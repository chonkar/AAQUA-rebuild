import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from 'react-oidc-context';
import { Play, Search, AlertTriangle, CheckCircle, ExternalLink, Loader2, User, Sparkles, BrainCircuit, XCircle, Globe, AlertCircle } from 'lucide-react';
import { launchBrowser } from '../services/accessibilityService';
import { useProject } from '../context/ProjectContext';
import { createApiClient } from '../utils/apiClient';
import JiraDefectButton from '../components/features/JiraDefectButton';
import UrlScopeWarning from '../components/common/UrlScopeWarning';

// Heuristic scan phases. The backend runs synchronously with no progress
// stream, so we model the work it actually does (axe injection → rules →
// optional AI audit) and asymptote at the phase ceiling. Real completion
// snaps the bar to 100%; failure paints it red.
const SCAN_PHASES_WITH_AI = [
    { label: 'Initializing browser context…',  ceiling: 12, durationMs: 1500 },
    { label: 'Injecting axe-core engine…',     ceiling: 25, durationMs: 2000 },
    { label: 'Running WCAG 2.2 AA rules…',     ceiling: 50, durationMs: 6000 },
    { label: 'Capturing DOM snapshot…',        ceiling: 60, durationMs: 1500 },
    { label: 'AI expert audit in progress…',   ceiling: 90, durationMs: 22000 },
];
const SCAN_PHASES_NO_AI = [
    { label: 'Initializing browser context…',  ceiling: 20, durationMs: 1500 },
    { label: 'Injecting axe-core engine…',     ceiling: 40, durationMs: 2000 },
    { label: 'Running WCAG 2.2 AA rules…',     ceiling: 80, durationMs: 5000 },
    { label: 'Finalizing report…',             ceiling: 90, durationMs: 1500 },
];

// Same BASE_URL pattern as the service layer — see src/services/testRunnerService.js for the rationale.
const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

const AccessibilityScanner = () => {
    const { selectedProjectId, selectedProject } = useProject();
    const auth = useAuth();
    const api = createApiClient(() => auth.user?.access_token || '');
    const [url, setUrl] = useState('');
    const [isBrowserActive, setIsBrowserActive] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [includeAiAudit, setIncludeAiAudit] = useState(false);
    const [results, setResults] = useState(null);
    const [scanHistory, setScanHistory] = useState([]);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('violations');
    const [scanProgress, setScanProgress] = useState(0);
    const [scanPhaseLabel, setScanPhaseLabel] = useState('');
    const [scanFailed, setScanFailed] = useState(false);

    // Interactive Mode State
    const [browserType, setBrowserType] = useState('chromium');
    const [useCookies, setUseCookies] = useState(false);
    const [cookieInput, setCookieInput] = useState('');
    const [currentBrowserUrl, setCurrentBrowserUrl] = useState('');
    const [navUrlInput, setNavUrlInput] = useState('');
    const [isExtensionInstalled, setIsExtensionInstalled] = useState(false);

    // Per-issue JIRA logging state. Keys are `${source}-${id}` (e.g. axe-color-contrast, ai-3).
    // Values: { status: 'idle'|'logging'|'logged'|'error', key?, url?, error? }
    const [jiraState, setJiraState] = useState({});
    const scanStartRef = useRef(0);
    const scanTickRef = useRef(null);

    // Drive the heuristic progress bar while a scan is in flight. Phases
    // advance based on elapsed wall time against their `durationMs`, and
    // the bar eases toward each phase ceiling rather than jumping — so the
    // user always sees motion. Capped at 90% until the API resolves; the
    // success/error handler sets the final value.
    useEffect(() => {
        if (!isScanning) {
            if (scanTickRef.current) {
                clearInterval(scanTickRef.current);
                scanTickRef.current = null;
            }
            return;
        }

        const phases = includeAiAudit ? SCAN_PHASES_WITH_AI : SCAN_PHASES_NO_AI;
        scanStartRef.current = Date.now();
        setScanProgress(0);
        setScanPhaseLabel(phases[0].label);

        scanTickRef.current = setInterval(() => {
            const elapsed = Date.now() - scanStartRef.current;
            let cumulative = 0;
            let phaseStart = 0;
            for (const phase of phases) {
                const phaseEnd = phaseStart + phase.durationMs;
                if (elapsed < phaseEnd) {
                    const phaseElapsed = elapsed - phaseStart;
                    const ratio = phaseElapsed / phase.durationMs;
                    // Ease-out so the bar slows as it approaches each ceiling.
                    const eased = 1 - Math.pow(1 - ratio, 2);
                    setScanPhaseLabel(phase.label);
                    setScanProgress(Math.min(90, Math.round(cumulative + eased * (phase.ceiling - cumulative))));
                    return;
                }
                cumulative = phase.ceiling;
                phaseStart = phaseEnd;
            }
            // All phases elapsed and still no response — pin to 90% with
            // the last phase's label so the user knows we're still waiting
            // on the server, not stuck.
            setScanPhaseLabel(phases[phases.length - 1].label);
            setScanProgress(90);
        }, 200);

        return () => {
            if (scanTickRef.current) {
                clearInterval(scanTickRef.current);
                scanTickRef.current = null;
            }
        };
    }, [isScanning, includeAiAudit]);

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
        };
    }, []);

    useEffect(() => {
        if (selectedProject?.target_url) {
            setUrl(selectedProject.target_url);
        }
    }, [selectedProject?.id, selectedProject?.target_url]);

    // Raise a single JIRA bug for an a11y issue. Source is 'axe' or 'ai' —
    // the backend normalizes both shapes into a single Bug ticket.
    const logJiraDefect = async (issue, source, issueKey) => {
        setJiraState(prev => ({ ...prev, [issueKey]: { status: 'logging' } }));
        try {
            const payload = {
                issue: { ...issue, source },
                projectName: selectedProject?.name || 'Untitled Project',
                scannedUrl: results?.scannedUrl,
            };
            const data = await api.post('/api/jira/accessibility-defect', payload);
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

    const handleScan = async () => {
        try {
            setIsScanning(true);
            setError(null);
            setScanFailed(false);
            setScanProgress(0);
            setJiraState({}); // wipe per-issue JIRA badges from any previous scan
            const response = await fetch(`${API_URL}/analyze-accessibility`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': import.meta.env.VITE_LLM_API_KEY // Send key for AI audit
                },
                body: JSON.stringify({
                    projectId: selectedProjectId,
                    includeAiAudit: includeAiAudit
                })
            });

            if (!response.ok) {
                if (response.status === 400) {
                    // Session lost (server restart?)
                    setIsBrowserActive(false);
                    throw new Error("Browser session lost (Server restarted?). Please Click 'Launch' again.");
                }
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || `Scan failed (Status: ${response.status})`);
            }

            const data = await response.json();
            console.log("Scan Data:", data);

            // Add to history
            const newHistoryItem = {
                url: data.scannedUrl,
                timestamp: new Date().toLocaleTimeString(),
                violationCount: data.violations.length,
                passCount: data.passes.length
            };

            setScanHistory(prev => [newHistoryItem, ...prev]);
            setResults(data);
            setScanProgress(100);
            setScanPhaseLabel('Scan complete');
        } catch (err) {
            setError(err.message);
            setScanFailed(true);
            setScanPhaseLabel('Scan failed');
        } finally {
            setIsScanning(false);
        }
    };

    const getImpactColor = (impact) => {
        switch (impact) {
            case 'critical': return 'text-red-600 bg-red-100 border-red-200';
            case 'serious': return 'text-orange-600 bg-orange-100 border-orange-200';
            case 'moderate': return 'text-yellow-600 bg-yellow-100 border-yellow-200';
            case 'minor': return 'text-blue-600 bg-blue-100 border-blue-200';
            default: return 'text-gray-600 bg-gray-100';
        }
    };

    // Release verdict derived from ACTUAL findings, not solely the AI string.
    // Previously this was `aiAudit?.releasability === 'Ready'`, which defaulted to
    // "NOT READY" whenever the AI audit was off/failed — contradicting a clean
    // (zero-violation) scan. Now: ready when there are no critical/serious
    // blockers (axe or AI), unless the AI audit explicitly flags "Not Ready".
    const releaseReady = (() => {
        if (!results) return false;
        const isBlocker = (sev) => ['critical', 'serious'].includes(String(sev || '').toLowerCase());
        const axeBlockers = (results.violations || []).filter(v => isBlocker(v.impact)).length;
        const aiBlockers = (results.aiAudit?.issues || []).filter(i => isBlocker(i.severity)).length;
        return axeBlockers + aiBlockers === 0 && results.aiAudit?.releasability !== 'Not Ready';
    })();

    return (
        <div className="accessibility-scanner animate-fade-in">
            <div className="ac-header">
                <h2><User className="inline-icon" /> Hybrid Accessibility Scanner (WCAG 2.2)</h2>
                <p className="ac-subtitle">Detect violations using Axe-core automation + AI Expert Audit.</p>
            </div>

            <div className="scanner-container">
                <div className="control-panel">
                    <div className="form-group">
                        <label>Target URL</label>
                        <div className="input-with-button">
                            <input
                                type="text"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://example.com"
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

                    <div className="form-group" style={{ marginTop: '1rem', display: 'flex', alignItems: 'center' }}>
                        <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            <input
                                type="checkbox"
                                checked={includeAiAudit}
                                onChange={(e) => setIncludeAiAudit(e.target.checked)}
                                style={{ cursor: 'pointer', width: 'auto', margin: 0 }}
                            />
                            <span>Enable AI WCAG Expert Audit</span>
                        </label>
                    </div>

                    <div className="action-area">
                        <button
                            onClick={handleScan}
                            disabled={!isBrowserActive || isScanning}
                            className="btn full-width"
                            style={{ background: '#2563eb', color: '#fff', border: 'none' }}
                        >
                            {isScanning ? <Loader2 className="spin" /> : <Search size={18} />}
                            {isScanning ? "Scanning..." : "Scan Page"}
                        </button>
                        <p className="hint">
                            Navigate manually in the opened browser window, then click Scan Page.
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

                    {(isScanning || scanProgress > 0) && (
                        <div className="ac-progress" role="progressbar" aria-valuenow={scanProgress} aria-valuemin={0} aria-valuemax={100} aria-label="Accessibility scan progress">
                            <div className="ac-progress-header">
                                <span className="ac-progress-label">{scanPhaseLabel}</span>
                                <span className="ac-progress-pct">{scanProgress}%</span>
                            </div>
                            <div className="ac-progress-track">
                                <div
                                    className={`ac-progress-fill ${scanFailed ? 'failed' : ''} ${!isScanning && !scanFailed ? 'done' : ''}`}
                                    style={{ width: `${scanProgress}%` }}
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
                        <div>
                            <h3>Scan Results</h3>
                            {results?.scannedUrl && <span className="scanned-url">Page: {results.scannedUrl}</span>}
                        </div>
                    </div>

                    <div className="tabs">
                        <button
                            className={`tab-btn ${activeTab === 'violations' ? 'active' : ''}`}
                            onClick={() => setActiveTab('violations')}
                        >
                            Violations {results && <span className="tab-count badge-error">
                                {results.violations.length + (results.aiAudit?.issues?.length || 0)}
                            </span>}
                        </button>
                        <button
                            className={`tab-btn ${activeTab === 'passes' ? 'active' : ''}`}
                            onClick={() => setActiveTab('passes')}
                        >
                            Passed Checks {results && <span className="tab-count badge-success">{results.passes.length}</span>}
                        </button>
                        <button
                            className={`tab-btn ${activeTab === 'report' ? 'active' : ''}`}
                            onClick={() => setActiveTab('report')}
                        >
                            Report <span className="tab-count" style={{ background: '#d1fae5', color: '#065f46' }}>{results?.aiAudit?.summary?.overallRisk ? 'Ready' : 'N/A'}</span>
                        </button>
                        <button
                            className={`tab-btn ${activeTab === 'ai' ? 'active' : ''}`}
                            onClick={() => setActiveTab('ai')}
                        >
                            <Sparkles size={16} className={activeTab === 'ai' ? 'text-accent' : ''} />
                            AI Audit <span className="tab-count" style={{ background: 'var(--accent-glow)', color: 'var(--accent-primary)' }}>{results?.aiAudit?.issues?.length || 0}</span>
                        </button>
                        <button
                            className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
                            onClick={() => setActiveTab('history')}
                        >
                            History <span className="tab-count" style={{ background: '#e5e7eb', color: '#374151' }}>{scanHistory.length}</span>
                        </button>
                    </div>

                    {!results && !isScanning && scanHistory.length === 0 && (
                        <div className="empty-state">
                            <CheckCircle size={48} className="text-muted" />
                            <p>Launch a page and run a scan to see results.</p>
                        </div>
                    )}

                    {activeTab === 'history' && (
                        <div className="history-list">
                            {scanHistory.length === 0 ? (
                                <p className="text-muted">No scans performed in this session yet.</p>
                            ) : (
                                scanHistory.map((item, idx) => (
                                    <div key={idx} className="history-item">
                                        <div className="history-url">{item.url}</div>
                                        <div className="history-meta">
                                            <span>{item.timestamp}</span>
                                            <span className="badge badge-error">{item.violationCount} Issues</span>
                                            <span className="badge badge-success">{item.passCount} Passed</span>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    )}

                    {/* --- REPORT TAB --- */}
                    {activeTab === 'report' && results && (
                        <div className="report-dashboard" style={{ color: '#000000', fontFamily: 'sans-serif' }}>
                            {/* 1. Execution Summary */}
                            <div className="report-header-card" style={{ color: '#000000' }}>
                                <div className="report-title-row">
                                    <h2 style={{ color: '#1e293b' }}>WCAG 2.2 AA Compliance Report</h2>
                                    <div className={`release-badge ${releaseReady ? 'badge-success' : 'badge-error'}`}>
                                        {releaseReady ? '✅ READY FOR RELEASE' : '❌ NOT READY FOR RELEASE'}
                                    </div>
                                </div>
                                <div className="report-meta" style={{ color: '#475569' }}>
                                    <span><strong>URL:</strong> {results.scannedUrl}</span>
                                    <span><strong>Date:</strong> {new Date().toLocaleDateString()}</span>
                                    <span><strong>Risk Level:</strong> <span className={`risk-text ${results.aiAudit?.summary?.overallRisk?.toLowerCase()}`}>{results.aiAudit?.summary?.overallRisk || 'Unknown'}</span></span>
                                </div>
                            </div>

                            <div className="report-grid">
                                {/* 2. Compliance Snapshot */}
                                <div className="report-card snapshot-card">
                                    <h3 style={{ color: '#1e293b' }}>Compliance Snapshot</h3>
                                    <table className="snapshot-table">
                                        <thead><tr><th style={{ color: '#475569' }}>Principle</th><th style={{ color: '#475569' }}>Status</th></tr></thead>
                                        <tbody>
                                            {results.aiAudit?.complianceSnapshot && Object.entries(results.aiAudit.complianceSnapshot).map(([key, status]) => (
                                                <tr key={key}>
                                                    <td className="capitalize" style={{ color: '#334155' }}>{key}</td>
                                                    <td className={`snapshot-status ${status.toLowerCase()}`}>
                                                        {status === 'Pass' && <CheckCircle size={16} />}
                                                        {status === 'Fail' && <XCircle size={16} />}
                                                        {status === 'Partial' && <AlertTriangle size={16} />}
                                                        {status}
                                                    </td>
                                                </tr>
                                            ))}
                                            {!results.aiAudit?.complianceSnapshot && <tr><td colSpan="2" style={{ color: '#64748b' }}>AI Data Missing</td></tr>}
                                        </tbody>
                                    </table>
                                </div>

                                {/* 4. Stats */}
                                <div className="report-card stats-card">
                                    <h3 style={{ color: '#1e293b' }}>Coverage Stats</h3>
                                    <div className="stats-row">
                                        <div className="stat-item">
                                            <span className="stat-value" style={{ color: '#4f46e5' }}>{results.violations.length}</span>
                                            <span className="stat-label">Automated (Axe)</span>
                                        </div>
                                        <div className="stat-item">
                                            <span className="stat-value" style={{ color: '#8b5cf6' }}>{results.aiAudit?.issues?.length || 0}</span>
                                            <span className="stat-label">AI Detected</span>
                                        </div>
                                    </div>
                                    <div className="affected-users-list">
                                        <h4>Top Impacted Groups</h4>
                                        <ul style={{ color: '#334155' }}>
                                            {/* Deduplicate users */}
                                            {[...new Set((results.aiAudit?.issues || []).flatMap(i => i.affectedUsers))].slice(0, 4).map((u, i) => (
                                                <li key={i}>{u}</li>
                                            ))}
                                        </ul>
                                    </div>
                                </div>
                            </div>

                            {/* 3. Blocking Issues */}
                            {/* 3. Failing Issues (All Severities) */}
                            <div className="report-card blockers-card">
                                <h3 style={{ color: '#1e293b' }}>⚠️ Detected Violations (Failed Checks)</h3>
                                <ul className="blockers-list">
                                    {/* Axe Violations (All) */}
                                    {results.violations.map((v, i) => (
                                        <li key={`axe-${i}`} className="blocker-item" style={{ color: '#881337', backgroundColor: '#fff1f2' }}>
                                            <span className="source-tag axe">Auto</span>
                                            <span className="violation-impact" style={{ color: '#be123c', fontWeight: 'bold', marginRight: '5px' }}>
                                                [{v.impact ? v.impact.toUpperCase() : 'ISSUE'}]
                                            </span>
                                            <strong>{v.id}:</strong> {v.description}
                                        </li>
                                    ))}
                                    {/* AI Violations (All) */}
                                    {results.aiAudit?.issues?.map((i, idx) => (
                                        <li key={`ai-${idx}`} className="blocker-item" style={{ color: '#881337', backgroundColor: '#fff1f2' }}>
                                            <span className="source-tag ai">AI</span>
                                            <span className="violation-impact" style={{ color: '#be123c', fontWeight: 'bold', marginRight: '5px' }}>
                                                [{i.severity ? i.severity.toUpperCase() : 'ISSUE'}]
                                            </span>
                                            <strong>{i.wcag}:</strong> {i.issue}
                                        </li>
                                    ))}
                                    {/* Empty state */}
                                    {results.violations.length === 0 &&
                                        (!results.aiAudit?.issues || results.aiAudit.issues.length === 0) && (
                                            <li className="text-success" style={{ color: 'green' }}>✅ No accessibility violations found.</li>
                                        )}
                                </ul>
                            </div>

                            {/* 6. Recommendation */}
                            <div className="report-card recommendation-card">
                                <h3 style={{ color: '#1e293b' }}>💡 Final Recommendation</h3>
                                <p className="recommendation-text" style={{ color: '#1e3a8a' }}>
                                    {results.aiAudit?.finalRecommendation || "No recommendation generated."}
                                </p>
                            </div>
                        </div>
                    )}

                    {activeTab === 'report' && !results && (
                        <div className="empty-state" style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
                            <AlertTriangle size={48} className="text-muted" style={{ marginBottom: '1rem' }} />
                            <p>No report data available.</p>
                            <p style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>Please launch a page and run a scan first to generate a report.</p>
                        </div>
                    )}

                    {activeTab === 'violations' && results && (
                        <>
                            {results.violations.length === 0 && (!results.aiAudit?.issues || results.aiAudit.issues.length === 0) && (
                                <div className="success-state">
                                    <CheckCircle size={48} className="text-success" />
                                    <p>No violations found!</p>
                                </div>
                            )}

                            {/* Axe Violations */}
                            {results.violations.map((violation, idx) => {
                                const issueKey = `axe-${violation.id || idx}`;
                                return (
                                    <div key={issueKey} className={`violation-card ${getImpactColor(violation.impact)}`}>
                                        <div className="violation-header">
                                            <span className="violation-impact">{violation.impact ? violation.impact.toUpperCase() : 'UNKNOWN'}</span>
                                            <span className="violation-id">{violation.id}</span>
                                            {violation.helpUrl && (
                                                <a href={violation.helpUrl} target="_blank" rel="noopener noreferrer" className="help-link">
                                                    <ExternalLink size={14} /> WCAG Help
                                                </a>
                                            )}
                                            <div style={{ marginLeft: 'auto' }}>
                                                <JiraDefectButton
                                                    state={jiraState[issueKey]}
                                                    onClick={() => logJiraDefect(violation, 'axe', issueKey)}
                                                />
                                            </div>
                                        </div>
                                        <p className="violation-desc">{violation.description}</p>
                                        <p className="violation-help">{violation.help}</p>

                                        <div className="violation-nodes">
                                            {violation.nodes && violation.nodes.map((node, nIdx) => (
                                                <code key={nIdx} className="node-selector">{node.target && node.target.join(' ')}</code>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}

                            {/* AI Violations Merged Here */}
                            {results.aiAudit && results.aiAudit.issues && results.aiAudit.issues.length > 0 && (
                                <div className="ai-section-divider">
                                    <h3><Sparkles size={18} className="text-accent" /> AI Expert Analysis</h3>
                                    <p>Issues detected by AI, passed automated checks but require attention.</p>

                                    <div className="ai-issues-list">
                                        {results.aiAudit.issues.map((issue, idx) => {
                                            const issueKey = `ai-${idx}`;
                                            return (
                                                <div key={issueKey} className={`ai-issue-card ${issue.severity.toLowerCase()}`}>
                                                    <div className="issue-header">
                                                        <span className={`severity-badge ${issue.severity.toLowerCase()}`}>{issue.severity}</span>
                                                        <span className="wcag-ref">{issue.wcag}</span>
                                                        <div className="affected-users">
                                                            {issue.affectedUsers.map((u, i) => <span key={i} className="user-tag">{u}</span>)}
                                                        </div>
                                                        <div style={{ marginLeft: 'auto' }}>
                                                            <JiraDefectButton
                                                                state={jiraState[issueKey]}
                                                                onClick={() => logJiraDefect(issue, 'ai', issueKey)}
                                                            />
                                                        </div>
                                                    </div>
                                                    <h4 className="issue-title">{issue.issue}</h4>

                                                    <div className="issue-details">
                                                        <p className="detail-row">
                                                            <strong>Why it matters:</strong> {issue.whyItMatters}
                                                        </p>
                                                        <div className="fix-box">
                                                            <strong>💡 Recommended Fix:</strong>
                                                            <code>{issue.recommendedFix}</code>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {activeTab === 'ai' && results && (
                        <div className="ai-results animate-fade-in">
                            {!results.aiAudit ? (
                                <div className="empty-state">
                                    <p>AI Audit data not available. Ensure API Key is set.</p>
                                </div>
                            ) : results.aiAudit.error ? (
                                <div className="error-banner">{results.aiAudit.error}</div>
                            ) : (
                                <>
                                    <div className="ai-summary-card">
                                        <div className="risk-level">
                                            <span>Overall Risk:</span>
                                            <span className={`risk-badge ${results.aiAudit.summary.overallRisk?.toLowerCase()}`}>
                                                {results.aiAudit.summary.overallRisk}
                                            </span>
                                        </div>
                                        <div className="risk-metrics">
                                            <div className="metric">
                                                <span className="count critical">{results.aiAudit.summary.criticalIssues}</span>
                                                <span className="label">Critical</span>
                                            </div>
                                            <div className="metric">
                                                <span className="count serious">{results.aiAudit.summary.seriousIssues}</span>
                                                <span className="label">Serious</span>
                                            </div>
                                            <div className="metric">
                                                <span className="count moderate">{results.aiAudit.summary.moderateIssues}</span>
                                                <span className="label">Moderate</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="ai-issues-list">
                                        {results.aiAudit.issues.map((issue, idx) => {
                                            const issueKey = `ai-${idx}`;
                                            return (
                                                <div key={issueKey} className={`ai-issue-card ${issue.severity.toLowerCase()}`}>
                                                    <div className="issue-header">
                                                        <span className={`severity-badge ${issue.severity.toLowerCase()}`}>{issue.severity}</span>
                                                        <span className="wcag-ref">{issue.wcag}</span>
                                                        <div className="affected-users">
                                                            {issue.affectedUsers.map((u, i) => <span key={i} className="user-tag">{u}</span>)}
                                                        </div>
                                                        <div style={{ marginLeft: 'auto' }}>
                                                            <JiraDefectButton
                                                                state={jiraState[issueKey]}
                                                                onClick={() => logJiraDefect(issue, 'ai', issueKey)}
                                                            />
                                                        </div>
                                                    </div>
                                                    <h4 className="issue-title">{issue.issue}</h4>

                                                    <div className="issue-details">
                                                        <p className="detail-row">
                                                            <strong>Why it matters:</strong> {issue.whyItMatters}
                                                        </p>
                                                        <div className="fix-box">
                                                            <strong>💡 Recommended Fix:</strong>
                                                            <code>{issue.recommendedFix}</code>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    {results.aiAudit.areasReviewed && (
                                        <div className="areas-reviewed">
                                            <h4>Areas Reviewed by AI:</h4>
                                            <div className="area-tags">
                                                {results.aiAudit.areasReviewed.map((area, idx) => (
                                                    <span key={idx} className="area-tag"><BrainCircuit size={12} /> {area}</span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    )}

                    {activeTab === 'passes' && results && Array.isArray(results.passes) && (
                        <>
                            {results.passes.map((pass, idx) => (
                                <div key={idx} className="violation-card pass-card">
                                    <div className="violation-header">
                                        <span className="violation-impact text-success">PASS</span>
                                        <span className="violation-id">{pass.id}</span>
                                    </div>
                                    <p className="violation-desc">{pass.description}</p>
                                    <p className="violation-help" style={{ marginBottom: 0 }}>{pass.help}</p>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            </div>

            <style>{`
                .accessibility-scanner { max-width: 1200px; margin: 0 auto; }
                .inline-icon { display: inline; vertical-align: middle; margin-right: 0.5rem; }

                /* Header — matches Test Runner format */
                .ac-header { margin-bottom: 2rem; }
                .ac-header h2 {
                    font-size: 2rem;
                    margin-bottom: 0.5rem;
                    background: linear-gradient(to right, var(--accent-primary), var(--accent-secondary));
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                }
                .ac-subtitle { color: var(--text-secondary); }

                .scanner-container {
                    display: grid;
                    grid-template-columns: 1fr 2fr;
                    gap: 2rem;
                }

                .control-panel, .results-panel {
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-lg);
                    padding: 1.5rem;
                }

                .input-with-button { display: flex; gap: 0.5rem; }
                .action-area { margin-top: 2rem; }
                .hint { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem; text-align: center; }
                .full-width { width: 100%; display: flex; justify-content: center; gap: 0.5rem; }

                /* Scan progress bar — heuristic, eases to 90% then snaps to 100% on response */
                .ac-progress {
                    margin-top: 1rem;
                    padding: 12px 14px;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                }
                .ac-progress-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 8px;
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                }
                .ac-progress-label { font-weight: 600; }
                .ac-progress-pct {
                    font-variant-numeric: tabular-nums;
                    font-weight: 700;
                    color: var(--text-primary);
                }
                .ac-progress-track {
                    width: 100%;
                    height: 8px;
                    background: var(--bg-primary);
                    border-radius: 99px;
                    overflow: hidden;
                }
                .ac-progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #2563eb, #3b82f6);
                    border-radius: 99px;
                    transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                }
                .ac-progress-fill.done {
                    background: linear-gradient(90deg, #16a34a, #22c55e);
                }
                .ac-progress-fill.failed {
                    background: linear-gradient(90deg, #b91c1c, #ef4444);
                }

                /* JIRA defect button — appears on every issue card (Axe + AI) */
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

                .badge { padding: 0.25rem 0.75rem; border-radius: 99px; font-size: 0.85rem; font-weight: 600; margin-left: 0.5rem; }
                .badge-error { background: #fee2e2; color: #dc2626; }
                .badge-success { background: #dcfce7; color: #16a34a; }

                .violation-card {
                    background: white;
                    border: 1px solid;
                    border-radius: 8px;
                    padding: 1rem;
                    margin-bottom: 1rem;
                    color: #1f2937; /* Force dark text */
                }
                
                .violation-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; }
                .violation-impact { font-weight: 800; font-size: 0.8rem; letter-spacing: 0.05em; }
                .violation-id { font-family: monospace; background: rgba(0,0,0,0.05); padding: 2px 6px; borderRadius: 4px; }
                .help-link { margin-left: auto; display: flex; align-items: center; gap: 4px; font-size: 0.85rem; text-decoration: underline; }
                
                .violation-desc { font-weight: 600; margin-bottom: 0.25rem; }
                .violation-help { font-size: 0.9rem; opacity: 0.8; margin-bottom: 0.75rem; }
                
                .violation-nodes { display: flex; flex-direction: column; gap: 0.25rem; }
                .node-selector { font-family: monospace; font-size: 0.85rem; background: rgba(255,255,255,0.5); padding: 4px; white-space: break-spaces; word-break: break-all; }
                
                .tabs { display: flex; gap: 1rem; margin-bottom: 1.5rem; border-bottom: 2px solid var(--border-color); }
                .tab-btn {
                    background: none; border: none; padding: 0.75rem 0; font-size: 1rem; cursor: pointer;
                    color: var(--text-muted); font-weight: 500; position: relative; top: 2px;
                    display: flex; align-items: center; gap: 8px;
                }
                .tab-btn.active { color: var(--text-primary); border-bottom: 2px solid var(--accent-primary); }
                .tab-count { font-size: 0.75rem; padding: 2px 6px; border-radius: 99px; }
                
                .pass-card { border-left: 4px solid #16a34a; background: #f0fdf4 !important; border-color: #bbf7d0; }
                .text-success { color: #16a34a; }

                .scanned-url { display: block; font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem; font-family: monospace; }
                
                .history-item { background: white; padding: 1rem; border-radius: 8px; margin-bottom: 0.75rem; border: 1px solid var(--border-color); }
                .history-url { font-weight: 600; color: #1f2937; margin-bottom: 0.5rem; word-break: break-all; }
                .history-meta { display: flex; gap: 0.5rem; font-size: 0.8rem; color: #6b7280; align-items: center; }

                .ai-section-divider { margin-top: 2rem; border-top: 2px dashed #cbd5e1; padding-top: 1.5rem; }
                .ai-section-divider h3 { display: flex; align-items: center; gap: 8px; color: #4f46e5; margin-bottom: 0.25rem; }
                .ai-section-divider p { color: #64748b; margin-bottom: 1.5rem; font-size: 0.9rem; }

                .ai-summary-card {
                    background: linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%);
                    border: 1px solid #bfdbfe;
                    border-radius: 8px;
                    padding: 1.5rem;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 2rem;
                }
                .risk-level { font-size: 1.2rem; font-weight: 600; display: flex; align-items: center; gap: 1rem; }
                .risk-badge { padding: 4px 12px; border-radius: 99px; color: white; }
                .risk-badge.high { background: #dc2626; }
                .risk-badge.medium { background: #f59e0b; }
                .risk-badge.low { background: #16a34a; }
                
                .risk-metrics { display: flex; gap: 2rem; }
                .metric { text-align: center; }
                .metric .count { display: block; font-size: 1.5rem; font-weight: 800; }
                .metric .count.critical { color: #dc2626; }
                .metric .count.serious { color: #ea580c; }
                .metric .count.moderate { color: #ca8a04; }
                .metric .label { font-size: 0.8rem; color: #6b7280; text-transform: uppercase; }

                .ai-issue-card {
                    background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem;
                    border-left: 4px solid #9ca3af;
                }
                .ai-issue-card.critical { border-left-color: #dc2626; }
                .ai-issue-card.serious { border-left-color: #ea580c; }
                .ai-issue-card.moderate { border-left-color: #ca8a04; }

                .issue-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
                .severity-badge { font-weight: 700; font-size: 0.75rem; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; color: white; }
                .severity-badge.critical { background: #dc2626; }
                .severity-badge.serious { background: #ea580c; }
                .severity-badge.moderate { background: #ca8a04; }
                
                .wcag-ref { font-family: monospace; background: #e5e7eb; padding: 2px 6px; border-radius: 4px; font-size: 0.85rem; color: #374151; }
                .affected-users { display: flex; gap: 0.5rem; }
                .user-tag { background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 99px; font-size: 0.75rem; }

                .issue-title { font-size: 1.1rem; margin: 0 0 1rem 0; color: #111827; }
                .detail-row { margin-bottom: 1rem; color: #4b5563; }
                
                .fix-box { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 1rem; border-radius: 6px; color: #166534; font-size: 0.9rem; }
                .fix-box code { display: block; margin-top: 0.5rem; white-space: pre-wrap; background: rgba(255,255,255,0.5); padding: 0.5rem; border-radius: 4px; }

                .areas-reviewed { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; }
                .area-tags { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
                .area-tag { display: flex; align-items: center; gap: 4px; background: #f3f4f6; padding: 4px 10px; border-radius: 99px; font-size: 0.8rem; color: #4b5563; }

                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { 100% { transform: rotate(360deg); } }
                /* Report Dashboard Styles */
                .report-dashboard { display: flex; flex-direction: column; gap: 1.5rem; color: #0f172a; } /* Force dark text base */
                .report-card { background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border: 1px solid #e2e8f0; color: #334155; }
                
                .report-header-card { background: #f8fafc; border-bottom: 4px solid #6366f1; padding: 1.5rem; border-radius: 8px; color: #1e293b; }
                .report-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
                .report-title-row h2 { margin: 0; font-size: 1.5rem; color: #1e293b; font-weight: 700; }
                .release-badge { padding: 0.5rem 1rem; border-radius: 20px; font-weight: bold; font-size: 0.9rem; text-transform: uppercase; color: #1e293b; }
                .report-meta { display: flex; gap: 2rem; color: #475569; font-size: 0.95rem; }
                .risk-text.high { color: #dc2626; font-weight: bold; }
                .risk-text.medium { color: #d97706; font-weight: bold; }
                .risk-text.low { color: #16a34a; font-weight: bold; }

                .report-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
                .snapshot-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; color: #334155; } /* Explicit table text color */
                .snapshot-table th { text-align: left; padding: 0.5rem; color: #475569; font-size: 0.85rem; border-bottom: 2px solid #e2e8f0; font-weight: 600; }
                .snapshot-table td { padding: 0.75rem 0.5rem; border-bottom: 1px solid #f1f5f9; color: #1e293b; } /* Explicit cell color */
                .snapshot-status { display: flex; align-items: center; gap: 8px; font-weight: 600; }
                .snapshot-status.pass { color: #16a34a; }
                .snapshot-status.fail { color: #dc2626; }
                .snapshot-status.partial { color: #d97706; }

                .stats-row { display: flex; justify-content: space-around; margin-bottom: 1.5rem; }
                .stat-item { display: flex; flex-direction: column; align-items: center; }
                .stat-value { font-size: 2rem; font-weight: bold; color: #4f46e5; }
                .stat-label { font-size: 0.85rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
                .affected-users-list h4 { margin: 0 0 0.5rem 0; font-size: 0.9rem; color: #334155; font-weight: 600; }
                .affected-users-list ul { padding-left: 1.25rem; margin: 0; color: #334155; font-size: 0.9rem; }
                .affected-users-list li { margin-bottom: 0.25rem; color: #334155; }

                .blockers-list { list-style: none; padding: 0; margin: 0; }
                .blocker-item { background: #fff1f2; border-left: 4px solid #f43f5e; padding: 1rem; margin-bottom: 0.75rem; border-radius: 4px; font-size: 0.95rem; color: #881337; } /* Dark Red for text on light pink */
                .blocker-item strong { color: #881337; font-weight: 700; }
                .source-tag { font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; margin-right: 8px; font-weight: bold; text-transform: uppercase; vertical-align: middle; }
                .source-tag.axe { background: #e0f2fe; color: #0369a1; }
                .source-tag.ai { background: #f0fdf4; color: #15803d; }

                .recommendation-card { background: #eff6ff; border: 1px solid #bfdbfe; }
                .recommendation-text { font-size: 1.05rem; line-height: 1.6; color: #1e3a8a; font-style: italic; }
            `}</style>
        </div>
    );
};

export default AccessibilityScanner;
