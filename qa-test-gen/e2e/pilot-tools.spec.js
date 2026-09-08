import { test, expect } from '@playwright/test'

// Authenticated E2E smoke for the Phase 1 pilot wizard (Test Case Generator).
//
// This suite talks to a real dev-realm Keycloak login and a real backend, so
// it is entirely environment-gated: it only runs when E2E_USER / E2E_PASS are
// set, which in practice means "someone stood up the local docker-compose.security.yml
// stack (Keycloak + backend + Postgres) and pointed E2E_BASE_URL at a running
// `npm run dev`". CI/local runs without that stack just see "1 skipped".
//
// Preconditions the environment must satisfy (not automated here — see below):
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
//      and asserts on it: seed a project via `POST /api/projects` (or the UI)
//      for E2E_USER before running this suite.
const user = process.env.E2E_USER
test.skip(!user, 'E2E_USER not set — skipping authenticated e2e (see file header for required env + preconditions)')

test('test case generator wizard end-to-end', async ({ page }) => {
  await page.goto('/')

  // Keycloak's hosted login form (standard field ids across realms).
  await page.fill('#username', user)
  await page.fill('#password', process.env.E2E_PASS)
  await page.click('#kc-login')

  // Precondition check: if the user has no project, RequireProject bounces
  // us to /services. Fail with a clear message rather than timing out
  // opaquely inside the wizard.
  await page.goto('/test-generator')
  await expect(page).not.toHaveURL(/\/services$/, {
    timeout: 10_000,
  })

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
