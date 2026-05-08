import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ShieldCheck, Play, Loader2, AlertTriangle, CheckCircle, XCircle, Lock, Plus, ArrowLeft, BarChart3, Shield, Code, RefreshCw, Clock, TrendingUp, BrainCircuit, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from 'react-oidc-context';
import { createApiClient } from '../utils/apiClient';

const API = '/api/security';

const SecurityScanner = () => {
    // Token comes from Keycloak via the OIDC context. ProtectedRoute has already
    // gated this page on isAuthenticated + admin role, so we know it's present.
    const auth = useAuth();
    const api = useMemo(
        () => createApiClient(() => auth.user?.access_token),
        [auth.user?.access_token]
    );

    // ─── App state ───────────────────────────────────────
    const [view, setView] = useState('projects'); // projects | project-detail | scan-results | new-project
    const [projects, setProjects] = useState([]);
    const [selectedProject, setSelectedProject] = useState(null);
    const [dashboardData, setDashboardData] = useState(null);

    // ─── Scan state ──────────────────────────────────────
    const [scanType, setScanType] = useState('baseline');
    const [scanLoading, setScanLoading] = useState(false);
    const [activeScan, setActiveScan] = useState(null);
    const [scanResults, setScanResults] = useState(null);
    const [governance, setGovernance] = useState(null);

    // ─── General ─────────────────────────────────────────
    const [error, setError] = useState('');
    const [zapHealth, setZapHealth] = useState(null);
    const pollRef = useRef(null);

    // ─── New Project form ────────────────────────────────
    const [projectForm, setProjectForm] = useState({
        name: '',
        target_url: '',
        description: '',
        auth_username: '',
        auth_password: '',
        login_url: ''
    });
    const [showAuthFields, setShowAuthFields] = useState(false);

    // ─── Project handlers ────────────────────────────────

    const fetchProjects = async () => {
        try {
            const data = await api.get(`${API}/projects`);
            setProjects(data.projects || []);
        } catch (err) {
            if (err.status === 401) auth.signinRedirect();
            else setError('Failed to fetch projects');
        }
    };

    const createProject = async (e) => {
        e.preventDefault();
        setError('');
        try {
            await api.post(`${API}/projects`, projectForm);
            setProjectForm({
                name: '',
                target_url: '',
                description: '',
                auth_username: '',
                auth_password: '',
                login_url: ''
            });
            setShowAuthFields(false);
            setView('projects');
            fetchProjects();
        } catch (err) {
            setError(err.message);
        }
    };

    const openProject = async (project) => {
        setSelectedProject(project);
        setView('project-detail');
        setScanResults(null);
        setGovernance(null);
        setActiveScan(null);
        try {
            const data = await api.get(`${API}/dashboard/summary/${project.id}`);
            setDashboardData(data);
        } catch { }
    };

    // ─── Scan handlers ──────────────────────────────────

    const startScan = async () => {
        setError('');
        setScanLoading(true);
        setScanResults(null);
        setGovernance(null);
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

    const startPolling = (scanId) => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
            try {
                const data = await api.get(`${API}/scan/status/${scanId}`);
                setActiveScan(data);

                if (data.status === 'completed' || data.status === 'failed') {
                    clearInterval(pollRef.current);
                    pollRef.current = null;
                    setScanLoading(false);

                    if (data.status === 'completed') {
                        await fetchScanResults(scanId);
                        await fetchGovernance(scanId);
                        try {
                            const dashData = await api.get(`${API}/dashboard/summary/${selectedProject.id}`);
                            setDashboardData(dashData);
                        } catch { }
                    } else if (data.status === 'failed') {
                        const errorMsg = data.error || 'Scan execution failed';
                        if (errorMsg.includes('429') || errorMsg.toLowerCase().includes('quota') || errorMsg.toLowerCase().includes('rate limit')) {
                            setError('AI Rate Limit Reached: The scan finished but AI analysis was throttled. Please wait a few minutes before trying again or check your Gemini API quota.');
                        } else {
                            setError(`Security Scan Failed: ${errorMsg}`);
                        }
                    }
                }
            } catch { }
        }, 3000);
    };

    const fetchScanResults = async (scanId) => {
        try {
            const data = await api.get(`${API}/scan/results/${scanId}`);
            setScanResults(data);
        } catch { }
    };

    const fetchGovernance = async (scanId) => {
        try {
            const data = await api.get(`${API}/governance/release-check/${scanId}`);
            setGovernance(data);
        } catch { }
    };

    // ─── ZAP health ──────────────────────────────────────

    const checkZapHealth = async () => {
        try {
            // ZAP health is unauthenticated by design.
            const res = await fetch(`${API}/zap/health`);
            const text = await res.text();
            const data = text ? JSON.parse(text) : { status: 'error', error: 'Empty response' };
            setZapHealth(data);
        } catch {
            setZapHealth({ status: 'error', error: 'Unreachable' });
        }
    };

    // ─── Effects ─────────────────────────────────────────

    useEffect(() => {
        fetchProjects();
        checkZapHealth();
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
        // Mount-only — depending on `fetchProjects` here would re-fire every
        // render since it isn't memoized; the effect only needs to run once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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

            {/* ─── Projects List ─── */}
            {view === 'projects' && (
                <div className="section">
                    <div className="section-header">
                        <h3>Your Projects</h3>
                        <button className="btn btn-primary" onClick={() => setView('new-project')}>
                            <Plus size={16} /> New Security Project
                        </button>
                    </div>
                    {projects.length === 0 ? (
                        <div className="empty-state">
                            <Shield size={64} style={{ color: 'var(--text-muted)', marginBottom: '1rem' }} />
                            <p>No projects found. Create a project to start your first secure scan.</p>
                        </div>
                    ) : (
                        <div className="projects-grid-premium">
                            {projects.map(p => (
                                <div key={p.id} className="project-card-premium" onClick={() => openProject(p)}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                                        <div style={{ background: 'var(--accent-glow)', padding: '8px', borderRadius: '12px' }}>
                                            <Shield size={24} style={{ color: 'var(--accent-primary)' }} />
                                        </div>
                                        <h4>{p.name}</h4>
                                    </div>
                                    <div className="url-display">{p.target_url}</div>
                                    <div className="project-meta">
                                        {p.scans && p.scans[0] ? (
                                            <span className="meta-tag">
                                                {getStatusIcon(p.scans[0].status)}
                                                <span>Last: {p.scans[0].scan_type} ({new Date(p.scans[0].created_at).toLocaleDateString()})</span>
                                            </span>
                                        ) : (
                                            <span className="meta-tag">No scans yet</span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ─── New Project Form ─── */}
            {view === 'new-project' && (
                <div className="section">
                    <button className="btn btn-ghost" onClick={() => setView('projects')} style={{ marginBottom: '1.5rem' }}>
                        <ArrowLeft size={16} /> Back to Projects
                    </button>
                    <div className="auth-card-premium" style={{ maxWidth: '600px', margin: '0 auto' }}>
                        <h3 style={{ marginBottom: '1.5rem', fontSize: '1.5rem' }}>Create New Security Project</h3>
                        <form onSubmit={createProject}>
                            <div className="form-group-premium">
                                <label>Project Name</label>
                                <input
                                    className="form-input-premium"
                                    value={projectForm.name}
                                    onChange={e => setProjectForm(p => ({ ...p, name: e.target.value }))}
                                    placeholder="Enter a descriptive project name"
                                    required
                                />
                            </div>
                            <div className="form-group-premium">
                                <label>Target URL</label>
                                <input
                                    className="form-input-premium"
                                    value={projectForm.target_url}
                                    onChange={e => setProjectForm(p => ({ ...p, target_url: e.target.value }))}
                                    placeholder="https://app.example.com"
                                    required
                                />
                            </div>
                            <div className="form-group-premium">
                                <label>Description (Optional)</label>
                                <textarea
                                    className="form-input-premium"
                                    rows={3}
                                    value={projectForm.description}
                                    onChange={e => setProjectForm(p => ({ ...p, description: e.target.value }))}
                                    placeholder="What are we protecting today?"
                                />
                            </div>

                            <div className="form-group-premium" style={{ marginBottom: '1.5rem' }}>
                                <label className="checkbox-container" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                                    <input
                                        type="checkbox"
                                        checked={showAuthFields}
                                        onChange={() => setShowAuthFields(!showAuthFields)}
                                        style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                                    />
                                    <strong>Authentication Required (Optional)</strong>
                                </label>
                                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: '26px', marginTop: '4px' }}>
                                    Enable this if the target site requires a login to access certain pages.
                                </p>
                            </div>

                            {showAuthFields && (
                                <div className="auth-settings-container animate-fade-in" style={{ padding: '1.25rem', background: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--border-color)', marginBottom: '1.5rem' }}>
                                    <h5 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <Lock size={16} /> Target Site Credentials
                                    </h5>
                                    <div className="form-group-premium">
                                        <label>Login URL</label>
                                        <input
                                            className="form-input-premium"
                                            value={projectForm.login_url}
                                            onChange={e => setProjectForm(p => ({ ...p, login_url: e.target.value }))}
                                            placeholder="https://app.example.com/login"
                                            required={showAuthFields}
                                        />
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                                        <div className="form-group-premium">
                                            <label>Username</label>
                                            <input
                                                className="form-input-premium"
                                                value={projectForm.auth_username}
                                                onChange={e => setProjectForm(p => ({ ...p, auth_username: e.target.value }))}
                                                placeholder="admin"
                                                required={showAuthFields}
                                            />
                                        </div>
                                        <div className="form-group-premium">
                                            <label>Password</label>
                                            <input
                                                type="password"
                                                className="form-input-premium"
                                                value={projectForm.auth_password}
                                                onChange={e => setProjectForm(p => ({ ...p, auth_password: e.target.value }))}
                                                placeholder="••••••••"
                                                required={showAuthFields}
                                            />
                                        </div>
                                    </div>
                                </div>
                            )}

                            <button type="submit" className="btn btn-primary full-width">
                                <Plus size={18} /> Initialize Security Project
                            </button>
                        </form>
                    </div>
                </div>
            )}

            {/* ─── Project Detail / Dashboard ─── */}
            {view === 'project-detail' && selectedProject && (
                <div className="section">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                        <button className="btn btn-ghost" onClick={() => { setView('projects'); setSelectedProject(null); setDashboardData(null); setScanResults(null); }}>
                            <ArrowLeft size={16} /> Dashboard
                        </button>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <div className="url-display" style={{ margin: 0 }}>{selectedProject.target_url}</div>
                        </div>
                    </div>

                    <div style={{ marginBottom: '2rem' }}>
                        <h3 style={{ fontSize: '1.8rem', margin: 0 }}>{selectedProject.name}</h3>
                        <p style={{ color: 'var(--text-muted)' }}>Project Security Intelligence Hub</p>
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
                            <p className="scan-progress-text">System is currently performing {activeScan.scan_type} analysis on target endpoint.</p>
                        </div>
                    )}

                    {/* Governance Gate Result */}
                    {governance && (
                        <div className={`governance-card ${governance.release_blocked ? 'blocked' : 'approved'}`} style={{ borderLeftWidth: '6px' }}>
                            <div className="governance-header">
                                {governance.release_blocked ? <XCircle size={32} style={{ color: 'var(--error)' }} /> : <CheckCircle size={32} style={{ color: 'var(--success)' }} />}
                                <div>
                                    <h4 style={{ fontSize: '1.2rem' }}>{governance.release_blocked ? 'Policy Violation: Release Blocked' : 'Security Compliance: Approved'}</h4>
                                    <p>Security Gate: Critical+High vulnerabilities at {governance.metrics?.critical_high_percentage?.toFixed(1)}% (Limit: 30%)</p>
                                </div>
                                <div style={{ marginLeft: 'auto' }}>
                                    <span style={{ fontSize: '0.8rem', background: 'var(--bg-primary)', padding: '4px 10px', borderRadius: '4px' }}>
                                        {governance.metrics?.regression_count} Regressions Found
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
                            <h3 className="results-title"><BarChart3 size={20} /> Latest Analysis Findings</h3>

                            <div className="stats-row-premium">
                                {[
                                    { label: 'Overall Score', value: (governance?.metrics?.health_score !== undefined && governance?.metrics?.health_score !== null) ? `${governance.metrics.health_score}/10` : '—', color: 'var(--accent-primary)' },
                                    { label: 'Total', value: scanResults.summary.total, color: 'var(--text-primary)' },
                                    { label: 'Critical', value: scanResults.summary.critical, color: 'var(--error)' },
                                    { label: 'High', value: scanResults.summary.high, color: '#f97316' },
                                    { label: 'Medium', value: scanResults.summary.medium, color: 'var(--warning)' },
                                    { label: 'Low', value: scanResults.summary.low, color: 'var(--success)' },
                                    { label: 'Regressions', value: scanResults.summary.regressions, color: '#a855f7' },
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

                            <h4 style={{ marginTop: '2rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <Shield size={20} /> Vulnerability Intelligence ({scanResults.vulnerabilities.length})
                            </h4>
                            <div className="vuln-list">
                                {scanResults.vulnerabilities.map((v, i) => (
                                    <VulnCard key={v.id || i} vuln={v} />
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
                                <div className="exec-summary-box" style={{ background: 'var(--bg-tertiary)', borderLeft: '4px solid var(--accent-primary)' }}>
                                    <h4 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <Sparkles size={18} style={{ color: 'var(--accent-primary)' }} /> AI Executive Summary
                                    </h4>
                                    <div style={{ color: 'var(--text-secondary)', lineHeight: '1.6', whiteSpace: 'pre-wrap', fontSize: '0.95rem', marginTop: '10px' }}>
                                        {dashboardData.executive_summary}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {renderStyles()}
        </div>
    );
};

// ─── Vulnerability Card Component ─────────────────────────

const VulnCard = ({ vuln }) => {
    const [expanded, setExpanded] = useState(false);

    const getRiskColor = (risk) => {
        const map = { Critical: '#ef4444', High: '#f97316', Medium: '#eab308', Low: '#22c55e', Informational: '#6b7280' };
        return map[risk] || '#6b7280';
    };

    return (
        <div className={`vuln-item-premium ${expanded ? 'active' : ''}`}>
            <div className="vuln-header-premium" onClick={() => setExpanded(!expanded)}>
                <div className="severity-indicator" style={{ background: getRiskColor(vuln.risk) }} />
                <div className="vuln-title-group">
                    <h5>{vuln.alert_name}</h5>
                    <span>{vuln.owasp_category || 'General Security'} — Risk Score: {(typeof vuln.risk_score === 'number') ? vuln.risk_score.toFixed(1) : 'N/A'}/10</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {vuln.is_regression && <span className="regression-tag">REGRESSION</span>}
                    {expanded ? <ChevronUp size={20} style={{ opacity: 0.6 }} /> : <ChevronDown size={20} style={{ opacity: 0.6 }} />}
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
                        {vuln.jira_ticket_key && (
                            <div className="detail-row"><strong>Jira Ticket:</strong> <span className="jira-badge">{vuln.jira_ticket_key}</span></div>
                        )}
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
            background: linear-gradient(to right, #fff, var(--text-secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }
        .page-header-premium p { 
            margin: 0.5rem 0 0 0; 
            color: var(--text-secondary);
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

        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    `}</style>
    );
}

export default SecurityScanner;
