# AAQUA — AI-Assisted QA Platform

AAQUA is a React + Express platform that combines a suite of AI-driven QA tools (test generation, locator capture, framework conversion, accessibility / localization scanning, security scanning) behind a single SPA. Identity is provided by Keycloak; security scanning is powered by OWASP ZAP; the LLM backend is Aaseya's gateway.

## Quick links

| If you want to… | Read |
|---|---|
| Run the stack on your laptop | [`LOCAL_SETUP.md`](LOCAL_SETUP.md) |
| Deploy to a QA / staging server (shared-infra model) | [`DEPLOYMENT.md`](DEPLOYMENT.md) and the executable plan at [`docs/superpowers/plans/2026-05-08-shared-infra-deployment.md`](docs/superpowers/plans/2026-05-08-shared-infra-deployment.md) |
| Understand the deployment design | [`docs/superpowers/specs/2026-05-08-shared-infra-deployment-design.md`](docs/superpowers/specs/2026-05-08-shared-infra-deployment-design.md) |
| Understand the AI Secure Engine subsystem (`/api/security/*`) | [`SECURITY_ENGINE_README.md`](SECURITY_ENGINE_README.md) |
| Understand the architecture and codebase conventions | [`CLAUDE.md`](CLAUDE.md) |

## Stack at a glance

- **Frontend** — React 19 + Vite 7, OIDC via `react-oidc-context`, no UI framework (custom CSS variables + `lucide-react` icons).
- **Backend** — Express 5 monolith (`server/index.js`) + a modular AI Secure Engine subsystem under `server/{routes,models,services,middleware}` mounted at `/api/security/*`.
- **Identity** — Keycloak 24 (OIDC + OAuth2, PKCE), realm `aaseya-platform`. Express verifies tokens against Keycloak's JWKS using `jose`. No local user table.
- **Database** — PostgreSQL 16, two schemas in one DB (`public` for app data, `keycloak` for IAM data).
- **Security scanner** — OWASP ZAP daemon, controlled via REST.
- **Browser automation** — Playwright (used both as an in-process library for accessibility / localization scans and as a subprocess runner for uploaded user test ZIPs).
- **Local mail** — Mailpit container catches every email Keycloak emits during dev. Production uses real SMTP (configured in the Keycloak admin console).

## First-time install (3 steps)

```bash
git clone <repo-url> qa-test-gen && cd qa-test-gen
npm install                                                # auto-fetches Playwright Chromium
docker compose -f docker-compose.security.yml up -d        # Postgres, Keycloak, ZAP, Mailpit
cp .env.example .env                                       # then edit secrets
npm run server   # terminal 1 — Express on :3001
npm run dev      # terminal 2 — Vite on :5173
```

Then open http://localhost:5173. See [`LOCAL_SETUP.md`](LOCAL_SETUP.md) for the full walkthrough including Keycloak admin bootstrap and email verification flow.

## Compose file map

| File | Purpose | Use for |
|---|---|---|
| `docker-compose.security.yml` | Local dev infra: Postgres + Keycloak + ZAP + Mailpit, on the developer's laptop | `npm run dev` / `npm run server` workflow |
| `docker-compose.security.prod.yml` | Legacy prod overlay (older bundled-image deployment model) | Not used by the current shared-infra deployment |
| `docker-compose.yml` | **AAQUA tenant compose** — `app` (backend-only, no in-image nginx) + `zap`. Joins external `shared-infra_default` network. | QA/prod, alongside the shared-infra stack at `/opt/shared-infra/` |
| `scripts/shared-infra-template/docker-compose.yml` | **Shared infrastructure stack** — Postgres 17 + Keycloak 24 + Nginx 1.27, hosting one or many tenants by path-prefix routing. Lives at `/opt/shared-infra/` on the QA host. | One per host; AAQUA is currently the first/only tenant. |

## License

Internal — not for redistribution. Contact platform-aaseya@aaseya.com.
