# AI Secure Engine

AI-powered security scanning backend integrated into the AAQUA platform. Uses OWASP ZAP for vulnerability scanning, an Aaseya AI gateway for intelligent analysis / remediation / governance, and Keycloak for identity & authorization.

## Architecture

```
React Frontend ──(OIDC redirect)──→  Keycloak  (:8082)
       │
       │ Authorization: Bearer <access_token>
       ▼
Express Server (:3001) ──→ ZAP API (:8080)
                       ──→ PostgreSQL (:5433 host / :5432 container)
                       ──→ Aaseya AI gateway (https://llm.lab.aaseya.com)
                       ──→ Jira API (optional)
```

The Express backend has no credential store of its own — it verifies inbound JWTs against Keycloak's JWKS (`/realms/aaseya-platform/protocol/openid-connect/certs`) using `jose`. User identity is the Keycloak `sub` claim (a stable per-realm UUID); roles are read from `realm_access.roles`.

## Quick Start

### 1. Start Infrastructure (Docker)

```bash
docker compose -f docker-compose.security.yml up -d
```

This brings up:
- **PostgreSQL 16** on host port `5433` (user: `aaqua`, db: `aaqua_security`). Hosts two schemas: `public` (app) and `keycloak` (IAM).
- **Keycloak 24** on host port `8082`. Auto-imports the `aaseya-platform` realm from `keycloak/aaseya-platform-realm.json`.
- **OWASP ZAP** on host port `8080` (daemon mode, API key disabled for local dev).

### 2. Configure `.env`

Copy the template and fill in real values:

```bash
cp .env.example .env
```

The `KEYCLOAK_*` and `VITE_KEYCLOAK_*` blocks must match the Keycloak instance you brought up — defaults already point at `localhost:8082`.

### 3. Set passwords for the seeded admins

The realm ships two pre-seeded admins with no passwords (just required actions). Set a temporary password for each via the Keycloak admin console at `http://localhost:8082/admin`:

| Username | Email |
|---|---|
| `sanjay.jain` | jain.sanjay@aaseya.com |
| `kavita.chonkar` | kavita.chonkar@aaseya.com |

Both have realm roles `admin` + `user` and `requiredActions: ["UPDATE_PASSWORD","VERIFY_EMAIL"]` — they'll change the password on first login.

### 4. Start Backend Server

```bash
npm run server
```

The server will:
- Auto-connect to PostgreSQL and sync tables in the `public` schema only
- Mount security APIs at `/api/security/*`
- Log: `Security API: http://localhost:3001/api/security`

### 5. Verify Setup

```bash
# Check ZAP
curl http://localhost:8080/JSON/core/view/version/

# Check Keycloak realm + JWKS
curl http://localhost:8082/realms/aaseya-platform/.well-known/openid-configuration

# Check backend rejects unauth
curl -i http://localhost:3001/api/security/projects
# HTTP/1.1 401 Unauthorized
```

## API Endpoints

> Authentication is performed by Keycloak via the OIDC code+PKCE flow. The browser obtains an access token from Keycloak and sends it as `Authorization: Bearer <token>` to every backend call. There are no `/auth/login` or `/auth/register` endpoints in this service.

### Projects

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/security/projects` | any authenticated | Create project |
| GET | `/api/security/projects` | any authenticated | List projects |
| GET | `/api/security/projects/:id` | any authenticated | Get project details |
| DELETE | `/api/security/projects/:id` | any authenticated | Delete project |

### Scans

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/security/scan/start` | any authenticated | Start a scan |
| GET | `/api/security/scan/status/:scanId?since=<cursor>` | any authenticated | Poll scan progress + live log tail. `since` is the cursor returned by the previous call; omit (or pass 0) for the full buffer. Response shape: `{ id, scan_type, status, progress, target_url, started_at, completed_at, error_message, logs: string[], cursor: number }`. |
| GET | `/api/security/scan/results/:scanId` | any authenticated | Get full results |

Log lines accumulate in an in-memory ring buffer (cap 500 lines per scan) and are flushed to the `Scan.logs` TEXT column on each phase transition and on terminal status. The status endpoint serves from the live buffer while the scan runs and falls back to `Scan.logs` for completed/failed scans — so tester reloads and post-mortem reviews show the same log history.

### Dashboard & Governance

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/security/dashboard/summary/:projectId` | any authenticated | Project dashboard |
| GET | `/api/security/governance/release-check/:scanId` | **admin only** | Release gate check |
| GET | `/api/security/governance/trend/:projectId` | **admin only** | Historical trend |

### Health

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/security/zap/health` | none | ZAP connection status |

## Example Usage

### 1. Obtain a token

In a browser-based deployment the SPA handles this transparently via `react-oidc-context`. For ad-hoc CLI testing you can grab a token via the password grant on the master `admin-cli` client (Keycloak admin only):

```bash
TOKEN=$(curl -sX POST http://localhost:8082/realms/aaseya-platform/protocol/openid-connect/token \
  -d "client_id=admin-cli" \
  -d "username=sanjay.jain" \
  -d "password=<the temp pw you set>" \
  -d "grant_type=password" | jq -r .access_token)
```

> The realm's public `aaqua-frontend` client has `directAccessGrantsEnabled: false` by design — the password grant is disabled there. Use `admin-cli` (master realm) only for testing.

### 2. Create Project & Start Scan

```bash
# Create project
curl -X POST http://localhost:3001/api/security/projects \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"My Web App","target_url":"https://example.com"}'

# Start baseline scan
curl -X POST http://localhost:3001/api/security/scan/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"project_id":"<project-id>","scan_type":"baseline"}'

# Poll status
curl http://localhost:3001/api/security/scan/status/<scan-id> \
  -H "Authorization: Bearer $TOKEN"

# Get full results
curl http://localhost:3001/api/security/scan/results/<scan-id> \
  -H "Authorization: Bearer $TOKEN"
```

### 3. Governance Check (admin role required)

```bash
curl http://localhost:3001/api/security/governance/release-check/<scan-id> \
  -H "Authorization: Bearer $TOKEN"
# → Returns: { release_decision: "APPROVED" or "BLOCKED", metrics: {...} }
```

## Scan Types

| Type | Description | Duration |
|------|-------------|----------|
| `baseline` | Spider + passive scan only. Fast, non-intrusive. | 2-5 min |
| `active` | Spider + passive + active attack scan. Thorough. | 10-30 min |
| `api` | OpenAPI spec import + active scan. For APIs. | 5-15 min |

## Governance Rules

- **Release Gate**: If Critical + High vulnerabilities exceed **30%** of total findings, the release is **BLOCKED**.
- **Regression Detection**: Vulnerabilities found in previous scans that reappear are flagged as regressions.
- **Executive Summary**: Auto-generated plain-language summary for leadership.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://aaqua:aaqua@localhost:5433/aaqua_security` | PostgreSQL connection string |
| `ZAP_API_URL` | Yes | `http://localhost:8080` | ZAP daemon URL |
| `ZAP_API_KEY` | No | _(empty)_ | ZAP API key (disabled in dev) |
| `KEYCLOAK_REALM_URL` | Yes | `http://localhost:8082/realms/aaseya-platform` | Backend uses this for OIDC discovery + JWKS |
| `KEYCLOAK_AUDIENCE` | Yes | `aaqua-frontend` | Backend enforces this `aud`/`azp` claim |
| `KEYCLOAK_ADMIN_USER` | Yes | `superadmin` | Bootstrap admin for Keycloak admin console |
| `KEYCLOAK_ADMIN_PASSWORD` | Yes | _(none)_ | Bootstrap admin password |
| `KEYCLOAK_DB_PASSWORD` | Yes | _(none)_ | Password for the `keycloak_user` Postgres role |
| `VITE_KEYCLOAK_URL` | Yes (frontend) | `http://localhost:8082` | Keycloak base URL exposed to the SPA |
| `VITE_KEYCLOAK_REALM` | Yes (frontend) | `aaseya-platform` | Realm name used by `react-oidc-context` |
| `VITE_KEYCLOAK_CLIENT_ID` | Yes (frontend) | `aaqua-frontend` | OIDC public client ID |
| `VITE_LLM_API_KEY` | Yes | — | Aaseya LLM gateway key for AI analysis |
| `JIRA_ENABLED` | No | `false` | Enable Jira integration |
| `JIRA_URL` | No | — | Jira instance URL |
| `JIRA_EMAIL` | No | — | Jira user email |
| `JIRA_TOKEN` | No | — | Jira API token |
| `JIRA_PROJECT_KEY` | No | — | Jira project key |
| `ALLOW_PRIVATE_SCAN` | No | `false` | Let ZAP target private/internal IPs |

## File Structure

```
server/
├── index.js              # Express app (mounts security routes)
├── db.js                 # Sequelize PostgreSQL connection (pinned to public schema)
├── models/               # ORM models — no User model; identity owned by Keycloak
│   ├── index.js          # Associations & DB init
│   ├── Project.js        # owner_id stores Keycloak `sub`
│   ├── Scan.js           # initiated_by stores Keycloak `sub`; `logs` TEXT holds the run tail
│   ├── Vulnerability.js
│   └── GovernanceMetric.js
├── routes/               # API route handlers
│   ├── projectRoutes.js
│   ├── scanRoutes.js
│   ├── dashboardRoutes.js
│   └── governanceRoutes.js   (admin-only via requireRole('admin'))
├── services/             # Business logic
│   ├── zapService.js     # OWASP ZAP API client
│   ├── aiAnalysisService.js  # AI analysis
│   ├── governanceService.js  # Release gating
│   └── jiraService.js    # Jira integration
└── middleware/           # Security middleware
    ├── auth.js           # Keycloak JWT verification (jose + JWKS)
    ├── rateLimiter.js    # Rate limiting
    └── urlValidator.js   # SSRF prevention
keycloak/
├── aaseya-platform-realm.json   Realm export imported on Keycloak boot
└── init/01-keycloak-schema.sh   Postgres init for `keycloak` schema + role
scripts/
└── migrate-drop-users-table.sql One-shot cutover after switching to Keycloak
```

## Migrating from the Legacy Local-Auth Build

If you're upgrading a deployment that still has the old `users` table from the legacy JWT auth:

```bash
npm run migrate:cutover
```

This runs `scripts/migrate-drop-users-table.sql` — drops FK constraints from `projects.owner_id` and `scans.initiated_by`, then drops the `users` table. Existing project/scan rows keep their `owner_id` UUIDs; new logins assign rows to the Keycloak `sub` of the signed-in user.
