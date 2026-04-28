# AAQUA — QA Server Deployment Guide

How to deploy the AAQUA stack to a shared QA server using Docker Compose. Frontend and backend are bundled into a **single image** (`Dockerfile`); Postgres and OWASP ZAP run as separate containers because they're stateful infra with independent lifecycles.

> For local developer setup (running Vite + Express directly on the host), see `LOCAL_SETUP.md`.

---

## 1. What gets deployed

```
        ┌─────────────────────── Internet / LAN ───────────────────────┐
        │                                                              │
        │                         :80                                  │
        │                          ▼                                   │
        │              ┌────────────────────────┐                      │
        │              │  app  (single image)   │                      │
        │              │ ┌────────────────────┐ │                      │
        │              │ │ nginx :80          │ │  serves SPA          │
        │              │ │  /api/    → :3001  │ │  /llm-api/ → llm.lab │
        │              │ │  /llm-api → llm... │ │  (Auth header from   │
        │              │ └─────────┬──────────┘ │   Docker secret)     │
        │              │           │ loopback   │                      │
        │              │ ┌─────────▼──────────┐ │                      │
        │              │ │ node :3001         │ │  Express + Playwright│
        │              │ │ (not host-exposed) │ │                      │
        │              │ └─────────┬──────────┘ │                      │
        │              └───────────┼────────────┘                      │
        │                          │                                   │
        │                ┌─────────┴────────┐                          │
        │           ┌────▼──┐          ┌────▼──┐                       │
        │           │ pg 16 │          │  ZAP  │                       │
        │           │ :5432 │          │ :8080 │                       │
        │           └───────┘          └───────┘                       │
        │   host:5442 ─┘                  host:8040 ─┘ (tooling only)  │
        └──────────────────────────────────────────────────────────────┘
```

| Service | Image | Internal | Host | Public? |
|---|---|---|---|---|
| `app` | built from `Dockerfile` (Playwright v1.58 + nginx + supervisord) | 80 (nginx), 3001 (node, loopback only) | **80** | yes — single entrypoint |
| `postgres` | `postgres:16-alpine` | 5432 | **5442** | tooling only |
| `zap` | `ghcr.io/zaproxy/zaproxy:stable` | 8080 | **8040** | tooling only |

Inside the `app` container, **supervisord** runs nginx and the Node backend together. nginx is the only listener bound to the container's external interface; Express on `:3001` is bound to the loopback and reached only via nginx's `proxy_pass http://127.0.0.1:3001`. End users hit `http://<qa-server>/` — only port 80 needs to be open externally. Ports 5442 and 8040 should be firewalled to the office / VPN only; they exist for pgAdmin / ZAP UI access during debugging.

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
| Inbound | TCP 80 open to end users; 5442/8040 restricted |

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

Docker Compose mounts secrets from `./secrets/*.txt` into each container at `/run/secrets/<name>`. The repo ships only `*.example` templates — the real `.txt` files are gitignored and **must be created on the server**.

```bash
cd /opt/aaqua
cp secrets/llm_api_key.txt.example   secrets/llm_api_key.txt
cp secrets/jwt_secret.txt.example    secrets/jwt_secret.txt
cp secrets/db_password.txt.example   secrets/db_password.txt
cp secrets/jira_token.txt.example    secrets/jira_token.txt
```

Edit each file and put the real value (no trailing newline if your editor will let you avoid it):

| File | Source / generation |
|---|---|
| `secrets/llm_api_key.txt` | The `VITE_LLM_API_KEY` provided by the AI platform team |
| `secrets/jwt_secret.txt` | `openssl rand -hex 48` — used to sign auth tokens for `/api/security/*` |
| `secrets/db_password.txt` | `openssl rand -base64 24` — Postgres password for the `aaqua` user |
| `secrets/jira_token.txt` | Jira API token (only if `JIRA_ENABLED=true`; leave empty otherwise) |

Lock down the directory:

```bash
chmod 700 secrets
chmod 600 secrets/*.txt
```

> **Do not commit `secrets/*.txt`.** `secrets/.gitignore` already excludes them, but double-check with `git status` before any commit.

### 3.3 Adjust environment (optional)

Most settings live in `docker-compose.yml` under the `backend` service. Edit if needed:

| Variable | Default | When to change |
|---|---|---|
| `VITE_LLM_ENDPOINT` | `https://llm.lab.aaseya.com/v1` | If the LLM endpoint moves |
| `VITE_LLM_MODEL` | `gpt-oss-20b` | To switch models |
| `JIRA_ENABLED` | `false` | Set `true` only if Jira integration is required |
| `ALLOW_PRIVATE_SCAN` | `false` | Set `true` to let ZAP scan internal/private IPs (relaxes the SSRF guard) |
| `JWT_EXPIRES_IN` | `24h` | Token lifetime |

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

Expected after ~60s:

```
NAME              STATUS              PORTS
aaqua-postgres    Up (healthy)        0.0.0.0:5442->5432/tcp
aaqua-zap         Up (healthy)        0.0.0.0:8040->8080/tcp
aaqua-app         Up (healthy)        0.0.0.0:80->80/tcp
```

The `app` service `depends_on` postgres + zap with `condition: service_healthy`, so it won't start until both are healthy. Inside the container, supervisord starts nginx and the Node backend together; both are required for the container to report healthy.

### 3.6 Smoke tests

```bash
# 1. SPA served
curl -I http://localhost/
# HTTP/1.1 200 OK

# 2. Backend reachable through nginx → loopback :3001
curl http://localhost/api/security/zap/health
# {"status":"connected","version":"..."}

# 3. ZAP version directly (via host port, for debugging)
curl http://localhost:8040/JSON/core/view/version/

# 4. Postgres reachable from host (for tooling)
docker exec aaqua-postgres pg_isready -U aaqua -d aaqua_security

# 5. Both processes alive inside the container
docker exec aaqua-app supervisorctl status
# nginx    RUNNING   pid 8, uptime 0:00:30
# backend  RUNNING   pid 9, uptime 0:00:30
```

Then open `http://<qa-server>/` in a browser. Walk through:

1. Home page renders with the AAQUA sidebar.
2. **Test Generator** — generate a small test case (exercises the browser-side LLM path through `/llm-api`).
3. **Security Scanner** — hit ZAP health (exercises backend → ZAP).
4. **Test Runner** — upload a small Playwright project ZIP and run it.

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

Secret files are mounted at startup; the running container holds the old value until restart.

```bash
nano secrets/jwt_secret.txt            # write the new value
docker compose up -d --force-recreate app
```

> Rotating `jwt_secret.txt` invalidates all currently issued tokens — users will need to log in again. Rotating `db_password.txt` also requires running `ALTER USER aaqua WITH PASSWORD '...'` inside Postgres before restart, or Postgres will reject backend connections.

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

The backend will recreate all tables on next start via `sequelize.sync({ alter: true })`.

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

1. **Legacy endpoints are unauthenticated.** `/api/convert`, `/api/scrape`, `/api/run-tests*`, `/api/browser/*`, `/api/analyze-*` have no JWT check. Anyone who can reach `:80` can drive Playwright on the server. Mitigations: (a) firewall to VPN only, (b) add an nginx `auth_basic` in front of `/api/`, or (c) port the legacy routes onto the same JWT middleware that protects `/api/security/*`.
2. **`/llm-api` is an open proxy.** nginx forwards anything under `/llm-api/` to the LLM endpoint with the production Authorization header. Anyone who can hit the QA server can spend the team's LLM quota. Mitigations: tighten the location block to specific paths (e.g. only `^/llm-api/v1/chat/completions$`), add `limit_req_zone`, and require an internal cookie or token.
3. **No TLS.** Compose publishes plain HTTP on `:80`. For external use, terminate TLS with a reverse proxy (Caddy / Traefik / nginx with certbot) in front of `aaqua-app`, or replace the published port with `443` and mount a certificate.
4. **App container runs as root.** The Playwright image's default user is root, and supervisord here also runs as root so it can manage nginx. Acceptable for an internal QA box; not acceptable for a hardened deployment.
5. **`docker-compose.security.yml` still in the repo.** It's the local-dev infra file used for `npm run server` workflows. Don't run it on the QA server — it ships a hardcoded Postgres password (`aaqua/aaqua`) and `POSTGRES_HOST_AUTH_METHOD: trust`. The production stack is `docker-compose.yml` only.

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
