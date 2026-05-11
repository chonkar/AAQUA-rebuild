# Shared-infrastructure deployment for AAQUA on `10.13.1.182`

**Date:** 2026-05-08
**Author:** jain.sanjay@aaseya.com
**Status:** Approved (brainstorming) — pending writing-plans handoff

## 1. Goal

Deploy AAQUA (this repo) to the Ubuntu host `10.13.1.182` in a way that
introduces a host-wide **shared-infrastructure tier** (Postgres 17, Nginx,
Keycloak) that future projects on the same host can also adopt as tenants.
AAQUA becomes the first tenant.

The host already runs an unrelated `momthathel-*` stack (Camunda admin
services). That stack is **untouched** by this work.

## 2. Decisions taken

| Decision | Choice | Notes |
|---|---|---|
| Shared infra existed already? | No — created by this work | Despite container name `shared-infra` the user mentioned, no such container is on the host today. The whole stack is new. |
| Postgres version | **17-alpine** (new cluster) | momthathel runs 16; not migrated. |
| Public routing model | **Path-prefix** — `/aaqua/`, `/auth/`, future `/<tenant>/` | Subdomain rejected: avoids DNS / TLS-cert-per-host coordination today. |
| TLS | Deferred ("later") | LAN-only QA box for now. Edge nginx is HTTP on `:80`. |
| Integration model | **Approach B** — slim AAQUA, shared nginx serves SPA + does LLM-key injection | Pros: thin tenant containers, single nginx tier, secret stays at edge. Cons: AAQUA `Dockerfile` rework + SPA extraction step. |
| Postgres tenancy | **One DB per tenant** + tenant-scoped login role | Stronger isolation than today's "two schemas in one DB". |
| Keycloak tenancy | **One shared Keycloak, one realm per tenant** | AAQUA's existing `aaseya-platform` realm imports unchanged (with templated URLs). |
| ZAP | Stays inside AAQUA (`/opt/aaqua/`) | Not promoted to shared until a second project needs it. |

## 3. Architecture

### 3.1 Host layout

```
/opt/shared-infra/                        NEW shared compose project
├── docker-compose.yml                    postgres-17 + nginx + keycloak
├── .env                                  KC + DB passwords
├── nginx/                                edge config + tenant SPA bundles
├── postgres/init/                        first-boot tenant provisioning
├── keycloak/realms/                      rendered realm JSON (first-boot import)
├── scripts/                              render-realm.sh, onboard-aaqua.sh
└── secrets/                              per-tenant secret files

/opt/aaqua/                               EXISTING repo, slimmed
├── docker-compose.yml                    only `app` + `zap`; joins external network
├── Dockerfile                            backend-only (no nginx, no supervisord)
├── scripts/publish-spa.sh                extracts dist/ to shared-infra
├── scripts/shared-infra-template/        committed source-of-truth for shared stack
└── ...

/opt/momthathel/                          UNTOUCHED, on its own private stack
```

### 3.2 Container layout

| Container | Image | Network | Public port | Owns |
|---|---|---|---|---|
| `shared-nginx` | `nginx:1.27-alpine` | `shared-infra_default` | **80** (the only one) | Static SPA serving + tenant routing + LLM auth-header injection |
| `shared-postgres` | `postgres:17-alpine` | `shared-infra_default` | 5443 (tooling) | Multi-DB cluster |
| `shared-keycloak` | `quay.io/keycloak/keycloak:24.0` | `shared-infra_default` | none | IAM, multi-realm |
| `aaqua-app` | built from `Dockerfile` | `shared-infra_default` (external) | none | Express + Playwright on `:3001` |
| `aaqua-zap` | `ghcr.io/zaproxy/zaproxy:stable` | `shared-infra_default` (external) | none | OWASP ZAP daemon |

Only `shared-nginx` publishes a host port. Postgres and Keycloak are
internal-only — tooling access is `docker exec` or via the dedicated `5443`
psql port (firewall to LAN/VPN).

### 3.3 Routing (single shared `server` block)

```
http://10.13.1.182/                       → 302 /aaqua/
http://10.13.1.182/healthz                → "ok" (edge healthcheck)
http://10.13.1.182/auth/<...>             → http://shared-keycloak:8080/auth/<...>
http://10.13.1.182/aaqua/                 → static SPA from /var/www/aaqua/
http://10.13.1.182/aaqua/api/<...>        → http://aaqua-app:3001/api/<...>
http://10.13.1.182/aaqua/llm-api/<...>    → https://llm.lab.aaseya.com/<...>
                                            with `Authorization: Bearer ${AAQUA_LLM_API_KEY}`
                                            injected at the edge.
```

`AAQUA_LLM_API_KEY` is loaded from
`/opt/shared-infra/secrets/aaqua/llm_api_key.txt` at nginx start by
`/docker-entrypoint.d/10-load-tenant-secrets.envsh` (the standard
nginx-image entrypoint hook, sourced so envvars persist), then envsubst'd
into the rendered tenant config in `/etc/nginx/tenants.d/aaqua.conf`.

Keycloak is configured with `KC_HTTP_RELATIVE_PATH=/auth` so the host root
is free for tenants. `KC_PROXY=edge` makes it trust `X-Forwarded-*` headers
from `shared-nginx` (works for both HTTP today and HTTPS later).

## 4. Concrete artifacts

### 4.1 New / changed files

| Path | What | Change |
|---|---|---|
| `Dockerfile` | AAQUA image | **Rewrite** — drop nginx, supervisord, gettext-base, tini; backend-only entrypoint `node server/index.js`. |
| `docker-compose.yml` | AAQUA compose | **Slim** — remove `postgres`, `keycloak` services; `app` joins `external: shared-infra_default`; secrets sourced from `/opt/shared-infra/secrets/aaqua/`. |
| `vite.config.js` | Vite build | Add `base: process.env.VITE_BASE_PATH \|\| '/'`. |
| `src/App.jsx` | React Router | `<Router basename={import.meta.env.BASE_URL.replace(/\/$/, '') \|\| undefined}>`. |
| `src/auth/oidcConfig.js` | OIDC config | Prefix `redirect_uri` and `post_logout_redirect_uri` with `import.meta.env.BASE_URL` — **fixes a `/auth/callback` collision with shared Keycloak**. |
| `src/utils/apiClient.js` | API fetcher | Prepend `import.meta.env.BASE_URL.replace(/\/$/, '')` to every request path. Single edit — no caller changes. |
| `src/utils/llmClient.js` | LLM CORS-bypass | Same prefix on the `/llm-api` rewrite. |
| `keycloak/aaseya-platform-realm.template.json` | New | Templated realm with `${PUBLIC_BASE_URL}` placeholders for `rootUrl`, `baseUrl`, `redirectUris`, `webOrigins`. The committed `aaseya-platform-realm.json` (with `localhost:5173` URLs) stays for local dev. |
| `scripts/publish-spa.sh` | New | `docker build --target frontend-build` then `docker cp` to `/opt/shared-infra/nginx/sites/aaqua/`. |
| `scripts/shared-infra-template/` | New tree | Source-of-truth for shared-infra files. The host's `/opt/shared-infra/` is seeded from this dir on first deploy. |

### 4.2 Files deleted

`docker/nginx.conf.template`, `docker/supervisord.conf`, and the bulk of
`docker/app-entrypoint.sh` (the nginx-config envsubst path). The
`docker/` directory itself goes away unless something still needs it.

### 4.3 Files unchanged but worth a sweep during implementation

`window.location.href`, `window.location.replace`, and hand-rolled
`<a href="/...">` calls anywhere in `src/` could bypass React Router's
`basename` and 404 in QA. Grep is the verification step.

## 5. Operational model

### 5.1 First deploy

Documented in §7.2 of the brainstorming transcript; condensed here:

1. `mkdir -p /opt/{shared-infra,aaqua}` (chown to deploy user).
2. Clone AAQUA into `/opt/aaqua`, check out the branch with this work.
3. `cp -r /opt/aaqua/scripts/shared-infra-template/. /opt/shared-infra/`.
4. Configure `/opt/shared-infra/.env` (admin/db passwords, `KC_PUBLIC_BASE_URL=http://10.13.1.182`); `chmod 600`.
5. `openssl rand -base64 24 > /opt/shared-infra/secrets/postgres_super_password.txt`.
6. `bash /opt/shared-infra/scripts/onboard-aaqua.sh` — generates per-tenant secrets, renders the realm template, publishes the SPA bundle.
7. `cd /opt/shared-infra && docker compose up -d`.
8. `cd /opt/aaqua && docker compose up -d --build`.
9. Smoke tests (health, OIDC discovery, SPA, 401 on protected `/api/`).
10. Bootstrap seed-admin passwords in the Keycloak admin console (per existing `DEPLOYMENT.md:226-231`, new URL).
11. Browser smoke: log in, confirm URL bar stays under `/aaqua/` throughout (catches the redirect-URI collision).

### 5.2 Update / redeploy

```bash
cd /opt/aaqua
git pull
bash scripts/publish-spa.sh                       # re-publish SPA
docker compose build --pull && docker compose up -d   # rebuild backend
```

Shared-infra is touched only when its config changes:

```bash
cd /opt/aaqua
git pull
cp -r scripts/shared-infra-template/. /opt/shared-infra/   # carry forward edits
cd /opt/shared-infra
docker compose up -d                              # picks up changes
```

The `cp -r` is safe to re-run: the template ships only versioned files
(`docker-compose.yml`, `.env.example`, `nginx/conf.d/*`, scripts, etc.),
never the generated artifacts (`.env`, `secrets/aaqua/*.txt`,
`keycloak/realms/*.json`, `nginx/sites/aaqua/`). Generated files are
produced by `onboard-aaqua.sh` and `publish-spa.sh` and live alongside
the templated ones in `/opt/shared-infra/` without overlap.

### 5.3 Rollback

`docker compose down` in either directory (no `-v`); independent
lifecycles. `momthathel-*` is unaffected by either operation.

### 5.4 Adding a second tenant later

The shared stack is tenant-aware by convention:
- New DB + role on shared-postgres via the same `create_tenant` helper in `01-bootstrap-tenants.sh` (run manually with `docker exec` once the cluster is up).
- New realm in shared-keycloak (admin console or templated import).
- New `<tenant>.conf.template` dropped in `nginx/conf.d.templates/`.
- New `secrets/<tenant>/` directory.
- New `nginx/sites/<tenant>/` directory mounted into shared-nginx.

The shared-infra design intentionally has no AAQUA-specific code paths —
AAQUA is just the first tenant.

## 6. Security posture

| Concern | Today (project-private compose) | After this work |
|---|---|---|
| Postgres exposed | host `:5442` published in compose | Internal only; `:5443` is tooling-only and firewallable |
| Keycloak exposed | host `:8082` published | Internal; reachable only via shared-nginx `/auth/` |
| Auth method on Postgres | `trust` in dev compose, password in prod | `scram-sha-256` (Postgres 17 default) |
| Tenant data isolation | Two schemas + `search_path` discipline | One DB per tenant — Postgres rejects cross-DB at protocol level |
| LLM key in browser bundle | No (already injected at nginx layer) | No change — same pattern, relocated to shared edge |
| Realm import drift | First-boot only (existing gotcha) | Same gotcha — surfaces in the runbook |

**Pre-existing security debt not addressed by this work** (per
`DEPLOYMENT.md:448-459`):

- Legacy `/api/*` endpoints (`/api/convert`, `/api/run-tests*`,
  `/api/scrape`, `/api/browser/*`, `/api/analyze-*`) have **no** Keycloak
  auth check. `/api/security/*` is protected; the others aren't.
- `/llm-api/*` is an open proxy — anyone reaching `:80` can spend LLM
  quota.
- All containers still run as root.

These are AAQUA-backend tickets, not DevOps tickets, and are out of scope
here.

## 7. Out-of-scope follow-ups (tracked, not done)

| Item | Trigger to revisit |
|---|---|
| TLS at the edge (`:443`, certbot, `KC_HOSTNAME=https://...`, `KC_HOSTNAME_STRICT_HTTPS=true`) | Before any external exposure |
| Migrating momthathel to shared-infra | Its next major upgrade |
| Auth-gating legacy `/api/*` endpoints | Before any external exposure |
| Tightening `/llm-api/` (rate limit, internal token gate) | Same |
| CI/CD pipeline (auto `publish-spa.sh` + `compose up -d --build app`) | After manual baseline is stable |
| Postgres backup cron (`pg_dump -Fc` nightly) | Before "going production" — pattern matches existing `DEPLOYMENT.md:328` |
| Container resource limits | When `docker stats` shows pressure |

## 8. Validation checkpoints

For the implementation plan to call out (not exhaustive — the plan will
expand each into concrete checks):

1. **Pre-flight** — `free -h` shows ≥4 GB headroom; `:80` is unbound.
2. **Shared stack healthy** — `docker compose ps` in `/opt/shared-infra`
   shows all three services `(healthy)` within ~90 s.
3. **OIDC discovery responds correctly** —
   `curl http://10.13.1.182/auth/realms/aaseya-platform/.well-known/openid-configuration`
   returns `iss = http://10.13.1.182/auth/realms/aaseya-platform`.
4. **`/aaqua/api/` returns 401 without a token** — confirms backend
   reachability + token middleware.
5. **Browser smoke test** — login redirects round-trip to
   `http://10.13.1.182/aaqua/auth/callback` (NOT `/auth/callback`).
   This is the load-bearing check for the redirect-URI collision fix in
   `src/auth/oidcConfig.js`.
6. **Hardcoded-path sweep** — `grep -rE
   "(window\.location\.(href|replace)|<a [^>]*href=\"/)"` in `src/` shows
   no remaining absolute paths that bypass `basename`.
7. **Tenant isolation** — connecting as `aaqua_app` to the `keycloak` DB
   fails even with the correct password (Postgres rejects cross-DB access
   that wasn't explicitly granted to the role). Verifies the
   one-DB-per-tenant model is actually enforcing isolation.

## 9. Open questions resolved during brainstorming

- **Shared infra greenfield-on-brownfield?** Yes — the host has only
  momthathel-* containers; no shared stack pre-existed.
- **Keep AAQUA's internal nginx?** No — Approach B strips it; SPA is
  served by shared-nginx, LLM-key injection moves to shared-nginx.
- **Where does `secrets/llm_api_key.txt` live?** Single source at
  `/opt/shared-infra/secrets/aaqua/llm_api_key.txt`; AAQUA's compose
  mounts it via Docker secret for the Node-side LLM client (server
  routes), and shared-nginx reads it for the browser-facing `/llm-api/`
  proxy. One file, two consumers.
- **One DB per tenant or schemas in one DB?** One DB per tenant — strong
  isolation default for shared infra.
- **Path-prefix or subdomain?** Path-prefix (`/aaqua/`) — no DNS
  coordination needed today.
