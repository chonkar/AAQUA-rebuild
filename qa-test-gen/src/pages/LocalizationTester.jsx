import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from 'react-oidc-context';
import { Globe, Play, Search, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import { launchBrowser, capturePage, startLocalizationAnalysis, getLocalizationStatus } from '../services/localizationService';
import { useProject } from '../context/ProjectContext';
import { createApiClient } from '../utils/apiClient';
import JiraDefectButton from '../components/features/JiraDefectButton';
import UrlScopeWarning from '../components/common/UrlScopeWarning';

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

    // Heuristic progress state — same pattern used in AccessibilityScanner.
    const [analyzeProgress, setAnalyzeProgress] = useState(0);
    const [analyzePhaseLabel, setAnalyzePhaseLabel] = useState('');
    const [analyzeFailed, setAnalyzeFailed] = useState(false);
    const pollRef = useRef(null);

    // Per-issue JIRA logging state. Keys are `loc-${idx}` since localization
    // issues have no stable id — reset on every analyze run so badges don't
    // leak across scans.
    const [jiraState, setJiraState] = useState({});

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
        try {
            setError(null);
            await launchBrowser(url);
            setIsBrowserActive(true);
        } catch (err) {
            setError("Failed to launch browser. Ensure server is running.");
        }
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
