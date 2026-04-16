import React, { useState } from 'react';
import { Globe, Play, Search, AlertTriangle, CheckCircle, ExternalLink, Loader2 } from 'lucide-react';
import { launchBrowser, capturePage, analyzeLocalization } from '../services/localizationService';

const LocalizationTester = () => {
    const [url, setUrl] = useState('');
    const [targetLanguage, setTargetLanguage] = useState('Arabic');
    const [isBrowserActive, setIsBrowserActive] = useState(false);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [issues, setIssues] = useState([]);
    const [error, setError] = useState(null);

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
        try {
            setIsAnalyzing(true);
            setError(null);

            // 1. Capture HTML
            const { html } = await capturePage();

            // 2. Analyze with AI
            const apiKey = import.meta.env.VITE_LLM_API_KEY;
            if (!apiKey) throw new Error("API Key missing");

            const result = await analyzeLocalization(html, targetLanguage, apiKey);
            setIssues(result.issues || []);

        } catch (err) {
            setError(err.message);
        } finally {
            setIsAnalyzing(false);
        }
    };

    return (
        <div className="localization-tester animate-fade-in">
            <div className="page-header">
                <h2><Globe className="inline-icon" /> Localization Tester</h2>
                <p>Detect English text leakage on localized pages.</p>
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
                            className="btn btn-accent full-width"
                        >
                            {isAnalyzing ? <Loader2 className="spin" /> : <Search size={18} />}
                            {isAnalyzing ? "Analyzing..." : "Analyze Current Page"}
                        </button>
                        <p className="hint">
                            Navigate manually in the opened browser window, then click Analyze.
                        </p>
                    </div>

                    {error && (
                        <div className="error-banner">
                            <AlertTriangle size={18} /> {error}
                        </div>
                    )}
                </div>

                <div className="results-panel">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                        <h3 style={{ margin: 0 }}>Analysis Results</h3>
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
                    {issues.length === 0 && !isAnalyzing ? (
                        <div className="empty-state">
                            <CheckCircle size={48} className="text-muted" />
                            <p>No issues detected yet. Start analysis.</p>
                        </div>
                    ) : (
                        <div className="issues-list">
                            {issues.map((issue, idx) => (
                                <div key={idx} className="issue-card">
                                    <div className="issue-header">
                                        <span className="badge-warning">LEAK</span>
                                        <span className="context">{issue.context}</span>
                                    </div>
                                    <div className="issue-body">
                                        <div className="original">"{issue.original}"</div>
                                        <div className="arrow">→</div>
                                        <div className="suggestion">{issue.suggestion}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <style>{`
                .localization-tester { max-width: 1000px; margin: 0 auto; }
                .inline-icon { display: inline; vertical-align: middle; margin-right: 0.5rem; }
                
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
            `}</style>
        </div>
    );
};

export default LocalizationTester;
