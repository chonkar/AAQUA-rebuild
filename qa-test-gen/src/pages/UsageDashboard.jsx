import React, { useState, useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import { Users, Activity, ShieldCheck, RefreshCw, Search, ChevronLeft, ChevronRight, HelpCircle, Terminal } from 'lucide-react';

const UsageDashboard = () => {
    const auth = useAuth();
    const token = auth.user?.access_token || '';

    // Summary state
    const [summary, setSummary] = useState(null);
    const [summaryLoading, setSummaryLoading] = useState(true);
    const [summaryError, setSummaryError] = useState(null);

    // Logs state
    const [logs, setLogs] = useState([]);
    const [logsTotal, setLogsTotal] = useState(0);
    const [logsPage, setLogsPage] = useState(1);
    const [logsTotalPages, setLogsTotalPages] = useState(1);
    const [logsLoading, setLogsLoading] = useState(true);
    const [logsError, setLogsError] = useState(null);

    // Filter/Search state
    const [searchVal, setSearchVal] = useState('');
    const [activeSearch, setActiveSearch] = useState('');

    const API_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '');

    const fetchSummary = async () => {
        setSummaryLoading(true);
        setSummaryError(null);
        try {
            const res = await fetch(`${API_PREFIX}/api/admin/usage/summary`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            if (!res.ok) throw new Error(`Status ${res.status}: Failed to fetch summary stats.`);
            const data = await res.json();
            setSummary(data);
        } catch (err) {
            console.error('[UsageDashboard] Summary error:', err);
            setSummaryError(err.message);
        } finally {
            setSummaryLoading(false);
        }
    };

    const fetchLogs = async (page = 1, search = '') => {
        setLogsLoading(true);
        setLogsError(null);
        try {
            const queryParams = new URLSearchParams({
                page: page.toString(),
                limit: '15',
                search: search
            });
            const res = await fetch(`${API_PREFIX}/api/admin/usage/logs?${queryParams.toString()}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            if (!res.ok) throw new Error(`Status ${res.status}: Failed to fetch logs.`);
            const data = await res.json();
            setLogs(data.logs || []);
            setLogsTotal(data.total || 0);
            setLogsPage(data.page || 1);
            setLogsTotalPages(data.totalPages || 1);
        } catch (err) {
            console.error('[UsageDashboard] Logs error:', err);
            setLogsError(err.message);
        } finally {
            setLogsLoading(false);
        }
    };

    const handleRefreshAll = () => {
        fetchSummary();
        fetchLogs(logsPage, activeSearch);
    };

    useEffect(() => {
        if (token) {
            fetchSummary();
            fetchLogs(1, '');
        }
    }, [token]);

    const handleSearchSubmit = (e) => {
        e.preventDefault();
        setActiveSearch(searchVal);
        setLogsPage(1);
        fetchLogs(1, searchVal);
    };

    const handleSearchClear = () => {
        setSearchVal('');
        setActiveSearch('');
        setLogsPage(1);
        fetchLogs(1, '');
    };

    const handlePageChange = (newPage) => {
        if (newPage >= 1 && newPage <= logsTotalPages) {
            setLogsPage(newPage);
            fetchLogs(newPage, activeSearch);
        }
    };

    // Format dates cleanly
    const formatTimestamp = (dateStr) => {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    };

    // Render bar charts using SVG
    const renderTrendChart = () => {
        if (!summary) return null;

        // Build list of last 7 days chronologically
        const trendMap = new Map();
        if (summary.activityTrend) {
            summary.activityTrend.forEach(t => {
                const dateKey = new Date(t.date).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
                trendMap.set(dateKey, parseInt(t.count, 10));
            });
        }

        const trends = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateKey = d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
            trends.push({
                date: d,
                count: trendMap.get(dateKey) || 0
            });
        }

        const maxVal = Math.max(...trends.map(t => t.count), 5) || 5;
        const chartHeight = 150;
        const chartWidth = 500;
        const paddingLeft = 40;
        const paddingRight = 20;
        const availableWidth = chartWidth - paddingLeft - paddingRight;
        
        // Spacing for exactly 7 bars
        const barWidth = 30;
        const gap = (availableWidth - (7 * barWidth)) / 8;

        return (
            <div className="chart-container-inner" style={{ maxWidth: '500px', margin: '0 auto', width: '100%' }}>
                <svg viewBox="0 0 500 220" className="trend-svg" style={{ width: '100%', height: 'auto', display: 'block' }}>
                    {/* Y Axis Grid Lines */}
                    {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => {
                        const yVal = chartHeight * (1 - pct) + 30;
                        const labelVal = Math.round(maxVal * pct);
                        return (
                            <g key={i} className="grid-line-group">
                                <line x1={paddingLeft} y1={yVal} x2={chartWidth - paddingRight} y2={yVal} className="grid-line" />
                                <text x={paddingLeft - 10} y={yVal + 4} textAnchor="end" className="grid-label">{labelVal}</text>
                            </g>
                        );
                    })}

                    {/* Bars */}
                    {trends.map((t, idx) => {
                        const pct = t.count / maxVal;
                        const height = chartHeight * pct;
                        const x = paddingLeft + gap + idx * (barWidth + gap);
                        const y = chartHeight - height + 30;
                        
                        const label = t.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

                        return (
                            <g key={idx} className="chart-bar-group">
                                <rect 
                                    x={x} 
                                    y={y} 
                                    width={barWidth} 
                                    height={Math.max(height, 2)} 
                                    rx="4" 
                                    fill="url(#bar-gradient)" 
                                    className="chart-rect"
                                />
                                {t.count > 0 && (
                                    <text x={x + barWidth / 2} y={y - 8} textAnchor="middle" className="bar-value">
                                        {t.count}
                                    </text>
                                )}
                                <text x={x + barWidth / 2} y={chartHeight + 52} textAnchor="middle" className="bar-label">
                                    {label}
                                </text>
                            </g>
                        );
                    })}

                    <defs>
                        <linearGradient id="bar-gradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--accent-primary)" />
                            <stop offset="100%" stopColor="var(--accent-secondary)" />
                        </linearGradient>
                    </defs>
                </svg>
            </div>
        );
    };

    return (
        <div className="usage-dashboard-page animate-fade-in">
            <div className="page-header-row">
                <div>
                    <h2>Application Usage Intelligence</h2>
                    <p className="subtitle">Real-time system active user counts, activities trend, and operational audit trail logs.</p>
                </div>
                <div className="header-actions">
                    <button className="btn btn-secondary" onClick={handleRefreshAll} disabled={summaryLoading || logsLoading}>
                        <RefreshCw className={summaryLoading || logsLoading ? 'spin' : ''} size={16} />
                        <span>Sync Dashboard</span>
                    </button>
                </div>
            </div>

            {/* Aggregated Stats Cards */}
            <div className="stats-cards-grid">
                <div className="metric-card glass-panel">
                    <div className="card-icon-wrapper purple">
                        <Users size={24} />
                    </div>
                    <div className="card-info">
                        <span className="card-title">Active Users</span>
                        <h3 className="card-value">
                            {summaryLoading ? '...' : summary?.totalUsers ?? 0}
                        </h3>
                        <span className="card-subtext">Unique user accounts signed in</span>
                    </div>
                </div>

                <div className="metric-card glass-panel">
                    <div className="card-icon-wrapper blue">
                        <Activity size={24} />
                    </div>
                    <div className="card-info">
                        <span className="card-title">System Operations</span>
                        <h3 className="card-value">
                            {summaryLoading ? '...' : summary?.totalActivities ?? 0}
                        </h3>
                        <span className="card-subtext">Total requests captured by audit trail</span>
                    </div>
                </div>

                <div className="metric-card glass-panel">
                    <div className="card-icon-wrapper green">
                        <ShieldCheck size={24} />
                    </div>
                    <div className="card-info">
                        <span className="card-title">Audit Log Status</span>
                        <h3 className="card-value text-green">Active</h3>
                        <span className="card-subtext">Recording background activities</span>
                    </div>
                </div>
            </div>

            {/* Visual Analytics Rows */}
            <div className="analytics-grid">
                {/* Daily Activity Chart */}
                <div className="analytics-card glass-panel flex-grow-2">
                    <div className="analytics-card-header">
                        <h4>Daily System Interaction Trend (7 Days)</h4>
                    </div>
                    <div className="analytics-card-body chart-body">
                        {summaryLoading ? (
                            <div className="loading-state-mini">
                                <RefreshCw className="spin" size={24} />
                                <p>Loading activity trends...</p>
                            </div>
                        ) : summaryError ? (
                            <div className="error-state-mini">
                                <p>{summaryError}</p>
                            </div>
                        ) : (
                            renderTrendChart()
                        )}
                    </div>
                </div>

                {/* Top Active Users */}
                <div className="analytics-card glass-panel flex-grow-1">
                    <div className="analytics-card-header">
                        <h4>Top Active Accounts</h4>
                    </div>
                    <div className="analytics-card-body ranking-body">
                        {summaryLoading ? (
                            <div className="loading-state-mini">
                                <RefreshCw className="spin" size={24} />
                                <p>Loading user rankings...</p>
                            </div>
                        ) : summaryError ? (
                            <div className="error-state-mini">
                                <p>{summaryError}</p>
                            </div>
                        ) : !summary?.topUsers || summary.topUsers.length === 0 ? (
                            <p className="no-data-text">No active users recorded.</p>
                        ) : (
                            <div className="top-users-list">
                                {summary.topUsers.map((user, idx) => (
                                    <div key={idx} className="top-user-item">
                                        <div className="user-rank-badge">{idx + 1}</div>
                                        <div className="user-details">
                                            <span className="user-email-text" title={user.email}>{user.name || user.email}</span>
                                            <span className="user-subtext">{user.name ? `${user.email} • ` : ''}username: {user.username || 'N/A'}</span>
                                        </div>
                                        <div className="user-meta">
                                            <span className="user-count-badge">{user.count} actions</span>
                                            <span className="user-last-active">
                                                Last: {new Date(user.last_active).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Detailed Log Table */}
            <div className="audit-log-card glass-panel">
                <div className="audit-log-header">
                    <h4>Operations Audit Trail Logs</h4>
                    
                    {/* Search Filters */}
                    <form className="log-search-form" onSubmit={handleSearchSubmit}>
                        <div className="search-input-wrapper">
                            <Search size={16} className="search-icon" />
                            <input
                                type="text"
                                className="search-input"
                                placeholder="Search by email, action..."
                                value={searchVal}
                                onChange={(e) => setSearchVal(e.target.value)}
                            />
                            {searchVal && (
                                <button type="button" className="search-clear-btn" onClick={handleSearchClear}>
                                    &times;
                                </button>
                            )}
                        </div>
                        <button type="submit" className="btn btn-primary search-submit-btn">
                            Search
                        </button>
                    </form>
                </div>

                <div className="audit-log-body">
                    {logsLoading ? (
                        <div className="loading-state-table">
                            <RefreshCw className="spin" size={32} />
                            <p>Loading activity logs...</p>
                        </div>
                    ) : logsError ? (
                        <div className="error-state-table">
                            <p>Failed to load logs: {logsError}</p>
                        </div>
                    ) : logs.length === 0 ? (
                        <div className="empty-state-table">
                            <p>No activity logs found. {activeSearch && 'Try adjusting your search criteria.'}</p>
                        </div>
                    ) : (
                        <div className="table-wrapper">
                            <table className="audit-table">
                                <thead>
                                    <tr>
                                        <th>Timestamp</th>
                                        <th>Account User</th>
                                        <th>Action Description</th>
                                        <th>IP Address</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {logs.map((log) => (
                                        <tr key={log.id} className="log-row">
                                            <td className="col-time">{formatTimestamp(log.createdAt || log.created_at)}</td>
                                            <td className="col-user">
                                                <div className="table-user-cell">
                                                    <span className="table-user-email">{log.name || log.email}</span>
                                                    <span className="table-user-name">{log.name ? `${log.email} • ` : ''}username: {log.username || 'N/A'}</span>
                                                </div>
                                            </td>
                                            <td className="col-action">
                                                <span className={`action-badge ${log.action.split(' ')[0].toLowerCase()}`}>
                                                    <span className="action-method">{log.action.split(' ')[0]}</span>
                                                    <span className="action-path">{log.action.substring(log.action.indexOf(' '))}</span>
                                                </span>
                                            </td>
                                            <td className="col-ip">{log.ip_address || '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Table Pagination */}
                {!logsLoading && !logsError && logsTotalPages > 1 && (
                    <div className="audit-log-footer">
                        <span className="pagination-info">
                            Showing page <strong>{logsPage}</strong> of <strong>{logsTotalPages}</strong> ({logsTotal} operations total)
                        </span>
                        <div className="pagination-buttons">
                            <button 
                                className="btn btn-secondary btn-pagination" 
                                onClick={() => handlePageChange(logsPage - 1)}
                                disabled={logsPage === 1}
                            >
                                <ChevronLeft size={16} />
                                <span>Prev</span>
                            </button>
                            <button 
                                className="btn btn-secondary btn-pagination" 
                                onClick={() => handlePageChange(logsPage + 1)}
                                disabled={logsPage === logsTotalPages}
                            >
                                <span>Next</span>
                                <ChevronRight size={16} />
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <style>{`
                /* Light Theme Overrides */
                [data-theme='light'] .glass-panel {
                    background: rgba(255, 255, 255, 0.6);
                    box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.05);
                }
                [data-theme='light'] .search-input {
                    background: rgba(255, 255, 255, 0.8);
                }
                [data-theme='light'] .top-user-item {
                    background: rgba(0, 0, 0, 0.02);
                }
                [data-theme='light'] .action-badge {
                    background: rgba(0, 0, 0, 0.03);
                }
                [data-theme='light'] .action-badge.get .action-method { color: #1d4ed8; }
                [data-theme='light'] .action-badge.post .action-method { color: #047857; }
                [data-theme='light'] .action-badge.put .action-method { color: #b45309; }
                [data-theme='light'] .action-badge.delete .action-method { color: #b91c1c; }
                [data-theme='light'] .grid-line {
                    stroke: rgba(0, 0, 0, 0.06);
                }
                [data-theme='light'] .log-row:hover {
                    background: rgba(0, 0, 0, 0.02);
                }
                [data-theme='light'] .card-icon-wrapper.purple { background: rgba(139, 92, 246, 0.1); color: #7c3aed; }
                [data-theme='light'] .card-icon-wrapper.blue { background: rgba(59, 130, 246, 0.1); color: #2563eb; }
                [data-theme='light'] .card-icon-wrapper.green { background: rgba(16, 185, 129, 0.1); color: #059669; }

                .usage-dashboard-page {
                    max-width: 1200px;
                    margin: 0 auto;
                    padding: 1rem 0 2rem 0;
                }

                .page-header-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 2rem;
                    gap: 1rem;
                }

                .page-header-row h2 {
                    font-size: 1.75rem;
                    margin-bottom: 0.25rem;
                    font-weight: 700;
                    background: linear-gradient(to right, var(--accent-primary), var(--accent-secondary));
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                }

                .subtitle {
                    color: var(--text-secondary);
                    font-size: 0.95rem;
                }

                .glass-panel {
                    background: rgba(30, 41, 59, 0.4);
                    backdrop-filter: blur(16px);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-lg);
                    transition: all 0.3s;
                }

                .glass-panel:hover {
                    border-color: var(--border-focus);
                    box-shadow: var(--shadow-xl), 0 0 30px rgba(139, 92, 246, 0.05);
                }

                /* Stats Cards styling */
                .stats-cards-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                    gap: 1.5rem;
                    margin-bottom: 2rem;
                }

                .metric-card {
                    display: flex;
                    align-items: center;
                    padding: 1.75rem;
                    gap: 1.25rem;
                }

                .card-icon-wrapper {
                    width: 54px;
                    height: 54px;
                    border-radius: 14px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }

                .card-icon-wrapper.purple { background: rgba(139, 92, 246, 0.15); color: #a78bfa; }
                .card-icon-wrapper.blue { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
                .card-icon-wrapper.green { background: rgba(16, 185, 129, 0.15); color: #34d399; }

                .card-info {
                    display: flex;
                    flex-direction: column;
                }

                .card-title {
                    font-size: 0.85rem;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    color: var(--text-muted);
                    font-weight: 700;
                }

                .card-value {
                    font-size: 2rem;
                    font-weight: 800;
                    color: var(--text-primary);
                    margin: 0.15rem 0;
                    line-height: 1.1;
                }

                .card-subtext {
                    font-size: 0.75rem;
                    color: var(--text-secondary);
                }

                /* Analytics layout styling */
                .analytics-grid {
                    display: flex;
                    gap: 1.5rem;
                    margin-bottom: 2rem;
                    flex-wrap: wrap;
                }

                .flex-grow-1 { flex: 1 1 350px; }
                .flex-grow-2 { flex: 2 2 550px; }

                .analytics-card {
                    padding: 1.5rem;
                    display: flex;
                    flex-direction: column;
                }

                .analytics-card-header {
                    margin-bottom: 1.5rem;
                    border-bottom: 1px solid var(--border-color);
                    padding-bottom: 0.75rem;
                }

                .analytics-card-header h4 {
                    font-size: 1.05rem;
                    font-weight: 700;
                    color: var(--text-primary);
                }

                .analytics-card-body {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                }

                /* Visual Chart styles */
                .chart-body {
                    justify-content: center;
                    align-items: center;
                    min-height: 220px;
                }

                .chart-container-inner {
                    width: 100%;
                    overflow-x: auto;
                }

                .trend-svg {
                    width: 100%;
                    min-width: 480px;
                    display: block;
                }

                .grid-line {
                    stroke: rgba(255, 255, 255, 0.04);
                    stroke-width: 1;
                    stroke-dasharray: 4;
                }

                .grid-label {
                    fill: var(--text-muted);
                    font-size: 0.7rem;
                    font-weight: 600;
                }

                .chart-rect {
                    transition: height 0.5s ease-out, y 0.5s ease-out, opacity 0.2s;
                    opacity: 0.85;
                }

                .chart-bar-group:hover .chart-rect {
                    opacity: 1;
                    filter: drop-shadow(0 0 8px var(--accent-glow));
                }

                .bar-value {
                    fill: var(--text-primary);
                    font-size: 0.75rem;
                    font-weight: 700;
                    opacity: 0;
                    transition: opacity 0.2s;
                }

                .chart-bar-group:hover .bar-value {
                    opacity: 1;
                }

                .bar-label {
                    fill: var(--text-secondary);
                    font-size: 0.7rem;
                    font-weight: 600;
                }

                /* Top active users ranking styling */
                .top-users-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                }

                .top-user-item {
                    display: flex;
                    align-items: center;
                    background: rgba(255, 255, 255, 0.02);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-sm);
                    padding: 0.75rem 1rem;
                    gap: 0.75rem;
                    transition: border-color 0.2s;
                }

                .top-user-item:hover {
                    border-color: var(--border-focus);
                }

                .user-rank-badge {
                    width: 28px;
                    height: 28px;
                    border-radius: 50%;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.85rem;
                    font-weight: 700;
                    color: var(--accent-secondary);
                }

                .user-details {
                    display: flex;
                    flex-direction: column;
                    flex: 1;
                    min-width: 0;
                }

                .user-email-text {
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--text-primary);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .user-subtext {
                    font-size: 0.7rem;
                    color: var(--text-muted);
                }

                .user-meta {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-end;
                    gap: 0.15rem;
                }

                .user-count-badge {
                    font-size: 0.75rem;
                    background: rgba(139, 92, 246, 0.1);
                    color: var(--accent-primary);
                    border: 1px solid rgba(139, 92, 246, 0.2);
                    padding: 2px 8px;
                    border-radius: 99px;
                    font-weight: 600;
                }

                .user-last-active {
                    font-size: 0.65rem;
                    color: var(--text-muted);
                }

                /* Audit logs table styling */
                .audit-log-card {
                    display: flex;
                    flex-direction: column;
                    padding: 1.5rem;
                }

                .audit-log-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 1rem;
                    margin-bottom: 1.5rem;
                    border-bottom: 1px solid var(--border-color);
                    padding-bottom: 1rem;
                }

                .audit-log-header h4 {
                    font-size: 1.15rem;
                    font-weight: 700;
                }

                .log-search-form {
                    display: flex;
                    gap: 0.5rem;
                    align-items: center;
                }

                .search-input-wrapper {
                    position: relative;
                    display: flex;
                    align-items: center;
                }

                .search-icon {
                    position: absolute;
                    left: 10px;
                    color: var(--text-muted);
                    pointer-events: none;
                }

                .search-input {
                    background: rgba(15, 23, 42, 0.4);
                    border: 1px solid var(--border-color);
                    color: var(--text-primary);
                    padding: 0.5rem 2rem 0.5rem 2.25rem;
                    border-radius: var(--radius-sm);
                    font-size: 0.85rem;
                    outline: none;
                    width: 220px;
                    transition: all 0.2s;
                }

                .search-input:focus {
                    border-color: var(--border-focus);
                    box-shadow: 0 0 8px rgba(139, 92, 246, 0.2);
                }

                .search-clear-btn {
                    position: absolute;
                    right: 8px;
                    background: none;
                    border: none;
                    color: var(--text-muted);
                    font-size: 1.1rem;
                    cursor: pointer;
                }

                .search-clear-btn:hover {
                    color: var(--text-primary);
                }

                .search-submit-btn {
                    padding: 0.5rem 1rem;
                    font-size: 0.85rem;
                }

                .table-wrapper {
                    width: 100%;
                    overflow-x: auto;
                }

                .audit-table {
                    width: 100%;
                    border-collapse: collapse;
                    text-align: left;
                    font-size: 0.9rem;
                }

                .audit-table th {
                    border-bottom: 2px solid var(--border-color);
                    padding: 0.75rem 1rem;
                    color: var(--text-muted);
                    font-weight: 700;
                    text-transform: uppercase;
                    font-size: 0.75rem;
                    letter-spacing: 0.5px;
                }

                .audit-table td {
                    padding: 0.85rem 1rem;
                    border-bottom: 1px solid var(--border-color);
                    vertical-align: middle;
                }

                .log-row {
                    transition: background 0.15s;
                }

                .log-row:hover {
                    background: rgba(255, 255, 255, 0.01);
                }

                .col-time {
                    white-space: nowrap;
                    font-family: monospace;
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                }

                .table-user-cell {
                    display: flex;
                    flex-direction: column;
                }

                .table-user-email {
                    font-weight: 600;
                    color: var(--text-primary);
                }

                .table-user-name {
                    font-size: 0.75rem;
                    color: var(--text-muted);
                }

                .col-action {
                    font-family: monospace;
                }

                .action-badge {
                    display: inline-flex;
                    align-items: center;
                    border-radius: 6px;
                    padding: 3px 8px;
                    font-size: 0.75rem;
                    background: rgba(255, 255, 255, 0.03);
                    border: 1px solid var(--border-color);
                    max-width: 500px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .action-method {
                    font-weight: 700;
                    margin-right: 6px;
                    text-transform: uppercase;
                }

                /* Method colorings */
                .action-badge.get .action-method { color: #60a5fa; }
                .action-badge.post .action-method { color: #34d399; }
                .action-badge.put .action-method { color: #fbbf24; }
                .action-badge.delete .action-method { color: #f87171; }

                .action-path {
                    color: var(--text-secondary);
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .col-ip {
                    font-family: monospace;
                    font-size: 0.8rem;
                    color: var(--text-muted);
                }

                /* Pagination Footer styles */
                .audit-log-footer {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-top: 1.5rem;
                    padding-top: 1rem;
                    border-top: 1px solid var(--border-color);
                    flex-wrap: wrap;
                    gap: 1rem;
                }

                .pagination-info {
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                }

                .pagination-buttons {
                    display: flex;
                    gap: 0.5rem;
                }

                .btn-pagination {
                    padding: 0.45rem 1rem;
                    font-size: 0.8rem;
                }

                /* Mini States */
                .loading-state-mini, .error-state-mini, .loading-state-table, .error-state-table, .empty-state-table {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    padding: 2.5rem;
                    text-align: center;
                    color: var(--text-secondary);
                }

                .loading-state-table, .error-state-table, .empty-state-table {
                    min-height: 200px;
                }

                .empty-chart {
                    height: 100%;
                    min-height: 180px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--text-muted);
                    font-size: 0.85rem;
                }

                .no-data-text {
                    color: var(--text-secondary);
                    font-size: 0.85rem;
                }

                .spin {
                    animation: spin 1s linear infinite;
                }
                @keyframes spin {
                    100% { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    );
};

export default UsageDashboard;
