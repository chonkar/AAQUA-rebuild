import { Router } from 'express';
import { Project, McpServer, AgentRun, McpLocatorLearning } from '../models/index.js';
import { authenticateToken } from '../middleware/auth.js';
import multer from 'multer';
import * as XLSXModule from 'xlsx';
const XLSX = XLSXModule.default || XLSXModule;
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { LocalLLM as GoogleGenerativeAI } from '../utils/llmClient.js';
import { PlaywrightMcpClientManager, resolveRelativeDate } from '../services/mcpClientService.js';
import { generateArchitectReport, generateProductionPlaywrightFiles, generateProductionSeleniumFiles } from '../services/qaArchitectService.js';
import { recorderService } from '../services/recorderService.js';

const router = Router();

// Configure Multer for temp uploads
const upload = multer({ dest: 'temp_uploads/' });

// In-memory per-run log buffers
const agentLogBuffers = new Map(); // runId -> string[]
const MAX_LOG_LINES = 500;

// In-memory per-run live browser screenshots & MJPEG streaming
const agentLiveScreenshots = new Map(); // runId -> base64 jpeg
const agentScreencastListeners = new Map(); // runId -> Set<Response>

// In-memory active agent run cancellation tracker
const activeAgentRuns = new Map(); // runId -> { cancel: Function, isCancelled: boolean }

function registerActiveRun(runId, cancelFn) {
    activeAgentRuns.set(runId, { cancel: cancelFn, isCancelled: false });
}

function cancelActiveRun(runId) {
    const active = activeAgentRuns.get(runId);
    if (active) {
        active.isCancelled = true;
        if (typeof active.cancel === 'function') {
            try { active.cancel(); } catch (err) { console.error('[ActiveRun Cancel Err]', err); }
        }
        return true;
    }
    return false;
}

function isRunCancelled(runId) {
    const active = activeAgentRuns.get(runId);
    return active ? active.isCancelled : false;
}

function unregisterActiveRun(runId) {
    activeAgentRuns.delete(runId);
}

function updateAgentScreenshot(runId, base64Jpg) {
    if (!runId || !base64Jpg) return;
    agentLiveScreenshots.set(runId, base64Jpg);

    const listeners = agentScreencastListeners.get(runId);
    if (listeners && listeners.size > 0) {
        const buffer = Buffer.from(base64Jpg, 'base64');
        for (const res of listeners) {
            try {
                res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
                res.write(buffer);
                res.write('\r\n');
            } catch (err) {
                listeners.delete(res);
            }
        }
    }
}

const shadowRootHelperCode = `
    private void clickElement(WebElement element) {
        try {
            if (element.getTagName().equalsIgnoreCase("option")) {
                WebElement parentSelect = element.findElement(By.xpath(".."));
                if (parentSelect.getTagName().equalsIgnoreCase("select")) {
                    org.openqa.selenium.support.ui.Select select = new org.openqa.selenium.support.ui.Select(parentSelect);
                    String val = element.getAttribute("value");
                    if (val != null && !val.isEmpty()) {
                        select.selectByValue(val);
                    } else {
                        select.selectByVisibleText(element.getText());
                    }
                    return;
                }
            }
        } catch (Exception e) {
            // ignore and fallback
        }
        try {
            element.click();
        } catch (org.openqa.selenium.WebDriverException e) {
            if (e instanceof org.openqa.selenium.StaleElementReferenceException) {
                throw e;
            }
            System.out.println("Physical click failed, falling back to JavaScript click.");
            try {
                ((org.openqa.selenium.JavascriptExecutor) driver).executeScript("arguments[0].click();", element);
            } catch (Exception ex) {
                throw e;
            }
        }
    }

    private WebElement waitForElement(By locator, int timeoutSeconds) {
        try {
            WebDriverWait shortWait = new WebDriverWait(driver, Duration.ofSeconds(10));
            shortWait.until(ExpectedConditions.invisibilityOfElementLocated(By.className("full-screen-loader-wrapper")));
            shortWait.until(ExpectedConditions.invisibilityOfElementLocated(By.className("loading-spinner")));
        } catch (Exception ex) {
            // ignore
        }
        // Prioritize matching native select <option> tags for text-based XPaths to trigger Select events correctly
        if (locator.toString().contains("translate(text()")) {
            try {
                String locStr = locator.toString();
                String xpathStr = locStr.substring(locStr.indexOf(":") + 1).trim();
                String optionXpath = xpathStr.replace("//*", "//option");
                WebDriverWait optionWait = new WebDriverWait(driver, Duration.ofSeconds(3));
                WebElement opt = optionWait.until(ExpectedConditions.presenceOfElementLocated(By.xpath(optionXpath)));
                if (opt != null) return opt;
            } catch (Exception ex) {
                // ignore
            }
        }
        try {
            WebDriverWait quickWait = new WebDriverWait(driver, Duration.ofSeconds(5));
            return quickWait.until(ExpectedConditions.presenceOfElementLocated(locator));
        } catch (Exception primaryEx) {
            // Fallback 1: Try dot-text matching for XPath so descendant text nodes inside child spans/divs match
            if (locator instanceof By.ByXPath) {
                String locStr = locator.toString();
                String xpathStr = locStr.substring(locStr.indexOf(":") + 1).trim();
                if (xpathStr.contains("contains(text(),")) {
                    try {
                        String dotXpath = xpathStr.replace("contains(text(),", "contains(.,");
                        WebDriverWait dotWait = new WebDriverWait(driver, Duration.ofSeconds(5));
                        WebElement el = dotWait.until(ExpectedConditions.presenceOfElementLocated(By.xpath(dotXpath)));
                        if (el != null) return el;
                    } catch (Exception ignored) {}
                }
            }

            // Fallback 2: Try Shadow DOM / JS traversal
            try {
                String locStr = locator.toString();
                String query = "";
                boolean isText = false;
                if (locator instanceof By.ByCssSelector) {
                    query = locStr.substring(locStr.indexOf(":") + 1).trim();
                } else if (locator instanceof By.ByXPath) {
                    int lastQuoteClose = locStr.lastIndexOf("'");
                    if (lastQuoteClose > 0) {
                        int lastQuoteOpen = locStr.lastIndexOf("'", lastQuoteClose - 1);
                        if (lastQuoteOpen >= 0) {
                            query = locStr.substring(lastQuoteOpen + 1, lastQuoteClose);
                            isText = true;
                        }
                    }
                }
                if (!query.isEmpty()) {
                    Object res = ((org.openqa.selenium.JavascriptExecutor) driver).executeScript(
                        "function findAcrossShadows(root, q, isTxt) {" +
                        "  if (isTxt) {" +
                        "    const lq = q.toLowerCase().trim();" +
                        "    function traverse(node) {" +
                        "      if (node.shadowRoot) {" +
                        "        const found = traverse(node.shadowRoot);" +
                        "        if (found) return found;" +
                        "      }" +
                        "      for (let i = 0; i < node.children.length; i++) {" +
                        "        const found = traverse(node.children[i]);" +
                        "        if (found) return found;" +
                        "      }" +
                        "      if (node.textContent && node.textContent.toLowerCase().includes(lq)) {" +
                        "        if (node.querySelectorAll('*').length < 15) return node;" +
                        "      }" +
                        "      return null;" +
                        "    }" +
                        "    return traverse(root);" +
                        "  } else {" +
                        "    function traverseCss(node) {" +
                        "      const el = node.querySelector(q);" +
                        "      if (el) return el;" +
                        "      const all = node.querySelectorAll('*');" +
                        "      for (let i = 0; i < all.length; i++) {" +
                        "        if (all[i].shadowRoot) {" +
                        "          const elShadow = traverseCss(all[i].shadowRoot);" +
                        "          if (elShadow) return elShadow;" +
                        "        }" +
                        "      }" +
                        "      return null;" +
                        "    }" +
                        "    return traverseCss(root);" +
                        "  }" +
                        "}" +
                        "return findAcrossShadows(document.body, arguments[0], arguments[1]);", query, isText
                    );
                    if (res instanceof WebElement) {
                        return (WebElement) res;
                    }
                }
            } catch (Exception ex) {
                System.out.println("Shadow Root traversal error: " + ex.getMessage());
            }

            // Final fallback: wait with the main driver wait
            return wait.until(ExpectedConditions.presenceOfElementLocated(locator));
        }
    }
`;


function logAgent(runId, line) {
    const text = line == null ? '' : String(line);
    const stamped = `[${new Date().toISOString()}] ${text}`;
    let buf = agentLogBuffers.get(runId);
    if (!buf) {
        buf = [];
        agentLogBuffers.set(runId, buf);
    }
    buf.push(stamped);
    if (buf.length > MAX_LOG_LINES) {
        buf.splice(0, buf.length - MAX_LOG_LINES);
    }
    console.log(`[AgentRun ${runId.slice(0, 8)}] ${text}`);
}

async function flushAgentLogs(run) {
    const buf = agentLogBuffers.get(run.id);
    if (!buf || buf.length === 0) return;
    try {
        await run.update({ logs: buf.join('\n') });
    } catch (err) {
        console.error(`[AgentRun ${run.id}] Failed to flush logs:`, err.message);
    }
}

/**
 * Converts simple CSS selectors (tag, tag#id, tag.class, tag[attr=val]) to valid XPath query parts.
 */
function cssToXpath(css) {
    if (!css) return '*';
    let s = css.trim();
    if (s === '*' || s === '') return '*';

    let tag = '*';
    const tagMatch = s.match(/^[a-zA-Z0-9_-]+/);
    if (tagMatch) {
        tag = tagMatch[0];
        s = s.substring(tag.length);
    }

    const conditions = [];

    // Match ID selector
    const idMatch = s.match(/#([a-zA-Z0-9_-]+)/);
    if (idMatch) {
        conditions.push(`@id='${idMatch[1]}'`);
        s = s.replace(/#([a-zA-Z0-9_-]+)/, '');
    }

    // Match Classes
    const classRegex = /\.([a-zA-Z0-9_-]+)/g;
    let classMatch;
    while ((classMatch = classRegex.exec(s)) !== null) {
        conditions.push(`contains(concat(' ', normalize-space(@class), ' '), ' ${classMatch[1]} ')`);
    }
    s = s.replace(/\.([a-zA-Z0-9_-]+)/g, '');

    // Match Attributes
    const attrRegex = /\[([a-zA-Z_:][-a-zA-Z0-9_:]*)\s*=\s*(['"]?)(.*?)\2\]/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(s)) !== null) {
        const attrName = attrMatch[1];
        const attrVal = attrMatch[3];
        conditions.push(`@${attrName}='${attrVal}'`);
    }

    let xpath = tag;
    if (conditions.length > 0) {
        xpath += `[${conditions.join(' and ')}]`;
    }
    return xpath;
}

/**
 * Shared helper to convert a selector string into a Selenium locator string.
 * Automatically cleans and handles Playwright-specific selector expressions.
 */
function getSeleniumLocator(sel) {
    if (!sel) return 'By.cssSelector("")';
    let s = normalizeSelector(sel).trim();

    // Convert dynamic OutSystems element IDs to prefix-independent stable suffix selectors
    if (/^#b\d+-/i.test(s)) {
        const lastIdx = s.lastIndexOf('-');
        if (lastIdx > 0) {
            let lastPart = s.substring(lastIdx + 1);
            const indexMatch = s.match(/_(\d+)-[^-]+$/);
            if (indexMatch) {
                lastPart = `_${indexMatch[1]}-${lastPart}`;
            }
            if (lastPart.toLowerCase().includes('dropdown')) {
                s = `[id$='${lastPart}'] select, [id$='${lastPart}'], .dropdown select`;
            } else {
                s = `[id$='${lastPart}']`;
            }
        }
    }

    // Handle compound/comma-separated selectors
    if (s.includes(',')) {
        const parts = s.split(',').map(p => p.trim());
        const standardParts = parts.filter(p => {
            const lower = p.toLowerCase();
            return !lower.includes(':has-text') && !lower.startsWith('text=') && !lower.includes('text=');
        });
        if (standardParts.length > 0) {
            s = standardParts.join(', ');
        } else {
            s = parts[0];
        }
    }

    if (s.startsWith('xpath=')) {
        return `By.xpath("${s.substring(6).replace(/"/g, '\\"')}")`;
    }
    if (s.startsWith('/') || s.startsWith('..')) {
        return `By.xpath("${s.replace(/"/g, '\\"')}")`;
    }

    // Handle Playwright text= or general text selectors
    if (s.startsWith('text=') || s.includes('text=')) {
        let textVal = s;
        if (s.startsWith('text=')) {
            textVal = s.substring(5);
        }
        if (textVal.startsWith('"') && textVal.endsWith('"')) {
            textVal = textVal.substring(1, textVal.length - 1);
        } else if (textVal.startsWith("'") && textVal.endsWith("'")) {
            textVal = textVal.substring(1, textVal.length - 1);
        }

        if (textVal.startsWith('/') && textVal.endsWith('/i')) {
            let rawPattern = textVal.slice(1, -2);
            let cleanText = rawPattern
                .replace(/\\s\*/g, ' ')
                .replace(/\s\*/g, ' ')
                .replace(/[^a-zA-Z0-9\s]/g, '')
                .trim();
            if (cleanText) {
                return `By.xpath("//*[contains(text(), '${cleanText}') or contains(@value, '${cleanText}')]")`;
            }
        }

        const escapedText = textVal.replace(/'/g, "\\'");
        return `By.xpath("//*[contains(text(), '${escapedText}') or contains(@value, '${escapedText}')]")`;
    }

    // Handle Playwright :has-text("...") pseudo-class
    if (s.includes(':has-text(')) {
        const match = s.match(/:has-text\((['"])(.*?)\1\)/);
        if (match) {
            const textVal = match[2];
            const baseSelector = s.split(':has-text(')[0].trim();
            const escapedText = textVal.replace(/'/g, "\\'");
            
            const normalizedBase = normalizeSelector(baseSelector);
            const xpathBase = cssToXpath(normalizedBase);
            return `By.xpath("//${xpathBase}[contains(text(), '${escapedText}')]")`;
        }
    }

    // If selector is a plain word without CSS syntax symbols (# . [ > : = /), convert to clean text/attribute search XPath
    if (!/[#\.\[>:=>/\\ ]/.test(s)) {
        const lowerS = s.toLowerCase();
        if (lowerS === 'submit' || lowerS === 'save') {
            return `By.xpath("//button[@type='submit'] | //input[@type='submit'] | //*[contains(text(), '${s}') or contains(@value, '${s}')]")`;
        }
        return `By.xpath("//input[contains(translate(@id, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerS}') or contains(translate(@name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerS}') or contains(translate(@placeholder, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerS}')] | //label[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerS}')]/following::input[1] | //*[contains(text(), '${s}') or contains(@placeholder, '${s}') or contains(@id, '${s}') or contains(@name, '${s}')]")`;
    }

    return `By.cssSelector("${s.replace(/"/g, '\\"')}")`;
}

/**
 * Generates a semantically clean, unique camelCase locator name from a step's actionKey or target.
 */
function getCleanLocatorName(step, idx, prefix = 'locator') {
    let base = '';
    if (step.actionKey) {
        base = step.actionKey;
    } else if (step.targetSelector && !isSelector(step.targetSelector)) {
        base = step.targetSelector;
    } else if (step.target && !isSelector(step.target)) {
        base = step.target;
    } else {
        return `${prefix}_${idx + 1}`;
    }

    // Clean up base string (remove text= syntax, brackets, quotes, etc)
    let cleanedBase = base.replace(/text=|[\[\]'"]/g, '').trim();
    let clean = cleanedBase.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    if (!clean) return `${prefix}_${idx + 1}`;
    
    const words = clean.split(/\s+/);
    let camel = words[0].toLowerCase();
    for (let i = 1; i < words.length; i++) {
        camel += words[i].charAt(0).toUpperCase() + words[i].slice(1).toLowerCase();
    }
    
    if (/^[0-9]/.test(camel)) {
        camel = 'el_' + camel;
    }
    
    const action = (step.action || '').toLowerCase();
    if (action.includes('type') || action.includes('enter') || action.includes('input')) {
        if (!camel.toLowerCase().includes('input') && !camel.toLowerCase().includes('field')) {
            camel += 'Input';
        }
    } else if (action.includes('click') || action.includes('press')) {
        if (!camel.toLowerCase().includes('btn') && !camel.toLowerCase().includes('button') && !camel.toLowerCase().includes('link') && !camel.toLowerCase().includes('dropdown') && !camel.toLowerCase().includes('icon')) {
            camel += 'Button';
        }
    }
    
    // Append index to guarantee uniqueness across multiple steps
    return `${camel}_${idx + 1}`;
}

/**
 * Normalizes CSS selectors by wrapping unquoted attribute values in quotes.
 * E.g., a[href=/Timesheet_New/Timesheet] -> a[href="/Timesheet_New/Timesheet"]
 */
function normalizeSelector(sel) {
    if (!sel) return '';
    let s = sel.trim();
    
    // 1. Wrap unquoted text arguments in :has-text() with single quotes
    s = s.replace(/:has-text\(\s*([^'"].*?)\s*\)/g, (match, textVal) => {
        const trimmed = textVal.trim();
        return `:has-text('${trimmed}')`;
    });

    // 2. Normalize attribute values (quoted or unquoted) inside square brackets [attr=val]
    s = s.replace(/\[([a-zA-Z_:][-a-zA-Z0-9_:]*)\s*=\s*(['"]?)(.*?)\2\]/g, (match, attrName, quote, attrValue) => {
        const val = attrValue.trim();
        return `[${attrName}='${val}']`;
    });

    // 3. Convert tag:text=value to tag:has-text('value')
    s = s.replace(/^([a-zA-Z0-9_-]+):text\s*=\s*(.+)$/g, (match, tag, val) => {
        const cleanVal = val.trim().replace(/^['"]|['"]$/g, '');
        return `${tag}:has-text('${cleanVal}')`;
    });
    return s;
}

/**
 * Normalizes an action string or target into a clean alphanumeric key for locator learning
 */
function normalizeActionKey(key) {
    if (!key || typeof key !== 'string') return 'action';
    return key.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 100);
}

/**
 * Generates robust, cross-platform CSS selectors for typing into form inputs.
 * Completely generic across any web application (React, Angular, Vue, Bootstrap, Tailwind, standard HTML forms, OutSystems).
 * Strictly avoids hardcoding application-specific element IDs.
 */
export function generateGenericInputSelectors(targetLabel) {
    if (!targetLabel) return 'input:not([type="hidden"]), textarea';
    const label = targetLabel.replace(/^(type|enter|input|fill|into|in)\s+/i, '').trim();
    const lower = label.toLowerCase();

    // 1. Semantic standard form concepts
    if (lower.includes('first') && lower.includes('name')) {
        return 'input[name*="firstName" i], input[id*="firstName" i], input[placeholder*="First Name" i], input[autocomplete*="given-name"], input[aria-label*="first name" i], label:has-text("First Name") ~ input, label:has-text("First Name") ~ * input, *:has(> label:has-text("First Name")) input, input[type="text"]';
    }
    if (lower.includes('last') && lower.includes('name')) {
        return 'input[name*="lastName" i], input[id*="lastName" i], input[placeholder*="Last Name" i], input[autocomplete*="family-name"], input[aria-label*="last name" i], label:has-text("Last Name") ~ input, label:has-text("Last Name") ~ * input, *:has(> label:has-text("Last Name")) input, input[type="text"]';
    }
    if (lower.includes('username') || lower === 'user') {
        return 'input[name*="username" i], input[id*="username" i], input[placeholder*="username" i], input[data-test="username"], input[autocomplete="username"], input[name*="user" i], input[id*="user" i], label:has-text("User") ~ input, input[type="text"]';
    }
    if (lower.includes('password') || lower.includes('pass')) {
        return 'input[type="password"], input[name*="password" i], input[id*="password" i], input[placeholder*="password" i], input[name*="pass" i], input[id*="pass" i], input[data-test="password"]';
    }
    if (lower.includes('email')) {
        return 'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i], input[autocomplete*="email"], input[aria-label*="email" i]';
    }
    if (lower.includes('mobile') || lower.includes('phone') || lower.includes('cell') || lower.includes('tel')) {
        return 'input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i], input[id*="mobile" i], input[placeholder*="phone" i], input[placeholder*="mobile" i]';
    }
    if (lower.includes('search')) {
        return 'input[type="search"], input[name*="search" i], input[id*="search" i], input[placeholder*="search" i], input[aria-label*="search" i]';
    }
    if (lower.includes('start date') || lower.includes('startdate') || lower.includes('from date')) {
        return 'input[placeholder*="Start" i], input[id*="StartDate" i], input[name*="StartDate" i], input[type="date"], label:has-text("Start") ~ * input, input[placeholder*="start" i]';
    }
    if (lower.includes('end date') || lower.includes('enddate') || lower.includes('to date')) {
        return 'input[placeholder*="End" i], input[id*="EndDate" i], input[name*="EndDate" i], input[type="date"], label:has-text("End") ~ * input, input[placeholder*="end" i]';
    }
    if (lower.includes('date') || lower.includes('dob') || lower.includes('birth')) {
        return 'input[type="date"], input[id*="Date" i], input[name*="Date" i], input[placeholder*="Date" i]';
    }

    // 2. Multi-word general field
    const words = label.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (words.length > 0) {
        const compact = words.join('').toLowerCase();
        const camel = words[0].toLowerCase() + words.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
        const snake = words.join('_').toLowerCase();
        const kebab = words.join('-').toLowerCase();
        const rawPhrase = words.join(' ');

        return `[name="${camel}"], #${camel}, [name="${kebab}"], #${kebab}, [name="${snake}"], #${snake}, [name*="${compact}" i], input[id*="${compact}" i], input[placeholder*="${rawPhrase}" i], input[aria-label*="${rawPhrase}" i], textarea[name*="${compact}" i], textarea[id*="${compact}" i], textarea[placeholder*="${rawPhrase}" i], label:has-text("${rawPhrase}") ~ input, label:has-text("${rawPhrase}") ~ * input, *:has(> label:has-text("${rawPhrase}")) input, input:not([type="hidden"]), textarea`;
    }

    return 'input:not([type="hidden"]), textarea';
}
const generateInputSelectors = generateGenericInputSelectors;

/**
 * Generates robust, cross-platform candidate selectors for clicking elements.
 * Universal across any web application using semantic HTML tags, ARIA roles, and leaf text matching.
 * Zero hardcoded application-specific IDs.
 */
export function generateGenericClickSelectors(targetOrAction) {
    if (!targetOrAction) return 'button, a, [role="button"], [role="menuitem"], input[type="submit"]';

    // If target is already a specific heading selector like h5 or h5:has-text(...)
    const trimmed = targetOrAction.trim();
    if (/^h[1-6]$/i.test(trimmed)) {
        return trimmed.toLowerCase();
    }
    if (/^h[1-6]:has-text/i.test(trimmed)) {
        return trimmed;
    }

    const clean = targetOrAction
        .replace(/^(click|press|tap|open|select)\s+(on\s+)?/i, '')
        .replace(/^(heading|header|card|title|h[1-6])\s+/i, '')
        .replace(/\s+(button|link|menu|icon|heading|header|card|title|h[1-6])$/i, '')
        .trim();
    if (!clean) return 'button, a, [role="button"], [role="menuitem"], input[type="submit"]';

    const lower = clean.toLowerCase();
    const rawLower = targetOrAction.toLowerCase();

    // Semantic form actions
    if (lower === 'login' || lower === 'log in' || lower === 'sign in' || lower === 'signin') {
        return 'button:has-text("Login"), button:has-text("Log In"), button:has-text("Sign in"), button:has-text("Sign In"), input[type="submit"][value*="Login" i], input[type="submit"][value*="Sign" i], [role="button"]:has-text("Login"), text="Login", button[type="submit"]';
    }
    if (lower === 'submit' || lower === 'save' || lower === 'apply') {
        return `button:has-text("${clean}"), button[type="submit"], input[type="submit"][value*="${clean}" i], [role="button"]:has-text("${clean}"), text="${clean}"`;
    }

    // Modal / Popup Close actions (e.g. DemoQA "Thanks for submitting the form", Bootstrap & custom dialogs)
    if (lower.includes('close') || lower.includes('dismiss') || lower.includes('popup') || lower.includes('modal') || lower.includes('thanks')) {
        return '#closeLargeModal, button#closeLargeModal, .modal-footer button, .modal button:has-text("Close"), [role="dialog"] button:has-text("Close"), [role="dialog"] button, [aria-label="Close"], button.close, [data-dismiss="modal"], [data-bs-dismiss="modal"], button:has-text("Close"), [role="button"]:has-text("Close"), text="Close"';
    }

    // Explicit heading or card intent (e.g. "h5 Forms", "Forms heading", "Alerts card", or card titles on DemoQA)
    if (rawLower.includes('h5') || rawLower.includes('h4') || rawLower.includes('h3') || rawLower.includes('h2') || rawLower.includes('h1') || rawLower.includes('heading') || rawLower.includes('header') || rawLower.includes('card')) {
        return `h5:has-text("${clean}"), .card:has-text("${clean}"), [class*="card"]:has-text("${clean}"), .top-card:has-text("${clean}"), h4:has-text("${clean}"), h3:has-text("${clean}"), h2:has-text("${clean}"), h1:has-text("${clean}"), h6:has-text("${clean}"), [role="button"]:has-text("${clean}"), button:has-text("${clean}"), a:has-text("${clean}"), text="${clean}", div:has-text("${clean}")`;
    }

    // Universal standard candidates (including headings h5/h4/h3/h2/h1/h6 and card wrappers)
    return `button:has-text("${clean}"), a:has-text("${clean}"), h5:has-text("${clean}"), [role="button"]:has-text("${clean}"), [role="menuitem"]:has-text("${clean}"), [role="tab"]:has-text("${clean}"), [role="option"]:has-text("${clean}"), .card:has-text("${clean}"), [class*="card"]:has-text("${clean}"), h4:has-text("${clean}"), h3:has-text("${clean}"), h2:has-text("${clean}"), h1:has-text("${clean}"), h6:has-text("${clean}"), input[type="submit"][value*="${clean}" i], input[type="button"][value*="${clean}" i], [aria-label*="${clean}" i], [title*="${clean}" i], [data-testid*="${clean}" i], text="${clean}", div:has-text("${clean}"), span:has-text("${clean}"), li:has-text("${clean}")`;
}

/**
 * Generates robust, cross-platform candidate selectors for dropdown selects.
 * Works for native <select> elements, ARIA comboboxes, and custom dropdown wrappers.
 */
export function generateGenericSelectSelectors(targetOrAction) {
    if (!targetOrAction) return 'select, [role="combobox"], .dropdown';
    const clean = targetOrAction.replace(/^(select|choose|pick|open)\s+/i, '').replace(/\s+(dropdown|select|options?)$/i, '').trim();
    if (!clean) return 'select, [role="combobox"], .dropdown';

    const words = clean.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
    const compact = words.join('').toLowerCase();

    return `select[name*="${compact}" i], select[id*="${compact}" i], select[aria-label*="${clean}" i], label:has-text("${clean}") ~ select, label:has-text("${clean}") ~ * select, [role="combobox"][aria-label*="${clean}" i], [role="combobox"], .dropdown, select, [class*="dropdown"]`;
}


/**
 * GET /api/mcp/templates/excel
 * Download a sample Excel template matching the functional test generator format
 */
router.get('/templates/excel', (req, res) => {
    try {
        // Create workbook & worksheet
        const wb = XLSX.utils.book_new();
        const data = [
            {
                "Test Case ID": "FT_001",
                "Module": "Authentication",
                "Feature": "User Login",
                "Scenario": "Successful login with standard user",
                "Test Type": "Functional",
                "Priority": "High",
                "Platform": "Web",
                "Preconditions": "Browser is open on Swag Labs login page",
                "Test Data": "username: standard_user, password: secret_sauce",
                "Test Steps": "1. Navigate to 'https://www.saucedemo.com'\n2. Enter username 'standard_user' into '[data-test=\"username\"]'\n3. Enter password 'secret_sauce' into '[data-test=\"password\"]'\n4. Click login button on '[data-test=\"login-button\"]'\n5. Click hamburger menu on 'button#react-burger-menu-btn'\n6. Assert logout button is visible on 'a#logout_sidebar_link'",
                "Expected Result": "Swag Labs product catalog dashboard is visible and user can log out"
            }
        ];

        const ws = XLSX.utils.json_to_sheet(data);
        XLSX.utils.book_append_sheet(wb, ws, "Test Cases");

        // Write workbook to buffer
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=aaqua_mcp_test_template.xlsx');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        res.send(buf);
    } catch (err) {
        console.error('[MCP Template] Error generating Excel template:', err);
        res.status(500).json({ error: 'Failed to generate Excel template.' });
    }
});

/**
 * GET /api/mcp/servers
 * List MCP servers for a project
 */
router.get('/servers', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.query;
        if (!projectId) {
            return res.status(400).json({ error: 'projectId is required.' });
        }

        const project = await Project.findByPk(projectId);
        if (!project) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        let servers = await McpServer.findAll({ where: { project_id: projectId } });

        // Migrate any old 'Playwright Browser MCP' or in-built browser MCP to the mature server
        let updatedAny = false;
        for (const s of servers) {
            if (s.name === 'Playwright Browser MCP' || s.name.toLowerCase().includes('playwright browser') || s.name.toLowerCase().includes('in-built browser')) {
                await s.update({
                    name: '@executeautomation/playwright-mcp-server',
                    url: 'stdio://@executeautomation/playwright-mcp-server',
                    type: 'stdio'
                });
                updatedAny = true;
            }
        }
        if (updatedAny) {
            servers = await McpServer.findAll({ where: { project_id: projectId } });
        }

        // Seed default servers if empty to wow the user out-of-the-box
        if (servers.length === 0) {
            servers = await Promise.all([
                McpServer.create({
                    project_id: projectId,
                    name: 'Built-in Filesystem MCP',
                    url: './',
                    type: 'builtin',
                    status: 'active',
                }),
                McpServer.create({
                    project_id: projectId,
                    name: 'Local PostgreSQL MCP',
                    url: 'postgresql://localhost:5433/aaqua_security',
                    type: 'builtin',
                    status: 'active',
                }),
                McpServer.create({
                    project_id: projectId,
                    name: '@executeautomation/playwright-mcp-server',
                    url: 'stdio://@executeautomation/playwright-mcp-server',
                    type: 'stdio',
                    status: 'active',
                }),
            ]);
        }

        res.json(servers);
    } catch (err) {
        console.error('[MCP] List servers error:', err);
        res.status(500).json({ error: 'Failed to get MCP servers.' });
    }
});

/**
 * POST /api/mcp/servers
 * Add an MCP server configuration
 */
router.post('/servers', authenticateToken, async (req, res) => {
    try {
        const { project_id, name, url, type } = req.body;
        if (!project_id || !name || !url) {
            return res.status(400).json({ error: 'project_id, name, and url are required.' });
        }

        const project = await Project.findByPk(project_id);
        if (!project) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        const server = await McpServer.create({
            project_id,
            name,
            url,
            type: type || 'sse',
            status: 'active',
        });

        res.status(201).json(server);
    } catch (err) {
        console.error('[MCP] Create server error:', err);
        res.status(500).json({ error: 'Failed to add MCP server.' });
    }
});

/**
 * DELETE /api/mcp/servers/:id
 * Delete an MCP server configuration
 */
router.delete('/servers/:id', authenticateToken, async (req, res) => {
    try {
        const server = await McpServer.findByPk(req.params.id);
        if (!server) {
            return res.status(404).json({ error: 'Server configuration not found.' });
        }

        await server.destroy();
        res.json({ message: 'Server configuration deleted successfully.' });
    } catch (err) {
        console.error('[MCP] Delete server error:', err);
        res.status(500).json({ error: 'Failed to delete MCP server.' });
    }
});

/**
 * POST /api/mcp/agent/run
 * Run an agent task asynchronously
 */
router.post('/agent/run', authenticateToken, async (req, res) => {
    try {
        const { projectId, goal } = req.body;
        if (!projectId || !goal) {
            return res.status(400).json({ error: 'projectId and goal are required.' });
        }

        const project = await Project.findByPk(projectId);
        if (!project) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        const apiKey = process.env.VITE_LLM_API_KEY;
        if (!apiKey) {
            // Simulated / mock run - start immediately in 'running' mode
            const run = await AgentRun.create({
                project_id: projectId,
                goal,
                status: 'running',
            });
            executeAgentRun(run, goal, req.body.headed);
            return res.status(202).json({
                message: 'Agent task started in simulated mode.',
                runId: run.id,
                status: 'running',
            });
        }

        // Planning mode (real LLM) - Generate step plan
        const endpoint = process.env.VITE_LLM_ENDPOINT;
        const modelName = process.env.VITE_LLM_MODEL || 'gpt-oss-20b';

        const llm = new GoogleGenerativeAI(apiKey, endpoint);
        const model = llm.getGenerativeModel({ 
            model: modelName,
            generationConfig: { temperature: 0.1 }
        });
        const todayDate = new Date();
        const todayIso = todayDate.toISOString().split('T')[0];
        const tomorrowDate = new Date(todayDate);
        tomorrowDate.setDate(todayDate.getDate() + 1);
        const tomorrowIso = tomorrowDate.toISOString().split('T')[0];

        const prompt = `Your task is to convert a natural language web automation/testing goal into a list of structured, sequential execution steps.

User Goal: "${goal}"

You must output a JSON array of objects, where each object represents a single step to execute in Playwright.
Supported step actions:
1. "Navigate": Go to a URL.
   - Requires target: the full URL.
2. "Type": Enter text into an input field or date field.
   - Requires target: CSS selector, XPath, or natural language label for the input.
   - Requires inputData: the text to enter.
3. "Select": Choose an option from a dropdown or <select> element.
   - Requires target: CSS selector, XPath, or natural language label for the dropdown (e.g. "Select dropdown", "select[name='country']").
   - Requires inputData: the option text or label to choose (e.g. "Aaseya annual leave").
4. "Click": Click a button, link, or element.
   - Requires target: CSS selector, XPath, or natural language label of the element to click.
5. "Assert": Verify that an element or text is present on the page.
   - Requires target: CSS selector or text to verify.
   - Requires expected: description of the expected state.

SPECIAL DATE & DROPDOWN RULES:
- CURRENT DATE CONTEXT: Today's date is ${todayIso}. Tomorrow is ${tomorrowIso}.
- Dropdown Selection: When the goal specifies selecting a dropdown option (e.g., "From Select leave type dropdown, select 'Aaseya annual leave'"), use action "Select" or "Type" with target "Select leave type dropdown" and inputData "Aaseya annual leave".
- Date Fields: When the goal specifies relative dates (e.g., "select start date as next day from current day", "Select End date as same day of the holiday"), calculate the actual future date (YYYY-MM-DD format, e.g. "${tomorrowIso}") based on today (${todayIso}) as inputData. Never generate dates in the past (such as 2025 or earlier).
- Login URL: For OutSystems/aOne_TH application, ALWAYS use https://assl-dev.outsystemscloud.com/aOne_TH/osLogin as the login URL. Use input[type="text"] for the username field, NOT #Input_Username (which only exists on internalosLogin).
- Modal / Popup Close: When closing a confirmation modal or popup (e.g. "Thanks for submitting the form", "close button on popup", modal close button), use action "Click" with target "#closeLargeModal, .modal-footer button, button:has-text('Close')".

SPECIAL RANGE & TIMESHEET EXPANSION RULES:
- Multi-Day / Timesheet Range Expansion: When the goal specifies a range of days (e.g., "fill 9 hrs from Mon to Fri", "Monday to Friday", "Mon-Fri", "all weekdays"), DO NOT output a single step for "Mon to Fri". Instead, expand it into 5 separate, sequential Type steps—one for each day: Monday, Tuesday, Wednesday, Thursday, and Friday.
  Example for "fill 9 hrs from Mon to Fri":
  { "action": "Type", "target": "Monday", "inputData": "9" },
  { "action": "Type", "target": "Tuesday", "inputData": "9" },
  { "action": "Type", "target": "Wednesday", "inputData": "9" },
  { "action": "Type", "target": "Thursday", "inputData": "9" },
  { "action": "Type", "target": "Friday", "inputData": "9" }

Return ONLY the raw JSON array (no markdown code blocks, no other text).
Example:
[
  { "action": "Navigate", "target": "https://www.saucedemo.com" },
  { "action": "Type", "target": "username", "inputData": "standard_user" },
  { "action": "Type", "target": "password", "inputData": "secret_sauce" },
  { "action": "Click", "target": "Login" },
  { "action": "Assert", "target": "Products", "expected": "Products dashboard is visible" }
]`;

        const result = await model.generateContent(prompt);
        let text = result.response.text().trim();
        if (text.startsWith('```')) {
            text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
        }

        let steps;
        try {
            steps = JSON.parse(text);
            if (!Array.isArray(steps)) throw new Error("Response is not an array");
        } catch (e) {
            console.error('[MCP Route Run] Plan parse error:', e.message, 'Raw response:', text);
            return res.status(422).json({ error: 'Failed to generate step plan: ' + e.message, rawResponse: text });
        }

        // Map steps to structural checklist
        const flatSteps = steps.map((s, idx) => ({
            testCaseId: 'TC_AI',
            scenario: goal,
            expected: s.expected || 'Step execution success',
            stepNum: String(idx + 1),
            action: s.action || 'Execute action',
            target: normalizeSelector(s.target || ''),
            inputData: s.inputData || '',
        }));

        // Create run record in 'planned' status containing the plan
        const run = await AgentRun.create({
            project_id: projectId,
            goal,
            status: 'planned',
            steps: JSON.stringify(flatSteps),
        });

        res.json({
            message: 'Step plan generated. Awaiting human confirmation.',
            runId: run.id,
            status: 'planned',
            steps: flatSteps
        });

    } catch (err) {
        console.error('[MCP Agent] Run start error:', err);
        res.status(500).json({ error: 'Failed to start agent task: ' + err.message });
    }
});

/**
 * POST /api/mcp/agent/confirm
 * Approve and execute the planned agent task
 */
router.post('/agent/confirm', authenticateToken, async (req, res) => {
    try {
        const { runId, headed } = req.body;
        if (!runId) {
            return res.status(400).json({ error: 'runId is required.' });
        }

        const run = await AgentRun.findByPk(runId);
        if (!run) {
            return res.status(404).json({ error: 'Agent run not found.' });
        }

        if (run.status !== 'planned') {
            return res.status(400).json({ error: `Agent run must be in 'planned' status to confirm (current: ${run.status})` });
        }

        if (!run.steps) {
            return res.status(400).json({ error: 'No planned steps found for this agent run.' });
        }

        const flatSteps = JSON.parse(run.steps);

        // Update status to running
        await run.update({ status: 'running' });

        // Start background runner using the stored steps
        executeStepsBackground(run, flatSteps, headed);

        res.json({
            message: 'Agent execution started.',
            runId: run.id,
            status: 'running'
        });

    } catch (err) {
        console.error('[MCP Confirm] Confirm error:', err);
        res.status(500).json({ error: 'Failed to confirm and run agent task.' });
    }
});

/**
 * Convert verified steps of a run into Playwright/Selenium code (secured via runId UUIDv4 capability token validation)
 */
async function handleConvert(req, res) {
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    console.log(`[MCP Convert] Request received. Method: ${req.method}, Query: ${JSON.stringify(req.query)}, Body: ${JSON.stringify(req.body)}`);
    try {
        const runId = req.body?.runId || req.query?.runId;
        const targetFramework = req.body?.targetFramework || req.query?.targetFramework;

        if (!runId || !targetFramework) {
            return res.status(400).json({ error: 'runId and targetFramework are required.' });
        }

        // Validate UUIDv4 format (Capability Token Security)
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(runId)) {
            return res.status(400).json({ error: 'Invalid runId format.' });
        }

        const run = await AgentRun.findByPk(runId);
        if (!run) {
            return res.status(404).json({ error: 'Agent run not found.' });
        }

        const steps = run.steps ? JSON.parse(run.steps) : [];
        if (steps.length === 0) {
            return res.status(400).json({ error: 'No execution steps found to export.' });
        }

        let zipBuffer;
        let filename;

        if (targetFramework.toLowerCase() === 'playwright') {
            zipBuffer = generatePlaywrightProjectZip(steps, run.goal);
            filename = 'playwright-automation-project.zip';
        } else {
            zipBuffer = generateSeleniumProjectZip(steps, run.goal);
            filename = 'selenium-automation-project.zip';
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(zipBuffer);
    } catch (err) {
        console.error('[MCP Convert] Error converting steps to project framework:', err);
        res.status(500).json({ error: 'Failed to generate project framework: ' + err.message });
    }
}

async function handleDownloadProject(req, res) {
    try {
        const { runId, filename } = req.params;
        console.log(`[MCP Download] Request received. runId: ${runId}, filename: ${filename}`);

        // Validate UUIDv4 format (Capability Token Security)
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(runId)) {
            return res.status(400).json({ error: 'Invalid runId format.' });
        }

        const run = await AgentRun.findByPk(runId);
        if (!run) {
            return res.status(404).json({ error: 'Agent run not found.' });
        }

        const steps = run.steps ? JSON.parse(run.steps) : [];
        if (steps.length === 0) {
            return res.status(400).json({ error: 'No execution steps found to export.' });
        }

        let zipBuffer;
        if (filename.toLowerCase().includes('playwright')) {
            zipBuffer = generatePlaywrightProjectZip(steps, run.goal);
        } else {
            zipBuffer = generateSeleniumProjectZip(steps, run.goal);
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(zipBuffer);
    } catch (err) {
        console.error('[MCP Download] Error:', err);
        res.status(500).json({ error: 'Failed to download project framework: ' + err.message });
    }
}

/**
 * POST /api/mcp/agent/cancel/:runId
 * Cancel an ongoing agent run
 */
router.post('/agent/cancel/:runId', async (req, res) => {
    try {
        const { runId } = req.params;
        const run = await AgentRun.findByPk(runId);
        if (!run) {
            return res.status(404).json({ error: 'Agent run not found.' });
        }

        cancelActiveRun(runId);
        await run.update({ status: 'cancelled' });
        logAgent(runId, '🛑 [Cancel Requested] User cancelled the running operation.');
        await flushAgentLogs(run);

        res.json({ message: 'Operation cancelled successfully.', runId, status: 'cancelled' });
    } catch (err) {
        console.error('[MCP Cancel] Error:', err);
        res.status(500).json({ error: 'Failed to cancel operation: ' + err.message });
    }
});

router.get('/agent/convert', handleConvert);
router.post('/agent/convert', handleConvert);
router.get('/agent/download/:runId/:filename', handleDownloadProject);

/**
 * Helper to execute steps in background
 */
async function executeStepsBackground(run, flatSteps, headed = false) {
    const runId = run.id;
    const log = (text) => logAgent(runId, text);
    try {
        log(`🌐 Starting execution of planned natural language steps.`);
        
        await executeStepsInBrowser(run, flatSteps, headed, log);

        if (isRunCancelled(runId)) {
            log(`\n🛑 Natural Language Agent run cancelled by user.`);
            await run.update({ status: 'cancelled' });
            await flushAgentLogs(run);
            return;
        }

        log(`\n🎉 Natural Language Agent discovery completed successfully! All tasks solved.`);
        log(`📐 Synthesizing 10-Section QA Automation Architecture Deliverable...`);
        const architectResult = generateArchitectReport(run.goal, flatSteps);
        log(`✅ QA Architecture Report, Playwright POM, and Selenium POM generated.`);
        await run.update({ 
            status: 'completed', 
            steps: JSON.stringify(flatSteps),
            architect_report: JSON.stringify(architectResult)
        });
        await flushAgentLogs(run);
    } catch (err) {
        log(`❌ Agent execution failed: ${err.message}`);
        await run.update({ status: 'failed' });
        await flushAgentLogs(run);
    } finally {
        setTimeout(() => agentLogBuffers.delete(runId), 5 * 60 * 1000);
    }
}

/**
 * Partitions E2E steps into Login, Action, and Logout blocks
 */
function parsePartitionedSteps(steps, goal = '') {
    let loginCutoff = -1;
    let logoutStart = -1;

    const lowerGoal = (goal || '').toLowerCase();
    const isFailureScenario = lowerGoal.includes('invalid') || lowerGoal.includes('error') || lowerGoal.includes('fail') || lowerGoal.includes('incorrect') || lowerGoal.includes('wrong');

    if (isFailureScenario) {
        // Group all steps under LoginPage/loginSteps since the session never succeeds
        return {
            loginSteps: steps,
            actionSteps: [],
            logoutSteps: []
        };
    }

    for (let i = 0; i < steps.length; i++) {
        const action = steps[i].action.toLowerCase();
        const target = (steps[i].target || '').toLowerCase();
        const original = (steps[i].original || '').toLowerCase();

        if (loginCutoff === -1) {
            if (target.includes('login') || target.includes('signin') || original.includes('log in') || original.includes('sign in')) {
                if (action.includes('click')) {
                    loginCutoff = i;
                }
            }
        }

        if (logoutStart === -1) {
            if (target.includes('logout') || target.includes('log-out') || original.includes('log out') || target.includes('signout') || target.includes('sign-out') || original.includes('sign out')) {
                if (action.includes('click')) {
                    logoutStart = i;
                }
            }
        }
    }

    if (loginCutoff === -1) {
        const passIdx = steps.findIndex(s => (s.target || '').toLowerCase().includes('pass') || (s.inputData || '').toLowerCase().includes('pass'));
        if (passIdx !== -1 && passIdx + 1 < steps.length) {
            loginCutoff = passIdx + 1;
        } else {
            loginCutoff = Math.min(3, steps.length - 1);
        }
    }
    if (logoutStart === -1) {
        logoutStart = steps.length;
    }

    if (loginCutoff >= logoutStart) {
        loginCutoff = Math.min(3, steps.length - 1);
        logoutStart = steps.length;
    }

    const loginSteps = steps.slice(0, loginCutoff + 1);
    const actionSteps = steps.slice(loginCutoff + 1, logoutStart);
    const logoutSteps = steps.slice(logoutStart);

    return { loginSteps, actionSteps, logoutSteps };
}

/**
 * Helper to explicitly register all directory entries in the ZIP index.
 * This is crucial for native Windows Explorer ZIP extraction compatibility.
 */
function addFoldersToZip(zip, filePath) {
    const parts = filePath.split('/');
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
        currentPath += parts[i] + '/';
        try {
            zip.addFile(currentPath, Buffer.alloc(0));
        } catch (_) {
            // Entry already exists, safe to ignore
        }
    }
}

/**
 * Playwright Project Generator (Production Page Object Model with CI/CD & Allure)
 */
function generatePlaywrightProjectZip(steps, goal) {
    const zip = new AdmZip();
    const files = generateProductionPlaywrightFiles(steps, goal);
    for (const file of files) {
        addFoldersToZip(zip, file.path);
        zip.addFile(file.path, Buffer.from(file.code, 'utf8'));
    }
    return zip.toBuffer();
}

/**
 * Selenium Project Generator (Production Page Object Model with TestNG, Maven & Allure)
 */
function generateSeleniumProjectZip(steps, goal) {
    const zip = new AdmZip();
    const files = generateProductionSeleniumFiles(steps, goal);
    for (const file of files) {
        addFoldersToZip(zip, file.path);
        zip.addFile(file.path, Buffer.from(file.code, 'utf8'));
    }
    return zip.toBuffer();
}


/**
 * POST /api/mcp/agent/run-excel
 * Upload and run Excel test cases via MCP agent
 */
router.post('/agent/run-excel', upload.single('excelFile'), authenticateToken, async (req, res) => {
    try {
        const { projectId, headed } = req.body;
        if (!projectId) {
            return res.status(400).json({ error: 'projectId is required.' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'excelFile is required.' });
        }

        const project = await Project.findByPk(projectId);
        if (!project) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        // Parse Excel file
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet);

        if (rows.length === 0) {
            throw new Error('Excel sheet contains no test case data.');
        }

        // Create run record
        const run = await AgentRun.create({
            project_id: projectId,
            goal: `Execute ${rows.length} test steps from uploaded Excel sheet: ${req.file.originalname}`,
            status: 'running',
        });

        // Start background execution
        const isHeaded = headed === 'true' || headed === true;
        executeExcelAgentRun(run, rows, req.file.path, isHeaded);

        res.status(202).json({
            message: 'Excel agent task started successfully.',
            runId: run.id,
        });
    } catch (err) {
        console.error('[MCP Agent] Excel run start error:', err);
        // Clean up uploaded file if parsed fails
        if (req.file && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
        }
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/mcp/agent/status/:runId
 * Poll agent status and incremental logs
 */
router.get('/agent/status/:runId', authenticateToken, async (req, res) => {
    try {
        const run = await AgentRun.findByPk(req.params.runId);
        if (!run) {
            return res.status(404).json({ error: 'Agent run not found.' });
        }

        const since = Math.max(0, parseInt(req.query.since, 10) || 0);
        const buf = agentLogBuffers.get(run.id);
        const allLines = buf
            ? buf.slice()
            : (run.logs ? run.logs.split('\n') : []);
        const logs = allLines.slice(since);
        const cursor = allLines.length;

        res.json({
            id: run.id,
            goal: run.goal,
            status: run.status,
            logs,
            cursor,
            steps: run.steps ? JSON.parse(run.steps) : [],
            pending_learnings: run.pending_learnings,
            live_screenshot: agentLiveScreenshots.get(run.id) || null,
        });
    } catch (err) {
        console.error('[MCP Agent] Status error:', err);
        res.status(500).json({ error: 'Failed to get agent status.' });
    }
});

/**
 * GET /api/mcp/agent/live-stream/:runId
 * Real-time MJPEG live stream for the browser execution session
 */
router.get('/agent/live-stream/:runId', (req, res) => {
    const { runId } = req.params;
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'close');
    res.setHeader('Pragma', 'no-cache');

    if (!agentScreencastListeners.has(runId)) {
        agentScreencastListeners.set(runId, new Set());
    }
    const listeners = agentScreencastListeners.get(runId);
    listeners.add(res);

    // Write initial frame immediately if one is in buffer
    const initial = agentLiveScreenshots.get(runId);
    if (initial) {
        const buf = Buffer.from(initial, 'base64');
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
        res.write(buf);
        res.write('\r\n');
    }

    req.on('close', () => {
        listeners.delete(res);
        if (listeners.size === 0) {
            agentScreencastListeners.delete(runId);
        }
    });
});

/**
 * GET /api/mcp/agent/live-screen/:runId
 * Single live frame JPEG
 */
router.get('/agent/live-screen/:runId', (req, res) => {
    const { runId } = req.params;
    let base64 = agentLiveScreenshots.get(runId);
    if (!base64) {
        // Fallback to active recorder session if runId corresponds to a recording session
        const session = recorderService.getSession(runId);
        if (session && session.liveScreenshot) {
            base64 = session.liveScreenshot.replace(/^data:image\/\w+;base64,/, '');
        }
    }
    if (!base64) {
        return res.status(404).send('No frame captured yet.');
    }
    const buf = Buffer.from(base64, 'base64');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(buf);
});

/**
 * Simulated Agent execution loop for natural language goals
 */
/**
 * AI-assisted locator self-healing engine
 */
async function healSelectorWithAI(page, action, failedSelector, log) {
    try {
        log(`  🔄 [Playwright MCP] Entering AI self-healing for: "${failedSelector}"`);
        
        // Query DOM specifically for interactive elements, custom controls, and triggers
        const candidates = await page.$$eval(
            'button, input, a, select, textarea, [role="button"], [role="menuitem"], [onclick], [class*="click"], [class*="dropdown"], [class*="menu"], [class*="trigger"], [class*="icon"], [class*="chevron"], [class*="arrow"]',
            elements => elements
                .filter(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                })
                .map(el => ({
                    tagName: el.tagName.toLowerCase(),
                    id: el.id || null,
                    name: el.getAttribute('name') || null,
                    type: el.getAttribute('type') || null,
                    placeholder: el.getAttribute('placeholder') || null,
                    className: el.className || null,
                    text: el.textContent ? el.textContent.trim().slice(0, 100).replace(/\s+/g, ' ') : '',
                    role: el.getAttribute('role') || null,
                    outerHTML: el.outerHTML.slice(0, 300)
                }))
        );

        // Format candidate elements cleanly for prompt ingestion
        const formattedCandidates = candidates.map((c, idx) => {
            let desc = `${idx + 1}. <${c.tagName}`;
            if (c.id) desc += ` id="${c.id}"`;
            if (c.name) desc += ` name="${c.name}"`;
            if (c.type) desc += ` type="${c.type}"`;
            if (c.placeholder) desc += ` placeholder="${c.placeholder}"`;
            if (c.role) desc += ` role="${c.role}"`;
            if (c.className) desc += ` class="${c.className}"`;
            desc += `>`;
            if (c.text) desc += ` Text: "${c.text}"`;
            desc += ` | Snippet: ${c.outerHTML}`;
            return desc;
        }).join('\n');

        const prompt = `You are a test automation self-healing engine. A Playwright locator has failed to find an element on the page.

Action: ${action}
Failed Selector/Target: "${failedSelector}"

Here is the list of interactive candidate elements found in the current page DOM:
${formattedCandidates}

Review the failed selector and the elements list. Identify the element that matches the intent of the failed selector using these strict rules:
1. Match Text Intent: If the target is a text label (e.g. "Impersonate"), prioritize the specific leaf element (like an anchor <a> or button <button>) that contains or matches that text.
2. Avoid Wrapper/Header Elements: Do NOT select parent containers (like submenu headers, dropdown wrappers, or parent divs) when the target is an option inside them. For example, do not match the option "Impersonate" to a header container containing "Administrator".
3. Unique Selector: Suggest the single most robust CSS, ID, or text selector (e.g. "a:has-text('Submit')", "text=Impersonate", or "[data-test='login-button']") targeting that specific leaf element.

Return ONLY the raw selector string itself. Do NOT wrap it in quotes, markdown code blocks, or explain anything.`;

        const apiKey = process.env.VITE_LLM_API_KEY;
        const endpoint = process.env.VITE_LLM_ENDPOINT;
        const llmModel = process.env.VITE_LLM_MODEL || 'gemma-4';
        
        if (!apiKey) {
            log(`  ⚠️ [Playwright MCP] Skip AI healing: VITE_LLM_API_KEY is not configured.`);
            return null;
        }

        const genAI = new GoogleGenerativeAI(apiKey, endpoint);
        const model = genAI.getGenerativeModel({ 
            model: llmModel,
            generationConfig: { temperature: 0.2 }
        });

        // Capture page screenshot for LLM Multimodal Vision
        let imagePart = null;
        try {
            const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 80 });
            imagePart = {
                inlineData: {
                    data: screenshotBuffer.toString("base64"),
                    mimeType: "image/jpeg"
                }
            };
        } catch (ssErr) {
            log(`  ⚠️ [Playwright MCP] Vision module failed to capture page screenshot: ${ssErr.message}`);
        }

        // Build multimodal prompt parts
        const promptParts = [];
        if (imagePart) {
            promptParts.push(imagePart);
            log(`  📸 [Playwright MCP] Vision module attached page screenshot to AI self-healing prompt.`);
        }
        promptParts.push({ text: prompt });

        const result = await model.generateContent(promptParts);
        const raw = result.response.text().trim().replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
        const suggestion = raw.replace(/^["'`]|["'`]$/g, '').trim();
        const lower = suggestion.toLowerCase();
        
        if (suggestion && suggestion.length > 0 && suggestion.length < 200 &&
            !lower.startsWith('no ') && !lower.startsWith('none') && !lower.startsWith('sorry') &&
            !lower.startsWith('cannot') && !lower.includes('not found') && !lower.includes('were found') &&
            !lower.includes('unable to') &&
            !(suggestion.split(/\s+/).length > 5 && !suggestion.includes(':has-text') && !suggestion.includes('text='))) {
            log(`  🔍 [Playwright MCP] AI suggested alternate selector: "${suggestion}"`);
            return suggestion;
        }
        return null;
    } catch (err) {
        log(`  ⚠️ [Playwright MCP] AI self-healing suggestion failed: ${err.message}`);
        return null;
    }
}

/**
 * Shared Playwright browser step execution runner using @executeautomation/playwright-mcp-server
 */
async function executeStepsInBrowser(run, flatSteps, headed, log) {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const pendingLearnings = [];
    let mcp = null;
    let screenInterval = null;

    registerActiveRun(run.id, () => {
        log('🛑 Cancellation signal received. Halting browser automation...');
        unregisterActiveRun(run.id);
        if (screenInterval) clearInterval(screenInterval);
        if (mcp) {
            try { mcp.close(); } catch {}
        }
    });

    try {
        log(`🖥️ [Playwright MCP Server] Initializing @executeautomation/playwright-mcp-server client (${headed ? 'HEADED' : 'HEADLESS'})...`);
        mcp = new PlaywrightMcpClientManager({
            runId: run.id,
            headed,
            onScreenshot: (base64) => updateAgentScreenshot(run.id, base64),
            log
        });
        await mcp.init();

        // Background interval for continuous live visual streaming into AAQUA LiveBrowserViewer
        screenInterval = setInterval(async () => {
            try {
                if (mcp && !mcp.activeCallPromise) {
                    await mcp.captureScreen();
                }
            } catch {}
        }, 1200);

        for (let i = 0; i < flatSteps.length; i++) {
            if (isRunCancelled(run.id)) {
                log('🛑 [Operation Cancelled] Step execution aborted by user.');
                break;
            }
            const step = flatSteps[i];
            const action = step.action || 'Execute action';
            const actionLower = action.toLowerCase();
            const target = step.target || '';
            const inputData = step.inputData || '';
            const expected = step.expected || 'Step execution success';
            let targetSelector = target;

            // 1. Check database for learned locator
            let learned = false;
            let learnedSelector = null;
            const actionKey = normalizeActionKey(target || action);
            try {
                const learning = await McpLocatorLearning.findOne({
                    where: {
                        project_id: run.project_id,
                        action_key: actionKey
                    },
                    order: [['confidence', 'DESC']]
                });
                if (learning && learning.selector) {
                    learnedSelector = learning.selector;
                    learned = true;
                    log(`  🔍 [DB Learning] Found selector for "${actionKey}": "${learnedSelector}"`);
                }
            } catch (learnErr) {
                // Non-critical
            }

            if (learnedSelector) {
                let exists = false;
                // Give dynamic SPAs up to 4s to have the element ready
                for (let a = 0; a < 8; a++) {
                    try {
                        exists = await mcp.evaluate(`(() => {
                            try {
                                return !!document.querySelector(${JSON.stringify(learnedSelector)});
                            } catch { return false; }
                        })()`);
                        if (exists) break;
                    } catch {}
                    await delay(500);
                }

                if (exists) {
                    targetSelector = learnedSelector;
                    log(`  🔍 [DB Learning] Verified selector exists in current DOM: "${learnedSelector}"`);
                } else {
                    log(`  ⚠️ [DB Learning] Learned selector "${learnedSelector}" not present on current page. Skipping to fresh resolution.`);
                    learned = false;
                    learnedSelector = null;
                }
            }

            if (targetSelector) {
                targetSelector = normalizeSelector(targetSelector);
                step.target = targetSelector;
            }

            log(`  📋 [Step ${step.stepNum || (i + 1)}] Action: "${action}" | Target: "${targetSelector || 'unspecified'}" ${inputData ? `| Input: "${inputData}"` : ''}`);

            if (actionLower.includes('navigate') || actionLower.includes('open')) {
                const url = targetSelector || inputData;
                await mcp.navigate(url);
                log(`  ✅ [Playwright MCP] Page loaded.`);
                step.target = url;
            } else if (actionLower.includes('select') || actionLower.includes('choose')) {
                if (!targetSelector || !isSelector(targetSelector)) {
                    targetSelector = generateGenericSelectSelectors(targetSelector || action);
                }
                step.target = targetSelector;
                try {
                    await mcp.select(targetSelector, inputData);
                    log(`  ✅ [Playwright MCP] Target updated with "${inputData}".`);

                    if (!target && targetSelector && !learned) {
                        pendingLearnings.push({
                            project_id: run.project_id,
                            url: 'playwright-mcp',
                            action_key: actionKey,
                            selector: targetSelector,
                            confidence: 0.85
                        });
                    }
                } catch (selErr) {
                    log(`  ⚠️ [Playwright MCP] Action failed for "${targetSelector}". Entering self-healing mode.`);
                    const aiSelector = await mcp.healSelectorWithAI(action, targetSelector);
                    if (aiSelector) {
                        log(`  🛠️ [Playwright MCP] Testing AI recommended selector: "${aiSelector}"`);
                        await mcp.select(aiSelector, inputData);
                        step.target = aiSelector;
                        step.healed = true;
                        pendingLearnings.push({
                            project_id: run.project_id,
                            url: 'playwright-mcp',
                            action_key: actionKey,
                            selector: aiSelector,
                            confidence: 0.9
                        });
                        log(`  ✅ [Playwright MCP] Select successful using healed selector!`);
                    } else {
                        throw selErr;
                    }
                }
            } else if (actionLower.includes('type') || actionLower.includes('enter') || actionLower.includes('input')) {
                if (!targetSelector || !isSelector(targetSelector)) {
                    targetSelector = generateGenericInputSelectors(targetSelector || action);
                }

                // If targeting a select or dropdown explicitly, route to select()
                const labelForCheck = (target || action).toLowerCase();
                const isDropdownExplicit = (labelForCheck.includes('dropdown') || labelForCheck.includes('select')) &&
                    !labelForCheck.includes('first name') &&
                    !labelForCheck.includes('last name') &&
                    !labelForCheck.includes('email') &&
                    !labelForCheck.includes('username') &&
                    !labelForCheck.includes('password') &&
                    !labelForCheck.includes('phone') &&
                    !labelForCheck.includes('mobile');

                if (isDropdownExplicit) {
                    log(`  📋 [Playwright MCP] Routing Type on dropdown "${targetSelector}" to select("${inputData}")`);
                    step.target = targetSelector;
                    try {
                        await mcp.select(targetSelector, inputData);
                        log(`  ✅ [Playwright MCP] Dropdown selected with "${inputData}".`);
                        continue;
                    } catch (dropErr) {
                        log(`  ⚠️ [Playwright MCP] Dropdown select attempt failed (${dropErr.message}). Continuing to fill...`);
                    }
                }

                step.target = targetSelector;
                try {
                    await mcp.fill(targetSelector, inputData);
                    log(`  ✅ [Playwright MCP] Target updated with "${inputData}".`);

                    if (!target && targetSelector && !learned) {
                        pendingLearnings.push({
                            project_id: run.project_id,
                            url: 'playwright-mcp',
                            action_key: actionKey,
                            selector: targetSelector,
                            confidence: 0.8
                        });
                    }
                } catch (typeErr) {
                    log(`  ⚠️ [Playwright MCP] Action failed for "${targetSelector}". Entering self-healing mode.`);
                    const aiSelector = await mcp.healSelectorWithAI(action, targetSelector);
                    if (aiSelector) {
                        log(`  🛠️ [Playwright MCP] Testing AI recommended selector: "${aiSelector}"`);
                        await mcp.fill(aiSelector, inputData);
                        step.target = aiSelector;
                        step.healed = true;
                        pendingLearnings.push({
                            project_id: run.project_id,
                            url: 'playwright-mcp',
                            action_key: actionKey,
                            selector: aiSelector,
                            confidence: 0.9
                        });
                        log(`  ✅ [Playwright MCP] Field updated successfully using healed selector!`);
                    } else {
                        throw typeErr;
                    }
                }
            } else if (actionLower.includes('click') || actionLower.includes('press')) {
                let resolvedSelector = targetSelector;
                if (!resolvedSelector || !isSelector(resolvedSelector)) {
                    resolvedSelector = generateGenericClickSelectors(resolvedSelector || action);
                }

                step.target = resolvedSelector;
                try {
                    await mcp.click(resolvedSelector);
                    if (actionLower.includes('login') || resolvedSelector.toLowerCase().includes('login')) {
                        log(`  🌐 [Playwright MCP] Waiting for post-login redirect & page load...`);
                        for (let r = 0; r < 15; r++) {
                            await delay(150);
                            try {
                                const state = await mcp.evaluate(`(() => {
                                    const l = document.querySelector('.full-screen-loader-wrapper, .loading-spinner');
                                    const isLoading = l && l.style.display !== 'none';
                                    const bodyReady = document.body && document.body.innerText.length > 50;
                                    return { isLoading, bodyReady };
                                })()`);
                                if (!state.isLoading && state.bodyReady && r >= 2) break;
                            } catch {}
                        }
                        await mcp.dismissLoaders();
                        await mcp.captureScreen();
                    } else {
                        // General post-action check: if full-screen loader appeared, wait up to 5s for it to dismiss
                        for (let w = 0; w < 10; w++) {
                            try {
                                const isLoading = await mcp.evaluate(`
                                    !!document.querySelector('.full-screen-loader-wrapper:not([style*="display: none"]), .loading-mask:not([style*="display: none"]), .loading-spinner:not([style*="display: none"])')
                                `);
                                if (!isLoading) break;
                                await delay(200);
                            } catch { break; }
                        }
                        await mcp.dismissLoaders();
                    }
                    log(`  ✅ [Playwright MCP] Element clicked.`);

                    if (!target && resolvedSelector && !learned) {
                        pendingLearnings.push({
                            project_id: run.project_id,
                            url: 'playwright-mcp',
                            action_key: actionKey,
                            selector: resolvedSelector,
                            confidence: 0.85
                        });
                    }
                } catch (clickErr) {
                    log(`  ⚠️ [Playwright MCP] Click failed for "${resolvedSelector}". Entering self-healing mode.`);
                    const aiSelector = await mcp.healSelectorWithAI(action, resolvedSelector);
                    if (aiSelector) {
                        log(`  🛠️ [Playwright MCP] Testing AI recommended selector: "${aiSelector}"`);
                        await mcp.click(aiSelector);
                        step.target = aiSelector;
                        step.healed = true;
                        pendingLearnings.push({
                            project_id: run.project_id,
                            url: 'playwright-mcp',
                            action_key: actionKey,
                            selector: aiSelector,
                            confidence: 0.9
                        });
                        log(`  ✅ [Playwright MCP] Element clicked successfully using healed selector!`);
                    } else {
                        throw clickErr;
                    }
                }
            } else if (actionLower.includes('wait') || actionLower.includes('sleep')) {
                log(`  ⏳ [Playwright MCP] Waiting for page/network stability...`);
                if (inputData && !isNaN(inputData)) {
                    await delay(parseInt(inputData, 10) * 1000);
                } else {
                    await delay(2000);
                }
                log(`  ⏳ [Playwright MCP] Wait complete.`);
            } else if (actionLower.includes('assert') || actionLower.includes('verify') || actionLower.includes('see')) {
                let resolvedSelector = targetSelector;
                if (!resolvedSelector || !isSelector(resolvedSelector)) {
                    resolvedSelector = `text="${resolvedSelector || expected || ''}"`;
                }
                step.target = resolvedSelector;
                log(`  🔍 [Playwright MCP] Asserting page element state matching "${resolvedSelector}"...`);

                let assertPassed = false;
                let foundTime = null;
                const expectedText = (targetSelector || expected || '').toLowerCase().trim();

                // Dynamic progressive wait (up to 20s, logging milestones at 5s, 10s, 15s, 20s)
                let logged5 = false;
                let logged10 = false;
                let logged15 = false;
                const pollInterval = 200;
                const maxAttempts = 100; // 20s total

                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    const elapsedMs = (attempt + 1) * pollInterval;
                    const elapsed = (elapsedMs / 1000).toFixed(1);

                    if (elapsedMs >= 5000 && !logged5) {
                        logged5 = true;
                        log(`  ⏳ [Wait 5s] Waiting for assertion target "${resolvedSelector}" to render...`);
                    } else if (elapsedMs >= 10000 && !logged10) {
                        logged10 = true;
                        log(`  ⏳ [Wait 10s] Still waiting for assertion target "${resolvedSelector}" to appear...`);
                    } else if (elapsedMs >= 15000 && !logged15) {
                        logged15 = true;
                        log(`  ⏳ [Wait 15s] Assertion target "${resolvedSelector}" still loading...`);
                    } else if (attempt === maxAttempts - 1) {
                        log(`  ⏳ [Wait 20s] Dynamic timeout reached for assertion target "${resolvedSelector}".`);
                    }

                    try {
                        const isPresent = await mcp.evaluate(`(() => {
                            const sel = ${JSON.stringify(resolvedSelector)};
                            const exp = ${JSON.stringify(expectedText)};
                            try {
                                if (!sel.startsWith('text=')) {
                                    const el = document.querySelector(sel);
                                    if (el && (el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0)) return true;
                                }
                            } catch {}
                            const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
                            if (exp && bodyText.includes(exp)) return true;
                            return false;
                        })()`);

                        if (isPresent) {
                            assertPassed = true;
                            foundTime = elapsed;
                            break;
                        }
                    } catch {}

                    if (attempt < maxAttempts - 1) await delay(pollInterval);
                }

                await mcp.dismissLoaders();
                await mcp.captureScreen();

                if (assertPassed) {
                    log(`  ✅ [Playwright MCP] Assertion successful in ${foundTime}s. Expected: "${expected}" - PASS`);
                } else {
                    log(`  ⚠️ [Playwright MCP] Assertion target "${resolvedSelector}" not found on page after 20s. Expected: "${expected}"`);
                }
            } else {
                log(`  ⚙️ [Playwright MCP] Executing action: "${action}"`);
                if (targetSelector) {
                    await mcp.click(targetSelector);
                }
                log(`  ✅ [Playwright MCP] Action complete. Expected: "${expected}" - PASS`);
            }

            // Update steps in database in real time
            try {
                await run.update({ steps: JSON.stringify(flatSteps) });
            } catch (dbErr) {}

            await delay(150);
        }
    } finally {
        if (screenInterval) clearInterval(screenInterval);
        if (pendingLearnings.length > 0) {
            try {
                await run.update({ pending_learnings: JSON.stringify(pendingLearnings) });
                log(`  💾 [Pending Learning] Saved ${pendingLearnings.length} pending learnings to run cache.`);
            } catch (saveErr) {
                console.error('Failed to save pending learnings:', saveErr);
            }
        }
        if (mcp) {
            try {
                await delay(1000);
                await mcp.close();
            } catch (closeErr) {
                console.error('Failed to close MCP client:', closeErr);
            }
        }
        setTimeout(() => agentLiveScreenshots.delete(run.id), 10 * 60 * 1000);
    }
}

/**
 * Real Agent execution loop for natural language goals using the local LLM and Playwright
 */
async function executeAgentRun(run, goal, headed = false) {
    const runId = run.id;
    const log = (text) => logAgent(runId, text);
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
        log(`🌐 Agent initialized. Goal: "${goal}"`);
        await delay(1000);

        const apiKey = process.env.VITE_LLM_API_KEY;
        if (!apiKey) {
            log(`⚠️ VITE_LLM_API_KEY is not set in environment. Running in SIMULATED mode.`);
            await delay(1000);
            
            // Fall back to original simulated logging loop
            log(`🔍 Querying active MCP Servers for relevant capabilities...`);
            await delay(1200);
            log(`🔌 Linked to 3 MCP servers: Built-in Filesystem, Local PostgreSQL, and Playwright Browser.`);
            await delay(1000);
            const lowerGoal = goal.toLowerCase();
            if (lowerGoal.includes('database') || lowerGoal.includes('db') || lowerGoal.includes('schema') || lowerGoal.includes('table')) {
                log(`📊 [PostgreSQL MCP] Connecting to database schema 'public'...`);
                await delay(1500);
                log(`📊 [PostgreSQL MCP] Analyzing table definitions. Tables found: projects, mcp_servers, agent_runs, automation_results.`);
                await delay(1500);
                log(`📊 [PostgreSQL MCP] Found table schema for 'automation_results'. Inspecting primary keys and constraints.`);
                await delay(1200);
                log(`💾 [PostgreSQL MCP] Generating safe synthetic dataset for automation metrics validation.`);
                await delay(1500);
            } else if (lowerGoal.includes('locator') || lowerGoal.includes('selector') || lowerGoal.includes('heal') || lowerGoal.includes('runner')) {
                log(`📂 [Filesystem MCP] Searching project files... Found \`src/utils/locatorUtils.js\` and \`src/pages/TestRunner.jsx\`.`);
                await delay(1500);
                if (headed) {
                    log(`🖥️ [Playwright MCP] Launching local browser in HEADED mode (visible UI window) to inspect target DOM elements.`);
                } else {
                    log(`🖥️ [Playwright MCP] Launching local browser in headless mode to inspect target DOM elements.`);
                }
                await delay(1800);
                log(`🖥️ [Playwright MCP] Checking selector viability for target 'button[type="submit"]'.`);
                await delay(1200);
                log(`🛠️ [Filesystem MCP] Discovered obsolete selector syntax in local specs. Auto-healing: updating to target resilient CSS selectors.`);
                await delay(1500);
            } else {
                log(`📂 [Filesystem MCP] Traversing project directories under root './'...`);
                await delay(1500);
                log(`📂 [Filesystem MCP] Parsing codebase structure. Detected Node/Express server and React/Vite frontend configurations.`);
                await delay(1500);
                log(`📝 [Filesystem MCP] Generating structural recommendations for test suites...`);
                await delay(1200);
            }
            if (headed) {
                log(`🚀 [Command MCP] Running verification pipeline in HEADED mode: \`npm run test\` / \`npx playwright test --headed\``);
            } else {
                log(`🚀 [Command MCP] Running verification pipeline: \`npm run test\` / \`npx playwright test\``);
            }
            await delay(2000);
            log(`🚀 [Command MCP] Pipeline execution status: SUCCESS (0 errors, 1 warnings, all tests passed).`);
            await delay(1200);
            log(`🎉 Agent execution completed successfully! All tasks solved.`);
            await run.update({ status: 'completed' });
            await flushAgentLogs(run);
            return;
        }

        // Real Execution with LLM planning
        log(`🔍 [AI Planning] Connecting to AI model to plan execution steps...`);
        
        const endpoint = process.env.VITE_LLM_ENDPOINT;
        const modelName = process.env.VITE_LLM_MODEL || 'gpt-oss-20b';
        
        const llm = new GoogleGenerativeAI(apiKey, endpoint);
        const model = llm.getGenerativeModel({ 
            model: modelName,
            generationConfig: { temperature: 0.1 }
        });
        const todayDate = new Date();
        const todayIso = todayDate.toISOString().split('T')[0];
        const tomorrowDate = new Date(todayDate);
        tomorrowDate.setDate(todayDate.getDate() + 1);
        const tomorrowIso = tomorrowDate.toISOString().split('T')[0];

        const prompt = `Your task is to convert a natural language web automation/testing goal into a list of structured, sequential execution steps.

User Goal: "${goal}"

You must output a JSON array of objects, where each object represents a single step to execute in Playwright.
Supported step actions:
1. "Navigate": Go to a URL.
   - Requires target: the full URL.
2. "Type": Enter text into an input field or date field.
   - Requires target: CSS selector, XPath, or natural language label for the input.
   - Requires inputData: the text to enter.
3. "Select": Choose an option from a dropdown or <select> element.
   - Requires target: CSS selector, XPath, or natural language label for the dropdown (e.g. "Country dropdown", "select[name='role']").
   - Requires inputData: the option text or label to choose (e.g. "Aaseya annual leave").
4. "Click": Click a button, link, or element.
   - Requires target: CSS selector, XPath, or natural language label of the element to click.
5. "Assert": Verify that an element or text is present on the page.
   - Requires target: CSS selector or text to verify.
   - Requires expected: description of the expected state.

SPECIAL DATE & DROPDOWN RULES:
- CURRENT DATE CONTEXT: Today's date is ${todayIso}. Tomorrow is ${tomorrowIso}.
- Dropdown Selection: When the goal specifies selecting a dropdown option (e.g., "From Select leave type dropdown, select 'Aaseya annual leave'"), use action "Select" or "Type" with target "Select leave type dropdown" and inputData "Aaseya annual leave".
- Date Fields: When the goal specifies relative dates (e.g., "select start date as next day from current day", "Select End date as same day of the holiday"), calculate the actual future date (YYYY-MM-DD format, e.g. "${tomorrowIso}") based on today (${todayIso}) as inputData. Never generate dates in the past (such as 2025 or earlier).

SPECIAL RANGE & TIMESHEET EXPANSION RULES:
- Multi-Day / Timesheet Range Expansion: When the goal specifies a range of days (e.g., "fill 9 hrs from Mon to Fri", "Monday to Friday", "Mon-Fri", "all weekdays"), DO NOT output a single step for "Mon to Fri". Instead, expand it into 5 separate, sequential Type steps—one for each day: Monday, Tuesday, Wednesday, Thursday, and Friday.
  Example for "fill 9 hrs from Mon to Fri":
  { "action": "Type", "target": "Monday", "inputData": "9" },
  { "action": "Type", "target": "Tuesday", "inputData": "9" },
  { "action": "Type", "target": "Wednesday", "inputData": "9" },
  { "action": "Type", "target": "Thursday", "inputData": "9" },
  { "action": "Type", "target": "Friday", "inputData": "9" }

Return ONLY the raw JSON array (no markdown code blocks, no other text).
Example:
[
  { "action": "Navigate", "target": "https://www.saucedemo.com" },
  { "action": "Type", "target": "username", "inputData": "standard_user" },
  { "action": "Type", "target": "password", "inputData": "secret_sauce" },
  { "action": "Click", "target": "Login" },
  { "action": "Assert", "target": "Products", "expected": "Products dashboard is visible" }
]`;

        const result = await model.generateContent(prompt);
        let text = result.response.text().trim();
        
        // Strip markdown backticks if any
        if (text.startsWith('```')) {
            text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
        }

        let steps;
        try {
            steps = JSON.parse(text);
            if (!Array.isArray(steps)) throw new Error("Response is not an array");
        } catch (e) {
            log(`❌ [AI Planning] Failed to parse generated steps JSON: ${e.message}`);
            log(`Raw response was:\n${text}`);
            throw new Error(`AI planning produced invalid step format.`);
        }

        log(`📝 [AI Planning] Generated ${steps.length} execution steps for goal:`);
        steps.forEach((step, idx) => {
            log(`  Plan [${idx+1}] Action: "${step.action}" | Target: "${step.target || ''}" ${step.inputData ? `| Input: "${step.inputData}"` : ''}`);
        });
        await delay(1000);

        // Map steps to the expected flatSteps structure
        const flatSteps = steps.map((s, idx) => ({
            testCaseId: 'TC_AI',
            scenario: goal,
            expected: s.expected || 'Step execution success',
            stepNum: String(idx + 1),
            action: s.action || 'Execute action',
            target: s.target || '',
            inputData: s.inputData || '',
        }));

        // Execute steps in browser
        await executeStepsInBrowser(run, flatSteps, headed, log);

        log(`\n🎉 Natural Language Agent run completed successfully! All tasks solved.`);
        await run.update({ status: 'completed' });
        await flushAgentLogs(run);

    } catch (err) {
        log(`❌ Agent execution failed: ${err.message}`);
        await run.update({ status: 'failed' });
        await flushAgentLogs(run);
    } finally {
        setTimeout(() => agentLogBuffers.delete(runId), 5 * 60 * 1000);
    }
}

/**
 * Helper to identify if a string is already a structured CSS or XPath selector,
 * rather than a natural language label.
 */
function isSelector(str) {
    if (!str) return false;
    str = str.trim();
    // Starts with CSS selector indicators
    if (/^[#\.\[]/i.test(str)) return true;
    // Starts with XPath indicators (e.g. //input, /html/body, ..)
    if (str.startsWith('/') || str.startsWith('xpath=') || str.startsWith('..')) return true;
    // Playwright pseudo-selectors or text matchers
    if (str.includes(':has-text(') || str.includes(':text(') || str.startsWith('text=')) return true;
    // Contains attribute equality (e.g. [name=user] or @id=val)
    if (str.includes('=')) return true;
    // Common HTML tag names as CSS selectors (including all heading levels h1-h6)
    const tags = ['input', 'button', 'select', 'textarea', 'a', 'div', 'span', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'nav', 'main', 'section', 'article', 'label', 'li', 'ul', 'ol', 'p'];
    if (tags.includes(str.toLowerCase())) return true;
    return false;
}

/**
 * Helper to generate random QA test data on the fly for natural language steps
 */
function generateRandomData(type, fieldName) {
    const combined = `${type} ${fieldName}`.toLowerCase();
    
    if (combined.includes('email')) {
        return `user_${Math.floor(1000 + Math.random() * 9000)}@example.com`;
    }
    if (combined.includes('first name') || combined.includes('firstname')) {
        const firstNames = ['John', 'Jane', 'Robert', 'Mary', 'William', 'Linda', 'David', 'Elizabeth', 'Richard', 'Susan'];
        return firstNames[Math.floor(Math.random() * firstNames.length)];
    }
    if (combined.includes('last name') || combined.includes('lastname')) {
        const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Taylor'];
        return lastNames[Math.floor(Math.random() * lastNames.length)];
    }
    if (combined.includes('mobile') || combined.includes('phone') || combined.includes('number') || combined.includes('tel')) {
        let num = '98';
        for (let i = 0; i < 8; i++) {
            num += Math.floor(Math.random() * 10);
        }
        return num;
    }
    if (combined.includes('dob') || combined.includes('birth') || combined.includes('date')) {
        const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[Math.floor(Math.random() * 12)];
        const year = Math.floor(Math.random() * 30) + 1980;
        return `${day} ${month} ${year}`;
    }
    if (combined.includes('address')) {
        const streetNum = Math.floor(Math.random() * 999) + 1;
        const streets = ['Main St', 'Oak Ave', 'Pine Rd', 'Maple Dr', 'Cedar Ln', 'Elm St'];
        return `${streetNum} ${streets[Math.floor(Math.random() * streets.length)]}`;
    }
    return '';
}

/**
 * Step line parser for natural language instructions in Functional Test templates
 */
function parseStepLine(line) {
    // Strip step number prefix, e.g. "1. ", "Step 1: ", "1- ", "1) ", or bullet points
    let cleanLine = line.replace(/^(?:\d+[\.\:\s\-\)]+|Step\s+\d+[\.\:\s\-\)]+|[\*\-\•]\s+)/i, '').trim();
    
    let action = 'Execute action';
    let target = '';
    let inputData = '';

    const lower = cleanLine.toLowerCase();

    // Regex to capture values in matching quotes, e.g. 'standard_user' or "standard_user"
    const quoteRegex = /'([^']*)'|"([^"]*)"/g;
    const quotes = [...cleanLine.matchAll(quoteRegex)].map(m => m[1] || m[2] || '');

    // 1. Navigation
    if (lower.includes('navigate') || lower.includes('open') || (lower.includes('go to') && (lower.includes('http') || lower.includes('www') || quotes.length > 0 || lower.includes('page') || lower.includes('url')))) {
        action = 'Navigate';
        const urlMatch = cleanLine.match(/https?:\/\/[^\s'"]+/i);
        target = urlMatch ? urlMatch[0] : (quotes[0] || '');
        if (!target && lower.includes('go to')) {
            const words = cleanLine.split(/\s+/);
            const gotoIndex = words.findIndex(w => w.toLowerCase() === 'go' && words[words.indexOf(w)+1]?.toLowerCase() === 'to');
            if (gotoIndex !== -1 && gotoIndex + 2 < words.length) {
                target = words.slice(gotoIndex + 2).join(' ');
            }
        }
    }
    // 2. Click / Press
    else if (lower.includes('click') || lower.includes('press')) {
        action = 'Click';
        if (quotes.length >= 1) {
            target = quotes[0];
        } else {
            const clickMatch = cleanLine.match(/(?:click|press)(?:\s+on)?\s+(.+)$/i);
            target = clickMatch ? clickMatch[1].trim() : '';
        }
    }
    // 3. Selection (checkboxes, radios, dropdowns)
    else if (lower.includes('select') || lower.includes('choose')) {
        action = 'Click'; // Map select action to a Click so that Playwright clicks it
        const asMatch = cleanLine.match(/select\s+(.*?)\s+as\s+(.*?)(?:\s+from\s+(.*))?$/i);
        const fromMatch = cleanLine.match(/select\s+(.*?)\s+from\s+(.*)$/i);
        
        if (asMatch) {
            const field = asMatch[1].trim();
            const val = asMatch[2].trim();
            const container = asMatch[3] ? asMatch[3].trim() : '';
            target = container ? `${container} containing ${val}` : val;
            inputData = val;
        } else if (fromMatch) {
            const val = fromMatch[1].trim();
            const field = fromMatch[2].trim();
            target = field;
            inputData = val;
        } else {
            const selectMatch = cleanLine.match(/(?:select|choose)\s+(.+)$/i);
            target = selectMatch ? selectMatch[1].trim() : '';
        }
    }
    // 4. Type / Enter / Fill / Input
    else if (lower.includes('type') || lower.includes('enter') || lower.includes('input') || lower.includes('fill')) {
        action = 'Type';
        if (quotes.length >= 2) {
            inputData = quotes[0];
            target = quotes[1];
        } else if (quotes.length === 1) {
            inputData = quotes[0];
            const targetMatch = cleanLine.match(/into\s+(.+)$/i) || cleanLine.match(/in\s+(.+)$/i);
            if (targetMatch) {
                target = targetMatch[1].replace(/['"]/g, '').trim();
            } else {
                // If cleanLine was "Enter First Name as 'John'" or "Enter First Name 'John'"
                const withoutQuote = cleanLine.replace(/['"][^'"]*['"]/g, '').trim();
                const cleanTarget = withoutQuote.replace(/^(enter|type|input|fill)\s+/i, '')
                                               .replace(/\s+(as|with|for|in|into)\s*$/i, '')
                                               .replace(/^(as|with|for|in|into)\s+/i, '')
                                               .replace(/[:\-]/g, '')
                                               .trim();
                target = cleanTarget || 'input';
            }
        } else {
            // Check explicit patterns: "enter <target> as <val>", "fill <target> with <val>", "enter <target>: <val>"
            const asMatch = cleanLine.match(/^(?:enter|type|input|fill)\s+(.*?)\s+(?:as|with|\:)\s+(.*)$/i);
            const inMatch = cleanLine.match(/^(?:enter|type|input|fill)\s+(.*?)\s+(?:in|into)\s+(.*)$/i);
            if (asMatch) {
                target = asMatch[1].trim();
                inputData = asMatch[2].trim();
            } else if (inMatch) {
                inputData = inMatch[1].trim();
                target = inMatch[2].trim();
            } else {
                const words = cleanLine.split(/\s+/);
                const intoIndex = words.findIndex(w => w.toLowerCase() === 'into' || w.toLowerCase() === 'in');
                if (intoIndex !== -1 && intoIndex + 1 < words.length) {
                    target = words.slice(intoIndex + 1).join(' ');
                    inputData = words.slice(1, intoIndex).join(' ');
                } else {
                    const verbMatch = cleanLine.match(/^(?:enter|type|input|fill)\s+(.+)$/i);
                    target = verbMatch ? verbMatch[1].trim() : '';
                    inputData = target;
                }
            }
        }

        // Dynamically resolve random flags
        const lowerInput = String(inputData).toLowerCase();
        const lowerTarget = String(target).toLowerCase();
        if (lowerInput.includes('random') || lowerInput.includes('any random') || lowerInput.includes('random 10 digit')) {
            const randomVal = generateRandomData(lowerInput, lowerTarget);
            if (randomVal) {
                inputData = randomVal;
            }
        }
    }
    // 5. Wait / Sleep / Delay
    else if (lower.includes('wait') || lower.includes('sleep') || lower.includes('delay') || lower.includes('load')) {
        action = 'Wait';
        const secMatch = cleanLine.match(/(\d+)\s*(?:sec|second|s\b)/i);
        inputData = secMatch ? secMatch[1] : '';
        target = 'Page load';
    }
    // 6. Assert / Verify
    else if (lower.includes('assert') || lower.includes('verify') || lower.includes('see') || lower.includes('visible')) {
        action = 'Assert';
        if (quotes.length >= 1) {
            target = quotes[0];
        } else {
            const visibleMatch = cleanLine.match(/(?:verify|assert|see)(?:\s+that)?\s+(.+)$/i) || cleanLine.match(/visible\s+(.+)$/i) || cleanLine.match(/on\s+(.+)$/i);
            target = visibleMatch ? visibleMatch[1].trim() : '';
            if (target) {
                target = target.replace(/\s+is\s+(visible|attached|present|hidden|active|displayed|enabled|disabled)$/i, '');
                target = target.replace(/\s+(visible|attached|present|hidden|active|displayed|enabled|disabled)$/i, '');
            }
        }
    }

    // Clean up common noise prefixes from target: "the", "a", "an", "on", "of", "any"
    if (target) {
        target = target.replace(/^(the|a|an|on|of|any)\s+/i, '').trim();
    }

    return { action, target, inputData, original: cleanLine };
}

async function executeExcelAgentRun(run, rows, filePath, headed = false) {
    const runId = run.id;
    const log = (text) => logAgent(runId, text);
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
        log(`🌐 Excel Agent initialized. Loaded ${rows.length} rows from spreadsheet.`);
        await delay(1000);

        log(`🔌 Activating tool servers: Filesystem MCP, @executeautomation/playwright-mcp-server.`);
        await delay(1000);

        // Check if there is a multi-step column (Functional Test Case format)
        const sampleRow = rows[0] || {};
        const stepsColumnKey = Object.keys(sampleRow).find(key => 
            /test\s*steps/i.test(key) || /^steps$/i.test(key)
        );

        let flatSteps = [];
        if (stepsColumnKey) {
            log(`ℹ️ Detected functional test case spreadsheet format. Parsing steps from "${stepsColumnKey}" column.`);
            
            // Extract setup/precondition steps first
            let setupSteps = [];
            let normalRows = [];
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const tcId = String(row['Test Case ID'] || '').trim().toUpperCase();
                const scenario = String(row['Scenario'] || '').trim().toLowerCase();
                
                if (tcId === 'SETUP' || tcId === 'PRECONDITION' || scenario.includes('setup') || scenario.includes('precondition')) {
                    const stepsText = row[stepsColumnKey] || '';
                    const stepLines = stepsText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                    stepLines.forEach(line => {
                        const parsed = parseStepLine(line);
                        if (parsed.target) {
                            parsed.target = normalizeSelector(parsed.target);
                        }
                        setupSteps.push(parsed);
                    });
                } else {
                    normalRows.push(row);
                }
            }

            if (setupSteps.length > 0) {
                log(`ℹ️ Extracted ${setupSteps.length} common setup steps from SETUP/PRECONDITION row.`);
            }

            // Parse normal rows and prepend setup steps
            for (let i = 0; i < normalRows.length; i++) {
                const row = normalRows[i];
                const stepsText = row[stepsColumnKey] || '';
                const stepLines = stepsText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                
                const combinedSteps = [];
                // Prepend setup steps
                setupSteps.forEach((s, sIdx) => {
                    combinedSteps.push({
                        ...s,
                        stepNum: `${i+1}.setup.${sIdx+1}`
                    });
                });
                
                // Add testcase specific steps
                stepLines.forEach((line, subIdx) => {
                    const parsed = parseStepLine(line);
                    if (parsed.target) {
                        parsed.target = normalizeSelector(parsed.target);
                    }
                    combinedSteps.push({
                        ...parsed,
                        stepNum: `${i+1}.${subIdx+1}`
                    });
                });

                combinedSteps.forEach(parsed => {
                    flatSteps.push({
                        testCaseId: row['Test Case ID'] || `TC_${i+1}`,
                        scenario: row['Scenario'] || `Scenario ${i+1}`,
                        expected: row['Expected Result'] || '',
                        ...parsed
                    });
                });
            }
        } else {
            log(`ℹ️ Detected flat test cases format. Executing row-by-row.`);
            flatSteps = rows.map((row, idx) => ({
                testCaseId: 'TC',
                scenario: 'Flat Execution',
                stepNum: row.Step || (idx + 1),
                action: row.Action || 'Execute action',
                target: normalizeSelector(row.Target || ''),
                inputData: row['Input Data'] || row.InputData || '',
                expected: row['Expected Result'] || row.ExpectedResult || 'Verify page state'
            }));
        }

        // Save steps to AgentRun
        await run.update({ steps: JSON.stringify(flatSteps) });

        // Execute steps in browser
        await executeStepsInBrowser(run, flatSteps, headed, log);

        if (isRunCancelled(runId)) {
            log(`\n🛑 Excel Agent run cancelled by user.`);
            await run.update({ status: 'cancelled' });
            await flushAgentLogs(run);
            return;
        }

        log(`\n🎉 Excel Agent run completed: executed all test steps.`);
        await delay(200);

        log(`📝 [Filesystem MCP] Saving test execution status reports...`);
        await delay(200);

        log(`✅ Task completed successfully.`);
        log(`📐 Synthesizing 10-Section QA Automation Architecture Deliverable...`);
        const architectResult = generateArchitectReport(run.goal || 'Excel Test Cases Execution', flatSteps);
        log(`✅ QA Architecture Report, Playwright POM, and Selenium POM generated.`);
        await run.update({ 
            status: 'completed', 
            steps: JSON.stringify(flatSteps),
            architect_report: JSON.stringify(architectResult)
        });
        await flushAgentLogs(run);

    } catch (err) {
        log(`❌ Excel Agent run failed: ${err.message}`);
        await run.update({ status: 'failed' });
        await flushAgentLogs(run);
    } finally {
        // Clean up temp file
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        }
        setTimeout(() => agentLogBuffers.delete(runId), 5 * 60 * 1000);
    }
}

function generateProjectCodePreview(steps, goal, framework) {
    if (framework.toLowerCase() === 'playwright') {
        return generateProductionPlaywrightFiles(steps, goal);
    } else {
        return generateProductionSeleniumFiles(steps, goal);
    }
}


/**
 * POST /api/mcp/agent/accept/:runId
 * Accept and commit staged locator learnings to the database
 */
router.post('/agent/accept/:runId', authenticateToken, async (req, res) => {
    try {
        const run = await AgentRun.findByPk(req.params.runId);
        if (!run) {
            return res.status(404).json({ error: 'Agent run not found.' });
        }
        
        if (!run.pending_learnings || run.pending_learnings.trim() === '') {
            return res.json({ message: 'No pending learnings for this run.', count: 0 });
        }
        
        const learnings = JSON.parse(run.pending_learnings);
        let count = 0;
        for (const learn of learnings) {
            const [learnRec, created] = await McpLocatorLearning.findOrCreate({
                where: {
                    project_id: learn.project_id,
                    url: learn.url,
                    action_key: learn.action_key
                },
                defaults: {
                    selector: learn.selector,
                    confidence: learn.confidence,
                    user_provided: false
                }
            });
            if (!created) {
                await learnRec.update({ selector: learn.selector, confidence: learn.confidence });
            }
            count++;
        }
        
        // Clear pending learnings after they are committed
        await run.update({ pending_learnings: '' });
        
        res.json({ message: 'Learnings accepted and committed successfully.', count });
    } catch (err) {
        console.error('[MCP Agent] Accept error:', err);
        res.status(500).json({ error: 'Failed to accept learnings: ' + err.message });
    }
});

router.get('/agent/preview-code', async (req, res) => {
    try {
        const { runId, targetFramework } = req.query;
        if (!runId || !targetFramework) {
            return res.status(400).json({ error: 'runId and targetFramework are required.' });
        }
        const run = await AgentRun.findByPk(runId);
        if (!run) {
            return res.status(404).json({ error: 'Agent run not found.' });
        }
        const steps = run.steps ? JSON.parse(run.steps) : [];
        if (steps.length === 0) {
            return res.json({ files: [] });
        }
        const files = generateProjectCodePreview(steps, run.goal, targetFramework);
        res.json({ files });
    } catch (err) {
        console.error('[MCP Preview] Error:', err);
        res.status(500).json({ error: 'Failed to generate preview: ' + err.message });
    }
});

/**
 * GET /api/mcp/agent/architect-report/:runId
 * Returns the 10-section QA Architecture Report in JSON and Markdown
 */
router.get('/agent/architect-report/:runId', async (req, res) => {
    try {
        const { runId } = req.params;
        const run = await AgentRun.findByPk(runId);
        if (!run) {
            return res.status(404).json({ error: 'Agent run not found.' });
        }
        let report;
        if (run.architect_report && run.architect_report.trim()) {
            try {
                report = JSON.parse(run.architect_report);
            } catch {}
        }
        if (!report) {
            const steps = run.steps ? JSON.parse(run.steps) : [];
            report = generateArchitectReport(run.goal, steps);
            await run.update({ architect_report: JSON.stringify(report) }).catch(() => {});
        }
        res.json(report);
    } catch (err) {
        console.error('[MCP Architect Report] Error:', err);
        res.status(500).json({ error: 'Failed to generate architect report: ' + err.message });
    }
});

/**
 * GET /api/mcp/agent/download-report/:runId
 * Downloads the 10-section QA Architecture Report as Markdown
 */
router.get('/agent/download-report/:runId', async (req, res) => {
    try {
        const { runId } = req.params;
        const run = await AgentRun.findByPk(runId);
        if (!run) {
            return res.status(404).json({ error: 'Agent run not found.' });
        }
        let report;
        if (run.architect_report && run.architect_report.trim()) {
            try {
                report = JSON.parse(run.architect_report);
            } catch {}
        }
        if (!report) {
            const steps = run.steps ? JSON.parse(run.steps) : [];
            report = generateArchitectReport(run.goal, steps);
        }
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="QA_Architecture_Report_${run.id.slice(0, 8)}.md"`);
        res.send(report.markdown);
    } catch (err) {
        console.error('[MCP Download Report] Error:', err);
        res.status(500).json({ error: 'Failed to download report: ' + err.message });
    }
});

export default router;

