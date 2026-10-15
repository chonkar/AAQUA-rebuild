import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { globSync } from 'glob';
import { exec } from 'child_process';

/**
 * Patches a locator in source files and re-runs a single test to verify if it passes.
 */
export async function execStatefulRun({ projectRoot, framework, classname, testName, oldLocator, newLocator, newStrategy }) {
    const rawId = (oldLocator || '').replace(/\\-/g, '-').replace(/\\./g, '.').replace(/^#/, '').trim();
    const searchPatterns = [];

    if (framework === 'playwright' || framework === 'cypress') {
        searchPatterns.push(`locator("${oldLocator}")`);
        searchPatterns.push(`locator('${oldLocator}')`);
        searchPatterns.push(`"${oldLocator}"`);
        searchPatterns.push(`'${oldLocator}'`);
    } else {
        if (rawId) {
            searchPatterns.push(`By.id("${rawId}")`);
            searchPatterns.push(`By.cssSelector("#${rawId}")`);
            searchPatterns.push(`@FindBy(id = "${rawId}")`);
            searchPatterns.push(`"${rawId}"`);
        }
        if (oldLocator && oldLocator.startsWith('//')) {
            searchPatterns.push(`By.xpath("${oldLocator}")`);
            searchPatterns.push(`"${oldLocator}"`);
        }
    }

    let allFiles = [];
    if (framework === 'maven') {
        allFiles = globSync('**/*.java', { cwd: projectRoot, ignore: ['**/target/**', '**/node_modules/**'] }).map(f => path.join(projectRoot, f));
    } else {
        allFiles = globSync('**/*.{js,ts}', { cwd: projectRoot, ignore: ['**/node_modules/**', '**/dist/**'] }).map(f => path.join(projectRoot, f));
    }

    let sourceFile = null;
    let foundPattern = null;
    let fileContent = null;

    for (const f of allFiles) {
        const contentStr = fs.readFileSync(f, 'utf-8');
        for (const p of searchPatterns) {
            if (p && contentStr.includes(p)) {
                sourceFile = f;
                foundPattern = p;
                fileContent = contentStr;
                break;
            }
        }
        if (foundPattern) break;
    }

    if (!foundPattern || !sourceFile) {
        return { passed: false, error: 'Locator pattern not found in any project file' };
    }

    function toJavaSyntax(val, strat) {
        const s = (strat || '').toLowerCase();
        if (s === 'id') return `By.id("${val}")`;
        if (s === 'xpath') return `By.xpath("${val}")`;
        if (s === 'name') return `By.name("${val}")`;
        return `By.cssSelector("${val}")`;
    }

    let replacement;
    if (framework === 'playwright' || framework === 'cypress') {
        replacement = `locator("${newLocator}")`;
    } else {
        if (foundPattern.startsWith('@FindBy')) {
            replacement = `@FindBy(id = "${newLocator}")`;
        } else if (foundPattern.startsWith('"') && foundPattern.endsWith('"')) {
            replacement = `"${newLocator}"`;
        } else {
            replacement = toJavaSyntax(newLocator, newStrategy);
        }
    }

    // Write backup and patch source
    fs.writeFileSync(sourceFile + '.bak', fileContent, 'utf-8');
    const patched = fileContent.replace(foundPattern, replacement);
    fs.writeFileSync(sourceFile, patched, 'utf-8');

    const healRunId = crypto.randomBytes(6).toString('hex');
    let cmd = '';
    if (framework === 'maven') {
        const simpleClass = classname ? classname.split('.').pop() : '';
        cmd = `mvn test -Dtest=${simpleClass}#${testName} -fae --no-transfer-progress`;
    } else {
        const relSpec = path.relative(projectRoot, sourceFile);
        cmd = `npx playwright test ${relSpec} --grep="${testName}"`;
    }

    return new Promise((resolve) => {
        exec(cmd, { cwd: projectRoot, timeout: 60000 }, (error, stdout, stderr) => {
            const passed = !error;
            resolve({
                passed,
                healRunId,
                patchedFrom: foundPattern,
                patchedTo: replacement,
                sourceFile,
                stdout,
                stderr
            });
        });
    });
}
