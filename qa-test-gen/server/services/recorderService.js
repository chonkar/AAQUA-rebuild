import { chromium, firefox, webkit } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { 
    generateProductionPlaywrightFiles, 
    generateProductionSeleniumFiles, 
    generateArchitectReport 
} from './qaArchitectService.js';

class RecorderService {
    constructor() {
        this.sessions = new Map();
        this.tempDir = path.join(os.tmpdir(), 'aaqua_recordings');
        if (!fs.existsSync(this.tempDir)) {
            try {
                fs.mkdirSync(this.tempDir, { recursive: true });
            } catch {}
        }
    }

    /**
     * Start a new recording session
     * @param {Object} options 
     * @returns {Object} session meta
     */
    async startSession({ url = 'https://demoqa.com/automation-practice-form', mode = 'smart', browserType = 'chromium', headed = true }) {
        const sessionId = 'rec_' + crypto.randomBytes(6).toString('hex');
        const session = {
            id: sessionId,
            url: url || 'about:blank',
            mode,
            browserType,
            headed,
            status: 'active',
            startTime: Date.now(),
            steps: [],
            logs: [`[Recorder] Session initialized at ${new Date().toLocaleTimeString()} for URL: "${url}"`],
            browser: null,
            context: null,
            page: null,
            process: null,
            outputFile: path.join(this.tempDir, `${sessionId}.js`),
            liveScreenshot: null
        };

        this.sessions.set(sessionId, session);

        if (mode === 'codegen') {
            await this._startCodegenMode(session);
        } else {
            await this._startSmartMode(session);
        }

        return {
            sessionId,
            mode,
            status: 'active',
            url: session.url,
            startTime: session.startTime
        };
    }

    /**
     * Smart Injected Event Recorder (Real-time step streaming as user interacts)
     */
    async _startSmartMode(session) {
        try {
            const browserLauncher = session.browserType === 'firefox' ? firefox 
                : session.browserType === 'webkit' ? webkit 
                : chromium;

            const launchArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--window-size=1280,800'
            ];

            session.browser = await browserLauncher.launch({
                headless: !session.headed,
                args: launchArgs
            });

            session.context = await session.browser.newContext({
                viewport: { width: 1280, height: 800 }
            });

            session.page = await session.context.newPage();
            session.pages = [session.page];
            session.activePageIndex = 0;

            // Multi-Tab & Popup Window Support: Automatically capture and switch to any newly opened tab/window
            session.context.on('page', async (newPage) => {
                session.logs.push(`[New Tab] Detected new tab/window: ${newPage.url() || 'about:blank'}`);
                if (!session.pages.includes(newPage)) {
                    session.pages.push(newPage);
                }
                session.page = newPage;
                session.activePageIndex = session.pages.indexOf(newPage);

                await newPage.waitForLoadState('domcontentloaded').catch(() => {});
                await newPage.bringToFront().catch(() => {});

                const currentUrl = newPage.url() || 'New Tab';
                session.logs.push(`[New Tab] Switched view to: ${currentUrl}`);

                // Record step for opening / switching to new tab
                const stepNum = session.steps.length + 1;
                session.steps.push({
                    testCaseId: 'TC_REC',
                    stepNum: String(stepNum),
                    action: 'SwitchToTab',
                    target: currentUrl,
                    inputData: String(session.activePageIndex),
                    expected: `Switched to newly opened tab/window: ${currentUrl}`,
                    timestamp: new Date().toISOString()
                });

                await this._wirePageEvents(session, newPage);

                try {
                    const buf = await newPage.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
                    if (buf) {
                        session.liveScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
                    }
                } catch {}

                newPage.on('close', async () => {
                    session.pages = session.pages.filter(p => p !== newPage && !p.isClosed());
                    if (session.page === newPage) {
                        session.page = session.pages[session.pages.length - 1] || null;
                        session.activePageIndex = Math.max(0, session.pages.length - 1);
                        if (session.page && !session.page.isClosed()) {
                            await session.page.bringToFront().catch(() => {});
                            const buf = await session.page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
                            if (buf) session.liveScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
                        }
                    }
                });
            });

            // Wire initial page
            await this._wirePageEvents(session, session.page);

            // Browser Closed Listener
            session.browser.on('disconnected', () => {
                session.status = 'completed';
                session.logs.push(`[Recorder] Browser closed by user. Recording finalized.`);
            });

            // Initial Navigation
            if (session.url && session.url !== 'about:blank') {
                session.logs.push(`[Recorder] Navigating to initial URL: ${session.url}`);
                await session.page.goto(session.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
                if (session.page && !session.page.isClosed()) {
                    session.page.screenshot({ type: 'jpeg', quality: 50 })
                        .then(buf => { session.liveScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64'); })
                        .catch(() => {});
                }
            }

        } catch (err) {
            session.status = 'error';
            session.logs.push(`[Error] Failed to launch smart recorder: ${err.message}`);
            throw err;
        }
    }

    /**
     * Injects action recorder script and server communication bridges into a page
     */
    async _wirePageEvents(session, targetPage) {
        if (!targetPage || targetPage.isClosed()) return;

        // Expose server bridge for recording actions from the page
        await targetPage.exposeFunction('__aaquaRecordAction', (actionObj) => {
            if (!actionObj) return;

            if (actionObj.action === 'Stop') {
                this.stopSession(session.id).catch(() => {});
                return;
            }

            const target = actionObj.selector || actionObj.target || 'N/A';

            // If user typed into the same target field, update the existing step rather than spamming
            if (actionObj.action === 'Type' && session.steps.length > 0) {
                const lastStep = session.steps[session.steps.length - 1];
                if (lastStep.action === 'Type' && lastStep.target === target) {
                    lastStep.inputData = actionObj.value || actionObj.inputData || '';
                    lastStep.timestamp = new Date().toISOString();
                    return;
                }
            }

            // If consecutive duplicate Click on identical target, ignore
            if (actionObj.action === 'Click' && session.steps.length > 0) {
                const lastStep = session.steps[session.steps.length - 1];
                if (lastStep.action === 'Click' && lastStep.target === target) {
                    return;
                }
            }

            const stepNum = session.steps.length + 1;
            const formattedStep = {
                testCaseId: 'TC_REC',
                stepNum: String(stepNum),
                action: actionObj.action || 'Click',
                target: target,
                inputData: actionObj.value || actionObj.inputData || '',
                expected: actionObj.action === 'Navigate' 
                    ? `Navigated to ${target}`
                    : `${actionObj.action} completed on ${target || 'element'}`,
                timestamp: new Date().toISOString()
            };

            session.steps.push(formattedStep);
            session.logs.push(`[Step ${stepNum}] ${formattedStep.action} -> ${formattedStep.target} ${formattedStep.inputData ? `("${formattedStep.inputData}")` : ''}`);

            // Capture live screenshot for embedded viewer
            if (session.page && !session.page.isClosed()) {
                session.page.screenshot({ type: 'jpeg', quality: 50 })
                    .then(buf => { session.liveScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64'); })
                    .catch(() => {});
            }
        }).catch(() => {});

        const injectionFunction = () => {
            (() => {
                if (window.__aaquaRecorderInjected) return;
                window.__aaquaRecorderInjected = true;

                // 1. Selector Generator Engine
                function getOptimalSelector(el) {
                    if (!el || el === document.body || el === document.documentElement) return 'body';

                    // Priority 1: Stable, clean ID attribute
                    if (el.id && !/b\d+[-_]l\d+/i.test(el.id) && !/[a-f0-9]{8}-[a-f0-9]{4}/i.test(el.id)) {
                        return '#' + el.id;
                    }

                    // Priority 2: data-testid or data-test
                    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
                    if (testId) return `[data-testid="${testId}"]`;

                    // Priority 3: Modal Close and Modal Action Buttons
                    if (el.closest('.modal, [role="dialog"]')) {
                        const modal = el.closest('.modal, [role="dialog"]');
                        if (el.id === 'closeLargeModal') return '#closeLargeModal';
                        const btnText = (el.innerText || el.textContent || '').trim();
                        if (btnText && btnText.length < 20) {
                            return `.modal button:has-text("${btnText}"), [role="dialog"] button:has-text("${btnText}")`;
                        }
                    }

                    // Priority 4: Button, link, or heading with readable text
                    const tag = el.tagName.toLowerCase();
                    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
                    if ((tag === 'button' || el.getAttribute('role') === 'button') && text && text.length < 30) {
                        return `button:has-text("${text}")`;
                    }
                    if (tag === 'a' && text && text.length < 30) {
                        return `a:has-text("${text}")`;
                    }
                    // Priority 4.5: Headings (h1 - h6)
                    if (/^h[1-6]$/.test(tag) && text && text.length < 50) {
                        return `${tag}:has-text("${text}")`;
                    }
                    // Priority 4.6: Card wrappers containing headings
                    if ((el.classList?.contains('card') || el.classList?.contains('top-card') || (typeof el.className === 'string' && el.className.includes('card'))) && text) {
                        const heading = el.querySelector('h1, h2, h3, h4, h5, h6');
                        if (heading && (heading.innerText || heading.textContent)) {
                            const hText = (heading.innerText || heading.textContent).trim();
                            return `${heading.tagName.toLowerCase()}:has-text("${hText}")`;
                        }
                        if (text.length < 40) {
                            return `.card:has-text("${text}")`;
                        }
                    }

                    // Priority 5: Form inputs with name or placeholder
                    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                        if (el.name) return `${tag}[name="${el.name}"]`;
                        if (el.placeholder) return `${tag}[placeholder="${el.placeholder}"]`;
                        if (el.getAttribute('aria-label')) return `${tag}[aria-label="${el.getAttribute('aria-label')}"]`;
                    }

                    // Priority 6: Associated label for inputs (e.g. Radio/Checkbox labels)
                    if (tag === 'label' && text && text.length < 30) {
                        return `label:has-text("${text}")`;
                    }
                    if (el.id) {
                        const label = document.querySelector(`label[for="${el.id}"]`);
                        if (label && label.innerText) {
                            return `label:has-text("${label.innerText.trim()}")`;
                        }
                    }

                    // Priority 7: Clean class selector
                    if (el.className && typeof el.className === 'string') {
                        const classes = el.className.split(/\s+/).filter(c => c && !c.includes(':') && !/^(active|focus|hover|show)/i.test(c));
                        if (classes.length > 0) {
                            return `${tag}.${classes.slice(0, 2).join('.')}`;
                        }
                    }

                    return tag;
                }

                // 2. Click Interceptor
                let lastClickSelector = '';
                let lastClickTime = 0;

                document.addEventListener('click', (e) => {
                    if (e.target && e.target.closest('#aaqua-recorder-banner')) return;

                    const el = e.target;
                    if (el.tagName === 'INPUT' && ['text', 'email', 'password', 'number', 'tel', 'url', 'search'].includes(el.type)) {
                        return;
                    }
                    if (el.tagName === 'TEXTAREA') {
                        return;
                    }

                    const clickable = el.closest('button, a, input, [role="button"], label, select, h1, h2, h3, h4, h5, h6, .card, [class*="card"]') || el;
                    const selector = getOptimalSelector(clickable);

                    const now = Date.now();
                    if (selector === lastClickSelector && (now - lastClickTime) < 300) {
                        return;
                    }
                    lastClickSelector = selector;
                    lastClickTime = now;

                    try {
                        if (typeof window.__aaquaRecordAction === 'function') {
                            window.__aaquaRecordAction({
                                action: 'Click',
                                selector: selector,
                                tag: clickable.tagName
                            }).catch(() => {});
                        }
                    } catch {}
                }, true);

                // 3. Input, Blur & Change Interceptor
                let inputDebounceTimer = null;
                function recordInputEvent(targetEl) {
                    if (!targetEl || (targetEl.tagName !== 'INPUT' && targetEl.tagName !== 'TEXTAREA' && targetEl.tagName !== 'SELECT')) return;
                    if (targetEl.type === 'checkbox' || targetEl.type === 'radio') return;

                    const selector = getOptimalSelector(targetEl);
                    const val = targetEl.value !== undefined ? String(targetEl.value) : '';
                    try {
                        if (typeof window.__aaquaRecordAction === 'function') {
                            window.__aaquaRecordAction({
                                action: targetEl.tagName === 'SELECT' ? 'Select' : 'Type',
                                selector: selector,
                                value: val,
                                tag: targetEl.tagName
                            }).catch(() => {});
                        }
                    } catch {}
                }

                document.addEventListener('blur', (e) => {
                    recordInputEvent(e.target);
                }, true);

                document.addEventListener('change', (e) => {
                    recordInputEvent(e.target);
                }, true);

                document.addEventListener('input', (e) => {
                    clearTimeout(inputDebounceTimer);
                    inputDebounceTimer = setTimeout(() => {
                        recordInputEvent(e.target);
                    }, 500);
                }, true);

                // 4. Floating UI Banner in Browser Window
                function injectBanner() {
                    if (document.getElementById('aaqua-recorder-banner')) return;
                    const banner = document.createElement('div');
                    banner.id = 'aaqua-recorder-banner';
                    banner.style.cssText = `
                        position: fixed;
                        top: 12px;
                        right: 16px;
                        z-index: 2147483647;
                        background: rgba(15, 23, 42, 0.95);
                        backdrop-filter: blur(8px);
                        color: #ffffff;
                        padding: 8px 14px;
                        border-radius: 9999px;
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                        font-size: 12px;
                        font-weight: 600;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(239, 68, 68, 0.4);
                        user-select: none;
                    `;
                    banner.innerHTML = `
                        <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#ef4444; box-shadow:0 0 8px #ef4444; animation:aaquaPulse 1.5s infinite;"></span>
                        <span>AAQUA Live Recorder</span>
                        <button id="aaqua-btn-stop" style="
                            background: #ef4444;
                            color: white;
                            border: none;
                            padding: 3px 10px;
                            border-radius: 9999px;
                            cursor: pointer;
                            font-size: 11px;
                            font-weight: 700;
                            margin-left: 4px;
                        ">End & Save</button>
                    `;

                    const style = document.createElement('style');
                    style.textContent = `
                        @keyframes aaquaPulse {
                            0% { transform: scale(0.95); opacity: 0.8; }
                            50% { transform: scale(1.15); opacity: 1; }
                            100% { transform: scale(0.95); opacity: 0.8; }
                        }
                    `;
                    (document.head || document.documentElement).appendChild(style);
                    (document.body || document.documentElement).appendChild(banner);

                    const stopBtn = document.getElementById('aaqua-btn-stop');
                    if (stopBtn) {
                        stopBtn.addEventListener('click', (ev) => {
                            ev.stopPropagation();
                            ev.preventDefault();
                            window.__aaquaRecordAction({ action: 'Stop' });
                        });
                    }
                }

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectBanner);
                    window.addEventListener('load', injectBanner);
                } else {
                    injectBanner();
                }
            })();
        };

        await targetPage.addInitScript(injectionFunction).catch(() => {});
        await targetPage.evaluate(injectionFunction).catch(() => {});

        // Record Navigation
        targetPage.on('framenavigated', (frame) => {
            if (frame === targetPage.mainFrame()) {
                const currentUrl = frame.url();
                if (currentUrl && currentUrl !== 'about:blank' && !session.steps.some(s => s.action === 'Navigate' && s.target === currentUrl)) {
                    session.steps.push({
                        testCaseId: 'TC_REC',
                        stepNum: String(session.steps.length + 1),
                        action: 'Navigate',
                        target: currentUrl,
                        inputData: '',
                        expected: `Page navigated to ${currentUrl}`,
                        timestamp: new Date().toISOString()
                    });
                    session.logs.push(`[Navigate] Loaded "${currentUrl}"`);
                }
            }
        });
    }

    /**
     * Codegen Mode: Launches Playwright Codegen CLI inspector
     */
    async _startCodegenMode(session) {
        return new Promise((resolve, reject) => {
            const args = ['playwright', 'codegen', session.url, '-o', session.outputFile, '--target', 'javascript'];
            if (session.browserType && session.browserType !== 'chromium') {
                args.push('-b', session.browserType);
            }

            const proc = spawn('npx', args, {
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            session.process = proc;

            proc.stdout.on('data', (d) => {
                const msg = d.toString().trim();
                if (msg) session.logs.push(`[Codegen] ${msg}`);
            });

            proc.stderr.on('data', (d) => {
                const msg = d.toString().trim();
                if (msg && !msg.includes('notice')) session.logs.push(`[Codegen] ${msg}`);
            });

            proc.on('close', () => {
                session.status = 'completed';
                session.logs.push(`[Codegen] Process exited. Parsing generated script...`);
                this._parseCodegenFile(session);
            });

            resolve();
        });
    }

    /**
     * Parses Playwright Codegen output script into AAUQA structured steps
     */
    _parseCodegenFile(session) {
        if (!fs.existsSync(session.outputFile)) return;
        try {
            const content = fs.readFileSync(session.outputFile, 'utf-8');
            const lines = content.split('\n');
            const steps = [];

            lines.forEach((line) => {
                const trimmed = line.trim();
                if (!trimmed.startsWith('await page.')) return;

                // 1. goto
                const gotoMatch = trimmed.match(/await page\.goto\(['"]([^'"]+)['"]\)/);
                if (gotoMatch) {
                    steps.push({
                        testCaseId: 'TC_REC',
                        stepNum: String(steps.length + 1),
                        action: 'Navigate',
                        target: gotoMatch[1],
                        inputData: '',
                        expected: `Navigated to ${gotoMatch[1]}`
                    });
                    return;
                }

                // 2. click
                const clickMatch = trimmed.match(/await page\.(locator|getByRole|getByText|getByLabel|getByPlaceholder|getByTestId)\((.*?)\)\.click\(\)/);
                if (clickMatch) {
                    let sel = clickMatch[2].replace(/^['"]|['"]$/g, '');
                    if (clickMatch[1] === 'locator') {
                        sel = clickMatch[2].replace(/^['"]|['"]$/g, '');
                    } else {
                        sel = `${clickMatch[1]}(${clickMatch[2]})`;
                    }
                    steps.push({
                        testCaseId: 'TC_REC',
                        stepNum: String(steps.length + 1),
                        action: 'Click',
                        target: sel,
                        inputData: '',
                        expected: `Clicked ${sel}`
                    });
                    return;
                }

                // 3. fill / type
                const fillMatch = trimmed.match(/await page\.(locator|getByRole|getByText|getByLabel|getByPlaceholder|getByTestId)\((.*?)\)\.fill\(['"](.*?)['"]\)/);
                if (fillMatch) {
                    let sel = fillMatch[2].replace(/^['"]|['"]$/g, '');
                    steps.push({
                        testCaseId: 'TC_REC',
                        stepNum: String(steps.length + 1),
                        action: 'Type',
                        target: sel,
                        inputData: fillMatch[3],
                        expected: `Typed "${fillMatch[3]}" into ${sel}`
                    });
                }
            });

            if (steps.length > 0) {
                session.steps = steps;
            }
        } catch (e) {
            session.logs.push(`[Codegen Parse Error] ${e.message}`);
        }
    }

    /**
     * Stop recording session and generate Playwright & Selenium POM suites
     */
    async stopSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error('Session not found: ' + sessionId);

        if (session.browser) {
            try {
                await session.browser.close();
            } catch {}
            session.browser = null;
        }

        if (session.process) {
            try {
                session.process.kill();
            } catch {}
            session.process = null;
            this._parseCodegenFile(session);
        }

        session.status = 'completed';
        session.logs.push(`[Recorder] Recording stopped. Total steps captured: ${session.steps.length}`);

        // Generate full Production POM suites
        const goal = `Recorded test workflow for ${session.url}`;
        const playwrightFiles = generateProductionPlaywrightFiles(session.steps, goal);
        const seleniumFiles = generateProductionSeleniumFiles(session.steps, goal);
        const qaDeliverable = generateArchitectReport(goal, session.steps);

        return {
            sessionId,
            status: 'completed',
            stepsCount: session.steps.length,
            steps: session.steps,
            logs: session.logs,
            playwrightFiles,
            seleniumFiles,
            qaDeliverable
        };
    }

    /**
     * Get active session status and live steps
     */
    /**
     * Get active session status, live steps, and open tabs
     */
    getSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        return {
            sessionId: session.id,
            status: session.status,
            mode: session.mode,
            url: session.url,
            startTime: session.startTime,
            duration: Math.floor((Date.now() - session.startTime) / 1000) + 's',
            stepsCount: session.steps.length,
            steps: session.steps,
            logs: session.logs,
            tabs: this.getTabs(sessionId),
            activeTab: session.activePageIndex || 0,
            liveScreenshot: session.liveScreenshot
        };
    }

    /**
     * Return list of all open tabs/windows in the browser context
     */
    getTabs(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.pages) return [];

        session.pages = session.pages.filter(p => !p.isClosed());
        return session.pages.map((p, idx) => {
            let pageUrl = 'about:blank';
            try { pageUrl = p.url() || 'about:blank'; } catch {}
            return {
                index: idx,
                url: pageUrl,
                isActive: p === session.page
            };
        });
    }

    /**
     * Switch active view and interaction target to specified tab index
     */
    async switchTab(sessionId, tabIndex) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.pages) {
            throw new Error('No active recorder session found: ' + sessionId);
        }
        const idx = Number(tabIndex);
        if (idx < 0 || idx >= session.pages.length) {
            throw new Error(`Invalid tab index: ${idx}. Available tabs: 0 to ${session.pages.length - 1}`);
        }

        const targetPage = session.pages[idx];
        if (targetPage.isClosed()) {
            session.pages.splice(idx, 1);
            throw new Error('Target tab is already closed.');
        }

        session.page = targetPage;
        session.activePageIndex = idx;
        await session.page.bringToFront().catch(() => {});

        const currentUrl = session.page.url() || `Tab ${idx + 1}`;
        session.logs.push(`[Tabs] Switched to Tab ${idx + 1}: ${currentUrl}`);

        const stepNum = session.steps.length + 1;
        session.steps.push({
            testCaseId: 'TC_REC',
            stepNum: String(stepNum),
            action: 'SwitchToTab',
            target: currentUrl,
            inputData: String(idx),
            expected: `Switched to tab with index ${idx}`,
            timestamp: new Date().toISOString()
        });

        try {
            const buf = await session.page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
            if (buf) session.liveScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
        } catch {}

        return {
            success: true,
            activeTab: idx,
            tabs: this.getTabs(sessionId),
            liveScreenshot: session.liveScreenshot
        };
    }

    /**
     * Close a specific tab by index
     */
    async closeTab(sessionId, tabIndex) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.pages) {
            throw new Error('No active session: ' + sessionId);
        }
        const idx = Number(tabIndex);
        if (idx >= 0 && idx < session.pages.length) {
            const p = session.pages[idx];
            await p.close().catch(() => {});
            session.pages.splice(idx, 1);
            if (session.page === p) {
                session.page = session.pages[session.pages.length - 1] || null;
                session.activePageIndex = Math.max(0, session.pages.length - 1);
                if (session.page && !session.page.isClosed()) {
                    await session.page.bringToFront().catch(() => {});
                    const buf = await session.page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
                    if (buf) session.liveScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
                }
            }
        }
        return {
            success: true,
            activeTab: session.activePageIndex || 0,
            tabs: this.getTabs(sessionId),
            liveScreenshot: session.liveScreenshot
        };
    }

    /**
     * Dispatch click at viewport coordinate (x, y), inspect element, and auto-focus inputs
     */
    async clickCoordinate(sessionId, x, y) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.page || session.page.isClosed()) {
            throw new Error('No active browser page for session: ' + sessionId);
        }

        const clickX = Number(x);
        const clickY = Number(y);

        await session.page.mouse.click(clickX, clickY);
        await new Promise(r => setTimeout(r, 200));

        // Detect if clicked element is an input / textarea / select or interactive element
        let elementInfo = null;
        try {
            elementInfo = await session.page.evaluate(({ x, y }) => {
                let el = document.elementFromPoint(x, y);
                if (!el) el = document.activeElement;
                if (!el) return null;

                // Resolve input / interactive element hierarchy
                let inputEl = null;
                const active = document.activeElement;
                if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) {
                    inputEl = active;
                } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) {
                    inputEl = el;
                } else if (el.closest('label')) {
                    const label = el.closest('label');
                    if (label.control) inputEl = label.control;
                    else inputEl = label.querySelector('input, textarea, select');
                } else if (el.querySelector('input, textarea, select')) {
                    inputEl = el.querySelector('input, textarea, select');
                } else if (el.closest('input, textarea, select, [contenteditable="true"]')) {
                    inputEl = el.closest('input, textarea, select, [contenteditable="true"]');
                }

                const targetEl = inputEl || el;
                const tag = targetEl.tagName ? targetEl.tagName.toLowerCase() : '';
                const isInput = tag === 'input' || tag === 'textarea' || tag === 'select' || targetEl.isContentEditable;

                if (isInput && typeof targetEl.focus === 'function') {
                    targetEl.focus();
                }

                // If clicking a custom radio or checkbox label (like DemoQA gender/hobbies), click it
                if (targetEl.tagName === 'LABEL' || targetEl.closest('.custom-control')) {
                    const inputChild = targetEl.querySelector('input') || targetEl.closest('.custom-control')?.querySelector('input');
                    if (inputChild && (inputChild.type === 'radio' || inputChild.type === 'checkbox')) {
                        inputChild.checked = !inputChild.checked || inputChild.type === 'radio';
                        inputChild.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }

                let sel = '';
                if (targetEl.id) sel = '#' + targetEl.id;
                else if (targetEl.name) sel = `${tag}[name="${targetEl.name}"]`;
                else if (targetEl.placeholder) sel = `${tag}[placeholder="${targetEl.placeholder}"]`;
                else if (targetEl.getAttribute && targetEl.getAttribute('data-testid')) sel = `[data-testid="${targetEl.getAttribute('data-testid')}"]`;
                else if (targetEl.className && typeof targetEl.className === 'string') {
                    const firstClass = targetEl.className.trim().split(/\s+/)[0];
                    if (firstClass && !firstClass.includes(':')) sel = `${tag}.${firstClass}`;
                    else sel = tag;
                } else {
                    sel = tag;
                }

                const bRect = targetEl.getBoundingClientRect();

                return {
                    tagName: tag,
                    isInput,
                    type: targetEl.type || '',
                    id: targetEl.id || '',
                    name: targetEl.name || '',
                    placeholder: targetEl.placeholder || '',
                    value: targetEl.value !== undefined ? String(targetEl.value) : (targetEl.innerText || ''),
                    text: (targetEl.innerText || targetEl.textContent || '').trim().slice(0, 40),
                    selector: sel,
                    bounds: {
                        x: Math.round(bRect.left),
                        y: Math.round(bRect.top),
                        width: Math.round(bRect.width),
                        height: Math.round(bRect.height)
                    }
                };
            }, { x: clickX, y: clickY });
        } catch {}

        // Capture updated screenshot immediately
        try {
            const buf = await session.page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
            if (buf) session.liveScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
        } catch {}

        return {
            success: true,
            elementInfo,
            tabs: this.getTabs(sessionId),
            activeTab: session.activePageIndex || 0,
            steps: session.steps,
            liveScreenshot: session.liveScreenshot
        };
    }

    /**
     * Type text into currently focused element via keyboard with automatic DOM event dispatch
     */
    async typeText(sessionId, text) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.page || session.page.isClosed()) {
            throw new Error('No active browser page for session: ' + sessionId);
        }

        const strText = String(text);
        await session.page.keyboard.type(strText);
        await new Promise(r => setTimeout(r, 100));

        // Dispatch input/change so frameworks like React/Angular trigger state updates
        const targetData = await session.page.evaluate(() => {
            const el = document.activeElement;
            if (!el) return null;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));

            return {
                tag: el.tagName.toLowerCase(),
                id: el.id || '',
                name: el.name || '',
                placeholder: el.placeholder || '',
                value: el.value !== undefined ? String(el.value) : ''
            };
        }).catch(() => null);

        // Ensure step is recorded if not debounced yet
        if (targetData && targetData.value) {
            const target = targetData.id ? '#' + targetData.id 
                : targetData.name ? `${targetData.tag}[name="${targetData.name}"]` 
                : targetData.placeholder ? `${targetData.tag}[placeholder="${targetData.placeholder}"]` 
                : targetData.tag;

            const lastStep = session.steps[session.steps.length - 1];
            if (lastStep && lastStep.action === 'Type' && lastStep.target === target) {
                lastStep.inputData = targetData.value;
            } else {
                const stepNum = session.steps.length + 1;
                session.steps.push({
                    testCaseId: 'TC_REC',
                    stepNum: String(stepNum),
                    action: 'Type',
                    target: target,
                    inputData: targetData.value,
                    expected: `Typed "${targetData.value}" into ${target}`,
                    timestamp: new Date().toISOString()
                });
                session.logs.push(`[Step ${stepNum}] Type -> ${target} ("${targetData.value}")`);
            }
        }

        try {
            const buf = await session.page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
            if (buf) session.liveScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
        } catch {}

        return {
            success: true,
            steps: session.steps,
            liveScreenshot: session.liveScreenshot
        };
    }

    /**
     * Direct field filling by selector or active element (fills value, triggers events, records step)
     */
    async fillField(sessionId, selector, value) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.page || session.page.isClosed()) {
            throw new Error('No active browser page for session: ' + sessionId);
        }

        const strVal = String(value);

        // Try filling via Playwright locator first, then fallback to native prototype setter
        let fillSuccess = false;
        if (selector) {
            try {
                await session.page.locator(selector).first().fill(strVal, { timeout: 1500 });
                fillSuccess = true;
            } catch {}
        }

        if (!fillSuccess) {
            await session.page.evaluate(({ sel, val }) => {
                let el = sel ? document.querySelector(sel) : null;
                if (!el) el = document.activeElement;
                if (el) {
                    el.focus();
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
                        'value'
                    )?.set;
                    if (nativeSetter) {
                        nativeSetter.call(el, val);
                    } else {
                        el.value = val;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                }
            }, { sel: selector, val: strVal }).catch(() => {});
        }

        await new Promise(r => setTimeout(r, 100));

        // Get filled target descriptor
        const filledInfo = await session.page.evaluate(() => {
            const el = document.activeElement;
            if (!el) return null;
            return {
                tag: el.tagName.toLowerCase(),
                id: el.id || '',
                name: el.name || '',
                placeholder: el.placeholder || '',
                value: el.value !== undefined ? String(el.value) : ''
            };
        }).catch(() => null);

        const target = selector || (filledInfo?.id ? '#' + filledInfo.id : filledInfo?.placeholder || 'input');
        const finalVal = filledInfo?.value || strVal;

        const lastStep = session.steps[session.steps.length - 1];
        if (lastStep && lastStep.action === 'Type' && lastStep.target === target) {
            lastStep.inputData = finalVal;
        } else {
            const stepNum = session.steps.length + 1;
            session.steps.push({
                testCaseId: 'TC_REC',
                stepNum: String(stepNum),
                action: 'Type',
                target: target,
                inputData: finalVal,
                expected: `Filled "${finalVal}" into ${target}`,
                timestamp: new Date().toISOString()
            });
            session.logs.push(`[Step ${stepNum}] Type -> ${target} ("${finalVal}")`);
        }

        try {
            const buf = await session.page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
            if (buf) session.liveScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
        } catch {}

        return {
            success: true,
            steps: session.steps,
            liveScreenshot: session.liveScreenshot
        };
    }

    /**
     * Auto-Fill Entire Form: Automatically detect and fill visible form fields with clean QA test data
     */
    async autoFillForm(sessionId, customValues = {}) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.page || session.page.isClosed()) {
            throw new Error('No active browser page for session: ' + sessionId);
        }

        const page = session.page;

        // Execute smart form filling in browser context
        const filledFields = await page.evaluate(async (custom) => {
            const results = [];
            
            const setNativeValue = (el, val) => {
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
                    'value'
                )?.set;
                if (nativeSetter) {
                    nativeSetter.call(el, val);
                } else {
                    el.value = val;
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            };

            // 1. Text Inputs & Textareas
            const inputs = Array.from(document.querySelectorAll('input, textarea')).filter(el => {
                const t = (el.type || 'text').toLowerCase();
                return !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(t);
            });
            for (const input of inputs) {
                const name = (input.name || '').toLowerCase();
                const id = (input.id || '').toLowerCase();
                const placeholder = (input.placeholder || '').toLowerCase();
                const type = (input.type || '').toLowerCase();

                let val = '';
                if (custom && (custom[input.id] || custom[input.name])) {
                    val = custom[input.id] || custom[input.name];
                } else if (name.includes('first') || id.includes('first') || placeholder.includes('first')) {
                    val = 'John';
                } else if (name.includes('last') || id.includes('last') || placeholder.includes('last')) {
                    val = 'Doe';
                } else if (type === 'email' || name.includes('email') || id.includes('email') || placeholder.includes('email') || placeholder.includes('@')) {
                    val = 'john.doe@example.com';
                } else if (type === 'tel' || name.includes('phone') || name.includes('mobile') || id.includes('phone') || id.includes('mobile') || id.includes('usernumber') || placeholder.includes('mobile') || placeholder.includes('phone')) {
                    val = '9876543210';
                } else if (name.includes('address') || id.includes('address') || placeholder.includes('address')) {
                    val = '123 Automation Blvd, Suite 400';
                } else if (name.includes('city') || id.includes('city')) {
                    val = 'New York';
                } else if (name.includes('state') || id.includes('state')) {
                    val = 'NCR';
                } else if (name.includes('subject') || id.includes('subject')) {
                    val = 'Computer Science';
                } else if (type === 'password' || name.includes('pass') || id.includes('pass')) {
                    val = 'Testing@123';
                } else if (type === 'number') {
                    val = '25';
                } else if (!input.value) {
                    val = 'Sample Input';
                }

                if (val) {
                    input.focus();
                    setNativeValue(input, val);
                    const sel = input.id ? '#' + input.id : (input.name ? `input[name="${input.name}"]` : (input.placeholder ? `input[placeholder="${input.placeholder}"]` : input.tagName.toLowerCase()));
                    results.push({ action: 'Type', target: sel, value: val, name: input.placeholder || input.name || input.id || 'Field' });
                }
            }

            // 2. Radio Buttons (e.g. Gender on DemoQA)
            const radio = document.querySelector('input[type="radio"]:not(:checked)') || document.querySelector('input#gender-radio-1');
            if (radio) {
                const label = document.querySelector(`label[for="${radio.id}"]`) || radio.closest('label');
                if (label) {
                    label.click();
                    results.push({ action: 'Click', target: `label[for="${radio.id}"]`, value: '', name: label.innerText || radio.id });
                } else {
                    radio.click();
                    radio.checked = true;
                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                    results.push({ action: 'Click', target: `#${radio.id}`, value: '', name: radio.id });
                }
            }

            // 3. Checkboxes (e.g. Hobbies on DemoQA)
            const checkbox = document.querySelector('input[type="checkbox"]:not(:checked)') || document.querySelector('input#hobbies-checkbox-1');
            if (checkbox) {
                const label = document.querySelector(`label[for="${checkbox.id}"]`) || checkbox.closest('label');
                if (label) {
                    label.click();
                    results.push({ action: 'Click', target: `label[for="${checkbox.id}"]`, value: '', name: label.innerText || checkbox.id });
                } else {
                    checkbox.click();
                    checkbox.checked = true;
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                    results.push({ action: 'Click', target: `#${checkbox.id}`, value: '', name: checkbox.id });
                }
            }

            return results;
        }, customValues).catch((err) => {
            console.error('[autoFillForm evaluate error]', err);
            return [];
        });

        // Record steps for all filled fields
        if (filledFields && filledFields.length > 0) {
            for (const item of filledFields) {
                const stepNum = session.steps.length + 1;
                session.steps.push({
                    testCaseId: 'TC_REC',
                    stepNum: String(stepNum),
                    action: item.action,
                    target: item.target,
                    inputData: item.value || '',
                    expected: item.action === 'Type' ? `Filled "${item.value}" into ${item.target}` : `Clicked ${item.target}`,
                    timestamp: new Date().toISOString()
                });
                session.logs.push(`[Step ${stepNum}] ${item.action} -> ${item.target} ${item.value ? `("${item.value}")` : ''}`);
            }
        }

        await new Promise(r => setTimeout(r, 150));

        // Capture updated screenshot
        try {
            const buf = await session.page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
            if (buf) session.liveScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
        } catch {}

        return {
            success: true,
            filledCount: filledFields.length,
            filledFields,
            steps: session.steps,
            liveScreenshot: session.liveScreenshot
        };
    }

    /**
     * Press a keyboard key (e.g. 'Enter', 'Tab', 'Escape', 'Backspace')
     */
    async pressKey(sessionId, key) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.page || session.page.isClosed()) {
            throw new Error('No active browser page for session: ' + sessionId);
        }

        await session.page.keyboard.press(String(key));
        await new Promise(r => setTimeout(r, 200));

        try {
            const buf = await session.page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
            if (buf) session.liveScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
        } catch {}

        return {
            success: true,
            steps: session.steps,
            liveScreenshot: session.liveScreenshot
        };
    }
}

export const recorderService = new RecorderService();
