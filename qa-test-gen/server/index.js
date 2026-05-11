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
import { initDatabase } from './models/index.js';
import projectRoutes from './routes/projectRoutes.js';
import scanRoutes from './routes/scanRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import governanceRoutes from './routes/governanceRoutes.js';
import { securityRateLimiter } from './middleware/rateLimiter.js';
import { generateWithRetry } from './utils/aiUtils.js';

import express from 'express';
import { chromium } from 'playwright';
import cors from 'cors';

const app = express();
const PORT = 3001;
// Increase payload size limit for zip uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

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
        const model = genAI.getGenerativeModel({ model: process.env.VITE_LLM_MODEL || "gpt-oss-20b" });

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

            const prompt = `
                You are a Test Migration Expert. Convert the following Selenium code to ${targetFramework}.
                File: ${relativePath}
                
                Rules:
                1. Keep the same test structure logic.
                2. Use modern ${targetFramework} patterns (e.g. Page Object Model if apparent).
                3. Return ONLY the code. No markdown formatting.
                
                Content:
                ${content}
            `;

            try {
                let text = await generateWithRetry(prompt);

                // Clean markdown
                text = text.replace(/```[a-z]*\n?/g, '').replace(/```/g, '');

                const targetFile = path.join(outputPath, relativePath);
                fs.mkdirSync(path.dirname(targetFile), { recursive: true });
                fs.writeFileSync(targetFile, text);
            } catch (aiErr) {
                console.error(`Failed to convert ${relativePath}`, aiErr);
                // Write original file as fallback with comment
                const targetFile = path.join(outputPath, relativePath);
                fs.mkdirSync(path.dirname(targetFile), { recursive: true });
                fs.writeFileSync(targetFile, `// CONVERSION FAILED: ${aiErr.message}\n` + content);
            }
        }

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
async function generatePlaywrightTypeScript(outputPath, projectName, features) {
    // package.json
    const packageJson = {
        name: projectName,
        version: '1.0.0',
        scripts: {
            test: 'playwright test',
            'test:headed': 'playwright test --headed',
            'test:debug': 'playwright test --debug',
            report: features.reporting === 'Allure' ? 'allure generate ./allure-results --clean && allure open' : 'playwright show-report'
        },
        devDependencies: {
            '@playwright/test': '^1.40.0',
            'typescript': '^5.0.0',
            ...(features.reporting === 'Allure' && { 'allure-playwright': '^2.15.0', 'allure-commandline': '^2.25.0' }),
            ...(features.logging && { 'winston': '^3.11.0' })
        }
    };
    fs.writeFileSync(path.join(outputPath, 'package.json'), JSON.stringify(packageJson, null, 2));

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
    baseURL: 'https://example.com',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});`;
    fs.writeFileSync(path.join(outputPath, 'playwright.config.ts'), playwrightConfig);

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
    fs.writeFileSync(path.join(outputPath, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));

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
        fs.writeFileSync(path.join(outputPath, 'pages', 'BasePage.ts'), basePage);

        const loginPage = `import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class LoginPage extends BasePage {
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;

  constructor(page: Page) {
    super(page);
    this.usernameInput = page.locator('#username');
    this.passwordInput = page.locator('#password');
    this.loginButton = page.locator('button[type="submit"]');
  }

  async login(username: string, password: string) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }
}`;
        fs.writeFileSync(path.join(outputPath, 'pages', 'LoginPage.ts'), loginPage);
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
        fs.writeFileSync(path.join(outputPath, 'utils', 'logger.ts'), logger);
        fs.mkdirSync(path.join(outputPath, 'logs'), { recursive: true });
    }

    // Sample test
    const sampleTest = `import { test, expect } from '@playwright/test';
${features.pageObjectModel ? "import { LoginPage } from '../pages/LoginPage';" : ''}
${features.logging ? "import { logger } from '../utils/logger';" : ''}

test.describe('Login Tests', () => {
  test('should login successfully', async ({ page }) => {
    ${features.logging ? "logger.info('Starting login test');" : ''}
    ${features.pageObjectModel ? `
    const loginPage = new LoginPage(page);
    await loginPage.navigate('/login');
    await loginPage.login('testuser', 'password123');
    ` : `
    await page.goto('/login');
    await page.fill('#username', 'testuser');
    await page.fill('#password', 'password123');
    await page.click('button[type="submit"]');
    `}
    await expect(page).toHaveURL(/dashboard/);
    ${features.logging ? "logger.info('Login test completed');" : ''}
  });
});`;
    fs.writeFileSync(path.join(outputPath, 'tests', 'login.spec.ts'), sampleTest);

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
        fs.writeFileSync(path.join(outputPath, '.github', 'workflows', 'test.yml'), githubActions);
    }

    // Dockerfile
    if (features.docker) {
        const dockerfile = `FROM mcr.microsoft.com/playwright:v1.40.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "test"]`;
        fs.writeFileSync(path.join(outputPath, 'Dockerfile'), dockerfile);
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
    fs.writeFileSync(path.join(outputPath, 'README.md'), readme);
}

async function generatePlaywrightJavaScript(outputPath, projectName, features) {
    const packageJson = {
        name: projectName,
        version: '1.0.0',
        scripts: {
            test: 'playwright test',
            'test:headed': 'playwright test --headed',
            'test:debug': 'playwright test --debug',
            report: features.reporting === 'Allure' ? 'allure generate ./allure-results --clean && allure open' : 'playwright show-report'
        },
        devDependencies: {
            '@playwright/test': '^1.40.0',
            ...(features.reporting === 'Allure' && { 'allure-playwright': '^2.15.0', 'allure-commandline': '^2.25.0' }),
            ...(features.logging && { 'winston': '^3.11.0' })
        }
    };
    fs.writeFileSync(path.join(outputPath, 'package.json'), JSON.stringify(packageJson, null, 2));

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
    baseURL: 'https://example.com',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});`;
    fs.writeFileSync(path.join(outputPath, 'playwright.config.js'), playwrightConfig);

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
        fs.writeFileSync(path.join(outputPath, 'pages', 'BasePage.js'), basePage);

        const loginPage = `const { BasePage } = require('./BasePage');
class LoginPage extends BasePage {
  constructor(page) {
    super(page);
    this.usernameInput = page.locator('#username');
    this.passwordInput = page.locator('#password');
    this.loginButton = page.locator('button[type="submit"]');
  }
  async login(username, password) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }
}
module.exports = { LoginPage };`;
        fs.writeFileSync(path.join(outputPath, 'pages', 'LoginPage.js'), loginPage);
    }

    const sampleTest = `const { test, expect } = require('@playwright/test');
${features.pageObjectModel ? "const { LoginPage } = require('../pages/LoginPage');" : ''}

test.describe('Login Tests', () => {
  test('should login successfully', async ({ page }) => {
    ${features.pageObjectModel ? `const loginPage = new LoginPage(page);
    await loginPage.navigate('https://example.com/login');
    await loginPage.login('testuser', 'password123');` : `await page.goto('https://example.com/login');
    await page.fill('#username', 'testuser');
    await page.fill('#password', 'password123');
    await page.click('button[type="submit"]');`}
  });
});`;
    fs.writeFileSync(path.join(outputPath, 'tests', 'login.spec.js'), sampleTest);

    const readme = `# ${projectName}\n\nPlaywright JavaScript Framework\n\n## Setup\n\`\`\`bash\nnpm install\nnpx playwright install\n\`\`\`\n\n## Run Tests\n\`\`\`bash\nnpm test\n\`\`\``;
    fs.writeFileSync(path.join(outputPath, 'README.md'), readme);
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
    fs.writeFileSync(path.join(outputPath, 'package.json'), JSON.stringify(packageJson, null, 2));

    const readme = `# ${projectName}\n\nCypress ${language} Framework`;
    fs.writeFileSync(path.join(outputPath, 'README.md'), readme);
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
    const configProperties = `base.url=https://example.com
browser=chrome
headless=false
implicit.wait=10
explicit.wait=10`;
    fs.writeFileSync(path.join(mainResourcesPath, 'config.properties'), configProperties);

    // 3. testdata.json
    const testData = `[
  {
    "username": "testuser",
    "password": "password123",
    "expectedTitle": "Dashboard"
  }
]`;
    fs.writeFileSync(path.join(mainResourcesPath, 'testdata.json'), testData);

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
    fs.writeFileSync(path.join(mainResourcesPath, 'log4j2.xml'), log4j2Xml);

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
    <test name="Login Tests">
        <classes>
            <class name="${groupId}.${packageName}.tests.LoginTest"/>
        </classes>
    </test>
</suite>`;
    fs.writeFileSync(path.join(testResourcesPath, 'testng.xml'), testngXml);

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
    fs.writeFileSync(path.join(outputPath, '.github', 'workflows', 'test.yml'), githubActions);

    // 7. Dockerfile
    const dockerfile = `FROM maven:3.9.6-eclipse-temurin-17
WORKDIR /app
COPY . .
RUN mvn dependency:go-offline
CMD ["mvn", "test"]`;
    fs.writeFileSync(path.join(outputPath, 'Dockerfile'), dockerfile);

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
    fs.writeFileSync(path.join(outputPath, 'pom.xml'), pomXml);

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
    fs.writeFileSync(path.join(mainJavaPath, 'utils', 'ConfigReader.java'), configReader);

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
    fs.writeFileSync(path.join(mainJavaPath, 'utils', 'DriverManager.java'), driverManager);

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
    fs.writeFileSync(path.join(mainJavaPath, 'utils', 'WaitUtils.java'), waitUtils);

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
    fs.writeFileSync(path.join(mainJavaPath, 'pages', 'BasePage.java'), basePage);

    // 13. LoginPage.java
    const loginPage = `package ${groupId}.${packageName}.pages;

import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.FindBy;

public class LoginPage extends BasePage {

    @FindBy(id = "username")
    private WebElement usernameInput;

    @FindBy(id = "password")
    private WebElement passwordInput;

    @FindBy(xpath = "//button[@type='submit']")
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
    fs.writeFileSync(path.join(mainJavaPath, 'pages', 'LoginPage.java'), loginPage);

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
    fs.writeFileSync(path.join(testJavaPath, 'tests', 'BaseTest.java'), baseTest);

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
        loginPage.navigateTo(baseUrl + "/login");
        loginPage.login("testuser", "password123");
        Assert.assertTrue(driver.getCurrentUrl().contains("dashboard"), "Login failed!");
    }
}`;
    fs.writeFileSync(path.join(testJavaPath, 'tests', 'LoginTest.java'), loginTest);

    // 15.1 Cucumber Specific Files
    if (isCucumber) {
        // Feature File
        const featureFile = `Feature: Login Functionality
  Scenario: Successful login with valid credentials
    Given I am on the login page
    When I enter valid username and password
    Then I should be redirected to the dashboard`;
        fs.writeFileSync(path.join(testResourcesPath, 'features', 'login.feature'), featureFile);

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
        loginPage.navigateTo(baseUrl + "/login");
    }

    @When("I enter valid username and password")
    public void i_enter_valid_username_and_password() {
        loginPage.login("testuser", "password123");
    }

    @Then("I should be redirected to the dashboard")
    public void i_should_be_redirected_to_the_dashboard() {
        Assert.assertTrue(DriverManager.getDriver().getCurrentUrl().contains("dashboard"));
        DriverManager.quitDriver();
    }
}`;
        fs.writeFileSync(path.join(testJavaPath, 'stepdefinitions', 'LoginStepDefinitions.java'), stepdefs);

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
        fs.writeFileSync(path.join(testJavaPath, 'runners', 'CucumberTestRunner.java'), runner);
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

## Setup
\`\`\`bash
mvn clean install
\`\`\`

## Run Tests
\`\`\`bash
mvn test
\`\`\``;
    fs.writeFileSync(path.join(outputPath, 'README.md'), readme);
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
        const launchHeadless = process.env.HEADLESS !== 'false';
        activeBrowser = await chromium.launch({
            headless: launchHeadless,
        });

        activeContext = await activeBrowser.newContext({
            viewport: null // maximize viewport
        });

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

        console.log(`Captured ${cookies.length} cookies and HTML.`);

        // DO NOT close the browser here. Keep it open for further navigation.

        res.json({ cookies, html });
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

// Scrape endpoint (POST to accept body with cookies) - Headless Mode
app.post('/api/scrape', async (req, res) => {
    const { url, cookies } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    let browser = null;
    let context = null;
    let page = null;

    try {
        console.log(`Launching scraper for: ${url}`);

        browser = await chromium.launch({
            headless: true
        });

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
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Extra safety wait for dynamic content
        try {
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
        } catch (e) {
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

// Localization Analysis Endpoint
app.post('/api/analyze-localization', async (req, res) => {
    const { html, targetLanguage } = req.body;
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) return res.status(401).json({ error: 'API Key missing' });
    if (!html || !targetLanguage) return res.status(400).json({ error: 'HTML and Target Language required' });

    try {
        const endpoint = process.env.VITE_LLM_ENDPOINT || 'https://llm.lab.aaseya.com/v1';
        const llmModel = process.env.VITE_LLM_MODEL || 'gpt-oss-20b';
        const genAI = new GoogleGenerativeAI(apiKey, endpoint);
        const model = genAI.getGenerativeModel({ model: llmModel });

        // Determine if target is an English dialect (American vs British)
        const isEnglishDialect = targetLanguage.includes('American English') || targetLanguage.includes('British English');
        const isAmericanEnglish = targetLanguage.includes('American English');
        const isBritishEnglish = targetLanguage.includes('British English');

        // Aggressively clean the HTML (strip scripts, styles, SVGs, and empty space) to massively reduce token size
        const cleanHtml = html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
            .replace(/<path\b[^<]*(?:(?!<\/path>)<[^<]*)*<\/path>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        let prompt;

        if (isEnglishDialect) {
            // English dialect prompt: check for spelling/vocabulary inconsistencies
            const dialectFrom = isAmericanEnglish ? 'British English' : 'American English';
            const dialectTo = isAmericanEnglish ? 'American English (en-US)' : 'British English (en-GB)';
            const spellingExamples = isAmericanEnglish
                ? 'colour→color, organisation→organization, centre→center, behaviour→behavior, whilst→while, autumn→fall, boot (car)→trunk, tyre→tire'
                : 'color→colour, organize→organise, center→centre, behavior→behaviour, while→whilst, fall→autumn, trunk (car)→boot, tire→tyre';

            prompt = `
                You are a Localization QA Expert specializing in English dialect consistency.
                The page SHOULD be written in ${dialectTo}.
                
                Scan the visible text in the provided HTML for words or phrases that use ${dialectFrom} spelling or vocabulary instead of ${dialectTo}.
                
                Focus on:
                1. Spelling differences (examples: ${spellingExamples}).
                2. Vocabulary differences (e.g., "elevator" vs "lift", "cookie" vs "biscuit", "vacation" vs "holiday").
                3. Date/number format issues (e.g., MM/DD/YYYY vs DD/MM/YYYY if visible).
                
                Ignore proper nouns, brand names, and technical terms.
                
                For each issue found, provide:
                - "original": The text as found on the page.
                - "suggestion": The corrected ${dialectTo} version.
                - "context": A brief description of where it appears (e.g., "Submit Button", "Error Message").
                
                HTML CONTENT (Truncated for analysis):
                ${cleanHtml.substring(0, 200000)}
                
                OUTPUT FORMAT:
                Return ONLY a valid JSON array of objects. No markdown.
                [
                    { "original": "colour", "suggestion": "color", "context": "Label in Settings Panel" }
                ]
            `;
        } else {
            // Standard foreign language prompt: check for English text leaking into non-English pages
            prompt = `
                You are a highly precise Localization QA Expert. Your sole task is to exhaustively scan the provided HTML for a non-English website and find EVERY piece of English text. The web page SHOULD be fully translated into ${targetLanguage}.
                
                You MUST identify EVERY SINGLE INSTANCE of text visible to the user that is leaking in ENGLISH (or any language other than ${targetLanguage}).
                
                RULES:
                1. Only check the visible text content INSIDE the HTML tags. CRITICAL: Do NOT flag HTML tag names, CSS classes, URLs, or code attribute values as English text!
                2. Explicitly ignore proper nouns, global brand names, and technical product names.
                3. Do not summarize or be lazy. You must extract every single sentence, button label, or paragraph that failed to translate.

                For each issue found, provide:
                - "original": The text found.
                - "suggestion": A purely hypothetical translation to ${targetLanguage} (just to show intent).
                - "context": A brief CSS selector or description of where it is (e.g., "Login Button", "Footer Link").

                HTML CONTENT (Truncated for analysis):
                ${cleanHtml.substring(0, 200000)}

                OUTPUT FORMAT:
                Return ONLY a valid JSON array of objects. No markdown.
                [
                    { "original": "Sign In", "suggestion": "Inloggen", "context": "button.login-btn" }
                ]
            `;
        }

        const responseText = (await generateWithRetry(model, prompt)).replace(/```json/g, '').replace(/```/g, '').trim();

        try {
            const issues = JSON.parse(responseText);
            res.json({ issues });
        } catch (e) {
            console.error("AI response parsing failed:", responseText);
            res.status(500).json({ error: "Failed to parse analysis results", raw: responseText });
        }

    } catch (error) {
        console.error('Localization Analysis Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Accessibility Analysis Endpoint
app.post('/api/analyze-accessibility', async (req, res) => {
    if (!activeContext || !activePage) {
        return res.status(400).json({ error: 'No active browser session found' });
    }
    const apiKey = req.headers['x-api-key']; // Should be passed from frontend if client manages it, but we can also use env if backend manages it.
    // However, other endpoints use req.headers['x-api-key'], let's check if frontend sends it. 
    // accessibilityService.js currently DOES NOT send x-api-key. 
    // We should probably rely on the Backend environment variable here since it's a backend feature, OR update frontend to send it.
    // Existing code uses API Key from env for other things? 
    // Wait, localization analysis uses req.headers['x-api-key'].
    // Framework generator uses env? 
    // Locator generator uses client side.

    // Let's assume we use the process.env.VITE_GEMINI_API_KEY (or similar) if header is missing, 
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

        // Sanitize auth key (sometimes "undefined" string is passed)
        if (authKey === 'undefined' || authKey === 'null') {
            authKey = null;
        }

        if (authKey) {
            console.log(`Running AI Audit via Gemini... Key present (Starts with ${authKey.substring(0, 4)}...)`);
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
                const model = genAI.getGenerativeModel({ model: process.env.VITE_LLM_MODEL || "gpt-oss-20b" });

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
        } else {
            console.log("Skipping AI Audit: No API Key provided in headers.");
            aiAudit = { error: "API Key missing. Please ensure a valid API Key is provided in the request headers." };
        }

        console.log(`Scan complete. Found ${axeResults.violations.length} axe violations.`);
        if (aiAudit && !aiAudit.error) console.log(`AI Audit complete. Found ${aiAudit.issues?.length || 0} issues.`);

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
        fs.writeFileSync(path.join(RUN_LOGS_DIR, `${runId}.log`), run.logs.join(''));
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
                        tests.push({
                            name: testName,
                            classname: className,
                            status: skipped ? 'SKIPPED' : failed ? 'FAILED' : 'PASSED',
                            duration: parseFloat(tc['@_time'] || 0).toFixed(3) + 's',
                            errorMessage: failed ? (failed['@_message'] || failed.message || String(failed).substring(0, 200)) : null,
                            stackTrace: failed ? (typeof failed === 'string' ? failed : JSON.stringify(failed)) : null,
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
                return {
                    name: spec.title,
                    classname: suite.title,
                    status,
                    duration: result ? ((result.duration || 0) / 1000).toFixed(3) + 's' : '0s',
                    errorMessage: result?.error?.message || null,
                    stackTrace: result?.error?.stack || null,
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
function runCommand(cmd, args, cwd, runId, onComplete) {
    console.log(`[Runner ${runId}] Running: ${cmd} ${args.join(' ')} in ${cwd}`);
    const child = spawn(cmd, args, { cwd, shell: true, env: { ...process.env, CI: 'true' } });
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
        process.stdout.write(`[${runId}] ${line}`);
        line.split('\n').forEach(l => processLine(l));
    });
    child.stderr.on('data', (data) => {
        const line = data.toString();
        appendRunLog(run, line);
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

// POST /api/run-tests-local — Run tests from a local project directory
app.post('/api/run-tests-local', async (req, res) => {
    const { projectPath, headed } = req.body;
    if (!projectPath) return res.status(400).json({ error: 'projectPath is required' });
    // headed is only honoured when the host has a display server. We still
    // accept the flag here and let Playwright fail loudly in a headless
    // container — the UI hides the toggle when /api/runtime-info reports no
    // display so misconfiguration is rare in practice.
    const runHeaded = headed === true || headed === 'true';

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
            runCommand('mvn', ['clean', 'test', '-fae', '--no-transfer-progress'], projectRoot, runId, (code) => {
                const r = runStore.get(runId);
                appendRunLog(r, `\n[AAQUA] Process exited with code ${code}\n`);
                const suites = parseMavenResults(projectRoot);
                r.results = { suites, summary: buildSummary(suites) };
                r.failedTests = suites.flatMap(s => s.tests.filter(t => t.status === 'FAILED').map(t => ({ suite: s.name, name: t.name, classname: t.classname })));
                r.status = 'completed';
                persistRunLogs(runId, r);
            });
        } else if (framework === 'playwright') {
            runCommand('npm', ['ci', '--prefer-offline'], projectRoot, runId, () => {
                const r2 = runStore.get(runId);
                appendRunLog(r2, `[AAQUA] Dependencies installed. Running Playwright (${runHeaded ? 'headed' : 'headless'})...\n`);
                const pwArgs = ['playwright', 'test', '--reporter=line,json', '--output=playwright-results'];
                if (runHeaded) pwArgs.push('--headed');
                runCommand('npx', pwArgs, projectRoot, runId, (code) => {
                    const r3 = runStore.get(runId);
                    appendRunLog(r3, `\n[AAQUA] Process exited with code ${code}\n`);
                    const allLogs = r3.logs.join('');
                    const jsonStart = allLogs.lastIndexOf('{"version"');
                    let suites = [];
                    if (jsonStart !== -1) {
                        try { suites = parsePlaywrightResults(allLogs.substring(jsonStart)); } catch (_) { }
                    }
                    r3.results = { suites, summary: buildSummary(suites) };
                    r3.failedTests = suites.flatMap(s => s.tests.filter(t => t.status === 'FAILED').map(t => ({ suite: s.name, name: t.name })));
                    r3.status = 'completed';
                    persistRunLogs(runId, r3);
                });
            });
        } else if (framework === 'cypress') {
            runCommand('npm', ['ci', '--prefer-offline'], projectRoot, runId, () => {
                runCommand('npx', ['cypress', 'run', '--reporter', 'json'], projectRoot, runId, (code) => {
                    const r3 = runStore.get(runId);
                    appendRunLog(r3, `\n[AAQUA] Cypress exited with code ${code}\n`);
                    r3.results = { suites: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: '—' } };
                    r3.status = 'completed';
                    persistRunLogs(runId, r3);
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
            });
        } else if (framework === 'playwright') {
            // Install deps first
            runCommand('npm', ['ci', '--prefer-offline'], projectRoot, runId, () => {
                const run2 = runStore.get(runId);
                appendRunLog(run2, `[AAQUA] Dependencies installed. Running Playwright (${runHeaded ? 'headed' : 'headless'})...\n`);
                const pwArgs = ['playwright', 'test', '--reporter=json', '--output=playwright-results'];
                if (runHeaded) pwArgs.push('--headed');
                runCommand('npx', pwArgs, projectRoot, runId, (code) => {
                    const run3 = runStore.get(runId);
                    appendRunLog(run3, `\n[AAQUA] Process exited with code ${code}\n`);
                    // Try to read json from stdout logs
                    const allLogs = run3.logs.join('');
                    const jsonStart = allLogs.lastIndexOf('{"version"');
                    let suites = [];
                    if (jsonStart !== -1) {
                        try { suites = parsePlaywrightResults(allLogs.substring(jsonStart)); } catch (_) { }
                    }
                    run3.results = { suites, summary: buildSummary(suites) };
                    run3.failedTests = suites.flatMap(s => s.tests.filter(t => t.status === 'FAILED').map(t => ({ suite: s.name, name: t.name })));
                    run3.status = 'completed';
                    persistRunLogs(runId, run3);
                });
            });
        } else if (framework === 'cypress') {
            runCommand('npm', ['ci', '--prefer-offline'], projectRoot, runId, () => {
                runCommand('npx', ['cypress', 'run', '--reporter', 'json'], projectRoot, runId, (code) => {
                    const run3 = runStore.get(runId);
                    appendRunLog(run3, `\n[AAQUA] Cypress exited with code ${code}\n`);
                    run3.results = { suites: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: '—' } };
                    run3.status = 'completed';
                    persistRunLogs(runId, run3);
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

// GET /api/run-status/:runId?since=<cursor> — Poll status, logs delta, results
//
// `since` is the chunk index returned by a prior call's `cursor` field. Clients
// pass it back to receive only new log content since the last poll, which is
// much cheaper than re-shipping the whole buffer every 1.5s. Omitting `since`
// (or passing 0) returns the full buffer — used on initial mount and after
// page reloads.
app.get('/api/run-status/:runId', (req, res) => {
    const run = runStore.get(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    // Build live dashboard from partial surefire reports while still running
    let liveResults = null;
    if (run.status === 'running' && run.framework === 'maven' && run.projectRoot) {
        try {
            const suites = parseMavenResults(run.projectRoot);
            if (suites.length > 0) {
                const summary = buildSummary(suites);
                liveResults = { suites, summary };
            }
        } catch (e) { /* ignore parse errors during execution */ }
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
        });
    } else if (framework === 'playwright') {
        const grepPattern = failedTests.map(t => t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        runCommand('npx', ['playwright', 'test', '--reporter=line,json', '--grep', grepPattern], projectRoot, retryRunId, (code) => {
            const run = runStore.get(retryRunId);
            appendRunLog(run, `\n[AAQUA] Retry exited with code ${code}\n`);
            const allLogs = run.logs.join('');
            const jsonStart = allLogs.lastIndexOf('{"version"');
            let suites = [];
            if (jsonStart !== -1) { try { suites = parsePlaywrightResults(allLogs.substring(jsonStart)); } catch (_) { } }
            run.results = { suites, summary: buildSummary(suites) };
            run.failedTests = suites.flatMap(s => s.tests.filter(t => t.status === 'FAILED').map(t => ({ suite: s.name, name: t.name })));
            run.status = 'completed';
            persistRunLogs(retryRunId, run);
        });
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

// ─── AI Secure Engine: Mount security routes ────────────
// Authentication is owned by Keycloak; no /api/security/auth endpoints — clients
// obtain tokens via the OIDC code+PKCE flow against the realm directly.
app.use('/api/security/projects', securityRateLimiter, projectRoutes);
app.use('/api/security/scan', securityRateLimiter, scanRoutes);
app.use('/api/security/dashboard', securityRateLimiter, dashboardRoutes);
app.use('/api/security/governance', securityRateLimiter, governanceRoutes);

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

// ─── Start server ────────────────────────────────────────
(async () => {
    await initDatabase();
    app.listen(PORT, () => {
        console.log(`Backend Server running on http://localhost:${PORT}`);
        console.log(`Security API: http://localhost:${PORT}/api/security`);
    });
})();
