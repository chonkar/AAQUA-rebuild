import React, { useState, useEffect } from 'react';
import { Gauge, Play, Loader2, AlertCircle, AlertTriangle, Zap, Clock, Layout, Timer, Activity, Sparkles, Globe } from 'lucide-react';
import { analyzePerformance, getPerformanceInsights, launchBrowser } from '../services/performanceService';
import { useProject } from '../context/ProjectContext';
import { useAuth } from 'react-oidc-context';
import { createApiClient } from '../utils/apiClient';
import JiraDefectButton from '../components/features/JiraDefectButton';
import UrlScopeWarning from '../components/common/UrlScopeWarning';

// Same BASE_URL pattern as the service layer
const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

const cleanUrl = (val) => val ? val.replace(/^(https?:\/\/)+/i, (m) => m.toLowerCase().includes('https') ? 'https://' : 'http://') : '';

// Core Web Vitals rating thresholds (Google's good / needs-improvement / poor).
const rate = (value, good, poor) => {
    if (value == null) return 'na';
    if (value <= good) return 'good';
    if (value <= poor) return 'ni';
    return 'poor';
};
const RATE_COLOR = { good: '#10b981', ni: '#f59e0b', poor: '#ef4444', na: 'var(--text-muted)' };
const scoreColor = (s) => (s >= 90 ? '#10b981' : s >= 50 ? '#f59e0b' : '#ef4444');
const fmtMs = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

const PerformanceScanner = () => {
    const { selectedProjectId, selectedProject } = useProject();
    const auth = useAuth();
    const api = createApiClient(() => auth.user?.access_token || '');
    const [url, setUrl] = useState('');
    const [isScanning, setIsScanning] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [insights, setInsights] = useState({ loading: false, text: null, error: null });
    const [jiraState, setJiraState] = useState(null);

    // Interactive Mode State
    const [isBrowserActive, setIsBrowserActive] = useState(false);
    const [browserType, setBrowserType] = useState('chromium');
    const [useCookies, setUseCookies] = useState(false);
    const [cookieInput, setCookieInput] = useState('');
    const [currentBrowserUrl, setCurrentBrowserUrl] = useState('');
    const [navUrlInput, setNavUrlInput] = useState('');
    const [isExtensionInstalled, setIsExtensionInstalled] = useState(false);

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
            setUrl(cleanUrl(selectedProject.target_url));
        }
    }, [selectedProject?.id, selectedProject?.target_url]);

    const handleLaunch = async () => {
        setError(null);
        setIsBrowserActive(false);
        const cleanedUrl = cleanUrl(url);
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

            await launchBrowser(cleanedUrl, browserType, cookies, selectedProjectId || null);
            setIsBrowserActive(true);
            setCurrentBrowserUrl(cleanedUrl);
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
        const targetUrl = cleanUrl((isBrowserActive && currentBrowserUrl) ? currentBrowserUrl : url);
        if (!targetUrl.trim()) return;
        setIsScanning(true);
        setError(null);
        setResult(null);
        setInsights({ loading: false, text: null, error: null });
        setJiraState(null);
        try {
            const data = await analyzePerformance(targetUrl.trim(), selectedProjectId || null);
            setResult(data);
            fetchInsights(data); // fire-and-forget AI triage (loads after the report shows)
        } catch (err) {
            setError(err.message);
        } finally {
            setIsScanning(false);
        }
    };

    const fetchInsights = async (data) => {
        const apiKey = import.meta.env.VITE_LLM_API_KEY;
        if (!apiKey) return;
        setInsights({ loading: true, text: null, error: null });
        try {
            const { summary } = await getPerformanceInsights(
                { score: data.score, metrics: data.metrics, opportunities: data.opportunities, url: data.scannedUrl },
                apiKey,
            );
            setInsights({ loading: false, text: summary, error: null });
        } catch (err) {
            setInsights({ loading: false, text: null, error: err.message });
        }
    };

    const raiseJira = async () => {
        if (!result) return;
        setJiraState({ status: 'logging' });
        try {
            const data = await api.post('/api/jira/performance-defect', {
                perf: { score: result.score, metrics: result.metrics, opportunities: result.opportunities, aiSummary: insights.text || null },
                projectName: selectedProject?.name || 'Untitled Project',
                scannedUrl: result.scannedUrl,
            });
            setJiraState({ status: 'logged', key: data.key, url: data.url });
        } catch (err) {
            setJiraState({ status: 'error', error: err.message });
        }
    };

    const m = result?.metrics || {};
    const vitals = result ? [
        { key: 'lcp', label: 'Largest Contentful Paint', icon: Layout, value: fmtMs(m.lcp), rating: rate(m.lcp, 2500, 4000) },
        { key: 'cls', label: 'Cumulative Layout Shift', icon: Activity, value: m.cls == null ? '—' : m.cls.toFixed(3), rating: rate(m.cls, 0.1, 0.25) },
        { key: 'tbt', label: 'Total Blocking Time', icon: Timer, value: fmtMs(m.tbt), rating: rate(m.tbt, 200, 600) },
        { key: 'fcp', label: 'First Contentful Paint', icon: Zap, value: fmtMs(m.fcp), rating: rate(m.fcp, 1800, 3000) },
        { key: 'si', label: 'Speed Index', icon: Gauge, value: fmtMs(m.speedIndex), rating: rate(m.speedIndex, 3400, 5800) },
        { key: 'ttfb', label: 'Time to First Byte', icon: Clock, value: fmtMs(m.ttfb), rating: rate(m.ttfb, 800, 1800) },
    ] : [];

    return (
        <div className="perf-scanner animate-fade-in">
            <div className="page-header">
                <h2><Gauge className="inline-icon" /> Performance Scanner</h2>
                <p>Lighthouse front-end performance audit — score &amp; Core Web Vitals.</p>
            </div>

            <div className="perf-container">
                <div className="control-panel">
                    <div className="form-group">
                        <label>Target URL</label>
                        <div className="input-with-button" style={{ display: 'flex', gap: '0.5rem' }}>
                            <input
                                type="text"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://example.com"
                                className="form-input"
                                disabled={isScanning || isBrowserActive}
                            />
                            <button
                                onClick={handleLaunch}
                                disabled={!url || isBrowserActive || isScanning}
                                className="btn btn-primary"
                                style={{ flexShrink: 0 }}
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
                                disabled={isBrowserActive || isScanning}
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
                                    disabled={isBrowserActive || isScanning}
                                />
                                <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Use Session Cookies (Authenticated)</span>
                            </label>

                            {isExtensionInstalled ? (
                                <button
                                    type="button"
                                    onClick={handlePullCookies}
                                    disabled={!url.trim() || isBrowserActive || isScanning}
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
                                    disabled={isBrowserActive || isScanning}
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

                    <button 
                        onClick={handleScan} 
                        disabled={isScanning || (!isBrowserActive && !url.trim())} 
                        className="btn btn-primary full-width"
                        style={{ background: '#2563eb', color: '#fff', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                    >
                        {isScanning ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                        {isScanning ? 'Running Lighthouse…' : 'Run Performance Scan'}
                    </button>
                    <p className="hint">Lighthouse loads the target page in a headless browser and measures lab metrics. Takes ~15–40s.</p>

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
                                        disabled={isScanning}
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
                                        disabled={isScanning}
                                    >
                                        Go
                                    </button>
                                </div>
                            </div>

                            <button
                                onClick={handleCloseBrowser}
                                className="btn btn-danger btn-sm"
                                style={{ width: '100%', padding: '0.5rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: '600' }}
                                disabled={isScanning}
                            >
                                Close Browser Session
                            </button>
                        </div>
                    )}

                    {error && (
                        <div className="error-banner" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.8rem', padding: '0.6rem 0.8rem', background: 'rgba(239,68,68,0.1)', border: '1px solid var(--error)', color: '#fca5a5', borderRadius: 'var(--radius-md)', fontStyle: 'normal', textDecoration: 'none' }}>
                            <AlertCircle size={18} /> {error}
                        </div>
                    )}
                </div>

                <div className="results-panel">
                    {!result && !isScanning && (
                        <div className="empty-state">
                            <Gauge size={48} className="text-muted" />
                            <p>Enter a URL and run a scan to see the performance report.</p>
                        </div>
                    )}
                    {isScanning && (
                        <div className="empty-state">
                            <Loader2 size={40} className="spin" />
                            <p>Auditing the page with Lighthouse…</p>
                        </div>
                    )}
                    {result && (
                        <>
                            <div className="perf-score-row">
                                <div className="perf-score-ring" style={{ borderColor: scoreColor(result.score) }}>
                                    <span className="perf-score-num" style={{ color: scoreColor(result.score) }}>{result.score}</span>
                                    <span className="perf-score-cap">Performance</span>
                                </div>
                                <div className="perf-scanned">
                                    <span className="perf-scanned-label">Scanned</span>
                                    <span className="perf-scanned-url">{result.scannedUrl}</span>
                                </div>
                            </div>

                            <div className="vitals-grid">
                                {vitals.map(v => (
                                    <div key={v.key} className="vital-card" style={{ borderLeftColor: RATE_COLOR[v.rating] }}>
                                        <div className="vital-top">
                                            <v.icon size={15} />
                                            <span className="vital-label">{v.label}</span>
                                        </div>
                                        <span className="vital-value" style={{ color: RATE_COLOR[v.rating] }}>{v.value}</span>
                                    </div>
                                ))}
                            </div>

                            <div className="opps-card">
                                <h3>Opportunities</h3>
                                {(!result.opportunities || result.opportunities.length === 0) ? (
                                    <p className="opps-clean">✅ No major load-time opportunities flagged.</p>
                                ) : (
                                    <ul className="opps-list">
                                        {result.opportunities.map((o, i) => (
                                            <li key={i} className="opp-item">
                                                <div className="opp-head">
                                                    <span className="opp-title">{o.title}</span>
                                                    {o.savingsMs != null && <span className="opp-savings">~{fmtMs(o.savingsMs)} savings</span>}
                                                </div>
                                                {o.description && <p className="opp-desc">{o.description}</p>}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>

                            {(insights.loading || insights.text || insights.error) && (
                                <div className="ai-insights-card">
                                    <h3><Sparkles size={16} /> AI Performance Insights</h3>
                                    {insights.loading && <p className="ai-loading"><Loader2 className="spin" size={14} /> Generating prioritized fixes…</p>}
                                    {insights.text && <pre className="ai-text">{insights.text}</pre>}
                                    {insights.error && <p className="ai-err">AI insights unavailable: {insights.error}</p>}
                                </div>
                            )}

                            <div className="perf-actions">
                                <JiraDefectButton state={jiraState} onClick={raiseJira} />
                            </div>
                        </>
                    )}
                </div>
            </div>

            <style>{`
                .page-header { margin-bottom: 1.5rem; }
                .page-header h2 { font-size: 1.6rem; display: flex; align-items: center; gap: 0.5rem; }
                .inline-icon { color: var(--accent-primary); }
                .page-header p { color: var(--text-secondary); }
                .perf-container { display: grid; grid-template-columns: 320px 1fr; gap: 1.5rem; align-items: start; }
                .control-panel { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1.25rem; position: sticky; top: 90px; }
                .form-group label { display: block; font-weight: 600; margin-bottom: 0.4rem; font-size: 0.85rem; }
                .form-input { width: 100%; padding: 0.7rem; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-primary); color: var(--text-primary); }
                .full-width { width: 100%; justify-content: center; margin-top: 1rem; display: inline-flex; align-items: center; gap: 0.5rem; }
                .hint { font-size: 0.78rem; color: var(--text-muted); margin-top: 0.6rem; }
                .error-banner { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.8rem; padding: 0.6rem 0.8rem; background: rgba(239,68,68,0.1); border: 1px solid var(--error); color: #fca5a5; border-radius: var(--radius-md); font-size: 0.85rem; }
                .results-panel { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1.5rem; min-height: 300px; }
                .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.75rem; color: var(--text-muted); padding: 3rem 1rem; text-align: center; }
                .perf-score-row { display: flex; align-items: center; gap: 1.5rem; margin-bottom: 1.5rem; }
                .perf-score-ring { width: 96px; height: 96px; border: 6px solid; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0; }
                .perf-score-num { font-size: 2rem; font-weight: 800; line-height: 1; }
                .perf-score-cap { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-top: 2px; }
                .perf-scanned { display: flex; flex-direction: column; gap: 0.2rem; overflow: hidden; }
                .perf-scanned-label { font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); }
                .perf-scanned-url { font-family: monospace; font-size: 0.85rem; color: var(--text-secondary); word-break: break-all; }
                .vitals-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
                .vital-card { background: var(--bg-primary); border: 1px solid var(--border-color); border-left: 4px solid; border-radius: var(--radius-md); padding: 0.75rem 0.9rem; }
                .vital-top { display: flex; align-items: center; gap: 0.4rem; color: var(--text-muted); font-size: 0.72rem; margin-bottom: 0.4rem; }
                .vital-label { line-height: 1.2; }
                .vital-value { font-size: 1.35rem; font-weight: 700; }
                .opps-card h3 { font-size: 1.05rem; margin-bottom: 0.75rem; }
                .opps-clean { color: #10b981; }
                .opps-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
                .opp-item { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.7rem 0.9rem; }
                .opp-head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
                .opp-title { font-weight: 600; font-size: 0.9rem; }
                .opp-savings { font-size: 0.75rem; color: #f59e0b; white-space: nowrap; }
                .opp-desc { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.35rem; line-height: 1.4; }
                .ai-insights-card { margin-top: 1.5rem; padding: 1rem 1.1rem; background: rgba(139,92,246,0.06); border: 1px solid rgba(139,92,246,0.25); border-radius: var(--radius-md); }
                .ai-insights-card h3 { display: flex; align-items: center; gap: 0.4rem; font-size: 1rem; margin-bottom: 0.6rem; color: var(--accent-primary); }
                .ai-loading { display: flex; align-items: center; gap: 0.4rem; color: var(--text-muted); font-size: 0.85rem; }
                .ai-text { white-space: pre-wrap; font-family: inherit; font-size: 0.85rem; line-height: 1.5; color: var(--text-secondary); margin: 0; }
                .ai-err { color: #f59e0b; font-size: 0.82rem; }
                .perf-actions { margin-top: 1.25rem; display: flex; justify-content: flex-end; }
                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { 100% { transform: rotate(360deg); } }
                @media (max-width: 900px) { .perf-container { grid-template-columns: 1fr; } .control-panel { position: static; } }
            `}</style>
        </div>
    );
};

export default PerformanceScanner;
