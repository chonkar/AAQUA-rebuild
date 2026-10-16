# AAQUA — AI-Assisted QA Platform

AAQUA is a React + Express platform that combines a suite of AI-driven QA tools (test case / test plan / test data generation, locator capture, framework conversion, API test generation, test running, accessibility / localization scanning, MCP Agent Hub) behind a single SPA, with a Release Readiness dashboard that aggregates their results. Identity is provided by Keycloak; the LLM backend is Aaseya's gateway.

## Quick links

| If you want to… | Read |
|---|---|
| Run the stack on your laptop | [`LOCAL_SETUP.md`](LOCAL_SETUP.md) |
| **Provision a fresh GCP VM from scratch** (cloud-init Docker install, repo clone, shared-infra seed) | [`scripts/gcp-provision.sh`](scripts/gcp-provision.sh) — edit the `CONFIGURE ME` block at the top, then run from your workstation. Pair with `scripts/gcp-vm-startup.sh`. |
| **Install the CI/CD runner on the GCP VM** (auto-deploy on push to `main`) | [`scripts/install-gitlab-runner.sh`](scripts/install-gitlab-runner.sh) — register a project runner in the GitLab UI first (Tags field MUST be set), then run the script with the generated token. See [`CLAUDE.md` gotcha #24](CLAUDE.md). |
| Deploy to a QA / staging server (shared-infra model) | [`DEPLOYMENT.md`](DEPLOYMENT.md) and the executable plan at [`docs/superpowers/plans/2026-05-08-shared-infra-deployment.md`](docs/superpowers/plans/2026-05-08-shared-infra-deployment.md) |
| Understand the deployment design | [`docs/superpowers/specs/2026-05-08-shared-infra-deployment-design.md`](docs/superpowers/specs/2026-05-08-shared-infra-deployment-design.md) |
| Understand the architecture and codebase conventions | [`CLAUDE.md`](CLAUDE.md) |
| Look up a deployment gotcha (HTTPS / mixed-content, self-signed cert + JWKS, DB secret file, role claim location, `/aaqua/` BASE_URL trap, GCP provisioning quirks, nginx upstream resolution, Keycloak realm reset, GitLab Runner UI form, `.env`-shadows-defaults, `docker restart` env-var freeze, `pg_dump`-before-destructive, IP-based QA deploy, etc.) | [`CLAUDE.md` § Deployment gotchas](CLAUDE.md#deployment-gotchas-learned-the-hard-way-during-the-qa-box-stand-up) (28 numbered gotchas as of 2026-07-15) |
| **Bulk-import Keycloak users from CSV** (post-DB-loss recovery, team onboarding) | [`scripts/import-users.sh`](scripts/import-users.sh) + [`scripts/users-template.csv`](scripts/users-template.csv) — fill the CSV in Excel, `export KC_ADMIN_PW=...`, run the script on the VM. See `CLAUDE.md` § "Bulk user import via CSV". |

## Stack at a glance

- **Frontend** — React 19 + Vite 7, OIDC via `react-oidc-context`, MUI for pages migrated in Phase 1, custom CSS variables + `lucide-react` icons on the rest.
- **Backend** — Express 5 monolith (`server/index.js`) + modular Sequelize-backed routers under `server/{routes,models,services,middleware}` (projects, Jira, readiness, MCP, recorder, SSE events, LLM proxy).
- **Identity** — Keycloak 24 (OIDC + OAuth2, PKCE), realm `aaseya-platform`. Express verifies tokens against Keycloak's JWKS using `jose`. No local user table.
- **Database** — PostgreSQL 16, two schemas in one DB (`public` for app data, `keycloak` for IAM data).
- **Browser automation** — Playwright (used both as an in-process library for accessibility / localization scans and as a subprocess runner for uploaded user test ZIPs). Both paths run headless by default; the Test Runner page exposes a per-user "Open browser while running tests" toggle when the host has a display server (`GET /api/runtime-info` gates the UI).
- **Live progress** — test-run output streams to the UI via cursor-based polling on `GET /api/run-status/:runId?since=<cursor>`; completed run logs are written to `temp_runner_logs/<runId>.log`. Phase 1 LLM generations stream over SSE instead (`/api/events/:jobId`).
- **Local mail** — Mailpit container catches every email Keycloak emits during dev. Production uses real SMTP (configured in the Keycloak admin console).

## First-time install (3 steps)

```bash
git clone <repo-url> qa-test-gen && cd qa-test-gen
npm install                                                # auto-fetches Playwright Chromium
docker compose -f docker-compose.security.yml up -d        # Postgres, Keycloak, Mailpit
cp .env.example .env                                       # then edit secrets
npm run server   # terminal 1 — Express on :3001
npm run dev      # terminal 2 — Vite on :5173
```

Then open http://localhost:5173. See [`LOCAL_SETUP.md`](LOCAL_SETUP.md) for the full walkthrough including Keycloak admin bootstrap and email verification flow.

## CI/CD — push-to-deploy

The canonical repo lives at `https://git.lab.aaseya.com/camunda/aaqua` (migrated from GitHub on 2026-06-17). A GitLab Runner installed on the QA host (`aaqua-host` in GCP `asia-south1-a`) picks up every push to `main` and auto-deploys via [`.gitlab-ci.yml`](../.gitlab-ci.yml):

1. `git fetch + reset --hard` against the latest `main`
2. [`scripts/publish-spa.sh`](scripts/publish-spa.sh) builds the SPA in a Docker container and extracts to `/opt/shared-infra/nginx/sites/aaqua/`
3. `docker compose up -d --build app` rebuilds the AAQUA backend image and swaps the container
4. Re-copies the shared-infra nginx templates from the repo into `/opt/shared-infra/` and reloads `shared-nginx`

Setup is one-shot via [`scripts/install-gitlab-runner.sh`](scripts/install-gitlab-runner.sh) (runs on the GCP VM, registers a `gitlab-runner` system-user service with tag `aaqua-deploy`). See [`CLAUDE.md` gotcha #24](CLAUDE.md) for the full runner architecture including the GitLab Runner 16+ auth-token model trap (the UI form is the source of truth — fill in the Tags field or the runner stays idle).

The runner uses `CI_JOB_TOKEN` (short-lived, per-job, GitLab-injected) for the repo fetch — **no PAT lives on the VM**. Concurrency is pinned to 1 (publish-spa.sh's `rm -rf $TARGET` before `docker cp` would race under parallel deploys).

## Compose file map

| File | Purpose | Use for |
|---|---|---|
| `docker-compose.security.yml` | Local dev infra: Postgres + Keycloak + Mailpit, on the developer's laptop | `npm run dev` / `npm run server` workflow |
| `docker-compose.security.prod.yml` | Legacy prod overlay (older bundled-image deployment model) | Not used by the current shared-infra deployment |
| `docker-compose.yml` | **AAQUA tenant compose** — `app` only (backend, no in-image nginx). Joins external `shared-infra_default` network. | QA/prod, alongside the shared-infra stack at `/opt/shared-infra/` |
| `scripts/shared-infra-template/docker-compose.yml` | **Shared infrastructure stack** — Postgres 17 + Keycloak 24 + Nginx 1.27, hosting one or many tenants by path-prefix routing. Lives at `/opt/shared-infra/` on the QA host. | One per host; AAQUA is currently the first/only tenant. |

## License

Internal — not for redistribution. Contact platform-aaseya@aaseya.com.
