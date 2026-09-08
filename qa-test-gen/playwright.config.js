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
