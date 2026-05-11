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

### Path-prefix routing — `import.meta.env.BASE_URL` is load-bearing
In dev the SPA serves at `/`; in shared-infra QA/prod it serves under `/aaqua/`. The split is driven by Vite's `base` config, which is set from the `VITE_BASE_PATH` build-arg (`vite.config.js` line 5). Five places downstream depend on `import.meta.env.BASE_URL` to construct correct URLs:
- `src/App.jsx` — `<Router basename={BASE_URL.replace(/\/$/, '')}>` so React Router strips the prefix on route match.
- `src/auth/oidcConfig.js` — `redirect_uri = ${origin}${BASE_URL}auth/callback` (without the prefix it collides with shared-Keycloak's `/auth/*` route).
- `src/utils/apiClient.js` — prepends `${API_PREFIX}` to every fetch path.
- `src/utils/llmClient.js` — prefixes the `/llm-api` rewrite.
- `Dockerfile` and `scripts/publish-spa.sh` — pass `VITE_BASE_PATH` as build-arg.

Hardcoded `window.location.href = '/foo'`-style paths bypass React Router's basename and 404 in QA. Always use `<Link to="...">` or `useNavigate()`.

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
1. As a **library inside the server** (`import { chromium } from 'playwright'`) for the interactive browser endpoints (`/api/browser/launch|capture|close`) and `/api/scrape`, `/api/analyze-localization`, `/api/analyze-accessibility`. `/api/browser/launch` defaults to headless and respects `HEADLESS=false` in `.env` for the local-dev cookie-capture flow. The other endpoints are hardcoded `headless: true`.
2. As a **subprocess test runner** spawned via `child_process.spawn` from `/api/run-tests*` to execute uploaded user test projects. Results are parsed from Playwright's JSON reporter output. Headless is the default; pass `headed: true` in the request body (or `headed=true` form field for the ZIP-upload endpoint) to append `--headed` to the `npx playwright test` argv. This overrides whatever the uploaded `playwright.config.js` sets.

### Headed vs headless: `/api/runtime-info` is the UI gate
`GET /api/runtime-info` (unauthenticated, no secrets) returns `{ hasDisplayServer: !!process.env.DISPLAY, isContainer: existsSync('/.dockerenv'), platform }`. The TestRunner UI hides the "Open browser while running tests" toggle when `hasDisplayServer === false` — there's no point offering a control that crashes in the deployed `mcr.microsoft.com/playwright:v1.58.0-jammy` container (no X11/xvfb). The toggle's last value is sticky per-user via `localStorage` key `aaqua.testrunner.headed`. **Windows devs**: `DISPLAY` is unset by default; set `DISPLAY=1` (any truthy string) in `.env` to force the toggle to appear — Chromium itself works fine on Win32 without an X server, the env var is just our UI heuristic.

### Live log streaming for ZAP scans and Playwright runs
Both flows use **cursor-based polling**, not SSE/WebSocket. The choice is deliberate: it preserves the existing `Authorization: Bearer` auth, needs zero shared-nginx config changes, and survives the 5–30 minute active-scan duration without holding any single connection open.
- **Scans**: a module-level `scanLogBuffers: Map<scanId, string[]>` in `server/routes/scanRoutes.js` accumulates log lines as `executeScan` runs (helper `logScan(scanId, line)`; cap 500 lines). The buffer is flushed to the new `Scan.logs TEXT` column on every phase transition and on terminal status — so a tester who reloads mid-scan, or views a completed scan later, sees full log history from the DB. `GET /api/security/scan/status/:scanId?since=<cursor>` returns `{ ...status, logs: string[], cursor }` where `cursor` is the buffer length at fetch time. Live buffer is preferred while it exists; falls back to `Scan.logs` after the scan completes (buffer is dropped in `executeScan`'s `finally`).
- **Test runs**: existing `runStore` Map in `server/index.js` already held a `logs` array; now capped at 500 chunks via `appendRunLog(run, chunk)`. `GET /api/run-status/:runId?since=<cursor>` returns only the delta. On run completion, the full log is persisted to `temp_runner_logs/<runId>.log` for post-mortem inspection (runs are otherwise ephemeral).
- **ZAP service callback**: `zapService.runBaselineScan / runFullActiveScan / runPassiveScan / runFuzzerScan / runApiScan` each accept an optional third `onLog(line)` argument (the route passes `logScan` here). Internal helpers (`waitForSpider`, `waitForActiveScan`) still call `onProgress(status, percent)`, which the route wraps to also emit a log line.

### File-upload flows
`/api/convert` (test framework migration) and `/api/run-tests` accept ZIP uploads via `multer` into `temp_uploads/`, extract with `adm-zip` into `temp_extract/<timestamp>/`, then process. The `node_test_extract/` and `verify_proj_extracted/` directories at the repo root are leftover artifacts from previous runs and should not be edited as source.

### Frontend layout
`src/components/common/{Layout,Header,Sidebar}.jsx` provides the chrome; pages render inside `<Layout>`. Styling is per-component inline `<style>` blocks driven by CSS variables (`var(--bg-primary)`, `var(--text-muted)`, etc.) defined in `src/index.css`. There's a `useTheme` hook in `src/hooks/`. No CSS framework, no component library beyond `lucide-react` icons.

## Production deployment — shared-infra model

The committed `docker-compose.yml` is the **AAQUA tenant compose** — only `app` (backend, no nginx) and `zap`. It joins an external docker network `shared-infra_default` (`external: true`) and reads file-mounted secrets from `/opt/shared-infra/secrets/aaqua/`.

The platform tier (Postgres 17, Nginx, Keycloak 24) lives in a separate compose project at `/opt/shared-infra/` on the host. The committed source-of-truth for that stack is `scripts/shared-infra-template/` in this repo; it gets `cp -r`'d to `/opt/shared-infra/` on first deploy. Spec at `docs/superpowers/specs/2026-05-08-shared-infra-deployment-design.md`, executable plan at `docs/superpowers/plans/2026-05-08-shared-infra-deployment.md`.

Tenant routing is path-prefix: `/aaqua/` (SPA), `/aaqua/api/` (backend), `/aaqua/llm-api/` (LLM proxy with Authorization-header injection at the shared edge), `/auth/` (shared Keycloak). The backend code itself is unaware of `/aaqua` — shared-nginx strips the prefix before proxying.

### Deployment gotchas (learned the hard way during the QA box stand-up)
1. **PKCE-S256 needs HTTPS.** Browsers gate `crypto.subtle.digest()` to Secure Contexts (HTTPS or `localhost`). On plain HTTP via a LAN IP (`http://10.13.1.182/aaqua/`), the OIDC sign-in throws `Crypto.subtle is available only in secure contexts` and silently no-ops. Workarounds: ship a self-signed cert + accept the browser warning, or terminate TLS at a real reverse proxy. There's no client-side switch — `oidc-client-ts` mandates S256 for code flow.
2. **`KC_HOSTNAME` must be a bare hostname** (`10.13.1.182`), NOT a URL (`http://10.13.1.182`). URL form produces malformed `iss` claims (`http://http//...`) on frontchannel endpoints. Keep `KC_PUBLIC_BASE_URL` (full URL with scheme) separate — it's only used by `render-realm.sh` for realm template substitution.
3. **`KC_PROXY=edge` + `KC_HTTP_RELATIVE_PATH=/auth`** are the right settings for shared-nginx terminating in front of Keycloak, regardless of HTTP vs HTTPS.
4. **Don't use `start --optimized`** in shared-infra's keycloak command. The upstream image is built for H2; with `--optimized` the runtime ignores `KC_DB=postgres` and tries to use H2 to reach a Postgres URL, crashing with `URL format error; must be jdbc:h2:...`. Plain `start` lets Keycloak auto-rebuild for Postgres at boot (~30 s overhead, one-time).
5. **Healthcheck Alpine containers via `127.0.0.1`, not `localhost`.** Alpine's musl libc resolves `localhost` to `::1` first; if nginx isn't listening on IPv6 (it isn't, when we ship our own server block), the healthcheck loops on `Connection refused`.
6. **Shell scripts must have `+x` in the git index.** The official nginx image's entrypoint silently skips non-executable `.envsh` files (`Ignoring <file>, not executable`), then envsubst leaves placeholders unrendered, then nginx emerg-exits on the literal `${VAR}`. Use `git update-index --chmod=+x` from Windows to set the bit.
7. **`.gitattributes` pins shell scripts to LF.** Without it, Windows commits write CRLF, and on Linux `set -o pipefail\r` fails as "invalid option name". Already shipped at the repo root.
8. **AAQUA secrets live ONLY at `/opt/shared-infra/secrets/aaqua/`.** Two consumers — Node-side LLM calls (Docker secret in app container) and the `/aaqua/llm-api/` proxy at shared-nginx (file mount + envsubst). One file, one location, two readers. Copying secrets between dev and QA is forbidden.
9. **Realm import is first-boot-only.** After Keycloak's `keycloak` DB has the realm row, edits to `keycloak/aaseya-platform-realm.template.json` are ignored on restart. Changes after first boot must go through the admin console (or a partial-import) and should be exported back to the template if they're meant to persist across rebuilds.
10. **Self-signed TLS at shared-nginx breaks backend JWKS fetch — split the URL.** When shared-nginx terminates HTTPS with a self-signed cert, the backend's `jose` JWKS fetch throws `Error: self-signed certificate`. But token `iss` claims still carry the public HTTPS URL, so the backend has to (a) match `iss` against the public URL and (b) fetch JWKS via a docker-internal route that doesn't need cert validation. `server/middleware/auth.js` reads `KEYCLOAK_REALM_URL` (public, for issuer match) and an optional `KEYCLOAK_JWKS_URL` (docker-internal HTTP, e.g. `http://shared-keycloak:8080/auth/realms/aaseya-platform/protocol/openid-connect/certs`). If `KEYCLOAK_JWKS_URL` is unset, the code derives it from `KEYCLOAK_REALM_URL` — fine for any deploy where the issuer URL is reachable from the backend without TLS issues. `NODE_TLS_REJECT_UNAUTHORIZED=0` is a faster unblock but disables TLS verification for *all* outbound Node calls (including `llm.lab.aaseya.com`) — prefer the URL split.
11. **DB credentials in the deployed model come from a file-mounted Docker secret.** `docker-compose.yml` sets `DB_HOST=shared-postgres`, `DB_PORT=5432`, `DB_USER=aaqua_app`, `DB_NAME=aaqua_security` and mounts the password at `/run/secrets/db_password` (Compose v2 writes secrets to files, not env vars — the Postgres image's `*_FILE` convention is not universal). `server/db.js` `resolveDatabaseUrl()` builds the connection URL in three-tier precedence: `DATABASE_URL` → `DB_*` env vars + read password from `DB_PASSWORD_FILE` → hardcoded local-dev fallback. DB connection failure remains non-fatal (see "Boot sequence" above) — the server logs a warning and keeps running with security features unavailable.
12. **Realm roles live in the access_token, not the id_token / `profile`.** `oidc-client-ts` exposes `user.profile`, which is the id_token decoded — that does NOT carry `realm_access.roles`. Keycloak puts roles in the access_token. `src/auth/oidcConfig.js` `rolesOf(user)` decodes `user.access_token` directly. If you ever switch to reading from `user.profile.realm_access`, every role gate (e.g. ProtectedRoute admin check) silently fails for every user with a non-blank role list — the symptom is "Forbidden — requires role: admin" for a user who clearly has the role in the token.
13. **Raw `fetch('/api/...')` 404s in QA — the `/aaqua/` prefix is load-bearing.** Always go through `src/utils/apiClient.js` (which prepends `import.meta.env.BASE_URL`) or compute the URL from `BASE_URL` yourself. In dev, relative `/api/...` works via the Vite proxy; in QA shared-nginx only routes `/aaqua/api/...` to the backend — a path without the prefix falls through to nginx's default and returns the canned 404 page. This is especially invisible when the call is a health check that gates a primary action (e.g. the Security Scanner's "Trigger Scan" button stays `disabled` while `zapHealth?.status !== 'ok'`, so the button just looks unresponsive). The four legacy service files (`src/services/{testRunner,localization,migration,frameworkGenerator}Service.js`) compute `API_URL` from `BASE_URL` rather than hardcoding `http://localhost:3001/api` for this reason.

### `docker-compose.security.yml` is local-dev only
The local-dev compose still exists and runs Postgres + Keycloak + ZAP + Mailpit on the developer's laptop. It is **NOT** the same model as the shared-infra QA stack — it uses the older "two schemas in one DB" Postgres pattern and includes Mailpit (which has no place in QA/prod). The two are intentionally allowed to drift.

## Conventions worth noting

- ESM throughout (`"type": "module"` in `package.json`). Server uses `import` syntax with `.js` extensions; the few `.cjs` files (`apply_fixes.cjs`, `fix_llm.cjs`) are intentional CommonJS.
- ESLint rule `no-unused-vars` ignores names matching `^[A-Z_]` — uppercase identifiers can be left unused.
- `.env` is **gitignored and untracked** as of commit `f69bd7e`. The committed `.env.example` is the safe template — never commit a populated `.env`. The repo's local `.env` may contain real secrets (`VITE_LLM_API_KEY`, `KEYCLOAK_ADMIN_PASSWORD`, `KEYCLOAK_DB_PASSWORD`); don't print them in transcripts or PRs, don't commit replacements that would invalidate live values. There is **no JWT secret** anywhere — token verification uses Keycloak's public JWKS, not a shared HMAC.
