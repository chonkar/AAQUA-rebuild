import React, { useState } from 'react';
import { generateLocators } from '../services/locatorGenerationService';
import { exportToJSON, exportToExcel } from '../utils/exportUtils';
import { Target, Search, Copy, Download, Code, Globe, AlertCircle, Loader2 } from 'lucide-react';

// BASE_URL-prefixed relative path. See src/services/testRunnerService.js for why.
// Hardcoded http://localhost:3001 worked in dev but 404'd in QA (browser bypasses the Vite proxy in prod).
const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

const LocatorGenerator = () => {
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
    const [isBrowserOpen, setIsBrowserOpen] = useState(false);

    // Alias useCookies to isInteractiveMode for the UI logic
    const isInteractiveMode = useCookies;

    const handleLaunchBrowser = async () => {
        setIsGenerating(true);
        setStatusText("Launching Browser...");
        setError(null);
        try {
            const response = await fetch(`${API_URL}/browser/launch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: urlInput })
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Launch failed: ${text}`);
            }
            setIsBrowserOpen(true);
        } catch (e) {
            setError(e.message);
        } finally {
            setIsGenerating(false);
        }
    };

    const handleCaptureAndGenerate = async () => {
        setIsGenerating(true);
        setStatusText("Capturing Session & Generating Locators...");
        // Keep modal open for multiple captures

        try {
            // 1. Capture HTML & Cookies
            const captureRes = await fetch(`${API_URL}/browser/capture`);
            if (!captureRes.ok) throw new Error("Failed to capture browser session");

            const { html, cookies } = await captureRes.json();

            // 2. Update state with captured data
            setCookieInput(JSON.stringify(cookies, null, 2));

            // 3. Generate Locators
            const data = await generateLocators(html);
            setLocators(data);

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
            setIsBrowserOpen(false);
        }
    };
    React.useEffect(() => {
        console.log("LocatorGenerator mounted");
    }, []);

    const handleGenerate = async () => {
        setIsGenerating(true);
        setError(null);
        setLocators(null);
        setStatusText('Initializing...');

        try {
            let contentToAnalyze = htmlInput;

            if (mode === 'url') {
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
                        body: JSON.stringify({ url: urlInput, cookies: useCookies ? cookies : [] })
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

                            <div className="cookie-section">
                                <label className="cookie-toggle">
                                    <input
                                        type="checkbox"
                                        checked={useCookies}
                                        onChange={(e) => setUseCookies(e.target.checked)}
                                    />
                                    <span>Use Session Cookies (Authenticated Scraping)</span>
                                </label>

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
                        {mode === 'url' && isInteractiveMode ? (
                            <button
                                className="btn btn-primary"
                                onClick={handleLaunchBrowser}
                                disabled={isGenerating || !urlInput.trim()}
                            >
                                {isGenerating ? (
                                    <>
                                        <Loader2 className="spin" size={18} />
                                        Launching Browser...
                                    </>
                                ) : (
                                    <>
                                        <Globe size={18} />
                                        Launch Login Browser
                                    </>
                                )}
                            </button>
                        ) : (
                            <button
                                className="btn btn-primary"
                                onClick={handleGenerate}
                                disabled={isGenerating || (mode === 'html' ? !htmlInput.trim() : !urlInput.trim())}
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

                {isBrowserOpen && (
                    <div className="browser-modal animate-fade-in">
                        <div className="modal-content">
                            <h3>Browser Session Active</h3>
                            <div className="modal-steps">
                                <p>1. Navigate to the desired page in the opened window.</p>
                                <p>2. Click <strong>"Capture Current Page"</strong> below.</p>
                                <p>3. Repeat for other pages as needed.</p>
                            </div>
                            <div className="modal-actions" style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                                <button
                                    className="btn btn-success"
                                    onClick={handleCaptureAndGenerate}
                                    style={{ flex: 1 }}
                                    disabled={isGenerating}
                                >
                                    {isGenerating ? <Loader2 className="spin" /> : "Capture Current Page"}
                                </button>
                                <button
                                    className="btn btn-secondary"
                                    onClick={handleCloseBrowser}
                                    disabled={isGenerating}
                                >
                                    Close Browser
                                </button>
                            </div>
                        </div>
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
