import React, { useState } from 'react';
import { generateLocators } from '../services/locatorGenerationService';
import { exportToJSON, exportToExcel } from '../utils/exportUtils';
import { Target, Search, Copy, Download, Code, Globe, AlertCircle, Loader2 } from 'lucide-react';
import { useProject } from '../context/ProjectContext';
import UrlScopeWarning from '../components/common/UrlScopeWarning';

// BASE_URL-prefixed relative path. See src/services/testRunnerService.js for why.
// Hardcoded http://localhost:3001 worked in dev but 404'd in QA (browser bypasses the Vite proxy in prod).
const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

const LocatorGenerator = () => {
    const { selectedProjectId } = useProject();
    const [mode, setMode] = useState('html'); // 'html' or 'url'
    const [htmlInput, setHtmlInput] = useState('');
    const [urlInput, setUrlInput] = useState('');
    const [useCookies, setUseCookies] = useState(false);
    const [cookieInput, setCookieInput] = useState('');
    const [locators, setLocators] = useState(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [statusText, setStatusText] = useState('');
    const [error, setError] = useState(null);
    const [copiedIndex, setCopiedIndex] = useState(null);

    // Interactive Mode State
    const [isBrowserActive, setIsBrowserActive] = useState(false);
    // Browser Type Selection (chromium, firefox, webkit)
    const [browserType, setBrowserType] = useState('chromium');

    // Headless navigation state inside modal
    const [currentBrowserUrl, setCurrentBrowserUrl] = useState('');
    const [navUrlInput, setNavUrlInput] = useState('');

    // Custom Extension connection state
    const [isExtensionInstalled, setIsExtensionInstalled] = useState(false);

    const handleLaunchBrowser = async () => {
        setIsGenerating(true);
        setStatusText("Launching Browser...");
        setError(null);
        try {
            let cookies = [];
            if (useCookies && cookieInput.trim()) {
                try {
                    cookies = JSON.parse(cookieInput);
                    if (!Array.isArray(cookies)) throw new Error("Cookies must be a JSON Array.");
                } catch (e) {
                    throw new Error("Invalid Cookie JSON format. Please paste a valid array of cookies.");
                }
            }

            const response = await fetch(`${API_URL}/browser/launch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: urlInput, browserType, cookies, projectId: selectedProjectId || null })
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Launch failed: ${text}`);
            }
            setIsBrowserActive(true);
            setCurrentBrowserUrl(urlInput);
        } catch (e) {
            setError(e.message);
        } finally {
            setIsGenerating(false);
            setStatusText('');
        }
    };

    const handleNavigateBrowser = async () => {
        setIsGenerating(true);
        setStatusText("Navigating Browser...");
        setError(null);
        try {
            let target = navUrlInput.trim();
            if (target.startsWith('/')) {
                try {
                    const base = new URL(urlInput);
                    target = `${base.protocol}//${base.host}${target}`;
                } catch (e) {
                    // Fallback if urlInput is not fully qualified
                }
            } else if (!/^https?:\/\//i.test(target)) {
                target = 'https://' + target;
            }

            const response = await fetch(`${API_URL}/browser/navigate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: target })
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Navigation failed: ${text}`);
            }
            const data = await response.json();
            setCurrentBrowserUrl(data.currentUrl || target);
            setNavUrlInput('');
        } catch (e) {
            setError(e.message);
        } finally {
            setIsGenerating(false);
            setStatusText('');
        }
    };

    const handleCloseBrowser = async () => {
        try {
            await fetch(`${API_URL}/browser/close`, { method: 'POST' });
        } catch (e) {
            console.error("Failed to close browser", e);
        } finally {
            setIsBrowserActive(false);
            setCurrentBrowserUrl('');
            setNavUrlInput('');
        }
    };
    const [capturedHtml, setCapturedHtml] = useState('');

    const handlePullCookies = () => {
        if (!urlInput.trim()) {
            setError("Please enter a URL first to retrieve session cookies.");
            return;
        }
        window.postMessage({ source: 'aaqua-app', type: 'AAQUA_GET_COOKIES', url: urlInput }, '*');
    };

    const handleCaptureDOM = () => {
        if (!urlInput.trim()) {
            setError("Please enter a URL first to target the browser tab.");
            return;
        }
        setIsGenerating(true);
        setStatusText("Capturing page DOM via extension...");
        setError(null);
        window.postMessage({ source: 'aaqua-app', type: 'AAQUA_GET_DOM', url: urlInput }, '*');
    };

    const triggerGenerateWithCapturedHtml = async (html, url, cookies, storage) => {
        setIsGenerating(true);
        setError(null);
        setLocators(null);
        setStatusText('Analyzing captured page DOM...');

        try {
            const payload = {
                url: url,
                cookies: storage 
                    ? { cookies, localStorage: storage.localStorage, sessionStorage: storage.sessionStorage }
                    : cookies,
                html: html
            };

            const scrapeRes = await fetch(`${API_URL}/scrape`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!scrapeRes.ok) throw new Error("Failed to process captured DOM");
            const scrapeData = await scrapeRes.json();
            
            const result = await generateLocators(scrapeData.html);
            setLocators(result);
        } catch (err) {
            console.error(err);
            setError(err.message || "Failed to generate locators from captured page");
        } finally {
            setIsGenerating(false);
            setStatusText('');
        }
    };

    React.useEffect(() => {
        console.log("LocatorGenerator mounted");

        const handleExtensionMessage = (e) => {
            if (!e.data || e.data.source !== 'aaqua-extension') return;

            if (e.data.type === 'AAQUA_EXTENSION_READY') {
                setIsExtensionInstalled(true);
            }

            if (e.data.type === 'AAQUA_SET_COOKIES') {
                if (e.data.cookies && e.data.cookies.length > 0) {
                    const payload = e.data.storage
                        ? {
                            cookies: e.data.cookies,
                            localStorage: e.data.storage.localStorage,
                            sessionStorage: e.data.storage.sessionStorage
                          }
                        : e.data.cookies;
                    setCookieInput(JSON.stringify(payload, null, 2));
                    setUseCookies(true);
                    setError(null);
                } else if (e.data.error) {
                    setError(`Cookie Bridge: ${e.data.error}`);
                } else {
                    setError("No active session cookies found in your browser for this domain. Please open the page in another tab and log in first.");
                }
            }

            if (e.data.type === 'AAQUA_SET_DOM') {
                setIsGenerating(false);
                setStatusText('');
                if (e.data.html) {
                    setCapturedHtml(e.data.html);
                    if (e.data.url) {
                        setUrlInput(e.data.url);
                    }
                    if (e.data.cookies && e.data.cookies.length > 0) {
                        const payload = e.data.storage
                            ? {
                                cookies: e.data.cookies,
                                localStorage: e.data.storage.localStorage,
                                sessionStorage: e.data.storage.sessionStorage
                              }
                            : e.data.cookies;
                        setCookieInput(JSON.stringify(payload, null, 2));
                        setUseCookies(true);
                    }
                    setError(null);
                    triggerGenerateWithCapturedHtml(e.data.html, e.data.url, e.data.cookies, e.data.storage);
                } else if (e.data.error) {
                    setError(`DOM Capture Error: ${e.data.error}`);
                } else {
                    setError("Failed to capture tab content via extension. Please make sure the portal tab is open and you are logged in.");
                }
            }
        };

        window.addEventListener('message', handleExtensionMessage);
        
        // Ping extension to see if it is already loaded
        window.postMessage({ source: 'aaqua-app', type: 'AAQUA_PING' }, '*');

        return () => {
            window.removeEventListener('message', handleExtensionMessage);
        };
    }, []);

    const handleGenerate = async () => {
        setIsGenerating(true);
        setError(null);
        setLocators(null);
        setStatusText(isBrowserActive ? 'Capturing Session & Generating Locators...' : 'Initializing...');

        try {
            let contentToAnalyze = htmlInput;

            if (mode === 'url') {
                if (isBrowserActive) {
                    // Capture dynamic DOM from active browser session
                    const captureRes = await fetch(`${API_URL}/browser/capture`);
                    if (!captureRes.ok) throw new Error("Failed to capture browser session");

                    const { html, cookies, url } = await captureRes.json();
                    setCookieInput(JSON.stringify(cookies, null, 2));
                    if (url) {
                        setCurrentBrowserUrl(url);
                    }
                    contentToAnalyze = html;
                } else {
                    if (!urlInput.trim()) throw new Error("Please enter a valid URL.");

                    let cookies = [];
                    if (useCookies && cookieInput.trim()) {
                        try {
                            cookies = JSON.parse(cookieInput);
                            if (!Array.isArray(cookies)) throw new Error("Cookies must be a JSON Array.");
                        } catch (e) {
                            throw new Error("Invalid Cookie JSON format. Please paste a valid array of cookies.");
                        }
                    }

                    setStatusText('Scraping Website (this may take a few seconds)...');
                    try {
                        const response = await fetch(`${API_URL}/scrape`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: urlInput, cookies: useCookies ? cookies : [], browserType, projectId: selectedProjectId || null })
                        });

                        if (!response.ok) {
                            const text = await response.text();
                            try {
                                const err = JSON.parse(text);
                                throw new Error(err.details || err.error || "Failed to scrape URL.");
                            } catch (parseErr) {
                                throw new Error(`Backend Error (${response.status}): ${text.substring(0, 100)}...`);
                            }
                        }
                        const data = await response.json();
                        contentToAnalyze = data.html;
                    } catch (fetchErr) {
                        throw new Error(`Scraping failed: ${fetchErr.message}. Make sure 'npm run server' is running.`);
                    }
                }
            } else {
                if (!htmlInput.trim()) throw new Error("Please paste valid HTML content.");
            }

            setStatusText('AI Analyzing DOM & Generating Locators...');
            const data = await generateLocators(contentToAnalyze);
            setLocators(data);

        } catch (err) {
            setError(err.message);
        } finally {
            setIsGenerating(false);
            setStatusText('');
        }
    };

    const handleCopy = (text, index) => {
        navigator.clipboard.writeText(text);
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex(null), 2000);
    };

    const handleExportJSON = () => exportToJSON(locators, 'smart_locators');
    const handleExportExcel = () => exportToExcel(locators, 'smart_locators');

    return (
        <div className="locator-generator animate-fade-in">
            <div className="page-header">
                <h2>Smart Locator Generator</h2>
                <p>Generate resilient locators using Hybrid AI + Code analysis.</p>
            </div>

            <div className="input-section">

                <div className="mode-tabs">
                    <button
                        className={`tab-btn ${mode === 'html' ? 'active' : ''}`}
                        onClick={() => setMode('html')}
                    >
                        <Code size={18} /> Paste HTML
                    </button>
                    <button
                        className={`tab-btn ${mode === 'url' ? 'active' : ''}`}
                        onClick={() => setMode('url')}
                    >
                        <Globe size={18} /> Scrape URL
                    </button>

                </div>

                <div className="input-card">
                    <div className="card-header">
                        {mode === 'html' ? <Code size={18} /> : <Globe size={18} />}
                        <span>{mode === 'html' ? 'Paste Source Code' : 'Enter Website URL'}</span>
                    </div>

                    {mode === 'html' ? (
                        <textarea
                            className="html-input"
                            placeholder="<form>.....</form>"
                            value={htmlInput}
                            onChange={(e) => setHtmlInput(e.target.value)}
                            rows={10}
                            disabled={isGenerating}
                        />
                    ) : (
                        <div className="url-input-wrapper">
                            <input
                                type="url"
                                className="url-input"
                                placeholder="https://example.com"
                                value={urlInput}
                                onChange={(e) => setUrlInput(e.target.value)}
                                disabled={isGenerating}
                            />
                            <UrlScopeWarning url={urlInput} />

                            <div className="browser-select-section" style={{ margin: '1rem 0', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.75rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                                    <span>Browser Type:</span>
                                    <select
                                        value={browserType}
                                        onChange={(e) => setBrowserType(e.target.value)}
                                        disabled={isGenerating}
                                        style={{
                                            background: 'var(--bg-secondary)',
                                            border: '1px solid var(--border-color)',
                                            color: 'var(--text-primary)',
                                            padding: '0.5rem 1rem',
                                            borderRadius: 'var(--radius-md)',
                                            fontSize: '0.85rem',
                                            outline: 'none',
                                            cursor: 'pointer',
                                            fontWeight: '600'
                                        }}
                                    >
                                        <option value="chromium">Chromium (Chrome)</option>
                                        <option value="firefox">Firefox</option>
                                        <option value="webkit">WebKit (Safari)</option>
                                    </select>
                                </label>
                            </div>

                            <div className="cookie-section">
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '0.75rem' }}>
                                    <label className="cookie-toggle" style={{ margin: 0 }}>
                                        <input
                                            type="checkbox"
                                            checked={useCookies}
                                            onChange={(e) => setUseCookies(e.target.checked)}
                                        />
                                        <span>Use Session Cookies (Authenticated Scraping)</span>
                                    </label>

                                    {isExtensionInstalled ? (
                                        <button
                                            type="button"
                                            onClick={handlePullCookies}
                                            disabled={isGenerating || !urlInput.trim()}
                                            style={{
                                                background: 'var(--accent-glow)',
                                                border: '1px solid var(--accent-primary)',
                                                color: 'var(--accent-primary)',
                                                padding: '0.35rem 0.75rem',
                                                borderRadius: 'var(--radius-md)',
                                                fontSize: '0.75rem',
                                                cursor: 'pointer',
                                                fontWeight: '600',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.25rem',
                                                marginLeft: 'auto'
                                            }}
                                        >
                                            ⚡ Pull Active Browser Cookies
                                        </button>
                                    ) : (
                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                                            💡 Install AAQUA Extension to pull cookies
                                        </span>
                                    )}
                                </div>

                                {useCookies && (
                                    <div className="cookie-input-box animate-fade-in">
                                        <div className="cookie-help">
                                            <AlertCircle size={14} />
                                            <span>
                                                <strong>How to get cookies:</strong> Use a browser extension like "EditThisCookie" to export cookies as JSON, or copy from DevTools (Application &gt; Cookies).
                                            </span>
                                        </div>
                                        <textarea
                                            className="cookie-textarea"
                                            placeholder='[{"name": "session_id", "value": "..."}]'
                                            value={cookieInput}
                                            onChange={(e) => setCookieInput(e.target.value)}
                                            rows={5}
                                        />
                                    </div>
                                )}
                            </div>

                            <p className="hint-text">
                                * Requires <code>npm run server</code> running in a separate terminal.
                            </p>
                        </div>
                    )}
                    <div className="card-footer">
                        {mode === 'url' ? (
                            <div className="button-group" style={{ display: 'flex', gap: '1rem', width: '100%', flexWrap: 'wrap' }}>
                                <button
                                    className="btn btn-secondary"
                                    onClick={handleLaunchBrowser}
                                    disabled={isGenerating || !urlInput.trim() || isBrowserActive}
                                    style={{ flex: 1, minWidth: '200px' }}
                                >
                                    {isGenerating && statusText.includes('Launching') ? (
                                        <>
                                            <Loader2 className="spin" size={18} />
                                            Launching...
                                        </>
                                    ) : (
                                        <>
                                            <Globe size={18} />
                                            {isBrowserActive ? 'Browser Active' : 'Launch Login Browser'}
                                        </>
                                    )}
                                </button>
                                {isExtensionInstalled && (
                                    <button
                                        className="btn btn-secondary"
                                        onClick={handleCaptureDOM}
                                        disabled={isGenerating || !urlInput.trim()}
                                        style={{ flex: 1, minWidth: '200px', backgroundColor: '#0ea5e9', color: '#fff', borderColor: '#0ea5e9' }}
                                    >
                                        {isGenerating && statusText.includes('Capturing') ? (
                                            <>
                                                <Loader2 className="spin" size={18} />
                                                Capturing...
                                            </>
                                        ) : (
                                            <>
                                                <Copy size={18} />
                                                Capture Page via Extension
                                            </>
                                        )}
                                    </button>
                                )}
                                <button
                                    className="btn btn-primary"
                                    onClick={handleGenerate}
                                    disabled={isGenerating || (!isBrowserActive && !urlInput.trim() && !capturedHtml)}
                                    style={{ flex: 1, minWidth: '200px' }}
                                >
                                    {isGenerating && !statusText.includes('Launching') && !statusText.includes('Capturing') ? (
                                        <>
                                            <Loader2 className="spin" size={18} />
                                            {statusText || 'Scraping...'}
                                        </>
                                    ) : (
                                        <>
                                            <Search size={18} />
                                            {isBrowserActive ? 'Generate Locators (Browser Session)' : 'Generate Locators'}
                                        </>
                                    )}
                                </button>
                            </div>
                        ) : (
                            <button
                                className="btn btn-primary"
                                onClick={handleGenerate}
                                disabled={isGenerating || !htmlInput.trim()}
                            >
                                {isGenerating ? (
                                    <>
                                        <Loader2 className="spin" size={18} />
                                        {statusText || 'Processing...'}
                                    </>
                                ) : (
                                    <>
                                        <Search size={18} />
                                        Generate Locators
                                    </>
                                )}
                            </button>
                        )}
                    </div>
                </div>

                {isBrowserActive && (
                    <div className="browser-modal animate-fade-in" style={{ textAlign: 'left', marginTop: '1.5rem', border: '1px solid var(--accent-primary)', padding: '1rem', borderRadius: 'var(--radius-md)', background: 'var(--bg-tertiary)' }}>
                        <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 1rem 0', color: 'var(--success)' }}>
                            <Globe size={18} /> Browser Session Active
                        </h4>
                        
                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                                Current Location:
                            </label>
                            <div style={{ display: 'flex', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-primary)', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                                {currentBrowserUrl || urlInput}
                            </div>
                        </div>

                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                                Navigate Headless Session:
                            </label>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <input
                                    type="text"
                                    value={navUrlInput}
                                    onChange={(e) => setNavUrlInput(e.target.value)}
                                    placeholder="e.g. /dashboard or https://example.com/checkout"
                                    disabled={isGenerating}
                                    style={{
                                        flex: 1,
                                        padding: '0.4rem 0.6rem',
                                        background: 'var(--bg-primary)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 'var(--radius-md)',
                                        color: 'var(--text-primary)',
                                        fontSize: '0.85rem'
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && navUrlInput.trim() && !isGenerating) {
                                            handleNavigateBrowser();
                                        }
                                    }}
                                />
                                <button
                                    onClick={handleNavigateBrowser}
                                    className="btn btn-secondary btn-sm"
                                    style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                                    disabled={isGenerating}
                                >
                                    Go
                                </button>
                            </div>
                        </div>

                        <button
                            onClick={handleCloseBrowser}
                            className="btn btn-danger btn-sm"
                            style={{ width: '100%', padding: '0.5rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: '600' }}
                            disabled={isGenerating}
                        >
                            Close Browser Session
                        </button>
                    </div>
                )}
            </div>

            {error && (
                <div className="error-banner animate-fade-in">
                    <AlertCircle size={20} />
                    <span>{error}</span>
                </div>
            )}

            {locators && (
                <div className="results-section animate-fade-in">
                    <div className="results-header">
                        <h3>Generated Locators ({locators.length})
                            <span style={{ fontSize: '0.8rem', fontWeight: '500', marginLeft: '1rem', color: 'var(--text-secondary)' }}>
                                (🤖 AI: {locators.filter(l => l.source === 'AI').length} | 💻 Code: {locators.filter(l => l.source !== 'AI').length})
                            </span>
                        </h3>
                        <div className="export-actions">
                            <button className="btn btn-secondary btn-sm" onClick={handleExportJSON}>
                                <Download size={16} /> JSON
                            </button>
                            <button className="btn btn-secondary btn-sm" onClick={handleExportExcel}>
                                <Download size={16} /> Excel
                            </button>
                        </div>
                    </div>

                    <div className="table-responsive">
                        <table>
                            <thead>
                                <tr>
                                    <th>Element</th>
                                    <th>Type</th>
                                    <th>Source</th>
                                    <th>Playwright</th>
                                    <th>Selenium</th>
                                    <th>ID</th>
                                    <th>CSS Selector</th>
                                    <th>XPath</th>
                                </tr>
                            </thead>
                            <tbody>
                                {locators.map((loc, idx) => (
                                    <tr key={idx}>
                                        <td className="highlight">{loc.element}</td>
                                        <td>
                                            <span className="badge-type">{loc.type}</span>
                                        </td>
                                        <td>
                                            <span className={`badge-source ${loc.source?.toLowerCase() === 'ai' ? 'ai' : 'code'}`}>
                                                {loc.source || 'Code'}
                                            </span>
                                        </td>
                                        <td className="monospace code-cell">
                                            <div className="copy-wrapper highlight-playwright" onClick={() => handleCopy(loc.playwright, `${idx}-pw`)} title="Click to copy Playwright locator">
                                                {loc.playwright}
                                                {copiedIndex === `${idx}-pw` && <span className="copied-tooltip">Copied!</span>}
                                            </div>
                                        </td>
                                        <td className="monospace code-cell">
                                            <div className="copy-wrapper highlight-selenium" onClick={() => handleCopy(loc.selenium, `${idx}-sel`)} title="Click to copy Selenium locator">
                                                {loc.selenium}
                                                {copiedIndex === `${idx}-sel` && <span className="copied-tooltip">Copied!</span>}
                                            </div>
                                        </td>
                                        <td className="monospace">
                                            {loc.id ? (
                                                <div className="copy-wrapper" onClick={() => handleCopy(loc.id, `${idx}-id`)}>
                                                    {loc.id}
                                                    {copiedIndex === `${idx}-id` && <span className="copied-tooltip">Copied!</span>}
                                                </div>
                                            ) : <span className="text-muted">-</span>}
                                        </td>
                                        <td className="monospace">
                                            <div className="copy-wrapper" onClick={() => handleCopy(loc.css, `${idx}-css`)}>
                                                {loc.css}
                                                {copiedIndex === `${idx}-css` && <span className="copied-tooltip">Copied!</span>}
                                            </div>
                                        </td>
                                        <td className="monospace">
                                            <div className="copy-wrapper" onClick={() => handleCopy(loc.xpath, `${idx}-xpath`)}>
                                                {loc.xpath}
                                                {copiedIndex === `${idx}-xpath` && <span className="copied-tooltip">Copied!</span>}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            <style>{`
                .locator-generator { max-width: 1200px; margin: 0 auto; }
                .page-header { margin-bottom: 2rem; }
                .page-header h2 { font-size: 1.75rem; margin-bottom: 0.5rem; }
                .page-header p { color: var(--text-secondary); }

                .input-card {
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-md);
                    overflow: hidden;
                }

                .card-header {
                    padding: 0.75rem 1rem;
                    background: var(--bg-tertiary);
                    border-bottom: 1px solid var(--border-color);
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-weight: 500;
                    color: var(--text-secondary);
                }

                .html-input {
                    width: 100%;
                    background: var(--bg-primary);
                    color: var(--text-primary);
                    border: none;
                    padding: 1rem;
                    font-family: monospace;
                    font-size: 0.9rem;
                    resize: vertical;
                    min-height: 200px;
                }
                .html-input:focus { outline: none; }

                .url-input-wrapper {
                    padding: 1.5rem;
                }

                .url-input {
                    width: 100%;
                    padding: 1rem;
                    background: var(--bg-primary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-md);
                    color: var(--text-primary);
                    font-size: 1rem;
                }
                .url-input:focus {
                    outline: none;
                    border-color: var(--accent-primary);
                    box-shadow: 0 0 0 2px var(--accent-glow);
                }

                .hint-text {
                    margin-top: 0.5rem;
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                }
                .hint-text code {
                    background: var(--bg-tertiary);
                    padding: 2px 4px;
                    border-radius: 4px;
                    font-family: monospace;
                }

                .mode-tabs {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    margin-bottom: 0;
                }

                .tab-btn {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    background: var(--bg-secondary);
                    border: 1px solid transparent;
                    border-bottom: none;
                    color: var(--text-secondary);
                    padding: 0.75rem 1.25rem;
                    border-radius: var(--radius-md) var(--radius-md) 0 0;
                    cursor: pointer;
                    font-weight: 500;
                    transition: all 0.2s;
                }

                .tab-btn:hover {
                    color: var(--text-primary);
                    background: var(--bg-tertiary);
                }

                .tab-btn.active {
                    background: var(--bg-secondary);
                    color: var(--accent-primary);
                    border-color: var(--border-color);
                    border-bottom: 1px solid var(--bg-secondary);
                    margin-bottom: -1px;
                    position: relative;
                    z-index: 1;
                }

                .badge-beta {
                    font-size: 0.65rem;
                    background: var(--accent-primary);
                    color: white;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-weight: bold;
                    margin-left: 0.5rem;
                }

                .input-card {
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: 0 var(--radius-md) var(--radius-md) var(--radius-md); 
                    /* Top left sharp to attach to tabs */
                    overflow: hidden;
                }

                .cookie-section {
                    margin-top: 1.5rem;
                    border-top: 1px solid var(--border-color);
                    padding-top: 1rem;
                }

                .cookie-toggle {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    cursor: pointer;
                    font-size: 0.9rem;
                    color: var(--text-primary);
                    user-select: none;
                }
                
                .cookie-input-box {
                    margin-top: 1rem;
                }

                .cookie-help {
                    background: rgba(59, 130, 246, 0.1);
                    border: 1px solid rgba(59, 130, 246, 0.3);
                    color: #93c5fd;
                    padding: 0.75rem;
                    border-radius: var(--radius-md);
                    font-size: 0.85rem;
                    display: flex;
                    gap: 0.5rem;
                    align-items: flex-start;
                    margin-bottom: 0.75rem;
                }

                .cookie-textarea {
                    width: 100%;
                    background: var(--bg-primary);
                    color: var(--text-primary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-md);
                    padding: 0.75rem;
                    font-family: monospace;
                    font-size: 0.85rem;
                }
                .cookie-textarea:focus { outline: none; border-color: var(--accent-primary); }

                .interactive-section {
                    display: flex;
                    gap: 1.5rem;
                    margin: 1rem 0;
                    padding: 0.5rem 0;
                }

                .radio-label {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    cursor: pointer;
                    color: var(--text-primary);
                }

                .browser-modal {
                    margin-top: 1rem;
                    background: var(--bg-secondary);
                    border: 1px solid var(--accent-primary);
                    border-radius: var(--radius-md);
                    padding: 1.5rem;
                    text-align: center;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
                }

                .modal-steps {
                    text-align: left;
                    margin: 1rem 0;
                    background: var(--bg-tertiary);
                    padding: 1rem;
                    border-radius: var(--radius-md);
                    font-size: 0.9rem;
                    color: var(--text-secondary);
                }
                .modal-steps p { margin: 0.5rem 0; }

                .btn-success {
                    background: var(--success);
                    color: white;
                    border: none;
                    padding: 0.75rem 1.5rem;
                    border-radius: var(--radius-md);
                    cursor: pointer;
                    font-weight: 500;
                    transition: filter 0.2s;
                    display: block;
                    width: 100%;
                }
                .btn-success:hover { filter: brightness(1.1); }

                .error-banner {
                    margin-top: 1.5rem;
                    background: rgba(239, 68, 68, 0.1);
                    border: 1px solid var(--error);
                    color: #fca5a5;
                    padding: 1rem;
                    border-radius: var(--radius-md);
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                }

                .results-section { margin-top: 2rem; }
                .results-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1rem;
                }

                .export-actions { display: flex; gap: 0.5rem; }
                .btn-sm { padding: 0.5rem 0.75rem; font-size: 0.85rem; }

                .table-responsive {
                    background: var(--bg-secondary);
                    border-radius: var(--radius-md);
                    border: 1px solid var(--border-color);
                    overflow-x: auto;
                }

                table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
                th {
                    text-align: left;
                    padding: 1rem;
                    background: var(--bg-tertiary);
                    color: var(--text-secondary);
                    font-weight: 600;
                    white-space: nowrap;
                    border-bottom: 1px solid var(--border-color);
                }
                td {
                    padding: 0.75rem 1rem;
                    border-bottom: 1px solid var(--border-color);
                    color: var(--text-primary);
                    vertical-align: middle;
                }
                tr:last-child td { border-bottom: none; }

                .highlight { font-weight: 600; color: var(--accent-primary); }
                .badge-source { padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; margin-right: 0.5rem; }
                .badge-source.ai { background: rgba(139, 92, 246, 0.15); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.3); }
                .badge-source.code { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }

                .badge-type {
                    background: var(--bg-tertiary);
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                    text-transform: uppercase;
                }
                .monospace { font-family: monospace; font-size: 0.85rem; color: var(--text-muted); }
                .code-cell {
                    max-width: 200px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .code-cell:hover {
                    white-space: normal;
                    word-break: break-all;
                }
                .highlight-playwright {
                    color: #c084fc !important; /* soft purple */
                }
                .highlight-selenium {
                    color: #60a5fa !important; /* soft blue */
                }
                .text-muted { color: var(--text-secondary); opacity: 0.5; }

                .copy-wrapper {
                    cursor: pointer;
                    position: relative;
                    transition: color 0.2s;
                }
                .copy-wrapper:hover { color: var(--accent-secondary); }
                
                .copied-tooltip {
                    position: absolute;
                    top: -25px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: var(--success);
                    color: white;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 0.75rem;
                    pointer-events: none;
                }

                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { 100% { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
};

export default LocatorGenerator;
