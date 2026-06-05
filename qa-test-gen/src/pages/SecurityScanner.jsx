import React, { useState, useEffect, useRef } from 'react';
import { ShieldCheck, Play, Loader2, AlertTriangle, CheckCircle, XCircle, BarChart3, Shield, RefreshCw, Download, Clock, TrendingUp, Eye, BrainCircuit, Sparkles, ChevronDown, ChevronUp, StopCircle, Info } from 'lucide-react';
import { useAuth } from 'react-oidc-context';
import { createApiClient } from '../utils/apiClient';
import { useProject } from '../context/ProjectContext';
import JiraDefectButton from '../components/features/JiraDefectButton';

// BASE_URL handles dev (Vite proxies `/api`) and QA (shared-nginx routes
// `/aaqua/api`). Hardcoded localhost:3001 worked in dev but 404'd in QA.
const API_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '');
const API = `${API_PREFIX}/api/security`;
const PROJECTS_API = `${API_PREFIX}/api/projects`;

const SecurityScanner = () => {
    // ─── Auth state (Keycloak OIDC) ──────────────────────
    const auth = useAuth();
    const token = auth.user?.access_token || '';
    const api = createApiClient(() => token);

    // ─── Active project (driven by the global header selector) ─────────
    const { selectedProject } = useProject();
    const [dashboardData, setDashboardData] = useState(null);
    const [scanHistory, setScanHistory] = useState([]);

    // ─── Scan state ──────────────────────────────────────
    const [scanType, setScanType] = useState('baseline');
    const [scanLoading, setScanLoading] = useState(false);
    const [activeScan, setActiveScan] = useState(null);
    const [scanResults, setScanResults] = useState(null);
    const [governance, setGovernance] = useState(null);
    const [scanLogs, setScanLogs] = useState([]);
    const [logsExpanded, setLogsExpanded] = useState(true);
    const scanLogCursorRef = useRef(0);
    const logsEndRef = useRef(null);

    // ─── General ─────────────────────────────────────────
    const [error, setError] = useState('');
    const [zapHealth, setZapHealth] = useState(null);
    const pollRef = useRef(null);

    // Per-vulnerability JIRA logging state, keyed by vuln.id.
    // { status: 'idle'|'logging'|'logged'|'error', key?, url?, error? }
    const [jiraState, setJiraState] = useState({});

    const headers = () => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    });

    // ─── Project context handlers ────────────────────────
    // The project itself is owned by the global header selector; this page
    // only consumes selectedProject and (re)loads scan history + dashboard
    // whenever the user switches projects.

    // Raise a JIRA ticket for a single vulnerability. Persists the resulting
    // key on the backend (Vulnerability.jira_ticket_key) AND updates the
    // local scanResults so the badge sticks after the round-trip.
    const logJiraDefect = async (vuln) => {
        const issueKey = vuln.id;
        setJiraState(prev => ({ ...prev, [issueKey]: { status: 'logging' } }));
        try {
            const data = await api.post('/api/jira/vulnerability-defect', { vulnerabilityId: vuln.id });
            setJiraState(prev => ({
                ...prev,
                [issueKey]: { status: 'logged', key: data.key, url: data.url },
            }));
            // Mirror the key onto the local results so a re-render shows it
            // even before the next scan fetch.
            setScanResults(prev => prev ? ({
                ...prev,
                vulnerabilities: prev.vulnerabilities.map(v =>
                    v.id === vuln.id ? { ...v, jira_ticket_key: data.key } : v
                ),
            }) : prev);
        } catch (err) {
            setJiraState(prev => ({
                ...prev,
                [issueKey]: { status: 'error', error: err.message || 'Failed to raise JIRA ticket' },
            }));
        }
    };

    const loadProjectContext = async (project) => {
        setScanResults(null);
        setGovernance(null);
        setActiveScan(null);
        setScanHistory([]);
        setDashboardData(null);
        setJiraState({});
        if (!project) return;
        try {
            const projRes = await fetch(`${PROJECTS_API}/${project.id}`, { headers: headers() });
            const projData = await projRes.json();
            if (projRes.ok) setScanHistory(projData.project.scans || []);

            const res = await fetch(`${API}/dashboard/summary/${project.id}`, { headers: headers() });
            const data = await res.json();
            if (res.ok) setDashboardData(data);
        } catch (_err) { /* ignored */ }
    };

    const downloadReport = async (scanId, scanType, scanDate) => {
        setError('');
        try {
            const res = await fetch(`${API}/scan/report/${scanId}/download`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || 'Failed to generate report.');
            }

            // Extract the filename from Content-Disposition if exposed, otherwise construct it
            let filename = '';
            const disposition = res.headers.get('Content-Disposition');
            if (disposition && disposition.indexOf('attachment') !== -1) {
                const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
                const matches = filenameRegex.exec(disposition);
                if (matches != null && matches[1]) { 
                    filename = matches[1].replace(/['"]/g, '');
                }
            }

            // Fallback to client-side formatted date and time if header is missing
            if (!filename) {
                const dateObj = new Date(scanDate || Date.now());
                const formattedDate = dateObj.getFullYear() + '-' +
                    String(dateObj.getMonth() + 1).padStart(2, '0') + '-' +
                    String(dateObj.getDate()).padStart(2, '0');
                const formattedTime = String(dateObj.getHours()).padStart(2, '0') + '-' +
                    String(dateObj.getMinutes()).padStart(2, '0') + '-' +
                    String(dateObj.getSeconds()).padStart(2, '0');
                filename = `Security_Scan_Report_${scanType}_${formattedDate}_${formattedTime}.docx`;
            }

            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            
            // Delay revocation to ensure the browser captures the filename and starts downloading before blob is destroyed
            setTimeout(() => {
                window.URL.revokeObjectURL(url);
                a.remove();
            }, 5000);
        } catch (err) {
            setError('Failed to download report: ' + err.message);
        }
    };

    const handleViewHistoryResults = async (scanId) => {
        setScanLoading(true);
        setError('');
        setScanResults(null);
        setGovernance(null);
        try {
            await fetchScanResults(scanId);
            await fetchGovernance(scanId);
            const res = await fetch(`${API}/scan/status/${scanId}`, { headers: headers() });
            const data = await res.ok ? await res.json() : null;
            setActiveScan(data);
        } catch (err) {
            setError('Failed to fetch historical scan results.');
        } finally {
            setScanLoading(false);
        }
    };

    // ─── Scan handlers ──────────────────────────────────

    const startScan = async () => {
        setError('');
        setScanLoading(true);
        setScanResults(null);
        setGovernance(null);
        setScanLogs([]);
        setJiraState({});
        scanLogCursorRef.current = 0;
        try {
            const data = await api.post(`${API}/scan/start`, {
                project_id: selectedProject.id,
                scan_type: scanType,
            });
            setActiveScan(data.scan);
            startPolling(data.scan.id);
        } catch (err) {
            setError(err.message);
            setScanLoading(false);
        }
    };

    const handleStopScan = async (scanId) => {
        setError('');
        try {
            const res = await fetch(`${API}/scan/stop/${scanId}`, {
                method: 'POST',
                headers: headers(),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to stop scan.');

            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
            }

            setActiveScan(null);
            setScanLoading(false);
            setScanResults(null);
            setGovernance(null);

            await loadProjectContext(selectedProject);
        } catch (err) {
            setError(err.message);
        }
    };

    const startPolling = (scanId) => {
        if (pollRef.current) clearInterval(pollRef.current);
        // 2s poll: a little tighter than the original 3s because the log panel
        // makes lag visible. Still well within the existing infra's request
        // budget (ZAP scans run for minutes).
        pollRef.current = setInterval(async () => {
            try {
                const data = await api.get(`${API}/scan/status/${scanId}?since=${scanLogCursorRef.current}`);
                setActiveScan(data);
                if (Array.isArray(data.logs) && data.logs.length > 0) {
                    setScanLogs(prev => [...prev, ...data.logs]);
                }
                if (typeof data.cursor === 'number') scanLogCursorRef.current = data.cursor;

                if (data.status === 'completed' || data.status === 'failed') {
                    clearInterval(pollRef.current);
                    pollRef.current = null;
                    setScanLoading(false);

                    if (data.status === 'completed') {
                        await fetchScanResults(scanId);
                        await fetchGovernance(scanId);
                        // Refresh dashboard
                        const dashRes = await fetch(`${API}/dashboard/summary/${selectedProject.id}`, { headers: headers() });
                        const dashData = await dashRes.json();
                        if (dashRes.ok) setDashboardData(dashData);

                        // Refresh scan history
                        const projRes = await fetch(`${PROJECTS_API}/${selectedProject.id}`, { headers: headers() });
                        const projData = await projRes.json();
                        if (projRes.ok) setScanHistory(projData.project.scans || []);
                    } else if (data.status === 'failed') {
                        const errorMsg = data.error_message || data.error || 'Scan execution failed';
                        if (errorMsg.includes('429') || errorMsg.toLowerCase().includes('quota') || errorMsg.toLowerCase().includes('rate limit')) {
                            setError('AI Rate Limit Reached: The scan finished but AI analysis was throttled. Please wait a few minutes before trying again or check your Local LLM configuration.');
                        } else {
                            setError(`Security Scan Failed: ${errorMsg}`);
                        }

                        // Refresh scan history
                        const projRes = await fetch(`${PROJECTS_API}/${selectedProject.id}`, { headers: headers() });
                        const projData = await projRes.json();
                        if (projRes.ok) setScanHistory(projData.project.scans || []);
                    }
                }
            } catch (_err) { /* ignored */ }
        }, 3000);
    };

    // Auto-scroll the log panel to the bottom when new lines arrive.
    useEffect(() => {
        if (logsExpanded && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
    }, [scanLogs, logsExpanded]);

    const fetchScanResults = async (scanId) => {
        try {
            const res = await fetch(`${API}/scan/results/${scanId}`, { headers: headers() });
            const data = await res.json();
            if (res.ok) setScanResults(data);
        } catch (_err) { /* ignored */ }
    };

    const fetchGovernance = async (scanId) => {
        try {
            const res = await fetch(`${API}/governance/release-check/${scanId}`, { headers: headers() });
            const data = await res.json();
            if (res.ok) setGovernance(data);
        } catch (_err) { /* ignored */ }
    };

    // ─── ZAP health ──────────────────────────────────────

    const checkZapHealth = async () => {
        try {
            // ZAP health is unauthenticated by design, but we still go through the
            // api client so the BASE_URL prefix (/aaqua in QA) is applied. A raw
            // fetch('/api/...') bypasses the prefix and 404s at shared-nginx.
            const data = await api.get(`${API}/zap/health`);
            setZapHealth(data || { status: 'error', error: 'Empty response' });
        } catch {
            setZapHealth({ status: 'error', error: 'Unreachable' });
        }
    };

    // ─── Effects ─────────────────────────────────────────

    useEffect(() => {
        checkZapHealth();
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reload scan history + dashboard whenever the user picks a different
    // project in the global header. Re-keying on selectedProject?.id (not
    // the object reference) avoids spurious reloads on unrelated rerenders.
    useEffect(() => {
        loadProjectContext(selectedProject);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedProject?.id]);

    // ─── Helpers ────────────────────────────────────────

    const getRiskColor = (risk) => {
        const map = { Critical: '#ef4444', High: '#f97316', Medium: '#eab308', Low: '#22c55e', Informational: '#6b7280' };
        return map[risk] || '#6b7280';
    };

    const getStatusIcon = (status) => {
        switch (status) {
            case 'completed': return <CheckCircle size={16} style={{ color: '#22c55e' }} />;
            case 'failed': return <XCircle size={16} style={{ color: '#ef4444' }} />;
            case 'running': case 'spidering': case 'scanning': case 'analyzing':
                return <Loader2 size={16} className="spin" style={{ color: 'var(--accent-primary)' }} />;
            default: return <Clock size={16} style={{ color: '#6b7280' }} />;
        }
    };

    // ─── RENDER: Main App ────────────────────────────────

    return (
        <div className="security-scanner animate-fade-in">
            <div className="page-header-premium">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <h2><ShieldCheck size={32} /> AI Secure Engine</h2>
                        <p>Enterprise-grade security scanning & governance</p>
                    </div>
                    <div className="status-badge-container">
                        <span className={`zap-status-pill ${zapHealth?.status === 'ok' ? 'online' : 'offline'}`}>
                            {zapHealth?.status === 'ok' ? '● ZAP Engine Active' : '○ Engine Offline'}
                        </span>
                    </div>
                </div>
            </div>

            {error && (
                <div className="error-banner-premium">
                    <AlertTriangle size={16} />
                    {error}
                    <button onClick={() => setError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>✕</button>
                </div>
            )}

            {/* ─── No project selected ─── */}
            {!selectedProject && (
                <div className="no-project-selected">
                    <Info size={48} />
                    <h3>No Project Context Active</h3>
                    <p>Pick a project from the header dropdown (or create one with the <strong>+</strong> button) to view its scan history and trigger new security scans.</p>
                </div>
            )}

            {/* ─── Project Scan Hub ─── */}
            {selectedProject && (
                <div className="section">
                    <div className="project-scan-header">
                        <div>
                            <h3 style={{ fontSize: '1.8rem', margin: 0, display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <Shield size={26} style={{ color: 'var(--accent-primary)' }} />
                                {selectedProject.name}
                                <span className="scan-count-chip" title={`${scanHistory.length} scan(s) recorded for this project`}>
                                    {scanHistory.length} {scanHistory.length === 1 ? 'scan' : 'scans'}
                                </span>
                            </h3>
                            <p style={{ color: 'var(--text-muted)', marginTop: '4px' }}>Project Security Intelligence Hub</p>
                        </div>
                        <div className="url-display" style={{ margin: 0 }}>{selectedProject.target_url}</div>
                    </div>

                    {/* Scan Controls */}
                    <div className="scan-controls" style={{ background: 'var(--bg-tertiary)', flexDirection: 'column', alignItems: 'stretch' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                            <div className="scan-type-selector" style={{ margin: 0 }}>
                                {['passive', 'baseline', 'active', 'fuzzer', 'api'].map(t => (
                                    <button
                                        key={t}
                                        className={`scan-type-btn ${scanType === t ? 'active' : ''}`}
                                        onClick={() => setScanType(t)}
                                        disabled={scanLoading}
                                    >
                                        {t === 'passive' && '🕵️ Passive'}
                                        {t === 'baseline' && '🔍 Baseline'}
                                        {t === 'active' && '⚡ Active Attack'}
                                        {t === 'fuzzer' && '🔥 Fuzz Testing'}
                                        {t === 'api' && '📊 API Audit'}
                                    </button>
                                ))}
                            </div>
                            <button className="btn btn-primary" onClick={startScan} disabled={scanLoading || zapHealth?.status !== 'ok'}>
                                {scanLoading ? <><Loader2 className="spin" size={18} /> Scanning...</> : <><Play size={18} /> Trigger Scan</>}
                            </button>
                        </div>

                        <div className="scan-mode-info" style={{ padding: '1rem', background: 'var(--bg-primary)', borderRadius: '8px', border: '1px solid var(--border-color)', fontSize: '0.85rem' }}>
                            <h5 style={{ marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <Sparkles size={14} style={{ color: 'var(--accent-primary)' }} /> Scan Mode Guide
                            </h5>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                                <div>
                                    <p><strong>Passive:</strong> Surface-level discovery without attacking. Safe for production.</p>
                                    <p><strong>Baseline:</strong> Standard spidering + passive analysis. Good for initial audits.</p>
                                </div>
                                <div>
                                    <p><strong>Active Attack:</strong> Deeply crawls and actively attempts to exploit vulnerabilities.</p>
                                    <p><strong>Fuzz Testing:</strong> Aggressive input-based testing to find hidden logic flaws.</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Scan Progress */}
                    {activeScan && scanLoading && (
                        <div className="scan-progress-card" style={{ border: '1px solid var(--accent-primary)', background: 'var(--bg-secondary)' }}>
                            <div className="scan-progress-header">
                                <RefreshCw className="spin" size={20} style={{ color: 'var(--accent-primary)' }} />
                                <span>Execution Phase: <strong>{activeScan.status}</strong></span>
                                <span className="scan-status-badge">{activeScan.progress || 0}%</span>
                            </div>
                            <div className="progress-bar" style={{ background: 'var(--bg-primary)' }}>
                                <div className="progress-fill" style={{ width: `${activeScan.progress || 5}%` }} />
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', flexWrap: 'wrap', gap: '1rem' }}>
                                <p className="scan-progress-text" style={{ margin: 0 }}>System is currently performing {activeScan.scan_type} analysis on target endpoint.</p>
                                <button 
                                    className="btn-danger" 
                                    style={{ 
                                        background: 'rgba(239, 68, 68, 0.1)', 
                                        color: '#ef4444', 
                                        border: '1px solid #ef4444',
                                        borderRadius: '6px',
                                        padding: '6px 14px',
                                        fontSize: '0.85rem',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '6px',
                                        fontWeight: '600',
                                        cursor: 'pointer',
                                        transition: 'all 0.2s ease',
                                        boxShadow: '0 0 10px rgba(239, 68, 68, 0.15)'
                                    }}
                                    onMouseEnter={(e) => {
                                        e.target.style.background = 'rgba(239, 68, 68, 0.2)';
                                        e.target.style.boxShadow = '0 0 15px rgba(239, 68, 68, 0.3)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.target.style.background = 'rgba(239, 68, 68, 0.1)';
                                        e.target.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.15)';
                                    }}
                                    onClick={() => handleStopScan(activeScan.id)}
                                >
                                    <StopCircle size={14} /> Stop Scan
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Scan Log Panel — tail of zapService + executeScan output */}
                    {scanLogs.length > 0 && (
                        <div className="scan-log-card">
                            <div className="scan-log-header" onClick={() => setLogsExpanded(v => !v)}>
                                {logsExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                                <span>Scan logs ({scanLogs.length})</span>
                                {scanLoading && <span className="scan-log-live">● LIVE</span>}
                            </div>
                            {logsExpanded && (
                                <pre className="scan-log-body">
                                    {scanLogs.join('\n')}
                                    <div ref={logsEndRef} />
                                </pre>
                            )}
                        </div>
                    )}

                    {/* Governance Gate Result */}
                    {governance && (
                        <div className={`governance-card ${governance.release_blocked ? 'blocked' : 'approved'}`} style={{ borderLeftWidth: '6px' }}>
                            <div className="governance-header">
                                {governance.release_blocked ? <XCircle size={32} style={{ color: 'var(--error)' }} /> : <CheckCircle size={32} style={{ color: 'var(--success)' }} />}
                                <div>
                                    <h4 style={{ fontSize: '1.2rem' }}>{governance.release_blocked ? 'Policy Violation: Release Blocked' : 'Security Compliance: Approved'}</h4>
                                    <p>Security Posture Score: {governance.metrics?.health_score !== undefined && governance.metrics?.health_score !== null ? governance.metrics.health_score.toFixed(1) : '—'}/10 (Policy Gate Limit: 6.0/10)</p>
                                </div>
                                <div style={{ marginLeft: 'auto' }}>
                                    <span style={{ fontSize: '0.8rem', background: 'var(--bg-primary)', padding: '4px 10px', borderRadius: '4px' }}>
                                        {governance.metrics?.regressions || 0} Regressions Found
                                    </span>
                                </div>
                            </div>
                            {governance.executive_summary && (
                                <div className="executive-summary" style={{ background: 'var(--bg-primary)', opacity: 0.8 }}>
                                    {governance.executive_summary}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Scan Results Dashboard */}
                    {scanResults && (
                        <div className="results-section">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
                                <h3 className="results-title" style={{ margin: 0 }}><BarChart3 size={20} /> Latest Analysis Findings</h3>
                                <button 
                                    className="btn-ghost" 
                                    style={{ background: 'var(--accent-glow)', borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)', fontWeight: 'bold' }}
                                    onClick={() => downloadReport(scanResults.scan.id, scanResults.scan.scan_type, scanResults.scan.started_at || scanResults.scan.created_at)}
                                >
                                    <Download size={16} /> Download Report
                                </button>
                            </div>

                            <div className="stats-row-premium">
                                {[
                                    { label: 'Overall Score', value: (governance?.metrics?.health_score !== undefined && governance?.metrics?.health_score !== null) ? `${governance.metrics.health_score}/10` : '—', color: 'var(--accent-primary)' },
                                    { label: 'Total', value: scanResults.summary.total, color: 'var(--text-primary)' },
                                    { label: 'Critical', value: scanResults.summary.critical, color: 'var(--error)' },
                                    { label: 'High', value: scanResults.summary.high, color: '#f97316' },
                                    { label: 'Medium', value: scanResults.summary.medium, color: 'var(--warning)' },
                                    { label: 'Low', value: scanResults.summary.low, color: 'var(--success)' },
                                    { label: 'Regressions', value: scanResults.summary.regressions, color: '#a855f7' },
                                    { label: 'Scan Date', value: scanResults.scan?.completed_at ? new Date(scanResults.scan.completed_at).toLocaleDateString() : new Date(scanResults.scan?.started_at || Date.now()).toLocaleDateString(), color: 'var(--accent-secondary)' },
                                ].map(c => (
                                    <div key={c.label} className="stat-card-premium">
                                        <span className="value" style={{ color: c.color }}>{c.value}</span>
                                        <span className="label">{c.label}</span>
                                    </div>
                                ))}
                            </div>

                            {/* OWASP Breakdown */}
                            {Object.keys(scanResults.owasp_breakdown || {}).length > 0 && (
                                <div className="owasp-section card" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
                                    <h4 style={{ marginBottom: '1.25rem', color: 'var(--accent-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <BrainCircuit size={20} /> OWASP Top 10 Coverage
                                    </h4>
                                    <div className="owasp-bars">
                                        {Object.entries(scanResults.owasp_breakdown).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
                                            <div key={cat} className="owasp-bar-row">
                                                <span className="owasp-label" title={cat}>{cat}</span>
                                                <div className="owasp-bar-track" style={{ background: 'var(--bg-primary)' }}>
                                                    <div className="owasp-bar-fill" style={{ width: `${Math.min((count / scanResults.summary.total) * 100, 100)}%`, background: 'var(--accent-primary)' }} />
                                                </div>
                                                <span className="owasp-count">{count}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div style={{ marginTop: '2rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
                                <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <Shield size={20} /> Vulnerability Intelligence ({scanResults.vulnerabilities.length})
                                </h4>
                                <div className="severity-legend" aria-label="Severity color key">
                                    {[
                                        { risk: 'Critical', desc: 'Immediate exploit; release-blocking' },
                                        { risk: 'High', desc: 'Serious exposure; fix this sprint' },
                                        { risk: 'Medium', desc: 'Notable risk; plan a fix' },
                                        { risk: 'Low', desc: 'Minor; address opportunistically' },
                                        { risk: 'Informational', desc: 'Hardening hint; no exploit' },
                                    ].map(item => (
                                        <span key={item.risk} className="severity-legend-item" title={item.desc}>
                                            <span className="severity-legend-swatch" style={{ background: getRiskColor(item.risk) }} />
                                            {item.risk}
                                        </span>
                                    ))}
                                </div>
                            </div>
                            <div className="vuln-list">
                                {scanResults.vulnerabilities.map((v, i) => (
                                    <VulnCard
                                        key={v.id || i}
                                        vuln={v}
                                        jiraSlice={jiraState[v.id]}
                                        onLogJira={() => logJiraDefect(v)}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Dashboard (historical data when no active scan) */}
                    {!scanResults && dashboardData && (
                        <div className="dashboard-section">
                            <h3 className="results-title"><TrendingUp size={20} /> Security Posture Overview</h3>
                            <div className="stats-row-premium">
                                {[
                                    { label: 'Total Scans', value: dashboardData.stats.total_scans, color: 'var(--text-primary)' },
                                    { label: 'Overall Score', value: (dashboardData.stats.avg_health_score !== undefined && dashboardData.stats.avg_health_score !== null) ? `${dashboardData.stats.avg_health_score.toFixed(1)}/10` : '—', color: 'var(--accent-primary)' },
                                    { label: 'Active Issues', value: dashboardData.stats.total_vulnerabilities, color: 'var(--warning)' },
                                    { label: 'Risk Exposure', value: `${dashboardData.stats.critical_high_pct?.toFixed(1)}%`, color: '#f97316' },
                                    { label: 'Policy Status', value: dashboardData.stats.release_status || 'N/A', color: dashboardData.stats.release_status === 'APPROVED' ? 'var(--success)' : 'var(--error)' },
                                    { label: 'Last Scan', value: dashboardData.stats.last_scan_date ? new Date(dashboardData.stats.last_scan_date).toLocaleDateString() : 'N/A', color: 'var(--accent-secondary)' },
                                ].map(c => (
                                    <div key={c.label} className="stat-card-premium">
                                        <span className="value" style={{ color: c.color }}>{c.value}</span>
                                        <span className="label">{c.label}</span>
                                    </div>
                                ))}
                            </div>

                            {dashboardData.top_vulnerabilities?.length > 0 && (
                                <div className="card" style={{ marginBottom: '2rem' }}>
                                    <h4 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <AlertTriangle size={20} style={{ color: 'var(--warning)' }} /> Highest Priority Risks
                                    </h4>
                                    <div className="vuln-list">
                                        {dashboardData.top_vulnerabilities.map((v, i) => (
                                            <div key={i} className="vuln-mini" style={{ padding: '12px', background: 'var(--bg-primary)', borderRadius: '8px', marginBottom: '8px', border: '1px solid var(--border-color)' }}>
                                                <span className="risk-badge" style={{ background: getRiskColor(v.risk), minWidth: '80px', textAlign: 'center' }}>{v.risk}</span>
                                                <span className="vuln-name" style={{ flex: 1, marginLeft: '12px' }}>{v.name}</span>
                                                {v.is_regression && <span className="regression-tag">REGRESSION</span>}
                                                <span className="vuln-score" style={{ color: 'var(--accent-secondary)' }}>Score: {(typeof v.risk_score === 'number') ? v.risk_score.toFixed(1) : 'N/A'}/10</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {dashboardData.executive_summary && (
                                <div className="exec-summary-box" style={{ background: 'var(--bg-tertiary)', borderLeft: '4px solid var(--accent-primary)', marginBottom: '2rem' }}>
                                    <h4 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <Sparkles size={18} style={{ color: 'var(--accent-primary)' }} /> AI Executive Summary
                                    </h4>
                                    <div style={{ color: 'var(--text-secondary)', lineHeight: '1.6', whiteSpace: 'pre-wrap', fontSize: '0.95rem', marginTop: '10px' }}>
                                        {dashboardData.executive_summary}
                                    </div>
                                </div>
                            )}

                            {/* Security Scan History (Up to 30 Scans) */}
                            <div className="card" style={{ marginTop: '2rem', padding: '1.5rem', marginBottom: '2rem', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)' }}>
                                <h4 style={{ marginBottom: '1.25rem', color: 'var(--accent-secondary)', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.1rem' }}>
                                    <Clock size={20} /> Security Scan Execution History (Up to 30 Scans)
                                </h4>
                                
                                {scanHistory && scanHistory.length > 0 ? (
                                    <div style={{ overflowX: 'auto' }}>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                                            <thead>
                                                <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left', background: 'var(--bg-primary)' }}>
                                                    <th style={{ padding: '12px 10px' }}>Scan Type</th>
                                                    <th style={{ padding: '12px 10px' }}>Execution Date</th>
                                                    <th style={{ padding: '12px 10px' }}>Status</th>
                                                    <th style={{ padding: '12px 10px' }}>Governance Gate</th>
                                                    <th style={{ padding: '12px 10px' }}>Findings Breakdown</th>
                                                    <th style={{ padding: '12px 10px', textAlign: 'center' }}>Actions</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {scanHistory.map((scan) => {
                                                    const isBlocked = scan.governance?.release_blocked;
                                                    return (
                                                        <tr key={scan.id} style={{ borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' }} className="table-row-hover">
                                                            <td style={{ padding: '12px 10px', textTransform: 'capitalize', fontWeight: '600', color: 'var(--text-primary)' }}>{scan.scan_type}</td>
                                                            <td style={{ padding: '12px 10px' }}>{new Date(scan.started_at || scan.created_at || Date.now()).toLocaleString()}</td>
                                                            <td style={{ padding: '12px 10px' }}>
                                                                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                                    {getStatusIcon(scan.status)}
                                                                    <span style={{ textTransform: 'capitalize', fontSize: '0.8rem' }}>{scan.status}</span>
                                                                </span>
                                                            </td>
                                                            <td style={{ padding: '12px 10px' }}>
                                                                {scan.status === 'completed' ? (
                                                                    <span style={{ 
                                                                        padding: '2px 8px', 
                                                                        borderRadius: '4px', 
                                                                        fontSize: '0.75rem', 
                                                                        fontWeight: '700',
                                                                        background: isBlocked ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.1)',
                                                                        color: isBlocked ? 'var(--error)' : 'var(--success)',
                                                                        border: `1px solid ${isBlocked ? 'rgba(239, 68, 68, 0.2)' : 'rgba(34, 197, 94, 0.2)'}`
                                                                    }}>
                                                                        {isBlocked ? 'BLOCKED' : 'APPROVED'}
                                                                    </span>
                                                                ) : '—'}
                                                            </td>
                                                            <td style={{ padding: '12px 10px' }}>
                                                                {scan.status === 'completed' && scan.governance ? (
                                                                    <div style={{ display: 'flex', gap: '6px', fontSize: '0.75rem', fontWeight: 'bold' }}>
                                                                        <span style={{ background: 'rgba(239, 68, 68, 0.15)', color: 'var(--error)', padding: '1px 6px', borderRadius: '4px' }}>C: {scan.governance.critical_count || 0}</span>
                                                                        <span style={{ background: 'rgba(249, 115, 22, 0.15)', color: '#f97316', padding: '1px 6px', borderRadius: '4px' }}>H: {scan.governance.high_count || 0}</span>
                                                                        <span style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)', padding: '1px 6px', borderRadius: '4px' }}>Total: {scan.governance.total_count || 0}</span>
                                                                    </div>
                                                                ) : '—'}
                                                            </td>
                                                            <td style={{ padding: '12px 10px', display: 'flex', justifyContent: 'center', gap: '8px' }}>
                                                                {scan.status === 'completed' && (
                                                                    <>
                                                                        <button 
                                                                            className="btn-ghost" 
                                                                            style={{ padding: '4px 8px', fontSize: '0.75rem' }} 
                                                                            title="View Scan Results"
                                                                            onClick={() => handleViewHistoryResults(scan.id)}
                                                                        >
                                                                            <Eye size={12} /> View
                                                                        </button>
                                                                        <button 
                                                                            className="btn-ghost" 
                                                                            style={{ padding: '4px 8px', fontSize: '0.75rem', color: 'var(--accent-primary)', borderColor: 'var(--accent-glow)' }} 
                                                                            title="Download Report"
                                                                            onClick={() => downloadReport(scan.id, scan.scan_type, scan.started_at || scan.created_at)}
                                                                        >
                                                                            <Download size={12} /> Download
                                                                        </button>
                                                                    </>
                                                                )}
                                                                {!['completed', 'failed'].includes(scan.status) && (
                                                                    <button 
                                                                        className="btn-ghost" 
                                                                        style={{ 
                                                                            padding: '4px 8px', 
                                                                            fontSize: '0.75rem', 
                                                                            color: 'var(--error)', 
                                                                            borderColor: 'rgba(239, 68, 68, 0.2)' 
                                                                        }} 
                                                                        title="Stop Scan"
                                                                        onClick={() => handleStopScan(scan.id)}
                                                                    >
                                                                        <StopCircle size={12} /> Stop
                                                                    </button>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                ) : (
                                    <p style={{ margin: 0, color: 'var(--text-muted)', textAlign: 'center', padding: '1.5rem' }}>No historical scans have been recorded for this project yet.</p>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {renderStyles()}
        </div>
    );
};

// ─── Vulnerability Card Component ─────────────────────────

const VulnCard = ({ vuln, jiraSlice, onLogJira }) => {
    const [expanded, setExpanded] = useState(false);

    const getRiskColor = (risk) => {
        const map = { Critical: '#ef4444', High: '#f97316', Medium: '#eab308', Low: '#22c55e', Informational: '#6b7280' };
        return map[risk] || '#6b7280';
    };

    // If the backend already auto-created a ticket for this vuln (Critical/High
    // path during scan completion), surface it as the "logged" state so the
    // button is clickable through to JIRA. We construct the deep-link from the
    // user's locally-stored JIRA config since the auto-creation path doesn't
    // persist the URL itself.
    const effectiveJiraSlice = jiraSlice || (vuln.jira_ticket_key ? (() => {
        let jiraBase = '';
        try {
            const cfg = JSON.parse(window.localStorage.getItem('aaqua_jira_config') || '{}');
            if (cfg.url) jiraBase = cfg.url.trim().replace(/\/$/, '');
        } catch { /* localStorage parse error — fall back to key without link */ }
        return {
            status: 'logged',
            key: vuln.jira_ticket_key,
            url: jiraBase ? `${jiraBase}/browse/${vuln.jira_ticket_key}` : '#',
        };
    })() : null);

    return (
        <div className={`vuln-item-premium ${expanded ? 'active' : ''}`}>
            <div className="vuln-header-premium" onClick={() => setExpanded(!expanded)}>
                <div className="severity-indicator" style={{ background: getRiskColor(vuln.risk) }} />
                <div className="vuln-title-group">
                    <h5>{vuln.alert_name}</h5>
                    <span>{vuln.owasp_category || 'General Security'} — Risk Score: {(typeof vuln.risk_score === 'number') ? vuln.risk_score.toFixed(1) : 'N/A'}/10</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }} onClick={(e) => e.stopPropagation()}>
                    {vuln.is_regression && <span className="regression-tag">REGRESSION</span>}
                    {onLogJira && (
                        <JiraDefectButton state={effectiveJiraSlice} onClick={onLogJira} />
                    )}
                    <div onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer', display: 'flex' }}>
                        {expanded ? <ChevronUp size={20} style={{ opacity: 0.6 }} /> : <ChevronDown size={20} style={{ opacity: 0.6 }} />}
                    </div>
                </div>
            </div>

            {expanded && (
                <div className="vuln-details" style={{ padding: '0 1.5rem 1.5rem 1.5rem' }}>
                    {vuln.ai_summary && (
                        <div className="detail-block" style={{ background: 'var(--bg-primary)', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem', borderLeft: '4px solid var(--accent-secondary)' }}>
                            <h5 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                                <BrainCircuit size={16} /> AI Security Insight
                            </h5>
                            <p style={{ margin: 0, fontSize: '0.9rem' }}>{vuln.ai_summary}</p>
                        </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
                        <div className="detail-row"><strong>Target URL:</strong> <code>{vuln.url}</code></div>
                        <div className="detail-row"><strong>CWE ID:</strong> <span className="exploit-badge">CWE-{vuln.cwe_id}</span></div>
                        <div className="detail-row"><strong>Exploitability:</strong> <span className="exploit-badge" style={{ color: 'var(--warning)' }}>{vuln.exploitability}</span></div>
                    </div>

                    {vuln.remediation && (
                        <div className="detail-block remediation">
                            <h5 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Sparkles size={16} /> Remediation Strategy</h5>
                            <pre>{vuln.remediation}</pre>
                        </div>
                    )}

                    {vuln.code_example && (
                        <div className="detail-block code-block">
                            <h5 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Code size={16} /> Secure Implementation Example</h5>
                            <pre><code>{vuln.code_example}</code></pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// ─── Styles ─────────────────────────────────────────────

function renderStyles() {
    return (
        <style>{`
        .security-scanner {
            max-width: 1200px;
            margin: 0 auto;
            padding-bottom: 3rem;
        }

        /* Empty state when no project picked in the header dropdown */
        .no-project-selected {
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            padding: 3rem 1.5rem;
            background: var(--bg-secondary);
            border: 1px dashed var(--border-color);
            border-radius: var(--radius-lg);
            color: var(--text-muted);
            gap: 0.5rem;
        }
        .no-project-selected h3 {
            color: var(--text-primary);
            margin: 0.5rem 0 0.25rem;
        }
        .no-project-selected p {
            max-width: 520px;
            line-height: 1.6;
            margin: 0;
        }

        /* Project-scoped header with scan count chip */
        .project-scan-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 1.5rem;
            margin-bottom: 2rem;
            flex-wrap: wrap;
        }
        .scan-count-chip {
            display: inline-flex;
            align-items: center;
            background: var(--accent-glow);
            color: var(--accent-primary);
            border: 1px solid var(--accent-primary);
            padding: 2px 12px;
            border-radius: 99px;
            font-size: 0.75rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        /* JIRA defect button — shared visual language with other scanner pages */
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
        .jira-defect-btn:disabled { cursor: not-allowed; opacity: 0.7; }
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

        /* Premium Header */
        .page-header-premium {
            background: linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary));
            padding: 2.5rem;
            border-radius: var(--radius-lg);
            border: 1px solid var(--border-color);
            margin-bottom: 2rem;
            box-shadow: var(--shadow-lg);
            position: relative;
            overflow: hidden;
        }
        .page-header-premium::after {
            content: '';
            position: absolute;
            top: -50%;
            right: -10%;
            width: 300px;
            height: 300px;
            background: radial-gradient(circle, var(--accent-glow) 0%, transparent 70%);
            opacity: 0.3;
            pointer-events: none;
        }
        .page-header-premium h2 { 
            margin: 0; 
            font-size: 2rem; 
            font-weight: 800;
            color: var(--text-primary);
            -webkit-text-fill-color: unset;
            background: none;
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }
        .page-header-premium p { 
            margin: 0.5rem 0 0 0; 
            color: var(--text-primary);
            opacity: 0.75;
            font-size: 1.1rem;
        }

        /* Auth Layout */
        .auth-layout {
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 60vh;
        }
        .auth-card-premium {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-lg);
            padding: 2.5rem;
            width: 100%;
            max-width: 450px;
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3), var(--shadow-glow);
        }
        .auth-tabs-premium {
            display: flex;
            background: var(--bg-primary);
            padding: 4px;
            border-radius: var(--radius-md);
            margin-bottom: 2rem;
        }
        .auth-tab-premium {
            flex: 1;
            padding: 0.6rem;
            border: none;
            background: transparent;
            color: var(--text-secondary);
            font-weight: 600;
            cursor: pointer;
            border-radius: var(--radius-sm);
            transition: all 0.2s;
        }
        .auth-tab-premium.active {
            background: var(--bg-tertiary);
            color: var(--accent-primary);
            box-shadow: var(--shadow-sm);
        }

        /* Status Badges */
        .status-badge-container {
            display: flex;
            gap: 0.75rem;
            align-items: center;
        }
        .zap-status-pill {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.8rem;
            font-weight: 700;
            padding: 4px 12px;
            border-radius: 99px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .zap-status-pill.online { background: rgba(16, 185, 129, 0.1); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.2); }
        .zap-status-pill.offline { background: rgba(239, 68, 68, 0.1); color: var(--error); border: 1px solid rgba(239, 68, 68, 0.2); }

        /* Project Grid */
        .projects-grid-premium {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
            gap: 1.5rem;
            margin-top: 1.5rem;
        }
        .project-card-premium {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-lg);
            padding: 1.5rem;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }
        .project-card-premium:hover {
            transform: translateY(-4px);
            border-color: var(--accent-primary);
            box-shadow: 0 10px 30px -10px rgba(0,0,0,0.5), 0 0 15px var(--accent-glow);
        }
        .project-delete-btn {
            background: transparent;
            border: 1px solid transparent;
            color: var(--text-muted);
            border-radius: 6px;
            padding: 6px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
        }
        .project-delete-btn:hover {
            background: rgba(239, 68, 68, 0.1);
            border-color: rgba(239, 68, 68, 0.3);
            color: var(--error);
        }
        .project-card-premium h4 {
            margin: 0 0 0.5rem 0;
            font-size: 1.2rem;
            color: var(--text-primary);
        }
        .url-display {
            font-family: monospace;
            font-size: 0.85rem;
            color: var(--text-muted);
            background: var(--bg-primary);
            padding: 4px 8px;
            border-radius: 4px;
            display: inline-block;
            margin-bottom: 1rem;
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        /* Stats Cards */
        .stats-row-premium {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }
        .stat-card-premium {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            padding: 1.25rem;
            text-align: center;
            transition: all 0.2s;
        }
        .stat-card-premium:hover {
            border-color: var(--accent-secondary);
            background: var(--bg-tertiary);
        }
        .stat-card-premium .value {
            display: block;
            font-size: 1.8rem;
            font-weight: 800;
            margin-bottom: 2px;
        }
        .stat-card-premium .label {
            font-size: 0.75rem;
            font-weight: 700;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        /* Vulnerability Premium */
        .vuln-item-premium {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            margin-bottom: 0.75rem;
            overflow: hidden;
            transition: all 0.2s;
        }
        .vuln-item-premium:hover {
            border-color: var(--text-muted);
        }
        .vuln-item-premium.active {
            border-color: var(--accent-primary);
            box-shadow: 0 0 15px var(--accent-glow);
        }
        .vuln-header-premium {
            padding: 1rem;
            display: flex;
            align-items: center;
            gap: 1rem;
            cursor: pointer;
        }
        .severity-indicator {
            width: 4px;
            height: 40px;
            border-radius: 2px;
        }
        .vuln-title-group { flex: 1; }
        .vuln-title-group h5 { margin: 0; font-size: 1rem; color: var(--text-primary); }
        .vuln-title-group span { font-size: 0.8rem; color: var(--text-muted); }

        /* Animation */
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }

        .form-group-premium {
            margin-bottom: 1.5rem;
        }
        .form-group-premium label {
            display: block;
            margin-bottom: 0.5rem;
            font-size: 0.85rem;
            font-weight: 600;
            color: var(--text-secondary);
        }
        .form-input-premium {
            width: 100%;
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            padding: 0.75rem 1rem;
            border-radius: var(--radius-md);
            outline: none;
            transition: all 0.2s;
        }
        .form-input-premium:focus {
            border-color: var(--accent-primary);
            box-shadow: 0 0 0 2px var(--accent-glow);
        }

        .error-banner-premium {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.2);
            color: var(--error);
            padding: 0.75rem;
            border-radius: var(--radius-md);
            margin-bottom: 1.5rem;
            font-size: 0.85rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
    
        /* Auth */
        .auth-container { display: flex; justify-content: center; padding: 3rem 0; }
        .auth-card {
            background: var(--bg-secondary); border: 1px solid var(--border-color);
            border-radius: var(--radius-lg); padding: 2rem; width: 100%; max-width: 420px;
        }
        .auth-tabs { display: flex; gap: 0; margin-bottom: 1.5rem; border-bottom: 2px solid var(--border-color); }
        .auth-tab {
            flex: 1; padding: 0.75rem; background: none; border: none;
            color: var(--text-muted); font-size: 1rem; cursor: pointer; font-weight: 500;
        }
        .auth-tab.active { color: var(--accent-primary); border-bottom: 2px solid var(--accent-primary); }
        .full-width { width: 100%; display: flex; justify-content: center; gap: 0.5rem; }

        /* Projects */
        .section { margin-bottom: 2rem; }
        .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
        .projects-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
        .project-card {
            background: var(--bg-secondary); border: 1px solid var(--border-color);
            border-radius: var(--radius-lg); padding: 1.25rem; cursor: pointer;
            transition: all 0.2s;
        }
        .project-card:hover { border-color: var(--accent-primary); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .project-card-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
        .project-card-header h4 { margin: 0; color: var(--text-primary); }
        .project-url { font-size: 0.85rem; color: var(--text-muted); word-break: break-all; font-family: monospace; }
        .project-meta { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
        .meta-tag { display: flex; align-items: center; gap: 4px; font-size: 0.8rem; color: var(--text-secondary); background: var(--bg-tertiary); padding: 2px 8px; border-radius: 99px; }

        /* Form */
        .form-card {
            background: var(--bg-secondary); border: 1px solid var(--border-color);
            border-radius: var(--radius-lg); padding: 1.5rem; max-width: 500px;
        }
        .form-card h3 { margin-top: 0; }

        /* Scan Controls */
        .scan-controls {
            display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;
            background: var(--bg-secondary); border: 1px solid var(--border-color);
            border-radius: var(--radius-lg); padding: 1rem;
        }
        .scan-type-selector { display: flex; gap: 0.5rem; flex: 1; }
        .scan-type-btn {
            padding: 0.5rem 1rem; border-radius: var(--radius-md);
            border: 1px solid var(--border-color); background: var(--bg-tertiary);
            color: var(--text-secondary); cursor: pointer; font-size: 0.9rem;
            transition: all 0.2s;
        }
        .scan-type-btn.active { background: var(--accent-primary); color: white; border-color: var(--accent-primary); }
        .scan-type-btn:hover:not(.active):not(:disabled) { border-color: var(--accent-primary); color: var(--text-primary); }
        .scan-info { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1.5rem; }

        /* Scan Progress */
        .scan-progress-card {
            background: var(--bg-secondary); border: 1px solid var(--accent-primary);
            border-radius: var(--radius-lg); padding: 1.25rem; margin-bottom: 1.5rem;
        }
        .scan-progress-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; font-weight: 600; color: var(--text-primary); }
        .scan-status-badge {
            margin-left: auto; padding: 2px 10px; border-radius: 99px;
            font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
            background: var(--accent-glow); color: var(--accent-primary);
        }
        .progress-bar { height: 6px; background: var(--bg-tertiary); border-radius: 99px; overflow: hidden; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary)); border-radius: 99px; transition: width 0.5s ease; }
        .scan-progress-text { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem; }

        /* Scan Log Panel */
        .scan-log-card {
            background: var(--bg-secondary); border: 1px solid var(--border-color);
            border-radius: var(--radius-lg); margin-bottom: 1.5rem; overflow: hidden;
        }
        .scan-log-header {
            display: flex; align-items: center; gap: 0.5rem;
            padding: 0.75rem 1rem; cursor: pointer;
            font-size: 0.85rem; font-weight: 600; color: var(--text-secondary);
            background: var(--bg-tertiary); user-select: none;
        }
        .scan-log-header:hover { color: var(--text-primary); }
        .scan-log-live {
            margin-left: auto; font-size: 0.7rem; color: var(--error); font-weight: 700;
            animation: scanLogPulse 1.2s ease-in-out infinite;
        }
        @keyframes scanLogPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .scan-log-body {
            background: #0d0d14; color: #c4c4c4;
            font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
            font-size: 0.78rem; line-height: 1.5;
            padding: 1rem; margin: 0;
            max-height: 320px; overflow-y: auto;
            white-space: pre-wrap; word-break: break-word;
        }

        /* Governance Card */
        .governance-card {
            border-radius: var(--radius-lg); padding: 1.25rem; margin-bottom: 1.5rem;
            border: 1px solid;
        }
        .governance-card.approved { background: rgba(34, 197, 94, 0.08); border-color: #22c55e; }
        .governance-card.blocked { background: rgba(239, 68, 68, 0.08); border-color: #ef4444; }
        .governance-header { display: flex; align-items: center; gap: 0.75rem; }
        .governance-header h4 { margin: 0; }
        .governance-header p { margin: 0; font-size: 0.85rem; color: var(--text-muted); }
        .executive-summary {
            margin-top: 1rem; padding: 1rem; background: var(--bg-tertiary);
            border-radius: var(--radius-md); font-size: 0.85rem; line-height: 1.6;
            white-space: pre-wrap; font-family: inherit; color: var(--text-secondary);
        }

        /* Summary Cards */
        .summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
        .summary-card {
            background: var(--bg-secondary); border: 1px solid var(--border-color);
            border-radius: var(--radius-lg); padding: 1rem; text-align: center;
        }
        .summary-value { display: block; font-size: 1.8rem; font-weight: 800; }
        .summary-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }

        /* Results */
        .results-section, .dashboard-section { margin-top: 1rem; }
        .results-title {
            display: flex; align-items: center; gap: 0.5rem;
            font-size: 1.3rem; font-weight: 700; margin-bottom: 1rem;
            background: linear-gradient(to right, var(--accent-primary), var(--accent-secondary));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }

        /* OWASP bars */
        .owasp-section { margin-bottom: 1.5rem; }
        .owasp-section h4 { margin-bottom: 0.75rem; }
        .owasp-bars { display: flex; flex-direction: column; gap: 0.5rem; }
        .owasp-bar-row { display: flex; align-items: center; gap: 0.75rem; }
        .owasp-label { width: 280px; font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .owasp-bar-track { flex: 1; height: 8px; background: var(--bg-tertiary); border-radius: 99px; overflow: hidden; }
        .owasp-bar-fill { height: 100%; background: var(--accent-primary); border-radius: 99px; min-width: 4px; transition: width 0.3s; }
        .owasp-count { font-size: 0.8rem; font-weight: 600; color: var(--text-primary); min-width: 20px; text-align: right; }

        /* Vulnerability Cards */
        .vuln-list { display: flex; flex-direction: column; gap: 0.5rem; }
        .vuln-card {
            background: var(--bg-secondary); border: 1px solid var(--border-color);
            border-radius: var(--radius-md); padding: 0.75rem 1rem; cursor: pointer;
            transition: all 0.2s;
        }
        .vuln-card:hover { border-color: var(--accent-primary); }
        .vuln-card.expanded { border-color: var(--accent-primary); }
        .vuln-header { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
        .risk-badge { padding: 2px 8px; border-radius: 4px; color: white; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; }

        /* Severity legend — explains the color swatch used on each VulnCard */
        .severity-legend {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 0.5rem 0.75rem;
            padding: 6px 12px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 99px;
        }
        .severity-legend-item {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 0.72rem;
            font-weight: 600;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.03em;
            cursor: help;
        }
        .severity-legend-swatch {
            width: 10px;
            height: 10px;
            border-radius: 2px;
            display: inline-block;
            box-shadow: 0 0 0 1px rgba(255,255,255,0.05);
        }
        .vuln-name { font-weight: 600; color: var(--text-primary); font-size: 0.9rem; }
        .vuln-score { font-size: 0.8rem; font-weight: 700; color: var(--text-secondary); }
        .regression-tag { padding: 1px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 700; background: #a855f7; color: white; }
        .vuln-mini { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color); }

        /* Vuln Details */
        .vuln-details { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border-color); }
        .detail-block { margin-bottom: 0.75rem; }
        .detail-block h5 { margin: 0 0 0.25rem 0; font-size: 0.85rem; color: var(--accent-primary); }
        .detail-block p { margin: 0; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5; }
        .detail-row { font-size: 0.85rem; margin-bottom: 0.4rem; color: var(--text-secondary); }
        .detail-row code { font-size: 0.8rem; background: var(--bg-tertiary); padding: 1px 4px; border-radius: 3px; word-break: break-all; }
        .exploit-badge { padding: 1px 6px; border-radius: 4px; font-size: 0.75rem; background: var(--bg-tertiary); color: var(--text-primary); }
        .remediation pre, .code-block pre {
            font-size: 0.8rem; background: var(--bg-tertiary); padding: 0.75rem;
            border-radius: var(--radius-md); white-space: pre-wrap; word-break: break-word;
            font-family: 'Cascadia Code', 'Fira Code', monospace; color: var(--text-secondary);
            line-height: 1.5; margin: 0.25rem 0 0 0;
        }
        .jira-badge { padding: 1px 6px; border-radius: 4px; font-size: 0.75rem; background: #2563eb; color: white; }
        .exec-summary-box { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1.25rem; margin-top: 1rem; }
        .exec-summary-box pre { white-space: pre-wrap; font-family: inherit; color: var(--text-secondary); line-height: 1.6; margin: 0.5rem 0 0 0; }

        /* ZAP Status */
        .zap-status { font-size: 0.8rem; padding: 4px 10px; border-radius: 99px; }
        .zap-status.online { background: rgba(34,197,94,0.1); color: #22c55e; }
        .zap-status.offline { background: rgba(239,68,68,0.1); color: #ef4444; }

        /* Ghost button */
        .btn-ghost {
            background: var(--bg-tertiary); border: 1px solid var(--border-color);
            color: var(--text-secondary); padding: 0.4rem 0.75rem; border-radius: var(--radius-md);
            cursor: pointer; display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem;
            transition: all 0.2s;
        }
        .btn-ghost:hover { color: var(--text-primary); border-color: var(--text-muted); }

        .project-detail-header { margin-bottom: 1rem; }
        .project-detail-header h3 { margin: 0; }

        .table-row-hover:hover {
            background: rgba(255, 255, 255, 0.03) !important;
        }

        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    `}</style>
    );
}

export default SecurityScanner;
