# AAQUA UI Modernization, Microsoft 365 SSO, and Kubernetes Migration — Design Spec

**Date:** 2026-07-29
**Status:** Approved decisions — MUI, Keycloak federation with Entra ID, containers on k3s (serverless rejected)
**Scope:** `qa-test-gen` (React 19 SPA + Express 5 backend)

## 1. Context and current state

AAQUA is a multi-tool QA platform in production: a React 19 / Vite SPA (15 feature pages, custom CSS, no component library) backed by a Node.js Express 5 monolith (`server/index.js`, ~4,000 lines), PostgreSQL via Sequelize, Keycloak OIDC auth, and an OpenAI-compatible local LLM endpoint (`llm.lab.aaseya.com`, model `gemma-4`). Deployment is docker-compose on a single GCP VM behind a shared nginx, driven by GitLab CI.

Known problems this design addresses:

- UI is hand-rolled CSS with per-component `<style>` blocks: inconsistent, desktop-only, fake progress bars, `setInterval` polling for all long jobs.
- Sign-in is Keycloak-local accounts; the business wants Microsoft 365 (Entra ID) SSO.
- ~32 inline endpoints in `server/index.js` have **no authentication**; `cors()` is wide open; the SPA calls the LLM endpoint directly from the browser (exposes key/endpoint); admin email is hardcoded.
- Job state is in-memory (`Map`s) and a single shared Playwright browser is module-level state: jobs vanish on restart, unsafe for concurrent users, blocks horizontal scaling.
- Container healthcheck hits `/api/security/zap/health`, coupling app health to ZAP; `PORT` is hardcoded to 3001.

## 2. Goals

1. A consistent, responsive, user-friendly UI built on **Material UI (MUI v6+)** — every tool follows one learnable workflow pattern.
2. **Microsoft 365 SSO** via **Entra ID federated into the existing Keycloak realm** (no application code change for auth).
3. Real-time progress feedback via **Server-Sent Events**, including streamed LLM output.
4. Security hardening of the API surface.
5. Deployment on **Kubernetes (k3s on the existing GCP VM)** with a GitLab CI build→push→deploy pipeline, portable later to GKE.

## 3. Non-goals

- No serverless re-architecture (rejected: stateful Playwright sessions, long-running spawned processes, multi-GB image, ZAP daemon).
- No backend rewrite or framework change; Express stays.
- No replacement of Keycloak with direct MSAL/Entra integration.
- No multi-node HA in phase one (single-node k3s accepts the same VM-loss risk as today).
- No new product features; feature parity across all 15 tools is the bar.

## 4. Design decisions (approved)

| Decision | Choice | Rejected alternative |
|---|---|---|
| Component library | MUI | Tailwind + shadcn/ui (more assembly for a tool-heavy app) |
| M365 SSO | Entra ID as IdP federated in Keycloak realm `aaseya-platform` | Direct `@azure/msal-react` (rewrites auth stack, more risk) |
| Compute model | Containers | Serverless (workload mismatch) |
| Orchestrator | k3s on existing GCP VM, GKE later if usage grows | GKE Autopilot now (cost), docker-compose status quo (no rollout rigor) |
| Progress UX | SSE from Express | Polling status quo; WebSockets (overkill, harder through nginx/ingress) |

## 5. Architecture

### 5.1 Frontend (Phase 1–2)

- **Theme:** one MUI theme (`src/theme.js`) encoding the existing brand tokens (dark `#0a0a0f` background, violet `#6d28d9` accent, Inter) with light/dark palettes wired to the existing `useTheme` toggle. Delete per-component `<style>` blocks as pages migrate.
- **Shell:** MUI `AppBar` + permanent `Drawer` (desktop) collapsing to temporary drawer + hamburger below `md`. Project selector and user menu in the AppBar. Existing route guards (`ProtectedRoute`, `RequireProject`, role gates) unchanged.
- **Shared `ToolWorkflow` component:** an MUI `Stepper`-based wizard used by all 15 tools: **Input → Configure → Generate (live progress) → Review → Export**. Each tool supplies step content; the frame supplies navigation, validation, progress display, error surface, and export bar. This is the core "user friendly" bet: learn one tool, know them all.
- **Tables:** MUI DataGrid (community) replaces `TestCaseTable`; column priority hides secondary columns on small screens; card fallback below `sm`.
- **Feedback:** global snackbar/toast provider, skeleton loaders, designed empty states, confirmation dialogs for destructive actions.
- **Responsive bar:** all pages usable at 375 px, 768 px, 1024 px, 1440 px; no horizontal scroll; touch targets ≥ 44 px.
- **Accessibility:** WCAG 2.1 AA — keyboard-navigable wizard and tables, `focus-visible` rings, correct heading hierarchy, contrast-checked palette.
- Migration order: shell + 2 pilot pages (Test Case Generator, Test Plan Generator) → remaining generators → runner/scanners → dashboards. Old CSS removed page-by-page; both styles coexist during migration.

### 5.2 Streaming progress (Phase 1.5)

- New SSE endpoints on Express (`GET /api/events/:jobId`) backed by the job store (5.4). Replaces `setInterval` polling in TestRunner, SecurityScanner, LocalizationTester, AccessibilityScanner; replaces fake progress in FrameworkGenerator/TestConverter with real phase events.
- LLM generation proxied through the backend with `stream: true`; tokens forwarded over SSE so users watch output render. Removes all direct browser→LLM calls (`src/utils/llmClient.js` now targets backend only), which also stops leaking the LLM endpoint/key to clients.

### 5.3 Microsoft 365 SSO (Phase 3)

- Entra ID app registration in the office M365 tenant; redirect URI = Keycloak broker endpoint (`https://<keycloak-host>/realms/aaseya-platform/broker/microsoft/endpoint`).
- Keycloak Identity Provider "microsoft" added to realm `aaseya-platform`; client ID/secret from the registration; scopes `openid profile email`.
- Claim mapping: Entra `email`/`name` → Keycloak user attributes; Entra security groups → Keycloak realm roles (`admin`, default user role) via IdP mappers. First-login flow auto-links by verified email for the users already imported via `scripts/import-users.sh`.
- Login page shows "Sign in with Microsoft"; once verified, set the IdP as the default authentication flow (M365-only sign-in). Application code (`oidcConfig.js`, `auth.js` middleware) unchanged.
- Realm export `keycloak/aaseya-platform-realm.json` updated (secret templated, not committed).

### 5.4 Backend hardening (Phase 4 — rides along, required for K8s)

1. **Global auth:** `app.use('/api', authenticateToken)` before all routes with an explicit public allowlist (`/api/health`, auth callbacks). Closes the ~32 unauthenticated inline endpoints.
2. **CORS allowlist** from env (`ALLOWED_ORIGINS`), replacing open `cors()`.
3. **Job store:** move in-memory job `Map`s (localization, heal-batch, test runs) to a `jobs` table in Postgres (id, type, status, progress, payload, result, timestamps). SSE reads from it; jobs survive restarts.
4. **Health endpoints:** `GET /api/health` (liveness: process up, DB reachable), `GET /api/ready` (readiness: DB + optional ZAP detail). Container/probe wiring moves off the ZAP health URL.
5. **`PORT` from env** (`server/index.js:48`).
6. Admin gating from env only (no hardcoded email fallback in `auth.js` and `App.jsx`).
7. Playwright interactive-browser singleton documented as single-replica constraint (refactor to per-session contexts is future work, out of scope).

### 5.5 Kubernetes migration (Phase 5)

- **Cluster:** k3s (single node) on the existing GCP VM, Traefik disabled in favor of ingress-nginx to match current nginx behavior; cert-manager or existing certs for TLS.
- **Workloads:**
  - `aaqua-app` Deployment, `replicas: 1` (browser-singleton constraint), liveness `/api/health`, readiness `/api/ready`, resource requests/limits sized from current VM usage.
  - `aaqua-spa`: nginx image serving the built SPA under `/aaqua/`.
  - `zap` Deployment (2 Gi limit as today).
  - `keycloak` Deployment + Postgres (existing shared instance migrates as a StatefulSet with PVC, or stays external on the VM in step one — decided at implementation by data-migration risk).
- **Config:** ConfigMaps for non-secret env; K8s Secrets mounted as files at `/run/secrets/*` — the app already reads secret files, so no code change.
- **Pipeline (GitLab CI):** `lint+test` → `build` (two images, tagged with commit SHA, pushed to GCP Artifact Registry) → `deploy-staging` (kubectl apply/Helm upgrade to `aaqua-staging` namespace) → smoke test (`/api/health`, SPA index) → manual gate → `deploy-prod`. Rollback = `helm rollback` / re-deploy previous SHA.
- **Cutover:** k3s stack runs alongside compose on alternate ports → nginx flips upstream → compose retired after a stable week. GKE later = same manifests, new kubeconfig.

## 6. Error handling

- SSE: client auto-reconnects (`EventSource` native retry); on reconnect, server replays current job state from the job store. Terminal job errors carry a user-readable message + correlation id logged server-side.
- LLM streaming failures mid-generation surface partial output plus a retry action (reusing `generateWithRetry` semantics server-side).
- Auth: 401 → SPA redirects to Keycloak login; federation misconfig surfaces on Keycloak's error page, not a blank SPA.
- K8s probes never depend on ZAP or the LLM; degraded subsystems are reported in `/api/ready` details and shown as a status banner in the UI, not a dead app.

## 7. Testing

- **Frontend:** Vitest + React Testing Library for the `ToolWorkflow` frame, guards, and export utilities; Playwright e2e for the two pilot tools (happy path: input → generate → export) run in CI against a compose stack.
- **Per-page migration checklist:** feature parity (all controls/exports work), responsive at 4 breakpoints, keyboard-only pass, axe-core clean.
- **SSO:** test users in a dev Entra tenant (or dev realm) verifying first-login link, role mapping to `admin`, and token acceptance by existing middleware — before flipping the default flow in prod.
- **Backend:** supertest suite asserting every `/api/*` route rejects unauthenticated requests (regression test for the hardening) and job-store lifecycle.
- **K8s:** staging namespace soak, pipeline smoke tests, restart test proving jobs survive pod restarts.

## 8. Rollout and risk

| Risk | Mitigation |
|---|---|
| UI regression during page-by-page migration | Pilot pages first; per-page parity checklist; old pages remain until each replacement is verified |
| Federation locks users out | Keep local-login flow available until M365 path is verified in prod; Keycloak admin retains local access |
| Global auth breaks an integration that relied on open endpoints | Staging soak + supertest coverage; explicit allowlist reviewed before merge |
| Single-node k3s outage | Same blast radius as today's VM; GKE promotion path documented |
| Job-store migration bugs | Old polling endpoints kept (reading the new store) until SSE is verified, then removed |

## 9. Phases and sequencing

1. **Phase 1 — Shell + design system (1–2 wk):** MUI theme, AppBar/Drawer shell, providers (snackbar), 2 pilot pages on `ToolWorkflow`.
2. **Phase 1.5 — SSE + LLM streaming (1 wk):** job store groundwork (§5.4.3 subset), SSE endpoint, pilot pages streamed.
3. **Phase 2 — Page migration (3–4 wk):** remaining 13 pages in batches; responsive + a11y checklist each.
4. **Phase 3 — M365 SSO (3–5 d):** Entra registration, Keycloak federation, role mapping, staged default-flow flip.
5. **Phase 4 — Hardening (1 wk):** global auth, CORS, health endpoints, env PORT, admin-email env, remaining job-store moves.
6. **Phase 5 — K8s (1–1.5 wk):** manifests/Helm, k3s install, CI pipeline stages, staged cutover.

Each phase is independently shippable; production stays on the current stack until each phase's gate passes.
