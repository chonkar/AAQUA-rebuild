# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # install deps
npm run dev            # Vite dev server (frontend) - default :5173
npm run server         # Express backend on :3001 (loads .env)
npm run build          # production build → dist/
npm run lint           # eslint .
npm run preview        # preview built bundle

# Local infra: Postgres + Keycloak + OWASP ZAP + Mailpit (SMTP catcher)
docker compose -f docker-compose.security.yml up -d
```

There is **no test framework wired up**. The `test_*.js`, `tmp-test-llm.js`, `debug_llm.js`, and `apply_fixes.cjs` files at the repo root are ad-hoc debug scripts run with `node <file>` — not a test suite. Don't claim "tests pass" without something to run.

`npm install` runs a `postinstall` hook (`playwright install chromium`) that fetches the Chromium build matching the pinned Playwright version. It's idempotent — no-op if the binary is already cached. Docker image builds bypass this via `npm ci --ignore-scripts`, since the `mcr.microsoft.com/playwright:v1.58.0-jammy` base image already ships matching browsers at `/ms-playwright`.

## Architecture

This is the AAQUA platform: a React + Vite frontend that drives an Express backend. The frontend is a router shell (`src/App.jsx`) over ~10 feature pages in `src/pages/`, each backed by a service in `src/services/` that either calls an LLM directly or hits the Express API at `:3001`.

### Two-process model
- **Frontend** (`src/`): runs in the browser, talks to LLMs directly through a Vite proxy and to the backend through `/api`.
- **Backend** (`server/`): Express app. `server/index.js` is a 2000-line monolith holding most legacy endpoints (`/api/convert`, `/api/generate-framework`, `/api/browser/*`, `/api/scrape`, `/api/analyze-localization`, `/api/analyze-accessibility`, `/api/run-tests*`). At the bottom it mounts the modular **AI Secure Engine** routers under `/api/security/*`.
- **Vite proxy** (`vite.config.js`): `/api` → `localhost:3001`, `/llm-api` → `https://llm.lab.aaseya.com` (CORS bypass for browser-side LLM calls).

### LLM client — Gemini-shaped wrapper around an OpenAI-compatible endpoint
There are **two near-identical `LocalLLM` classes**: `src/utils/llmClient.js` (browser, rewrites the endpoint to `/llm-api`) and `server/utils/llmClient.js` (server-side, calls the URL directly). Both expose a Gemini-shaped API (`getGenerativeModel({ model }).generateContent(prompt).response.text()`) but POST to an OpenAI-compatible `/chat/completions`. That's why services import it as `import { LocalLLM as GoogleGenerativeAI } from ...` — the alias is intentional, callers were originally written against the Gemini SDK. If you change one client, change both.

Configuration via `.env`: `VITE_LLM_API_KEY`, `VITE_LLM_ENDPOINT` (default `https://llm.lab.aaseya.com/v1`), `VITE_LLM_MODEL` (default `gpt-oss-20b`). The same `VITE_*` vars are read both in the browser (via `import.meta.env`) and on the server (via `process.env` after `dotenv.config()`).

### AI Secure Engine subsystem (`/api/security/*`)
A bolted-on, modular subsystem that does **not** follow the monolith pattern in `server/index.js`. It has its own layered structure under `server/`:

- `models/` — Sequelize models (`Project`, `Scan`, `Vulnerability`, `GovernanceMetric`) with associations defined in `models/index.js`. Convention: `underscored: true`, `freezeTableName: true`. **No `User` model** — identity is owned by Keycloak; `Project.owner_id` and `Scan.initiated_by` are plain UUIDs storing the Keycloak `sub` claim.
- `routes/` — one router per resource (`projectRoutes`, `scanRoutes`, `dashboardRoutes`, `governanceRoutes`). Governance endpoints are gated by `requireRole('admin')`.
- `services/` — `zapService` (OWASP ZAP REST client), `aiAnalysisService` (LLM-driven vuln triage), `governanceService` (release-gate logic: blocks if Critical+High > 30% of findings), `jiraService`.
- `middleware/` — `auth.js` (Keycloak JWT verification via `jose` + JWKS — see "Identity" below), `rateLimiter.js`, `urlValidator.js` (SSRF guard).

### Identity — Keycloak owns auth, Express only verifies tokens
Authentication is delegated entirely to Keycloak (realm `aaseya-platform`, OIDC code+PKCE flow). `server/middleware/auth.js` verifies inbound `Authorization: Bearer <jwt>` tokens against Keycloak's JWKS using `jose`, sets `req.user = { id, email, name, roles, raw }` from the token claims, and exposes `requireRole(...allowed)` for role gating. There is **no local password store, no `/auth/login` endpoint, no JWT signing key in `.env`** — all of that lives in Keycloak. The frontend uses `react-oidc-context`; tokens flow via `src/utils/apiClient.js`. The `keycloak` schema is isolated from the app's `public` schema; `server/db.js` pins Sequelize's `search_path` to `public` so `sync({ alter: true })` cannot reach Keycloak's tables.

### Local mail — Mailpit (dev only)
`docker-compose.security.yml` includes a `mailpit` container that catches every email Keycloak sends (verify-email, password reset, etc.) without delivering to a real inbox. SMTP at `mailpit:1025`, web UI at `localhost:8025`. The realm export's `smtpServer` block points at it. **Production uses real SMTP** — configured via the Keycloak admin console (Realm settings → Email), not via the realm JSON. Never include Mailpit in `docker-compose.yml` or `docker-compose.security.prod.yml`.

Boot sequence (bottom of `server/index.js`): `initDatabase()` → `app.listen()`. `initDatabase` runs `sequelize.sync({ alter: true })` so model edits auto-migrate the schema on next start. **DB connection failure is non-fatal** — the server logs a warning and keeps running with security features unavailable; don't add code that assumes the DB is up.

### Database port mismatch — read this
- `docker-compose.security.yml` maps host `5433` → container `5432`.
- `.env` has `DATABASE_URL=...localhost:5433/...` (matches docker-compose).
- `server/db.js` falls back to `localhost:5433` if `DATABASE_URL` is unset.
- `SECURITY_ENGINE_README.md` says `5432`. **The README is wrong.** Use `5433` from the host.

### Playwright is used two ways
1. As a **library inside the server** (`import { chromium } from 'playwright'`) for the interactive browser endpoints (`/api/browser/launch|capture|close`) and `/api/scrape`, `/api/analyze-localization`, `/api/analyze-accessibility`.
2. As a **subprocess test runner** spawned via `child_process.spawn` from `/api/run-tests*` to execute uploaded user test projects. Results are parsed from Playwright's JSON reporter output.

### File-upload flows
`/api/convert` (test framework migration) and `/api/run-tests` accept ZIP uploads via `multer` into `temp_uploads/`, extract with `adm-zip` into `temp_extract/<timestamp>/`, then process. The `node_test_extract/` and `verify_proj_extracted/` directories at the repo root are leftover artifacts from previous runs and should not be edited as source.

### Frontend layout
`src/components/common/{Layout,Header,Sidebar}.jsx` provides the chrome; pages render inside `<Layout>`. Styling is per-component inline `<style>` blocks driven by CSS variables (`var(--bg-primary)`, `var(--text-muted)`, etc.) defined in `src/index.css`. There's a `useTheme` hook in `src/hooks/`. No CSS framework, no component library beyond `lucide-react` icons.

## Conventions worth noting

- ESM throughout (`"type": "module"` in `package.json`). Server uses `import` syntax with `.js` extensions; the few `.cjs` files (`apply_fixes.cjs`, `fix_llm.cjs`) are intentional CommonJS.
- ESLint rule `no-unused-vars` ignores names matching `^[A-Z_]` — uppercase identifiers can be left unused.
- The `.env` in this repo contains real secrets (`VITE_LLM_API_KEY`, `KEYCLOAK_ADMIN_PASSWORD`, `KEYCLOAK_DB_PASSWORD`). Don't print them in transcripts or PRs, don't commit replacements that would invalidate live values, and treat `.env` as already-configured rather than something to recreate. There is **no JWT secret** in this codebase anymore — token verification uses Keycloak's public JWKS, not a shared HMAC.
