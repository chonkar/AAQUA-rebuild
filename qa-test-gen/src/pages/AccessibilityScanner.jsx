import React, { useState } from 'react';
import { Play, Search, AlertTriangle, CheckCircle, ExternalLink, Loader2, User, Sparkles, BrainCircuit } from 'lucide-react';
import { launchBrowser, runAccessibilityScan } from '../services/accessibilityService';

const AccessibilityScanner = () => {
    const [url, setUrl] = useState('');
    const [isBrowserActive, setIsBrowserActive] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [results, setResults] = useState(null);
    const [scanHistory, setScanHistory] = useState([]);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('violations');

    const handleLaunch = async () => {
        try {
            setError(null);
            await launchBrowser(url);
            setIsBrowserActive(true);
        } catch (err) {
            setError("Failed to launch browser. Ensure server is running.");
        }
    };

    const handleScan = async () => {
        try {
            setIsScanning(true);
            setError(null);
            const response = await fetch('/api/analyze-accessibility', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': import.meta.env.VITE_LLM_API_KEY // Send key for AI audit
                }
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
        } catch (err) {
            setError(err.message);
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

    return (
        <div className="accessibility-scanner animate-fade-in">
            <div className="page-header">
                <h2><User className="inline-icon" /> Hybrid Accessibility Scanner (WCAG 2.2)</h2>
                <p>Detect violations using Axe-core automation + AI Expert Audit.</p>
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
                    </div>

                    <div className="action-area">
                        <button
                            onClick={handleScan}
                            disabled={!isBrowserActive || isScanning}
                            className="btn btn-accent full-width"
                        >
                            {isScanning ? <Loader2 className="spin" /> : <Search size={18} />}
                            {isScanning ? "Scanning..." : "Scan Page"}
                        </button>
                    </div>

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
                                    <div className={`release-badge ${results.aiAudit?.releasability === 'Ready' ? 'badge-success' : 'badge-error'}`}>
                                        {results.aiAudit?.releasability === 'Ready' ? '✅ READY FOR RELEASE' : '❌ NOT READY FOR RELEASE'}
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
                            {results.violations.map((violation, idx) => (
                                <div key={`axe-${idx}`} className={`violation-card ${getImpactColor(violation.impact)}`}>
                                    <div className="violation-header">
                                        <span className="violation-impact">{violation.impact ? violation.impact.toUpperCase() : 'UNKNOWN'}</span>
                                        <span className="violation-id">{violation.id}</span>
                                        {violation.helpUrl && (
                                            <a href={violation.helpUrl} target="_blank" rel="noopener noreferrer" className="help-link">
                                                <ExternalLink size={14} /> WCAG Help
                                            </a>
                                        )}
                                    </div>
                                    <p className="violation-desc">{violation.description}</p>
                                    <p className="violation-help">{violation.help}</p>

                                    <div className="violation-nodes">
                                        {violation.nodes && violation.nodes.map((node, nIdx) => (
                                            <code key={nIdx} className="node-selector">{node.target && node.target.join(' ')}</code>
                                        ))}
                                    </div>
                                </div>
                            ))}

                            {/* AI Violations Merged Here */}
                            {results.aiAudit && results.aiAudit.issues && results.aiAudit.issues.length > 0 && (
                                <div className="ai-section-divider">
                                    <h3><Sparkles size={18} className="text-accent" /> AI Expert Analysis</h3>
                                    <p>Issues detected by AI, passed automated checks but require attention.</p>

                                    <div className="ai-issues-list">
                                        {results.aiAudit.issues.map((issue, idx) => (
                                            <div key={`ai-${idx}`} className={`ai-issue-card ${issue.severity.toLowerCase()}`}>
                                                <div className="issue-header">
                                                    <span className={`severity-badge ${issue.severity.toLowerCase()}`}>{issue.severity}</span>
                                                    <span className="wcag-ref">{issue.wcag}</span>
                                                    <div className="affected-users">
                                                        {issue.affectedUsers.map((u, i) => <span key={i} className="user-tag">{u}</span>)}
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
                                        ))}
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
                                        {results.aiAudit.issues.map((issue, idx) => (
                                            <div key={idx} className={`ai-issue-card ${issue.severity.toLowerCase()}`}>
                                                <div className="issue-header">
                                                    <span className={`severity-badge ${issue.severity.toLowerCase()}`}>{issue.severity}</span>
                                                    <span className="wcag-ref">{issue.wcag}</span>
                                                    <div className="affected-users">
                                                        {issue.affectedUsers.map((u, i) => <span key={i} className="user-tag">{u}</span>)}
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
                                        ))}
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
                .full-width { width: 100%; display: flex; justify-content: center; gap: 0.5rem; }

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
