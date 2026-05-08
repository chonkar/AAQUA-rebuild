# Shared-Infrastructure Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy AAQUA on Ubuntu host `10.13.1.182` behind a host-wide shared-infra tier (Postgres 17 + Nginx + Keycloak) using path-prefix routing under `/aaqua/`.

**Architecture:** New `/opt/shared-infra/` compose project hosts the public edge nginx, multi-tenant Postgres-17 cluster, and multi-realm Keycloak. AAQUA's image becomes backend-only (Express + Playwright on `:3001`). The shared nginx serves AAQUA's SPA from a host-mounted bundle and proxies `/aaqua/api/`, `/aaqua/llm-api/`, and `/auth/`. Spec at `docs/superpowers/specs/2026-05-08-shared-infra-deployment-design.md`.

**Tech Stack:** Docker Compose v2, Nginx 1.27, Postgres 17, Keycloak 24, Vite 5, React 18, react-oidc-context.

---

## Important context for the implementer

- **No test framework is wired up in this repo** (per `CLAUDE.md`). "Verification" steps below use real-world checks: `npm run build`, `docker compose config`, `nginx -t`, `bash -n`, `shellcheck`, `curl`. Treat these the way you'd treat unit tests — they MUST pass before committing.
- **Frequent, atomic commits.** One commit per task. Use the conventional-commits style — current repo's recent log is sloppy ("Commited the changes."), but follow the better pattern (`feat:`, `chore:`, `refactor:`).
- **Never commit `.env`, `secrets/*.txt`, or anything with real credentials.** Verify with `git status` before each commit.
- **Phase 1 (Tasks 1–16) is repo work** — done locally, ships as one PR. **Phase 2 (Tasks 17–26) is operator runbook** — executed on `10.13.1.182` after the PR is merged.
- **Working directory throughout Phase 1:** `C:\Office\Project\Aaseya\testing\AAQUA\AAQUA-rebuild\qa-test-gen` (this repo's root). All file paths in this plan are relative to that root.

---

## File structure

### New files (Phase 1)

```
scripts/
├── publish-spa.sh                                          # SPA extraction helper
└── shared-infra-template/                                  # source-of-truth for /opt/shared-infra/
    ├── .env.example
    ├── docker-compose.yml
    ├── nginx/
    │   ├── conf.d/
    │   │   ├── 00-defaults.conf
    │   │   └── 10-shared-edge.conf
    │   ├── conf.d.templates/
    │   │   └── aaqua.conf.template
    │   └── 10-load-tenant-secrets.envsh
    ├── postgres/
    │   └── init/
    │       └── 01-bootstrap-tenants.sh
    ├── scripts/
    │   ├── render-realm.sh
    │   └── onboard-aaqua.sh
    └── secrets/
        └── .gitkeep                                        # ensures the dir exists in the template

keycloak/
└── aaseya-platform-realm.template.json                     # templated realm export
```

### Modified files (Phase 1)

| Path | Change |
|---|---|
| `Dockerfile` | Rewrite: backend-only, drop nginx/supervisord/tini stack |
| `docker-compose.yml` | Slim: drop postgres + keycloak; join external `shared-infra_default` network |
| `vite.config.js` | Add `base: process.env.VITE_BASE_PATH \|\| '/'` |
| `src/App.jsx` | Add `basename` to `<Router>` |
| `src/auth/oidcConfig.js` | Prefix `redirect_uri` and `post_logout_redirect_uri` with `BASE_URL` |
| `src/utils/apiClient.js` | Prepend `BASE_URL` to every request path |
| `src/utils/llmClient.js` | Prefix `/llm-api` rewrite with `BASE_URL` |

### Deleted files (Phase 1)

```
docker/
├── nginx.conf.template
├── supervisord.conf
└── app-entrypoint.sh
```

---

# Phase 1 — Repo changes

## Task 1: Add shared-infra compose file and `.env.example`

**Files:**
- Create: `scripts/shared-infra-template/docker-compose.yml`
- Create: `scripts/shared-infra-template/.env.example`
- Create: `scripts/shared-infra-template/secrets/.gitkeep`

- [ ] **Step 1: Create `scripts/shared-infra-template/docker-compose.yml` with:**

```yaml
# Shared infrastructure tier on host 10.13.1.182.
# - postgres-17:    multi-tenant cluster, INTERNAL ONLY (5443 = tooling only)
# - keycloak:       multi-realm IAM, INTERNAL ONLY (reached via shared-nginx)
# - nginx:          public edge on :80 (later :443), routes path-prefix per tenant
#
# Bring up:    docker compose up -d
# Tear down:   docker compose down       (-v also wipes Postgres + Keycloak data)

services:
  postgres:
    image: postgres:17-alpine
    container_name: shared-postgres
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_super_password
      POSTGRES_DB: postgres
      KEYCLOAK_DB_PASSWORD: ${KEYCLOAK_DB_PASSWORD:?set in .env}
      AAQUA_DB_PASSWORD:    ${AAQUA_DB_PASSWORD:?set in .env}
    secrets:
      - postgres_super_password
    ports:
      - "5443:5432"            # tooling only — firewall to LAN/VPN
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  keycloak:
    image: quay.io/keycloak/keycloak:24.0
    container_name: shared-keycloak
    command: ["start", "--import-realm", "--optimized"]
    environment:
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://postgres:5432/keycloak
      KC_DB_USERNAME: keycloak_user
      KC_DB_PASSWORD:        ${KEYCLOAK_DB_PASSWORD:?set in .env}
      KEYCLOAK_ADMIN:        ${KEYCLOAK_ADMIN_USER:-superadmin}
      KEYCLOAK_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD:?set in .env}
      KC_HTTP_RELATIVE_PATH: /auth
      KC_HOSTNAME: ${KC_PUBLIC_BASE_URL:-http://10.13.1.182}
      KC_PROXY: edge
      KC_HOSTNAME_STRICT: "false"
      KC_HOSTNAME_STRICT_HTTPS: "false"
      KC_HTTP_ENABLED: "true"
      KC_HEALTH_ENABLED: "true"
    volumes:
      - ./keycloak/realms:/opt/keycloak/data/import:ro
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/8080 || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 90s
    restart: unless-stopped

  nginx:
    image: nginx:1.27-alpine
    container_name: shared-nginx
    ports:
      - "80:80"
      # - "443:443"           # uncomment when TLS lands (out-of-scope here)
    environment:
      NGINX_ENVSUBST_OUTPUT_DIR: /etc/nginx/tenants.d
    volumes:
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - ./nginx/conf.d.templates:/etc/nginx/templates:ro
      - ./nginx/sites:/var/www:ro
      - ./secrets:/run/shared-secrets:ro
      - ./nginx/10-load-tenant-secrets.envsh:/docker-entrypoint.d/10-load-tenant-secrets.envsh:ro
    tmpfs:
      - /etc/nginx/tenants.d
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
    restart: unless-stopped

networks:
  default:
    name: shared-infra_default
    driver: bridge

volumes:
  postgres_data:
    driver: local

secrets:
  postgres_super_password:
    file: ./secrets/postgres_super_password.txt
```

- [ ] **Step 2: Create `scripts/shared-infra-template/.env.example` with:**

```bash
# Copy to .env on the host (chmod 600). Generate secrets with `openssl rand -base64 24`.
KEYCLOAK_ADMIN_USER=superadmin
KEYCLOAK_ADMIN_PASSWORD=CHANGE_ME_GENERATE_WITH_openssl_rand_base64_32
KEYCLOAK_DB_PASSWORD=CHANGE_ME_GENERATE_WITH_openssl_rand_base64_24
AAQUA_DB_PASSWORD=CHANGE_ME_GENERATE_WITH_openssl_rand_base64_24
KC_PUBLIC_BASE_URL=http://10.13.1.182
```

- [ ] **Step 3: Create `scripts/shared-infra-template/secrets/.gitkeep` (empty file)**

This ensures the `secrets/` subdir survives in the template tree even though we don't commit any `.txt` secret files.

- [ ] **Step 4: Validate compose syntax**

Run from repo root:
```bash
docker compose -f scripts/shared-infra-template/docker-compose.yml --env-file /dev/null config --quiet 2>&1 | head -20
```

Expected: empty output (or only warnings about unset vars — that's fine; we won't run this compose locally). NO `error` or `invalid` lines.

- [ ] **Step 5: Commit**

```bash
git add scripts/shared-infra-template/docker-compose.yml \
        scripts/shared-infra-template/.env.example \
        scripts/shared-infra-template/secrets/.gitkeep
git commit -m "feat(shared-infra): add compose file and env template"
```

---

## Task 2: Add shared nginx config files

**Files:**
- Create: `scripts/shared-infra-template/nginx/conf.d/00-defaults.conf`
- Create: `scripts/shared-infra-template/nginx/conf.d/10-shared-edge.conf`
- Create: `scripts/shared-infra-template/nginx/conf.d.templates/aaqua.conf.template`
- Create: `scripts/shared-infra-template/nginx/10-load-tenant-secrets.envsh`

- [ ] **Step 1: Create `scripts/shared-infra-template/nginx/conf.d/00-defaults.conf`:**

```nginx
# Applied to every server block on this nginx (tenants and the shared edge).
client_max_body_size 100m;            # AAQUA accepts ~50 MB ZIP uploads via /api/run-tests
gzip on;
gzip_min_length 1024;
gzip_types
    text/plain text/css application/json application/javascript
    text/xml application/xml application/xml+rss text/javascript image/svg+xml;
```

- [ ] **Step 2: Create `scripts/shared-infra-template/nginx/conf.d/10-shared-edge.conf`:**

```nginx
server {
    listen 80 default_server;
    server_name _;

    add_header X-Frame-Options       "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff"   always;
    add_header Referrer-Policy        "strict-origin-when-cross-origin" always;

    location = /healthz {
        access_log off;
        add_header Content-Type text/plain;
        return 200 "ok\n";
    }

    location = / { return 302 /aaqua/; }

    # Shared Keycloak. NO trailing slash on proxy_pass — preserves /auth/* verbatim.
    location /auth/ {
        proxy_pass         http://shared-keycloak:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-Host  $host;
        proxy_buffering    off;
        proxy_read_timeout 300s;
    }

    # Tenant fragments rendered by 20-envsubst-on-templates.sh into a tmpfs.
    include /etc/nginx/tenants.d/*.conf;
}
```

- [ ] **Step 3: Create `scripts/shared-infra-template/nginx/conf.d.templates/aaqua.conf.template`:**

```nginx
# Substituted at boot: ${AAQUA_LLM_API_KEY}

# AAQUA SPA — static bundle published by /opt/aaqua/scripts/publish-spa.sh.
location /aaqua/ {
    alias /var/www/aaqua/;
    try_files $uri $uri/ /aaqua/index.html;
}

# AAQUA Express backend.
location /aaqua/api/ {
    proxy_pass         http://aaqua-app:3001/api/;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-Prefix /aaqua;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}

# LLM proxy with Authorization injection from /run/shared-secrets/aaqua/llm_api_key.txt.
location /aaqua/llm-api/ {
    proxy_pass            https://llm.lab.aaseya.com/;
    proxy_http_version    1.1;
    proxy_ssl_server_name on;
    proxy_set_header      Host          llm.lab.aaseya.com;
    proxy_set_header      Authorization "Bearer ${AAQUA_LLM_API_KEY}";
    proxy_set_header      Content-Type  "application/json";
    proxy_read_timeout    120s;
}
```

- [ ] **Step 4: Create `scripts/shared-infra-template/nginx/10-load-tenant-secrets.envsh`:**

```sh
#!/bin/sh
# Sourced (NOT executed) by /docker-entrypoint.sh in the official nginx image.
# Convention: /run/shared-secrets/<tenant>/<name>.txt -> ${TENANT}_${NAME}
# Example:    /run/shared-secrets/aaqua/llm_api_key.txt -> ${AAQUA_LLM_API_KEY}
for d in /run/shared-secrets/*/; do
    [ -d "$d" ] || continue
    tenant_var=$(basename "$d" | tr '[:lower:]-' '[:upper:]_')
    for f in "$d"*.txt; do
        [ -f "$f" ] || continue
        name_var=$(basename "$f" .txt | tr '[:lower:]-' '[:upper:]_')
        # shellcheck disable=SC2163
        export "${tenant_var}_${name_var}"="$(cat "$f")"
    done
done
unset d tenant_var f name_var
```

- [ ] **Step 5: Make the envsh file executable bit irrelevant — it is sourced — but lint it:**

```bash
sh -n scripts/shared-infra-template/nginx/10-load-tenant-secrets.envsh
```

Expected: no output (zero exit code = syntax OK).

- [ ] **Step 6: Validate the rendered nginx config syntax inside a one-shot nginx container.**

Render the template with a dummy key, then run `nginx -t`:

```bash
docker run --rm \
  -v "$PWD/scripts/shared-infra-template/nginx/conf.d:/etc/nginx/conf.d:ro" \
  -v "$PWD/scripts/shared-infra-template/nginx/conf.d.templates:/etc/nginx/templates:ro" \
  -e AAQUA_LLM_API_KEY=dummy-key-for-syntax-check \
  -e NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/tenants.d \
  --tmpfs /etc/nginx/tenants.d \
  nginx:1.27-alpine \
  sh -c '/docker-entrypoint.sh nginx -t'
```

Expected: ends with `nginx: configuration file /etc/nginx/nginx.conf test is successful`.

- [ ] **Step 7: Commit**

```bash
git add scripts/shared-infra-template/nginx/
git commit -m "feat(shared-infra): add nginx edge config and aaqua tenant template"
```

---

## Task 3: Add shared-postgres tenant bootstrap script

**Files:**
- Create: `scripts/shared-infra-template/postgres/init/01-bootstrap-tenants.sh`

- [ ] **Step 1: Create the script:**

```bash
#!/bin/bash
# Provisions the shared-postgres cluster on first boot:
#   - DB `keycloak`        + role `keycloak_user`
#   - DB `aaqua_security`  + role `aaqua_app`
# To add a tenant later (cluster already initialized):
#   docker exec -e <TENANT>_DB_PASSWORD=... shared-postgres \
#     psql -U postgres -d postgres -f /docker-entrypoint-initdb.d/01-bootstrap-tenants.sh
# Idempotent.
set -eu

require() { [ -n "${!1:-}" ] || { echo "[bootstrap] ERROR: $1 not set" >&2; exit 1; }; }
require KEYCLOAK_DB_PASSWORD
require AAQUA_DB_PASSWORD

create_tenant() {
  local db="$1" role="$2" pw="$3"
  echo "[bootstrap] Provisioning DB=$db ROLE=$role"
  psql --username "$POSTGRES_USER" --dbname postgres -v ON_ERROR_STOP=1 \
    -v role="$role" -v pw="$pw" -v db="$db" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec

SELECT format('ALTER ROLE %I WITH PASSWORD %L', :'role', :'pw') \gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL

  psql --username "$POSTGRES_USER" --dbname "$db" -v ON_ERROR_STOP=1 \
    -v role="$role" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT  ALL ON SCHEMA public TO :"role";
SQL
}

create_tenant keycloak       keycloak_user "$KEYCLOAK_DB_PASSWORD"
create_tenant aaqua_security  aaqua_app     "$AAQUA_DB_PASSWORD"

echo "[bootstrap] Done."
```

- [ ] **Step 2: Make executable + lint-check:**

```bash
chmod +x scripts/shared-infra-template/postgres/init/01-bootstrap-tenants.sh
bash -n scripts/shared-infra-template/postgres/init/01-bootstrap-tenants.sh
```

Expected: no output.

- [ ] **Step 3 (optional but recommended): shellcheck**

```bash
shellcheck scripts/shared-infra-template/postgres/init/01-bootstrap-tenants.sh || true
```

Expected: no errors. Warnings are acceptable as long as the script's intent is preserved (the heredoc + `\gexec` form is intentional; suppress with inline `# shellcheck disable=` if shellcheck objects).

- [ ] **Step 4: Commit**

```bash
git add scripts/shared-infra-template/postgres/init/01-bootstrap-tenants.sh
git commit -m "feat(shared-infra): add postgres tenant bootstrap script"
```

---

## Task 4: Add shared-infra helper scripts (`render-realm.sh`, `onboard-aaqua.sh`)

**Files:**
- Create: `scripts/shared-infra-template/scripts/render-realm.sh`
- Create: `scripts/shared-infra-template/scripts/onboard-aaqua.sh`

- [ ] **Step 1: Create `render-realm.sh`:**

```bash
#!/usr/bin/env bash
# Renders AAQUA's templated Keycloak realm into the shared-infra import dir.
# Substitutes ${PUBLIC_BASE_URL}.
# Run once before the first `docker compose up` of shared-infra.
set -euo pipefail

: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL, e.g. http://10.13.1.182}"
: "${AAQUA_REPO:=/opt/aaqua}"
SRC="$AAQUA_REPO/keycloak/aaseya-platform-realm.template.json"
DST="/opt/shared-infra/keycloak/realms/aaseya-platform-realm.json"

[ -f "$SRC" ] || { echo "ERROR: $SRC not found"; exit 1; }
mkdir -p "$(dirname "$DST")"
PUBLIC_BASE_URL="$PUBLIC_BASE_URL" envsubst '${PUBLIC_BASE_URL}' < "$SRC" > "$DST"
echo "Rendered -> $DST"
```

- [ ] **Step 2: Create `onboard-aaqua.sh`:**

```bash
#!/usr/bin/env bash
# Onboards AAQUA onto the shared-infra stack on this host. Run once.
# Re-runs are safe — secret files are preserved if present.
set -euo pipefail

SHARED=/opt/shared-infra
AAQUA=${AAQUA_REPO:-/opt/aaqua}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://10.13.1.182}

echo "==> Creating tenant directory layout"
mkdir -p "$SHARED"/{secrets/aaqua,nginx/sites/aaqua,keycloak/realms}
chmod 700 "$SHARED/secrets" "$SHARED/secrets/aaqua"

gen_or_keep() {
  local path="$1" generator="$2"
  if [ -s "$path" ]; then
    echo "  keep    $path (already exists)"
  else
    eval "$generator" > "$path"
    chmod 600 "$path"
    echo "  create  $path"
  fi
}

echo "==> Tenant secrets at $SHARED/secrets/aaqua/"
gen_or_keep "$SHARED/secrets/aaqua/db_password.txt"  "echo \"\$AAQUA_DB_PASSWORD\""
if [ ! -s "$SHARED/secrets/aaqua/llm_api_key.txt" ]; then
  read -rsp "Paste VITE_LLM_API_KEY (input hidden): " KEY; echo
  printf '%s' "$KEY" > "$SHARED/secrets/aaqua/llm_api_key.txt"
  chmod 600 "$SHARED/secrets/aaqua/llm_api_key.txt"
fi

echo "==> Rendering Keycloak realm template"
PUBLIC_BASE_URL="$PUBLIC_BASE_URL" AAQUA_REPO="$AAQUA" \
  bash "$SHARED/scripts/render-realm.sh"

echo "==> Publishing AAQUA SPA bundle"
( cd "$AAQUA" && bash scripts/publish-spa.sh )

echo
echo "Next steps:"
echo "  1. cd $SHARED && docker compose up -d           # brings up postgres + keycloak + nginx"
echo "  2. cd $AAQUA  && docker compose up -d --build   # brings up aaqua-app + aaqua-zap"
echo "  3. open $PUBLIC_BASE_URL/aaqua/"
```

- [ ] **Step 3: Make both executable + lint-check:**

```bash
chmod +x scripts/shared-infra-template/scripts/render-realm.sh \
         scripts/shared-infra-template/scripts/onboard-aaqua.sh
bash -n scripts/shared-infra-template/scripts/render-realm.sh
bash -n scripts/shared-infra-template/scripts/onboard-aaqua.sh
```

Expected: no output for either.

- [ ] **Step 4: Commit**

```bash
git add scripts/shared-infra-template/scripts/
git commit -m "feat(shared-infra): add render-realm and onboard-aaqua scripts"
```

---

## Task 5: Add templated Keycloak realm JSON

**Files:**
- Read: `keycloak/aaseya-platform-realm.json` (existing committed file with localhost URLs)
- Create: `keycloak/aaseya-platform-realm.template.json`

- [ ] **Step 1: Copy the existing realm export as the starting point:**

```bash
cp keycloak/aaseya-platform-realm.json keycloak/aaseya-platform-realm.template.json
```

- [ ] **Step 2: Open `keycloak/aaseya-platform-realm.template.json` and replace the four URL fields.**

Find the `aaqua-frontend` client block (the section containing `"clientId": "aaqua-frontend"`) and replace ONLY these four fields:

```diff
-      "rootUrl": "http://localhost:5173",
-      "baseUrl": "http://localhost:5173/",
+      "rootUrl": "${PUBLIC_BASE_URL}/aaqua",
+      "baseUrl": "${PUBLIC_BASE_URL}/aaqua/",
       "redirectUris": [
-        "http://localhost:5173/*"
+        "${PUBLIC_BASE_URL}/aaqua/*"
       ],
       "webOrigins": [
-        "http://localhost:5173",
+        "${PUBLIC_BASE_URL}",
```

Confirm the original `keycloak/aaseya-platform-realm.json` is **unchanged** (it stays for local dev).

- [ ] **Step 3: Validate the templated JSON parses (after substituting the placeholder):**

```bash
PUBLIC_BASE_URL=http://10.13.1.182 \
  envsubst '${PUBLIC_BASE_URL}' \
  < keycloak/aaseya-platform-realm.template.json \
  | python -m json.tool > /dev/null
```

Expected: no output, exit code 0. If JSON is malformed, `json.tool` will print an error.

- [ ] **Step 4: Confirm the four fields rendered correctly:**

```bash
PUBLIC_BASE_URL=http://10.13.1.182 \
  envsubst '${PUBLIC_BASE_URL}' \
  < keycloak/aaseya-platform-realm.template.json \
  | grep -E '"(rootUrl|baseUrl|redirectUris|webOrigins)"' -A1
```

Expected: shows `http://10.13.1.182/aaqua` (and variants) — NO `localhost:5173`, NO `${PUBLIC_BASE_URL}`.

- [ ] **Step 5: Commit**

```bash
git add keycloak/aaseya-platform-realm.template.json
git commit -m "feat(shared-infra): add templated keycloak realm for shared deployment"
```

---

## Task 6: Rewrite `Dockerfile` (slim, backend-only)

**Files:**
- Modify: `Dockerfile` (full rewrite)

- [ ] **Step 1: Read the current Dockerfile to confirm what's being replaced:**

```bash
head -85 Dockerfile
```

Confirm it's the existing 85-line bundled image with nginx + supervisord + tini. (If it's already been changed, stop and re-read this plan in conversation context.)

- [ ] **Step 2: Replace the entire `Dockerfile` content with:**

```dockerfile
# AAQUA backend image — Express + Playwright. NO nginx, NO supervisord, NO SPA.
# The SPA is built in stage 1 and EXPORTED to a host volume by scripts/publish-spa.sh.
# The shared-infra nginx serves the SPA and reverse-proxies to this container's :3001.

# ─── Stage 1: build the React SPA ─────────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src

ARG VITE_LLM_API_KEY=server-injected
ARG VITE_LLM_ENDPOINT=https://llm.lab.aaseya.com/v1
ARG VITE_LLM_MODEL=gpt-oss-20b
ARG VITE_KEYCLOAK_URL=http://10.13.1.182/auth
ARG VITE_KEYCLOAK_REALM=aaseya-platform
ARG VITE_KEYCLOAK_CLIENT_ID=aaqua-frontend
ARG VITE_BASE_PATH=/aaqua/
ENV VITE_LLM_API_KEY=$VITE_LLM_API_KEY \
    VITE_LLM_ENDPOINT=$VITE_LLM_ENDPOINT \
    VITE_LLM_MODEL=$VITE_LLM_MODEL \
    VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL \
    VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM \
    VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID \
    VITE_BASE_PATH=$VITE_BASE_PATH

RUN npm run build

# ─── Stage 2: backend production deps ─────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.58.0-jammy AS backend-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ─── Stage 3: final backend runtime ───────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.58.0-jammy

ENV NODE_ENV=production \
    PORT=3001 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
COPY --from=backend-deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
RUN mkdir -p temp_uploads temp_extract temp_output

EXPOSE 3001
# tini is added via `docker compose up`'s `init: true` flag (configured in docker-compose.yml)
# so we don't have to install it into the image. node alone as PID 1 has known SIGTERM
# quirks; init: true gives us tini-equivalent signal forwarding without the apt install.
ENTRYPOINT ["node", "server/index.js"]
```

- [ ] **Step 3: Verify the Dockerfile parses (no actual build):**

```bash
docker buildx build --no-cache --target frontend-build -f Dockerfile --check . 2>&1 | head -20 || true
```

Expected: a parse summary; no `failed to parse`/`unknown instruction` lines. (If `--check` isn't supported on the local Docker, skip this step — the real validation is Task 16's actual build.)

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "refactor(docker): slim app image to backend-only (drop nginx/supervisord)"
```

---

## Task 7: Slim `docker-compose.yml` for AAQUA

**Files:**
- Modify: `docker-compose.yml` (replace contents)

- [ ] **Step 1: Replace the entire content of `docker-compose.yml` with:**

```yaml
# AAQUA tenant compose — only the app backend and ZAP. Postgres, Keycloak,
# and the public-facing nginx live in /opt/shared-infra. This file joins
# the shared docker network as `external: true`.
#
# Bring up:    docker compose up -d --build
# Update:      git pull && ./scripts/publish-spa.sh && docker compose up -d --build app

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        VITE_BASE_PATH: /aaqua/
        VITE_KEYCLOAK_URL: ${VITE_KEYCLOAK_URL:-http://10.13.1.182/auth}
        VITE_KEYCLOAK_REALM: aaseya-platform
        VITE_KEYCLOAK_CLIENT_ID: aaqua-frontend
    container_name: aaqua-app
    init: true                # tini-equivalent signal forwarding (replaces in-image tini)
    environment:
      NODE_ENV: production
      PORT: 3001
      DB_HOST: shared-postgres
      DB_PORT: 5432
      DB_USER: aaqua_app
      DB_NAME: aaqua_security
      DB_LOGGING: "false"
      ZAP_API_URL: http://aaqua-zap:8080
      ZAP_API_KEY: ""
      VITE_LLM_ENDPOINT: https://llm.lab.aaseya.com/v1
      VITE_LLM_MODEL: gpt-oss-20b
      KEYCLOAK_REALM_URL: ${KEYCLOAK_REALM_URL:-http://10.13.1.182/auth/realms/aaseya-platform}
      KEYCLOAK_AUDIENCE: aaqua-frontend
      JIRA_ENABLED: "false"
      ALLOW_PRIVATE_SCAN: "false"
    secrets:
      - llm_api_key
      - db_password
      - jira_token
    depends_on:
      zap:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3001/api/security/zap/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    restart: unless-stopped
    networks:
      - shared-infra_default

  zap:
    image: ghcr.io/zaproxy/zaproxy:stable
    container_name: aaqua-zap
    command: >
      zap.sh -daemon -port 8080 -host 0.0.0.0
      -config api.disablekey=true
      -config api.addrs.addr.name=.*
      -config api.addrs.addr.regex=true
      -config connection.timeoutInSecs=120
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/JSON/core/view/version/"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 2G
    networks:
      - shared-infra_default

networks:
  shared-infra_default:
    external: true

secrets:
  llm_api_key:
    file: /opt/shared-infra/secrets/aaqua/llm_api_key.txt
  db_password:
    file: /opt/shared-infra/secrets/aaqua/db_password.txt
  jira_token:
    file: ./secrets/jira_token.txt
```

- [ ] **Step 2: Validate compose YAML syntax:**

```bash
docker compose -f docker-compose.yml config --quiet 2>&1 | head -20
```

Expected: only warnings about the missing external network (`network shared-infra_default declared as external, but could not be found`). NO YAML or schema errors.

NOTE: this compose file CANNOT be brought up locally on a Windows dev machine — the `external: true` network and `/opt/shared-infra/secrets/aaqua/...` paths only exist on the QA Ubuntu host. Local validation stops at YAML/config parse.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "refactor(compose): slim aaqua to tenant-only (joins shared-infra network)"
```

---

## Task 8: Add `scripts/publish-spa.sh`

**Files:**
- Create: `scripts/publish-spa.sh`

- [ ] **Step 1: Create the script:**

```bash
#!/usr/bin/env bash
# Build the SPA inside a temp container, extract dist/ to /opt/shared-infra/nginx/sites/aaqua/.
# Run after every `git pull` on the QA host. Idempotent.
set -euo pipefail

TARGET="${SHARED_INFRA_DIR:-/opt/shared-infra}/nginx/sites/aaqua"
mkdir -p "$TARGET"

docker build \
  --target frontend-build \
  --build-arg VITE_BASE_PATH=/aaqua/ \
  --build-arg VITE_KEYCLOAK_URL="${VITE_KEYCLOAK_URL:-http://10.13.1.182/auth}" \
  --build-arg VITE_KEYCLOAK_REALM=aaseya-platform \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=aaqua-frontend \
  -t aaqua-spa-build:latest \
  .

TMP=$(docker create aaqua-spa-build:latest)
trap 'docker rm -f "$TMP" >/dev/null 2>&1 || true' EXIT
docker cp "$TMP:/app/dist/." "$TARGET/"

echo "Published SPA -> $TARGET"
ls -la "$TARGET" | head -20
```

- [ ] **Step 2: Make executable + lint-check:**

```bash
chmod +x scripts/publish-spa.sh
bash -n scripts/publish-spa.sh
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add scripts/publish-spa.sh
git commit -m "feat(deploy): add publish-spa.sh for extracting dist/ to shared nginx"
```

---

## Task 9: Add `base` to `vite.config.js`

**Files:**
- Modify: `vite.config.js`

- [ ] **Step 1: Read current `vite.config.js` to confirm shape:**

```bash
cat vite.config.js
```

Confirm it starts with the `defineConfig({...})` form shown in the spec.

- [ ] **Step 2: Replace `vite.config.js` with:**

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// '/' for dev (no prefix). '/aaqua/' for QA (set via VITE_BASE_PATH build-arg).
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
      '/llm-api': {
        target: 'https://llm.lab.aaseya.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/llm-api/, ''),
        secure: false,
      },
    },
  },
})
```

- [ ] **Step 3: Verify the dev build still emits root-relative URLs (no path-prefix):**

```bash
npm run build
grep -oE '(src|href)="[^"]*"' dist/index.html | head -10
```

Expected: paths like `src="/assets/index-...js"` or `href="/assets/index-...css"` — i.e., starting with `/`, NOT `/aaqua/`. (No `VITE_BASE_PATH` set → defaults to `/`.)

- [ ] **Step 4: Verify the prod build emits `/aaqua/`-prefixed URLs:**

```bash
VITE_BASE_PATH=/aaqua/ npm run build
grep -oE '(src|href)="[^"]*"' dist/index.html | head -10
```

Expected: paths like `src="/aaqua/assets/index-...js"`.

- [ ] **Step 5: Clean up build artifacts:**

```bash
rm -rf dist
```

- [ ] **Step 6: Commit**

```bash
git add vite.config.js
git commit -m "feat(vite): add VITE_BASE_PATH-driven base for path-prefix routing"
```

---

## Task 10: Add `basename` to `<Router>` in `src/App.jsx`

**Files:**
- Modify: `src/App.jsx:26`

- [ ] **Step 1: Read the current Router line:**

```bash
sed -n '26p' src/App.jsx
```

Expected: `      <Router>`.

- [ ] **Step 2: Edit `src/App.jsx`. Replace this exact line:**

Old:
```jsx
      <Router>
```

New:
```jsx
      <Router basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
```

- [ ] **Step 3: Verify the file still parses by running an ESLint check:**

```bash
npm run lint -- src/App.jsx
```

Expected: zero errors. Pre-existing warnings (if any) are fine.

- [ ] **Step 4: Verify the dev build still works:**

```bash
VITE_BASE_PATH=/aaqua/ npm run build
test -f dist/index.html && echo "build OK"
rm -rf dist
```

Expected: `build OK`.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat(spa): wire React Router basename to import.meta.env.BASE_URL"
```

---

## Task 11: Fix redirect URIs in `src/auth/oidcConfig.js`

**Files:**
- Modify: `src/auth/oidcConfig.js:15-16`

- [ ] **Step 1: Read the current oidcConfig redirect lines:**

```bash
sed -n '12,17p' src/auth/oidcConfig.js
```

Expected:
```
export const oidcConfig = {
    authority: `${KC_URL}/realms/${KC_REALM}`,
    client_id: KC_CLIENT_ID,
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: window.location.origin + '/',
```

- [ ] **Step 2: Edit `src/auth/oidcConfig.js`. Replace lines 12–16 to:**

Old:
```js
export const oidcConfig = {
    authority: `${KC_URL}/realms/${KC_REALM}`,
    client_id: KC_CLIENT_ID,
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: window.location.origin + '/',
```

New:
```js
const BASE = import.meta.env.BASE_URL;       // '/' in dev, '/aaqua/' in QA

export const oidcConfig = {
    authority: `${KC_URL}/realms/${KC_REALM}`,
    client_id: KC_CLIENT_ID,
    redirect_uri: `${window.location.origin}${BASE}auth/callback`,
    post_logout_redirect_uri: `${window.location.origin}${BASE}`,
```

- [ ] **Step 3: Lint and re-build:**

```bash
npm run lint -- src/auth/oidcConfig.js
VITE_BASE_PATH=/aaqua/ npm run build
test -f dist/index.html && echo "build OK"
rm -rf dist
```

Expected: lint passes; `build OK`.

- [ ] **Step 4: Commit**

```bash
git add src/auth/oidcConfig.js
git commit -m "fix(auth): prefix OIDC redirect URIs with BASE_URL to avoid /auth/ collision"
```

---

## Task 12: Prepend `BASE_URL` in `src/utils/apiClient.js`

**Files:**
- Modify: `src/utils/apiClient.js:8-19`

- [ ] **Step 1: Read the current request function:**

```bash
sed -n '1,20p' src/utils/apiClient.js
```

- [ ] **Step 2: Edit `src/utils/apiClient.js`. Replace the existing `export function createApiClient` block prefix.**

Old (the relevant slice):
```js
export function createApiClient(getToken) {
    async function request(path, { method = 'GET', body, headers = {} } = {}) {
        const token = typeof getToken === 'function' ? getToken() : getToken;
        const res = await fetch(path, {
```

New:
```js
const API_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '');   // '' in dev, '/aaqua' in QA

export function createApiClient(getToken) {
    async function request(path, { method = 'GET', body, headers = {} } = {}) {
        const token = typeof getToken === 'function' ? getToken() : getToken;
        const res = await fetch(`${API_PREFIX}${path}`, {
```

- [ ] **Step 3: Lint and re-build:**

```bash
npm run lint -- src/utils/apiClient.js
VITE_BASE_PATH=/aaqua/ npm run build
test -f dist/index.html && echo "build OK"
rm -rf dist
```

Expected: lint passes; `build OK`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/apiClient.js
git commit -m "fix(api): prepend BASE_URL to api request paths"
```

---

## Task 13: Prefix `/llm-api` rewrite in `src/utils/llmClient.js`

**Files:**
- Modify: `src/utils/llmClient.js:7-9`

- [ ] **Step 1: Read the current rewrite block:**

```bash
sed -n '6,10p' src/utils/llmClient.js
```

Expected:
```
        // Bypass CORS in browser explicitly using Vite proxy
        if (typeof window !== 'undefined' && this.endpoint.includes('llm.lab.aaseya.com')) {
            this.endpoint = this.endpoint.replace('https://llm.lab.aaseya.com', '/llm-api');
        }
```

- [ ] **Step 2: Edit `src/utils/llmClient.js`. Replace the inner two lines:**

Old:
```js
        if (typeof window !== 'undefined' && this.endpoint.includes('llm.lab.aaseya.com')) {
            this.endpoint = this.endpoint.replace('https://llm.lab.aaseya.com', '/llm-api');
        }
```

New:
```js
        if (typeof window !== 'undefined' && this.endpoint.includes('llm.lab.aaseya.com')) {
            const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
            this.endpoint = this.endpoint.replace('https://llm.lab.aaseya.com', `${BASE}/llm-api`);
        }
```

- [ ] **Step 3: Lint and re-build:**

```bash
npm run lint -- src/utils/llmClient.js
VITE_BASE_PATH=/aaqua/ npm run build
test -f dist/index.html && echo "build OK"
rm -rf dist
```

Expected: lint passes; `build OK`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/llmClient.js
git commit -m "fix(llm): prefix /llm-api rewrite with BASE_URL"
```

---

## Task 14: Hardcoded-path sweep in `src/`

**Files:**
- Audit: every file under `src/`

- [ ] **Step 1: Find absolute-path usages that bypass React Router's basename:**

```bash
grep -rnE '(window\.location\.(href|replace|assign)\s*=\s*['"'"'"]/|<a [^>]*href=['"'"'"]/[^/])' src/
```

Expected: zero matches. Each match (if any) is a hardcoded `/foo`-style path that needs to be prefixed via `import.meta.env.BASE_URL` or replaced with a `<Link>` from `react-router-dom`.

- [ ] **Step 2: If matches exist, fix each one inline.**

For `<a href="/foo">Link</a>` → switch to `<Link to="/foo">Link</Link>` (React Router prefixes it).
For `window.location.href = '/foo'` → use `${import.meta.env.BASE_URL}foo` or `useNavigate()`.

- [ ] **Step 3: Re-run the grep. Expected: zero matches.**

- [ ] **Step 4: If you made changes, rebuild and commit:**

```bash
VITE_BASE_PATH=/aaqua/ npm run build && rm -rf dist
git add -p src/
git commit -m "fix(spa): replace hardcoded absolute paths with BASE_URL-aware equivalents"
```

If no changes needed, skip the commit and move on.

---

## Task 15: Delete obsolete `docker/` files

**Files:**
- Delete: `docker/nginx.conf.template`
- Delete: `docker/supervisord.conf`
- Delete: `docker/app-entrypoint.sh`

- [ ] **Step 1: Delete the files:**

```bash
git rm docker/nginx.conf.template docker/supervisord.conf docker/app-entrypoint.sh
rmdir docker 2>/dev/null || true     # remove dir if empty
```

- [ ] **Step 2: Verify nothing else references them:**

```bash
grep -rn "docker/nginx.conf\|docker/supervisord\|docker/app-entrypoint" . --include='*.{yml,yaml,json,sh,md,Dockerfile}' 2>/dev/null
```

Expected: zero matches outside of historical files like `DEPLOYMENT.md` (which describes the OLD bundled architecture and is acceptable as documentation of history). If matches occur in active config files (Dockerfile, compose), you've missed an edit in an earlier task.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore(docker): remove bundled-nginx files (replaced by shared-infra)"
```

---

## Task 16: Local validation — full build + compose lint

**Files:** none modified; this is a verification gate.

- [ ] **Step 1: Verify the AAQUA backend image still builds end-to-end (this is the heaviest local check):**

```bash
docker build --target frontend-build -t aaqua-spa-test:latest \
  --build-arg VITE_BASE_PATH=/aaqua/ \
  --build-arg VITE_KEYCLOAK_URL=http://10.13.1.182/auth \
  --build-arg VITE_KEYCLOAK_REALM=aaseya-platform \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=aaqua-frontend \
  .
```

Expected: `=> writing image sha256:...` line. Build succeeds with no errors.

- [ ] **Step 2: Verify the bundle has correct path-prefix:**

```bash
TMP=$(docker create aaqua-spa-test:latest)
docker cp "$TMP:/app/dist/index.html" /tmp/aaqua-index.html
docker rm -f "$TMP" >/dev/null
grep -oE '(src|href)="[^"]+"' /tmp/aaqua-index.html | head -10
```

Expected: every `src=` and `href=` starts with `/aaqua/`.

- [ ] **Step 3: Re-validate the AAQUA compose:**

```bash
docker compose -f docker-compose.yml config --quiet 2>&1 | head -10
```

Expected: only the "external network not found" warning. No YAML errors.

- [ ] **Step 4: Re-validate the shared-infra compose:**

```bash
KEYCLOAK_DB_PASSWORD=x AAQUA_DB_PASSWORD=x KEYCLOAK_ADMIN_PASSWORD=x \
  docker compose -f scripts/shared-infra-template/docker-compose.yml config --quiet 2>&1 | head -10
```

Expected: empty output OR only deprecation warnings. No `error` lines.

- [ ] **Step 5: Clean up:**

```bash
docker rmi aaqua-spa-test:latest 2>/dev/null || true
rm -f /tmp/aaqua-index.html
```

- [ ] **Step 6: No commit needed** — this is a verification gate. If all passed, Phase 1 is ready to PR.

---

# Phase 2 — Deployment runbook

These tasks run on the QA host `10.13.1.182` AFTER Phase 1's PR is merged. Each is bite-sized and ends in a verification, but they DO NOT have commits — Phase 2 is operational, not source-controlled.

## Task 17: Pre-flight checks on the host

- [ ] **Step 1: SSH to the host:**

```bash
ssh javaaps@10.13.1.182      # adjust user as needed
```

- [ ] **Step 2: Confirm RAM headroom:**

```bash
free -h
```

Expected: `available` row shows ≥4 GB. (If under, escalate before proceeding — momthathel + Elasticsearch already consume most of the box.)

- [ ] **Step 3: Confirm disk:**

```bash
df -h /var/lib/docker /opt
```

Expected: ≥15 GB free on each.

- [ ] **Step 4: Confirm `:80` is unbound:**

```bash
ss -ltnp | awk '$4 ~ /:80$/ {print}'
```

Expected: empty output. (If something else holds `:80`, stop — `momthathel-nginx` runs on `:8092`, so `:80` should be free.)

- [ ] **Step 5: Confirm Docker version:**

```bash
docker -v && docker compose version
```

Expected: Docker `24+`, Compose `v2`.

---

## Task 18: Initial host directory layout + clone

- [ ] **Step 1: Create directories:**

```bash
sudo mkdir -p /opt/{shared-infra,aaqua}
sudo chown $USER:$USER /opt/shared-infra /opt/aaqua
```

- [ ] **Step 2: Clone AAQUA at the merged main branch:**

```bash
git clone <repo-url> /opt/aaqua
cd /opt/aaqua && git checkout main && git pull
```

(Operator: substitute `<repo-url>` with the real URL — e.g. `git@git.lab.aaseya.com:...`.)

- [ ] **Step 3: Verify the new files exist:**

```bash
test -d /opt/aaqua/scripts/shared-infra-template && \
  test -f /opt/aaqua/keycloak/aaseya-platform-realm.template.json && \
  echo "OK"
```

Expected: `OK`.

---

## Task 19: Seed `/opt/shared-infra/` from the template

- [ ] **Step 1: Copy the template tree:**

```bash
cp -r /opt/aaqua/scripts/shared-infra-template/. /opt/shared-infra/
ls /opt/shared-infra
```

Expected output includes: `docker-compose.yml`, `.env.example`, `nginx/`, `postgres/`, `scripts/`, `secrets/`.

- [ ] **Step 2: Make scripts executable (in case `cp` lost the bit):**

```bash
chmod +x /opt/shared-infra/scripts/*.sh \
         /opt/shared-infra/postgres/init/*.sh \
         /opt/aaqua/scripts/publish-spa.sh
```

---

## Task 20: Configure `/opt/shared-infra/.env` and the postgres superuser secret

- [ ] **Step 1: Generate passwords and write `.env` via grouped `echo` lines.**

This form is more paste-friendly than a heredoc — heredocs require the closing `EOF` at column 0 (no leading whitespace), which terminal copy-paste often violates silently.

```bash
cd /opt/shared-infra

KC_ADMIN_PW=$(openssl rand -base64 32)
KC_DB_PW=$(openssl rand -base64 24)
AAQUA_DB_PW=$(openssl rand -base64 24)

{
  echo "KEYCLOAK_ADMIN_USER=superadmin"
  echo "KEYCLOAK_ADMIN_PASSWORD=$KC_ADMIN_PW"
  echo "KEYCLOAK_DB_PASSWORD=$KC_DB_PW"
  echo "AAQUA_DB_PASSWORD=$AAQUA_DB_PW"
  echo "KC_PUBLIC_BASE_URL=http://10.13.1.182"
} > .env
chmod 600 .env
```

Verify:
```bash
cat .env
```
Should print 5 lines, every value populated (none empty).

- [ ] **Step 2: Generate the postgres superuser secret.**

```bash
mkdir -p /opt/shared-infra/secrets
openssl rand -base64 24 > /opt/shared-infra/secrets/postgres_super_password.txt
chmod 600 /opt/shared-infra/secrets/postgres_super_password.txt
```

- [ ] **Step 3: Verify `.env` has real values (no placeholders left).**

```bash
grep CHANGE_ME .env && echo "FIX: still has placeholders" || echo "OK"
```

Expected: `OK`.

- [ ] **Step 4: Save the admin password somewhere outside `.env`** (you need it for the Keycloak admin console in Task 25; `.env` only lives on the server).

```bash
echo "Save this — Keycloak admin (master realm) password:"
grep KEYCLOAK_ADMIN_PASSWORD .env
```

Copy the value into your password manager / secret store now. Do NOT paste it into chat or commit it anywhere.

---

## Task 21: Run `onboard-aaqua.sh`

- [ ] **Step 1: Source the AAQUA DB password from `.env` and run the onboarding script:**

```bash
cd /opt/shared-infra
set -a; source .env; set +a
PUBLIC_BASE_URL="$KC_PUBLIC_BASE_URL" AAQUA_REPO=/opt/aaqua \
  bash scripts/onboard-aaqua.sh
```

When prompted, paste the LLM API key (provided by the AI platform team — value of `VITE_LLM_API_KEY`).

- [ ] **Step 2: Verify the generated artifacts:**

```bash
ls -la /opt/shared-infra/secrets/aaqua/
test -s /opt/shared-infra/secrets/aaqua/llm_api_key.txt && \
  test -s /opt/shared-infra/secrets/aaqua/db_password.txt && \
  test -s /opt/shared-infra/keycloak/realms/aaseya-platform-realm.json && \
  test -d /opt/shared-infra/nginx/sites/aaqua && \
  echo "ALL ARTIFACTS PRESENT"
```

Expected: `ALL ARTIFACTS PRESENT`.

- [ ] **Step 3: Spot-check the rendered realm has the right URLs:**

```bash
grep -E '"(rootUrl|baseUrl|redirectUris|webOrigins)"' \
  /opt/shared-infra/keycloak/realms/aaseya-platform-realm.json -A1 | head -20
```

Expected: shows `http://10.13.1.182/aaqua` (and variants). NO `${PUBLIC_BASE_URL}` placeholders left.

---

## Task 22: Bring up shared-infra stack

- [ ] **Step 1: Start the shared stack:**

```bash
cd /opt/shared-infra
docker compose up -d
```

- [ ] **Step 2: Watch services come healthy (~90 s):**

```bash
docker compose ps
```

Expected after 90 s: `shared-postgres`, `shared-keycloak`, `shared-nginx` all show `(healthy)`.

If `shared-keycloak` is `(unhealthy)` or restarting:
```bash
docker compose logs keycloak --tail=80
```
The most common first-boot failure is the realm import — the rendered realm JSON must be valid. If it's corrupt, fix the template (Task 5) or the renderer (Task 4) and re-run `onboard-aaqua.sh`, then `docker compose up -d --force-recreate keycloak`.

---

## Task 23: Bring up AAQUA stack

- [ ] **Step 1: Build and start AAQUA:**

```bash
cd /opt/aaqua
docker compose up -d --build
```

This takes ~5 min on first run (Playwright base image + npm ci).

- [ ] **Step 2: Verify AAQUA is healthy:**

```bash
docker compose ps
```

Expected: `aaqua-app` and `aaqua-zap` both `(healthy)` within ~2 minutes.

- [ ] **Step 3: Confirm aaqua-app joined the shared network:**

```bash
docker network inspect shared-infra_default --format '{{range $k, $v := .Containers}}{{$v.Name}} {{end}}'
```

Expected output includes: `shared-postgres`, `shared-keycloak`, `shared-nginx`, `aaqua-app`, `aaqua-zap`.

---

## Task 24: Smoke tests (curl-level)

Run these from the host (or from a LAN client with network access to `10.13.1.182:80`).

- [ ] **Step 1: Edge healthcheck:**

```bash
curl -fsS http://10.13.1.182/healthz
```

Expected: `ok`.

- [ ] **Step 2: Keycloak OIDC discovery:**

```bash
curl -fsS http://10.13.1.182/auth/realms/aaseya-platform/.well-known/openid-configuration | jq .issuer
```

Expected: `"http://10.13.1.182/auth/realms/aaseya-platform"`.

- [ ] **Step 3: SPA serves under `/aaqua/`:**

```bash
curl -fsSI http://10.13.1.182/aaqua/ | head -1
```

Expected: `HTTP/1.1 200 OK`.

- [ ] **Step 4: Backend reachable AND token middleware engaged:**

```bash
curl -i http://10.13.1.182/aaqua/api/security/projects | head -1
```

Expected: `HTTP/1.1 401 Unauthorized` (middleware rejected the un-tokened request — exactly what we want).

- [ ] **Step 5: Postgres has both tenant DBs:**

```bash
docker exec shared-postgres psql -U postgres -l | grep -E 'keycloak|aaqua_security'
```

Expected: both DBs listed.

- [ ] **Step 6: Cross-DB tenant isolation:**

```bash
PGPASSWORD=$(cat /opt/shared-infra/secrets/aaqua/db_password.txt) \
  docker exec -i shared-postgres psql -U aaqua_app -d keycloak -c '\l' 2>&1 | head -3
```

Expected: `FATAL:  permission denied for database "keycloak"` (or similar). Confirms tenant isolation.

If ANY of steps 1–6 fails, do NOT proceed to Task 25. Diagnose with `docker compose logs` and fix.

---

## Task 25: Bootstrap Keycloak admin password and seed users

- [ ] **Step 1: Open the Keycloak admin console:**

In a browser: `http://10.13.1.182/auth/admin/`. Log in as the master-realm admin:
- Username: value of `KEYCLOAK_ADMIN_USER` from `/opt/shared-infra/.env` (default `superadmin`)
- Password: value of `KEYCLOAK_ADMIN_PASSWORD` from `/opt/shared-infra/.env`

- [ ] **Step 2: Switch to the `aaseya-platform` realm** (top-left realm dropdown).

- [ ] **Step 3: Confirm the realm exists and the `aaqua-frontend` client is configured.**

- [ ] **Step 4: For each seed admin (`sanjay.jain`, `kavita.chonkar`):**

  a. Realm dropdown → **Users**.
  b. Click the user → **Credentials** tab.
  c. Set a temporary password (the user changes it on first login per the realm's `requiredActions`).

- [ ] **Step 5: Configure SMTP for the realm** (per `DEPLOYMENT.md:202-220`):

  - **Realm settings → Email** tab.
  - Fill in production SMTP (Office 365 / SES / internal relay — per your team's setup).
  - From: `no-reply@aaseya.com` (or your team's address).
  - Click **Test connection**, confirm a test mail arrives, **Save**.

  > Mailpit is dev-only — do NOT add it on the QA host.

---

## Task 26: Browser smoke test (catches the `/auth/callback` collision)

This is the load-bearing test that verifies the `oidcConfig.js` BASE_URL fix is correct.

- [ ] **Step 1: Open `http://10.13.1.182/aaqua/` in a browser.**

Expected: AAQUA home page loads with the Header. Static assets (CSS, JS) load successfully (DevTools Network tab shows 200s under `/aaqua/assets/`).

- [ ] **Step 2: Click any tool tile (e.g., Test Generator).**

Expected: redirect to `http://10.13.1.182/auth/realms/aaseya-platform/protocol/openid-connect/auth?...` (a Keycloak login page). NOT a 404, NOT a Keycloak welcome page.

- [ ] **Step 3: Log in as a seed admin (`sanjay.jain` or `kavita.chonkar`) with the temporary password.**

Expected: forced UPDATE_PASSWORD prompt → set a new password → land back on the AAQUA tool. URL bar shows `http://10.13.1.182/aaqua/test-generator` (or wherever you came from).

- [ ] **Step 4: CRITICAL — confirm the redirect URI did NOT collide with shared Keycloak:**

Look at the URL bar at any point during/after the round-trip. It should show paths like:
- `http://10.13.1.182/aaqua/...` ← good
- `http://10.13.1.182/aaqua/auth/callback` ← good (transient)

It should NEVER show:
- `http://10.13.1.182/auth/callback` ← BAD — would mean Task 11 wasn't applied or is wrong; you'd see a Keycloak 404 page.

If the URL goes to bare `/auth/callback`, stop. The `oidcConfig.js` change in Task 11 didn't take effect (likely the SPA wasn't rebuilt + republished). Re-run `bash /opt/aaqua/scripts/publish-spa.sh` and try again.

- [ ] **Step 5: Functional smokes:**

  a. **Test Generator** — generate a small test case. (Exercises the browser-side LLM proxy through `/aaqua/llm-api/`.)
  b. **Security Scanner** — admin-only; should load.
  c. **Test Runner** — upload a small Playwright project ZIP and run it.

- [ ] **Step 6: Check container logs for errors:**

```bash
docker logs aaqua-app --tail 50 | grep -iE '(error|warn)' | head -20
docker logs shared-keycloak --tail 50 | grep -iE 'error' | head -20
```

Expected: no recurring errors. Occasional benign warnings are OK.

---

# Self-review against the spec

Mapping each spec section to its task:

- §2 decision matrix → Tasks 1–8 implement the chosen approach end-to-end.
- §3 architecture diagram → Tasks 1, 2, 5, 7 (the artifacts that produce that runtime shape).
- §4.1 file changes → Tasks 1–13 (every row mapped); Tasks 6–7 cover the rewrites.
- §4.2 deletions → Task 15.
- §4.3 hardcoded-path sweep → Task 14.
- §5.1 first deploy → Tasks 17–26.
- §5.3 rollback → covered in the runbook task descriptions (Task 22 fix-up + plan §5.3 of spec).
- §6 security posture → Tasks 1, 7 (internal-only ports), Task 3 (DB-per-tenant), Task 24 step 6 (cross-DB isolation check).
- §8 validation checkpoints → Task 17 (1), Task 22 (2), Task 24 (3,4), Task 26 (5), Task 14 (6), Task 24 step 6 (7).
- §9 open-questions resolved → reflected in Tasks 1–8 design choices (single secrets dir, one DB per tenant, path-prefix).

No spec section lacks a corresponding task.
