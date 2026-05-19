# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AAQUA** (AI-Assisted QA Utility Application) — a React + Express platform for AI-powered QA test generation, security scanning, and test management. All code lives under `qa-test-gen/`.

## Commands

All commands run from `qa-test-gen/`:

```bash
# Frontend (Vite dev server on :5173, proxies /api to :3001)
npm run dev

# Backend (Express server on :3001)
npm run server

# Both need to run simultaneously for full functionality.

# Lint
npm run lint

# Build for production
npm run build

# Start security infrastructure (PostgreSQL + OWASP ZAP)
docker-compose -f docker-compose.security.yml up -d
```

## Architecture

```
React Frontend (:5173)  →  Express Backend (:3001)  →  Local LLM API (llm.lab.aaseya.com)
                                                    →  OWASP ZAP (:8080)
                                                    →  PostgreSQL (:5433)
                                                    →  Playwright (browser automation)
```

### Frontend (src/)
- **React 19 + React Router 7** SPA with Vite
- `src/App.jsx` — route definitions, all pages wrapped in `Layout`
- `src/pages/` — one page per feature: TestGenerator, TestPlanGenerator, TestDataGenerator, LocatorGenerator, TestConverter, FrameworkGenerator, TestRunner, LocalizationTester, AccessibilityScanner, SecurityScanner
- `src/services/` — API client logic for each feature (calls `/api/*` endpoints on the backend)
- `src/utils/llmClient.js` — `LocalLLM` class wrapping an OpenAI-compatible chat completions API; uses Vite proxy (`/llm-api`) to bypass CORS in browser
- `src/components/common/` — Layout, Header, Sidebar
- `src/components/features/` — shared UI: RequirementInput, TestCaseTable, ExportControls

### Backend (server/)
- **Express 5** server in `server/index.js` (single large file containing most API endpoints)
- LLM calls on server side use the same `LocalLLM` class from `server/utils/llmClient.js`
- `server/utils/aiUtils.js` — `generateWithRetry` helper for LLM calls with retry logic

#### Security Engine (AI Secure Engine)
Dedicated subsystem for OWASP ZAP security scanning with JWT auth:
- `server/routes/` — authRoutes, projectRoutes, scanRoutes, dashboardRoutes, governanceRoutes (all mounted at `/api/security/*`)
- `server/models/` — Sequelize ORM models: User, Project, Scan, Vulnerability, GovernanceMetric
- `server/services/` — zapService (ZAP API client), aiAnalysisService (LLM-powered vuln analysis), governanceService (release gating), jiraService (optional Jira integration)
- `server/middleware/` — JWT auth, rate limiting, URL/SSRF validation
- `server/db.js` — Sequelize PostgreSQL connection

### Vite Proxy Configuration (vite.config.js)
- `/api` → `http://localhost:3001` (backend)
- `/llm-api` → `https://llm.lab.aaseya.com` (LLM endpoint, path rewritten)

## Environment

Config in `qa-test-gen/.env`:
- `VITE_LLM_API_KEY`, `VITE_LLM_ENDPOINT`, `VITE_LLM_MODEL` — LLM connection (VITE_ prefix exposes to frontend)
- `DATABASE_URL` — PostgreSQL (default: `postgresql://aaqua:aaqua@localhost:5433/aaqua_security`)
- `ZAP_API_URL`, `ZAP_API_KEY` — OWASP ZAP connection
- `JWT_SECRET`, `JWT_EXPIRES_IN` — auth tokens for security engine

## Key Patterns

- **LLM integration**: Both frontend and backend use the `LocalLLM` class which wraps an OpenAI-compatible `/v1/chat/completions` endpoint. The class is aliased as `GoogleGenerativeAI` in imports for historical reasons.
- **File uploads**: Multer handles zip file uploads to `temp_uploads/`; extracted to `temp_extract/`, output to `temp_output/`.
- **ESLint**: Flat config format. Unused vars starting with uppercase or underscore are allowed (`varsIgnorePattern: '^[A-Z_]'`).
- **No TypeScript**: Pure JavaScript codebase (JSX for React components).
- **Security scan types**: baseline (passive), active (attack), api (OpenAPI spec import).
- **Governance**: Release gate blocks if critical+high vulnerabilities exceed 30% of findings.
