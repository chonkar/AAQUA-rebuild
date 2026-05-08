# AAQUA — Local Development Setup

How to run the full AAQUA stack on a developer workstation. The frontend (Vite) and backend (Express) run directly on the host via `npm`; Postgres and OWASP ZAP run as containers via the `docker-compose.security.yml` infrastructure file.

> For deploying to a shared QA / staging server, see `DEPLOYMENT.md` instead — that uses the full Dockerized stack (`docker-compose.yml`).

---

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20.x LTS | matches the Playwright base image used in production |
| npm | 10.x | bundled with Node 20 |
| Docker Desktop | latest | needed only for Postgres + ZAP |
| Git | any | |

Verify:

```bash
node -v        # v20.x
npm -v         # 10.x
docker -v
docker compose version
```

Also reserve these host ports — make sure nothing else is bound to them:

| Port | Service |
|---|---|
| 5173 | Vite dev server (frontend) |
| 3001 | Express backend |
| 5433 | Postgres (host → container 5432) |
| 8080 | OWASP ZAP daemon |
| 8082 | Keycloak (IAM) — login redirects land here |
| 8025 | Mailpit web UI — view captured emails |
| 1025 | Mailpit SMTP — Keycloak sends mail here over the docker network; host port is exposed for ad-hoc debugging |

---

## 2. Clone & install

```bash
git clone <repo-url> qa-test-gen
cd qa-test-gen
npm install
```

`npm install` automatically downloads the Chromium build that matches the pinned Playwright version (~280 MB, one-time, cached at `~/AppData/Local/ms-playwright` on Windows or `~/.cache/ms-playwright` on macOS/Linux). This is wired via the `postinstall` script in `package.json`, so subsequent `playwright` version bumps refetch the matching browser on the next `npm install` automatically — no manual `npx playwright install` needed.

---

## 3. Configure `.env`

If you don't already have a `.env`, copy the template:

```bash
cp .env.example .env
```

Then fill in the empty values. The most important keys for local dev:

```
VITE_LLM_API_KEY=sk-...                        # provided by the AI platform team
DATABASE_URL=postgresql://aaqua:aaqua@localhost:5433/aaqua_security
KEYCLOAK_ADMIN_PASSWORD=<strong>               # bootstraps the Keycloak superadmin
KEYCLOAK_DB_PASSWORD=<strong>                  # password for the keycloak_user PG role
KEYCLOAK_REALM_URL=http://localhost:8082/realms/aaseya-platform
VITE_KEYCLOAK_URL=http://localhost:8082
VITE_KEYCLOAK_REALM=aaseya-platform
VITE_KEYCLOAK_CLIENT_ID=aaqua-frontend
```

> The same `VITE_*` variables are read both in the browser (via `import.meta.env`) and in the Node server (via `process.env` after `dotenv.config()`). Don't rename them.

---

## 4. Start Postgres + Keycloak + ZAP + Mailpit

```bash
docker compose -f docker-compose.security.yml up -d
```

This brings up four containers:

- `aaqua-postgres` — Postgres 16, exposed on host **5433**. Hosts two schemas: `public` (app data) and `keycloak` (IAM data).
- `aaqua-keycloak` — Keycloak 24 IAM, exposed on host **8082**. Auto-imports the realm config from `keycloak/aaseya-platform-realm.json`.
- `aaqua-zap` — OWASP ZAP daemon on host **8080**, API key disabled for local dev.
- `aaqua-mailpit` — Mailpit SMTP catcher. Web UI on host **8025**, SMTP on **1025**. Captures every email Keycloak sends (verify-email, password reset) without delivering to a real inbox. **Local-only — never deployed to QA / prod**, real SMTP is configured there.

Wait until all four are healthy:

```bash
docker compose -f docker-compose.security.yml ps
# STATUS should show "healthy" for postgres + keycloak + zap + mailpit
```

> **Fresh-volume note.** The Postgres init script (`keycloak/init/01-keycloak-schema.sh`) only runs the first time the volume is created. If you're working with a pre-existing volume, run it once manually:
>
> ```bash
> docker exec -e KEYCLOAK_DB_PASSWORD="$(grep ^KEYCLOAK_DB_PASSWORD .env | cut -d= -f2-)" \
>   aaqua-postgres bash /docker-entrypoint-initdb.d/01-keycloak-schema.sh
> ```

**Optional** — confirm both schemas exist:

```bash
docker exec aaqua-postgres psql -U aaqua -d aaqua_security -c "\dn"
# Should list `public` and `keycloak`
```

The first time the backend boots it runs `sequelize.sync({ alter: true })` against the **public** schema only (Keycloak owns the `keycloak` schema), creating `projects`, `scans`, `vulnerabilities`, `governance_metrics`.

---

## 5. Start the backend

In one terminal:

```bash
npm run server
```

Expected log lines:

```
✓ Database connection established successfully.
✓ All models synchronized.
✓ Database initialized successfully
🚀 AAQUA Server running on port 3001
```

> If you see `⚠ Database connection failed — security features unavailable`, the DB isn't reachable. The server **keeps running** on purpose so the legacy non-security endpoints still work. Re-check that `aaqua-postgres` is healthy and that `DATABASE_URL` points at `localhost:5433`.

Smoke test:

```bash
curl http://localhost:3001/api/security/zap/health
# {"status":"connected", ...}
```

---

## 6. Start the frontend

In a second terminal:

```bash
npm run dev
```

Vite serves on **http://localhost:5173**. The dev server proxies:

- `/api/*` → `http://localhost:3001` (Express backend)
- `/llm-api/*` → `https://llm.lab.aaseya.com` (browser LLM calls — bypasses CORS)

Open http://localhost:5173 in a browser. You should see the AAQUA home page with the sidebar of features (Test Generator, Test Plan, Locator, Test Converter, Framework Generator, Test Runner, Localization, Accessibility, Security Scanner, etc.).

### 6.1 First-time login (one-shot per environment)

Authenticated routes will redirect you to Keycloak. The realm ships with two pre-seeded admins, but neither has a password yet — set them once via the Keycloak admin console:

1. Visit `http://localhost:8082/admin` and log in as `superadmin` / `${KEYCLOAK_ADMIN_PASSWORD}` from your `.env`.
2. Realm dropdown → switch to **aaseya-platform** → **Users**.
3. For each of `sanjay.jain` and `kavita.chonkar`:
   - **Credentials** tab → set a temporary password.
   - The user must change it on first login (the realm export sets `requiredActions: ["UPDATE_PASSWORD","VERIFY_EMAIL"]`).

The realm JSON ships with `smtpServer` already pointing at the Mailpit container (host: `mailpit`, port: `1025`, no auth, no TLS). On a fresh Keycloak boot this is picked up automatically. **For an existing Keycloak DB** (the realm was already imported before Mailpit was wired in), apply it via the admin console: **Realm settings → Email** → Host `mailpit`, Port `1025`, From `no-reply@aaseya.local`, all TLS/auth toggles **OFF** → **Save** → **Test connection** (the test mail will arrive at http://localhost:8025).

Now navigate to `http://localhost:5173/security-scanner`, log in as one of the admins:
1. Enter the temp password, get prompted to update it (UPDATE_PASSWORD action).
2. Get prompted to verify email — Keycloak emits the verification mail; open http://localhost:8025, click the link inside the message preview to complete the action.
3. You land back in the app with the email + Sign Out visible in the header.

---

## 7. Verify end-to-end

| Check | How |
|---|---|
| Frontend reaches backend | DevTools → Network → confirm calls to `/api/...` return 200 |
| Browser-side LLM works | Open **Test Generator**, generate a case from a small input — output should populate without 401/403 |
| Server-side LLM works | Open **Test Converter**, upload a tiny ZIP — conversion should run |
| Postgres + ZAP wired | Open **Security Scanner**, hit the health endpoint; ZAP version should display |
| Playwright as library | Open **Accessibility Scanner**, point at `https://example.com`, run scan |
| Playwright as runner | Open **Test Runner**, upload a small Playwright project ZIP and run |
| OIDC flow works | Visit a protected route in incognito → redirects to Keycloak → log in → returns to the app with the email visible in the Header |
| Role gating works | Log in as a non-admin Keycloak user → `/security-scanner` shows a Forbidden screen |
| Email flow works | Trigger any Keycloak email (login as a user with `VERIFY_EMAIL`, or "Forgot password?") → message lands in Mailpit at http://localhost:8025 within 1s |

---

## 8. Common dev commands

```bash
npm run dev         # frontend (Vite, :5173)
npm run server      # backend (Express, :3001) — loads .env
npm run build       # production bundle into dist/
npm run preview     # preview the built bundle
npm run lint        # eslint .
```

Stop / restart infra:

```bash
docker compose -f docker-compose.security.yml stop
docker compose -f docker-compose.security.yml start
docker compose -f docker-compose.security.yml down       # remove containers
docker compose -f docker-compose.security.yml down -v    # also wipe DB volume
```

> There is **no test framework wired up**. The `test_*.js`, `tmp-test-llm.js`, `debug_llm.js`, `apply_fixes.cjs` files at the repo root are ad-hoc debug scripts — run with `node <file>` only when you need them.

---

## 9. Troubleshooting

**Backend exits with `ECONNREFUSED 127.0.0.1:5432`**
You're hitting the wrong Postgres port. Local Postgres runs on **5433**, not 5432. Confirm `DATABASE_URL` in `.env` ends with `:5433/aaqua_security`.

**Login redirects to Keycloak but errors with `Invalid redirect URI`**
The `aaqua-frontend` client's `redirectUris` in `keycloak/aaseya-platform-realm.json` is `http://localhost:5173/*`. If you run Vite on a different host or port, edit the JSON and restart Keycloak (`docker compose -f docker-compose.security.yml restart keycloak`).

**Keycloak boots but `/realms/aaseya-platform` returns 404**
Realm import was skipped because the realm already exists in the schema. To force a fresh import: stop Keycloak, drop only the `keycloak` schema (`DROP SCHEMA keycloak CASCADE`), re-run the init script, restart Keycloak.

**Backend rejects every token with "Token audience mismatch"**
`KEYCLOAK_AUDIENCE` in `.env` doesn't match the `azp` claim in the SPA's tokens. The SPA's token comes from the `aaqua-frontend` client, so set `KEYCLOAK_AUDIENCE=aaqua-frontend`.

**Frontend shows `API Key is missing`**
`VITE_LLM_API_KEY` is empty in `.env`, or `.env` was loaded *after* Vite started. Stop `npm run dev`, fix the value, and restart.

**Accessibility / Localization scanner fails with "Executable doesn't exist at ...chromium-NNNN..."**
The `playwright` lib version in `package.json` was bumped but the matching browser revision wasn't fetched. The `postinstall` hook normally handles this on `npm install`, but if you ran `npm install --ignore-scripts` or interrupted the postinstall, run it manually:
```bash
npx playwright install chromium
```
On Linux dev machines, you may also need `npx playwright install-deps chromium` once (system libs).

**Keycloak verify-email / password-reset emails don't arrive in Mailpit**
Two common causes:
- Realm SMTP still points at an old config (e.g. Office 365 from a prior attempt). Admin console → **Realm settings → Email** → Host must be `mailpit`, all TLS/auth toggles OFF → **Save**, then **Test connection**.
- Mailpit container isn't on the `aaqua-net` network. Check with `docker network inspect qa-test-gen_aaqua-net` — it should list `aaqua-mailpit` alongside `aaqua-keycloak`. If missing, `docker compose -f docker-compose.security.yml up -d mailpit`.

**ZAP container restarts forever**
ZAP is memory-hungry. Make sure Docker Desktop has at least 4 GB allocated (Settings → Resources). The compose file caps ZAP at 2 GB.

**Port 5433 / 8080 / 5173 / 3001 already in use**
On Windows: `netstat -ano | findstr :<port>` → `taskkill /PID <pid> /F`. On macOS/Linux: `lsof -i :<port>` → `kill <pid>`. If you can't free a port, change the host mapping in `docker-compose.security.yml` and update `.env` to match.

**`temp_extract/` or `node_test_extract/` filling up**
These are leftovers from `/api/convert` and `/api/run-tests` runs. Safe to delete when no upload is in flight.

---

## 10. Project layout cheat sheet

```
src/                  React + Vite frontend
  auth/               OIDC config, ProtectedRoute, AuthCallback
  pages/              one feature per page (~10)
  services/           per-feature service (LLM or backend calls)
  utils/apiClient.js  fetch wrapper that auto-attaches Keycloak Bearer token
  utils/llmClient.js  browser-side LocalLLM (Gemini-shaped wrapper)
server/
  index.js            2000-line Express monolith (legacy endpoints)
  middleware/auth.js  Keycloak JWT verification via JWKS (jose)
  routes/             modular AI Secure Engine routers (/api/security/*)
  models/             Sequelize models (no User model — identity is Keycloak)
  services/           ZAP, AI analysis, governance, Jira clients
  utils/llmClient.js  server-side LocalLLM (mirrors src/utils/llmClient.js)
keycloak/
  aaseya-platform-realm.json   Realm export imported on Keycloak boot
  init/01-keycloak-schema.sh   Postgres init: provisions `keycloak` schema + role
scripts/
  migrate-drop-users-table.sql Cutover after switching to Keycloak (one-shot)
docker-compose.security.yml   infra-only compose for local dev (Postgres + Keycloak + ZAP + Mailpit)
docker-compose.security.prod.yml  prod overlay (TLS-terminated upstream; no Mailpit)
docker-compose.yml            full-stack compose for QA/prod — wires real SMTP, no Mailpit (see DEPLOYMENT.md)
```

Read `CLAUDE.md` for architecture detail (two-process model, dual `LocalLLM` clients, `/api/security/*` subsystem, Playwright dual usage).
