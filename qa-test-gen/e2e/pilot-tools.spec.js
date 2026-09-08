import { test, expect } from '@playwright/test'

// Authenticated E2E smoke for the Phase 1 pilot wizard (Test Case Generator).
//
// This suite talks to a real dev-realm Keycloak login and a real backend, so
// it is entirely environment-gated: it only runs when E2E_USER AND E2E_PASS
// are both set, which in practice means "someone stood up the local
// docker-compose.security.yml stack (Keycloak + backend + Postgres) and
// pointed E2E_BASE_URL at a running `npm run dev`". CI/local runs without
// that stack just see "1 skipped" — and (per playwright.config.js) don't
// even boot the Vite dev server for it.
//
// Preconditions the environment must satisfy:
//   1. Keycloak (realm `aaseya-platform`) reachable and seeded with a user
//      matching E2E_USER / E2E_PASS.
//   2. The Express backend (npm run server) and Postgres are up so
//      /api/projects and the LLM proxy respond.
//   3. THE E2E USER MUST ALREADY HAVE AT LEAST ONE PROJECT.
//      Every feature route (including /test-generator) is wrapped in
//      <RequireProject> (src/components/common/RequireProject.jsx): once the
//      project list finishes loading, a user with zero projects is redirected
//      to /services instead of rendering the tool. ProjectContext
//      (src/context/ProjectContext.jsx) auto-selects the first project
//      returned by GET /api/projects — it does not create one. Driving
//      project creation through the UI here would make this test brittle
//      (it depends on whatever "New Project" form exists on /services, which
//      Phase 1 didn't touch), so instead this test documents the precondition
//      and asserts on it directly: it waits for RequireProject's loading
//      spinner to clear, then asserts the URL actually landed on
//      /test-generator (rather than being bounced to /services). A
//      project-less E2E_USER fails this assertion with a clear message
//      instead of the test passing vacuously. Seed a project via
//      `POST /api/projects` (or the UI) for E2E_USER before running this
//      suite.
const user = process.env.E2E_USER
const pass = process.env.E2E_PASS
test.skip(!user || !pass, 'E2E_USER/E2E_PASS not set — skipping authenticated e2e (see file header for required env + preconditions)')

test('test case generator wizard end-to-end', async ({ page }) => {
  await page.goto('/')

  // Keycloak's hosted login form (standard field ids across realms).
  await page.fill('#username', user)
  await page.fill('#password', pass)
  await page.click('#kc-login')

  // The OIDC code+PKCE flow bounces through /auth/callback before
  // react-oidc-context finishes hydrating the user — navigating immediately
  // races that redirect. Wait for the callback route to resolve, then for a
  // stable authenticated-only landmark (Header's account IconButton,
  // aria-label="account" — src/components/common/Header.jsx) so we know the
  // app shell has actually recognized the session before driving any routes.
  await page.waitForURL((url) => !url.pathname.includes('auth/callback'), { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'account' })).toBeVisible({ timeout: 30_000 })

  await page.goto('/test-generator')

  // Precondition check: RequireProject holds the route on a loading spinner
  // ("Loading project context…") while the project list fetches, then either
  // renders the tool or redirects a project-less user to /services. Wait for
  // the spinner to clear before asserting the URL, otherwise the assertion
  // below would trivially pass while the redirect is still in flight.
  await expect(page.getByText(/loading project context/i)).toHaveCount(0, { timeout: 15_000 })
  await expect(page).toHaveURL(/test-generator/)

  // Step 1: Input — RequirementInput renders a plain textarea for the
  // manual-entry tab (default source), no accessible name beyond role=textbox.
  await page.getByRole('textbox').first().fill('User can reset password via email link')
  await page.getByRole('button', { name: /next/i }).click()

  // Step 2: Generate — kicks off the LLM stream (GenerationProgress renders
  // the streamed text; completion flips the wizard to Review automatically
  // per handleGenerate in src/pages/TestGenerator.jsx).
  await page.getByRole('button', { name: /generate test cases/i }).click()

  // Step 3: Review — the generated-cases DataGrid appears once the LLM
  // stream resolves. LLM latency is env-dependent, hence the long timeout.
  await expect(page.getByRole('grid')).toBeVisible({ timeout: 180_000 })
})
