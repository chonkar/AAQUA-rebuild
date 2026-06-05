# AAQUA — QA Server Deployment Guide

> **⚠️ This document describes the LEGACY bundled-image deployment.** As of `2026-05-08`, AAQUA deploys against a host-wide shared-infrastructure tier (Postgres 17 + Nginx + Keycloak) with AAQUA as a tenant. **For the current deployment runbook, use:**
>
> - **Spec** — [`docs/superpowers/specs/2026-05-08-shared-infra-deployment-design.md`](docs/superpowers/specs/2026-05-08-shared-infra-deployment-design.md)
> - **Plan / runbook** — [`docs/superpowers/plans/2026-05-08-shared-infra-deployment.md`](docs/superpowers/plans/2026-05-08-shared-infra-deployment.md) (Phase 2, Tasks 17–26 are the host-side steps)
>
> The content below is preserved for historical reference and matches the (now-removed) bundled `Dockerfile` that ran `nginx + supervisord + node + Playwright` in a single container. The current `Dockerfile` is **backend-only**; the SPA is built and published separately via `scripts/publish-spa.sh`.
>
> **Lessons we learned during the shared-infra QA stand-up (apply when re-deploying):**
> 1. The realm requires PKCE-S256, which needs `crypto.subtle` — only available over **HTTPS** or on `localhost`/`127.0.0.1`. A LAN-IP HTTP deploy will silently break the SPA login flow. Terminate TLS at shared-nginx (self-signed cert is acceptable for internal QA).
> 2. `KC_HOSTNAME` must be a **bare hostname** (`aaqua.aaseya.com`), NOT a URL. Pass full URLs only via `KC_PUBLIC_BASE_URL` for realm-template substitution. Non-default port goes in `KC_HOSTNAME_PORT` (`8443`).
> 3. Drop `--optimized` from Keycloak's command — the upstream image is built for H2; `start --optimized` ignores `KC_DB=postgres` and crashes.
> 4. Healthcheck Alpine containers via `127.0.0.1`, not `localhost` (musl resolves to `::1` first; nginx isn't IPv6-bound).
> 5. Shell scripts must have `+x` set in the git index (`git update-index --chmod=+x`); committing from Windows defaults to `100644` and the official nginx image silently skips non-executable `.envsh` files.
> 6. `.gitattributes` pins shell scripts to LF — without it, Windows checkouts produce CRLF that breaks `set -o pipefail` on Linux.
>
> Full deployment-time discoveries are recorded in `CLAUDE.md` under "Production deployment — shared-infra model".

> For local developer setup (running Vite + Express directly on the host), see `LOCAL_SETUP.md`.

---

## 1. What gets deployed

```
       ┌──────────────────────────── Internet / LAN ─────────────────────────────┐
       │                                                                         │
       │       :80                                       :8082                   │
       │        ▼                                          ▼                     │
       │  ┌──────────────────────┐               ┌──────────────────┐            │
       │  │ app (single image)   │               │     keycloak     │            │
       │  │ ┌────────────────┐   │               │   (IAM, OIDC)    │            │
       │  │ │ nginx :80      │   │ serves SPA    │  realm:          │            │
       │  │ │ /api/ → :3001  │   │ /llm-api/...  │  aaseya-platform │            │
       │  │ │ /llm-api → ... │   │               └────────┬─────────┘            │
       │  │ └────────┬───────┘   │                        │ JWKS lookup          │
       │  │          │ loopback  │ ◀──── Bearer <jwt> ────┘ (verify tokens)      │
       │  │ ┌────────▼───────┐   │                                               │
       │  │ │ node :3001     │   │ Express + Playwright + jose                   │
       │  │ └────────┬───────┘   │                                               │
       │  └──────────┼───────────┘                                               │
       │             │                                                           │
       │   ┌─────────┴─────────┐                                                 │
       │ ┌─▼────┐  ┌────▼───┐                                                    │
       │ │ pg16 │  │  ZAP   │                                                    │
       │ │ :5432│  │  :8080 │                                                    │
       │ └──────┘  └────────┘                                                    │
       │ host:5442─┘  host:8040─┘ (tooling only)                                 │
       └─────────────────────────────────────────────────────────────────────────┘
```

| Service | Image | Internal | Host | Public? |
|---|---|---|---|---|
| `app` | built from `Dockerfile` (Playwright v1.58 + nginx + supervisord) | 80 (nginx), 3001 (node, loopback only) | **80** | yes — single SPA entrypoint |
| `keycloak` | `quay.io/keycloak/keycloak:24.0` | 8080 | **8082** | yes — login redirects land here |
| `postgres` | `postgres:16-alpine` | 5432 | **5442** | tooling only |
| `zap` | `ghcr.io/zaproxy/zaproxy:stable` | 8080 | **8040** | tooling only |

Inside the `app` container, **supervisord** runs nginx and the Node backend together. nginx is the only listener bound to the container's external interface; Express on `:3001` is bound to the loopback and reached only via nginx's `proxy_pass http://127.0.0.1:3001`. Postgres hosts two schemas — `public` (app data) and `keycloak` (IAM data) — isolated via Postgres roles and `KC_DB_SCHEMA`. End users hit ports **80** (the SPA) and **8082** (login redirect) — both must be open externally. Ports 5442 and 8040 should be firewalled to the office / VPN only; they exist for pgAdmin / ZAP UI access during debugging.

> **TLS:** terminate HTTPS at a reverse proxy (Caddy / Traefik / nginx + certbot) in front of both `:80` and `:8082`. When you do, set `KC_HOSTNAME=<bare-hostname>` (+ `KC_HOSTNAME_PORT=<port>` if non-standard), `KC_HOSTNAME_STRICT=true`, `KC_HOSTNAME_STRICT_BACKCHANNEL=false`, `KC_HOSTNAME_STRICT_HTTPS=true`, `KC_PROXY_HEADERS=xforwarded` (this replaces the deprecated `KC_PROXY=edge`), and update the realm's `redirectUris` to your public SPA hostname.

---

## 2. Server prerequisites

| Requirement | Minimum |
|---|---|
| OS | Ubuntu 22.04 / RHEL 9 / equivalent Linux |
| CPU | 4 vCPU |
| RAM | 8 GB (ZAP alone is capped at 2 GB; Playwright runs are memory-hungry) |
| Disk | 30 GB free (Playwright browsers ≈ 1 GB, Postgres growth, temp ZIP uploads) |
| Docker Engine | 24+ |
| Docker Compose | v2 (`docker compose`, not legacy `docker-compose`) |
| Outbound internet | yes — backend calls `https://llm.lab.aaseya.com`, ZAP fetches signatures |
| Inbound | TCP **80** (SPA) and **8082** (Keycloak login) open to end users; **5442 / 8040** restricted to internal admins |

Verify on the server:

```bash
docker -v               # Docker version 24.x or newer
docker compose version  # v2.x
```

---

## 3. First-time deployment

### 3.1 Clone the repository

```bash
sudo mkdir -p /opt/aaqua && sudo chown $USER /opt/aaqua
cd /opt/aaqua
git clone <repo-url> .
git checkout main
```

### 3.2 Provision secrets

Production secrets live in two places:

**(A) `./secrets/*.txt` — file-mounted secrets** for images that natively support `*_FILE` env vars (Postgres, the app's nginx config render):

```bash
cd /opt/aaqua
cp secrets/llm_api_key.txt.example   secrets/llm_api_key.txt
cp secrets/db_password.txt.example   secrets/db_password.txt
cp secrets/jira_token.txt.example    secrets/jira_token.txt
```

| File | Source / generation |
|---|---|
| `secrets/llm_api_key.txt` | The `VITE_LLM_API_KEY` provided by the AI platform team |
| `secrets/db_password.txt` | `openssl rand -base64 24` — Postgres password for the `aaqua` user |
| `secrets/jira_token.txt` | Jira API token (only if `JIRA_ENABLED=true`; leave empty otherwise) |

**(B) `.env` — environment-substituted secrets** for Keycloak (its image does not translate `*_FILE`, so passwords must arrive as plain env values via Compose):

```bash
cp .env.example .env
```

Then fill in (at minimum):

| Key | Source / generation |
|---|---|
| `KEYCLOAK_ADMIN_USER` | leave as `superadmin` or pick a name |
| `KEYCLOAK_ADMIN_PASSWORD` | `openssl rand -base64 32` — bootstrap superadmin for the Keycloak admin console |
| `KEYCLOAK_DB_PASSWORD` | `openssl rand -base64 24` — password for the `keycloak_user` Postgres role |
| `KEYCLOAK_REALM_URL` | the public URL Keycloak issues tokens under, e.g. `https://auth.aaseya.com/realms/aaseya-platform` |
| `KEYCLOAK_AUDIENCE` | `aaqua-frontend` (matches the realm's public client ID) |
| `VITE_KEYCLOAK_URL` | the public Keycloak base URL — baked into the SPA at build time |

Lock down both:

```bash
chmod 700 secrets
chmod 600 secrets/*.txt
chmod 600 .env
```

> **Do not commit `secrets/*.txt` or `.env`.** Both are excluded by `.gitignore`; verify with `git status` before any commit.

### 3.3 Adjust environment (optional)

Most settings live in `docker-compose.yml` under the `app` service. Edit if needed:

| Variable | Default | When to change |
|---|---|---|
| `VITE_LLM_ENDPOINT` | `https://llm.lab.aaseya.com/v1` | If the LLM endpoint moves |
| `VITE_LLM_MODEL` | `gpt-oss-20b` | To switch models |
| `JIRA_ENABLED` | `false` | Set `true` only if Jira integration is required |
| `ALLOW_PRIVATE_SCAN` | `false` | Set `true` to let ZAP scan internal/private IPs (relaxes the SSRF guard) |
| `KC_HOSTNAME` | `aaqua.aaseya.com` | Bare hostname only (no scheme, no port) — set to the public Keycloak hostname |
| `KC_HOSTNAME_PORT` | `8443` | Public port if non-standard (omit / leave default if serving on 443) |
| `KC_HOSTNAME_STRICT` | `true` | Rejects requests whose `Host` header doesn't match `KC_HOSTNAME` — prevents stale-IP / wrong-DNS access |
| `KC_HOSTNAME_STRICT_BACKCHANNEL` | `false` | Lets the backend container reach Keycloak via the docker-internal hostname for JWKS / token exchange |
| `KC_HOSTNAME_STRICT_HTTPS` | `false` | Set `true` once HTTPS is terminated upstream |
| `KC_PROXY_HEADERS` | unset | Set to `xforwarded` when fronted by a reverse proxy that terminates TLS (replaces deprecated `KC_PROXY=edge`) |

Token lifetimes (15-min access / 30-day refresh / password policy) are controlled by the realm export at `keycloak/aaseya-platform-realm.json` — edit there and restart Keycloak to apply.

### 3.4 Build and start

```bash
docker compose pull          # pulls postgres, zap, playwright base
docker compose build         # builds the bundled app image
docker compose up -d
```

First build can take **5–10 minutes** (Playwright base image ~1.5 GB, npm install, Vite build, apt install of nginx + supervisor).

### 3.5 Watch services come up

```bash
docker compose ps
```

Expected after ~90s (Keycloak's first boot is the slowest):

```
NAME              STATUS              PORTS
aaqua-postgres    Up (healthy)        0.0.0.0:5442->5432/tcp
aaqua-keycloak    Up (healthy)        0.0.0.0:8082->8080/tcp
aaqua-zap         Up (healthy)        0.0.0.0:8040->8080/tcp
aaqua-app         Up (healthy)        0.0.0.0:80->80/tcp
```

The `app` service `depends_on` postgres + zap + keycloak with `condition: service_healthy`, so it won't start until all three are healthy. Inside the `app` container, supervisord starts nginx and the Node backend together; both are required for the container to report healthy.

### 3.6 Smoke tests

```bash
# 1. SPA served
curl -I http://localhost/
# HTTP/1.1 200 OK

# 2. Backend rejects unauth (Keycloak owns the token issuance now)
curl -i http://localhost/api/security/projects
# HTTP/1.1 401 Unauthorized

# 3. Keycloak realm online
curl -s http://localhost:8082/realms/aaseya-platform/.well-known/openid-configuration | jq .issuer
# "http://localhost:8082/realms/aaseya-platform"  (or your KC_HOSTNAME)

# 4. ZAP version directly (via host port, for debugging)
curl http://localhost:8040/JSON/core/view/version/

# 5. Postgres reachable + both schemas present
docker exec aaqua-postgres psql -U aaqua -d aaqua_security -c "\dn"
# Should list public + keycloak

# 6. Both app processes alive inside the container
docker exec aaqua-app supervisorctl status
# nginx    RUNNING   pid 8, uptime 0:00:30
# backend  RUNNING   pid 9, uptime 0:00:30
```

### 3.7 Configure SMTP (real mail relay — required for QA / prod)

Unlike local dev (which uses the Mailpit catch-all container in `docker-compose.security.yml`), QA and prod **must** be wired to a real SMTP relay so verify-email and password-reset messages actually land in users' inboxes.

The realm export ships `smtpServer.host: "mailpit"` for the local dev case. On a QA/prod deployment, override it via the admin console (this persists in the Keycloak DB and survives realm re-imports):

1. `http://<qa-server>:8082/admin` → log in as `${KEYCLOAK_ADMIN_USER}` / `${KEYCLOAK_ADMIN_PASSWORD}` (master realm) → switch to **aaseya-platform**.
2. **Realm settings → Email** tab. Fill in the relay details. Examples:

   | Provider | Host | Port | Encryption | Auth |
   |---|---|---|---|---|
   | Office 365 | `smtp.office365.com` | `587` | StartTLS | App password on a service account |
   | Google Workspace | `smtp.gmail.com` | `587` | StartTLS | App password |
   | AWS SES | `email-smtp.<region>.amazonaws.com` | `587` | StartTLS | SES SMTP credentials |
   | Internal relay | as provided by IT | varies | varies | varies |

3. **From**: a real, deliverable address — e.g. `no-reply@aaseya.com`.
4. Click **Test connection** → confirm a test mail lands in the admin user's actual mailbox before saving.
5. **Save**.

> **Mailpit is local-dev only.** Do not include it in `docker-compose.yml` or `docker-compose.security.prod.yml` — they're intentionally clean of it.

### 3.8 Bootstrap admin passwords (one-shot)

The realm ships `sanjay.jain` and `kavita.chonkar` with no passwords (just `requiredActions: ["UPDATE_PASSWORD","VERIFY_EMAIL"]`). Set a temporary password for each via the Keycloak admin console:

1. `http://<qa-server>:8082/admin` → log in as `${KEYCLOAK_ADMIN_USER}` / `${KEYCLOAK_ADMIN_PASSWORD}`.
2. Realm dropdown → **aaseya-platform** → **Users**.
3. For each seed admin → **Credentials** → set a temporary password (the user changes it on first login).
4. After SMTP is configured (step 3.7), the user will receive verify-email mail at their real address on first login. If you skipped 3.7, log in once to clear the action manually via the admin console.

Then open `http://<qa-server>/` in a browser. Walk through:

1. Home page renders. Click any tool tile — you should be redirected to Keycloak.
2. Log in as one of the seed admins → forced UPDATE_PASSWORD → land back on the AAQUA tool with the email visible in the Header.
3. **Test Generator** — generate a small test case (exercises the browser-side LLM path through `/llm-api`).
4. **Security Scanner** — admin-only; should load for the seed admins.
5. **Test Runner** — upload a small Playwright project ZIP and run it.

---

## 4. Day-2 operations

### 4.1 View logs

```bash
docker compose logs -f                    # all services, tail
docker compose logs -f app                # the bundled app only
docker compose logs --since 10m app       # last 10 minutes

# Inside the app container, separate the two processes via supervisord:
docker exec aaqua-app supervisorctl tail -f nginx     stdout
docker exec aaqua-app supervisorctl tail -f backend   stdout
```

Save a snapshot for an incident:

```bash
docker compose logs --no-color > /tmp/aaqua-$(date +%F-%H%M).log
```

### 4.2 Restart

```bash
# Restart the whole bundled container (recovers both nginx and backend):
docker compose restart app

# Restart only one of the two processes inside (faster, no image reload):
docker exec aaqua-app supervisorctl restart backend
docker exec aaqua-app supervisorctl restart nginx
```

### 4.3 Update / redeploy

```bash
cd /opt/aaqua
git pull
docker compose build --pull            # rebuild images, pull base image updates
docker compose up -d                   # recreates only services whose images changed
docker image prune -f                  # reclaim disk
```

For a config-only change (compose YAML or secrets):

```bash
docker compose up -d                   # picks up the change, recreates affected services
```

### 4.4 Rotate a secret

Secret files (under `secrets/`) and `.env` values are loaded at startup; the running container holds the old value until restart.

**File-mounted secrets** (`secrets/*.txt`):

```bash
nano secrets/db_password.txt           # write the new value
# Postgres needs the new value applied to the live role before restart:
docker exec -it aaqua-postgres psql -U aaqua -d aaqua_security \
  -c "ALTER USER aaqua WITH PASSWORD '<new value>';"
docker compose up -d --force-recreate postgres app
```

**`.env`-substituted secrets** (Keycloak admin / DB passwords):

```bash
nano .env                              # update KEYCLOAK_DB_PASSWORD or KEYCLOAK_ADMIN_PASSWORD
# For the DB password, also rotate the Postgres role:
docker exec -i aaqua-postgres psql -U aaqua -d aaqua_security \
  -c "ALTER ROLE keycloak_user WITH PASSWORD '<new value>';"
docker compose up -d --force-recreate keycloak
```

> Rotating any password used for token signing (i.e. the realm's RSA keys, not these passwords) would invalidate all currently issued tokens. Rotating these env-level passwords does NOT — they're DB / admin-console credentials. To force-logout all users, instead use the Keycloak admin console: **Sessions → Sign out all active sessions**.

### 4.5 Postgres backup & restore

**Backup** (run nightly via cron):

```bash
docker exec aaqua-postgres pg_dump -U aaqua -Fc aaqua_security \
  > /opt/aaqua/backups/aaqua_security_$(date +%F).dump
```

Suggested cron entry:

```
0 2 * * *  cd /opt/aaqua && docker exec aaqua-postgres pg_dump -U aaqua -Fc aaqua_security > /opt/aaqua/backups/aaqua_security_$(date +\%F).dump && find /opt/aaqua/backups -name 'aaqua_security_*.dump' -mtime +14 -delete
```

**Restore**:

```bash
docker compose stop app
docker exec -i aaqua-postgres pg_restore -U aaqua -d aaqua_security --clean --if-exists \
  < /opt/aaqua/backups/aaqua_security_2026-04-27.dump
docker compose up -d app
```

### 4.6 Reset the database (destructive)

```bash
docker compose down
docker volume rm qa-test-gen_postgres_data    # exact name may differ — check `docker volume ls`
docker compose up -d
```

The backend will recreate all `public`-schema tables on next start via `sequelize.sync({ alter: true })`. Keycloak will re-create its `keycloak`-schema tables on first boot, AND re-import the realm export from `keycloak/aaseya-platform-realm.json` (because the realm no longer exists). You'll need to re-run the bootstrap admin password step (3.7) afterwards.

### 4.6a Cutover: drop the legacy `users` table

If you're upgrading a deployment that still has the old `users` table from the pre-Keycloak build:

```bash
npm run migrate:cutover
```

This drops the FK constraints on `projects.owner_id` / `scans.initiated_by` and the `users` table. Existing project/scan rows keep their `owner_id` UUIDs as plain values; new rows store the Keycloak `sub`.

### 4.7 Clear runtime artifacts

The backend writes uploaded ZIPs into container-internal `temp_uploads/` and extracts into `temp_extract/`. They're inside the container's writable layer and don't persist across recreates. If a runaway upload fills the layer:

```bash
docker exec aaqua-app sh -c 'rm -rf /app/temp_uploads/* /app/temp_extract/* /app/temp_output/*'
```

### 4.8 Tear down

```bash
docker compose down            # stop + remove containers, keep DB volume
docker compose down -v         # also wipe Postgres data (irreversible)
```

---

## 5. Rollback

If a deployment fails or the new build is unhealthy:

```bash
cd /opt/aaqua
git log --oneline -5                    # find the previous good commit
git checkout <previous-commit-sha>
docker compose build
docker compose up -d
```

Roll back the database only if the new release ran a destructive migration (uncommon — `sequelize.sync({ alter: true })` is mostly additive):

```bash
docker compose stop app
docker exec -i aaqua-postgres pg_restore -U aaqua -d aaqua_security --clean --if-exists \
  < /opt/aaqua/backups/<last-known-good>.dump
docker compose up -d app
```

---

## 6. Troubleshooting

**Container keeps restarting**
```bash
docker compose logs --tail=100 app
docker exec aaqua-app supervisorctl status   # which inner process is failing?
```
Common causes:
- `db_password.txt` doesn't match the password Postgres was initialised with → wipe the volume (4.6) or `ALTER USER` inside Postgres.
- ZAP not healthy → check `docker compose logs zap`; usually a memory issue. Bump container or host memory.
- nginx config render failed → check `docker exec aaqua-app cat /etc/nginx/conf.d/default.conf` for an unsubstituted `${LLM_API_KEY}`.

**Returns 502 on `/api/...`**
nginx can't reach the backend on the loopback. The Node process is either still starting or has died. Inside the container:
```bash
docker exec aaqua-app supervisorctl status backend
docker exec aaqua-app supervisorctl tail backend stdout
```

**Returns 502 on `/llm-api/...`**
The QA server can't reach `https://llm.lab.aaseya.com`. Test from inside:
```bash
docker exec aaqua-app wget -qO- https://llm.lab.aaseya.com/v1/models
```
If that fails, the issue is server-side networking, not AAQUA.

**`POST /api/run-tests` fails with `Browser not installed`**
The Playwright base image bundles browsers, but a custom `npm ci` step might prune them. Confirm with `docker exec aaqua-app ls /ms-playwright`. If empty, rebuild after removing the `--ignore-scripts` flag in `Dockerfile`.

**Disk filling up**
```bash
docker system df
docker image prune -f
docker exec aaqua-app sh -c 'rm -rf /app/temp_*/*'
```

**Need to inspect Postgres directly**
From the host:
```bash
psql "postgresql://aaqua@localhost:5442/aaqua_security"   # asks for db_password.txt value
```
Or from inside the container:
```bash
docker exec -it aaqua-postgres psql -U aaqua -d aaqua_security
```

---

## 7. Open security items (read before going public)

These are flagged because the user requested "available for all the end users." If the QA server is accessible only on the internal network or VPN, several of these can wait — but they should be addressed before any external exposure.

1. **Legacy endpoints are unauthenticated.** `/api/convert`, `/api/scrape`, `/api/run-tests*`, `/api/browser/*`, `/api/analyze-*` have no token check. The `/api/security/*` subsystem is protected by the Keycloak token middleware, but the legacy endpoints in `server/index.js` are not. Anyone who can reach `:80` can drive Playwright on the server. Mitigations: (a) firewall to VPN only, (b) add an nginx `auth_request` in front of `/api/` that validates the Keycloak token, or (c) wrap the legacy routes with the same `authenticateToken` middleware that protects `/api/security/*`.
2. **`/llm-api` is an open proxy.** nginx forwards anything under `/llm-api/` to the LLM endpoint with the production Authorization header. Anyone who can hit the QA server can spend the team's LLM quota. Mitigations: tighten the location block to specific paths (e.g. only `^/llm-api/v1/chat/completions$`), add `limit_req_zone`, and require an internal cookie or token.
3. **No TLS by default.** Compose publishes plain HTTP on `:80` and `:8082`. For external use, terminate TLS with a reverse proxy (Caddy / Traefik / nginx with certbot) in front of both. Once HTTPS is wired up, set `KC_HOSTNAME=<bare-hostname>` (+ `KC_HOSTNAME_PORT=<port>` if non-standard), `KC_HOSTNAME_STRICT=true`, `KC_HOSTNAME_STRICT_BACKCHANNEL=false`, `KC_HOSTNAME_STRICT_HTTPS=true`, `KC_PROXY_HEADERS=xforwarded` (replaces deprecated `KC_PROXY=edge`), and update the realm's `redirectUris` and `webOrigins` to the HTTPS frontend URL.
4. **Containers run as root.** Both `aaqua-app` (because supervisord manages nginx) and `aaqua-keycloak` (the upstream image's default) run as root. Acceptable for an internal QA box; not acceptable for a hardened deployment — switch to a non-root build of each image before exposing to the internet.
5. **`docker-compose.security.yml` is for local dev only.** It uses `start-dev` and `POSTGRES_HOST_AUTH_METHOD: trust`. Don't run it on the QA server; the production stack is `docker-compose.yml` only.
6. **Default admin passwords.** The bootstrap `${KEYCLOAK_ADMIN_PASSWORD}` and the seed admins' temporary passwords are powerful — make sure they're rotated to strong values and that the seed admins have completed UPDATE_PASSWORD before the system goes public.
7. **Realm export is the source of truth on first boot only.** Edits made via the Keycloak admin console after first boot persist in the `keycloak` schema and are NOT synced back to `keycloak/aaseya-platform-realm.json`. To version-control changes (new clients, password policy tweaks, additional admins), export from the admin console (**Realm settings → Action → Partial export**) and commit the diff.

---

## 8. Quick reference

```bash
# bring up
docker compose up -d --build

# bring down
docker compose down

# wipe everything including DB
docker compose down -v

# logs
docker compose logs -f [service]

# restart one service
docker compose restart [service]

# update
git pull && docker compose build --pull && docker compose up -d

# backup DB
docker exec aaqua-postgres pg_dump -U aaqua -Fc aaqua_security > backup.dump

# enter a container
docker exec -it aaqua-app sh
docker exec -it aaqua-postgres psql -U aaqua -d aaqua_security

# inner-process control (inside aaqua-app)
docker exec aaqua-app supervisorctl status
docker exec aaqua-app supervisorctl restart {nginx|backend}

# health
curl http://localhost/api/security/zap/health
docker compose ps
```
