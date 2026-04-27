const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'server', 'index.js');
let content = fs.readFileSync(file, 'utf8');

// 1. Directory Structure Generic Replaced
const genericDirLogic = `        // For non-Java projects, create standard JS/TS structure
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
        } else {`;
const specificDirLogic = `        // Create framework-specific standard layouts
        if (framework === 'Playwright') {
            fs.mkdirSync(path.join(outputPath, 'tests'), { recursive: true });
            fs.mkdirSync(path.join(outputPath, 'utils'), { recursive: true });
            if (features.pageObjectModel) fs.mkdirSync(path.join(outputPath, 'pages'), { recursive: true });
            if (features.reporting) fs.mkdirSync(path.join(outputPath, 'reports'), { recursive: true });
        } else if (framework === 'Cypress') {
            fs.mkdirSync(path.join(outputPath, 'cypress', 'e2e'), { recursive: true });
            fs.mkdirSync(path.join(outputPath, 'cypress', 'fixtures'), { recursive: true });
            fs.mkdirSync(path.join(outputPath, 'cypress', 'support'), { recursive: true });
            if (features.pageObjectModel) fs.mkdirSync(path.join(outputPath, 'cypress', 'pages'), { recursive: true });
            if (features.reporting) fs.mkdirSync(path.join(outputPath, 'reports'), { recursive: true });
        } else if (!(framework === 'Selenium' && language === 'Java')) {
            fs.mkdirSync(path.join(outputPath, 'src', 'tests'), { recursive: true });
        } else {`;
content = content.replace(genericDirLogic, specificDirLogic);

// 2. Fix Playwright TypeScript paths from src/ to root
content = content.replace(/testDir: '\.\/src\/tests',/g, "testDir: './tests',");
content = content.replace(/'src', 'pages', 'BasePage\.ts'/g, "'pages', 'BasePage.ts'");
content = content.replace(/'src', 'pages', 'LoginPage\.ts'/g, "'pages', 'LoginPage.ts'");
content = content.replace(/'src', 'utils', 'logger\.ts'/g, "'utils', 'logger.ts'");
content = content.replace(/'src', 'tests', 'login\.spec\.ts'/g, "'tests', 'login.spec.ts'");

// 3. Replace Playwright JS implementation
const pwJsOldRegex = /async function generatePlaywrightJavaScript[\s\S]*?function generateCypress/m;
const pwJsNew = `async function generatePlaywrightJavaScript(outputPath, projectName, features) {
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

    const playwrightConfig = \`const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: \${features.parallel},
  workers: \${features.parallel ? 'process.env.CI ? 1 : undefined' : '1'},
  reporter: [
    ['html'],
    \${features.reporting === 'Allure' ? "['allure-playwright']," : ''}
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
});\`;
    fs.writeFileSync(path.join(outputPath, 'playwright.config.js'), playwrightConfig);

    if (features.pageObjectModel) {
        const basePage = \`class BasePage {
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
module.exports = { BasePage };\`;
        fs.writeFileSync(path.join(outputPath, 'pages', 'BasePage.js'), basePage);

        const loginPage = \`const { BasePage } = require('./BasePage');
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
module.exports = { LoginPage };\`;
        fs.writeFileSync(path.join(outputPath, 'pages', 'LoginPage.js'), loginPage);
    }

    const sampleTest = \`const { test, expect } = require('@playwright/test');
\${features.pageObjectModel ? "const { LoginPage } = require('../pages/LoginPage');" : ''}

test.describe('Login Tests', () => {
  test('should login successfully', async ({ page }) => {
    \${features.pageObjectModel ? \`const loginPage = new LoginPage(page);
    await loginPage.navigate('https://example.com/login');
    await loginPage.login('testuser', 'password123');\` : \`await page.goto('https://example.com/login');
    await page.fill('#username', 'testuser');
    await page.fill('#password', 'password123');
    await page.click('button[type="submit"]');\`}
  });
});\`;
    fs.writeFileSync(path.join(outputPath, 'tests', 'login.spec.js'), sampleTest);

    const readme = \`# \${projectName}\\n\\nPlaywright JavaScript Framework\\n\\n## Setup\\n\\\`\\\`\\\`bash\\nnpm install\\nnpx playwright install\\n\\\`\\\`\\\`\\n\\n## Run Tests\\n\\\`\\\`\\\`bash\\nnpm test\\n\\\`\\\`\\\`\`;
    fs.writeFileSync(path.join(outputPath, 'README.md'), readme);
}

async function generateCypress`;
content = content.replace(pwJsOldRegex, pwJsNew);

// 4. Replace Cypress implementation
const cyOldRegex = /async function generateCypress[\s\S]*?fs\.writeFileSync\(path\.join\(outputPath, 'README\.md'\), readme\);\n\}/m;
const cyNew = `async function generateCypress(outputPath, projectName, features, language) {
    const isTS = language === 'TypeScript';
    const ext = isTS ? 'ts' : 'js';

    const packageJson = {
        name: projectName,
        version: '1.0.0',
        scripts: {
            'test': 'cypress run',
            'cy:open': 'cypress open'
        },
        devDependencies: {
            'cypress': '^13.6.0',
            ...(isTS && { 'typescript': '^5.0.0' })
        }
    };
    fs.writeFileSync(path.join(outputPath, 'package.json'), JSON.stringify(packageJson, null, 2));

    if (isTS) {
        const tsConfig = {
            compilerOptions: {
                target: 'es5',
                lib: ['es5', 'dom'],
                types: ['cypress', 'node']
            },
            include: ['**/*.ts']
        };
        fs.writeFileSync(path.join(outputPath, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));
    }

    const configContent = isTS 
        ? \`import { defineConfig } from "cypress";\\n\\nexport default defineConfig({\\n  e2e: {\\n    setupNodeEvents(on, config) {},\\n    baseUrl: 'https://example.com',\\n  },\\n});\`
        : \`const { defineConfig } = require("cypress");\\n\\nmodule.exports = defineConfig({\\n  e2e: {\\n    setupNodeEvents(on, config) {},\\n    baseUrl: 'https://example.com',\\n  },\\n});\`;
    fs.writeFileSync(path.join(outputPath, \`cypress.config.\${ext}\`), configContent);

    const commandsContent = \`// Custom Cypress commands go here\\n\`;
    fs.writeFileSync(path.join(outputPath, 'cypress', 'support', \`commands.\${ext}\`), commandsContent);
    
    const e2eSupportContent = isTS ? \`import './commands';\\n\` : \`require('./commands');\\n\`;
    fs.writeFileSync(path.join(outputPath, 'cypress', 'support', \`e2e.\${ext}\`), e2eSupportContent);

    fs.writeFileSync(path.join(outputPath, 'cypress', 'fixtures', 'example.json'), \`{\\n  "name": "cypress",\\n  "email": "hello@cypress.io"\\n}\`);

    let pageImportStr = '';
    if (features.pageObjectModel) {
        const loginPageContent = isTS
            ? \`export class LoginPage {\\n  visit() { cy.visit('/login'); }\\n  fillUsername(val: string) { cy.get('#username').type(val); }\\n  fillPassword(val: string) { cy.get('#password').type(val); }\\n  submit() { cy.get('button[type="submit"]').click(); }\\n}\\nexport const loginPage = new LoginPage();\`
            : \`class LoginPage {\\n  visit() { cy.visit('/login'); }\\n  fillUsername(val) { cy.get('#username').type(val); }\\n  fillPassword(val) { cy.get('#password').type(val); }\\n  submit() { cy.get('button[type="submit"]').click(); }\\n}\\nmodule.exports = new LoginPage();\`;
        fs.writeFileSync(path.join(outputPath, 'cypress', 'pages', \`LoginPage.\${ext}\`), loginPageContent);
        
        pageImportStr = isTS 
            ? \`import { loginPage } from '../pages/LoginPage';\\n\`
            : \`const loginPage = require('../pages/LoginPage');\\n\`;
    }

    const sampleTest = \`\${pageImportStr}\\ndescribe('Login Suite', () => {\\n  it('should login', () => {\\n\${features.pageObjectModel ? \`    loginPage.visit();\\n    loginPage.fillUsername('testuser');\\n    loginPage.fillPassword('password123');\\n    loginPage.submit();\` : \`    cy.visit('/login');\\n    cy.get('#username').type('testuser');\\n    cy.get('#password').type('password123');\\n    cy.get('button[type="submit"]').click();\`}\\n  });\\n});\`;
    fs.writeFileSync(path.join(outputPath, 'cypress', 'e2e', \`login.cy.\${ext}\`), sampleTest);

    const readme = \`# \${projectName}\\n\\nCypress \${language} Framework\\n\\n## Setup\\n\\\`\\\`\\\`bash\\nnpm install\\n\\\`\\\`\\\`\\n## Run\\n\\\`\\\`\\\`bash\\nnpm run test\\n\\\`\\\`\\\`\`;
    fs.writeFileSync(path.join(outputPath, 'README.md'), readme);
}`;
content = content.replace(cyOldRegex, cyNew);

fs.writeFileSync(file, content, 'utf8');
console.log('Successfully refactored Playwright and Cypress generation.');
