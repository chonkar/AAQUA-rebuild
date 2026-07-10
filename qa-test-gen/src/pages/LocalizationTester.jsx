import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from 'react-oidc-context';
import { Globe, Play, Search, AlertTriangle, CheckCircle, Loader2, AlertCircle } from 'lucide-react';
import { launchBrowser, capturePage, startLocalizationAnalysis, getLocalizationStatus } from '../services/localizationService';
import { useProject } from '../context/ProjectContext';
import { createApiClient } from '../utils/apiClient';
import JiraDefectButton from '../components/features/JiraDefectButton';
import UrlScopeWarning from '../components/common/UrlScopeWarning';

const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

// Heuristic scan phases — the backend runs synchronously with no progress
// stream. Phases below mirror the actual work: capture DOM via the browser
// endpoint, extract+chunk visible text, then loop over LLM analysis per
// chunk. Bar asymptotes at 90% until the API resolves.
const ANALYZE_PHASES = [
    { label: 'Capturing rendered DOM…',         ceiling: 20, durationMs: 2000 },
    { label: 'Extracting visible text…',        ceiling: 35, durationMs: 1500 },
    { label: 'Chunking for AI analysis…',       ceiling: 45, durationMs: 1500 },
    { label: 'AI translation review in progress…', ceiling: 90, durationMs: 18000 },
];

const LocalizationTester = () => {
    const { selectedProjectId, selectedProject } = useProject();
    const auth = useAuth();
    const api = createApiClient(() => auth.user?.access_token || '');
    const [url, setUrl] = useState('');
    const [targetLanguage, setTargetLanguage] = useState('Arabic');
    const [isBrowserActive, setIsBrowserActive] = useState(false);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [issues, setIssues] = useState([]);
    const [error, setError] = useState(null);
    const [chunkCount, setChunkCount] = useState(null);
    const [scannedUrl, setScannedUrl] = useState('');

    // Interactive Mode State
    const [browserType, setBrowserType] = useState('chromium');
    const [useCookies, setUseCookies] = useState(false);
    const [cookieInput, setCookieInput] = useState('');
    const [currentBrowserUrl, setCurrentBrowserUrl] = useState('');
    const [navUrlInput, setNavUrlInput] = useState('');
    const [isExtensionInstalled, setIsExtensionInstalled] = useState(false);

    // Heuristic progress state — same pattern used in AccessibilityScanner.
    const [analyzeProgress, setAnalyzeProgress] = useState(0);
    const [analyzePhaseLabel, setAnalyzePhaseLabel] = useState('');
    const [analyzeFailed, setAnalyzeFailed] = useState(false);
    const pollRef = useRef(null);

    // Per-issue JIRA logging state. Keys are `loc-${idx}` since localization
    // issues have no stable id — reset on every analyze run so badges don't
    // leak across scans.
    const [jiraState, setJiraState] = useState({});

    // Listeners for Chrome Extension connection & cookie responses
    useEffect(() => {
        const handleExtensionMessage = (e) => {
            if (!e.data || e.data.source !== 'aaqua-extension') return;

            if (e.data.type === 'AAQUA_EXTENSION_READY') {
                setIsExtensionInstalled(true);
            }

            if (e.data.type === 'AAQUA_SET_COOKIES') {
                if (e.data.cookies && e.data.cookies.length > 0) {
                    setCookieInput(JSON.stringify(e.data.cookies, null, 2));
                    setUseCookies(true);
                    setError(null);
                } else if (e.data.error) {
                    setError(`Cookie Bridge: ${e.data.error}`);
                } else {
                    setError("No active session cookies found in your browser for this domain. Please open the page in another tab and log in first.");
                }
            }
        };

        window.addEventListener('message', handleExtensionMessage);
        
        // Ping extension to see if it is already loaded
        window.postMessage({ source: 'aaqua-app', type: 'AAQUA_PING' }, '*');

        return () => {
            window.removeEventListener('message', handleExtensionMessage);
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    useEffect(() => {
        if (selectedProject?.target_url) {
            setUrl(selectedProject.target_url);
        }
    }, [selectedProject?.id, selectedProject?.target_url]);

    const languages = [
        'Arabic',
        'Dutch',
        'Spanish',
        'French',
        'German',
        'Japanese',
        'American English (en-US)',
        'British English (en-GB)',
    ];

    const handleLaunch = async () => {
        setError(null);
        setIsBrowserActive(false);
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

            await launchBrowser(url, browserType, cookies, selectedProjectId || null);
            setIsBrowserActive(true);
            setCurrentBrowserUrl(url);
        } catch (err) {
            setError(err.message || "Failed to launch browser. Ensure server is running.");
        }
    };

    const handleNavigateBrowser = async () => {
        setError(null);
        try {
            let target = navUrlInput.trim();
            if (target.startsWith('/')) {
                try {
                    const base = new URL(url);
                    target = `${base.protocol}//${base.host}${target}`;
                } catch (e) {
                    console.debug("Failed to resolve absolute path from base URL:", e);
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

    const handlePullCookies = () => {
        if (!url.trim()) {
            setError("Please enter a URL first to retrieve session cookies.");
            return;
        }
        window.postMessage({ source: 'aaqua-app', type: 'AAQUA_GET_COOKIES', url }, '*');
    };

    const handleAnalyze = async () => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        setIsAnalyzing(true);
        setError(null);
        setAnalyzeFailed(false);
        setAnalyzeProgress(0);
        setAnalyzePhaseLabel('Capturing page…');
        setIssues([]);          // clear previous run so new findings stream in fresh
        setChunkCount(null);
        setJiraState({});       // wipe per-issue JIRA badges from any previous run

        try {
            // 1. Capture HTML (and the actual page URL).
            const capture = await capturePage();
            setScannedUrl(capture?.url || url);
            if (capture?.url) {
                setCurrentBrowserUrl(capture.url);
            }

            const apiKey = import.meta.env.VITE_LLM_API_KEY;
            if (!apiKey) throw new Error("API Key missing");

            // 2. Start the async analysis job.
            setAnalyzePhaseLabel('Starting analysis…');
            const { jobId, totalChunks } = await startLocalizationAnalysis(capture.html, targetLanguage, apiKey, selectedProjectId);
            setChunkCount(totalChunks || 1);

            // 3. Poll for progress — issues stream into the panel as each chunk finishes.
            pollRef.current = setInterval(async () => {
                try {
                    const s = await getLocalizationStatus(jobId);
                    setIssues(s.issues || []);                       // incremental display
                    const found = (s.issues || []).length;
                    if (s.status === 'completed') {
                        clearInterval(pollRef.current); pollRef.current = null;
                        setAnalyzeProgress(100);
                        setAnalyzePhaseLabel(`Analysis complete — ${found} issue(s) found`);
                        setIsAnalyzing(false);
                    } else if (s.status === 'failed') {
                        clearInterval(pollRef.current); pollRef.current = null;
                        setError(s.error || 'Localization analysis failed.');
                        setAnalyzeFailed(true);
                        setAnalyzePhaseLabel('Analysis failed');
                        setIsAnalyzing(false);
                    } else {
                        const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 5;
                        setAnalyzeProgress(Math.min(99, pct));
                        setAnalyzePhaseLabel(`Analyzing chunk ${s.done}/${s.total} — ${found} issue(s) so far`);
                    }
                } catch (pollErr) {
                    clearInterval(pollRef.current); pollRef.current = null;
                    setError(pollErr.message);
                    setAnalyzeFailed(true);
                    setAnalyzePhaseLabel('Analysis failed');
                    setIsAnalyzing(false);
                }
            }, 2000);
        } catch (err) {
            setError(err.message);
            setAnalyzeFailed(true);
            setAnalyzePhaseLabel('Analysis failed');
            setIsAnalyzing(false);
        }
    };

    // Raise a single JIRA bug for a localization issue.
    const logJiraDefect = async (issue, issueKey) => {
        setJiraState(prev => ({ ...prev, [issueKey]: { status: 'logging' } }));
        try {
            const data = await api.post('/api/jira/localization-defect', {
                issue,
                projectName: selectedProject?.name || 'Untitled Project',
                scannedUrl,
                targetLanguage,
            });
            setJiraState(prev => ({
                ...prev,
                [issueKey]: { status: 'logged', key: data.key, url: data.url },
            }));
        } catch (err) {
            setJiraState(prev => ({
                ...prev,
                [issueKey]: { status: 'error', error: err.message || 'Failed to raise JIRA ticket' },
            }));
        }
    };

    return (
        <div className="localization-tester animate-fade-in">
            <div className="lc-header">
                <h2><Globe className="inline-icon" /> Localization Tester</h2>
                <p className="lc-subtitle">Detect English text leakage on localized pages.</p>
            </div>

            <div className="tester-container">
                <div className="control-panel">
                    <div className="form-group">
                        <label>Target URL</label>
                        <div className="input-with-button">
                            <input
                                type="text"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://example.com/ar"
                                className="form-input"
                            />
                            <button
                                onClick={handleLaunch}
                                disabled={!url || isBrowserActive}
                                className="btn btn-primary"
                            >
                                <Play size={16} /> Launch
                            </button>
                        </div>
                        <UrlScopeWarning url={url} />
                    </div>

                    <div className="browser-select-section" style={{ margin: '1rem 0', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.75rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                            <span>Browser Type:</span>
                            <select
                                value={browserType}
                                onChange={(e) => setBrowserType(e.target.value)}
                                disabled={isBrowserActive}
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

                    <div className="cookie-section" style={{ marginBottom: '1.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '0.75rem' }}>
                            <label className="cookie-toggle" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={useCookies}
                                    onChange={(e) => setUseCookies(e.target.checked)}
                                />
                                <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Use Session Cookies (Authenticated)</span>
                            </label>

                            {isExtensionInstalled ? (
                                <button
                                    type="button"
                                    onClick={handlePullCookies}
                                    disabled={!url.trim()}
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
                            <div className="cookie-input-box animate-fade-in" style={{ marginTop: '0.5rem' }}>
                                <div className="cookie-help" style={{ display: 'flex', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                                    <AlertCircle size={14} style={{ flexShrink: 0, marginTop: '2px' }} />
                                    <span>
                                        <strong>How to get cookies:</strong> Use EditThisCookie to export as JSON, or copy from DevTools (Application &gt; Cookies).
                                    </span>
                                </div>
                                <textarea
                                    className="cookie-textarea"
                                    placeholder='[{"name": "session_id", "value": "..."}]'
                                    value={cookieInput}
                                    onChange={(e) => setCookieInput(e.target.value)}
                                    rows={5}
                                    style={{
                                        width: '100%',
                                        padding: '0.5rem',
                                        background: 'var(--bg-primary)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 'var(--radius-md)',
                                        color: 'var(--text-primary)',
                                        fontFamily: 'monospace',
                                        fontSize: '0.85rem'
                                    }}
                                />
                            </div>
                        )}
                    </div>

                    <div className="form-group">
                        <label style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem', display: 'block' }}>Target Language</label>
                        <select
                            value={targetLanguage}
                            onChange={(e) => setTargetLanguage(e.target.value)}
                            className="form-select"
                            style={{
                                width: '100%',
                                padding: '0.8rem',
                                fontSize: '1rem',
                                border: '1px solid var(--border-color)',
                                borderRadius: 'var(--radius-md)',
                                backgroundColor: 'var(--bg-primary)',
                                height: 'auto',
                                cursor: 'pointer',
                                color: '#2563eb', // Blue font
                                fontWeight: 500
                            }}
                        >
                            {languages.map(lang => (
                                <option key={lang} value={lang}>{lang}</option>
                            ))}
                        </select>
                    </div>

                    <div className="action-area">
                        <button
                            onClick={handleAnalyze}
                            disabled={!isBrowserActive || isAnalyzing}
                            className="btn full-width"
                            style={{ background: '#2563eb', color: '#fff', border: 'none' }}
                        >
                            {isAnalyzing ? <Loader2 className="spin" /> : <Search size={18} />}
                            {isAnalyzing ? "Analyzing..." : "Analyze Current Page"}
                        </button>
                        <p className="hint">
                            Navigate manually in the opened browser window, then click Analyze.
                        </p>
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
                                    {currentBrowserUrl || url}
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
                                        style={{
                                            flex: 1,
                                            padding: '0.4rem 0.6rem',
                                            background: 'var(--bg-primary)',
                                            border: '1px solid var(--border-color)',
                                            borderRadius: 'var(--radius-md)',
                                            color: 'var(--text-primary)',
                                            fontSize: '0.85rem'
                                        }}
                                    />
                                    <button
                                        onClick={handleNavigateBrowser}
                                        className="btn btn-secondary btn-sm"
                                        style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                                    >
                                        Go
                                    </button>
                                </div>
                            </div>

                            <button
                                onClick={handleCloseBrowser}
                                className="btn btn-danger btn-sm"
                                style={{ width: '100%', padding: '0.5rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: '600' }}
                            >
                                Close Browser Session
                            </button>
                        </div>
                    )}

                    {(isAnalyzing || analyzeProgress > 0) && (
                        <div className="lc-progress" role="progressbar" aria-valuenow={analyzeProgress} aria-valuemin={0} aria-valuemax={100} aria-label="Localization analysis progress">
                            <div className="lc-progress-header">
                                <span className="lc-progress-label">{analyzePhaseLabel}</span>
                                <span className="lc-progress-pct">{analyzeProgress}%</span>
                            </div>
                            <div className="lc-progress-track">
                                <div
                                    className={`lc-progress-fill ${analyzeFailed ? 'failed' : ''} ${!isAnalyzing && !analyzeFailed ? 'done' : ''}`}
                                    style={{ width: `${analyzeProgress}%` }}
                                />
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="error-banner">
                            <AlertTriangle size={18} /> {error}
                        </div>
                    )}
                </div>

                <div className="results-panel">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                        <h3 style={{ margin: 0 }}>Analysis Results</h3>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        {chunkCount > 1 && (
                            <span style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa', padding: '0.25rem 0.75rem', borderRadius: '999px', fontSize: '0.8rem' }}>
                                {chunkCount} chunks scanned
                            </span>
                        )}
                        {issues.length > 0 && (
                            <span style={{
                                background: '#3b82f6',
                                color: 'white',
                                padding: '0.25rem 0.75rem',
                                borderRadius: '999px',
                                fontSize: '0.875rem',
                                fontWeight: 600
                            }}>
                                Total Findings: {issues.length}
                            </span>
                        )}
                        </div>
                    </div>
                    {issues.length === 0 && !isAnalyzing ? (
                        <div className="empty-state">
                            <CheckCircle size={48} className="text-muted" />
                            <p>No issues detected yet. Start analysis.</p>
                        </div>
                    ) : (
                        <div className="issues-list">
                            {issues.map((issue, idx) => {
                                const issueKey = `loc-${idx}`;
                                return (
                                    <div key={issueKey} className="issue-card">
                                        <div className="issue-header">
                                            <span className="badge-warning">LEAK</span>
                                            <span className="context">{issue.context}</span>
                                            <div style={{ marginLeft: 'auto' }}>
                                                <JiraDefectButton
                                                    state={jiraState[issueKey]}
                                                    onClick={() => logJiraDefect(issue, issueKey)}
                                                />
                                            </div>
                                        </div>
                                        <div className="issue-body">
                                            <div className="original">"{issue.original}"</div>
                                            <div className="arrow">→</div>
                                            <div className="suggestion">{issue.suggestion}</div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            <style>{`
                .localization-tester { max-width: 1000px; margin: 0 auto; }
                .inline-icon { display: inline; vertical-align: middle; margin-right: 0.5rem; }

                /* Header — matches Test Runner format */
                .lc-header { margin-bottom: 2rem; }
                .lc-header h2 {
                    font-size: 2rem;
                    margin-bottom: 0.5rem;
                    background: linear-gradient(to right, var(--accent-primary), var(--accent-secondary));
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                }
                .lc-subtitle { color: var(--text-secondary); }

                .tester-container {
                    display: grid;
                    grid-template-columns: 1fr 1.5fr;
                    gap: 2rem;
                }

                .control-panel, .results-panel {
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-lg);
                    padding: 1.5rem;
                }

                .input-with-button {
                    display: flex;
                    gap: 0.5rem;
                }
                
                .action-area {
                    margin-top: 2rem;
                    text-align: center;
                }

                .hint {
                    font-size: 0.8rem;
                    color: var(--text-muted);
                    margin-top: 0.5rem;
                }

                .issues-list {
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                    max-height: 500px;
                    overflow-y: auto;
                }

                .issue-card {
                    background: var(--bg-tertiary);
                    padding: 1rem;
                    border-radius: var(--radius-md);
                    border-left: 4px solid #f59e0b;
                }

                .issue-header {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 0.5rem;
                    font-size: 0.85rem;
                }
                
                .badge-warning {
                    background: rgba(245, 158, 11, 0.2);
                    color: #f59e0b;
                    padding: 0.1rem 0.4rem;
                    border-radius: 4px;
                    font-weight: bold;
                }
                
                .context {
                    color: var(--text-muted);
                    font-family: monospace;
                }

                .issue-body {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-size: 0.95rem;
                }
                
                .original { color: #f87171; font-weight: 500; }
                .suggestion { color: #4ade80; }
                .arrow { color: var(--text-muted); }

                .empty-state {
                    text-align: center;
                    padding: 3rem;
                    color: var(--text-muted);
                }
                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { 100% { transform: rotate(360deg); } }

                /* Analysis progress bar — heuristic, eases to 90% then snaps to 100% */
                .lc-progress {
                    margin-top: 1rem;
                    padding: 12px 14px;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                }
                .lc-progress-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 8px;
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                }
                .lc-progress-label { font-weight: 600; }
                .lc-progress-pct {
                    font-variant-numeric: tabular-nums;
                    font-weight: 700;
                    color: var(--text-primary);
                }
                .lc-progress-track {
                    width: 100%;
                    height: 8px;
                    background: var(--bg-primary);
                    border-radius: 99px;
                    overflow: hidden;
                }
                .lc-progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #2563eb, #3b82f6);
                    border-radius: 99px;
                    transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                }
                .lc-progress-fill.done {
                    background: linear-gradient(90deg, #16a34a, #22c55e);
                }
                .lc-progress-fill.failed {
                    background: linear-gradient(90deg, #b91c1c, #ef4444);
                }

                /* JIRA defect button — shared visual language with AccessibilityScanner */
                .jira-defect-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 10px;
                    font-size: 0.75rem;
                    font-weight: 600;
                    border-radius: 6px;
                    background: rgba(37, 99, 235, 0.08);
                    border: 1px solid rgba(37, 99, 235, 0.3);
                    color: #2563eb;
                    cursor: pointer;
                    text-decoration: none;
                    transition: all 0.2s ease;
                    white-space: nowrap;
                }
                .jira-defect-btn:hover:not(:disabled) {
                    background: rgba(37, 99, 235, 0.15);
                    border-color: #2563eb;
                }
                .jira-defect-btn:disabled {
                    cursor: not-allowed;
                    opacity: 0.7;
                }
                .jira-defect-btn--logged {
                    background: rgba(34, 197, 94, 0.1);
                    border-color: rgba(34, 197, 94, 0.4);
                    color: #16a34a;
                }
                .jira-defect-btn--logged:hover {
                    background: rgba(34, 197, 94, 0.18);
                    border-color: #16a34a;
                }
                .jira-defect-btn--error {
                    background: rgba(239, 68, 68, 0.08);
                    border-color: rgba(239, 68, 68, 0.4);
                    color: #dc2626;
                    max-width: 280px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
            `}</style>
        </div>
    );
};

export default LocalizationTester;
