# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AAQUA** (AI-Assisted QA Utility Application) is a React + Express platform that bundles ~10 AI-driven QA tools behind a single SPA: functional test generation, test plans, test data, locator capture, framework conversion, API test generation, test running, localization, accessibility, performance (Lighthouse), security (OWASP ZAP), and a Release Readiness dashboard that aggregates the rest.

**All application source lives under `qa-test-gen/`.** The repo root contains only this file, top-level docs (`README.md`, `LOCAL_SETUP.md`, etc.), and the application subdirectory. Treat `qa-test-gen/` as the working directory for every command.

## Where to look first

| You want to… | Read |
|---|---|
| Run any command (dev server, build, lint, migration, docker) | `qa-test-gen/CLAUDE.md` § Commands |
| Understand the architecture in detail | `qa-test-gen/CLAUDE.md` § Architecture |
| Look up a deployment gotcha (HTTPS, PKCE, Keycloak proxy headers, BASE_URL prefix, GCP provisioning, nginx upstream resolution, etc.) | `qa-test-gen/CLAUDE.md` § Deployment gotchas (22 numbered items) |
| Stand up a local dev environment | `qa-test-gen/LOCAL_SETUP.md` |
| Deploy to QA / production | `qa-test-gen/DEPLOYMENT.md` + `qa-test-gen/CLAUDE.md` § Production deployment |
| Understand the AI Secure Engine subsystem (`/api/security/*`) | `qa-test-gen/SECURITY_ENGINE_README.md` (note: README claims DB port `5432` — wrong, use `5433` from the host) |

## Architecture at the highest level

```
React 19 SPA (Vite, :5173)  ──/api──►  Express 5 (:3001)  ──►  LLM gateway (llm.lab.aaseya.com, OpenAI-compatible)
                            ──/llm-api──┘                   ──►  OWASP ZAP REST API (:8080)
                                                            ──►  PostgreSQL (:5433 local, :5432 in shared-infra)
                                                            ──►  Playwright (in-process + subprocess)
                                                            ──►  Lighthouse + chrome-launcher (performance scans)
                                                            ──►  Keycloak JWKS (token verification)
```

- **Identity** is delegated entirely to Keycloak (realm `aaseya-platform`, OIDC + PKCE-S256). There is **no User table, no `/api/auth/login`, no JWT signing secret** in the application — `server/middleware/auth.js` verifies inbound `Authorization: Bearer <jwt>` against Keycloak's JWKS using `jose`. The legacy `users` table was dropped via `qa-test-gen/scripts/migrate-drop-users-table.sql` (npm script `migrate:cutover`); `Project.owner_id` and `Scan.initiated_by` now store the Keycloak `sub` claim directly.

- **The Express server is split in two**: a ~3600-line monolith at `qa-test-gen/server/index.js` holds most feature endpoints (`/api/convert`, `/api/generate-framework`, `/api/parse-spec`, `/api/analyze-performance`, `/api/browser/*`, `/api/run-tests*`, `/api/scrape`, `/api/analyze-localization`, `/api/analyze-accessibility`, `/api/runtime-info`), and a modular AI Secure Engine sits beside it under `server/{routes,models,services,middleware}` with separate routers mounted at `/api/projects`, `/api/security/scan`, `/api/security/dashboard`, `/api/security/governance`, `/api/jira`, and `/api/readiness`.

- **Path-prefix routing is load-bearing.** In dev the SPA serves at `/`; in shared-infra QA/prod it serves under `/aaqua/`. Five places downstream depend on `import.meta.env.BASE_URL` — see `qa-test-gen/CLAUDE.md` § "Path-prefix routing" for the full list. **Hardcoded `/api/...` paths 404 in QA**; always go through `src/utils/apiClient.js` or compute the URL from `BASE_URL`.

- **No TypeScript.** Pure JavaScript / JSX, ESM throughout (`"type": "module"`). The few `.cjs` files at the qa-test-gen root are intentional CommonJS (ad-hoc debug scripts).

## Things that are easy to get wrong

1. **There is no JWT secret anywhere.** If you see code or docs referencing `JWT_SECRET`, `JWT_EXPIRES_IN`, or an `authRoutes` module, the docs are stale or the code is wrong.
2. **There is no `User` Sequelize model.** Identity is in Keycloak; `Project.owner_id` and `Scan.initiated_by` are plain UUIDs.
3. **There is no test framework wired up.** Files like `test_*.js`, `tmp-test-llm.js`, and `debug_llm.js` at the qa-test-gen root are ad-hoc node scripts, not a test suite. Do not claim "tests pass" without something concrete to run.
4. **Two near-identical `LocalLLM` classes** exist (`src/utils/llmClient.js` and `server/utils/llmClient.js`). They expose a Gemini-shaped API but POST to an OpenAI-compatible endpoint. Change one, change both.
5. **Mailpit is dev-only.** It catches every email Keycloak sends locally. **Never** include it in `docker-compose.yml` or `docker-compose.security.prod.yml` — production uses real SMTP configured in the Keycloak admin console.
6. **DB connection failure is non-fatal.** The server logs a warning and keeps running with security features unavailable. Do not write code that assumes the DB is up.
7. **`.env` is gitignored.** Use `.env.example` as the template; never commit a populated `.env`. The repo's local `.env` may carry real secrets — don't print them in transcripts or PRs.

For everything else — commands, deep architecture, deployment, gotchas — see `qa-test-gen/CLAUDE.md`.
