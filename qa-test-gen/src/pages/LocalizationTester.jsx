import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from 'react-oidc-context';
import { Globe, Play, Search, AlertTriangle, CheckCircle, Loader2, ArrowLeft, ArrowRight, RotateCw, CornerDownLeft, Terminal, Code, AlertCircle } from 'lucide-react';
import { launchBrowser, capturePage, startLocalizationAnalysis, getLocalizationStatus } from '../services/localizationService';
import { useProject } from '../context/ProjectContext';
import { createApiClient } from '../utils/apiClient';
import JiraDefectButton from '../components/features/JiraDefectButton';
import UrlScopeWarning from '../components/common/UrlScopeWarning';

// BASE_URL-prefixed relative path.
const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

const LocalizationTester = () => {
    const { selectedProjectId, selectedProject } = useProject();
    const auth = useAuth();
    const api = createApiClient(() => auth.user?.access_token || '');
    const [url, setUrl] = useState('');
    const [targetLanguage, setTargetLanguage] = useState('Arabic');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [issues, setIssues] = useState([]);
    const [error, setError] = useState(null);
    const [chunkCount, setChunkCount] = useState(null);
    const [scannedUrl, setScannedUrl] = useState('');

    // Heuristic progress state — same pattern used in AccessibilityScanner.
    const [analyzeProgress, setAnalyzeProgress] = useState(0);
    const [analyzePhaseLabel, setAnalyzePhaseLabel] = useState('');
    const [analyzeFailed, setAnalyzeFailed] = useState(false);
    const pollRef = useRef(null);

    // Per-issue JIRA logging state. Keys are `loc-${idx}` since localization
    // issues have no stable id — reset on every analyze run so badges don't
    // leak across scans.
    const [jiraState, setJiraState] = useState({});

    // Mode: 'url' (Scrape/Emulate) or 'html' (Manual Paste)
    const [mode, setMode] = useState('url');
    const [htmlInput, setHtmlInput] = useState('');

    // Remote Browser Emulator States
    const [isBrowserOpen, setIsBrowserOpen] = useState(false);
    const [screenshotTime, setScreenshotTime] = useState(Date.now());
    const [browserUrl, setBrowserUrl] = useState('');
    const [typeText, setTypeText] = useState('');
    const [isScreencastLoading, setIsScreencastLoading] = useState(false);

    // Progress is now driven by REAL chunk completion from the polling loop in
    // handleAnalyze (not a heuristic timer). Just clear the poll interval if the
    // user navigates away mid-analysis.
    useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

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
        if (!url.trim()) return;
        setIsAnalyzing(true);
        setError(null);
        try {
            await launchBrowser(url);
            setIsBrowserOpen(true);
            setBrowserUrl(url);
            setScreenshotTime(Date.now());
        } catch (err) {
            setError(err.message || "Failed to launch browser. Ensure server is running.");
        } finally {
            setIsAnalyzing(false);
        }
    };

    const handleScreenshotClick = async (e) => {
        if (isScreencastLoading || isAnalyzing) return;
        const rect = e.target.getBoundingClientRect();
        const x = Math.round((e.clientX - rect.left) / rect.width * 1280);
        const y = Math.round((e.clientY - rect.top) / rect.height * 800);

        setIsScreencastLoading(true);
        try {
            const response = await fetch(`${API_URL}/browser/click`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x, y })
            });
            if (response.ok) {
                const data = await response.json();
                if (data.url) setBrowserUrl(data.url);
                setScreenshotTime(Date.now());
            }
        } catch (err) {
            console.error("Remote browser click failed:", err);
        } finally {
            setIsScreencastLoading(false);
        }
    };

    const handleTypeSend = async (e) => {
        e.preventDefault();
        if (!typeText || isScreencastLoading || isAnalyzing) return;
        setIsScreencastLoading(true);
        try {
            const response = await fetch(`${API_URL}/browser/type`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: typeText })
            });
            if (response.ok) {
                const data = await response.json();
                if (data.url) setBrowserUrl(data.url);
                setTypeText('');
                setScreenshotTime(Date.now());
            }
        } catch (err) {
            console.error("Remote browser typing failed:", err);
        } finally {
            setIsScreencastLoading(false);
        }
    };

    const handlePressEnter = async () => {
        if (isScreencastLoading || isAnalyzing) return;
        setIsScreencastLoading(true);
        try {
            const response = await fetch(`${API_URL}/browser/key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'Enter' })
            });
            if (response.ok) {
                const data = await response.json();
                if (data.url) setBrowserUrl(data.url);
                setScreenshotTime(Date.now());
            }
        } catch (err) {
            console.error("Remote browser enter press failed:", err);
        } finally {
            setIsScreencastLoading(false);
        }
    };

    const handleNavigate = async (e) => {
        e.preventDefault();
        if (!browserUrl.trim() || isScreencastLoading || isAnalyzing) return;
        setIsScreencastLoading(true);
        try {
            const response = await fetch(`${API_URL}/browser/navigate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: browserUrl })
            });
            if (response.ok) {
                const data = await response.json();
                if (data.url) setBrowserUrl(data.url);
                setScreenshotTime(Date.now());
            }
        } catch (err) {
            console.error("Remote browser navigation failed:", err);
        } finally {
            setIsScreencastLoading(false);
        }
    };

    const handleHistory = async (direction) => {
        if (isScreencastLoading || isAnalyzing) return;
        setIsScreencastLoading(true);
        try {
            const response = await fetch(`${API_URL}/browser/history`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ direction })
            });
            if (response.ok) {
                const data = await response.json();
                if (data.url) setBrowserUrl(data.url);
                setScreenshotTime(Date.now());
            }
        } catch (err) {
            console.error("Remote browser history navigation failed:", err);
        } finally {
            setIsScreencastLoading(false);
        }
    };

    const handleCloseBrowser = async () => {
        try {
            await fetch(`${API_URL}/browser/close`, { method: 'POST' });
        } catch (e) {
            console.error("Failed to close browser session:", e);
        } finally {
            setIsBrowserOpen(false);
        }
    };

    const triggerAnalysis = async (htmlContent) => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        setIsAnalyzing(true);
        setError(null);
        setAnalyzeFailed(false);
        setAnalyzeProgress(0);
        setAnalyzePhaseLabel('Initiating localization review…');
        setIssues([]);
        setChunkCount(null);
        setJiraState({});

        try {
            const apiKey = import.meta.env.VITE_LLM_API_KEY;
            if (!apiKey) throw new Error("API Key missing");

            setAnalyzePhaseLabel('Starting analysis…');
            const { jobId, totalChunks } = await startLocalizationAnalysis(htmlContent, targetLanguage, apiKey, selectedProjectId);
            setChunkCount(totalChunks || 1);

            pollRef.current = setInterval(async () => {
                try {
                    const s = await getLocalizationStatus(jobId);
                    setIssues(s.issues || []);
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

    const handleAnalyze = async () => {
        if (mode === 'html') {
            if (!htmlInput.trim()) {
                setError("Please paste valid HTML content.");
                return;
            }
            setScannedUrl('Manual HTML Paste');
            await triggerAnalysis(htmlInput);
        } else {
            try {
                setError(null);
                setIsAnalyzing(true);
                setAnalyzePhaseLabel('Capturing page…');
                const capture = await capturePage();
                setScannedUrl(capture?.url || url);
                await triggerAnalysis(capture.html);
            } catch (err) {
                setError(err.message);
                setIsAnalyzing(false);
            }
        }
    };

    const handleCaptureAndAnalyze = async () => {
        setError(null);
        setIsAnalyzing(true);
        setAnalyzePhaseLabel('Capturing page session…');
        try {
            const capture = await capturePage();
            setScannedUrl(capture?.url || url);
            await handleCloseBrowser();
            await triggerAnalysis(capture.html);
        } catch (e) {
            setError(e.message);
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
                <div className="control-panel-wrapper">
                    <div className="mode-tabs">
                        <button
                            className={`tab-btn ${mode === 'url' ? 'active' : ''}`}
                            onClick={() => setMode('url')}
                        >
                            <Globe size={18} /> Scrape URL
                        </button>
                        <button
                            className={`tab-btn ${mode === 'html' ? 'active' : ''}`}
                            onClick={() => setMode('html')}
                        >
                            <Code size={18} /> Paste HTML
                        </button>
                    </div>

                    <div className="control-panel">
                        {mode === 'url' ? (
                            <div className="form-group">
                                <label>Target URL</label>
                                <div className="input-with-button">
                                    <input
                                        type="text"
                                        value={url}
                                        onChange={(e) => setUrl(e.target.value)}
                                        placeholder="https://example.com/ar"
                                        className="form-input"
                                        disabled={isAnalyzing}
                                    />
                                    <button
                                        onClick={handleLaunch}
                                        disabled={!url || isBrowserOpen || isAnalyzing}
                                        className="btn btn-primary"
                                    >
                                        <Play size={16} /> Launch
                                    </button>
                                </div>
                                <UrlScopeWarning url={url} />
                            </div>
                        ) : (
                            <div className="form-group">
                                <label>Paste HTML Content</label>
                                <textarea
                                    className="html-textarea"
                                    placeholder="<html lang='ar'>...</html>"
                                    value={htmlInput}
                                    onChange={(e) => setHtmlInput(e.target.value)}
                                    rows={8}
                                    disabled={isAnalyzing}
                                    style={{
                                        width: '100%',
                                        background: 'var(--bg-primary)',
                                        color: 'var(--text-primary)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 'var(--radius-md)',
                                        padding: '0.75rem',
                                        fontFamily: 'monospace',
                                        fontSize: '0.85rem',
                                        resize: 'vertical'
                                    }}
                                />
                            </div>
                        )}

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
                            {mode === 'url' ? (
                                <button
                                    onClick={handleAnalyze}
                                    disabled={!isBrowserOpen || isAnalyzing}
                                    className="btn full-width"
                                    style={{ background: '#2563eb', color: '#fff', border: 'none' }}
                                >
                                    {isAnalyzing ? <Loader2 className="spin" /> : <Search size={18} />}
                                    {isAnalyzing ? "Analyzing..." : "Analyze Current Page"}
                                </button>
                            ) : (
                                <button
                                    onClick={handleAnalyze}
                                    disabled={!htmlInput.trim() || isAnalyzing}
                                    className="btn full-width"
                                    style={{ background: '#2563eb', color: '#fff', border: 'none' }}
                                >
                                    {isAnalyzing ? <Loader2 className="spin" /> : <Search size={18} />}
                                    {isAnalyzing ? "Analyzing..." : "Analyze Pasted HTML"}
                                </button>
                            )}
                            {mode === 'url' && (
                                <p className="hint">
                                    Launch browser to navigate and log in, then click Analyze.
                                </p>
                            )}
                        </div>

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

            {isBrowserOpen && (
                <div className="remote-browser-modal animate-fade-in">
                    <div className="remote-browser-content">
                        {/* Address bar/Nav bar */}
                        <div className="remote-browser-header">
                            <button
                                className="remote-browser-nav-btn"
                                onClick={() => handleHistory('back')}
                                disabled={isScreencastLoading || isAnalyzing}
                                title="Back"
                            >
                                <ArrowLeft size={16} />
                            </button>
                            <button
                                className="remote-browser-nav-btn"
                                onClick={() => handleHistory('forward')}
                                disabled={isScreencastLoading || isAnalyzing}
                                title="Forward"
                            >
                                <ArrowRight size={16} />
                            </button>
                            <button
                                className="remote-browser-nav-btn"
                                onClick={() => setScreenshotTime(Date.now())}
                                disabled={isScreencastLoading || isAnalyzing}
                                title="Refresh Viewport"
                            >
                                <RotateCw size={16} />
                            </button>
                            
                            <form onSubmit={handleNavigate} className="remote-browser-address-form">
                                <input
                                    type="text"
                                    className="remote-browser-address-input"
                                    value={browserUrl}
                                    onChange={(e) => setBrowserUrl(e.target.value)}
                                    placeholder="Navigate to URL..."
                                    disabled={isScreencastLoading || isAnalyzing}
                                />
                                <button type="submit" className="btn btn-secondary btn-sm" disabled={isScreencastLoading || isAnalyzing}>
                                    Go
                                </button>
                            </form>
                        </div>

                        {/* Viewport Canvas */}
                        <div className="remote-browser-viewport">
                            <img
                                src={`${API_URL}/browser/screenshot?t=${screenshotTime}`}
                                alt="Remote Browser Screencast Viewport"
                                className="remote-browser-img"
                                onClick={handleScreenshotClick}
                            />
                            {(isScreencastLoading || isAnalyzing) && (
                                <div className="remote-browser-viewport-loading">
                                    <Loader2 className="spin" size={32} />
                                    <span>Syncing Remote Browser...</span>
                                </div>
                            )}
                        </div>

                        {/* Text Input / Keyboard Interaction toolbar */}
                        <div className="remote-browser-typing-toolbar">
                            <Terminal size={16} className="text-muted" />
                            <form onSubmit={handleTypeSend} className="remote-browser-type-form">
                                <input
                                    type="text"
                                    className="remote-browser-type-input"
                                    value={typeText}
                                    onChange={(e) => setTypeText(e.target.value)}
                                    placeholder="Type characters to input on page..."
                                    disabled={isScreencastLoading || isAnalyzing}
                                />
                                <button type="submit" className="btn btn-secondary btn-sm" disabled={isScreencastLoading || isAnalyzing || !typeText}>
                                    Type
                                </button>
                            </form>
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={handlePressEnter}
                                disabled={isScreencastLoading || isAnalyzing}
                                title="Send Enter Key"
                                style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                            >
                                <CornerDownLeft size={14} />
                                <span>Enter</span>
                            </button>
                        </div>

                        {/* Close/Capture Footer actions */}
                        <div className="remote-browser-footer">
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                💡 Click viewport to click. Type text in toolbar to enter text, click Type to send.
                            </span>
                            <div className="remote-browser-footer-actions">
                                <button
                                    className="btn btn-success"
                                    onClick={handleCaptureAndAnalyze}
                                    disabled={isScreencastLoading || isAnalyzing}
                                    style={{ width: 'auto' }}
                                >
                                    {isAnalyzing ? <Loader2 className="spin" size={16} /> : "Capture & Analyze Page"}
                                </button>
                                <button
                                    className="btn btn-secondary"
                                    onClick={handleCloseBrowser}
                                    disabled={isScreencastLoading || isAnalyzing}
                                    style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.3)', color: '#fca5a5' }}
                                >
                                    Close Browser
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

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

                /* Tabbed Interface and Remote Browser Emulator Styles */
                .control-panel-wrapper {
                    display: flex;
                    flex-direction: column;
                }

                .control-panel-wrapper .control-panel {
                    border-top-left-radius: 0;
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

                .remote-browser-modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(15, 23, 42, 0.75);
                    backdrop-filter: blur(8px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 1000;
                    padding: 2rem;
                }

                .remote-browser-content {
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-lg);
                    width: 100%;
                    max-width: 1320px;
                    display: flex;
                    flex-direction: column;
                    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4);
                    overflow: hidden;
                    animation: scaleUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                }

                @keyframes scaleUp {
                    from { transform: scale(0.95); opacity: 0; }
                    to { transform: scale(1); opacity: 1; }
                }

                .remote-browser-header {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 0.75rem 1rem;
                    background: var(--bg-tertiary);
                    border-bottom: 1px solid var(--border-color);
                }

                .remote-browser-nav-btn {
                    background: var(--bg-primary);
                    border: 1px solid var(--border-color);
                    color: var(--text-primary);
                    width: 32px;
                    height: 32px;
                    border-radius: var(--radius-md);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .remote-browser-nav-btn:hover:not(:disabled) {
                    background: var(--bg-secondary);
                    border-color: var(--accent-primary);
                    color: var(--accent-primary);
                }
                .remote-browser-nav-btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                .remote-browser-address-form {
                    display: flex;
                    flex: 1;
                    gap: 0.5rem;
                }

                .remote-browser-address-input {
                    flex: 1;
                    background: var(--bg-primary);
                    color: var(--text-primary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-md);
                    padding: 0.375rem 0.75rem;
                    font-size: 0.9rem;
                }
                .remote-browser-address-input:focus {
                    outline: none;
                    border-color: var(--accent-primary);
                }

                .remote-browser-viewport {
                    position: relative;
                    background: #000;
                    display: flex;
                    justify-content: center;
                    align-items: flex-start;
                    overflow: auto;
                    max-height: calc(100vh - 280px);
                    min-height: 400px;
                }

                .remote-browser-img {
                    width: 1280px;
                    height: 800px;
                    min-width: 1280px;
                    min-height: 800px;
                    object-fit: contain;
                    cursor: crosshair;
                    display: block;
                }

                .remote-browser-viewport-loading {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(15, 23, 42, 0.6);
                    backdrop-filter: blur(2px);
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 1rem;
                    color: white;
                    font-weight: 500;
                    z-index: 10;
                }

                .remote-browser-typing-toolbar {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 0.75rem 1rem;
                    background: var(--bg-tertiary);
                    border-top: 1px solid var(--border-color);
                    border-bottom: 1px solid var(--border-color);
                }

                .remote-browser-type-form {
                    display: flex;
                    flex: 1;
                    gap: 0.5rem;
                }

                .remote-browser-type-input {
                    flex: 1;
                    background: var(--bg-primary);
                    color: var(--text-primary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-md);
                    padding: 0.375rem 0.75rem;
                    font-size: 0.9rem;
                }
                .remote-browser-type-input:focus {
                    outline: none;
                    border-color: var(--accent-primary);
                }

                .remote-browser-footer {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 0.75rem 1rem;
                    background: var(--bg-tertiary);
                }

                .remote-browser-footer-actions {
                    display: flex;
                    gap: 0.75rem;
                }
            `}</style>
        </div>
    );
};

export default LocalizationTester;
