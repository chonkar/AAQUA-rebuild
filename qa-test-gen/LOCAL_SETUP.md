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

---

## 2. Clone & install

```bash
git clone <repo-url> qa-test-gen
cd qa-test-gen
npm install
```

`npm install` also pulls Playwright browsers via the postinstall hook; the first install can take a few minutes.

---

## 3. Configure `.env`

The `.env` file at the repo root is **already populated** with a working LLM key and JWT secret — treat it as configured infrastructure, not a template to recreate.

Sanity-check that these keys exist and are non-empty:

```
VITE_LLM_API_KEY=sk-...
VITE_LLM_ENDPOINT=https://llm.lab.aaseya.com/v1
VITE_LLM_MODEL=gpt-oss-20b
DATABASE_URL=postgresql://aaqua:aaqua@localhost:5433/aaqua_security
ZAP_API_URL=http://localhost:8080
JWT_SECRET=<long random string>
```

> The same `VITE_*` variables are read both in the browser (via `import.meta.env`) and in the Node server (via `process.env` after `dotenv.config()`). Don't rename them.

---

## 4. Start Postgres + ZAP

```bash
docker compose -f docker-compose.security.yml up -d
```

This brings up two containers:

- `aaqua-postgres` — Postgres 16, exposed on host **5433** (the README in this repo says 5432 — that's wrong; the compose file is authoritative).
- `aaqua-zap` — OWASP ZAP daemon on host **8080**, API key disabled for local dev.

Wait until both are healthy:

```bash
docker compose -f docker-compose.security.yml ps
# STATUS should show "healthy" for both
```

**Optional** — connect to Postgres to confirm:

```bash
docker exec -it aaqua-postgres psql -U aaqua -d aaqua_security -c "\dt"
```

The first time the backend boots it will run `sequelize.sync({ alter: true })` and create the tables (`users`, `projects`, `scans`, `vulnerabilities`, `governance_metrics`).

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

**Frontend shows `API Key is missing`**
`VITE_LLM_API_KEY` is empty in `.env`, or `.env` was loaded *after* Vite started. Stop `npm run dev`, fix the value, and restart.

**`/api/run-tests` fails with `playwright: command not found`**
Playwright browsers weren't installed. Run `npx playwright install --with-deps`.

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
  pages/              one feature per page (~10)
  services/           per-feature service (LLM or backend calls)
  utils/llmClient.js  browser-side LocalLLM (Gemini-shaped wrapper)
server/
  index.js            2000-line Express monolith (legacy endpoints)
  routes/             modular AI Secure Engine routers (/api/security/*)
  models/             Sequelize models
  services/           ZAP, AI analysis, governance, Jira clients
  utils/llmClient.js  server-side LocalLLM (mirrors src/utils/llmClient.js)
docker-compose.security.yml   infra-only compose for local dev (Postgres + ZAP)
docker-compose.yml            full-stack compose for QA/prod (see DEPLOYMENT.md)
```

Read `CLAUDE.md` for architecture detail (two-process model, dual `LocalLLM` clients, `/api/security/*` subsystem, Playwright dual usage).
