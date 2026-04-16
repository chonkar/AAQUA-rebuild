# AI Secure Engine

AI-powered security scanning backend integrated into the AAQUA platform. Uses OWASP ZAP for vulnerability scanning and Gemini AI for intelligent analysis, remediation, and governance.

## Architecture

```
React Frontend  →  Express Server (:3001)  →  ZAP API (:8080)
                                           →  PostgreSQL (:5432)
                                           →  Gemini AI
                                           →  Jira API (optional)
```

## Quick Start

### 1. Start Infrastructure (Docker)

```bash
docker-compose -f docker-compose.security.yml up -d
```

This starts:
- **PostgreSQL 16** on port `5432` (user: `aaqua`, password: `aaqua`, db: `aaqua_security`)
- **OWASP ZAP** on port `8080` (daemon mode, API key disabled for local dev)

### 2. Start Backend Server

```bash
npm run server
```

The server will:
- Auto-connect to PostgreSQL and sync tables
- Mount security APIs at `/api/security/*`
- Log: `Security API: http://localhost:3001/api/security`

### 3. Verify Setup

```bash
# Check ZAP
curl http://localhost:8080/JSON/core/view/version/

# Check DB connection (via server logs)
# Look for: [DB] PostgreSQL connected.
```

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/security/auth/register` | Create user account |
| POST | `/api/security/auth/login` | Login & get JWT token |

### Projects

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/security/projects` | ✅ | Create project |
| GET | `/api/security/projects` | ✅ | List projects |
| GET | `/api/security/projects/:id` | ✅ | Get project details |
| DELETE | `/api/security/projects/:id` | ✅ | Delete project |

### Scans

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/security/scan/start` | ✅ | Start a scan |
| GET | `/api/security/scan/status/:scanId` | ✅ | Poll scan progress |
| GET | `/api/security/scan/results/:scanId` | ✅ | Get full results |

### Dashboard & Governance

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/security/dashboard/summary/:projectId` | ✅ | Project dashboard |
| GET | `/api/security/governance/release-check/:scanId` | ✅ | Release gate check |
| GET | `/api/security/governance/trend/:projectId` | ✅ | Historical trend |

### Health

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/security/zap/health` | ❌ | ZAP connection status |

## Example Usage

### 1. Register & Login

```bash
# Register
curl -X POST http://localhost:3001/api/security/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@aaqua.com","password":"admin123!","name":"Admin"}'

# Login
curl -X POST http://localhost:3001/api/security/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@aaqua.com","password":"admin123!"}'
# → Returns: { token: "eyJhbGciOi..." }
```

### 2. Create Project & Start Scan

```bash
TOKEN="your-jwt-token"

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

### 3. Governance Check

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

- **Release Gate**: If Critical + High vulnerabilities exceed **30%** of total findings, the release is **BLOCKED**
- **Regression Detection**: Vulnerabilities found in previous scans that reappear are flagged as regressions
- **Executive Summary**: Auto-generated plain-language summary for leadership

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://aaqua:aaqua@localhost:5432/aaqua_security` | PostgreSQL connection string |
| `ZAP_API_URL` | Yes | `http://localhost:8080` | ZAP daemon URL |
| `ZAP_API_KEY` | No | _(empty)_ | ZAP API key (disabled in dev) |
| `JWT_SECRET` | Yes | _(default)_ | Secret for JWT signing |
| `JWT_EXPIRES_IN` | No | `24h` | Token expiration |
| `VITE_GEMINI_API_KEY` | Yes | — | Gemini API key for AI analysis |
| `JIRA_ENABLED` | No | `false` | Enable Jira integration |
| `JIRA_URL` | No | — | Jira instance URL |
| `JIRA_EMAIL` | No | — | Jira user email |
| `JIRA_TOKEN` | No | — | Jira API token |
| `JIRA_PROJECT_KEY` | No | — | Jira project key |

## File Structure

```
server/
├── index.js              # Express app (mounts security routes)
├── db.js                 # Sequelize PostgreSQL connection
├── models/               # ORM models
│   ├── index.js          # Associations & DB init
│   ├── User.js
│   ├── Project.js
│   ├── Scan.js
│   ├── Vulnerability.js
│   └── GovernanceMetric.js
├── routes/               # API route handlers
│   ├── authRoutes.js
│   ├── projectRoutes.js
│   ├── scanRoutes.js
│   ├── dashboardRoutes.js
│   └── governanceRoutes.js
├── services/             # Business logic
│   ├── zapService.js     # OWASP ZAP API client
│   ├── aiAnalysisService.js  # Gemini AI analysis
│   ├── governanceService.js  # Release gating
│   └── jiraService.js    # Jira integration
└── middleware/           # Security middleware
    ├── auth.js           # JWT auth
    ├── rateLimiter.js    # Rate limiting
    └── urlValidator.js   # SSRF prevention
```
