import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LocalLLM as GoogleGenerativeAI } from '../utils/llmClient.js';
import path from 'path';
import fs from 'fs';

/**
 * Resolves natural language relative dates into standard formatted dates (YYYY-MM-DD)
 */
export function resolveRelativeDate(text) {
    if (!text || typeof text !== 'string') return text;
    const lower = text.trim().toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}$/.test(lower) || /^\d{2}[-\/]\d{2}[-\/]\d{4}$/.test(lower)) {
        return text;
    }
    const now = new Date();
    let targetDate = null;
    if (lower.includes('next day') || lower.includes('tomorrow')) {
        targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    } else if (lower.includes('current day') || lower.includes('today') || lower.includes('same day')) {
        targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    } else if (lower.includes('yesterday')) {
        targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    } else {
        return text;
    }
    const yyyy = targetDate.getFullYear();
    const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
    const dd = String(targetDate.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * PlaywrightMcpClientManager
 * Connects to and drives @executeautomation/playwright-mcp-server via official Model Context Protocol SDK
 */
export class PlaywrightMcpClientManager {
    constructor({ runId, headed = false, onScreenshot, log = console.log }) {
        this.runId = runId;
        this.headed = headed;
        this.onScreenshot = onScreenshot;
        this.log = log;
        this.client = null;
        this.transport = null;
        this.tools = [];
        this.screenshotDir = path.resolve('temp_screenshots');
        if (!fs.existsSync(this.screenshotDir)) {
            fs.mkdirSync(this.screenshotDir, { recursive: true });
        }
        this.latestScreenshotBase64 = null;
        this.browserStarted = false;
        this.activeCallPromise = null;
    }

    /**
     * Start and connect the MCP Server process via stdio
     */
    async init() {
        this.log(`🔌 [Playwright MCP Client] Starting @executeautomation/playwright-mcp-server via stdio...`);
        const serverScript = path.resolve('node_modules/@executeautomation/playwright-mcp-server/dist/index.js');

        this.transport = new StdioClientTransport({
            command: 'node',
            args: [serverScript],
            env: {
                ...process.env,
                NODE_ENV: 'production'
            }
        });

        this.client = new Client(
            { name: 'aaqua-agent-runner', version: '2.0.0' },
            { capabilities: { tools: {} } }
        );

        await this.client.connect(this.transport);
        const toolsResult = await this.client.listTools();
        this.tools = toolsResult.tools || [];
        this.log(`✅ [Playwright MCP Client] Connected to MCP server. ${this.tools.length} standardized tools available.`);
        return this.tools;
    }

    /**
     * Call any raw tool on the MCP server with sequential queueing to protect stdio
     */
    async callTool(name, args = {}) {
        if (!this.client) {
            throw new Error('Playwright MCP client is not initialized.');
        }

        // Wait for any prior call to complete so calls never interleave or clash on stdio
        while (this.activeCallPromise) {
            try {
                await this.activeCallPromise;
            } catch {}
        }

        let resolveCall;
        this.activeCallPromise = new Promise(res => { resolveCall = res; });

        try {
            const result = await this.client.callTool({
                name,
                arguments: args
            });

            if (result.isError) {
                const errMsg = result.content?.map(c => c.text).join('\n') || `MCP Tool ${name} failed`;
                throw new Error(errMsg);
            }

            return result;
        } finally {
            this.activeCallPromise = null;
            if (resolveCall) resolveCall();
        }
    }

    /**
     * Helper to capture a screenshot via MCP and stream to UI
     */
    async captureScreen() {
        if (!this.browserStarted) return this.latestScreenshotBase64;
        // If an interactive tool is executing, return latest frame without clashing on stdio
        if (this.activeCallPromise) {
            return this.latestScreenshotBase64;
        }
        try {
            const timestamp = Date.now();
            const filename = `shot_${this.runId || 'run'}_${timestamp}`;
            const result = await this.callTool('playwright_screenshot', {
                downloadsDir: this.screenshotDir,
                name: filename
            });

            const textContent = result.content?.find(c => c.text && c.text.includes('Screenshot saved to:'))?.text;
            if (textContent) {
                const match = textContent.match(/Screenshot saved to:\s*(.*)/i);
                if (match && match[1]) {
                    const filePath = path.resolve(match[1].trim());
                    if (fs.existsSync(filePath)) {
                        const buf = fs.readFileSync(filePath);
                        const base64Jpg = buf.toString('base64');
                        this.latestScreenshotBase64 = base64Jpg;
                        if (this.onScreenshot) {
                            this.onScreenshot(base64Jpg);
                        }
                        fs.unlink(filePath, () => { });
                        return base64Jpg;
                    }
                }
            }
        } catch (err) {
            // Non-critical during fast navigations
        }
        return this.latestScreenshotBase64;
    }

    /**
     * Dismiss full screen loaders or waiting masks
     */
    async dismissLoaders() {
        try {
            await this.evaluate(`
                (() => {
                    const l = document.querySelector('.full-screen-loader-wrapper, .loading-spinner, .pega-loading-indicator');
                    if (l && l.style.display !== 'none') {
                        l.style.display = 'none';
                    }
                    // Remove fixed advertising banners or overlays that intercept clicks (e.g. demoqa #fixedban, sticky footer)
                    const ban = document.getElementById('fixedban');
                    if (ban) ban.remove();
                    const ads = document.querySelectorAll('#fixedban, [id*="google_ads"], [id*="adplus"], footer');
                    ads.forEach(a => {
                        if (a.tagName.toLowerCase() === 'footer') {
                            a.style.display = 'none';
                        } else {
                            a.remove();
                        }
                    });
                })()
            `);
        } catch { }
    }

    /**
     * Standardized Navigation via MCP
     */
    async navigate(url) {
        this.log(`🌐 [Playwright MCP] Calling playwright_navigate: "${url}"`);
        this.browserStarted = true;
        const res = await this.callTool('playwright_navigate', {
            url,
            headless: !this.headed
        });

        // Fast dynamic polling every 200ms (up to 15s)
        for (let i = 0; i < 75; i++) {
            try {
                const isReady = await this.evaluate(`(() => {
                    const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
                    const buttons = document.querySelectorAll('button:not([disabled]), input[type="submit"], a.btn, [role="button"]');
                    const text = (document.body ? document.body.innerText : '') || '';
                    const cleanText = text.replace(/javascript is required/i, '').trim();
                    const reactMount = document.getElementById('reactContainer');
                    const hasReactMounted = !!(reactMount && reactMount.children.length > 0);

                    return inputs.length > 0 || (buttons.length > 0 && cleanText.length > 20) || cleanText.length > 50 || (hasReactMounted && cleanText.length > 30);
                })()`);
                if (isReady) {
                    this.log(`  🌐 [Playwright MCP] SPA hydrated and ready after ${(i * 0.2).toFixed(1)}s.`);
                    break;
                }
            } catch {}
            await new Promise(r => setTimeout(r, 200));
        }

        // Allow layout/styles to settle before snapping the rendered initial frame
        await new Promise(r => setTimeout(r, 200));
        await this.dismissLoaders();
        await this.captureScreen();
        return res;
    }

    /**
     * Generic Progressive Element Locator
     * Polls every 500ms up to 20,000ms (40 attempts).
     * Emits milestone logs at 5s, 10s, 15s, and 20s.
     * Proceeds immediately (0ms additional delay) the instant the target element renders and becomes interactive.
     * Implements leaf-node prioritization to target specific clickable/editable elements rather than wrapper containers.
     */
    async waitForCandidate(candidates, options = {}) {
        const timeoutMs = options.timeoutMs || 20000;
        const intervalMs = options.intervalMs || 200;
        const maxAttempts = Math.floor(timeoutMs / intervalMs);
        const descriptor = options.descriptor || (Array.isArray(candidates) ? candidates[0] : candidates) || 'element';
        const checkType = options.checkType || 'visible'; // 'clickable', 'editable', 'select', 'visible'

        const candList = Array.isArray(candidates)
            ? candidates
            : (candidates ? candidates.split(',').map(s => s.trim()).filter(Boolean) : []);

        if (candList.length === 0) return null;

        let logged5 = false;
        let logged10 = false;
        let logged15 = false;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const elapsedMs = (attempt + 1) * intervalMs;
            const elapsedSec = (elapsedMs / 1000).toFixed(1);

            // Progressive milestone logs requested by user
            if (elapsedMs >= 5000 && !logged5) {
                logged5 = true;
                this.log(`  ⏳ [Wait 5s] Waiting for element "${descriptor}" to render...`);
            } else if (elapsedMs >= 10000 && !logged10) {
                logged10 = true;
                this.log(`  ⏳ [Wait 10s] Still waiting for element "${descriptor}" to appear...`);
            } else if (elapsedMs >= 15000 && !logged15) {
                logged15 = true;
                this.log(`  ⏳ [Wait 15s] Element "${descriptor}" still loading...`);
            } else if (attempt === maxAttempts - 1) {
                this.log(`  ⏳ [Wait 20s] Dynamic timeout (20s) reached for "${descriptor}".`);
            }

            try {
                const matched = await this.evaluate(`
                    (() => {
                        const cands = ${JSON.stringify(candList)};
                        const type = ${JSON.stringify(checkType)};

                        function isVisible(el) {
                            if (!el) return false;
                            const style = window.getComputedStyle(el);
                            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                            const rect = el.getBoundingClientRect();
                            if (rect.width <= 0 || rect.height <= 0) return false;
                            return el.offsetParent !== null || el.tagName.toLowerCase() === 'body' || el.tagName.toLowerCase() === 'html';
                        }

                        // Check if an active modal / dialog / popup is open
                        const activeModal = Array.from(document.querySelectorAll('[role="dialog"], .modal, .modal-dialog, .popup-dialog, .popup'))
                            .find(m => isVisible(m));

                        for (const c of cands) {
                            try {
                                let el = null;
                                if (c.includes(':has-text(')) {
                                    const m = c.match(/:has-text\\((["']?)(.*?)\\1\\)/);
                                    if (m && m[2]) {
                                        const targetText = m[2].toLowerCase().trim();
                                        const baseSel = c.replace(/:has-text\\(.*?\\)/, '').trim() || '*';
                                        const scope = activeModal || document;
                                        const matches = Array.from(scope.querySelectorAll(baseSel))
                                            .filter(item => isVisible(item) && (item.textContent || item.value || '').toLowerCase().includes(targetText));
                                        
                                        if (matches.length > 0) {
                                            // Leaf-node priority: sort by smallest subtree so we click the leaf element, not a huge wrapper
                                            el = matches.sort((a, b) => (a.querySelectorAll('*').length - b.querySelectorAll('*').length))[0];
                                        }
                                    }
                                } else if (c.startsWith('text=')) {
                                    const targetText = c.slice(5).replace(/^["']|["']$/g, '').toLowerCase().trim();
                                    const scope = activeModal || document;
                                    const matches = Array.from(scope.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], input, h1, h2, h3, h4, h5, h6, .card, [class*="card"], span, div, p, li, label'))
                                        .filter(item => isVisible(item) && (item.textContent || item.value || '').toLowerCase().includes(targetText));
                                    
                                    if (matches.length > 0) {
                                        el = matches.sort((a, b) => (a.querySelectorAll('*').length - b.querySelectorAll('*').length))[0];
                                    }
                                } else {
                                    // Standard CSS selector
                                    const scope = activeModal || document;
                                    const matches = Array.from(scope.querySelectorAll(c)).filter(item => isVisible(item));
                                    if (matches.length > 0) {
                                        el = matches[0];
                                    } else if (activeModal) {
                                        const docMatches = Array.from(document.querySelectorAll(c)).filter(item => isVisible(item));
                                        if (docMatches.length > 0) el = docMatches[0];
                                    }
                                }

                                if (el) {
                                    if (type === 'editable') {
                                        if (el.readOnly || el.disabled) continue;
                                    }
                                    if (type === 'clickable') {
                                        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
                                    }
                                    return c;
                                }
                            } catch {}
                        }
                        return null;
                    })()
                `);

                if (matched) {
                    if (attempt > 0) {
                        this.log(`  🎯 [Playwright MCP] Element "${descriptor}" resolved after ${elapsedSec}s: "${matched}"`);
                    }
                    return matched;
                }
            } catch {}

            if (attempt < maxAttempts - 1) {
                await new Promise(r => setTimeout(r, intervalMs));
            }
        }
        return null;
    }

    async click(selector) {
        this.log(`  🖱️ [Playwright MCP] Calling playwright_click: "${selector}"`);
        await this.dismissLoaders();

        // Split candidate selectors
        const candidates = selector.includes(',')
            ? selector.split(',').map(s => s.trim()).filter(Boolean)
            : [selector.trim()];

        // Dynamic progressive wait (up to 20s, logging milestones at 5s, 10s, 15s, 20s)
        const bestCandidate = await this.waitForCandidate(candidates, {
            descriptor: selector,
            checkType: 'clickable',
            timeoutMs: 20000,
            intervalMs: 200
        });

        // Auto scroll into view if candidate exists in DOM
        if (bestCandidate && !bestCandidate.startsWith('text=') && !bestCandidate.includes(':has-text(')) {
            try {
                await this.evaluate(`
                    (() => {
                        const el = document.querySelector(${JSON.stringify(bestCandidate)});
                        if (el && (el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0)) {
                            el.scrollIntoView({ block: 'center', inline: 'center' });
                        }
                    })()
                `);
            } catch {}
        }

        let lastErr = null;
        if (bestCandidate) {
            try {
                const res = await this.callTool('playwright_click', { selector: bestCandidate });
                await this.captureScreen();
                return res;
            } catch (err) {
                lastErr = err;
            }
        }

        // Generic DOM evaluation click fallback (prioritizes leaf elements and handles custom labels/inputs)
        this.log(`  ⚠️ [Playwright MCP] Physical click on candidates failed (${lastErr?.message?.slice(0, 80) || 'no direct candidate'}). Retrying via DOM evaluation.`);
        try {
            const evaluated = await this.evaluate(`
                (() => {
                    const raw = ${JSON.stringify(selector)};
                    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
                    let targetEl = null;

                    // Remove overlays that could intercept or obscure elements
                    const ban = document.getElementById('fixedban');
                    if (ban) ban.remove();
                    const foot = document.querySelector('footer');
                    if (foot) foot.style.display = 'none';

                    // Check if an active modal / dialog / popup is open
                    const activeModal = Array.from(document.querySelectorAll('[role="dialog"], .modal.show, .modal, .modal-dialog, .popup-dialog, .popup'))
                        .find(m => {
                            const style = window.getComputedStyle(m);
                            return style.display !== 'none' && style.visibility !== 'hidden' && (m.offsetHeight > 0 || m.offsetWidth > 0);
                        });

                    // 1. Direct modal close detection
                    const lowerRaw = raw.toLowerCase();
                    if (activeModal && (lowerRaw.includes('close') || lowerRaw.includes('thanks') || lowerRaw.includes('popup') || lowerRaw.includes('modal') || lowerRaw.includes('done') || lowerRaw.includes('ok'))) {
                        targetEl = document.getElementById('closeLargeModal') ||
                                   activeModal.querySelector('#closeLargeModal') ||
                                   activeModal.querySelector('.modal-footer button') ||
                                   Array.from(activeModal.querySelectorAll('button, [role="button"], a')).find(b => (b.textContent || '').trim().toLowerCase().includes('close'));
                    }

                    // 2. Exact selector matching
                    if (!targetEl) {
                        for (const part of parts) {
                            try {
                                if (!part.startsWith('text=') && !part.includes(':has-text(')) {
                                    const scope = activeModal || document;
                                    const el = scope.querySelector(part) || document.querySelector(part);
                                    if (el) { targetEl = el; break; }
                                }
                            } catch {}
                        }
                    }

                    // 3. Keyword matching across interactive elements only (buttons, links, labels - excluding generic containers)
                    if (!targetEl) {
                        const candidateWords = raw.replace(/[^a-zA-Z0-9\s]/g, ' ')
                            .toLowerCase()
                            .split(/\s+/)
                            .filter(w => w.length > 2 && !['button', 'type', 'text', 'has'].includes(w));
                        const scope = activeModal || document;
                        const all = Array.from(scope.querySelectorAll(
                            'button, input[type="submit"], input[type="button"], [role="button"], [role="menuitem"], [role="tab"], [role="option"], a, label, h1, h2, h3, h4, h5, h6, .card, [class*="card"]'
                        ));
                        targetEl = all.find(el => {
                            const t = (el.textContent || '').trim().toLowerCase();
                            const val = (el.value || '').trim().toLowerCase();
                            return candidateWords.some(w => t === w || val === w || t.includes(w));
                        });
                    }

                    if (targetEl) {
                        if (targetEl.tagName.toLowerCase() === 'label' && targetEl.htmlFor) {
                            const inp = document.getElementById(targetEl.htmlFor);
                            if (inp && (inp.type === 'radio' || inp.type === 'checkbox')) {
                                inp.checked = true;
                                inp.dispatchEvent(new Event('input', { bubbles: true }));
                                inp.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        } else if (targetEl.type === 'radio' || targetEl.type === 'checkbox') {
                            targetEl.checked = true;
                            targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                            targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                        }

                        targetEl.scrollIntoView({ block: 'center', inline: 'center' });
                        targetEl.click();
                        try {
                            targetEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                            const parentClickable = targetEl.closest('button, a, [role="button"], [role="menuitem"], [class*="toggle"], [class*="Header"], [class*="header"], .card, [class*="card"], [class*="top-card"], [onclick]');
                            if (parentClickable && parentClickable !== targetEl) {
                                parentClickable.click();
                                parentClickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                            }
                        } catch {}
                        return true;
                    }
                    return false;
                })()
            `);
            if (evaluated) {
                this.log(`  ✅ [Playwright MCP] Clicked element via DOM evaluation.`);
                await this.captureScreen();
                return { content: [{ type: 'text', text: `Clicked via DOM evaluation: ${selector}` }] };
            }
        } catch (evalErr) {
            // Ignore eval error
        }
        throw lastErr || new Error(`Click failed for: ${selector}`);
    }

    /**
     * Specialized, immediate handler for Date fields, Flatpickr, and OutSystems OSUI Datepicker widgets
     */
    async fillDateField(selector, value) {
        this.log(`  📅 [Playwright MCP] Resolving date field: "${selector}" -> "${value}"`);
        await this.dismissLoaders();

        let dateObj = new Date();
        const valLower = String(value).toLowerCase().trim();
        const selLower = String(selector).toLowerCase().trim();
        const isEndField = selLower.includes('end') || selLower.includes('to');

        if (valLower.includes('next day') || valLower.includes('tomorrow')) {
            dateObj.setDate(dateObj.getDate() + 1);
        } else if (valLower.includes('same day') || valLower.includes('today') || valLower.includes('current day')) {
            if (isEndField && (valLower.includes('same day') || valLower.includes('holiday'))) {
                // In leave management, "same day of holiday" for End Date means the single-day leave on that holiday (same as Start Date, i.e. tomorrow)
                dateObj.setDate(dateObj.getDate() + 1);
            }
        } else if (valLower.includes('+') || valLower.includes('after')) {
            const num = parseInt(valLower.replace(/[^0-9]/g, '')) || 1;
            dateObj.setDate(dateObj.getDate() + num);
        } else {
            const parsed = new Date(value);
            if (!isNaN(parsed.getTime())) {
                dateObj = parsed;
            }
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (dateObj < today) {
            // Auto roll forward to tomorrow if hallucinated in the past (e.g. 2025)
            dateObj = new Date(today);
            dateObj.setDate(today.getDate() + 1);
        }

        const isoDate = dateObj.toISOString().split('T')[0];
        const dayStr = String(dateObj.getDate()).padStart(2, '0');
        const monthStr = String(dateObj.getMonth() + 1).padStart(2, '0');
        const yearStr = dateObj.getFullYear();
        const dmyDate = `${dayStr}-${monthStr}-${yearStr}`;

        try {
            const result = await this.evaluate(`
                (() => {
                    const sel = ${JSON.stringify(selector)};
                    const lower = sel.toLowerCase();
                    const isStart = lower.includes('start') || lower.includes('from');
                    const isEnd = lower.includes('end') || lower.includes('to');
                    const timestamp = ${dateObj.getTime()};
                    let dObj = new Date(timestamp);
                    let dmy = ${JSON.stringify(dmyDate)};
                    let iso = ${JSON.stringify(isoDate)};

                    // Find active visible scope (only visible dialogs take precedence; otherwise main container)
                    const activeDialog = Array.from(document.querySelectorAll('.popup-dialog, .modal-dialog, [role="dialog"], .popup'))
                        .find(d => d.offsetParent !== null && window.getComputedStyle(d).display !== 'none' && window.getComputedStyle(d).visibility !== 'hidden');
                    const scope = activeDialog || document.querySelector('form, .content, main') || document.body;

                    if (isEnd) {
                        const sInp = scope.querySelector('input[placeholder*="Start" i].flatpickr-input, input[placeholder*="Start" i], [id*="StartDate" i], [name*="StartDate" i]');
                        let sDate = null;
                        if (sInp && sInp._flatpickr && sInp._flatpickr.selectedDates && sInp._flatpickr.selectedDates.length > 0) {
                            sDate = sInp._flatpickr.selectedDates[0];
                        } else if (sInp && sInp.value) {
                            const p = new Date(sInp.value);
                            if (!isNaN(p.getTime())) sDate = p;
                        }
                        const rawLower = ${JSON.stringify(valLower)};
                        if (sDate) {
                            if (rawLower.includes('same day') || rawLower.includes('holiday') || dObj < sDate) {
                                dObj = new Date(sDate);
                                const sy = dObj.getFullYear();
                                const sm = String(dObj.getMonth() + 1).padStart(2, '0');
                                const sd = String(dObj.getDate()).padStart(2, '0');
                                iso = sy + '-' + sm + '-' + sd;
                                dmy = sd + '-' + sm + '-' + sy;
                            }
                        }
                    }

                    let el = null;
                    if (isStart) {
                        el = scope.querySelector('input[placeholder*="Start" i].flatpickr-input, input[placeholder*="Start" i], [id*="StartDate" i], [name*="StartDate" i]');
                    } else if (isEnd) {
                        el = scope.querySelector('input[placeholder*="End" i].flatpickr-input, input[placeholder*="End" i], [id*="EndDate" i], [name*="EndDate" i]');
                    }

                    // Direct candidates search inside active scope
                    if (!el) {
                        const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
                        for (const part of parts) {
                            try {
                                if (!part.startsWith('text=') && !part.includes(':has-text(')) {
                                    const found = scope.querySelector(part);
                                    if (found) { el = found; break; }
                                }
                            } catch {}
                        }
                    }

                    // Fallback to searching inputs in datepicker blocks inside active scope
                    if (!el) {
                        const datePickers = Array.from(scope.querySelectorAll('.osui-datepicker, .input-date'));
                        const targetBlock = isEnd ? (datePickers[1] || datePickers[0]) : datePickers[0];
                        if (targetBlock) {
                            el = targetBlock.querySelector('input.flatpickr-input, input');
                        }
                    }

                    if (!el) return { success: false, reason: 'Date element not found' };

                    // Check for Flatpickr on element or its container/parent
                    const fp = el._flatpickr || 
                               el.parentElement?.querySelector('.flatpickr-input')?._flatpickr || 
                               (el.parentElement?.parentElement && el.parentElement.parentElement.querySelector('.flatpickr-input')?._flatpickr) ||
                               (el.closest && el.closest('.osui-datepicker')?.querySelector('.flatpickr-input')?._flatpickr);

                    if (fp) {
                        fp.setDate(dObj, true);
                        if (fp.input) {
                            if (fp.input.type === 'date') {
                                fp.input.value = iso;
                            } else {
                                fp.input.value = dmy;
                            }
                            fp.input.dispatchEvent(new Event('input', { bubbles: true }));
                            fp.input.dispatchEvent(new Event('change', { bubbles: true }));
                            fp.input.dispatchEvent(new Event('blur', { bubbles: true }));
                        }
                        if (fp.altInput) {
                            fp.altInput.value = dmy;
                            fp.altInput.dispatchEvent(new Event('input', { bubbles: true }));
                            fp.altInput.dispatchEvent(new Event('change', { bubbles: true }));
                            fp.altInput.dispatchEvent(new Event('blur', { bubbles: true }));
                        }
                        if (fp.config && fp.config.onChange) {
                            fp.config.onChange.forEach(cb => {
                                try { cb([dObj], fp.input ? fp.input.value : dmy, fp); } catch {}
                            });
                        }
                        return { success: true, method: 'flatpickr', val: dmy };
                    }

                    // Standard input fallback
                    el.removeAttribute('readonly');
                    el.removeAttribute('disabled');
                    const targetVal = el.type === 'date' ? iso : dmy;
                    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                    if (setter) setter.call(el, targetVal); else el.value = targetVal;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                    return { success: true, method: 'native', val: targetVal };
                })()
            `);

            if (result && result.success) {
                this.log(`  📅 [Playwright MCP] Successfully set date to "${result.val}" via ${result.method}.`);
                await this.captureScreen();
                return { content: [{ type: 'text', text: `Date successfully set: ${result.val}` }] };
            }
        } catch (err) {
            this.log(`  ⚠️ [Playwright MCP] fillDateField evaluation error: ${err.message}`);
        }
        return null;
    }

    /**
     * Standardized Type / Fill via MCP
     */
    async fill(selector, value) {
        let finalVal = String(value);
        const lowerSel = selector.toLowerCase();
        const rawVal = finalVal.trim();
        const isDateGoal = /\b(date|dob|birth|start_date|end_date|startdate|enddate|from_date|to_date)\b/i.test(selector) ||
            /\[(name|id|data-test|placeholder)\*?=['"]?(start|end|from|to)?_?date['"]?\]/i.test(selector) ||
            /^(today|tomorrow|yesterday|next\s+day)$/i.test(rawVal) ||
            /^\d{4}-\d{2}-\d{2}$/.test(rawVal) ||
            /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(rawVal);

        if (isDateGoal) {
            const dateResult = await this.fillDateField(selector, value);
            if (dateResult) return dateResult;
            finalVal = resolveRelativeDate(finalVal);
        }

        this.log(`  ⌨️ [Playwright MCP] Calling playwright_fill: "${selector}" -> "${finalVal}"`);
        await this.dismissLoaders();

        const candidates = selector.includes(',')
            ? selector.split(',').map(s => s.trim()).filter(Boolean)
            : [selector.trim()];

        // Dynamic progressive wait (up to 20s, logging milestones at 5s, 10s, 15s, 20s)
        const bestCandidate = await this.waitForCandidate(candidates, {
            descriptor: selector,
            checkType: 'editable',
            timeoutMs: 20000,
            intervalMs: 200
        });

        let lastErr = null;
        if (bestCandidate) {
            try {
                const res = await this.callTool('playwright_fill', { selector: bestCandidate, value: finalVal });
                await this.captureScreen();
                return res;
            } catch (err) {
                lastErr = err;
            }
        }

        // Universal DOM evaluation fallback for React/Vue/Angular and standard HTML forms
        this.log(`  ⚠️ [Playwright MCP] Physical fill on candidates failed (${lastErr?.message?.slice(0, 80) || 'no direct candidate'}). Retrying via DOM evaluation.`);
        try {
            const evaluated = await this.evaluate(`
                (() => {
                    const raw = ${JSON.stringify(selector)};
                    const val = ${JSON.stringify(finalVal)};
                    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
                    let el = null;

                    // 1. Direct match on candidates
                    for (const part of parts) {
                        try {
                            if (!part.startsWith('text=') && !part.includes(':has-text(')) {
                                const found = document.querySelector(part);
                                if (found && (found.tagName.toLowerCase() === 'input' || found.tagName.toLowerCase() === 'textarea')) {
                                    el = found;
                                    break;
                                }
                            }
                        } catch {}
                    }

                    // 2. Search by Label Text Association
                    if (!el) {
                        const cleanTarget = raw.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().toLowerCase();
                        const labels = Array.from(document.querySelectorAll('label'));
                        for (const lbl of labels) {
                            const txt = (lbl.textContent || '').trim().toLowerCase();
                            if (cleanTarget && (txt === cleanTarget || txt.includes(cleanTarget) || cleanTarget.includes(txt))) {
                                if (lbl.htmlFor) {
                                    el = document.getElementById(lbl.htmlFor);
                                    if (el) break;
                                }
                                el = lbl.querySelector('input, textarea');
                                if (el) break;
                                const parent = lbl.closest('.form-group, .form-row, .col, tr, div');
                                if (parent) {
                                    el = parent.querySelector('input:not([type="hidden"]), textarea');
                                    if (el) break;
                                }
                            }
                        }
                    }

                    // 3. Fuzzy search across all inputs and textareas on page
                    if (!el) {
                        const cleanTarget = raw.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().toLowerCase();
                        const compact = cleanTarget.replace(/\\s+/g, '');
                        const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea'));
                        for (const inp of allInputs) {
                            const id = (inp.id || '').toLowerCase();
                            const name = (inp.name || '').toLowerCase();
                            const ph = (inp.placeholder || '').toLowerCase();
                            const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
                            const title = (inp.title || '').toLowerCase();

                            if (compact && (id.includes(compact) || name.includes(compact) || ph.includes(compact) || aria.includes(compact))) {
                                el = inp;
                                break;
                            }
                            if (cleanTarget && (ph.includes(cleanTarget) || aria.includes(cleanTarget) || title.includes(cleanTarget))) {
                                el = inp;
                                break;
                            }
                        }
                    }

                    // 4. Fallback for date fields (generic)
                    if (!el && raw.toLowerCase().includes('start')) {
                        el = document.querySelector('input[placeholder*="Start" i], input[id*="StartDate" i], input[name*="StartDate" i], input[type="date"]');
                    } else if (!el && raw.toLowerCase().includes('end')) {
                        el = document.querySelector('input[placeholder*="End" i], input[id*="EndDate" i], input[name*="EndDate" i], input[type="date"]');
                    } else if (!el && raw.toLowerCase().includes('date')) {
                        el = document.querySelector('input[id*="Date" i], input[name*="Date" i], input[placeholder*="Date" i], input[type="date"]');
                    }

                    if (el) {
                        el.removeAttribute('readonly');
                        el.removeAttribute('disabled');
                        el.scrollIntoView({ block: 'center', inline: 'center' });

                        // Native property setter invocation to ensure React/Vue/Angular detect the input change
                        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                        if (setter) {
                            setter.call(el, val);
                        } else {
                            el.value = val;
                        }

                        if (el._flatpickr) {
                            try { el._flatpickr.setDate(val, true); } catch {}
                        }

                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                        return true;
                    }
                    return false;
                })()
            `);
            if (evaluated) {
                this.log(`  📅 [Playwright MCP] Set field value "${finalVal}" via DOM event dispatch.`);
                await this.captureScreen();
                return { content: [{ type: 'text', text: `Filled via DOM evaluation: ${selector}` }] };
            }
        } catch (evalErr) {
            // Ignore eval error
        }
        throw lastErr || new Error(`Fill failed for: ${selector}`);
    }

    /**
     * Standardized Select Option via MCP (Supports native <select> and custom/React-Select comboboxes)
     */
    /**
     * Standardized Select Option via MCP (Supports native <select>, OutSystems dropdowns, and custom/React-Select comboboxes)
     */
    async select(selector, value) {
        this.log(`  📋 [Playwright MCP] Resolving select dropdown: "${selector}" -> "${value}"`);
        await this.dismissLoaders();

        const cleanVal = String(value).trim();
        const valLower = cleanVal.toLowerCase();

        // 1. Check if the element is actually a searchable dropdown or combobox <input> (e.g. react-select, autocomplete, OutSystems DropdownSearch)
        try {
            const inputInfo = await this.evaluate(`
                (() => {
                    const raw = ${JSON.stringify(selector)};
                    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
                    for (const part of parts) {
                        try {
                            if (!part.startsWith('text=') && !part.includes(':has-text(')) {
                                const el = document.querySelector(part);
                                if (el) {
                                    if (el.tagName.toLowerCase() === 'input') {
                                        return { isInput: true, selector: part };
                                    }
                                    const childInp = el.querySelector('input');
                                    if (childInp) {
                                        return { isInput: true, selector: part + ' input' };
                                    }
                                }
                            }
                        } catch {}
                    }
                    return null;
                })()
            `);

            if (inputInfo && inputInfo.isInput) {
                this.log(`  🎯 [Playwright MCP] Target is a searchable dropdown input: "${inputInfo.selector}"`);
                try {
                    await this.callTool('playwright_click', { selector: inputInfo.selector });
                    await this.callTool('playwright_fill', { selector: inputInfo.selector, value: cleanVal });
                    await new Promise(r => setTimeout(r, 400));
                    await this.callTool('playwright_press_key', { key: 'Enter' });
                    await this.captureScreen();
                    this.log(`  ✅ [Playwright MCP] Selected "${cleanVal}" via searchable dropdown input.`);
                    return { content: [{ type: 'text', text: `Selected: ${cleanVal}` }] };
                } catch (inputErr) {
                    this.log(`  ⚠️ [Playwright MCP] Searchable input fill/press failed: ${inputErr.message}`);
                }
            }
        } catch { }

        // 1b. Universal VirtualSelect (.vscomp-wrapper) Support
        try {
            const vsResult = await this.evaluate(`
                (() => {
                    const val = ${JSON.stringify(cleanVal)}.toLowerCase();
                    const sel = ${JSON.stringify(selector)};
                    const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
                    let targetVs = null;

                    for (const p of parts) {
                        try {
                            const el = document.querySelector(p);
                            if (el && (el.classList.contains('vscomp-wrapper') || el.classList.contains('vscomp-ele') || el.querySelector('.vscomp-wrapper'))) {
                                targetVs = el.classList.contains('vscomp-wrapper') ? el : (el.querySelector('.vscomp-wrapper') || el);
                                break;
                            }
                        } catch {}
                    }
                    if (!targetVs) {
                        const allVs = Array.from(document.querySelectorAll('.vscomp-wrapper'));
                        if (allVs.length > 0) targetVs = allVs[0];
                    }

                    if (targetVs) {
                        const vsInstance = targetVs.virtualSelect || (targetVs.closest('.vscomp-ele') && targetVs.closest('.vscomp-ele').virtualSelect);
                        if (vsInstance && vsInstance.options) {
                            const opt = vsInstance.options.find(o => (o.label || o.text || '').toLowerCase().includes(val)) || vsInstance.options[0];
                            if (opt) {
                                vsInstance.setValue(opt.value);
                                return { ok: true, method: 'virtualSelect.setValue', text: opt.label || opt.text };
                            }
                        }
                        const toggle = targetVs.querySelector('.vscomp-toggle-button') || targetVs;
                        toggle.click();
                        return { ok: true, method: 'opened_toggle' };
                    }
                    return null;
                })()
            `);
            if (vsResult && vsResult.ok) {
                if (vsResult.method === 'virtualSelect.setValue') {
                    this.log(`  ✅ [Playwright MCP] Selected "\${vsResult.text}" via VirtualSelect API.`);
                    await this.captureScreen();
                    return { content: [{ type: 'text', text: `Selected: \${vsResult.text}` }] };
                }
                await new Promise(r => setTimeout(r, 600));
                const picked = await this.evaluate(`
                    (() => {
                        const val = ${JSON.stringify(cleanVal)}.toLowerCase();
                        const options = Array.from(document.querySelectorAll('.vscomp-option'));
                        const opt = options.find(o => (o.innerText || '').toLowerCase().includes(val)) || options[0];
                        if (opt) {
                            opt.click();
                            return opt.innerText.trim();
                        }
                        return null;
                    })()
                `);
                if (picked) {
                    this.log(`  ✅ [Playwright MCP] Clicked VirtualSelect option "\${picked}".`);
                    await this.captureScreen();
                    return { content: [{ type: 'text', text: `Selected: \${picked}` }] };
                }
            }
        } catch { }

        // 2. Poll DOM up to 20 seconds for a native <select> element or custom dropdown options
        let selectInfo = null;
        for (let attempt = 0; attempt < 40; attempt++) {
            if (attempt === 10) {
                this.log(`  ⏳ [Wait 5s] Waiting for dropdown "${selector}" options to load...`);
            } else if (attempt === 20) {
                this.log(`  ⏳ [Wait 10s] Still waiting for dropdown "${selector}" options to appear...`);
            } else if (attempt === 30) {
                this.log(`  ⏳ [Wait 15s] Dropdown "${selector}" options still loading...`);
            } else if (attempt === 39) {
                this.log(`  ⏳ [Wait 20s] Dynamic timeout (20s) reached for dropdown "${selector}".`);
            }

            try {
                const evaluated = await this.evaluate(`
                    (() => {
                        const raw = ${JSON.stringify(selector)};
                        const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
                        let s = null;

                        function getSelectData(selectEl) {
                            if (!selectEl || selectEl.tagName.toLowerCase() !== 'select') return null;
                            const optionsList = Array.from(selectEl.options || []).map((o, idx) => ({
                                index: idx,
                                value: o.value,
                                text: (o.text || o.textContent || '').trim()
                            }));
                            return {
                                id: selectEl.id || null,
                                tagName: 'select',
                                className: selectEl.className || '',
                                selector: selectEl.id ? ('#' + selectEl.id) : (selectEl.name ? ('select[name="' + selectEl.name + '"]') : (selectEl.className ? ('select.' + selectEl.className.split(' ').filter(Boolean).join('.')) : 'select')),
                                optionsCount: optionsList.length,
                                options: optionsList
                            };
                        }

                        // 2a. Direct selector match or child of container
                        for (const part of parts) {
                            try {
                                if (!part.startsWith('text=') && !part.includes(':has-text(')) {
                                    const found = document.querySelector(part);
                                    if (found) {
                                        if (found.tagName.toLowerCase() === 'select') {
                                            s = found;
                                            break;
                                        }
                                        const childSel = found.querySelector('select');
                                        if (childSel) {
                                            s = childSel;
                                            break;
                                        }
                                    }
                                }
                            } catch {}
                        }

                        // 2b. Label-based search: Look for label matching target descriptor
                        if (!s) {
                            try {
                                const cleanTarget = raw.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().toLowerCase();
                                const allLabels = Array.from(document.querySelectorAll('label, .control-label, span, div'));
                                const matchingLabel = allLabels.find(l => {
                                    const t = (l.textContent || '').toLowerCase().trim();
                                    return cleanTarget && (t === cleanTarget || t.startsWith(cleanTarget) || cleanTarget.includes(t));
                                });
                                if (matchingLabel) {
                                    const parentContainer = matchingLabel.closest('.form-group, .margin-bottom-base, [class*="form"], div');
                                    if (parentContainer) {
                                        s = parentContainer.querySelector('select');
                                    }
                                    if (!s && matchingLabel.nextElementSibling) {
                                        s = matchingLabel.nextElementSibling.tagName === 'SELECT'
                                            ? matchingLabel.nextElementSibling
                                            : matchingLabel.nextElementSibling.querySelector('select');
                                    }
                                }
                            } catch {}
                        }

                        // 2c. General dropdown selectors
                        if (!s) {
                            try {
                                s = document.querySelector('.dropdown select, select.dropdown-display, select[id*="Dropdown" i], select[name*="select" i], .popup-dialog select, .modal-dialog select, select');
                            } catch {}
                        }

                        return getSelectData(s);
                    })()
                `);

                if (evaluated) {
                    selectInfo = evaluated;
                    // If options are loaded beyond the default placeholder, stop polling
                    const hasLoadedOptions = (evaluated.options || []).some(o => o.value !== '' && o.value !== '-1');
                    if (hasLoadedOptions && evaluated.optionsCount > 1) {
                        break;
                    }
                }
            } catch { }
            if (attempt < 39) await new Promise(r => setTimeout(r, 500));
        }

        // 3. Intelligent option matching for native <select>
        if (selectInfo && selectInfo.options && selectInfo.options.length > 0) {
            const availableOptions = selectInfo.options.filter(o => o.value !== '' && o.value !== '-1');

            const synonymMap = {
                'annual': ['annual', 'earned', 'privilege', 'al', 'el', 'vacation', 'paid', 'casual'],
                'earned': ['annual', 'earned', 'privilege', 'al', 'el', 'vacation', 'paid'],
                'comp': ['comp', 'compoff', 'comp-off', 'compensatory'],
                'compoff': ['comp', 'compoff', 'comp-off', 'compensatory'],
                'sick': ['sick', 'medical', 'casual', 'sl'],
                'maternity': ['maternity'],
                'paternity': ['paternity'],
                'marriage': ['marriage', 'wedding'],
                'bereavement': ['bereavement', 'condolence'],
                'optional': ['optional', 'floating', 'holiday'],
                'unpaid': ['unpaid', 'loss of pay', 'lop']
            };

            const stopWords = new Set(['select', 'from', 'the', 'dropdown', 'option', 'type', 'leave', 'as']);
            const rawTokens = valLower.split(/[^a-z0-9]+/i).filter(t => t.length > 1 && !stopWords.has(t));
            const expandedTokens = new Set(rawTokens);
            for (const t of rawTokens) {
                if (synonymMap[t]) {
                    synonymMap[t].forEach(syn => expandedTokens.add(syn));
                }
            }

            let bestScore = -1;
            let bestOption = null;
            for (const opt of availableOptions) {
                const optTextLower = opt.text.toLowerCase();
                const optValLower = opt.value.toLowerCase();
                let score = 0;

                if (optTextLower === valLower || optValLower === valLower) {
                    score = 100;
                } else if (optTextLower.includes(valLower) || valLower.includes(optTextLower)) {
                    score = 60;
                } else {
                    const optTokens = optTextLower.split(/[^a-z0-9]+/i).filter(t => t.length > 1);
                    for (const token of expandedTokens) {
                        if (optTokens.includes(token)) {
                            score += 25;
                        } else if (optTextLower.includes(token)) {
                            score += 15;
                        }
                    }
                    const extraTokens = optTokens.filter(t => !stopWords.has(t) && !expandedTokens.has(t));
                    score -= (extraTokens.length * 2);
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestOption = opt;
                }
            }

            // Only select if we found a valid non-placeholder option
            if (!bestOption || bestScore <= 0) {
                if (availableOptions.length > 0) {
                    bestOption = availableOptions[0];
                } else {
                    bestOption = null;
                }
            }

            if (bestOption && bestOption.value !== '' && bestOption.value !== '-1') {
                const targetSelector = selectInfo.selector || 'select';
                this.log(`  🎯 [Playwright MCP] Matched option: "${bestOption.text}" (value: "${bestOption.value}") on ${targetSelector}`);

                let selectSuccess = false;
                const valToSelect = String(bestOption.value);
                const textToSelect = String(bestOption.text);

                try {
                    await this.callTool('playwright_select', { selector: targetSelector, value: valToSelect });
                    selectSuccess = true;
                } catch (mcpErr) {
                    this.log(`  ⚠️ [Playwright MCP] Native playwright_select returned: ${mcpErr.message?.slice(0, 60)}. Applying DOM event dispatch.`);
                }

                // Direct DOM event injection and option selection
                try {
                    const domSelected = await this.evaluate(`
                        (() => {
                            const targetSel = ${JSON.stringify(targetSelector)};
                            const sel = document.querySelector(targetSel) || document.querySelector('select');
                            if (sel && sel.tagName.toLowerCase() === 'select') {
                                const targetVal = ${JSON.stringify(valToSelect)};
                                const targetTxt = ${JSON.stringify(textToSelect)}.toLowerCase();
                                const opt = Array.from(sel.options).find(o => o.value === targetVal) 
                                    || Array.from(sel.options).find(o => (o.text || '').toLowerCase() === targetTxt)
                                    || Array.from(sel.options).find(o => (o.text || '').toLowerCase().includes(targetTxt))
                                    || sel.options[${bestOption.index}];
                                if (opt) {
                                    sel.value = opt.value;
                                    sel.selectedIndex = opt.index;
                                    try { opt.selected = true; } catch {}
                                    sel.dispatchEvent(new Event('input', { bubbles: true }));
                                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                                    sel.dispatchEvent(new Event('blur', { bubbles: true }));
                                    if (typeof sel.onchange === 'function') {
                                        try { sel.onchange(); } catch {}
                                    }
                                    return true;
                                }
                            }
                            return false;
                        })()
                    `);
                    if (domSelected) selectSuccess = true;
                } catch { }

                if (selectSuccess) {
                    this.log(`  ✅ [Playwright MCP] Successfully selected "${bestOption.text}"`);
                    await this.captureScreen();
                    return { content: [{ type: 'text', text: `Selected: ${bestOption.text}` }] };
                }
            } else {
                this.log(`  ⚠️ [Playwright MCP] No valid non-placeholder option found in native <select> (available: ${availableOptions.length}). Falling back to custom dropdown handling.`);
            }
        }

        // 4. Custom OutSystems / Div-based Dropdown Fallback
        // Open the dropdown container, wait for options popup to render, then click matched option
        try {
            this.log(`  📋 [Playwright MCP] Attempting custom dropdown open and option click...`);
            // 4a. Click the trigger/dropdown display
            await this.evaluate(`
                (() => {
                    const raw = ${JSON.stringify(selector)};
                    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
                    
                    // Priority triggers: element showing "Select leave type" or container
                    const textTrigger = Array.from(document.querySelectorAll('*')).find(el => {
                        const t = (el.textContent || '').trim().toLowerCase();
                        return (t === 'select leave type' || t.startsWith('select leave')) && el.children.length <= 1;
                    });
                    if (textTrigger) {
                        textTrigger.click();
                        return true;
                    }

                    for (const part of parts) {
                        try {
                            const trigger = document.querySelector(part);
                            if (trigger) {
                                trigger.click();
                                return true;
                            }
                        } catch {}
                    }

                    // Fallback to any dropdown container
                    const dd = document.querySelector('.dropdown, [class*="dropdown"], [id*="Dropdown"], .choices');
                    if (dd) {
                        dd.click();
                        return true;
                    }
                    return false;
                })()
            `);

            // Wait 500ms for options menu to render and animate open
            await new Promise(r => setTimeout(r, 500));

            // 4b. Find and click matching item in opened menu/list
            const clickedCustom = await this.evaluate(`
                (() => {
                    const val = ${JSON.stringify(valLower)};
                    const synonymKeys = ['annual', 'earned', 'comp', 'sick', 'maternity', 'paternity', 'bereavement'];
                    const synonyms = {
                        'annual': ['annual', 'earned', 'privilege', 'al', 'el', 'vacation'],
                        'earned': ['annual', 'earned', 'privilege', 'al', 'el'],
                        'comp': ['comp', 'compoff', 'comp-off', 'compensatory'],
                        'sick': ['sick', 'medical', 'sl']
                    };

                    const items = Array.from(document.querySelectorAll('[role="option"], .dropdown-item, .osui-dropdown__item, .choices__item, .dropdown-list div, [class*="option"], [class*="menu"] div, li'));
                    
                    // Exact or substring match
                    let match = items.find(it => {
                        const txt = (it.textContent || '').trim().toLowerCase();
                        return txt === val || txt.includes(val) || val.includes(txt);
                    });

                    // Synonym match
                    if (!match) {
                        for (const key of synonymKeys) {
                            if (val.includes(key) && synonyms[key]) {
                                match = items.find(it => {
                                    const txt = (it.textContent || '').trim().toLowerCase();
                                    return synonyms[key].some(syn => txt.includes(syn));
                                });
                                if (match) break;
                            }
                        }
                    }

                    if (match) {
                        match.scrollIntoView({ block: 'center' });
                        match.click();
                        return true;
                    }
                    return false;
                })()
            `);

            if (clickedCustom) {
                this.log(`  ✅ [Playwright MCP] Clicked custom dropdown option "${cleanVal}".`);
                await this.captureScreen();
                return { content: [{ type: 'text', text: `Selected: ${cleanVal}` }] };
            }
        } catch (customErr) {
            this.log(`  ⚠️ [Playwright MCP] Custom dropdown attempt: ${customErr.message}`);
        }

        throw new Error(`Failed to select option "${cleanVal}" in "${selector}"`);
    }

    /**
     * Standardized Evaluate via MCP
     */
    async evaluate(script) {
        const res = await this.callTool('playwright_evaluate', { script });
        const textObj = res.content?.find(c => c.text && c.text.startsWith('Result:'));
        if (textObj) {
            try {
                const lines = res.content.map(c => c.text);
                const resIdx = lines.findIndex(l => l.includes('Result:'));
                if (resIdx !== -1 && lines[resIdx + 1] !== undefined) {
                    const rawVal = lines[resIdx + 1].trim();
                    if (rawVal === 'undefined') return undefined;
                    if (rawVal === 'null') return null;
                    return JSON.parse(rawVal);
                }
            } catch { }
        }
        return null;
    }

    async selectOption(selector, value) {
        return this.select(selector, value);
    }

    /**
     * AI Self-Healing using MCP DOM inspection and multimodal screenshot
     */
    async healSelectorWithAI(action, failedSelector) {
        try {
            this.log(`  🔄 [Playwright MCP] Entering AI self-healing for: "${failedSelector}"`);

            // Query DOM specifically for candidate interactive elements
            const evalCandidates = await this.evaluate(`
                (() => {
                    const elements = Array.from(document.querySelectorAll(
                        'button, input, a, select, textarea, [role="button"], [role="menuitem"], [onclick], [class*="click"], [class*="dropdown"], [class*="menu"], [class*="trigger"], [class*="icon"], h1, h2, h3, h4, h5, h6, .card, [class*="card"]'
                    ));
                    return elements
                        .filter(el => {
                            const rect = el.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                        })
                        .map(el => ({
                            tagName: el.tagName.toLowerCase(),
                            id: el.id || null,
                            name: el.getAttribute('name') || null,
                            type: el.getAttribute('type') || null,
                            className: el.className || null,
                            text: el.textContent ? el.textContent.trim().slice(0, 100).replace(/\\s+/g, ' ') : '',
                            outerHTML: el.outerHTML.slice(0, 250)
                        }));
                })()
            `);

            const candidates = Array.isArray(evalCandidates) ? evalCandidates : [];
            const formattedCandidates = candidates.map((c, idx) => {
                let desc = `${idx + 1}. <${c.tagName}`;
                if (c.id) desc += ` id="${c.id}"`;
                if (c.name) desc += ` name="${c.name}"`;
                if (c.className) desc += ` class="${c.className}"`;
                desc += `>`;
                if (c.text) desc += ` Text: "${c.text}"`;
                desc += ` | HTML: ${c.outerHTML}`;
                return desc;
            }).join('\n');

            const prompt = `You are a test automation self-healing engine using Playwright MCP Server.
A locator failed to find an element on the page.

Action: ${action}
Failed Target: "${failedSelector}"

Interactive elements currently in DOM:
${formattedCandidates}

Rules:
1. Identify the single leaf element (button, select, input, a, heading h1-h6, card) matching the user's intent.
2. If it's a dropdown or select, suggest the select CSS or ID (e.g. "select[name='country']", "#roleSelect").
3. If it's a button or link, suggest the button CSS or text (e.g. "button:has-text('Submit')", "a:has-text('Next')").
4. If it's a heading or card title (e.g. DemoQA category card or section header), suggest the heading or card text (e.g. "h5:has-text('Forms')", ".card:has-text('Alerts, Frame & Windows')").
Return ONLY the raw selector string. No quotes, no markdown blocks.`;

            const apiKey = process.env.VITE_LLM_API_KEY;
            const endpoint = process.env.VITE_LLM_ENDPOINT;
            const llmModel = process.env.VITE_LLM_MODEL || 'gemma-4';

            if (!apiKey) return null;

            const genAI = new GoogleGenerativeAI(apiKey, endpoint);
            const model = genAI.getGenerativeModel({
                model: llmModel,
                generationConfig: { temperature: 0.1 }
            });

            const promptParts = [];
            if (this.latestScreenshotBase64) {
                promptParts.push({
                    inlineData: {
                        data: this.latestScreenshotBase64,
                        mimeType: 'image/jpeg'
                    }
                });
            }
            promptParts.push({ text: prompt });

            const result = await model.generateContent(promptParts);
            const raw = result.response.text().trim().replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
            const suggestion = raw.replace(/^["'`]|["'`]$/g, '').trim();
            const lower = suggestion.toLowerCase();
            if (!suggestion ||
                lower.startsWith('no ') ||
                lower.startsWith('none') ||
                lower.startsWith('sorry') ||
                lower.startsWith('cannot') ||
                lower.includes('not found') ||
                lower.includes('were found') ||
                lower.includes('unable to') ||
                (suggestion.split(/\s+/).length > 5 && !suggestion.includes(':has-text') && !suggestion.includes('text='))) {
                this.log(`  ⚠️ [Playwright MCP] AI healing did not find a valid replacement selector: "${suggestion.slice(0, 80)}"`);
                return null;
            }
            return suggestion;
        } catch (e) {
            this.log(`  ⚠️ [Playwright MCP] AI healing failed: ${e.message}`);
            return null;
        }
    }

    /**
     * Close browser and MCP process
     */
    async close() {
        try {
            if (this.client) {
                await this.callTool('playwright_close', {}).catch(() => { });
                await this.client.close().catch(() => { });
            }
        } catch (err) {
            // Ignore close errors
        } finally {
            this.client = null;
            this.transport = null;
            this.browserStarted = false;
        }
    }
}
