# Phase 1 + 1.5: MUI UI Foundation, Job Store, SSE & LLM Streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled CSS shell with a responsive MUI design system, introduce the shared `ToolWorkflow` wizard, and replace polling/fake progress with a Postgres-backed job store + SSE (including streamed LLM output), proven on two pilot pages.

**Architecture:** New MUI theme wraps the existing React 19 SPA; a shared `ToolWorkflow` stepper becomes the frame all tools adopt. Backend gains a `jobs` table (Sequelize, auto-created by the existing `sync({alter:true})`), an in-process emitter bridging job updates to `GET /api/events/:jobId` (SSE), and an LLM streaming proxy so the browser never calls the LLM directly.

**Tech Stack:** React 19, Vite 7, MUI v6 (`@mui/material`, `@mui/x-data-grid`), Emotion, Vitest + React Testing Library, Express 5, Sequelize 6/Postgres, `jose` (existing JWT middleware), SSE via native `EventSource`.

**Spec:** `docs/superpowers/specs/2026-07-29-ui-modernization-sso-k8s-design.md` §5.1, §5.2, §5.4.3 (job-store subset), §7.

**Follow-up plans (written after this ships, same spec):** Phase 2 page-migration batches, Phase 3 M365 SSO (Keycloak/Entra config), Phase 4 hardening, Phase 5 K8s.

**Working conventions for all tasks:**
- Run everything from the project root `qa-test-gen/` (the git repo root is its parent — commit paths are prefixed `qa-test-gen/`).
- Frontend dev server: `npm run dev` (5173). Backend: `npm run server` (3001). Tests: `npx vitest run <file>`.
- Another agent (IntelliJ) may hold uncommitted changes to `CLAUDE.md`/`README.md` — never `git add -A`; stage explicit paths only.

---

## File Structure

```
src/
  theme.js                          NEW  getTheme(mode) — MUI theme from brand tokens
  main.jsx                          MOD  wrap app in ThemeProvider + CssBaseline
  components/common/
    NotificationProvider.jsx        NEW  snackbar context + useNotify()
    Layout.jsx                      MOD  AppBar + responsive Drawer shell
  components/workflow/
    ToolWorkflow.jsx                NEW  shared stepper frame (Input→Configure→Generate→Review→Export)
    GenerationProgress.jsx          NEW  SSE consumer with reconnect + polling fallback
  utils/
    sseClient.js                    NEW  subscribeToJob(jobId, handlers) EventSource wrapper
    llmStream.js                    NEW  streamLLM({prompt, onToken}) → backend proxy
  pages/
    TestCaseGenerator.jsx (via route /test-generator)   MOD  pilot 1 on ToolWorkflow
    TestPlanGenerator.jsx                                MOD  pilot 2 on ToolWorkflow
server/
  models/Job.js                     NEW  jobs table
  models/index.js                   MOD  register Job
  services/jobStore.js              NEW  create/progress/complete/fail + EventEmitter
  routes/eventRoutes.js             NEW  GET /api/events/:jobId (SSE, token via query param)
  routes/llmRoutes.js               NEW  POST /api/llm/generate (streaming proxy)
  index.js                          MOD  mount /api/events and /api/llm
tests/
  frontend/  (vitest, jsdom)        NEW  theme, notifications, ToolWorkflow, sseClient
  server/    (vitest, node env)     NEW  jobStore, SSE route, llm proxy
vitest.config.js                    NEW  two projects: frontend (jsdom) / server (node)
```

---

### Task 1: Test tooling

**Files:**
- Create: `vitest.config.js`, `tests/frontend/setup.js`, `tests/frontend/smoke.test.jsx`
- Modify: `package.json` (devDeps + `test` script)

- [ ] **Step 1: Install dev dependencies**

```bash
npm i -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom supertest
```

- [ ] **Step 2: Create `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['tests/frontend/**/*.test.{js,jsx}'],
          setupFiles: ['tests/frontend/setup.js'],
          globals: true,
        },
      },
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/server/**/*.test.js'],
          globals: true,
        },
      },
    ],
  },
})
```

- [ ] **Step 3: Create `tests/frontend/setup.js`**

```js
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 4: Create smoke test `tests/frontend/smoke.test.jsx`**

```jsx
import { render, screen } from '@testing-library/react'

test('vitest + RTL renders JSX', () => {
  render(<div>aaqua-test-ok</div>)
  expect(screen.getByText('aaqua-test-ok')).toBeInTheDocument()
})
```

- [ ] **Step 5: Add script to `package.json`** — in `"scripts"`, add `"test": "vitest run"`.

- [ ] **Step 6: Run and verify PASS**

Run: `npx vitest run tests/frontend/smoke.test.jsx`
Expected: 1 passed.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.js tests/
git commit -m "test: add vitest + RTL test infrastructure (frontend jsdom / server node projects)"
```

---

### Task 2: MUI dependencies

**Files:** Modify: `package.json`

- [ ] **Step 1: Install**

```bash
npm i @mui/material @emotion/react @emotion/styled @mui/icons-material @mui/x-data-grid
```

- [ ] **Step 2: Verify the build still passes** — Run: `npm run build`. Expected: Vite build completes with no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add MUI v6 + emotion + x-data-grid dependencies"
```

---

### Task 3: Theme (`src/theme.js`)

Encodes the existing brand tokens from `src/index.css` (`--bg-primary: #0a0a0f`, accent `#6d28d9`, Inter) as an MUI theme with dark and light palettes.

**Files:**
- Create: `src/theme.js`
- Test: `tests/frontend/theme.test.js`

- [ ] **Step 1: Read `src/index.css` and `src/hooks/useTheme.js`** to capture the full token set (surface colors, radius, light-mode values) and the hook's API (how mode is stored/toggled). Adjust the literals below if the CSS variables differ.

- [ ] **Step 2: Write the failing test `tests/frontend/theme.test.js`**

```js
import { getTheme } from '../../src/theme'

test('dark theme carries AAQUA brand tokens', () => {
  const t = getTheme('dark')
  expect(t.palette.mode).toBe('dark')
  expect(t.palette.primary.main).toBe('#6d28d9')
  expect(t.palette.background.default.toLowerCase()).toBe('#0a0a0f')
  expect(t.typography.fontFamily).toMatch(/Inter/)
})

test('light theme keeps the same primary accent', () => {
  const t = getTheme('light')
  expect(t.palette.mode).toBe('light')
  expect(t.palette.primary.main).toBe('#6d28d9')
})
```

- [ ] **Step 3: Run to verify it fails** — `npx vitest run tests/frontend/theme.test.js` → FAIL (`getTheme` not found).

- [ ] **Step 4: Create `src/theme.js`**

```js
import { createTheme } from '@mui/material/styles'

const brand = {
  accent: '#6d28d9',
  accentHover: '#7c3aed',
  bgDark: '#0a0a0f',
  paperDark: '#13131a',
  bgLight: '#f7f7fb',
  paperLight: '#ffffff',
}

export function getTheme(mode = 'dark') {
  const dark = mode === 'dark'
  return createTheme({
    palette: {
      mode,
      primary: { main: brand.accent, dark: '#5b21b6', light: brand.accentHover },
      background: dark
        ? { default: brand.bgDark, paper: brand.paperDark }
        : { default: brand.bgLight, paper: brand.paperLight },
      ...(dark && { text: { primary: '#e5e5ec', secondary: '#9c9cab' } }),
    },
    typography: {
      fontFamily: `'Inter', system-ui, sans-serif`,
      h1: { fontSize: '2rem', fontWeight: 700 },
      h2: { fontSize: '1.5rem', fontWeight: 600 },
      h3: { fontSize: '1.25rem', fontWeight: 600 },
      button: { textTransform: 'none', fontWeight: 600 },
    },
    shape: { borderRadius: 10 },
    components: {
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiTooltip: { defaultProps: { arrow: true } },
    },
  })
}
```

- [ ] **Step 5: Run to verify PASS** — `npx vitest run tests/frontend/theme.test.js` → 2 passed.

- [ ] **Step 6: Wire providers in `src/main.jsx`** — read the file first; wrap the existing tree (inside the OIDC/router providers, outside `App`) with:

```jsx
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { getTheme } from './theme'
// inside the component that has access to the current mode from useTheme():
<ThemeProvider theme={getTheme(mode)}>
  <CssBaseline />
  {/* existing app tree */}
</ThemeProvider>
```

If `useTheme()` lives below `main.jsx`, create a small `AppThemeBridge` component in `main.jsx` that calls the hook and renders the provider, so the toggle keeps working.

- [ ] **Step 7: Verify visually** — `npm run dev`, open http://localhost:5173: app renders, dark background intact, no console errors. The old CSS still applies on unmigrated pages — that's expected coexistence.

- [ ] **Step 8: Commit**

```bash
git add src/theme.js src/main.jsx tests/frontend/theme.test.js
git commit -m "feat: MUI theme with AAQUA brand tokens, ThemeProvider wired to existing mode toggle"
```

---

### Task 4: NotificationProvider (`useNotify`)

**Files:**
- Create: `src/components/common/NotificationProvider.jsx`
- Modify: `src/main.jsx` (wrap inside ThemeProvider)
- Test: `tests/frontend/notifications.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotificationProvider, useNotify } from '../../src/components/common/NotificationProvider'

function Demo() {
  const notify = useNotify()
  return <button onClick={() => notify.success('Saved!')}>go</button>
}

test('notify.success shows a snackbar', async () => {
  render(<NotificationProvider><Demo /></NotificationProvider>)
  await userEvent.click(screen.getByText('go'))
  expect(await screen.findByText('Saved!')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement `src/components/common/NotificationProvider.jsx`**

```jsx
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { Alert, Snackbar } from '@mui/material'

const NotifyContext = createContext(null)

export function NotificationProvider({ children }) {
  const [toast, setToast] = useState(null) // {message, severity}
  const show = useCallback((message, severity) => setToast({ message, severity }), [])
  const api = useMemo(() => ({
    success: (m) => show(m, 'success'),
    error: (m) => show(m, 'error'),
    info: (m) => show(m, 'info'),
    warning: (m) => show(m, 'warning'),
  }), [show])
  return (
    <NotifyContext.Provider value={api}>
      {children}
      <Snackbar
        open={!!toast}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast && <Alert severity={toast.severity} onClose={() => setToast(null)}>{toast.message}</Alert>}
      </Snackbar>
    </NotifyContext.Provider>
  )
}

export function useNotify() {
  const ctx = useContext(NotifyContext)
  if (!ctx) throw new Error('useNotify must be used within NotificationProvider')
  return ctx
}
```

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Mount in `src/main.jsx`** directly inside `ThemeProvider`.

- [ ] **Step 6: Commit**

```bash
git add src/components/common/NotificationProvider.jsx src/main.jsx tests/frontend/notifications.test.jsx
git commit -m "feat: global snackbar NotificationProvider with useNotify hook"
```

---

### Task 5: Responsive app shell (Layout)

**Files:**
- Modify: `src/components/common/Layout.jsx`, `src/components/common/Header.jsx`, `src/components/common/Sidebar.jsx`
- Test: `tests/frontend/layout.test.jsx`

- [ ] **Step 1: Read the three existing components** and note: nav item list (route + label + icon + lock state from `RequireProject`), where the project selector and user menu render, and the `Sidebar.jsx` inline `<style>` block (to be deleted).

- [ ] **Step 2: Write the failing test**

```jsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Layout from '../../src/components/common/Layout'

// Mock auth + project contexts the shell consumes (adapt import paths after Step 1).
vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ isAuthenticated: true, user: { profile: { name: 'Tester', email: 't@aaseya.com' } }, signoutRedirect: vi.fn() }),
}))

test('shell renders app bar, nav drawer and content area', () => {
  render(
    <MemoryRouter>
      <Layout><div>page-content</div></Layout>
    </MemoryRouter>
  )
  expect(screen.getByRole('banner')).toBeInTheDocument()          // AppBar
  expect(screen.getByLabelText(/navigation/i)).toBeInTheDocument() // Drawer nav
  expect(screen.getByText('page-content')).toBeInTheDocument()
})
```

Wrap with `ProjectContext` provider too if `Layout` consumes it (check in Step 1).

- [ ] **Step 3: Run to verify it fails** (old Layout has no `role="banner"`/nav label).

- [ ] **Step 4: Rebuild `Layout.jsx`** — structure (keep existing nav data and guards; this is the frame):

```jsx
import { useState } from 'react'
import { AppBar, Box, Drawer, IconButton, Toolbar, Typography, useMediaQuery } from '@mui/material'
import MenuIcon from '@mui/icons-material/Menu'
import { useTheme as useMuiTheme } from '@mui/material/styles'
import Sidebar from './Sidebar'
import Header from './Header'

const DRAWER_WIDTH = 264

export default function Layout({ children }) {
  const mui = useMuiTheme()
  const isDesktop = useMediaQuery(mui.breakpoints.up('md'))
  const [mobileOpen, setMobileOpen] = useState(false)

  const drawer = <Sidebar onNavigate={() => setMobileOpen(false)} />

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Toolbar sx={{ gap: 1 }}>
          {!isDesktop && (
            <IconButton color="inherit" edge="start" aria-label="open navigation"
              onClick={() => setMobileOpen(true)}><MenuIcon /></IconButton>
          )}
          <Typography variant="h6" sx={{ flexGrow: 0, mr: 2 }}>AAQUA</Typography>
          <Header /> {/* project selector, theme toggle, user menu — existing logic, MUI controls */}
        </Toolbar>
      </AppBar>
      <Box component="nav" aria-label="main navigation" sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}>
        {isDesktop ? (
          <Drawer variant="permanent" open
            sx={{ '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' } }}>
            <Toolbar />{drawer}
          </Drawer>
        ) : (
          <Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)}
            ModalProps={{ keepMounted: true }}
            sx={{ '& .MuiDrawer-paper': { width: DRAWER_WIDTH } }}>
            {drawer}
          </Drawer>
        )}
      </Box>
      <Box component="main" sx={{ flexGrow: 1, p: { xs: 2, md: 3 }, width: { md: `calc(100% - ${DRAWER_WIDTH}px)` } }}>
        <Toolbar />
        {children}
      </Box>
    </Box>
  )
}
```

Rebuild `Sidebar.jsx` as an MUI `List` of `ListItemButton`s from the existing nav array (preserve lock behavior: `disabled` + lock icon + tooltip "Select a project first" when no active project). Delete its inline `<style>` block. `onNavigate` fires on item click so the mobile drawer closes. Rebuild `Header.jsx` controls with MUI (`Select` or `Menu` for project, `IconButton` for theme toggle, `Avatar`+`Menu` for user/logout) keeping all existing handlers.

- [ ] **Step 5: Run to verify PASS**, then run the full suite: `npx vitest run` → all green.

- [ ] **Step 6: Manual responsive check** — dev server at 375px, 768px, 1440px: hamburger appears below `md`, drawer overlays and closes on nav, no horizontal scroll.

- [ ] **Step 7: Commit**

```bash
git add src/components/common/ tests/frontend/layout.test.jsx
git commit -m "feat: responsive MUI app shell (AppBar + adaptive Drawer), Sidebar/Header on MUI"
```

---

### Task 6: ToolWorkflow stepper frame

The shared wizard every tool adopts: **Input → Configure → Generate → Review → Export**.

**Files:**
- Create: `src/components/workflow/ToolWorkflow.jsx`
- Test: `tests/frontend/toolworkflow.test.jsx`

**Props API (lock this — later plans depend on it):**

```
<ToolWorkflow
  title="Test Case Generator"
  steps={[
    { key: 'input',     label: 'Input',     content: <.../>, canAdvance: bool },
    { key: 'configure', label: 'Configure', content: <.../>, canAdvance: bool },   // optional step
    { key: 'generate',  label: 'Generate',  content: <.../>, autoAdvanceWhen: bool },
    { key: 'review',    label: 'Review',    content: <.../> },
    { key: 'export',    label: 'Export',    content: <.../> },
  ]}
  activeStep={number}            // controlled
  onStepChange={(index) => {}}
/>
```

- [ ] **Step 1: Write the failing test**

```jsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import ToolWorkflow from '../../src/components/workflow/ToolWorkflow'

function Harness({ canAdvance = true }) {
  const [step, setStep] = useState(0)
  return (
    <ToolWorkflow
      title="Demo Tool"
      activeStep={step}
      onStepChange={setStep}
      steps={[
        { key: 'input', label: 'Input', content: <div>step-input</div>, canAdvance },
        { key: 'review', label: 'Review', content: <div>step-review</div> },
      ]}
    />
  )
}

test('renders title, stepper labels and active step content', () => {
  render(<Harness />)
  expect(screen.getByRole('heading', { name: 'Demo Tool' })).toBeInTheDocument()
  expect(screen.getByText('Input')).toBeInTheDocument()
  expect(screen.getByText('step-input')).toBeInTheDocument()
  expect(screen.queryByText('step-review')).not.toBeInTheDocument()
})

test('Next advances when canAdvance, Back returns', async () => {
  render(<Harness />)
  await userEvent.click(screen.getByRole('button', { name: /next/i }))
  expect(screen.getByText('step-review')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /back/i }))
  expect(screen.getByText('step-input')).toBeInTheDocument()
})

test('Next is disabled when canAdvance is false', () => {
  render(<Harness canAdvance={false} />)
  expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/components/workflow/ToolWorkflow.jsx`**

```jsx
import { Box, Button, Paper, Step, StepLabel, Stepper, Typography, useMediaQuery } from '@mui/material'
import { useTheme } from '@mui/material/styles'

export default function ToolWorkflow({ title, steps, activeStep, onStepChange }) {
  const mui = useTheme()
  const isMobile = useMediaQuery(mui.breakpoints.down('sm'))
  const current = steps[activeStep]
  const isLast = activeStep === steps.length - 1

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Typography variant="h1" component="h1" sx={{ mb: 2 }}>{title}</Typography>
      <Stepper activeStep={activeStep} alternativeLabel={!isMobile}
        orientation={isMobile ? 'vertical' : 'horizontal'} sx={{ mb: 3 }}>
        {steps.map((s) => <Step key={s.key}><StepLabel>{s.label}</StepLabel></Step>)}
      </Stepper>
      <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, mb: 2 }}>
        {current.content}
      </Paper>
      <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
        <Button disabled={activeStep === 0} onClick={() => onStepChange(activeStep - 1)}>Back</Button>
        {!isLast && (
          <Button variant="contained" disabled={current.canAdvance === false}
            onClick={() => onStepChange(activeStep + 1)}>Next</Button>
        )}
      </Box>
    </Box>
  )
}
```

- [ ] **Step 4: Run to verify PASS** (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/workflow/ToolWorkflow.jsx tests/frontend/toolworkflow.test.jsx
git commit -m "feat: shared ToolWorkflow stepper frame (Input→Configure→Generate→Review→Export)"
```

---

### Task 7: Job model + jobStore service (backend)

**Files:**
- Create: `server/models/Job.js`, `server/services/jobStore.js`
- Modify: `server/models/index.js` (register + export Job)
- Test: `tests/server/jobStore.test.js`

- [ ] **Step 1: Read `server/models/Project.js` and `server/models/index.js`** to copy the exact model-definition idiom (they use `underscored: true`, `freezeTableName: true` globally).

- [ ] **Step 2: Create `server/models/Job.js`** (match the idiom found in Step 1; shape below):

```js
import { DataTypes } from 'sequelize'
import sequelize from '../db.js'

const Job = sequelize.define('jobs', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  type: { type: DataTypes.STRING, allowNull: false },        // 'test-cases' | 'test-plan' | 'localization' | ...
  status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' }, // pending|running|completed|failed
  progress: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },      // 0-100
  phase: { type: DataTypes.STRING },                          // human-readable current phase
  payload: { type: DataTypes.JSONB },
  result: { type: DataTypes.JSONB },
  error: { type: DataTypes.TEXT },
  owner_id: { type: DataTypes.STRING },                       // keycloak sub
})

export default Job
```

- [ ] **Step 3: Register in `server/models/index.js`** following the existing import/export pattern. No association needed. The existing `sequelize.sync({ alter: true })` at boot creates the table — no migration file.

- [ ] **Step 4: Write the failing test `tests/server/jobStore.test.js`** — pure unit test with the DB mocked, so CI needs no Postgres:

```js
import { describe, expect, test, vi, beforeEach } from 'vitest'

const rows = new Map()
vi.mock('../../server/models/index.js', () => ({
  Job: {
    create: vi.fn(async (data) => {
      const row = { id: 'job-1', status: 'pending', progress: 0, ...data,
        update: vi.fn(async function (patch) { Object.assign(this, patch); rows.set(this.id, this); return this }) }
      rows.set(row.id, row)
      return row
    }),
    findByPk: vi.fn(async (id) => rows.get(id) ?? null),
  },
}))

import { createJob, updateProgress, completeJob, failJob, getJob, jobEvents } from '../../server/services/jobStore.js'

beforeEach(() => rows.clear())

test('createJob returns a pending job and emits nothing yet', async () => {
  const job = await createJob({ type: 'test-cases', ownerId: 'u1', payload: { req: 'x' } })
  expect(job.status).toBe('pending')
  expect(job.id).toBeTruthy()
})

test('updateProgress persists and emits an event keyed by job id', async () => {
  const job = await createJob({ type: 'test-cases', ownerId: 'u1' })
  const seen = []
  jobEvents.on(`job:${job.id}`, (e) => seen.push(e))
  await updateProgress(job.id, { progress: 40, phase: 'Generating cases' })
  expect(seen[0]).toMatchObject({ status: 'running', progress: 40, phase: 'Generating cases' })
  expect((await getJob(job.id)).progress).toBe(40)
})

test('completeJob and failJob are terminal and emitted', async () => {
  const a = await createJob({ type: 't' })
  await completeJob(a.id, { items: [1] })
  expect((await getJob(a.id)).status).toBe('completed')
  const b = await createJob({ type: 't' })
  await failJob(b.id, new Error('boom'))
  const failed = await getJob(b.id)
  expect(failed.status).toBe('failed')
  expect(failed.error).toMatch('boom')
})
```

- [ ] **Step 5: Run to verify it fails** — `npx vitest run tests/server/jobStore.test.js` → module not found.

- [ ] **Step 6: Implement `server/services/jobStore.js`**

```js
import { EventEmitter } from 'node:events'
import { Job } from '../models/index.js'

export const jobEvents = new EventEmitter()
jobEvents.setMaxListeners(200)

function emit(job) {
  jobEvents.emit(`job:${job.id}`, {
    id: job.id, status: job.status, progress: job.progress,
    phase: job.phase ?? null, result: job.result ?? null, error: job.error ?? null,
  })
}

export async function createJob({ type, ownerId = null, payload = null }) {
  return Job.create({ type, owner_id: ownerId, payload })
}

export async function updateProgress(id, { progress, phase }) {
  const job = await Job.findByPk(id)
  if (!job) return null
  await job.update({ status: 'running', progress, ...(phase !== undefined && { phase }) })
  emit(job)
  return job
}

export async function completeJob(id, result) {
  const job = await Job.findByPk(id)
  if (!job) return null
  await job.update({ status: 'completed', progress: 100, result })
  emit(job)
  return job
}

export async function failJob(id, err) {
  const job = await Job.findByPk(id)
  if (!job) return null
  await job.update({ status: 'failed', error: String(err?.message ?? err) })
  emit(job)
  return job
}

export async function getJob(id) {
  return Job.findByPk(id)
}
```

- [ ] **Step 7: Run to verify PASS** (3 tests).

- [ ] **Step 8: Commit**

```bash
git add server/models/Job.js server/models/index.js server/services/jobStore.js tests/server/jobStore.test.js
git commit -m "feat: Postgres-backed job store with progress events (jobs survive restarts)"
```

---

### Task 8: SSE endpoint `GET /api/events/:jobId`

**Auth note (important):** the browser `EventSource` API cannot set headers, so the Bearer token rides a query parameter. Reuse the existing verifier: read `server/middleware/auth.js` first — extract its JWT-verification core into an exported `verifyToken(tokenString)` function that `authenticateToken` also uses, then call it here with `req.query.access_token`.

**Files:**
- Create: `server/routes/eventRoutes.js`
- Modify: `server/middleware/auth.js` (export `verifyToken`), `server/index.js` (mount router)
- Test: `tests/server/eventRoutes.test.js`

- [ ] **Step 1: Refactor `server/middleware/auth.js`** — move the token verification body (JWKS fetch, `jwtVerify`, iss/aud checks, user extraction) into:

```js
export async function verifyToken(token) {
  // ... existing verification logic, returns the user object or throws
}
```

and have `authenticateToken` call it. Run any existing usage manually: `npm run server` boots without error.

- [ ] **Step 2: Write the failing test `tests/server/eventRoutes.test.js`**

```js
import { describe, expect, test, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { EventEmitter } from 'node:events'

const emitter = new EventEmitter()
const jobRow = { id: 'j1', status: 'running', progress: 10, phase: 'starting', result: null, error: null }

vi.mock('../../server/services/jobStore.js', () => ({
  jobEvents: emitter,
  getJob: vi.fn(async (id) => (id === 'j1' ? jobRow : null)),
}))
vi.mock('../../server/middleware/auth.js', () => ({
  verifyToken: vi.fn(async (t) => {
    if (t !== 'good-token') throw new Error('bad token')
    return { id: 'u1', email: 't@aaseya.com' }
  }),
}))

import eventRoutes from '../../server/routes/eventRoutes.js'

function makeApp() {
  const app = express()
  app.use('/api/events', eventRoutes)
  return app
}

test('rejects missing/invalid token with 401', async () => {
  await request(makeApp()).get('/api/events/j1').expect(401)
  await request(makeApp()).get('/api/events/j1?access_token=bad').expect(401)
})

test('unknown job returns 404', async () => {
  await request(makeApp()).get('/api/events/nope?access_token=good-token').expect(404)
})

test('streams initial state then live updates as SSE', async () => {
  const app = makeApp()
  const res = await new Promise((resolve, reject) => {
    const req = request(app).get('/api/events/j1?access_token=good-token')
      .buffer(false)
      .parse((res) => {
        let body = ''
        res.on('data', (c) => {
          body += c.toString()
          if (body.includes('"progress":55')) { res.destroy(); resolve({ res, body }) }
        })
        res.on('error', reject)
      })
    req.end((err) => err && !String(err).includes('aborted') && reject(err))
    setTimeout(() => emitter.emit('job:j1', { ...jobRow, progress: 55, phase: 'halfway' }), 100)
  })
  expect(res.res.headers['content-type']).toMatch('text/event-stream')
  expect(res.body).toContain('"progress":10')  // replayed initial state
  expect(res.body).toContain('"progress":55')  // live event
})
```

- [ ] **Step 3: Run to verify it fails** — module not found.

- [ ] **Step 4: Implement `server/routes/eventRoutes.js`**

```js
import { Router } from 'express'
import { verifyToken } from '../middleware/auth.js'
import { getJob, jobEvents } from '../services/jobStore.js'

const router = Router()

router.get('/:jobId', async (req, res) => {
  try {
    const token = req.query.access_token
    if (!token) return res.status(401).json({ error: 'missing access_token' })
    await verifyToken(token)
  } catch {
    return res.status(401).json({ error: 'invalid token' })
  }

  const job = await getJob(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'job not found' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering
  })

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
  // Replay current state so reconnects never miss the latest status.
  send({ id: job.id, status: job.status, progress: job.progress, phase: job.phase, result: job.result, error: job.error })

  const channel = `job:${req.params.jobId}`
  const onEvent = (e) => {
    send(e)
    if (e.status === 'completed' || e.status === 'failed') res.end()
  }
  jobEvents.on(channel, onEvent)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000)

  req.on('close', () => {
    clearInterval(heartbeat)
    jobEvents.off(channel, onEvent)
  })
})

export default router
```

- [ ] **Step 5: Run to verify PASS** (3 tests).

- [ ] **Step 6: Mount in `server/index.js`** next to the other routers (around line 3629):

```js
import eventRoutes from './routes/eventRoutes.js'
app.use('/api/events', eventRoutes)
```

(No `authenticateToken` on the mount — the route validates the query-param token itself.)

- [ ] **Step 7: Commit**

```bash
git add server/routes/eventRoutes.js server/middleware/auth.js server/index.js tests/server/eventRoutes.test.js
git commit -m "feat: SSE job-progress endpoint with token auth, replay-on-connect and heartbeat"
```

---

### Task 9: Frontend SSE client (`subscribeToJob`)

**Files:**
- Create: `src/utils/sseClient.js`
- Test: `tests/frontend/sseClient.test.js`

- [ ] **Step 1: Read `src/utils/apiClient.js`** to find how the current access token is obtained (it attaches a Bearer token — reuse the same source) and the API base path convention (`/aaqua/` base in prod).

- [ ] **Step 2: Write the failing test**

```js
import { describe, expect, test, vi, beforeEach } from 'vitest'

class FakeEventSource {
  static instances = []
  constructor(url) { this.url = url; this.listeners = {}; FakeEventSource.instances.push(this) }
  addEventListener(type, fn) { this.listeners[type] = fn }
  set onmessage(fn) { this.listeners.message = fn }
  get onmessage() { return this.listeners.message }
  close() { this.closed = true }
  emit(data) { this.listeners.message?.({ data: JSON.stringify(data) }) }
}
vi.stubGlobal('EventSource', FakeEventSource)
vi.mock('../../src/utils/apiClient.js', () => ({ getAccessToken: () => 'tok-123', API_BASE: '/api' }))

import { subscribeToJob } from '../../src/utils/sseClient.js'

beforeEach(() => { FakeEventSource.instances = [] })

test('opens EventSource with token query param and forwards updates', () => {
  const onUpdate = vi.fn()
  subscribeToJob('j1', { onUpdate })
  const es = FakeEventSource.instances[0]
  expect(es.url).toBe('/api/events/j1?access_token=tok-123')
  es.emit({ id: 'j1', status: 'running', progress: 30 })
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ progress: 30 }))
})

test('terminal events fire onDone/onError and close the stream', () => {
  const onDone = vi.fn(), onError = vi.fn()
  subscribeToJob('j1', { onDone, onError })
  const es = FakeEventSource.instances[0]
  es.emit({ status: 'completed', result: { ok: 1 } })
  expect(onDone).toHaveBeenCalledWith({ ok: 1 })
  expect(es.closed).toBe(true)
})

test('unsubscribe closes the stream', () => {
  const unsub = subscribeToJob('j1', {})
  unsub()
  expect(FakeEventSource.instances[0].closed).toBe(true)
})
```

- [ ] **Step 3: Run to verify it fails.**

- [ ] **Step 4: Implement `src/utils/sseClient.js`** (adapt the two imports to what Step 1 found — if `apiClient.js` doesn't export `getAccessToken`/`API_BASE`, add those exports there as part of this task):

```js
import { getAccessToken, API_BASE } from './apiClient.js'

export function subscribeToJob(jobId, { onUpdate, onDone, onError } = {}) {
  const url = `${API_BASE}/events/${jobId}?access_token=${encodeURIComponent(getAccessToken())}`
  const es = new EventSource(url)
  es.onmessage = (evt) => {
    const data = JSON.parse(evt.data)
    if (data.status === 'completed') { onDone?.(data.result); es.close() }
    else if (data.status === 'failed') { onError?.(data.error); es.close() }
    else onUpdate?.(data)
  }
  // EventSource retries automatically on network drops; server replays state on reconnect.
  return () => es.close()
}
```

- [ ] **Step 5: Run to verify PASS** (3 tests), then full suite.

- [ ] **Step 6: Commit**

```bash
git add src/utils/sseClient.js src/utils/apiClient.js tests/frontend/sseClient.test.js
git commit -m "feat: frontend SSE client subscribeToJob with auto-close on terminal states"
```

---

### Task 10: LLM streaming proxy (backend) + frontend helper

Removes direct browser→LLM calls: the SPA now posts to the backend, which streams tokens back over SSE-format chunks.

**Files:**
- Create: `server/routes/llmRoutes.js`, `src/utils/llmStream.js`
- Modify: `server/index.js` (mount)
- Test: `tests/server/llmRoutes.test.js`

- [ ] **Step 1: Read `server/utils/llmClient.js`** — capture the endpoint resolution (env `LLM_ENDPOINT` / default `https://llm.lab.aaseya.com/v1`), API-key loading, model name (`VITE_LLM_MODEL`/`gemma-4`), and the exact request shape it sends to `/chat/completions`.

- [ ] **Step 2: Write the failing test `tests/server/llmRoutes.test.js`**

```js
import { describe, expect, test, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../server/middleware/auth.js', () => ({
  authenticateToken: (req, _res, next) => { req.user = { id: 'u1' }; next() },
}))

// Mock upstream fetch: an OpenAI-style streaming body with two chunks then [DONE].
const sseBody = [
  'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
  'data: [DONE]\n\n',
].join('')
vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody, {
  status: 200, headers: { 'content-type': 'text/event-stream' },
})))

import llmRoutes from '../../server/routes/llmRoutes.js'

test('proxies prompt upstream with stream:true and relays token chunks', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/llm', llmRoutes)
  const res = await request(app).post('/api/llm/generate')
    .send({ prompt: 'hi', maxTokens: 100 }).expect(200)
  expect(res.headers['content-type']).toMatch('text/event-stream')
  expect(res.text).toContain('Hello')
  expect(res.text).toContain(' world')
  expect(res.text).toContain('[DONE]')
  const upstreamCall = fetch.mock.calls[0]
  expect(upstreamCall[0]).toMatch('/chat/completions')
  expect(JSON.parse(upstreamCall[1].body).stream).toBe(true)
})

test('missing prompt is a 400', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/llm', llmRoutes)
  await request(app).post('/api/llm/generate').send({}).expect(400)
})
```

- [ ] **Step 3: Run to verify it fails.**

- [ ] **Step 4: Implement `server/routes/llmRoutes.js`** (reuse the exact endpoint/key/model resolution found in Step 1 — import from `llmClient.js` if it exports them, otherwise read the same env vars):

```js
import { Router } from 'express'
import { authenticateToken } from '../middleware/auth.js'

const router = Router()
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://llm.lab.aaseya.com/v1'
const LLM_MODEL = process.env.LLM_MODEL || process.env.VITE_LLM_MODEL || 'gemma-4'

router.post('/generate', authenticateToken, async (req, res) => {
  const { prompt, maxTokens = 12000, temperature } = req.body ?? {}
  if (!prompt) return res.status(400).json({ error: 'prompt is required' })

  const upstream = await fetch(`${LLM_ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.LLM_API_KEY && { Authorization: `Bearer ${process.env.LLM_API_KEY}` }),
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      ...(temperature !== undefined && { temperature }),
      stream: true,
    }),
  })
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    return res.status(502).json({ error: `LLM upstream ${upstream.status}`, detail: detail.slice(0, 500) })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  })
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(decoder.decode(value, { stream: true })) // relay OpenAI SSE chunks verbatim
    }
  } finally {
    res.end()
  }
  req.on('close', () => reader.cancel().catch(() => {}))
})

export default router
```

- [ ] **Step 5: Run to verify PASS** (2 tests).

- [ ] **Step 6: Mount in `server/index.js`**: `app.use('/api/llm', llmRoutes)` next to the other mounts.

- [ ] **Step 7: Create `src/utils/llmStream.js`** (fetch-based reader — POST bodies can't use `EventSource`):

```js
import { getAccessToken, API_BASE } from './apiClient.js'

export async function streamLLM({ prompt, maxTokens, temperature, onToken, signal }) {
  const res = await fetch(`${API_BASE}/llm/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAccessToken()}` },
    body: JSON.stringify({ prompt, maxTokens, temperature }),
    signal,
  })
  if (!res.ok) throw new Error(`LLM request failed: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = '', buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n\n')
    buffer = lines.pop() // keep incomplete frame
    for (const line of lines) {
      const data = line.replace(/^data: /, '').trim()
      if (!data || data === '[DONE]') continue
      try {
        const token = JSON.parse(data).choices?.[0]?.delta?.content ?? ''
        if (token) { full += token; onToken?.(token, full) }
      } catch { /* partial frame — ignored */ }
    }
  }
  return full
}
```

- [ ] **Step 8: Run the full suite** — `npx vitest run` → all green.

- [ ] **Step 9: Commit**

```bash
git add server/routes/llmRoutes.js server/index.js src/utils/llmStream.js tests/server/llmRoutes.test.js
git commit -m "feat: backend LLM streaming proxy + frontend streamLLM helper (no direct browser→LLM calls)"
```

---

### Task 11: GenerationProgress component

**Files:**
- Create: `src/components/workflow/GenerationProgress.jsx`
- Test: `tests/frontend/generationProgress.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
import { render, screen, act } from '@testing-library/react'
import { vi } from 'vitest'

let handlers
vi.mock('../../src/utils/sseClient.js', () => ({
  subscribeToJob: vi.fn((id, h) => { handlers = h; return vi.fn() }),
}))

import GenerationProgress from '../../src/components/workflow/GenerationProgress'

test('shows phase + progress from job updates, streamed text, and completion', () => {
  const onDone = vi.fn()
  render(<GenerationProgress jobId="j1" onDone={onDone} />)
  act(() => handlers.onUpdate({ progress: 40, phase: 'Generating test cases' }))
  expect(screen.getByText('Generating test cases')).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  act(() => handlers.onDone({ items: [1, 2] }))
  expect(onDone).toHaveBeenCalledWith({ items: [1, 2] })
})

test('failure shows error alert with retry callback', async () => {
  const onRetry = vi.fn()
  render(<GenerationProgress jobId="j1" onRetry={onRetry} />)
  act(() => handlers.onError('LLM timeout'))
  expect(screen.getByRole('alert')).toHaveTextContent('LLM timeout')
})

test('renders streamed text when streamText prop is provided (LLM mode, no jobId)', () => {
  render(<GenerationProgress streamText="Once upon a test..." />)
  expect(screen.getByText(/Once upon a test/)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/components/workflow/GenerationProgress.jsx`**

```jsx
import { useEffect, useState } from 'react'
import { Alert, Box, Button, LinearProgress, Paper, Typography } from '@mui/material'
import { subscribeToJob } from '../../utils/sseClient.js'

export default function GenerationProgress({ jobId, streamText, onDone, onRetry }) {
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState('Starting…')
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!jobId) return undefined
    setError(null)
    return subscribeToJob(jobId, {
      onUpdate: (e) => { setProgress(e.progress ?? 0); if (e.phase) setPhase(e.phase) },
      onDone: (result) => { setProgress(100); onDone?.(result) },
      onError: (msg) => setError(msg || 'Generation failed'),
    })
  }, [jobId])

  if (error) {
    return (
      <Alert severity="error" role="alert"
        action={onRetry && <Button color="inherit" size="small" onClick={onRetry}>Retry</Button>}>
        {error}
      </Alert>
    )
  }
  return (
    <Box>
      {jobId && (
        <>
          <Typography variant="body2" sx={{ mb: 1 }}>{phase}</Typography>
          <LinearProgress variant="determinate" value={progress}
            aria-valuenow={progress} sx={{ mb: 2, height: 8, borderRadius: 4 }} />
        </>
      )}
      {streamText != null && (
        <Paper variant="outlined" sx={{ p: 2, maxHeight: 320, overflow: 'auto',
          fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap' }}>
          {streamText}
          <Box component="span" sx={{ animation: 'blink 1s step-end infinite',
            '@keyframes blink': { '50%': { opacity: 0 } } }}>▌</Box>
        </Paper>
      )}
    </Box>
  )
}
```

- [ ] **Step 4: Run to verify PASS** (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/workflow/GenerationProgress.jsx tests/frontend/generationProgress.test.jsx
git commit -m "feat: GenerationProgress — live SSE progress bar + streamed LLM output pane"
```

---

### Task 12: Pilot page 1 — Test Case Generator on ToolWorkflow

**Files:**
- Modify: the page component for route `/test-generator` (in `src/pages/`), `src/services/testCaseGeneration.js`
- Reference (reuse, don't rewrite): `src/components/features/RequirementInput.jsx`, `src/components/features/TestCaseTable.jsx`, `src/components/features/ExportControls.jsx`, `src/components/features/JiraDefectButton.jsx`, `src/utils/exportUtils.js`

This task is integration work on existing code, so it starts with reading, and its verification is the existing behavior checklist rather than new unit tests (component behavior is covered by Task 6/11 tests; e2e comes in Task 14).

- [ ] **Step 1: Read the page and its service end-to-end.** Map every user-visible capability to a wizard step before touching code. Expected mapping (verify against reality):
  - **Input** → `RequirementInput` (free text / JIRA story fetch)
  - **Configure** → existing options (test types, counts, format) if present; if the page has no options, omit this step — `ToolWorkflow` accepts any step array
  - **Generate** → `GenerationProgress` with `streamText` from `streamLLM`
  - **Review** → `TestCaseTable` replaced by MUI DataGrid (below)
  - **Export** → `ExportControls` (Excel/CSV/JSON) + `JiraDefectButton`, restyled as MUI buttons

- [ ] **Step 2: Switch the service to streaming.** In `src/services/testCaseGeneration.js`, replace the direct `llmClient` call with `streamLLM` from `src/utils/llmStream.js`, threading an `onToken` callback through, and keep the existing response-parsing (JSON extraction into test-case rows) on the final full text. Signature target:

```js
export async function generateTestCases({ requirement, options, onToken }) {
  const full = await streamLLM({ prompt: buildPrompt(requirement, options), onToken })
  return parseTestCases(full) // existing parsing logic, unchanged
}
```

- [ ] **Step 3: Rebuild the page on the frame.** Skeleton (adapt state/props names to what Step 1 found):

```jsx
import { useState } from 'react'
import ToolWorkflow from '../components/workflow/ToolWorkflow'
import GenerationProgress from '../components/workflow/GenerationProgress'
import { DataGrid } from '@mui/x-data-grid'
import { useNotify } from '../components/common/NotificationProvider'
import { generateTestCases } from '../services/testCaseGeneration'

export default function TestCaseGenerator() {
  const notify = useNotify()
  const [step, setStep] = useState(0)
  const [requirement, setRequirement] = useState('')
  const [options, setOptions] = useState({/* existing defaults */})
  const [streamText, setStreamText] = useState('')
  const [cases, setCases] = useState([])
  const [generating, setGenerating] = useState(false)

  async function handleGenerate() {
    setGenerating(true); setStreamText('')
    try {
      const rows = await generateTestCases({
        requirement, options,
        onToken: (_t, full) => setStreamText(full),
      })
      setCases(rows)
      notify.success(`Generated ${rows.length} test cases`)
      setStep(3) // → Review
    } catch (e) {
      notify.error(`Generation failed: ${e.message}`)
    } finally { setGenerating(false) }
  }

  const steps = [
    { key: 'input', label: 'Input', canAdvance: requirement.trim().length > 0,
      content: /* RequirementInput wired to requirement/setRequirement */ },
    { key: 'configure', label: 'Configure', content: /* options controls */ },
    { key: 'generate', label: 'Generate',
      content: (
        <>
          {!generating && !streamText && /* MUI Button onClick={handleGenerate} */ }
          <GenerationProgress streamText={streamText || null} onRetry={handleGenerate} />
        </>
      ) },
    { key: 'review', label: 'Review',
      content: <DataGrid rows={cases} columns={buildColumns()} autoHeight
        getRowId={(r) => r.id ?? `${r.title}-${r.step ?? ''}`} disableRowSelectionOnClick /> },
    { key: 'export', label: 'Export', content: /* ExportControls + JiraDefectButton, MUI-styled */ },
  ]

  return <ToolWorkflow title="Test Case Generator" steps={steps} activeStep={step} onStepChange={setStep} />
}
```

`buildColumns()` derives DataGrid columns from the existing table columns; make secondary columns responsive with `flex` + `minWidth` and hide low-priority ones below `md` via the DataGrid `columnVisibilityModel` keyed off `useMediaQuery`.

- [ ] **Step 4: Delete the page's old layout markup and any inline `<style>` block.** Keep every service call, export handler, and JIRA wiring.

- [ ] **Step 5: Parity check against the live page** (dev server + backend + a valid login):
  - Enter a requirement → Next enabled only when non-empty
  - Generate: tokens visibly stream; failure path (stop the backend mid-run) shows error + Retry
  - Review: rows render, editable behaviors from the old table preserved (if the old table supported inline edit, use DataGrid `editable: true` columns and wire `processRowUpdate` to state)
  - Export: Excel/CSV/JSON downloads identical in shape to before; JIRA button works when `JIRA_ENABLED`
  - Responsive at 375/768/1440; keyboard-only pass (tab through stepper, table, buttons)

- [ ] **Step 6: Run the full suite** — `npx vitest run` → green.

- [ ] **Step 7: Commit**

```bash
git add src/pages/ src/services/testCaseGeneration.js
git commit -m "feat: migrate Test Case Generator to ToolWorkflow with streamed generation and DataGrid review"
```

---

### Task 13: Pilot page 2 — Test Plan Generator

**Files:**
- Modify: `src/pages/TestPlanGenerator.jsx`, `src/services/testPlan.js` (name per `src/services/` — verify)

Same recipe as Task 12; differences only:

- [ ] **Step 1: Read the page.** Note it exports DOCX client-side via `html-docx-js-typescript` — that stays.
- [ ] **Step 2: Service to `streamLLM`** with `onToken`, keeping existing plan-assembly/parsing on the full text.
- [ ] **Step 3: Steps mapping:** Input (project/scope details form → MUI `TextField`/`Select` in a `Grid`), Generate (streamed — a test *plan* is long-form text, so the streaming pane is the star here), Review (rendered plan in a `Paper`, editable sections if the old page allowed edits), Export (DOCX download button + copy-to-clipboard).
- [ ] **Step 4: Parity checklist** as Task 12 Step 5 (DOCX opens in Word, all sections present).
- [ ] **Step 5: Full suite green, then commit:**

```bash
git add src/pages/TestPlanGenerator.jsx src/services/
git commit -m "feat: migrate Test Plan Generator to ToolWorkflow with streamed long-form generation"
```

---

### Task 14: E2E smoke (Playwright) + wrap-up

**Files:**
- Create: `e2e/pilot-tools.spec.js`, `playwright.config.js` (e2e project — the repo has Playwright installed already for its own tooling)
- Modify: `package.json` (script `"test:e2e": "playwright test"`), `CLAUDE.md` (coordinate with the IntelliJ agent's edits — append, don't rewrite)

- [ ] **Step 1: Create `playwright.config.js`**

```js
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173' },
  webServer: process.env.E2E_NO_SERVER ? undefined : {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
})
```

- [ ] **Step 2: Write `e2e/pilot-tools.spec.js`** — auth via a real dev-realm login is environment-dependent, so gate on env:

```js
import { test, expect } from '@playwright/test'

// Requires: backend + Keycloak dev stack up, E2E_USER/E2E_PASS set for the dev realm.
const user = process.env.E2E_USER
test.skip(!user, 'E2E_USER not set — skipping authenticated e2e')

test('test case generator wizard end-to-end', async ({ page }) => {
  await page.goto('/')
  // Keycloak login form
  await page.fill('#username', user)
  await page.fill('#password', process.env.E2E_PASS)
  await page.click('#kc-login')
  await page.goto('/test-generator')
  await page.getByRole('textbox').first().fill('User can reset password via email link')
  await page.getByRole('button', { name: /next/i }).click()
  await page.getByRole('button', { name: /next/i }).click()          // configure → generate
  await page.getByRole('button', { name: /generate/i }).click()
  await expect(page.getByRole('grid')).toBeVisible({ timeout: 180_000 }) // review table appears
})
```

- [ ] **Step 3: Run it against the local stack** (`docker-compose.security.yml` up, backend running, dev creds): `E2E_USER=... E2E_PASS=... npx playwright test`. Expected: 1 passed (or skipped cleanly when creds unset).

- [ ] **Step 4: Append a short "UI architecture (Phase 1)" note to `CLAUDE.md`** documenting: `getTheme`, `NotificationProvider/useNotify`, `ToolWorkflow` props contract, `subscribeToJob`, `streamLLM`, job store + `/api/events/:jobId`, and the rule that new/migrated pages must use these primitives. **Read the file first and append a section — the IntelliJ agent has uncommitted edits to this file; if `git status` shows it dirty, coordinate: commit only your appended hunk via `git add -p` or ask the user.**

- [ ] **Step 5: Full check** — `npx vitest run && npm run build && npm run lint`. Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add e2e/ playwright.config.js package.json
git commit -m "test: e2e smoke for pilot wizard flow + Phase 1 architecture docs"
```

---

## Definition of Done (Phase 1 + 1.5)

- [ ] All vitest suites green; `npm run build` and `npm run lint` clean
- [ ] Shell responsive at 375/768/1024/1440 with no horizontal scroll
- [ ] Two pilot tools fully on `ToolWorkflow` with feature parity (exports, JIRA, editing)
- [ ] LLM generation streams visibly; zero direct browser→LLM calls remain in the two migrated services
- [ ] Jobs persisted in Postgres; SSE endpoint authenticated, replays state on reconnect
- [ ] Unmigrated pages still function unchanged (coexistence verified by clicking through 3 random tools)

## Out of scope (later plans)

Remaining 13 page migrations (Phase 2); converting the four polling tools (TestRunner, scanners) to the job store + SSE (Phase 2, needs their inline endpoints refactored); Entra federation (Phase 3); global auth/CORS/health/PORT (Phase 4); K8s manifests + pipeline (Phase 5).
