console.log("------------------ SERVER RESTART: NEW CODE LOADED ------------------");
import multer from 'multer';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { LocalLLM as GoogleGenerativeAI } from './utils/llmClient.js';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { XMLParser } from 'fast-xml-parser';
import crypto from 'crypto';
const require = createRequire(import.meta.url);

// ─── AI Secure Engine imports ────────────────────────────
import { initDatabase, AccessibilityResult, LocalizationResult, AutomationResult, PerformanceResult } from './models/index.js';
import projectRoutes from './routes/projectRoutes.js';
import scanRoutes from './routes/scanRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import governanceRoutes from './routes/governanceRoutes.js';
import jiraRoutes from './routes/jiraRoutes.js';
import readinessRoutes from './routes/readinessRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import { calculateAndSaveReadiness } from './services/readinessService.js';
import { parseSpec } from './services/apiSpecService.js';
import { generateApiTestCases } from './services/apiTestGenService.js';
import { generateFlows } from './services/apiFlowGenService.js';
import { emitRestAssured } from './services/emitters/restAssuredEmitter.js';
import { emitPlaywright } from './services/emitters/playwrightApiEmitter.js';
import { emitPlaywrightFlows } from './services/emitters/playwrightFlowEmitter.js';
import { emitK6 } from './services/emitters/k6Emitter.js';
import { validateHttpUrl } from './middleware/urlValidator.js';
import { securityRateLimiter } from './middleware/rateLimiter.js';
import { generateWithRetry } from './utils/aiUtils.js';

import express from 'express';
import { chromium, firefox, webkit } from 'playwright';
import cors from 'cors';

const getBrowserLauncher = (type) => {
    switch (type?.toLowerCase()) {
        case 'firefox': return firefox;
        case 'webkit': return webkit;
        case 'chromium':
        default: return chromium;
    }
};

const app = express();
const PORT = 3001;

// Keep the server alive on stray async errors. A single hung/failed LLM call or
// a late promise rejection must never take the whole backend down mid-session —
// otherwise the next request hits a dead process and the dev proxy returns a
// bare 500. Log loudly instead of crashing.
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.message ? err.message : err);
});
// Increase payload size limit for zip uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

app.get('/api/debug/browsers', (req, res) => {
    try {
        const files = fs.existsSync('/ms-playwright') ? fs.readdirSync('/ms-playwright') : [];
        const safeEnv = { ...process.env };
        for (const key of Object.keys(safeEnv)) {
            if (key.toLowerCase().includes('key') || key.toLowerCase().includes('password') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('token')) {
                safeEnv[key] = '[REDACTED]';
            }
        }
        res.json({ files, env: safeEnv });
    } catch (err) {
        res.json({ error: err.message, env: {} });
    }
});

// Configure Multer for temp uploads
const upload = multer({ dest: 'temp_uploads/' });

// ... existing interactive browser variables ...
let activeBrowser = null;
let activeContext = null;
let activePage = null;

// ... existing endpoints ...

// --- MIGRATION SERVICE ---

// Helper to recursively find files
function getFiles(dir, files = []) {
    const fileList = fs.readdirSync(dir);
    for (const file of fileList) {
        const name = `${dir}/${file}`;
        if (fs.statSync(name).isDirectory()) {
            getFiles(name, files);
        } else {
            files.push(name);
        }
    }
    return files;
}

// Migration scaffolding: the LLM converts source files but never emits a runnable
// project shell. Without these helpers, the resulting zip has no package.json /
// playwright.config.js / cypress.config.js, so Test Runner's detectFramework()
// rejects it as 'unknown'. We remap each converted file into the target
// framework's test directory (with the right .spec/.cy extension) and write a
// minimal but complete scaffold so the zip is detectable AND runnable after
// `npm install`.
function remapMigratedPath(relativePath, targetFramework) {
    const parts = relativePath.split(/[\\/]/);
    // Strip common Maven/Java layout prefixes so we don't end up with
    // tests/src/test/java/... nesting in the output.
    const stripPrefixes = [
        ['src', 'test', 'java'], ['src', 'main', 'java'],
        ['src', 'test'], ['src', 'main'], ['src'],
    ];
    for (const prefix of stripPrefixes) {
        if (parts.length > prefix.length && prefix.every((p, i) => parts[i] === p)) {
            parts.splice(0, prefix.length);
            break;
        }
    }
    const fileName = parts.pop();
    const base = fileName.replace(/\.(java|py|cs|js|ts|jsx|tsx)$/i, '');
    if (targetFramework === 'Cypress') {
        return path.join('cypress', 'e2e', ...parts, `${base}.cy.js`);
    }
    // Default: Playwright
    return path.join('tests', ...parts, `${base}.spec.js`);
}

function scaffoldMigratedProject(outputPath, targetFramework) {
    if (targetFramework === 'Cypress') {
        const pkg = {
            name: 'migrated-cypress-suite',
            version: '1.0.0',
            scripts: { test: 'cypress run', 'cy:open': 'cypress open' },
            devDependencies: { cypress: '^13.6.0' },
        };
        fs.writeFileSync(path.join(outputPath, 'package.json'), JSON.stringify(pkg, null, 2));
        fs.writeFileSync(path.join(outputPath, 'cypress.config.js'),
            `const { defineConfig } = require('cypress');\n\nmodule.exports = defineConfig({\n  e2e: {\n    baseUrl: 'http://localhost:3000',\n    specPattern: 'cypress/e2e/**/*.cy.{js,ts}',\n    setupNodeEvents() {},\n  },\n});\n`);
        return;
    }
    // Default: Playwright (JavaScript)
    const pkg = {
        name: 'migrated-playwright-suite',
        version: '1.0.0',
        scripts: {
            test: 'playwright test',
            'test:headed': 'playwright test --headed',
            'test:debug': 'playwright test --debug',
            postinstall: 'playwright install',
        },
        devDependencies: { '@playwright/test': '^1.58.0' },
    };
    fs.writeFileSync(path.join(outputPath, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(outputPath, 'playwright.config.js'),
        `const { defineConfig, devices } = require('@playwright/test');\n\nmodule.exports = defineConfig({\n  testDir: './tests',\n  fullyParallel: true,\n  retries: 0,\n  reporter: 'html',\n  use: {\n    baseURL: 'http://localhost:3000',\n    trace: 'on-first-retry',\n    screenshot: 'only-on-failure',\n  },\n  projects: [\n    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },\n  ],\n});\n`);
}

app.post('/api/convert', upload.single('projectZip'), async (req, res) => {
    const targetFramework = req.body.targetFramework || 'Playwright';
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return res.status(401).json({ error: 'API Key missing in headers' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No zip file uploaded' });
    }

    const extractionPath = path.join('temp_extract', Date.now().toString());
    const outputPath = path.join('temp_output', Date.now().toString());

    try {
        // 1. Unzip
        const zip = new AdmZip(req.file.path);
        zip.extractAllTo(extractionPath, true);

        // 2. Scan files
        const allFiles = getFiles(extractionPath);
        const sourceFiles = allFiles.filter(f => {
            const lower = f.toLowerCase();
            return (
                !lower.includes('/target/') &&
                !lower.includes('\\target\\') &&
                !lower.includes('/bin/') &&
                !lower.includes('\\bin\\') &&
                !lower.includes('/obj/') &&
                !lower.includes('/node_modules/') &&
                !lower.includes('/.git/') &&
                !lower.includes('/test-output/') &&
                !lower.includes('/reports/') &&
                (f.endsWith('.java') || f.endsWith('.py') || f.endsWith('.cs') || f.endsWith('.js') || f.endsWith('.ts'))
            );
        });

        if (sourceFiles.length === 0) {
            throw new Error("No valid source files (.java, .py, .cs, .js, .ts) found in zip.");
        }

        // 3. Initialize AI (Using Local LLM)
        const genAI = new GoogleGenerativeAI(apiKey, process.env.VITE_LLM_ENDPOINT);
        const model = genAI.getGenerativeModel({ 
            model: process.env.VITE_LLM_MODEL || "gemma-4",
            generationConfig: { temperature: 0.2 }
        });

        // 4. Convert Loop
        fs.mkdirSync(outputPath, { recursive: true });

        for (const file of sourceFiles) {
            const content = fs.readFileSync(file, 'utf-8');
            const relativePath = path.relative(extractionPath, file);

            // Skip huge files
            if (content.length > 50000) continue;

            // Initial throttle to avoid hitting limit instantly
            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log(`Converting: ${relativePath}`);

            const langHint = targetFramework === 'Cypress'
                ? 'Cypress (JavaScript, CommonJS, using `describe`/`it`/`cy.*`)'
                : 'Playwright (JavaScript, ES modules, using `@playwright/test` — import `test` and `expect` from it)';
            const prompt = `
                You are a Test Migration Expert. Convert the following Selenium code to ${langHint}.
                File: ${relativePath}

                Rules:
                1. Keep the same test structure and assertions.
                2. Use modern ${targetFramework} patterns (Page Object Model if apparent in the source).
                3. The output file will be saved with a JavaScript extension — write valid JavaScript only, no Java/Python/C# syntax.
                4. Return ONLY the code. No markdown fences, no commentary.

                Content:
                ${content}
            `;

            const targetFile = path.join(outputPath, remapMigratedPath(relativePath, targetFramework));
            fs.mkdirSync(path.dirname(targetFile), { recursive: true });

            try {
                let text = await generateWithRetry(model, prompt);
                // Clean markdown fences if the LLM emits them anyway
                text = text.replace(/```[a-z]*\n?/g, '').replace(/```/g, '');
                fs.writeFileSync(targetFile, text);
            } catch (aiErr) {
                console.error(`Failed to convert ${relativePath}`, aiErr);
                fs.writeFileSync(targetFile, `// CONVERSION FAILED: ${aiErr.message}\n// Original source from: ${relativePath}\n/*\n${content}\n*/\n`);
            }
        }

        // 4b. Emit framework scaffold so the zip is runnable + detectable by Test Runner
        scaffoldMigratedProject(outputPath, targetFramework);

        // 5. Zip Output
        const outputZip = new AdmZip();
        outputZip.addLocalFolder(outputPath);
        const zipBuffer = outputZip.toBuffer();

        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename=converted_${targetFramework.toLowerCase()}.zip`);
        res.send(zipBuffer);

    } catch (e) {
        console.error("Conversion error:", e);
        res.status(500).json({ error: e.message });
    } finally {
        // Cleanup
        try {
            if (req.file) fs.unlinkSync(req.file.path);
            fs.rmSync(extractionPath, { recursive: true, force: true });
            fs.rmSync(outputPath, { recursive: true, force: true });
        } catch (cleanupErr) { console.error("Cleanup error", cleanupErr); }
    }
});

// --- FRAMEWORK GENERATOR SERVICE ---

app.post('/api/generate-framework', async (req, res) => {
    const { projectName, framework, language, features } = req.body;

    if (!projectName || !framework || !language) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const outputPath = path.join('temp_frameworks', `${projectName}_${Date.now()}`);

    try {
        console.log(`Generating ${framework} framework in ${language}...`);

        // Create folder structure
        // Create folder structure common to JS/TS
        fs.mkdirSync(outputPath, { recursive: true });

        // For non-Java projects, create standard JS/TS structure
        if (!(framework === 'Selenium' && language === 'Java')) {
            fs.mkdirSync(path.join(outputPath, 'src'), { recursive: true });
            fs.mkdirSync(path.join(outputPath, 'src', 'tests'), { recursive: true });
            fs.mkdirSync(path.join(outputPath, 'src', 'utils'), { recursive: true });

            if (features.pageObjectModel) {
                fs.mkdirSync(path.join(outputPath, 'src', 'pages'), { recursive: true });
            }
            if (features.reporting) {
                fs.mkdirSync(path.join(outputPath, 'reports'), { recursive: true });
            }
        } else {
            // Java projects need src created but subfolders are handled by generateSelenium
            fs.mkdirSync(path.join(outputPath, 'src'), { recursive: true });
        }

        // Generate files based on framework
        if (framework === 'Playwright' && language === 'TypeScript') {
            await generatePlaywrightTypeScript(outputPath, projectName, features);
        } else if (framework === 'Playwright' && language === 'JavaScript') {
            await generatePlaywrightJavaScript(outputPath, projectName, features);
        } else if (framework === 'Cypress') {
            await generateCypress(outputPath, projectName, features, language);
        } else if (framework === 'Selenium') {
            await generateSelenium(outputPath, projectName, features, language);
        }

        // Zip and send
        const zip = new AdmZip();
        zip.addLocalFolder(outputPath);
        const zipBuffer = zip.toBuffer();

        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename=${projectName}.zip`);
        res.send(zipBuffer);

    } catch (e) {
        console.error('Framework generation error:', e);
        res.status(500).json({ error: e.message });
    } finally {
        try {
            fs.rmSync(outputPath, { recursive: true, force: true });
        } catch (cleanupErr) { console.error('Cleanup error', cleanupErr); }
    }
});

// Framework generation helpers

// Write a generated file, creating any missing parent directories first. The
// per-framework generators assume their target subfolders already exist; this
// makes every write self-sufficient so a path the route didn't pre-create
// (e.g. root-level tests/, pages/, utils/) can't throw ENOENT.
function writeProjectFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

async function generatePlaywrightTypeScript(outputPath, projectName, features) {
    // package.json
    const packageJson = {
        name: projectName,
        version: '1.0.0',
        scripts: {
            test: 'playwright test',
            'test:headed': 'playwright test --headed',
            'test:debug': 'playwright test --debug',
            // Auto-download the browser binaries on `npm install` so the project
            // is runnable out of the box (otherwise tests fail with "Executable
            // doesn't exist" until `npx playwright install` is run manually).
            postinstall: 'playwright install',
            report: features.reporting === 'Allure' ? 'allure generate ./allure-results --clean && allure open' : 'playwright show-report'
        },
        devDependencies: {
            '@playwright/test': '^1.40.0',
            'typescript': '^5.0.0',
            ...(features.reporting === 'Allure' && { 'allure-playwright': '^2.15.0', 'allure-commandline': '^2.25.0' }),
            ...(features.logging && { 'winston': '^3.11.0' })
        }
    };
    writeProjectFile(path.join(outputPath, 'package.json'), JSON.stringify(packageJson, null, 2));

    // playwright.config.ts
    const playwrightConfig = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: ${features.parallel},
  workers: ${features.parallel ? 'process.env.CI ? 1 : undefined' : '1'},
  reporter: [
    ['html'],
    ${features.reporting === 'Allure' ? "['allure-playwright']," : ''}
  ],
  use: {
    baseURL: 'https://www.saucedemo.com',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});`;
    writeProjectFile(path.join(outputPath, 'playwright.config.ts'), playwrightConfig);

    // tsconfig.json
    const tsConfig = {
        compilerOptions: {
            target: 'ES2020',
            module: 'commonjs',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true
        }
    };
    writeProjectFile(path.join(outputPath, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));

    // Base Page (if POM enabled)
    if (features.pageObjectModel) {
        const basePage = `import { Page } from '@playwright/test';
${features.logging ? "import { logger } from '../utils/logger';" : ''}

export class BasePage {
  constructor(protected page: Page) {}

  async navigate(url: string) {
    ${features.logging ? "logger.info(`Navigating to ${url}`);" : ''}
    await this.page.goto(url);
  }

  async waitForPageLoad() {
    await this.page.waitForLoadState('networkidle');
  }
}`;
        writeProjectFile(path.join(outputPath, 'pages', 'BasePage.ts'), basePage);

        const loginPage = `import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class LoginPage extends BasePage {
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;

  constructor(page: Page) {
    super(page);
    this.usernameInput = page.locator('[data-test="username"]');
    this.passwordInput = page.locator('[data-test="password"]');
    this.loginButton = page.locator('[data-test="login-button"]');
  }

  async login(username: string, password: string) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }
}`;
        writeProjectFile(path.join(outputPath, 'pages', 'LoginPage.ts'), loginPage);
    }

    // Logger utility
    if (features.logging) {
        const logger = `import winston from 'winston';

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return \`[\${timestamp}] \${level.toUpperCase()}: \${message}\`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/test.log' })
  ]
});`;
        writeProjectFile(path.join(outputPath, 'utils', 'logger.ts'), logger);
        fs.mkdirSync(path.join(outputPath, 'logs'), { recursive: true });
    }

    const sampleTest = `import { test, expect } from '@playwright/test';
${features.pageObjectModel ? "import { LoginPage } from '../pages/LoginPage';" : ''}
${features.logging ? "import { logger } from '../utils/logger';" : ''}

test.describe('Login Tests', () => {
  test('should login successfully', async ({ page }) => {
    ${features.logging ? "logger.info('Starting login test');" : ''}
    ${features.pageObjectModel ? `
    const loginPage = new LoginPage(page);
    await loginPage.navigate('/');
    await loginPage.login('standard_user', 'secret_sauce');
    ` : `
    await page.goto('/');
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();
    `}
    await expect(page).toHaveURL(/.*inventory.html/);
    ${features.logging ? "logger.info('Login test completed');" : ''}
  });
});`;
    writeProjectFile(path.join(outputPath, 'tests', 'login.spec.ts'), sampleTest);

    // API Test
    if (features.apiTesting) {
        fs.mkdirSync(path.join(outputPath, 'tests', 'api'), { recursive: true });
        const apiTestTs = `import { test, expect } from '@playwright/test';

test.describe('User API Tests', () => {
  const baseUrl = 'https://jsonplaceholder.typicode.com';

  test('should fetch user list', async ({ request }) => {
    const response = await request.get(\`\${baseUrl}/users\`);
    expect(response.ok()).toBeTruthy();
    
    const responseBody = await response.json();
    expect(responseBody.length).toBeGreaterThan(0);
    expect(responseBody[0]).toHaveProperty('email');
  });

  test('should create a new user', async ({ request }) => {
    const response = await request.post(\`\${baseUrl}/users\`, {
      data: { name: 'morpheus', username: 'leader' }
    });
    expect(response.status()).toBe(201);
    
    const responseBody = await response.json();
    expect(responseBody.name).toBe('morpheus');
  });
});`;
        writeProjectFile(path.join(outputPath, 'tests', 'api', 'users.spec.ts'), apiTestTs);
    }

    // CI/CD
    if (features.cicd === 'GitHub Actions') {
        fs.mkdirSync(path.join(outputPath, '.github', 'workflows'), { recursive: true });
        const githubActions = `name: Playwright Tests
on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - name: Install dependencies
        run: npm ci
      - name: Install Playwright Browsers
        run: npx playwright install --with-deps
      - name: Run Playwright tests
        run: npm test
      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: playwright-report
        path: playwright-report/
        retention-days: 30`;
        writeProjectFile(path.join(outputPath, '.github', 'workflows', 'test.yml'), githubActions);
    }

    // Dockerfile
    if (features.docker) {
        const dockerfile = `FROM mcr.microsoft.com/playwright:v1.40.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "test"]`;
        writeProjectFile(path.join(outputPath, 'Dockerfile'), dockerfile);
    }

    // README
    const readme = `# ${projectName}

Enterprise-grade Playwright test automation framework

## Features
${features.pageObjectModel ? '- ✅ Page Object Model' : ''}
${features.reporting ? `- ✅ ${features.reporting} Reporting` : ''}
${features.logging ? '- ✅ Winston Logging' : ''}
${features.cicd !== 'None' ? `- ✅ ${features.cicd} CI/CD` : ''}
${features.docker ? '- ✅ Docker Support' : ''}
${features.parallel ? '- ✅ Parallel Execution' : ''}

## Setup
\`\`\`bash
npm install
npx playwright install
\`\`\`

## Run Tests
\`\`\`bash
npm test
\`\`\`

${features.reporting === 'Allure' ? `## View Reports
\`\`\`bash
npm run report
\`\`\`` : ''}
`;
    writeProjectFile(path.join(outputPath, 'README.md'), readme);
}

async function generatePlaywrightJavaScript(outputPath, projectName, features) {
    const packageJson = {
        name: projectName,
        version: '1.0.0',
        scripts: {
            test: 'playwright test',
            'test:headed': 'playwright test --headed',
            'test:debug': 'playwright test --debug',
            // Auto-download the browser binaries on `npm install` so the project
            // is runnable out of the box (otherwise tests fail with "Executable
            // doesn't exist" until `npx playwright install` is run manually).
            postinstall: 'playwright install',
            report: features.reporting === 'Allure' ? 'allure generate ./allure-results --clean && allure open' : 'playwright show-report'
        },
        devDependencies: {
            '@playwright/test': '^1.40.0',
            ...(features.reporting === 'Allure' && { 'allure-playwright': '^2.15.0', 'allure-commandline': '^2.25.0' }),
            ...(features.logging && { 'winston': '^3.11.0' })
        }
    };
    writeProjectFile(path.join(outputPath, 'package.json'), JSON.stringify(packageJson, null, 2));

    const playwrightConfig = `const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: ${features.parallel},
  workers: ${features.parallel ? 'process.env.CI ? 1 : undefined' : '1'},
  reporter: [
    ['html'],
    ${features.reporting === 'Allure' ? "['allure-playwright']," : ''}
  ],
  use: {
    baseURL: 'https://www.saucedemo.com',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});`;
    writeProjectFile(path.join(outputPath, 'playwright.config.js'), playwrightConfig);

    if (features.pageObjectModel) {
        const basePage = `class BasePage {
  constructor(page) {
    this.page = page;
  }
  async navigate(url) {
    await this.page.goto(url);
  }
  async waitForPageLoad() {
    await this.page.waitForLoadState('networkidle');
  }
}
module.exports = { BasePage };`;
        writeProjectFile(path.join(outputPath, 'pages', 'BasePage.js'), basePage);

        const loginPage = `const { BasePage } = require('./BasePage');
class LoginPage extends BasePage {
  constructor(page) {
    super(page);
    this.usernameInput = page.locator('[data-test="username"]');
    this.passwordInput = page.locator('[data-test="password"]');
    this.loginButton = page.locator('[data-test="login-button"]');
  }
  async login(username, password) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }
}
module.exports = { LoginPage };`;
        writeProjectFile(path.join(outputPath, 'pages', 'LoginPage.js'), loginPage);
    }

    const sampleTest = `const { test, expect } = require('@playwright/test');
${features.pageObjectModel ? "const { LoginPage } = require('../pages/LoginPage');" : ''}

test.describe('Login Tests', () => {
  test('should login successfully', async ({ page }) => {
    ${features.pageObjectModel ? `const loginPage = new LoginPage(page);
    await loginPage.navigate('/');
    await loginPage.login('standard_user', 'secret_sauce');` : `await page.goto('/');
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();`}
    await expect(page).toHaveURL(/.*inventory.html/);
  });
});`;
    writeProjectFile(path.join(outputPath, 'tests', 'login.spec.js'), sampleTest);

    // API Test
    if (features.apiTesting) {
        fs.mkdirSync(path.join(outputPath, 'tests', 'api'), { recursive: true });
        const apiTestJs = `const { test, expect } = require('@playwright/test');

test.describe('User API Tests', () => {
  const baseUrl = 'https://jsonplaceholder.typicode.com';

  test('should fetch user list', async ({ request }) => {
    const response = await request.get(\`\${baseUrl}/users\`);
    expect(response.ok()).toBeTruthy();
    
    const responseBody = await response.json();
    expect(responseBody.length).toBeGreaterThan(0);
    expect(responseBody[0]).toHaveProperty('email');
  });

  test('should create a new user', async ({ request }) => {
    const response = await request.post(\`\${baseUrl}/users\`, {
      data: { name: 'morpheus', username: 'leader' }
    });
    expect(response.status()).toBe(201);
    
    const responseBody = await response.json();
    expect(responseBody.name).toBe('morpheus');
  });
});`;
        writeProjectFile(path.join(outputPath, 'tests', 'api', 'users.spec.js'), apiTestJs);
    }

    const readme = `# ${projectName}\n\nPlaywright JavaScript Framework\n\n## Setup\n\`\`\`bash\nnpm install\nnpx playwright install\n\`\`\`\n\n## Run Tests\n\`\`\`bash\nnpm test\n\`\`\``;
    writeProjectFile(path.join(outputPath, 'README.md'), readme);
}

async function generateCypress(outputPath, projectName, features, language) {
    const packageJson = {
        name: projectName,
        version: '1.0.0',
        scripts: {
            'cy:open': 'cypress open',
            'cy:run': 'cypress run'
        },
        devDependencies: {
            'cypress': '^13.0.0',
            ...(language === 'TypeScript' && { 'typescript': '^5.0.0' })
        }
    };
    writeProjectFile(path.join(outputPath, 'package.json'), JSON.stringify(packageJson, null, 2));

    const cypressConfig = `const { defineConfig } = require("cypress");

module.exports = defineConfig({
  e2e: {
    baseUrl: 'https://www.saucedemo.com',
    setupNodeEvents(on, config) {
      // implement node event listeners here
    },
  },
});`;
    writeProjectFile(path.join(outputPath, 'cypress.config.js'), cypressConfig);

    fs.mkdirSync(path.join(outputPath, 'cypress', 'e2e'), { recursive: true });

    const ext = language === 'TypeScript' ? 'ts' : 'js';
    const sampleTest = `describe('Login Tests', () => {
  it('should login successfully', () => {
    cy.visit('/');
    cy.get('[data-test="username"]').type('standard_user');
    cy.get('[data-test="password"]').type('secret_sauce');
    cy.get('[data-test="login-button"]').click();
    cy.url().should('include', 'inventory.html');
  });
});`;
    writeProjectFile(path.join(outputPath, 'cypress', 'e2e', `login.cy.${ext}`), sampleTest);

    if (features.apiTesting) {
        fs.mkdirSync(path.join(outputPath, 'cypress', 'e2e', 'api'), { recursive: true });
        const apiTestCypress = `describe('User API Tests', () => {
  const baseUrl = 'https://jsonplaceholder.typicode.com';

  it('should fetch user list', () => {
    cy.request('GET', \`\${baseUrl}/users\`).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.length).to.be.greaterThan(0);
      expect(response.body[0]).to.have.property('email');
    });
  });

  it('should create a new user', () => {
    cy.request('POST', \`\${baseUrl}/users\`, {
      name: 'morpheus',
      username: 'leader'
    }).then((response) => {
      expect(response.status).to.eq(201);
      expect(response.body).to.have.property('name', 'morpheus');
    });
  });
});`;
        writeProjectFile(path.join(outputPath, 'cypress', 'e2e', 'api', `users.cy.${ext}`), apiTestCypress);
    }

    const readme = `# ${projectName}\n\nCypress ${language} Framework\n\n## Setup\n\`\`\`bash\nnpm install\n\`\`\`\n\n## Run Tests\n\`\`\`bash\nnpm run cy:run\n\`\`\``;
    writeProjectFile(path.join(outputPath, 'README.md'), readme);
}

async function generateSelenium(outputPath, projectName, features, language) {
    console.log(`DEBUG: generateSelenium called with language=${language}`);
    console.log(`DEBUG: features=${JSON.stringify(features)}`);
    const isCucumber = features.cucumber === true;
    console.log(`DEBUG: isCucumber flag: ${isCucumber}`);

    // Sanitize project name for package usage (remove dashes, lowercase)
    const packageName = projectName.replace(/-/g, '').toLowerCase();
    console.log(`DEBUG: packageName used: ${packageName}`);
    const groupId = 'com.test';

    // 1. Create Folder Structure
    const mainJavaPath = path.join(outputPath, 'src', 'main', 'java', 'com', 'test', packageName);
    const testJavaPath = path.join(outputPath, 'src', 'test', 'java', 'com', 'test', packageName);
    const mainResourcesPath = path.join(outputPath, 'src', 'main', 'resources');
    const testResourcesPath = path.join(outputPath, 'src', 'test', 'resources');

    // Main Java subfolders
    fs.mkdirSync(path.join(mainJavaPath, 'pages'), { recursive: true });
    fs.mkdirSync(path.join(mainJavaPath, 'utils'), { recursive: true });
    fs.mkdirSync(path.join(mainJavaPath, 'constants'), { recursive: true });
    fs.mkdirSync(path.join(mainJavaPath, 'listeners'), { recursive: true });

    // Test Java subfolders
    fs.mkdirSync(path.join(testJavaPath, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(testJavaPath, 'runners'), { recursive: true });
    fs.mkdirSync(path.join(testJavaPath, 'stepdefinitions'), { recursive: true });

    // Resources
    fs.mkdirSync(mainResourcesPath, { recursive: true });
    fs.mkdirSync(testResourcesPath, { recursive: true });
    fs.mkdirSync(path.join(testResourcesPath, 'features'), { recursive: true });

    // GitHub Workflows
    fs.mkdirSync(path.join(outputPath, '.github', 'workflows'), { recursive: true });

    // 2. config.properties
    const configProperties = `base.url=https://www.saucedemo.com
browser=chrome
headless=true
implicit.wait=10
explicit.wait=10`;
    writeProjectFile(path.join(mainResourcesPath, 'config.properties'), configProperties);

    // 3. testdata.json
    const testData = `[
  {
    "username": "testuser",
    "password": "password123",
    "expectedTitle": "Dashboard"
  }
]`;
    writeProjectFile(path.join(mainResourcesPath, 'testdata.json'), testData);

    // 4. log4j2.xml
    const log4j2Xml = `<?xml version="1.0" encoding="UTF-8"?>
<Configuration status="WARN">
    <Appenders>
        <Console name="Console" target="SYSTEM_OUT">
            <PatternLayout pattern="%d{HH:mm:ss.SSS} [%t] %-5level %logger{36} - %msg%n"/>
        </Console>
    </Appenders>
    <Loggers>
        <Root level="info">
            <AppenderRef ref="Console"/>
        </Root>
    </Loggers>
</Configuration>`;
    writeProjectFile(path.join(mainResourcesPath, 'log4j2.xml'), log4j2Xml);

    // 5. testng.xml
    const testngXml = isCucumber ?
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">
<suite name="Cucumber Suite" parallel="methods" thread-count="2">
    <test name="Cucumber Tests">
        <classes>
            <class name="${groupId}.${packageName}.runners.CucumberTestRunner"/>
        </classes>
    </test>
</suite>` :
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">
<suite name="Automation Suite" parallel="methods" thread-count="2">
    <test name="UI Tests">
        <classes>
            <class name="${groupId}.${packageName}.tests.LoginTest"/>
        </classes>
    </test>${features.apiTesting ? `
    <test name="API Tests">
        <classes>
            <class name="${groupId}.${packageName}.api.UsersApiTest"/>
        </classes>
    </test>` : ''}
</suite>`;
    writeProjectFile(path.join(testResourcesPath, 'testng.xml'), testngXml);

    // 6. GitHub Actions (test.yml)
    const githubActions = `name: Java CI with Maven
on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - name: Set up JDK 17
      uses: actions/setup-java@v3
      with:
        java-version: '17'
        distribution: 'temurin'
        cache: 'maven'
    - name: Run Tests
      run: mvn test`;
    writeProjectFile(path.join(outputPath, '.github', 'workflows', 'test.yml'), githubActions);

    // 7. Dockerfile
    const dockerfile = `FROM maven:3.9.6-eclipse-temurin-17
WORKDIR /app
COPY . .
RUN mvn dependency:go-offline
CMD ["mvn", "test"]`;
    writeProjectFile(path.join(outputPath, 'Dockerfile'), dockerfile);

    // 8. pom.xml (User Requested Template)
    const pomXml = `<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
         http://maven.apache.org/xsd/maven-4.0.0.xsd">

    <modelVersion>4.0.0</modelVersion>

    <groupId>com.test</groupId>
    <artifactId>${projectName}</artifactId>
    <version>1.0-SNAPSHOT</version>
    <packaging>jar</packaging>

    <name>Automation Test Framework</name>

    <!-- =======================
         PROPERTIES (Change Versions Here Only)
         ======================= -->
    <properties>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>

        <selenium.version>4.21.0</selenium.version>
        <testng.version>7.9.0</testng.version>
        <webdrivermanager.version>5.8.0</webdrivermanager.version>
        <log4j.version>2.22.1</log4j.version>
        <extent.version>5.1.1</extent.version>
        <restassured.version>5.4.0</restassured.version>
        <jackson.version>2.17.0</jackson.version>
        <cucumber.version>7.18.0</cucumber.version>
    </properties>

    <!-- =======================
         DEPENDENCIES
         ======================= -->
    <dependencies>

        <!-- Selenium -->
        <dependency>
            <groupId>org.seleniumhq.selenium</groupId>
            <artifactId>selenium-java</artifactId>
            <version>\${selenium.version}</version>
        </dependency>

        <!-- TestNG -->
        <dependency>
            <groupId>org.testng</groupId>
            <artifactId>testng</artifactId>
            <version>\${testng.version}</version>
            <scope>test</scope>
        </dependency>

        <!-- WebDriverManager -->
        <dependency>
            <groupId>io.github.bonigarcia</groupId>
            <artifactId>webdrivermanager</artifactId>
            <version>\${webdrivermanager.version}</version>
        </dependency>

        <!-- Log4j2 -->
        <dependency>
            <groupId>org.apache.logging.log4j</groupId>
            <artifactId>log4j-api</artifactId>
            <version>\${log4j.version}</version>
        </dependency>

        <dependency>
            <groupId>org.apache.logging.log4j</groupId>
            <artifactId>log4j-core</artifactId>
            <version>\${log4j.version}</version>
        </dependency>

        <!-- Extent Reports -->
        <dependency>
            <groupId>com.aventstack</groupId>
            <artifactId>extentreports</artifactId>
            <version>\${extent.version}</version>
        </dependency>

        <!-- REST Assured (Optional Hybrid API Testing) -->
        <dependency>
            <groupId>io.rest-assured</groupId>
            <artifactId>rest-assured</artifactId>
            <version>\${restassured.version}</version>
            <scope>test</scope>
        </dependency>

        <!-- Jackson (JSON Processing) -->
        <dependency>
            <groupId>com.fasterxml.jackson.core</groupId>
            <artifactId>jackson-databind</artifactId>
            <version>\${jackson.version}</version>
        </dependency>

        <!-- Cucumber -->
        <dependency>
            <groupId>io.cucumber</groupId>
            <artifactId>cucumber-java</artifactId>
            <version>\${cucumber.version}</version>
        </dependency>

        <dependency>
            <groupId>io.cucumber</groupId>
            <artifactId>cucumber-testng</artifactId>
            <version>\${cucumber.version}</version>
        </dependency>

    </dependencies>

    <!-- =======================
         BUILD PLUGINS
         ======================= -->
    <build>
        <plugins>

            <!-- Compiler Plugin -->
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-compiler-plugin</artifactId>
                <version>3.11.0</version>
                <configuration>
                    <source>\${maven.compiler.source}</source>
                    <target>\${maven.compiler.target}</target>
                </configuration>
            </plugin>

            <!-- Surefire Plugin (Test Execution) -->
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-surefire-plugin</artifactId>
                <version>3.2.5</version>
                <configuration>
                    <suiteXmlFiles>
                        <suiteXmlFile>src/test/resources/testng.xml</suiteXmlFile>
                    </suiteXmlFiles>

                    <!-- Parallel Execution Ready -->
                    <parallel>methods</parallel>
                    <threadCount>2</threadCount>

                    <useSystemClassLoader>false</useSystemClassLoader>
                </configuration>
            </plugin>

        </plugins>
    </build>

</project>`;
    writeProjectFile(path.join(outputPath, 'pom.xml'), pomXml);

    // 9. ConfigReader.java
    const configReader = `package ${groupId}.${packageName}.utils;

import java.io.FileInputStream;
import java.io.IOException;
import java.util.Properties;

public class ConfigReader {
    private static Properties properties;

    static {
        try (FileInputStream fis = new FileInputStream("src/main/resources/config.properties")) {
            properties = new Properties();
            properties.load(fis);
        } catch (IOException e) {
            e.printStackTrace();
            throw new RuntimeException("Could not load config.properties");
        }
    }

    public static String getProperty(String key) {
        return properties.getProperty(key);
    }
    
    public static boolean getBoolean(String key) {
        return Boolean.parseBoolean(properties.getProperty(key));
    }
}`;
    writeProjectFile(path.join(mainJavaPath, 'utils', 'ConfigReader.java'), configReader);

    // 10. DriverManager.java (Using WebDriverManager)
    const driverManager = `package ${groupId}.${packageName}.utils;

import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.firefox.FirefoxDriver;
import org.openqa.selenium.edge.EdgeDriver;
import io.github.bonigarcia.wdm.WebDriverManager;
import java.time.Duration;

public class DriverManager {
    private static final ThreadLocal<WebDriver> driver = new ThreadLocal<>();

    public static void setDriver() {
        String browser = ConfigReader.getProperty("browser") != null ? ConfigReader.getProperty("browser").toLowerCase() : "chrome";
        boolean headless = ConfigReader.getBoolean("headless");
        int implicitWait = Integer.parseInt(ConfigReader.getProperty("implicit.wait"));

        WebDriver instance;

        switch (browser) {
            case "firefox":
                WebDriverManager.firefoxdriver().setup();
                instance = new FirefoxDriver();
                break;
            case "edge":
                WebDriverManager.edgedriver().setup();
                instance = new EdgeDriver();
                break;
            case "chrome":
            default:
                WebDriverManager.chromedriver().setup();
                ChromeOptions options = new ChromeOptions();
                options.addArguments("--remote-allow-origins=*");
                if (headless) options.addArguments("--headless");
                instance = new ChromeDriver(options);
                break;
        }
        
        instance.manage().window().maximize();
        instance.manage().timeouts().implicitlyWait(Duration.ofSeconds(implicitWait));
        driver.set(instance);
    }

    public static WebDriver getDriver() {
        return driver.get();
    }

    public static void quitDriver() {
        if (driver.get() != null) {
            driver.get().quit();
            driver.remove();
        }
    }
}`;
    writeProjectFile(path.join(mainJavaPath, 'utils', 'DriverManager.java'), driverManager);

    // 11. WaitUtils.java
    const waitUtils = `package ${groupId}.${packageName}.utils;

import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;
import java.time.Duration;

public class WaitUtils {
    private WebDriverWait wait;

    public WaitUtils(WebDriver driver, int timeoutInSeconds) {
        this.wait = new WebDriverWait(driver, Duration.ofSeconds(timeoutInSeconds));
    }

    public void waitForElementToBeClickable(WebElement element) {
        wait.until(ExpectedConditions.elementToBeClickable(element));
    }

    public void waitForElementToBeVisible(WebElement element) {
        wait.until(ExpectedConditions.visibilityOf(element));
    }
}`;
    writeProjectFile(path.join(mainJavaPath, 'utils', 'WaitUtils.java'), waitUtils);

    // 12. BasePage.java
    const basePage = `package ${groupId}.${packageName}.pages;

import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.PageFactory;
import ${groupId}.${packageName}.utils.WaitUtils;
import ${groupId}.${packageName}.utils.ConfigReader;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

public class BasePage {
    protected WebDriver driver;
    protected WaitUtils waitUtils;
    protected static final Logger logger = LogManager.getLogger(BasePage.class);

    public BasePage(WebDriver driver) {
        this.driver = driver;
        int explicitWait = Integer.parseInt(ConfigReader.getProperty("explicit.wait"));
        this.waitUtils = new WaitUtils(driver, explicitWait);
        PageFactory.initElements(driver, this);
    }
    
    public void navigateTo(String url) {
        logger.info("Navigating to: " + url);
        driver.get(url);
    }
}`;
    writeProjectFile(path.join(mainJavaPath, 'pages', 'BasePage.java'), basePage);

    // 13. LoginPage.java
    const loginPage = `package ${groupId}.${packageName}.pages;

import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.FindBy;

public class LoginPage extends BasePage {

    @FindBy(id = "user-name")
    private WebElement usernameInput;

    @FindBy(id = "password")
    private WebElement passwordInput;

    @FindBy(id = "login-button")
    private WebElement loginButton;

    public LoginPage(WebDriver driver) {
        super(driver);
    }

    public void login(String username, String password) {
        logger.info("Attempting to login with user: " + username);
        usernameInput.sendKeys(username);
        passwordInput.sendKeys(password);
        loginButton.click();
    }
}`;
    writeProjectFile(path.join(mainJavaPath, 'pages', 'LoginPage.java'), loginPage);

    // 14. BaseTest.java
    const baseTest = `package ${groupId}.${packageName}.tests;

import ${groupId}.${packageName}.utils.DriverManager;
import org.openqa.selenium.WebDriver;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.BeforeMethod;

public class BaseTest {

    protected WebDriver driver;

    @BeforeMethod
    public void setUp() {
        DriverManager.setDriver();
        driver = DriverManager.getDriver();
    }

    @AfterMethod
    public void tearDown() {
        DriverManager.quitDriver();
    }
}`;
    writeProjectFile(path.join(testJavaPath, 'tests', 'BaseTest.java'), baseTest);

    // 15. LoginTest.java
    const loginTest = `package ${groupId}.${packageName}.tests;

import ${groupId}.${packageName}.pages.LoginPage;
import ${groupId}.${packageName}.utils.ConfigReader;
import org.testng.annotations.Test;
import org.testng.Assert;

public class LoginTest extends BaseTest {

    @Test
    public void testLogin() {
        LoginPage loginPage = new LoginPage(driver);
        String baseUrl = ConfigReader.getProperty("base.url");
        loginPage.navigateTo(baseUrl);
        loginPage.login("standard_user", "secret_sauce");
        Assert.assertTrue(driver.getCurrentUrl().contains("inventory.html"), "Login failed!");
    }
}`;
    writeProjectFile(path.join(testJavaPath, 'tests', 'LoginTest.java'), loginTest);

    // 15.1 Cucumber Specific Files
    if (isCucumber) {
        // Feature File
        const featureFile = `Feature: Login Functionality
  Scenario: Successful login with valid credentials
    Given I am on the login page
    When I enter valid username and password
    Then I should be redirected to the dashboard`;
        writeProjectFile(path.join(testResourcesPath, 'features', 'login.feature'), featureFile);

        // Step Definitions
        const stepdefs = `package ${groupId}.${packageName}.stepdefinitions;

import ${groupId}.${packageName}.pages.LoginPage;
import ${groupId}.${packageName}.utils.ConfigReader;
import ${groupId}.${packageName}.utils.DriverManager;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import org.testng.Assert;

public class LoginStepDefinitions {
    private LoginPage loginPage;

    @Given("I am on the login page")
    public void i_am_on_the_login_page() {
        DriverManager.setDriver();
        loginPage = new LoginPage(DriverManager.getDriver());
        String baseUrl = ConfigReader.getProperty("base.url");
        loginPage.navigateTo(baseUrl);
    }

    @When("I enter valid username and password")
    public void i_enter_valid_username_and_password() {
        loginPage.login("standard_user", "secret_sauce");
    }

    @Then("I should be redirected to the dashboard")
    public void i_should_be_redirected_to_the_dashboard() {
        Assert.assertTrue(DriverManager.getDriver().getCurrentUrl().contains("inventory.html"));
        DriverManager.quitDriver();
    }
}`;
        writeProjectFile(path.join(testJavaPath, 'stepdefinitions', 'LoginStepDefinitions.java'), stepdefs);

        // Runner
        const runner = `package ${groupId}.${packageName}.runners;

import io.cucumber.testng.AbstractTestNGCucumberTests;
import io.cucumber.testng.CucumberOptions;
import org.testng.annotations.DataProvider;

@CucumberOptions(
    features = "src/test/resources/features",
    glue = {"${groupId}.${packageName}.stepdefinitions"},
    plugin = {"pretty", "html:target/cucumber-reports.html"}
)
public class CucumberTestRunner extends AbstractTestNGCucumberTests {
    @Override
    @DataProvider(parallel = true)
    public Object[][] scenarios() {
        return super.scenarios();
    }
}`;
        writeProjectFile(path.join(testJavaPath, 'runners', 'CucumberTestRunner.java'), runner);
    }

    if (features.apiTesting) {
        fs.mkdirSync(path.join(testJavaPath, 'api'), { recursive: true });
        const apiBaseTest = `package ${groupId}.${packageName}.api;

import io.restassured.RestAssured;
import org.testng.annotations.BeforeClass;

public class ApiBaseTest {
    @BeforeClass
    public void setupApi() {
        RestAssured.baseURI = "https://jsonplaceholder.typicode.com";
    }
}`;
        writeProjectFile(path.join(testJavaPath, 'api', 'ApiBaseTest.java'), apiBaseTest);

        const usersApiTest = `package ${groupId}.${packageName}.api;

import io.restassured.RestAssured;
import io.restassured.http.ContentType;
import org.testng.annotations.Test;
import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

public class UsersApiTest extends ApiBaseTest {

    @Test
    public void testGetUserList() {
        given()
            .when()
            .get("/users")
        .then()
            .statusCode(200)
            .body("size()", greaterThan(0))
            .body("[0]", hasKey("email"));
    }

    @Test
    public void testCreateUser() {
        String payload = "{\\"name\\": \\"morpheus\\", \\"job\\": \\"leader\\"}";
        
        given()
            .contentType(ContentType.JSON)
            .body(payload)
        .when()
            .post("/users")
        .then()
            .statusCode(201)
            .body("name", equalTo("morpheus"));
    }
}`;
        writeProjectFile(path.join(testJavaPath, 'api', 'UsersApiTest.java'), usersApiTest);
    }

    // 16. README.md
    const readme = `# \${projectName}
Enterprise-grade Selenium Java Framework

## Folder Structure
- \`src/main/java\`: Source code (Pages, Utils, Constants, Listeners)
- \`src/main/resources\`: Config, Logging, and Test Data
- \`src/test/java\`: Test scripts and Runners
- \`src/test/resources\`: TestNG suite configurations

## Features
- ✅ Page Object Model
- ✅ Log4j2 Logging
- ✅ WebDriverManager for binary management
- ✅ Extent Reports integration ready
- ✅ GitHub Actions workflow
- ✅ Docker support
- ${isCucumber ? '- ✅ Cucumber BDD Support' : ''}
- ${features.apiTesting ? '- ✅ REST Assured API Testing' : ''}

## Setup
\`\`\`bash
mvn clean install
\`\`\`

## Run Tests
\`\`\`bash
mvn test
\`\`\``;
    writeProjectFile(path.join(outputPath, 'README.md'), readme);
}

// Launch Interactive Browser
app.post('/api/browser/launch', async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // Auto-prepend https protocols so Playwright doesn't crash from raw domains like "google.com"
    if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
    }

    try {
        if (activeBrowser) {
            await activeBrowser.close().catch(() => { });
            activeBrowser = null;
        }

        console.log(`Launching interactive browser for: ${url}`);
        // Default headless so this works in the deployed container (which has
        // no display server). Local devs can opt out with HEADLESS=false in
        // .env to keep the historic headed-Chromium workflow for cookie/HTML
        // capture from the Setup Wizard.
        const { browserType, cookies } = req.body;
        const launchHeadless = process.env.HEADLESS !== 'false';
        const launcher = getBrowserLauncher(browserType);
        const launchOptions = {
            headless: launchHeadless,
        };
        if (browserType?.toLowerCase() === 'chromium' || !browserType) {
            launchOptions.args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox'];
        }
        activeBrowser = await launcher.launch(launchOptions);

        activeContext = await activeBrowser.newContext({
            viewport: null // maximize viewport
        });

        // Inject cookies if provided (for starting in an authenticated session state)
        if (cookies && Array.isArray(cookies) && cookies.length > 0) {
            console.log(`Injecting ${cookies.length} cookies into active browser context...`);
            await activeContext.addCookies(cookies);
        }

        activePage = await activeContext.newPage();
        await activePage.goto(url);

        res.json({ message: 'Browser launched' });
    } catch (error) {
        console.error('Launch error:', error);
        res.status(500).json({ error: 'Failed to launch browser', details: error.message });
    }
});

// Capture Cookies & HTML from Interactive Browser
app.get('/api/browser/capture', async (req, res) => {
    if (!activeContext || !activePage) {
        return res.status(400).json({ error: 'No active browser session found' });
    }

    try {
        const cookies = await activeContext.cookies();
        const html = await activePage.content();
        const url = activePage.url();

        console.log(`Captured ${cookies.length} cookies, HTML, and url=${url}`);

        // DO NOT close the browser here. Keep it open for further navigation.

        res.json({ cookies, html, url });
    } catch (error) {
        console.error('Capture error:', error);
        res.status(500).json({ error: 'Failed to capture data', details: error.message });
    }
});

// Close Interactive Browser
app.post('/api/browser/close', async (req, res) => {
    if (activeBrowser) {
        await activeBrowser.close().catch(() => { });
        activeBrowser = null;
        activeContext = null;
        activePage = null;
        res.json({ message: 'Browser closed' });
    } else {
        res.status(400).json({ error: 'No active browser to close' });
    }
});

// Navigate Active Browser Page
app.post('/api/browser/navigate', async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    if (!activePage) return res.status(400).json({ error: 'No active browser page found' });

    if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
    }

    try {
        console.log(`Navigating active browser page to: ${url}`);
        await activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        try {
            await activePage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
        } catch {
            // Ignore network idle timeout
        }
        res.json({ message: 'Navigated successfully', currentUrl: activePage.url() });
    } catch (error) {
        console.error('Navigation error:', error);
        res.status(500).json({ error: 'Failed to navigate', details: error.message });
    }
});
// Scrape endpoint (POST to accept body with cookies) - Headless Mode
app.post('/api/scrape', async (req, res) => {
    const { url, cookies, browserType } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    let targetUrl = url;
    if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
    }

    let browser = null;
    let context = null;
    let page = null;

    try {
        console.log(`Launching scraper for: ${targetUrl} (${browserType || 'chromium'})`);

        const launcher = getBrowserLauncher(browserType);
        const launchOptions = {
            headless: true
        };
        if (browserType?.toLowerCase() === 'chromium' || !browserType) {
            launchOptions.args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox'];
        }
        browser = await launcher.launch(launchOptions);

        context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });

        // Add cookies if provided
        if (cookies && Array.isArray(cookies) && cookies.length > 0) {
            console.log(`Injecting ${cookies.length} cookies...`);
            await context.addCookies(cookies);
        }

        page = await context.newPage();

        // Navigate and wait for content
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Extra safety wait for dynamic content
        try {
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
        } catch {
            // Ignore network idle timeout, proceed with what we have
        }

        const html = await page.content();
        console.log(`Scraping successful, length: ${html.length}`);

        res.json({ html });

    } catch (error) {
        res.status(500).json({
            error: 'Failed to scrape URL',
            details: error.message
        });
    } finally {
        if (browser) {
            await browser.close().catch(e => console.error('Error closing browser:', e));
        }
    }
});

// In-flight localization jobs, keyed by jobId. Each holds the cumulative issues
// found so far so the client can poll and render incrementally; dropped ~10 min
// after completion. (Module-level, like runStore for test runs.)
const localizationJobs = new Map();

// Parse an LLM issue-array response, tolerant of code fences, surrounding prose,
// and TRUNCATION (a long localization issue list can exceed the token cap).
// Falls back to scanning balanced top-level {...} objects so a partial final
// object is dropped instead of losing the whole chunk's findings.
function salvageJsonArray(text) {
    if (!text || typeof text !== 'string') return [];
    let s = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = s.indexOf('[');
    if (start !== -1) s = s.slice(start);
    const end = s.lastIndexOf(']');
    if (end > 0) { try { const a = JSON.parse(s.slice(0, end + 1)); if (Array.isArray(a)) return a; } catch { /* salvage below */ } }
    const objs = []; let depth = 0, st = -1, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') { if (depth === 0) st = i; depth++; }
        else if (ch === '}') { depth--; if (depth === 0 && st !== -1) { try { objs.push(JSON.parse(s.slice(st, i + 1))); } catch { /* skip incomplete */ } st = -1; } }
    }
    return objs;
}

// Localization Analysis Endpoint (Text-extraction + Chunked for large pages)
app.post('/api/analyze-localization', async (req, res) => {
    const { html, targetLanguage } = req.body;
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) return res.status(401).json({ error: 'API Key missing' });
    if (!html || !targetLanguage) return res.status(400).json({ error: 'HTML and Target Language required' });

    try {
        const endpoint = process.env.VITE_LLM_ENDPOINT || 'https://llm.lab.aaseya.com/v1';
        const llmModel = process.env.VITE_LLM_MODEL || 'gemma-4';
        const genAI = new GoogleGenerativeAI(apiKey, endpoint);
        const model = genAI.getGenerativeModel({
            model: llmModel,
            // Bound gpt-oss's reasoning (consistent with the other generators) but
            // leave output uncapped — a localization issue list can be long, and a
            // max_tokens cap would truncate it. timeoutMs is raised well above the
            // client's 120s default: a large page chunk takes minutes on the local
            // model, and the 120s abort was silently failing EVERY chunk (→ a false
            // "no issues" on pages that are clearly untranslated).
            generationConfig: { temperature: 0.2, reasoningEffort: 'low', timeoutMs: 240000 }
        });

        const isEnglishDialect = targetLanguage.includes('American English') || targetLanguage.includes('British English');
        const isAmericanEnglish = targetLanguage.includes('American English');

        // ── Step 1: Safe text extraction — NO complex regex (avoids catastrophic backtracking) ──
        // Walk the HTML char-by-char, skipping everything inside tags and known invisible blocks
        function extractVisibleText(rawHtml) {
            let result = '';
            let i = 0;
            const len = rawHtml.length;

            while (i < len) {
                if (rawHtml[i] === '<') {
                    // Find the tag name
                    let tagStart = i + 1;
                    // Skip leading slash for closing tags
                    if (rawHtml[tagStart] === '/') tagStart++;
                    // Read tag name
                    let tagNameEnd = tagStart;
                    while (tagNameEnd < len && /[a-zA-Z0-9]/.test(rawHtml[tagNameEnd])) tagNameEnd++;
                    const tagName = rawHtml.substring(tagStart, tagNameEnd).toLowerCase();

                    // For script/style/svg/noscript: skip to closing tag entirely
                    if (['script', 'style', 'svg', 'noscript'].includes(tagName)) {
                        const closeTag = `</${tagName}`;
                        const closeIdx = rawHtml.toLowerCase().indexOf(closeTag, i + 1);
                        if (closeIdx === -1) { i = len; break; }
                        // Skip past the closing >
                        i = rawHtml.indexOf('>', closeIdx) + 1;
                        if (i === 0) i = len;
                        result += ' ';
                        continue;
                    }

                    // For HTML comments: skip to -->
                    if (rawHtml.substring(i, i + 4) === '<!--') {
                        const closeIdx = rawHtml.indexOf('-->', i + 4);
                        i = closeIdx === -1 ? len : closeIdx + 3;
                        continue;
                    }

                    // For all other tags: skip to closing >
                    const closeIdx = rawHtml.indexOf('>', i);
                    i = closeIdx === -1 ? len : closeIdx + 1;
                    result += ' ';
                } else {
                    result += rawHtml[i];
                    i++;
                }
            }

            return result
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                .replace(/&#\d+;/g, ' ')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        }

        const visibleText = extractVisibleText(html);
        console.log(`[Localization] HTML ${html.length} chars → visible text ${visibleText.length} chars`);

        // ── Step 2: Deduplicate repeated lines (nav/footer repeating) ──
        const uniqueLines = [...new Set(
            visibleText.split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 2)
        )];
        const textContent = uniqueLines.join('\n');
        console.log(`[Localization] After dedup: ${textContent.length} chars`);


        // ── Step 3: Chunk at 8,000 chars ──
        // Smaller chunks keep each LLM call's output (and time) bounded so it
        // completes within the timeout. A 20k chunk on an all-English page asks
        // the model to enumerate hundreds of strings → minutes of output → abort.
        const CHUNK_SIZE = 8000;
        const chunks = [];
        for (let i = 0; i < textContent.length; i += CHUNK_SIZE) {
            chunks.push(textContent.substring(i, i + CHUNK_SIZE));
        }

        console.log(`[Localization] Raw HTML: ${html.length} chars → Extracted text: ${textContent.length} chars → ${chunks.length} chunk(s)`);

        const buildPrompt = (chunk, chunkIndex, totalChunks) => {
            const chunkNote = totalChunks > 1
                ? ` (Part ${chunkIndex + 1} of ${totalChunks})`
                : '';

            if (isEnglishDialect) {
                const dialectFrom = isAmericanEnglish ? 'British English' : 'American English';
                const dialectTo = isAmericanEnglish ? 'American English (en-US)' : 'British English (en-GB)';
                const spellingExamples = isAmericanEnglish
                    ? 'colour→color, organisation→organization, centre→center, behaviour→behavior, whilst→while'
                    : 'color→colour, organize→organise, center→centre, behavior→behaviour, while→whilst';

                return `You are a Localization QA Expert${chunkNote}.
The page SHOULD use ${dialectTo}. Scan the text below for ${dialectFrom} words/phrases.
Focus: spelling (${spellingExamples}), vocabulary, date formats. Ignore brand names and proper nouns.
Report UP TO 20 of the most prominent issues — do NOT list every repeated occurrence.

For each issue: { "original": "exact text", "suggestion": "corrected text", "context": "brief description" }

PAGE TEXT:
${chunk}

Return ONLY a JSON array. Empty array [] if no issues.`;
            } else {
                return `You are a Localization QA Expert${chunkNote}.
The page SHOULD be fully in ${targetLanguage}. Identify untranslated English strings visible to users.
Report UP TO 20 of the most prominent ones — do NOT exhaustively list every word or repeated occurrence.
Ignore: brand names, proper nouns, technical product names, URLs.

For each issue: { "original": "english text", "suggestion": "intended ${targetLanguage} translation", "context": "brief location" }

PAGE TEXT:
${chunk}

Return ONLY a JSON array. Empty array [] if no issues.`;
            }
        };

        // ── Step 4: Kick off an async job and stream results chunk-by-chunk ──
        // The local model is slow (a large page can take minutes), so instead of
        // one long blocking request we register a job, return its id immediately,
        // and merge each chunk's issues into the job as they complete. The client
        // polls /status/:jobId and renders issues incrementally.
        const projectId = req.body.projectId || req.query.projectId || req.body.project_id;
        const scannedUrl = activePage?.url() || 'Unknown Page';
        const jobId = `loc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const job = { status: 'running', total: chunks.length, done: 0, issues: [], error: null, seen: new Set() };
        localizationJobs.set(jobId, job);

        res.json({ jobId, totalChunks: chunks.length });

        // Background worker — runs after the response is sent.
        (async () => {
            let failedChunks = 0;
            for (let i = 0; i < chunks.length; i++) {
                console.log(`[Localization] Chunk ${i + 1}/${chunks.length} (~${Math.round(chunks[i].length / 4)} estimated tokens)...`);
                try {
                    const responseText = await generateWithRetry(model, buildPrompt(chunks[i], i, chunks.length));
                    for (const issue of salvageJsonArray(responseText)) {
                        const key = ((issue && issue.original) || '').toLowerCase().trim();
                        if (!key || job.seen.has(key)) continue;
                        job.seen.add(key);
                        job.issues.push(issue);
                    }
                } catch (chunkErr) {
                    // Empty/length-capped or aborted LLM call — count as a failure
                    // (don't mask it as "no issues") and keep going.
                    failedChunks++;
                    console.warn(`[Localization] Chunk ${i + 1} failed: ${chunkErr.message}`);
                }
                job.done = i + 1;
            }

            console.log(`[Localization] Done. ${job.issues.length} unique issues. Failed chunks: ${failedChunks}/${chunks.length}`);

            // If EVERY chunk failed, the analysis failed — surface it rather than
            // reporting an empty result that looks like a clean page.
            if (chunks.length > 0 && failedChunks === chunks.length) {
                job.status = 'failed';
                job.error = 'Localization analysis failed: the language model returned no usable output for the page (large pages can exhaust it). Please try again, or scan a smaller page.';
            } else {
                job.status = 'completed';
                // Persist a LocalizationResult for Release Readiness.
                try {
                    if (projectId) {
                        const totalIssues = job.issues.length;
                        await LocalizationResult.create({
                            project_id: projectId,
                            translation_accuracy: Math.max(0, 100 - (totalIssues * 1.5)),
                            localization_score: Math.max(0, 100 - (totalIssues * 3.0)),
                            missing_keys: totalIssues,
                            overflow_issues: 0,
                            scanned_url: scannedUrl,
                        });
                        await calculateAndSaveReadiness(projectId);
                    }
                } catch (dbErr) {
                    console.error('[Readiness] Failed to save LocalizationResult:', dbErr.message);
                }
            }
            // Keep the finished job around briefly so the client can read the final state.
            setTimeout(() => localizationJobs.delete(jobId), 10 * 60 * 1000);
        })();

    } catch (error) {
        console.error('Localization Analysis Error:', error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

// GET /api/analyze-localization/status/:jobId — poll a running localization job.
// Returns the issues accumulated so far (cumulative) so the UI can render them
// incrementally while the remaining chunks are still being analyzed.
app.get('/api/analyze-localization/status/:jobId', (req, res) => {
    const job = localizationJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Unknown or expired localization job.' });
    res.json({ status: job.status, done: job.done, total: job.total, issues: job.issues, error: job.error });
});

// ─── Performance scan (Phase 1): Lighthouse front-end audit ───
// Runs Lighthouse against a URL (reusing Playwright's bundled Chromium) and
// returns the performance score + Core Web Vitals + top opportunities. No LLM
// needed — Lighthouse is local. SSRF-validated like the other URL endpoints.
app.post('/api/analyze-performance', async (req, res) => {
    const { url, projectId } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required.' });
    const check = await validateHttpUrl(url);
    if (!check.valid) return res.status(400).json({ error: check.error });

    let chrome;
    try {
        const lighthouse = (await import('lighthouse')).default;
        const chromeLauncher = await import('chrome-launcher');
        chrome = await chromeLauncher.launch({
            chromePath: chromium.executablePath(),
            chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
        });
        console.log(`[Performance] Running Lighthouse on ${check.href}...`);
        const runnerResult = await lighthouse(check.href, {
            port: chrome.port,
            output: 'json',
            logLevel: 'error',
            onlyCategories: ['performance'],
        });
        const lhr = runnerResult.lhr;

        const ms = (id) => {
            const a = lhr.audits[id];
            return a && typeof a.numericValue === 'number' ? Math.round(a.numericValue) : null;
        };
        const score = Math.round((lhr.categories.performance.score || 0) * 100);
        const clsAudit = lhr.audits['cumulative-layout-shift'];
        const metrics = {
            lcp: ms('largest-contentful-paint'),
            cls: clsAudit && typeof clsAudit.numericValue === 'number' ? Number(clsAudit.numericValue.toFixed(3)) : null,
            tbt: ms('total-blocking-time'),
            fcp: ms('first-contentful-paint'),
            speedIndex: ms('speed-index'),
            ttfb: ms('server-response-time'),
        };
        // Failing / sub-optimal performance audits. Lighthouse 13 dropped the old
        // 'load-opportunities' auditRef group, so select by score instead — and
        // exclude the metric audits (already shown as CWV cards) and
        // informative/not-applicable ones.
        const METRIC_AUDIT_IDS = new Set([
            'largest-contentful-paint', 'first-contentful-paint', 'cumulative-layout-shift',
            'total-blocking-time', 'speed-index', 'interactive', 'max-potential-fid', 'server-response-time',
        ]);
        const opportunities = (lhr.categories.performance.auditRefs || [])
            .map(ref => lhr.audits[ref.id])
            .filter(a => a && a.score !== null && a.score < 0.9
                && !['informative', 'notApplicable', 'manual'].includes(a.scoreDisplayMode)
                && !METRIC_AUDIT_IDS.has(a.id))
            .map(a => ({
                title: a.title,
                savingsMs: a.details && typeof a.details.overallSavingsMs === 'number' ? Math.round(a.details.overallSavingsMs) : null,
                description: String(a.description || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 220),
            }))
            .sort((x, y) => (y.savingsMs || 0) - (x.savingsMs || 0))
            .slice(0, 10);

        console.log(`[Performance] Score ${score} for ${check.href}`);

        // Persist for Release Readiness (non-fatal; mirrors the other scanners).
        try {
            if (projectId) {
                await PerformanceResult.create({
                    project_id: projectId,
                    performance_score: score,
                    lcp_ms: metrics.lcp,
                    cls: metrics.cls,
                    tbt_ms: metrics.tbt,
                    ttfb_ms: metrics.ttfb,
                    scanned_url: check.href,
                });
                await calculateAndSaveReadiness(projectId);
            }
        } catch (dbErr) {
            console.error('[Performance] Failed to persist PerformanceResult:', dbErr.message);
        }

        res.json({ score, metrics, opportunities, scannedUrl: check.href });
    } catch (err) {
        console.error('[Performance] Lighthouse error:', err.message);
        res.status(500).json({ error: `Performance scan failed: ${err.message}` });
    } finally {
        if (chrome) { try { await chrome.kill(); } catch { /* best-effort */ } }
    }
});

// AI triage of a Lighthouse result — prioritized plain-English fixes. Kept
// SEPARATE from the scan so the fast scan isn't blocked by the slow local LLM;
// the UI fetches this after showing the raw report. Fail-loud (502), never silent.
app.post('/api/performance-insights', async (req, res) => {
    const { score, metrics = {}, opportunities = [], url } = req.body || {};
    const apiKey = req.headers['x-api-key'] || process.env.VITE_LLM_API_KEY;
    if (!apiKey) return res.status(401).json({ error: 'LLM API key missing.' });
    try {
        const genAI = new GoogleGenerativeAI(apiKey, process.env.VITE_LLM_ENDPOINT);
        const model = genAI.getGenerativeModel({
            model: process.env.VITE_LLM_MODEL || 'gemma-4',
            generationConfig: { temperature: 0.2, reasoningEffort: 'low', timeoutMs: 120000 },
        });
        const opps = (Array.isArray(opportunities) && opportunities.length)
            ? opportunities.map(o => `- ${o.title}${o.savingsMs ? ` (~${o.savingsMs} ms)` : ''}`).join('\n')
            : '(none flagged)';
        const prompt = `You are a senior web-performance engineer. From this Lighthouse result, write a SHORT triage in plain text (NO markdown headings): first a one-line verdict, then "Top fixes:" with the 3 highest-impact actions, each with the likely user impact. Be concrete and concise.

URL: ${url || 'n/a'}
Performance score: ${score}/100
Core Web Vitals: LCP ${metrics.lcp ?? '?'} ms, CLS ${metrics.cls ?? '?'}, TBT ${metrics.tbt ?? '?'} ms, TTFB ${metrics.ttfb ?? '?'} ms
Opportunities:
${opps}`;
        const summary = (await generateWithRetry(model, prompt)).trim();
        if (!summary) return res.status(502).json({ error: 'AI returned an empty summary — try again.' });
        res.json({ summary });
    } catch (err) {
        console.error('[Performance] AI insights failed:', err.message);
        res.status(502).json({ error: `AI insights failed: ${err.message}` });
    }
});

// Accessibility Analysis Endpoint


app.post('/api/analyze-accessibility', async (req, res) => {
    if (!activeContext || !activePage) {
        return res.status(400).json({ error: 'No active browser session found' });
    }
    const _apiKey = req.headers['x-api-key']; // Should be passed from frontend if client manages it, but we can also use env if backend manages it.
    // However, other endpoints use req.headers['x-api-key'], let's check if frontend sends it. 
    // accessibilityService.js currently DOES NOT send x-api-key. 
    // We should probably rely on the Backend environment variable here since it's a backend feature, OR update frontend to send it.
    // Existing code uses API Key from env for other things? 
    // Wait, localization analysis uses req.headers['x-api-key'].
    // Framework generator uses env? 
    // Locator generator uses client side.

    // Let's assume we use the Local LLM key if header is missing, 
    // but the backend might not have access to VITE_ vars directly unless loaded. 
    // This file uses `const require = createRequire...`. 
    // I'll try to use a hardcoded key or assume the User has set it up? 
    // Actually, I'll update the frontend to send the key if available, but for now I'll use the 'Header' pattern if provided, else fallback to a known variable if any.
    // Ideally, the Backend should have its own key.
    // I made a mistake in planning: Frontend needs to send key or Backend needs one.
    // I'll assume the frontend will send it (I'll update frontend next).

    try {
        console.log("Injecting axe-core...");
        await activePage.addScriptTag({ path: require.resolve('axe-core') });

        console.log("Running accessibility scan (Axe)...");
        const axeResults = await activePage.evaluate(async () => {
            // eslint-disable-next-line no-undef
            return await axe.run({
                runOnly: {
                    type: 'tag',
                    values: ['wcag22aa', 'wcag21aa', 'wcag2aa']
                }
            });
        });

        // --- NEW: AI HYBRID AUDIT ---
        let aiAudit = null;
        let authKey = req.headers['x-api-key'];
        const includeAiAudit = req.body.includeAiAudit !== false;

        // Sanitize auth key (sometimes "undefined" string is passed)
        if (authKey === 'undefined' || authKey === 'null') {
            authKey = null;
        }

        if (authKey && includeAiAudit) {
            console.log(`Running AI Audit via Local LLM... Key present (Starts with ${authKey.substring(0, 4)}...)`);
            try {
                // Optimize HTML to reduce token usage
                let html = await activePage.content();

                // Remove scripts, styles, svgs, comments to save tokens
                html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
                    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
                    .replace(/<svg\b[^>]*>([\s\S]*?)<\/svg>/gim, "")
                    .replace(/<!--[\s\S]*?-->/g, "")
                    .replace(/\s+/g, " "); // Minify whitespace

                const genAI = new GoogleGenerativeAI(authKey, process.env.VITE_LLM_ENDPOINT);
                // Switch to configured local model
                const model = genAI.getGenerativeModel({ 
                    model: process.env.VITE_LLM_MODEL || "gemma-4",
                    generationConfig: { temperature: 0.2 }
                });

                const passedRules = axeResults.passes.map(p => p.id).join(', ');
                const failedRules = axeResults.violations.map(v => v.id).join(', ');

                const systemPrompt = `
                    You are a senior accessibility auditor and WCAG 2.1 / 2.2 AA compliance expert.
                    Your task is to analyze web accessibility issues using WCAG AA standards and provide clear, actionable guidance.
                    
                    Focus on issues NOT reliably detected by automated tools (Axe).
                    
                    Context:
                    - Page URL: ${activePage.url()}
                    - Page Type: Dashboard/Web App
                    
                    Automated Checks Passed: ${passedRules}
                    Automated Checks Failed: ${failedRules}

                    DOM Snippet (Optimized & Truncated):
                    ${html.substring(0, 20000)}

                    Your tasks:
                    1. Identify WCAG AA issues NOT reliably detected by automated scanning (e.g. Logic focus order, meaningful text, dynamic content announcements, custom widgets).
                    2. Classify each issue as Critical, Serious, or Moderate.
                    3. Provide WCAG reference, Impacted user groups, Explanation, and Recommended fix.
                    4. Generate a 'Compliance Snapshot' (Pass/Fail/Partial) for the 4 principles: Perceivable, Operable, Understandable, Robust.
                    5. Determine 'Release Status' (Ready/Not Ready) based on Critical/Serious issues.
                    6. Write a short 'Final Recommendation' paragraph for the report.

                    OUTPUT FORMAT (Strict JSON):
                    {
                      "summary": { "overallRisk": "Low|Medium|High", "criticalIssues": 0, "seriousIssues": 0, "moderateIssues": 0 },
                      "releasability": "Ready" | "Not Ready",
                      "complianceSnapshot": {
                        "perceivable": "Pass|Fail|Partial",
                        "operable": "Pass|Fail|Partial",
                        "understandable": "Pass|Fail|Partial",
                        "robust": "Pass|Fail|Partial"
                      },
                      "finalRecommendation": "This page does not meet WCAG 2.2 AA due to...",
                      "issues": [
                        { "severity": "Critical", "wcag": "2.1.1 Keyboard", "issue": "...", "affectedUsers": ["Keyboard"], "whyItMatters": "...", "recommendedFix": "..." }
                      ],
                      "areasReviewed": ["Keyboard", "Forms", "Focus management", "ARIA"]
                    }
                `;

                const text = (await generateWithRetry(model, systemPrompt)).replace(/```json/g, '').replace(/```/g, '').trim();
                aiAudit = JSON.parse(text);

            } catch (aiErr) {
                console.error("AI Audit Failed Details:", aiErr);
                // Check for 429
                if (aiErr.message.includes('429') || aiErr.message.includes('Quota')) {
                    aiAudit = { error: "AI Rate Limit Reached. Please wait a minute and try again." };
                } else {
                    aiAudit = { error: `AI Audit failed: ${aiErr.message}` };
                }
            }
        } else if (!includeAiAudit) {
            console.log("Skipping AI Audit: User disabled AI expert audit in scan options.");
            aiAudit = { skipped: true, error: "AI Audit was skipped. Enable 'AI WCAG Expert Audit' in the scan panel to run full WCAG checks." };
        } else {
            console.log("Skipping AI Audit: No API Key provided in headers.");
            aiAudit = { error: "API Key missing. Please ensure a valid API Key is provided in the request headers." };
        }

        console.log(`Scan complete. Found ${axeResults.violations.length} axe violations.`);
        if (aiAudit && !aiAudit.error) console.log(`AI Audit complete. Found ${aiAudit.issues?.length || 0} issues.`);

        // --- NEW: SAVE ACCESSIBILITY PROFILE FOR RELEASE READINESS ---
        try {
            const projectId = req.body.projectId || req.query.projectId || req.body.project_id;
            if (projectId) {
                console.log(`[Readiness] Auto-saving AccessibilityResult for project ${projectId}...`);
                const critCount = axeResults.violations.filter(v => v.impact === 'critical').length + (aiAudit?.issues?.filter(i => i.severity === 'Critical').length || 0);
                const seriousCount = axeResults.violations.filter(v => v.impact === 'serious').length + (aiAudit?.issues?.filter(i => i.severity === 'Serious').length || 0);
                const moderateCount = axeResults.violations.filter(v => v.impact === 'moderate').length + (aiAudit?.issues?.filter(i => i.severity === 'Moderate').length || 0);
                const minorCount = axeResults.violations.filter(v => v.impact === 'minor').length;
                
                const compliancePct = Math.max(0, 100 - (critCount * 10 + seriousCount * 5 + moderateCount * 2));
                const accScore = Math.max(0, 100 - (critCount * 15 + seriousCount * 8 + moderateCount * 3));

                await AccessibilityResult.create({
                    project_id: projectId,
                    wcag_compliance: compliancePct,
                    accessibility_score: accScore,
                    critical_violations: critCount,
                    serious_violations: seriousCount,
                    moderate_violations: moderateCount,
                    minor_violations: minorCount,
                    scanned_url: activePage?.url() || 'Unknown Page',
                });

                // Auto-compute readiness score
                await calculateAndSaveReadiness(projectId);
            }
        } catch (dbErr) {
            console.error('[Readiness] Failed to save AccessibilityResult:', dbErr.message);
        }

        res.json({
            scannedUrl: activePage.url(),
            violations: axeResults.violations,
            passes: axeResults.passes,
            incomplete: axeResults.incomplete,
            aiAudit: aiAudit // Include AI results
        });

    } catch (error) {
        console.error('Accessibility Scan Error:', error);
        res.status(500).json({ error: 'Failed to run accessibility scan', details: error.message });
    }
});


// ============================================================
// TEST RUNNER SERVICE
// ============================================================

// In-memory store for run state
const runStore = new Map(); // runId -> { status, logs, results, framework, projectPath, failedTests }

// Cap on run.logs chunk count. The full log is also persisted to
// temp_runner/<runId>/logs.txt on completion for cases where the tail was
// rotated away during a long-running suite.
const MAX_RUN_LOG_CHUNKS = 500;

function appendRunLog(run, chunk) {
    if (!run || chunk == null) return;
    run.logs.push(String(chunk));
    if (run.logs.length > MAX_RUN_LOG_CHUNKS) {
        run.logs.splice(0, run.logs.length - MAX_RUN_LOG_CHUNKS);
    }
}

const RUN_LOGS_DIR = 'temp_runner_logs';
function persistRunLogs(runId, run) {
    try {
        if (!fs.existsSync(RUN_LOGS_DIR)) fs.mkdirSync(RUN_LOGS_DIR, { recursive: true });
        writeProjectFile(path.join(RUN_LOGS_DIR, `${runId}.log`), run.logs.join(''));
    } catch (err) {
        console.error(`[Runner ${runId}] Failed to persist logs:`, err.message);
    }
}

const runnerUpload = multer({ dest: 'temp_runner_uploads/' });

// Helper: detect framework from extracted folder
function detectFramework(projectDir) {
    const files = fs.readdirSync(projectDir);
    if (files.includes('pom.xml')) return 'maven';
    if (files.some(f => f.startsWith('playwright.config'))) return 'playwright';
    if (files.some(f => f.startsWith('cypress.config'))) return 'cypress';
    // Check nested
    for (const f of files) {
        const sub = path.join(projectDir, f);
        if (fs.statSync(sub).isDirectory()) {
            const subFiles = fs.readdirSync(sub);
            if (subFiles.includes('pom.xml')) return 'maven';
            if (subFiles.some(sf => sf.startsWith('playwright.config'))) return 'playwright';
        }
    }
    return 'unknown';
}

// Helper: find the actual project root (where pom.xml/playwright.config lives)
function findProjectRoot(extractDir, framework) {
    const files = fs.readdirSync(extractDir);
    const markerFiles = { maven: 'pom.xml', playwright: 'playwright.config', cypress: 'cypress.config' };
    const marker = markerFiles[framework];
    if (!marker) return extractDir;
    if (files.some(f => f === marker || f.startsWith(marker))) return extractDir;
    for (const f of files) {
        const sub = path.join(extractDir, f);
        if (fs.statSync(sub).isDirectory()) {
            const subFiles = fs.readdirSync(sub);
            if (subFiles.some(sf => sf === marker || sf.startsWith(marker))) return sub;
        }
    }
    return extractDir;
}

// ── Auto-Heal helpers (defined here so parseMavenResults/parsePlaywrightResults can call them) ──
const HEALABLE_PATTERNS = [
    /NoSuchElementException/i,
    /no such element/i,
    /Unable to locate element/i,
    /StaleElementReferenceException/i,
    /ElementNotInteractableException/i,
    /ElementClickInterceptedException/i,
    /element not found/i,
    /locator\..*timeout/i,
    /strict mode violation/i,
    /element is not attached/i,
    /getBy.*timeout exceeded/i,
    /TimeoutError.*locator/i,
    /Timed out retrying.*get\(\)/i,
];

function isHealable(errorMessage, stackTrace, errorType) {
    // Also check errorType (XML @_type attribute, e.g. org.openqa.selenium.NoSuchElementException)
    const text = `${errorMessage || ''} ${stackTrace || ''} ${errorType || ''}`;
    return HEALABLE_PATTERNS.some(p => p.test(text));
}

function extractLocator(errorMessage, stackTrace) {
    const text = `${errorMessage || ''} ${stackTrace || ''}`;
    // Selenium: {"method":"css selector","selector":"#id"} or {"method":"xpath","selector":"//btn"}
    const jsonSel = text.match(/\{"method":"([^"]+)","selector":"([^"]+)"\}/);
    if (jsonSel) return { strategy: jsonSel[1], value: jsonSel[2] };
    // Selenium: By.xpath("...") or By.id("...")
    const byMatch = text.match(/By\.(xpath|cssSelector|id|name|className|tagName|linkText)\("([^"]+)"\)/i);
    if (byMatch) return { strategy: byMatch[1], value: byMatch[2] };
    // Selenium findElement using= id/css
    const cmdMatch = text.match(/findElement \{using=([^,]+), value=([^}]+)\}/);
    if (cmdMatch) return { strategy: cmdMatch[1].trim(), value: cmdMatch[2].trim() };
    // Playwright: locator('...')
    const pwLocator = text.match(/locator\('([^']+)'\)/i);
    if (pwLocator) return { strategy: 'css', value: pwLocator[1] };
    // Playwright: getByRole
    const pwRole = text.match(/getByRole\('([^']+)'\)/i);
    if (pwRole) return { strategy: 'role', value: pwRole[1] };
    return null;
}

// Helper: parse Maven surefire XML reports
function parseMavenResults(projectRoot) {
    const suites = [];
    const seenTests = new Set(); // Track unique tests to prevent duplicates
    const reportDirs = [
        path.join(projectRoot, 'target', 'surefire-reports'),
        path.join(projectRoot, 'target', 'failsafe-reports'),
    ];
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

    for (const reportDir of reportDirs) {
        if (!fs.existsSync(reportDir)) continue;
        const allTestXmls = fs.readdirSync(reportDir).filter(f => f.startsWith('TEST-') && f.endsWith('.xml'));
        // Per-class files have dots in the name (e.g. TEST-com.example.LoginTest.xml)
        const perClassFiles = allTestXmls.filter(f => {
            const inner = f.replace('TEST-', '').replace('.xml', '');
            return inner.includes('.');
        });
        // Suite-level files don't have dots (e.g. TEST-TestSuite.xml)
        const suiteFiles = allTestXmls.filter(f => {
            const inner = f.replace('TEST-', '').replace('.xml', '');
            return !inner.includes('.');
        });

        // Prefer per-class files; if none, use only the FIRST suite file
        let toProcess;
        if (perClassFiles.length > 0) {
            toProcess = perClassFiles;
        } else if (suiteFiles.length > 0) {
            toProcess = [suiteFiles[0]];
        } else {
            const anyXml = fs.readdirSync(reportDir).filter(f => f.endsWith('.xml'));
            toProcess = anyXml.length > 0 ? [anyXml[0]] : [];
        }
        console.log(`[Parser] Report dir: ${reportDir}`);
        console.log(`[Parser] All TEST-*.xml: ${allTestXmls.join(', ')}`);
        console.log(`[Parser] Selected: ${toProcess.join(', ')}`);

        for (const file of toProcess) {
            try {
                const xml = fs.readFileSync(path.join(reportDir, file), 'utf-8');
                const parsed = parser.parse(xml);
                const ts = parsed.testsuite || parsed.testsuites?.testsuite;
                if (!ts) continue;
                const suitesArr = Array.isArray(ts) ? ts : [ts];
                for (const suite of suitesArr) {
                    const tests = [];
                    const tcs = suite.testcase ? (Array.isArray(suite.testcase) ? suite.testcase : [suite.testcase]) : [];
                    for (const tc of tcs) {
                        const testName = tc['@_name'] || tc.name || 'Unknown';
                        const className = tc['@_classname'] || '';
                        const uniqueKey = `${className}#${testName}`;

                        // Skip if we've already seen this exact test
                        if (seenTests.has(uniqueKey)) continue;
                        seenTests.add(uniqueKey);

                        const failed = tc.failure || tc.error;
                        const skipped = tc.skipped !== undefined;
                        const errorType = failed?.['@_type'] || failed?.type || '';
                        const errMsg = failed ? (failed['@_message'] || failed.message || String(failed).substring(0, 300)) : null;
                        const stackTr = failed ? (typeof failed === 'string' ? failed : (failed['#text'] || JSON.stringify(failed))) : null;
                        const healable = failed ? isHealable(errMsg, stackTr, errorType) : false;
                        // DEBUG — remove after confirmed working
                        if (failed) console.log(`[HEAL-DEBUG] test="${testName}" type="${errorType}" errMsgStart="${String(errMsg||'').substring(0,80)}" healable=${healable}`);
                        tests.push({
                            name: testName,
                            classname: className,
                            status: skipped ? 'SKIPPED' : failed ? 'FAILED' : 'PASSED',
                            duration: parseFloat(tc['@_time'] || 0).toFixed(3) + 's',
                            errorMessage: errMsg,
                            stackTrace: stackTr,
                            healable,
                            failedLocator: failed ? extractLocator(errMsg, stackTr) : null,
                        });
                    }
                    if (tests.length > 0) {
                        suites.push({
                            name: suite['@_name'] || suite.name || file.replace('.xml', ''),
                            tests,
                            duration: parseFloat(suite['@_time'] || 0).toFixed(3) + 's',
                        });
                    }
                }
            } catch (e) {
                console.error('Parse error for', file, e.message);
            }
        }
    }
    return suites;
}

// Helper: parse Playwright JSON reporter output
// Locate the start of Playwright's JSON report inside mixed (line+json) reporter
// output. The report is the trailing JSON object and begins with the root
// "config" key. The old marker ('{"version"') no longer matches modern
// Playwright reports, which silently yielded empty results (0 passed/failed).
function findPlaywrightJsonStart(text) {
    const cfgIdx = text.indexOf('"config"');
    if (cfgIdx === -1) return -1;
    return text.lastIndexOf('{', cfgIdx);
}

// Strip ANSI escape codes (e.g. Playwright embeds color codes in error
// messages). Built from a runtime char to keep the regex literal-free of
// control characters (avoids the no-control-regex lint rule).
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g');
function stripAnsi(s) {
    return typeof s === 'string' ? s.replace(ANSI_RE, '') : s;
}

// Accumulate live Playwright progress as output streams in, so the dashboard
// counters don't oscillate when the capped log buffer rotates. Failure blocks
// are numbered sequentially ("1) tests/…", "2) tests/…"), so the highest number
// seen is the cumulative failure count; "[N/total]" gives started/total. All
// values are tracked as running maxima — monotonic and eviction-proof.
function updatePlaywrightProgress(run, chunk) {
    if (!run || run.framework !== 'playwright') return;
    // Playwright prints "Running N tests using M worker(s)" when the test phase
    // actually starts. Reset and begin counting there, so earlier output — npm
    // install and (now) Playwright browser downloads, which ALSO emit "[1/3]"
    // style progress — can't pollute the live pass/fail counts and make them
    // jump (e.g. 3 → 0 → 3). Anything before this banner is ignored.
    const banner = chunk.match(/Running\s+(\d+)\s+tests?\s+using/);
    if (banner) {
        run.pwLive = { total: parseInt(banner[1], 10), started: 0, failed: 0 };
        run.pwCounting = true;
    }
    if (!run.pwCounting) return;
    const live = run.pwLive || (run.pwLive = { total: 0, started: 0, failed: 0 });
    let m;
    const progRe = /\[(\d+)\/(\d+)\]/g;
    while ((m = progRe.exec(chunk)) !== null) {
        const n = parseInt(m[1], 10), tot = parseInt(m[2], 10);
        if (n > live.started) live.started = n;
        if (tot > live.total) live.total = tot;
    }
    // Failure-summary entries are "  1) tests/x" or, when projects are used,
    // "  1) [chromium] › tests\x". Track the highest index (monotonic).
    const failRe = /(\d+)\)\s+(?:\[[^\]]+\]\s+›\s+)?tests[\\/]/g;
    while ((m = failRe.exec(chunk)) !== null) {
        const num = parseInt(m[1], 10);
        if (num > live.failed) live.failed = num;
    }
}

// Resolve Playwright results, preferring the JSON report file (written via
// PLAYWRIGHT_JSON_OUTPUT_NAME). The stdout log buffer is capped, so a large
// suite's report can have its start evicted — reading the file avoids that.
// Falls back to scraping the (possibly truncated) logs.
function readPlaywrightSuites(reportFile, allLogs) {
    try {
        if (reportFile && fs.existsSync(reportFile)) {
            const suites = parsePlaywrightResults(fs.readFileSync(reportFile, 'utf8'));
            if (suites.length > 0) return suites;
        }
    } catch { /* fall back to log scraping */ }
    const jsonStart = findPlaywrightJsonStart(allLogs);
    if (jsonStart !== -1) {
        try { return parsePlaywrightResults(allLogs.substring(jsonStart)); } catch { /* ignore */ }
    }
    return [];
}

function parsePlaywrightResults(jsonOutput) {
    const suites = [];
    try {
        const data = typeof jsonOutput === 'string' ? JSON.parse(jsonOutput) : jsonOutput;
        const processSuite = (suite) => {
            if (!suite) return;
            const tests = (suite.specs || []).map(spec => {
                const result = spec.tests?.[0]?.results?.[0];
                const status = result?.status === 'passed' ? 'PASSED'
                    : result?.status === 'failed' ? 'FAILED'
                        : result?.status === 'skipped' ? 'SKIPPED' : 'UNKNOWN';
                const errMsg = stripAnsi(result?.error?.message) || null;
                const stackTr = stripAnsi(result?.error?.stack) || null;
                return {
                    name: spec.title,
                    classname: suite.title,
                    status,
                    duration: result ? ((result.duration || 0) / 1000).toFixed(3) + 's' : '0s',
                    errorMessage: errMsg,
                    stackTrace: stackTr,
                    healable: status === 'FAILED' ? isHealable(errMsg, stackTr) : false,
                    failedLocator: status === 'FAILED' ? extractLocator(errMsg, stackTr) : null,
                };
            });
            if (tests.length > 0) {
                suites.push({ name: suite.title || 'Suite', tests, duration: '—' });
            }
            (suite.suites || []).forEach(processSuite);
        };
        (data.suites || []).forEach(processSuite);
    } catch (e) {
        console.error('Playwright parse error:', e.message);
    }
    return suites;
}

// Helper: build summary from suites
function buildSummary(suites) {
    let total = 0, passed = 0, failed = 0, skipped = 0, totalMs = 0;
    for (const suite of suites) {
        for (const test of suite.tests) {
            total++;
            if (test.status === 'PASSED') passed++;
            else if (test.status === 'FAILED') failed++;
            else if (test.status === 'SKIPPED') skipped++;
            const ms = parseFloat(test.duration) * 1000;
            if (!isNaN(ms)) totalMs += ms;
        }
    }
    return { total, passed, failed, skipped, duration: (totalMs / 1000).toFixed(2) + 's' };
}

// Helper: parse live test result from a console output line
function parseLiveResult(line, framework) {
    if (!line || typeof line !== 'string') return null;

    if (framework === 'maven') {
        // TestNG patterns: "PASSED: testMethodName" / "FAILED: testMethodName" / "SKIPPED: testMethodName"
        const testngMatch = line.match(/^\s*(PASSED|FAILED|SKIPPED):\s+(\S+)/m);
        if (testngMatch) {
            return { name: testngMatch[2], status: testngMatch[1], timestamp: Date.now() };
        }
        // Maven Surefire console: "Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.234 s -- in com.example.TestClass"
        // We skip these summary lines as individual PASSED/FAILED lines carry the detail
    }

    if (framework === 'playwright') {
        // Playwright patterns: "✓ [chromium] › file.spec.ts:10:5 › test name (1.2s)" or "✘ ..." or similar
        const pwPass = line.match(/[✓✔].*›\s+(.+?)\s+\(/m);
        if (pwPass) return { name: pwPass[1].trim(), status: 'PASSED', timestamp: Date.now() };
        const pwFail = line.match(/[✘✗×].*›\s+(.+?)\s+\(/m);
        if (pwFail) return { name: pwFail[1].trim(), status: 'FAILED', timestamp: Date.now() };
        const pwSkip = line.match(/-.*›\s+(.+?)\s+\(/m);
        if (pwSkip) return { name: pwSkip[1].trim(), status: 'SKIPPED', timestamp: Date.now() };
    }

    return null;
}

// Helper: run a command and stream logs
function runCommand(cmd, args, cwd, runId, onComplete, extraEnv = {}, options = {}) {
    // shell defaults to true (npm/mvn/cypress need PATH resolution via the shell).
    // Direct-Node Playwright invocations pass shell:false to avoid spawning a
    // cmd.exe per run — see playwrightSpawn() for why that matters on Windows.
    const useShell = options.shell !== false;
    console.log(`[Runner ${runId}] Running: ${cmd} ${args.join(' ')} in ${cwd}`);
    const child = spawn(cmd, args, { cwd, shell: useShell, env: { ...process.env, CI: 'true', ...extraEnv } });
    const run = runStore.get(runId);

    const processLine = (line) => {
        const result = parseLiveResult(line, run.framework);
        if (result) {
            // Deduplicate by name
            if (!run.liveResults.find(r => r.name === result.name)) {
                run.liveResults.push(result);
            }
        }
    };

    child.stdout.on('data', (data) => {
        const line = data.toString();
        appendRunLog(run, line);
        updatePlaywrightProgress(run, line);
        process.stdout.write(`[${runId}] ${line}`);
        line.split('\n').forEach(l => processLine(l));
    });
    child.stderr.on('data', (data) => {
        const line = data.toString();
        appendRunLog(run, line);
        updatePlaywrightProgress(run, line);
        line.split('\n').forEach(l => processLine(l));
    });
    child.on('close', (code) => {
        run.exitCode = code;
        onComplete(code);
    });
    child.on('error', (err) => {
        appendRunLog(run, `ERROR: ${err.message}\n`);
        run.status = 'error';
        run.error = err.message;
    });

    run.childProcess = child;
}

/**
 * Choose the npm install command for a JS/TS project. `npm ci` is faster and
 * reproducible but REQUIRES a package-lock.json; projects without one (e.g.
 * AAQUA-generated API test projects) must use `npm install`, which also
 * creates the lockfile.
 */
function npmInstallArgs(projectRoot) {
    const hasLock = fs.existsSync(path.join(projectRoot, 'package-lock.json'));
    return hasLock ? ['ci', '--prefer-offline'] : ['install'];
}

/**
 * Build a spawn descriptor that runs the project's local Playwright CLI directly
 * via Node (shell:false), instead of `npx playwright ...` through cmd.exe.
 *
 * Why: on Windows every `shell:true` spawn launches a cmd.exe, which consumes
 * desktop-heap. In the long-lived AAQUA server, after enough runs new child
 * processes fail to initialize at the OS level and exit with 0xC0000142
 * (STATUS_DLL_INIT_FAILED, decimal 3221225794) — before any test output appears.
 * Invoking node -> cli.js avoids the cmd.exe layer entirely.
 *
 * Falls back to the historic `npx playwright` form if the local CLI isn't present
 * (e.g. an unusual install layout), so behaviour is unchanged in that case.
 */
function playwrightSpawn(projectRoot, extraArgs) {
    const cli = path.join(projectRoot, 'node_modules', '@playwright', 'test', 'cli.js');
    if (fs.existsSync(cli)) {
        return { cmd: process.execPath, args: [cli, ...extraArgs], options: { shell: false } };
    }
    return { cmd: 'npx', args: ['playwright', ...extraArgs], options: {} };
}

/**
 * Decode opaque Windows NTSTATUS exit codes into a human-readable hint so the
 * run log explains an OS-level process-startup crash rather than printing a bare
 * 10-digit number. Returns '' for ordinary exit codes (0, 1, ...).
 */
function describeExitCode(code) {
    if (code === 3221225794) {
        return ' (0xC0000142 STATUS_DLL_INIT_FAILED — the OS could not start the test process; ' +
            'no tests ran. Usually transient on Windows: restart the AAQUA server (clears desktop-heap ' +
            'pressure) or exclude the run directory from antivirus, then re-run.)';
    }
    if (code === 3221225786) {
        return ' (0xC000013A — process was terminated, e.g. Ctrl-C or console close.)';
    }
    return '';
}

/**
 * Persist a Test Runner summary as an AutomationResult row so Release
 * Readiness can pick it up, then recompute the readiness profile.
 * No-op when projectId is missing (e.g. legacy callers that pre-date the
 * project selector wiring) or when the run produced zero tests.
 */
async function persistRunToReadiness(projectId, summary) {
    if (!projectId || !summary || !summary.total) return;
    try {
        const total = Number(summary.total) || 0;
        const passed = Number(summary.passed) || 0;
        const failed = Number(summary.failed) || 0;
        const passRate = total > 0 ? (passed / total) * 100 : 0;
        // summary.duration is a string like "12.34s" or "—"; pull the integer seconds.
        const durationMatch = typeof summary.duration === 'string' ? summary.duration.match(/[\d.]+/) : null;
        const duration = durationMatch ? Math.round(parseFloat(durationMatch[0])) : null;

        await AutomationResult.create({
            project_id: projectId,
            pass_rate: Math.round(passRate * 10) / 10,
            failed_tests: failed,
            total_tests: total,
            duration,
        });
        await calculateAndSaveReadiness(projectId);
    } catch (err) {
        console.error('[Runner] Failed to persist AutomationResult for readiness:', err.message);
    }
}

// POST /api/run-tests-local — Run tests from a local project directory
app.post('/api/run-tests-local', async (req, res) => {
    const { projectPath, isHeadless = true, projectId = null } = req.body;
    if (!projectPath) return res.status(400).json({ error: 'projectPath is required' });
    // Normalize path separators
    const normalizedPath = path.resolve(projectPath);

    if (!fs.existsSync(normalizedPath)) {
        return res.status(400).json({ error: `Path does not exist: ${normalizedPath}` });
    }
    if (!fs.statSync(normalizedPath).isDirectory()) {
        return res.status(400).json({ error: `Path is not a directory: ${normalizedPath}` });
    }

    const runId = crypto.randomBytes(6).toString('hex');

    runStore.set(runId, {
        status: 'detecting',
        logs: [],
        results: null,
        framework: null,
        projectPath: normalizedPath,
        projectRoot: null,
        failedTests: [],
        liveResults: [],
        exitCode: null,
        error: null,
        projectId,
    });

    try {
        const framework = detectFramework(normalizedPath);
        const projectRoot = findProjectRoot(normalizedPath, framework);
        const run = runStore.get(runId);
        run.framework = framework;
        run.projectRoot = projectRoot;

        if (framework === 'unknown') {
            run.status = 'error';
            run.error = 'Could not detect framework. Ensure pom.xml, playwright.config.*, or cypress.config.* is present.';
            return res.json({ runId, framework: 'unknown', error: run.error });
        }

        run.status = 'running';
        appendRunLog(run, `[AAQUA] Detected framework: ${framework.toUpperCase()}\n`);
        appendRunLog(run, `[AAQUA] Project root: ${projectRoot}\n`);
        appendRunLog(run, `[AAQUA] Starting test execution...\n`);

        res.json({ runId, framework });

        // Run tests asynchronously using existing helpers
        if (framework === 'maven') {
            // Delete old report directories to prevent live dashboard from showing stale results
            const reportDirs = [
                path.join(projectRoot, 'target', 'surefire-reports'),
                path.join(projectRoot, 'target', 'failsafe-reports'),
            ];
            for (const dir of reportDirs) {
                if (fs.existsSync(dir)) {
                    fs.rmSync(dir, { recursive: true, force: true });
                    console.log(`[Runner] Deleted old reports: ${dir}`);
                }
            }
            const mvnArgs = ['clean', 'test', '-fae', '--no-transfer-progress'];
            if (!isHeadless) mvnArgs.push('-Dheadless=false');
            runCommand('mvn', mvnArgs, projectRoot, runId, (code) => {
                const r = runStore.get(runId);
                appendRunLog(r, `\n[AAQUA] Process exited with code ${code}\n`);
                const suites = parseMavenResults(projectRoot);
                r.results = { suites, summary: buildSummary(suites) };
                r.failedTests = suites.flatMap(s => s.tests.filter(t => t.status === 'FAILED').map(t => ({ suite: s.name, name: t.name, classname: t.classname })));
                r.status = 'completed';
                persistRunLogs(runId, r);
                persistRunToReadiness(r.projectId, r.results.summary);
            });
        } else if (framework === 'playwright') {
            runCommand('npm', npmInstallArgs(projectRoot), projectRoot, runId, () => {
                const r2 = runStore.get(runId);
                r2.logs.push(`[AAQUA] Dependencies installed. Running Playwright...\n`);
                const reportFile = path.join(projectRoot, `aaqua-pw-${runId}.json`);
                const pwArgs = ['test', '--reporter=line,json', '--output=playwright-results'];
                if (!isHeadless) pwArgs.push('--headed');
                const pw = playwrightSpawn(projectRoot, pwArgs);
                runCommand(pw.cmd, pw.args, projectRoot, runId, (code) => {
                    const r3 = runStore.get(runId);
                    appendRunLog(r3, `\n[AAQUA] Process exited with code ${code}${describeExitCode(code)}\n`);
                    const suites = readPlaywrightSuites(reportFile, r3.logs.join(''));
                    r3.results = { suites, summary: buildSummary(suites) };
                    r3.failedTests = suites.flatMap(s => s.tests.filter(t => t.status === 'FAILED').map(t => ({ suite: s.name, name: t.name })));
                    r3.status = 'completed';
                    persistRunLogs(runId, r3);
                    persistRunToReadiness(r3.projectId, r3.results.summary);
                    try { fs.unlinkSync(reportFile); } catch { /* best-effort */ }
                }, { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile }, pw.options);
            });
        } else if (framework === 'cypress') {
            runCommand('npm', npmInstallArgs(projectRoot), projectRoot, runId, () => {
                const cyArgs = ['cypress', 'run', '--reporter', 'json'];
                if (!isHeadless) cyArgs.push('--headed');
                runCommand('npx', cyArgs, projectRoot, runId, (code) => {
                    const r3 = runStore.get(runId);
                    appendRunLog(r3, `\n[AAQUA] Cypress exited with code ${code}\n`);
                    r3.results = { suites: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: '—' } };
                    r3.status = 'completed';
                    persistRunLogs(runId, r3);
                    persistRunToReadiness(r3.projectId, r3.results.summary);
                });
            });
        }

    } catch (e) {
        console.error('Run tests local error:', e);
        const run = runStore.get(runId);
        if (run) { run.status = 'error'; run.error = e.message; }
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

// POST /api/run-tests — Upload zip and run
app.post('/api/run-tests', runnerUpload.single('projectZip'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No zip file uploaded' });

    // multer parses non-file form fields into req.body. The TestRunner UI
    // sends `headed` only when the host advertises a display server.
    const runHeaded = req.body?.headed === 'true' || req.body?.headed === true;
    const projectId = req.body?.projectId || null;

    const runId = crypto.randomBytes(6).toString('hex');
    const extractDir = path.join('temp_runner', runId);

    runStore.set(runId, {
        status: 'extracting',
        logs: [],
        results: null,
        framework: null,
        projectPath: extractDir,
        failedTests: [],
        liveResults: [],
        exitCode: null,
        error: null,
        projectId,
    });

    try {
        // Extract zip
        fs.mkdirSync(extractDir, { recursive: true });
        const zip = new AdmZip(req.file.path);
        zip.extractAllTo(extractDir, true);
        fs.unlinkSync(req.file.path);

        const framework = detectFramework(extractDir);
        const projectRoot = findProjectRoot(extractDir, framework);
        const run = runStore.get(runId);
        run.framework = framework;
        run.projectRoot = projectRoot;

        if (framework === 'unknown') {
            run.status = 'error';
            run.error = 'Could not detect framework. Ensure pom.xml, playwright.config.*, or cypress.config.* is present.';
            return res.json({ runId, framework: 'unknown', error: run.error });
        }

        run.status = 'running';
        appendRunLog(run, `[AAQUA] Detected framework: ${framework.toUpperCase()}\n`);
        appendRunLog(run, `[AAQUA] Project root: ${projectRoot}\n`);
        appendRunLog(run, `[AAQUA] Starting test execution...\n`);

        res.json({ runId, framework });

        // Run tests asynchronously
        if (framework === 'maven') {
            // Delete old report directories to prevent stale live dashboard
            for (const d of [path.join(projectRoot, 'target', 'surefire-reports'), path.join(projectRoot, 'target', 'failsafe-reports')]) {
                if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
            }
            runCommand('mvn', ['clean', 'test', '-fae', '--no-transfer-progress'], projectRoot, runId, (code) => {
                const run = runStore.get(runId);
                appendRunLog(run, `\n[AAQUA] Process exited with code ${code}\n`);
                const suites = parseMavenResults(projectRoot);
                run.results = { suites, summary: buildSummary(suites) };
                run.failedTests = suites.flatMap(s => s.tests.filter(t => t.status === 'FAILED').map(t => ({ suite: s.name, name: t.name, classname: t.classname })));
                run.status = 'completed';
                persistRunLogs(runId, run);
                persistRunToReadiness(run.projectId, run.results.summary);
            });
        } else if (framework === 'playwright') {
            // Install deps first
            runCommand('npm', npmInstallArgs(projectRoot), projectRoot, runId, () => {
                const run2 = runStore.get(runId);
                appendRunLog(run2, `[AAQUA] Dependencies installed. Running Playwright (${runHeaded ? 'headed' : 'headless'})...\n`);
                const reportFile = path.join(projectRoot, `aaqua-pw-${runId}.json`);
                const pwArgs = ['test', '--reporter=line,json', '--output=playwright-results'];
                if (runHeaded) pwArgs.push('--headed');
                const pw = playwrightSpawn(projectRoot, pwArgs);
                runCommand(pw.cmd, pw.args, projectRoot, runId, (code) => {
                    const run3 = runStore.get(runId);
                    appendRunLog(run3, `\n[AAQUA] Process exited with code ${code}${describeExitCode(code)}\n`);
                    const suites = readPlaywrightSuites(reportFile, run3.logs.join(''));
                    run3.results = { suites, summary: buildSummary(suites) };
                    run3.failedTests = suites.flatMap(s => s.tests.filter(t => t.status === 'FAILED').map(t => ({ suite: s.name, name: t.name })));
                    run3.status = 'completed';
                    persistRunLogs(runId, run3);
                    persistRunToReadiness(run3.projectId, run3.results.summary);
                    try { fs.unlinkSync(reportFile); } catch { /* best-effort */ }
                }, { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile }, pw.options);
            });
        } else if (framework === 'cypress') {
            runCommand('npm', npmInstallArgs(projectRoot), projectRoot, runId, () => {
                runCommand('npx', ['cypress', 'run', '--reporter', 'json'], projectRoot, runId, (code) => {
                    const run3 = runStore.get(runId);
                    appendRunLog(run3, `\n[AAQUA] Cypress exited with code ${code}\n`);
                    run3.results = { suites: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: '—' } };
                    run3.status = 'completed';
                    persistRunLogs(runId, run3);
                    persistRunToReadiness(run3.projectId, run3.results.summary);
                });
            });
        }

    } catch (e) {
        console.error('Run tests error:', e);
        const run = runStore.get(runId);
        if (run) { run.status = 'error'; run.error = e.message; }
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

// GET /api/heal-debug — Inspect all runs and healable detection (temporary debug route)
app.get('/api/heal-debug', (req, res) => {
    const runs = [];
    runStore.forEach((run, id) => {
        const failedTests = [];
        (run.results?.suites || []).forEach(suite => {
            suite.tests.forEach(t => {
                if (t.status === 'FAILED') {
                    failedTests.push({
                        name: t.name, classname: t.classname,
                        healable: t.healable, failedLocator: t.failedLocator,
                        errorMessageStart: String(t.errorMessage || '').substring(0, 150),
                    });
                }
            });
        });
        runs.push({ runId: id, status: run.status, framework: run.framework, failedTests });
    });
    res.json({ runs });
});

// GET /api/run-status/:runId — Poll status, logs, results
app.get('/api/run-status/:runId', (req, res) => {
    const run = runStore.get(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    // ── Live dashboard: parse console logs in real-time (works from the very first test) ──
    let liveResults = null;
    if (run.status === 'running') {
        try {
            const logText = run.logs.join('');

            if (run.framework === 'maven') {
                // ─ Parse Maven console output lines ─
                const suites = [];
                const suiteMap = {};

                // "Running com.example.LoginTest"
                const runningRe = /\[INFO\]\s+Running\s+([\w.]+)/g;
                let m;
                while ((m = runningRe.exec(logText)) !== null) {
                    const cls = m[1];
                    if (!suiteMap[cls]) {
                        suiteMap[cls] = { name: cls, tests: [], duration: '—', _passed: 0, _failed: 0, _skipped: 0, _running: true };
                        suites.push(suiteMap[cls]);
                    }
                }

                // "Tests run: 3, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 5.12 s -- in com.example.LoginTest"
                const doneRe = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+),\s*Time elapsed:\s*([\d.]+)\s*s\s*--\s*in\s+([\w.]+)/g;
                while ((m = doneRe.exec(logText)) !== null) {
                    const [, total, failures, errors, skipped, elapsed, cls] = m;
                    const passed = parseInt(total) - parseInt(failures) - parseInt(errors) - parseInt(skipped);
                    if (!suiteMap[cls]) {
                        suiteMap[cls] = { name: cls, tests: [], duration: elapsed + 's', _passed: 0, _failed: 0, _skipped: 0, _running: false };
                        suites.push(suiteMap[cls]);
                    }
                    const suite = suiteMap[cls];
                    suite._passed = passed;
                    suite._failed = parseInt(failures) + parseInt(errors);
                    suite._skipped = parseInt(skipped);
                    suite.duration = elapsed + 's';
                    suite._running = false;
                }

                // "FAILURE! testLogin(com.example.LoginTest)  Time elapsed: 4.98 s"
                const failRe = /\[ERROR\]\s+([\w]+)\(([\w.]+)\)\s+Time elapsed:\s*([\d.]+)\s*s\s+<<<\s+FAILURE/g;
                while ((m = failRe.exec(logText)) !== null) {
                    const [, testName, cls, elapsed] = m;
                    if (suiteMap[cls]) {
                        const already = suiteMap[cls].tests.find(t => t.name === testName);
                        if (!already) {
                            suiteMap[cls].tests.push({ name: testName, classname: cls, status: 'FAILED', duration: elapsed + 's', errorMessage: 'See logs', healable: false });
                        }
                    }
                }

                // Build test rows from counted stats where no individual test rows were captured
                suites.forEach(s => {
                    if (s.tests.length === 0 && !s._running) {
                        for (let i = 0; i < s._passed; i++) s.tests.push({ name: `Test ${i + 1}`, status: 'PASSED', duration: '—' });
                        for (let i = 0; i < s._failed; i++) s.tests.push({ name: `Failed Test ${i + 1}`, status: 'FAILED', duration: '—' });
                        for (let i = 0; i < s._skipped; i++) s.tests.push({ name: `Skipped Test ${i + 1}`, status: 'SKIPPED', duration: '—' });
                    } else if (s._running) {
                        s.tests.push({ name: '⏳ Running...', status: 'RUNNING', duration: '—' });
                    }
                });

                // Also try reading XML for completed classes (more accurate individual test names)
                try {
                    const xmlSuites = parseMavenResults(run.projectRoot);
                    xmlSuites.forEach(xs => {
                        const existing = suites.find(s => s.name === xs.name);
                        if (existing) {
                            // Replace generic rows with accurate XML rows
                            existing.tests = xs.tests;
                            existing.duration = xs.duration;
                        } else {
                            suites.push(xs);
                        }
                    });
                } catch { /* ignored */ }

                if (suites.length > 0) {
                    const summary = buildSummary(suites);
                    liveResults = { suites, summary };
                }
            } else if (run.framework === 'playwright') {
                // Use the cumulative counters from updatePlaywrightProgress
                // (eviction-proof), not a re-scan of the capped log buffer.
                const p = run.pwLive;
                if (p && (p.total > 0 || p.started > 0)) {
                    const failed = p.failed;
                    // "started" counts tests begun; begun-minus-failed is a
                    // provisional pass count (in-flight tests may still fail).
                    const passed = Math.max(0, p.started - failed);
                    const total = p.total || p.started;
                    liveResults = {
                        suites: [{ name: 'Live Progress', tests: [], duration: '—' }],
                        summary: { total, passed, failed, skipped: 0, duration: '—' },
                    };
                }
            }
        } catch { /* ignore live parse errors */ }
    }

    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    const tail = run.logs.slice(since);
    const cursor = run.logs.length;

    res.json({
        status: run.status,
        framework: run.framework,
        logs: tail.join(''),
        cursor,
        results: run.results,
        liveResults: liveResults,
        failedCount: run.failedTests?.length || 0,
        projectRoot: run.projectRoot || null,
        error: run.error || null,
    });
});

// POST /api/retry-tests/:runId — Retry only failed tests
app.post('/api/retry-tests/:runId', (req, res) => {
    const prevRun = runStore.get(req.params.runId);
    if (!prevRun) return res.status(404).json({ error: 'Original run not found' });
    if (!prevRun.failedTests?.length) return res.status(400).json({ error: 'No failed tests to retry' });

    const retryRunId = crypto.randomBytes(6).toString('hex');
    runStore.set(retryRunId, {
        status: 'running',
        logs: [`[AAQUA] Retrying ${prevRun.failedTests.length} failed test(s)...\n`],
        results: null,
        framework: prevRun.framework,
        projectRoot: prevRun.projectRoot,
        failedTests: [],
        liveResults: [],
        exitCode: null,
        error: null,
        projectId: prevRun.projectId || null,
    });

    res.json({ runId: retryRunId, framework: prevRun.framework });

    const { framework, projectRoot, failedTests } = prevRun;

    if (framework === 'maven') {
        // Build -Dtest=Class#method filter
        const testFilter = failedTests.map(t => {
            const cls = t.classname ? t.classname.split('.').pop() : t.suite;
            return `${cls}#${t.name}`;
        }).join(',');
        appendRunLog(runStore.get(retryRunId), `[AAQUA] Filter: -Dtest=${testFilter}\n`);
        runCommand('mvn', ['test', '-fae', '--no-transfer-progress', `-Dtest=${testFilter}`], projectRoot, retryRunId, (code) => {
            const run = runStore.get(retryRunId);
            appendRunLog(run, `\n[AAQUA] Retry process exited with code ${code}\n`);
            const suites = parseMavenResults(projectRoot);
            run.results = { suites, summary: buildSummary(suites) };
            run.failedTests = suites.flatMap(s => s.tests.filter(t => t.status === 'FAILED').map(t => ({ suite: s.name, name: t.name, classname: t.classname })));
            run.status = 'completed';
            persistRunLogs(retryRunId, run);
            // Retries execute only the previously-failed subset, so their summary
            // is NOT representative of the full suite — intentionally NOT persisted
            // to Release Readiness (it would clobber the last full run, e.g. show
            // 0/29 for a retry of 29 failures and trip the automation hard gate).
        });
    } else if (framework === 'playwright') {
        // Re-run only previously-failed tests via Playwright's --last-failed
        // (reads <outputDir>/.last-run.json). Avoids a giant --grep alternation
        // of test titles, whose "|" separators and spaces were parsed by the
        // shell as pipes/commands ("'Add' is not recognized").
        const reportFile = path.join(projectRoot, `aaqua-pw-${retryRunId}.json`);
        const pwRetry = playwrightSpawn(projectRoot, ['test', '--last-failed', '--reporter=line,json', '--output=playwright-results']);
        runCommand(pwRetry.cmd, pwRetry.args, projectRoot, retryRunId, (code) => {
            const run = runStore.get(retryRunId);
            appendRunLog(run, `\n[AAQUA] Retry exited with code ${code}${describeExitCode(code)}\n`);
            const suites = readPlaywrightSuites(reportFile, run.logs.join(''));
            run.results = { suites, summary: buildSummary(suites) };
            run.failedTests = suites.flatMap(s => s.tests.filter(t => t.status === 'FAILED').map(t => ({ suite: s.name, name: t.name })));
            run.status = 'completed';
            persistRunLogs(retryRunId, run);
            // Retries run only the failed subset (not representative) — intentionally
            // NOT persisted to Release Readiness. See the Maven retry above.
            try { fs.unlinkSync(reportFile); } catch { /* best-effort */ }
        }, { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile }, pwRetry.options);
    }
});

// GET /api/runtime-info — Lets the UI decide whether to show env-dependent
// controls (e.g. the headed-mode toggle). Reports whether the host has a
// display server and whether we're running inside a container. Unauthenticated
// because the response carries no secrets and the UI needs it before the
// auth flow has completed for some routes.
app.get('/api/runtime-info', (req, res) => {
    res.json({
        hasDisplayServer: !!process.env.DISPLAY,
        isContainer: fs.existsSync('/.dockerenv'),
        platform: process.platform,
    });
});

// ─── API test generation: parse an OpenAPI/Swagger spec into a catalog ───
// Phase A1 of the API/BPMN test-gen plan. Accepts the spec three ways:
//   - multipart file upload (field "specFile")
//   - JSON body { specUrl }   (SSRF-validated)
//   - JSON body { specText }  (raw JSON/YAML)
// Returns a normalized endpoint catalog. No script generation yet.
app.post('/api/parse-spec', upload.fields([{ name: 'specFile', maxCount: 1 }, { name: 'envFile', maxCount: 1 }]), async (req, res) => {
    const specFile = req.files && req.files.specFile && req.files.specFile[0];
    const envFile = req.files && req.files.envFile && req.files.envFile[0];
    try {
        let input;

        if (specFile) {
            input = { type: 'file', value: specFile.path };
        } else if (req.body && req.body.specUrl) {
            const check = await validateHttpUrl(req.body.specUrl);
            if (!check.valid) {
                return res.status(400).json({ error: check.error });
            }
            input = { type: 'url', value: check.href };
        } else if (req.body && req.body.specText) {
            input = { type: 'text', value: req.body.specText };
        } else {
            return res.status(400).json({ error: 'Provide a spec via specFile (upload), specUrl, or specText.' });
        }

        // Optional Postman environment file — resolves {{variables}} in a collection.
        if (envFile) {
            input.envValue = fs.readFileSync(envFile.path, 'utf8');
        }

        const catalog = await parseSpec(input);
        res.json(catalog);
    } catch (err) {
        console.error('[ParseSpec] error:', err.message);
        res.status(400).json({ error: `Failed to parse API spec: ${err.message}` });
    } finally {
        // Clean up the multer temp uploads regardless of outcome.
        for (const f of [specFile, envFile]) {
            if (f) { try { fs.unlinkSync(f.path); } catch { /* best-effort */ } }
        }
    }
});

// ─── API test generation (Phase A2): catalog → abstract test cases ───
// Accepts { endpoints, categories }. endpoints come from /api/parse-spec.
// Returns per-endpoint generated test cases (no code emission — that's A3).
app.post('/api/generate-api-testcases', async (req, res) => {
    try {
        const { endpoints, categories } = req.body || {};
        if (!Array.isArray(endpoints) || endpoints.length === 0) {
            return res.status(400).json({ error: 'endpoints array is required (from /api/parse-spec).' });
        }

        let apiKey = req.headers['x-api-key'];
        if (apiKey === 'undefined' || apiKey === 'null') apiKey = null;
        apiKey = apiKey || process.env.VITE_LLM_API_KEY;
        if (!apiKey) {
            return res.status(401).json({ error: 'LLM API key missing (send x-api-key or set VITE_LLM_API_KEY).' });
        }

        const results = await generateApiTestCases(endpoints, { categories }, apiKey);
        res.json({ results });
    } catch (err) {
        console.error('[GenerateApiTestCases] error:', err.message);
        res.status(500).json({ error: `Failed to generate test cases: ${err.message}` });
    }
});

// ─── API test generation (Phase A3): cases → runnable project ZIP ───
// Deterministic emitters (no LLM) render the A2 cases the client already has
// into a REST Assured (Java) or Playwright (TS) project, streamed as a ZIP.
// Body: { framework: 'restassured'|'playwright', info:{title,serverUrl}, groups:[{operationId,method,path,tags,secured,cases}] }
app.post('/api/generate-api-tests', (req, res) => {
    try {
        const { framework, info, groups } = req.body || {};
        if (!Array.isArray(groups) || groups.length === 0) {
            return res.status(400).json({ error: 'groups array is required (endpoints with generated cases).' });
        }
        if (!['restassured', 'playwright'].includes(framework)) {
            return res.status(400).json({ error: "framework must be 'restassured' or 'playwright'." });
        }

        const files = framework === 'restassured'
            ? emitRestAssured({ info: info || {}, groups })
            : emitPlaywright({ info: info || {}, groups });

        const zip = new AdmZip();
        for (const [relPath, contents] of Object.entries(files)) {
            zip.addFile(relPath, Buffer.from(contents, 'utf8'));
        }
        const buffer = zip.toBuffer();

        const safe = String((info && info.title) || 'api').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'api';
        const filename = `${safe}-${framework}-tests.zip`;
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename=${filename}`);
        res.set('Access-Control-Expose-Headers', 'Content-Disposition');
        res.send(buffer);
    } catch (err) {
        console.error('[GenerateApiTests] error:', err.message);
        res.status(500).json({ error: `Failed to generate project: ${err.message}` });
    }
});

// ─── k6 load test (Phase 4, generate-only): catalog → runnable k6 script ───
// Body: { info:{title,serverUrl}, endpoints:[{method,path,...}] }. Returns a ZIP
// (load-test.js + README) the team runs themselves — no k6 dependency in AAQUA.
app.post('/api/generate-load-test', (req, res) => {
    try {
        const { info, endpoints } = req.body || {};
        if (!Array.isArray(endpoints) || endpoints.length === 0) {
            return res.status(400).json({ error: 'endpoints array is required.' });
        }
        const files = emitK6({ info: info || {}, endpoints });
        const zip = new AdmZip();
        for (const [relPath, contents] of Object.entries(files)) {
            zip.addFile(relPath, Buffer.from(contents, 'utf8'));
        }
        const buffer = zip.toBuffer();
        const safe = String((info && info.title) || 'api').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'api';
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename=${safe}-k6-load-test.zip`);
        res.set('Access-Control-Expose-Headers', 'Content-Disposition');
        res.send(buffer);
    } catch (err) {
        console.error('[GenerateLoadTest] error:', err.message);
        res.status(500).json({ error: `Failed to generate load test: ${err.message}` });
    }
});

// ─── API flow generation (Phase B1): catalog → ordered process flows ───
// For process-orchestrated (BPMN/Camunda) APIs. LLM infers ordered flows whose
// steps chain ids captured from earlier responses. Body: { endpoints, info }.
app.post('/api/generate-api-flows', async (req, res) => {
    try {
        const { endpoints, info } = req.body || {};
        if (!Array.isArray(endpoints) || endpoints.length === 0) {
            return res.status(400).json({ error: 'endpoints array is required (from /api/parse-spec).' });
        }
        let apiKey = req.headers['x-api-key'];
        if (apiKey === 'undefined' || apiKey === 'null') apiKey = null;
        apiKey = apiKey || process.env.VITE_LLM_API_KEY;
        if (!apiKey) {
            return res.status(401).json({ error: 'LLM API key missing (send x-api-key or set VITE_LLM_API_KEY).' });
        }

        const flows = await generateFlows(endpoints, { info }, apiKey);
        res.json({ flows });
    } catch (err) {
        console.error('[GenerateApiFlows] error:', err.message);
        res.status(500).json({ error: `Failed to generate flows: ${err.message}` });
    }
});

// ─── API flow generation (Phase B3): flows → runnable Playwright ZIP ───
// Body: { info:{title,serverUrl,auth,dataVars}, flows:[{name,description,steps}] }
app.post('/api/generate-api-flow-tests', (req, res) => {
    try {
        const { info, flows } = req.body || {};
        if (!Array.isArray(flows) || flows.length === 0) {
            return res.status(400).json({ error: 'flows array is required.' });
        }

        const files = emitPlaywrightFlows({ info: info || {}, flows });
        const zip = new AdmZip();
        for (const [relPath, contents] of Object.entries(files)) {
            zip.addFile(relPath, Buffer.from(contents, 'utf8'));
        }
        const buffer = zip.toBuffer();

        const safe = String((info && info.title) || 'api').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'api';
        const filename = `${safe}-playwright-flows.zip`;
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename=${filename}`);
        res.set('Access-Control-Expose-Headers', 'Content-Disposition');
        res.send(buffer);
    } catch (err) {
        console.error('[GenerateApiFlowTests] error:', err.message);
        res.status(500).json({ error: `Failed to generate flow project: ${err.message}` });
    }
});

// ─── Projects: cross-cutting resource shared by every feature ────────────
// Projects are not security-specific — Scan, AutomationResult,
// AccessibilityResult, LocalizationResult, and ReleaseReadiness all hang off
// Project — so the CRUD lives at the top level.
app.use('/api/projects', securityRateLimiter, projectRoutes);

// ─── AI Secure Engine: Mount security routes ────────────
// Authentication is owned by Keycloak; no /api/security/auth endpoints — clients
// obtain tokens via the OIDC code+PKCE flow against the realm directly.
app.use('/api/security/scan', securityRateLimiter, scanRoutes);
app.use('/api/security/dashboard', securityRateLimiter, dashboardRoutes);
app.use('/api/security/governance', securityRateLimiter, governanceRoutes);
app.use('/api/jira', securityRateLimiter, jiraRoutes);
app.use('/api/readiness', securityRateLimiter, readinessRoutes);
app.use('/api/admin/usage', securityRateLimiter, adminRoutes);

// ZAP health check (no auth required)
app.get('/api/security/zap/health', async (req, res) => {
    try {
        const { healthCheck } = await import('./services/zapService.js');
        const status = await healthCheck();
        res.json(status);
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// ─── AUTO-HEAL ENDPOINTS (purely additive) ───
// ═══════════════════════════════════════════════════════════════

// In-memory store for batch heal jobs
const batchStore = new Map();

// ── POST /api/auto-heal — Analyse one test, return locator suggestions ──
app.post('/api/auto-heal', async (req, res) => {
    const { testName, classname, errorMessage, stackTrace, pageUrl } = req.body;
    if (!pageUrl) return res.status(400).json({ error: 'pageUrl is required' });

    let browser;
    try {
        const { chromium } = require('playwright');
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const dom = await page.content();
        const domTruncated = dom.substring(0, 18000); // keep under token limit

        const failedLocatorInfo = extractLocator(errorMessage, stackTrace);
        const locatorDesc = failedLocatorInfo
            ? `${failedLocatorInfo.strategy}("${failedLocatorInfo.value}")`
            : '(locator not extractable from error)';

        const prompt = `You are a test automation expert. A Selenium/Playwright locator has broken.

Failed locator: ${locatorDesc}
Error message: ${errorMessage || '(none)'}
Test: ${classname || ''}.${testName || ''}

Here is the current live page DOM (truncated):
${domTruncated}

Suggest 5 alternative locators for the same element that is likely missing or renamed.
Return ONLY valid JSON — no explanation, no markdown:
{ "suggestions": [ { "strategy": "xpath|css|id|name", "locator": "...", "confidence": 0-100, "description": "why this works" } ] }`;

        const apiKey = process.env.VITE_LLM_API_KEY;
        const endpoint = process.env.VITE_LLM_ENDPOINT || 'https://llm.lab.aaseya.com/v1';
        const llmModel = process.env.VITE_LLM_MODEL || 'gemma-4';
        const genAI = new GoogleGenerativeAI(apiKey, endpoint);
        const model = genAI.getGenerativeModel({ 
            model: llmModel,
            generationConfig: { temperature: 0.2 }
        });
        const result = await model.generateContent(prompt);
        const text = result.response.text();

        // Parse JSON from response
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        let suggestions = [];
        if (jsonStart !== -1 && jsonEnd !== -1) {
            const parsed = JSON.parse(text.substring(jsonStart, jsonEnd + 1));
            suggestions = parsed.suggestions || [];
        }
        // Sort by confidence desc
        suggestions.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
        res.json({ suggestions, failedLocator: failedLocatorInfo });

    } catch (err) {
        console.error('[AutoHeal] Error:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
});

// ── POST /api/auto-heal-batch — Queue multiple healable tests ──
app.post('/api/auto-heal-batch', async (req, res) => {
    const { runId, tests } = req.body;
    if (!Array.isArray(tests) || tests.length === 0) {
        return res.status(400).json({ error: 'tests array is required' });
    }

    const batchId = crypto.randomBytes(6).toString('hex');
    const batchResults = tests.map(t => ({
        testName: t.testName,
        classname: t.classname,
        pageUrl: t.pageUrl,
        errorMessage: t.errorMessage,
        stackTrace: t.stackTrace,
        status: 'pending',
        suggestions: [],
        appliedLocator: null,
        reRunStatus: null,
        reason: null,
    }));

    batchStore.set(batchId, { total: tests.length, processed: 0, results: batchResults, runId });
    res.json({ batchId });

    // Process sequentially in background
    (async () => {
        const batch = batchStore.get(batchId);
        for (let i = 0; i < batch.results.length; i++) {
            const item = batch.results[i];
            item.status = 'healing';
            let browser;
            try {
                if (!item.pageUrl) {
                    item.status = 'conflict';
                    item.reason = 'No page URL provided';
                    batch.processed++;
                    continue;
                }

                const { chromium } = require('playwright');
                browser = await chromium.launch({
                    headless: true,
                    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox']
                });
                const page = await browser.newPage();
                await page.goto(item.pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const dom = (await page.content()).substring(0, 18000);

                const failedLocatorInfo = extractLocator(item.errorMessage, item.stackTrace);
                const locatorDesc = failedLocatorInfo
                    ? `${failedLocatorInfo.strategy}("${failedLocatorInfo.value}")`
                    : '(locator not extractable)';

                const prompt = `You are a test automation expert. A Selenium/Playwright locator has broken.

Failed locator: ${locatorDesc}
Error: ${item.errorMessage || '(none)'}
Test: ${item.classname || ''}.${item.testName || ''}

Current page DOM (truncated):
${dom}

Suggest 5 alternative locators. Return ONLY valid JSON:
{ "suggestions": [ { "strategy": "xpath|css|id|name", "locator": "...", "confidence": 0-100, "description": "why this works" } ] }`;

                const apiKey = process.env.VITE_LLM_API_KEY;
                const endpoint = process.env.VITE_LLM_ENDPOINT || 'https://llm.lab.aaseya.com/v1';
                const llmModel = process.env.VITE_LLM_MODEL || 'gemma-4';
                const genAI = new GoogleGenerativeAI(apiKey, endpoint);
                const model = genAI.getGenerativeModel({ 
                    model: llmModel,
                    generationConfig: { temperature: 0.2 }
                });
                const result = await model.generateContent(prompt);
                const text = result.response.text();

                const jsonStart = text.indexOf('{');
                const jsonEnd = text.lastIndexOf('}');
                if (jsonStart !== -1 && jsonEnd !== -1) {
                    const parsed = JSON.parse(text.substring(jsonStart, jsonEnd + 1));
                    item.suggestions = (parsed.suggestions || []).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
                }

                item.status = item.suggestions.length > 0 ? 'suggestions-ready' : 'no-suggestion';
            } catch (err) {
                console.error(`[AutoHeal Batch] ${item.testName} error:`, err.message);
                item.status = 'no-suggestion';
                item.reason = err.message;
            } finally {
                if (browser) await browser.close().catch(() => {});
                batch.processed++;
            }
        }
    })();
});

// ── GET /api/heal-batch-status/:batchId — Poll batch progress ──
app.get('/api/heal-batch-status/:batchId', (req, res) => {
    const batch = batchStore.get(req.params.batchId);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    res.json({ total: batch.total, processed: batch.processed, results: batch.results });
});

// ── POST /api/apply-heal — Patch source file + re-run single test ──
app.post('/api/apply-heal', async (req, res) => {
    const { runId, testName, classname, oldLocator, newLocator, newStrategy, projectRoot: bodyProjectRoot, framework: bodyFramework } = req.body;
    if (!classname || !oldLocator || !newLocator) {
        return res.status(400).json({ error: 'classname, oldLocator, newLocator are required' });
    }

    try {
        // Prefer values from body (always available); fall back to runStore if provided
        let projectRoot = bodyProjectRoot;
        let framework = bodyFramework;
        if (framework) framework = framework.toLowerCase();
        if (runId && runStore.has(runId)) {
            const run = runStore.get(runId);
            projectRoot = projectRoot || run.projectRoot;
            framework = framework || run.framework;
            if (framework) framework = framework.toLowerCase();
        }
        if (!projectRoot || !framework) {
            return res.status(400).json({ error: 'projectRoot and framework are required (or a valid runId)' });
        }

        // ── We will search all project files for the locator later ──

        // ── Normalize the failed locator: strip CSS escapes and leading # ──
        // "#user\-name1" → "user-name1"
        const rawId = oldLocator.replace(/\\-/g, '-').replace(/\\./g, '.').replace(/^#/, '').trim();

        // ── Build candidate search patterns ──
        const searchPatterns = [];
        if (framework === 'playwright' || framework === 'cypress') {
            searchPatterns.push(`locator("${oldLocator}")`);
            searchPatterns.push(`locator('${oldLocator}')`);
            searchPatterns.push(`locator(\`${oldLocator}\`)`);
            searchPatterns.push(`get("${oldLocator}")`);
            searchPatterns.push(`get('${oldLocator}')`);
            searchPatterns.push(`get(\`${oldLocator}\`)`);
            searchPatterns.push(`"${oldLocator}"`);
            searchPatterns.push(`'${oldLocator}'`);
            searchPatterns.push(`\`${oldLocator}\``);
        } else {
            if (oldLocator.startsWith('#') || oldLocator.replace(/\\-/g, '-').startsWith('#')) {
                // CSS id selector — could be By.id or By.cssSelector in source
                searchPatterns.push(`By.id("${rawId}")`);
                searchPatterns.push(`By.cssSelector("#${rawId}")`);
                searchPatterns.push(`@FindBy(id = "${rawId}")`);
                searchPatterns.push(`@FindBy(css = "#${rawId}")`);
                searchPatterns.push(`"${rawId}"`);
            } else if (oldLocator.startsWith('//') || oldLocator.startsWith('(//')) {
                searchPatterns.push(`By.xpath("${oldLocator}")`);
                searchPatterns.push(`"${oldLocator}"`);
            } else if (oldLocator.startsWith('[name=') || (newStrategy || '').toLowerCase() === 'name') {
                searchPatterns.push(`By.name("${rawId}")`);
                searchPatterns.push(`"${rawId}"`);
            } else {
                searchPatterns.push(`By.cssSelector("${oldLocator}")`);
                searchPatterns.push(`"${rawId}"`);
            }
        }

        // ── Find the pattern in any project file ──
        const glob = require('glob');
        let allFiles = [];
        if (framework === 'maven') {
            allFiles = glob.sync('**/*.java', { cwd: projectRoot, ignore: ['**/target/**', '**/node_modules/**'] }).map(f => require('path').join(projectRoot, f));
        } else {
            allFiles = glob.sync('**/*.{js,ts}', { cwd: projectRoot, ignore: ['**/node_modules/**', '**/dist/**'] }).map(f => require('path').join(projectRoot, f));
        }

        let sourceFile = null;
        let foundPattern = null;
        let fileContent = null;

        for (const f of allFiles) {
            const contentStr = fs.readFileSync(f, 'utf-8');
            for (const p of searchPatterns) {
                const count = contentStr.split(p).length - 1;
                if (count === 1) {
                    sourceFile = f;
                    foundPattern = p;
                    fileContent = contentStr;
                    break;
                }
                if (count > 1) {
                    return res.status(409).json({ error: `Pattern "${p}" found ${count} times in ${require('path').basename(f)} — manual review required` });
                }
            }
            if (foundPattern) break;
        }

        if (!foundPattern || !sourceFile) {
            return res.status(400).json({
                error: `Could not locate the locator in any project file.\nSearched for:\n• ${searchPatterns.join('\n• ')}\n\nPlease apply the fix manually.`
            });
        }
        
        const content = fileContent;

        // ── Convert LLM suggestion to Java Selenium syntax ──

        function toJavaSyntax(val, strat) {
            const s = (strat || '').toLowerCase();
            if (s === 'id') return `By.id("${val}")`;
            if (s === 'xpath') return `By.xpath("${val}")`;
            if (s === 'name') return `By.name("${val}")`;
            if (s === 'classname' || s === 'class') return `By.className("${val}")`;
            if (s === 'linktext') return `By.linkText("${val}")`;
            if (s === 'partiallinktext') return `By.partialLinkText("${val}")`;
            if (s === 'tagname') return `By.tagName("${val}")`;
            return `By.cssSelector("${val}")`;
        }

        let replacement;
        if (framework === 'playwright' || framework === 'cypress') {
            if (foundPattern.startsWith('locator(')) {
                const quote = foundPattern.charAt(8);
                replacement = `locator(${quote}${newLocator}${quote})`;
            } else if (foundPattern.startsWith('get(')) {
                const quote = foundPattern.charAt(4);
                replacement = `get(${quote}${newLocator}${quote})`;
            } else {
                const quote = foundPattern.charAt(0);
                replacement = `${quote}${newLocator}${quote}`;
            }
        } else {
            if (foundPattern.startsWith('@FindBy')) {
                const s = (newStrategy || 'css').toLowerCase();
                if (s === 'id') replacement = `@FindBy(id = "${newLocator}")`;
                else if (s === 'xpath') replacement = `@FindBy(xpath = "${newLocator}")`;
                else if (s === 'name') replacement = `@FindBy(name = "${newLocator}")`;
                else replacement = `@FindBy(css = "${newLocator}")`;
            } else if (foundPattern.startsWith('"') && foundPattern.endsWith('"')) {
                replacement = `"${newLocator}"`;
            } else {
                replacement = toJavaSyntax(newLocator, newStrategy);
            }
        }

        // Create backup before patching
        fs.writeFileSync(sourceFile + '.bak', content, 'utf-8');
        const patched = content.replace(foundPattern, replacement);
        fs.writeFileSync(sourceFile, patched, 'utf-8');
        console.log(`[ApplyHeal] Patched: "${foundPattern}" → "${replacement}" in ${path.basename(sourceFile)}`);

        // Re-run only this test
        const healRunId = crypto.randomBytes(6).toString('hex');
        runStore.set(healRunId, {
            status: 'running', logs: [], results: null, framework,
            projectPath: projectRoot, projectRoot, failedTests: [], liveResults: [], exitCode: null, error: null,
        });

        res.json({ healRunId, sourceFile, backupFile: sourceFile + '.bak', patchedFrom: foundPattern, patchedTo: replacement });

        // Fire the re-run asynchronously
        if (framework === 'maven') {
            const simpleClass = classname.split('.').pop();
            runCommand('mvn', ['test', `-Dtest=${simpleClass}`, '-fae', '--no-transfer-progress'], projectRoot, healRunId, (code) => {
                const r = runStore.get(healRunId);
                r.logs.push(`\n[AAQUA] Heal re-run exited with code ${code}\n`);
                const suites = parseMavenResults(projectRoot);
                r.results = { suites, summary: buildSummary(suites) };
                r.failedTests = suites.flatMap(s => s.tests.filter(t => t.status === 'FAILED').map(t => ({ suite: s.name, name: t.name })));
                r.status = 'completed';
            });
        } else if (framework === 'playwright' && sourceFile) {
            const relSpec = path.relative(projectRoot, sourceFile);
            const reportFile = path.join(projectRoot, `aaqua-pw-${healRunId}.json`);
            const pwHeal = playwrightSpawn(projectRoot, ['test', relSpec, `--grep=${testName}`, '--reporter=line,json']);
            runCommand(pwHeal.cmd, pwHeal.args, projectRoot, healRunId, (code) => {
                const r = runStore.get(healRunId);
                r.logs.push(`\n[AAQUA] Heal re-run exited with code ${code}${describeExitCode(code)}\n`);
                const suites = readPlaywrightSuites(reportFile, r.logs.join(''));
                r.results = { suites, summary: buildSummary(suites) };
                r.status = 'completed';
                try { fs.unlinkSync(reportFile); } catch { /* best-effort */ }
            }, { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile }, pwHeal.options);
        }

    } catch (err) {
        console.error('[ApplyHeal] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Browse Directory Endpoint ───────────────────────────
app.get('/api/browse-folder', (req, res) => {
    const psScript = `
Add-Type -AssemblyName System.windows.forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = 'Select Project Folder'
$f.ShowNewFolderButton = $false
if($f.ShowDialog() -eq 'OK'){
    Write-Output $f.SelectedPath
}
`;
    const { exec } = require('child_process');
    exec(`powershell -Sta -NoProfile -WindowStyle Hidden -Command "${psScript.replace(/\n/g, ';')}"`, (err, stdout) => {
        if (err || !stdout.trim()) {
            return res.json({ path: '' });
        }
        res.json({ path: stdout.trim() });
    });
});

// ─── Start server ────────────────────────────────────────
(async () => {
    await initDatabase();
    app.listen(PORT, () => {
        console.log(`Backend Server running on http://localhost:${PORT}`);
        console.log(`Security API: http://localhost:${PORT}/api/security`);
    });
})();
