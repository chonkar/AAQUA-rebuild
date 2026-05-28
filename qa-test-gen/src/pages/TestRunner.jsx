import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Play, RotateCcw, CheckCircle2, XCircle, AlertTriangle, MinusCircle, Clock, FolderOpen, ChevronDown, ChevronRight, Terminal, BarChart3, Download, CalendarClock, Wrench } from 'lucide-react';
import { runTestsLocal, getRunStatus, retryFailedTests, getRuntimeInfo } from '../services/testRunnerService';
import { startBatchHeal, getBatchHealStatus, applyHeal } from '../services/autoHealService';
import { useProject } from '../context/ProjectContext';

const HEADED_PREF_KEY = 'aaqua.testrunner.headed';

const STATUS_COLORS = { PASSED: 'var(--success)', FAILED: 'var(--error)', SKIPPED: 'var(--warning)' };
const STATUS_ICONS = { PASSED: CheckCircle2, FAILED: XCircle, SKIPPED: MinusCircle };

// ─── Donut Chart (pure SVG) ───
const DonutChart = ({ passed, failed, skipped }) => {
    const total = passed + failed + skipped;
    if (total === 0) return null;
    const radius = 54, stroke = 12, circumference = 2 * Math.PI * radius;
    const pPass = passed / total, pFail = failed / total, pSkip = skipped / total;
    const passLen = pPass * circumference, failLen = pFail * circumference, skipLen = pSkip * circumference;
    const passRate = Math.round((passed / total) * 100);

    return (
        <div className="tr-donut-wrap">
            <svg viewBox="0 0 140 140" className="tr-donut-svg">
                {/* Passed */}
                <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--success)" strokeWidth={stroke}
                    strokeDasharray={`${passLen} ${circumference}`} strokeDashoffset="0"
                    transform="rotate(-90 70 70)" strokeLinecap="round" />
                {/* Failed */}
                <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--error)" strokeWidth={stroke}
                    strokeDasharray={`${failLen} ${circumference}`} strokeDashoffset={`-${passLen}`}
                    transform="rotate(-90 70 70)" strokeLinecap="round" />
                {/* Skipped */}
                <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--warning)" strokeWidth={stroke}
                    strokeDasharray={`${skipLen} ${circumference}`} strokeDashoffset={`-${passLen + failLen}`}
                    transform="rotate(-90 70 70)" strokeLinecap="round" />
                <text x="70" y="66" textAnchor="middle" fill="var(--text-primary)" fontSize="24" fontWeight="700">{passRate}%</text>
                <text x="70" y="84" textAnchor="middle" fill="var(--text-secondary)" fontSize="11">Pass Rate</text>
            </svg>
            <div className="tr-donut-legend">
                <span><i style={{ background: 'var(--success)' }} /> Passed: {passed}</span>
                <span><i style={{ background: 'var(--error)' }} /> Failed: {failed}</span>
                <span><i style={{ background: 'var(--warning)' }} /> Skipped: {skipped}</span>
            </div>
        </div>
    );
};

// ─── Summary Card ───
const SummaryCard = ({ label, value, color, icon: _Icon }) => (
    <div className="tr-stat-card">
        <div className="tr-stat-icon" style={{ background: `${color}18`, color }}><_Icon size={20} /></div>
        <div className="tr-stat-info">
            <span className="tr-stat-value">{value}</span>
            <span className="tr-stat-label">{label}</span>
        </div>
    </div>
);

// ─── Suite Row ───
const SuiteRow = ({ suite }) => {
    const [expanded, setExpanded] = useState(false);
    const passed = suite.tests.filter(t => t.status === 'PASSED').length;
    const failed = suite.tests.filter(t => t.status === 'FAILED').length;
    const skipped = suite.tests.filter(t => t.status === 'SKIPPED').length;

    return (
        <div className="tr-suite">
            <div className="tr-suite-header" onClick={() => setExpanded(!expanded)}>
                <span className="tr-suite-chevron">{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                <span className="tr-suite-name">{suite.name}</span>
                <span className="tr-suite-counts">
                    {passed > 0 && <span className="tr-mini-badge pass">{passed} ✓</span>}
                    {failed > 0 && <span className="tr-mini-badge fail">{failed} ✗</span>}
                    {skipped > 0 && <span className="tr-mini-badge skip">{skipped} —</span>}
                </span>
                <span className="tr-suite-duration">{suite.duration}</span>
            </div>
            {expanded && (
                <div className="tr-suite-tests animate-fade-in">
                    {suite.tests.map((test, i) => <TestRow key={i} test={test} />)}
                </div>
            )}
        </div>
    );
};

// ─── Test Row ───
const TestRow = ({ test }) => {
    const [showTrace, setShowTrace] = useState(false);
    const Icon = STATUS_ICONS[test.status] || MinusCircle;
    return (
        <div className="tr-test-row">
            <div className="tr-test-main" onClick={() => test.errorMessage && setShowTrace(!showTrace)}>
                <Icon size={16} style={{ color: STATUS_COLORS[test.status], flexShrink: 0 }} />
                <span className="tr-test-name">{test.name}</span>
                <span className={`tr-status-badge ${test.status.toLowerCase()}`}>{test.status}</span>
                <span className="tr-test-dur">{test.duration}</span>
            </div>
            {showTrace && test.errorMessage && (
                <div className="tr-error-block animate-fade-in">
                    <p className="tr-error-msg">{test.errorMessage}</p>
                    {test.stackTrace && <pre className="tr-stack">{typeof test.stackTrace === 'string' ? test.stackTrace.substring(0, 600) : JSON.stringify(test.stackTrace).substring(0, 600)}</pre>}
                </div>
            )}
        </div>
    );
};

// ─── Live Console ───
const LiveConsole = ({ logs, isRunning }) => {
    const endRef = useRef(null);
    useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

    const colorize = (text) => {
        return text.split('\n').map((line, i) => {
            let cls = '';
            if (line.includes('[AAQUA]')) cls = 'log-aaqua';
            else if (line.includes('PASSED') || line.includes('BUILD SUCCESS') || line.includes('Tests run:') && !line.includes('Failures: 0') === false) cls = 'log-pass';
            else if (line.includes('FAILED') || line.includes('ERROR') || line.includes('BUILD FAILURE')) cls = 'log-fail';
            else if (line.includes('WARNING') || line.includes('SKIPPED')) cls = 'log-warn';
            return <div key={i} className={`log-line ${cls}`}>{line || '\u00A0'}</div>;
        });
    };

    return (
        <div className="tr-console">
            <div className="tr-console-header">
                <Terminal size={16} /> <span>Live Console</span>
                {isRunning && <span className="tr-console-dot" />}
            </div>
            <div className="tr-console-body">
                {logs ? colorize(logs) : <div className="log-line log-aaqua">Waiting to start...</div>}
                <div ref={endRef} />
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════
// ─── MAIN PAGE ───
// ═══════════════════════════════════════════
const TestRunner = () => {
    const { selectedProjectId } = useProject();
    const [projectPath, setProjectPath] = useState('');
    const [runId, setRunId] = useState(null);
    const [retrySourceRunId, setRetrySourceRunId] = useState(null);
    const [headed, setHeaded] = useState(() => {
        try { return localStorage.getItem(HEADED_PREF_KEY) === 'true'; } catch { return false; }
    });
    const [hasDisplayServer, setHasDisplayServer] = useState(false);
    const logCursorRef = useRef(0);
    const [framework, setFramework] = useState(null);
    const [projectRoot, setProjectRoot] = useState(null); // real server-side project root (may differ from projectPath if ZIP was uploaded)
    const [status, setStatus] = useState('idle'); // idle | running | completed | error
    const [logs, setLogs] = useState('');
    const [results, setResults] = useState(null);
    const [failedCount, setFailedCount] = useState(0);
    const [error, setError] = useState(null);
    const [hasRun, setHasRun] = useState(false);
    const [liveResults, setLiveResults] = useState(null);
    const [scheduleTime, setScheduleTime] = useState('');
    const [scheduleDate, setScheduleDate] = useState(new Date().toISOString().split('T')[0]); // default today
    const [isScheduled, setIsScheduled] = useState(false);
    const pollRef = useRef(null);
    const scheduleTimerRef = useRef(null);

    // ── Auto-Heal state (isolated — no effect on existing run/retry flow) ──
    const [healCandidates, setHealCandidates] = useState([]); // healable tests from results
    const [selectedHeals, setSelectedHeals] = useState({});   // { testKey: true/false }
    const [sharedPageUrl, setSharedPageUrl] = useState('');
    const [perTestUrls, setPerTestUrls] = useState({});       // { testKey: url }
    const [usePerTestUrls, setUsePerTestUrls] = useState(false);
    const [batchId, setBatchId] = useState(null);
    const [batchProgress, setBatchProgress] = useState(null); // { total, processed, results }
    const [batchDone, setBatchDone] = useState(false);
    const [healApplyState, setHealApplyState] = useState({}); // { testKey: { status, healRunId, reRunResult } }
    const batchPollRef = useRef(null);
    const healPollRefs = useRef({});

    // Persist the headed preference whenever the user toggles it.
    useEffect(() => {
        try { localStorage.setItem(HEADED_PREF_KEY, String(headed)); } catch { /* localStorage may be unavailable in some browsers */ }
    }, [headed]);

    // Fetch runtime info on mount to decide whether to show the headed toggle.
    // In the deployed container (no DISPLAY env var) we hide the control
    // entirely rather than offer something that can't work.
    useEffect(() => {
        getRuntimeInfo()
            .then(info => setHasDisplayServer(!!info.hasDisplayServer))
            .catch(() => setHasDisplayServer(false));
    }, []);

    // Polling — uses cursor-based delta so each tick only ships new chunks.
    const startPolling = useCallback((rid) => {
        if (pollRef.current) clearInterval(pollRef.current);
        logCursorRef.current = 0;
        pollRef.current = setInterval(async () => {
            try {
                const data = await getRunStatus(rid, logCursorRef.current);
                if (data.cursor != null) logCursorRef.current = data.cursor;
                if (data.logs) setLogs(prev => prev + data.logs);
                setStatus(data.status);
                setFramework(data.framework);
                // Live dashboard data (parsed from partial XML reports)
                if (data.liveResults && data.liveResults.summary) {
                    setLiveResults(data.liveResults);
                }
                if (data.status === 'completed' || data.status === 'error') {
                    clearInterval(pollRef.current);
                    pollRef.current = null;
                    setResults(data.results);
                    setFailedCount(data.failedCount || 0);
                    setLiveResults(null);
                    if (data.projectRoot) setProjectRoot(data.projectRoot);
                    if (data.error) setError(data.error);
                    setHasRun(true);
                }
            } catch (e) {
                console.error('Poll error:', e);
            }
        }, 1500);
    }, []);

    useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

    // Scheduler
    const handleSchedule = () => {
        if (!projectPath.trim() || !scheduleTime || !scheduleDate) return;
        const [h, m] = scheduleTime.split(':');
        const [year, month, day] = scheduleDate.split('-').map(Number);
        const target = new Date(year, month - 1, day, h, m, 0);
        const now = new Date();
        if (target <= now) {
            alert('Scheduled time must be in the future.');
            return;
        }
        const delay = target.getTime() - now.getTime();
        setIsScheduled(true);
        scheduleTimerRef.current = setTimeout(() => {
            setIsScheduled(false);
            handleRun();
        }, delay);
    };

    const handleCancelSchedule = () => {
        if (scheduleTimerRef.current) {
            clearTimeout(scheduleTimerRef.current);
            scheduleTimerRef.current = null;
        }
        setIsScheduled(false);
    };

    // Run
    const handleRun = async () => {
        if (!projectPath.trim()) return;
        setStatus('running'); setError(null); setResults(null); setLogs(''); setFailedCount(0); setLiveResults(null);
        logCursorRef.current = 0;
        try {
            const data = await runTestsLocal(projectPath.trim(), !headed, selectedProjectId || null);
            if (data.error) { setStatus('error'); setError(data.error); setHasRun(true); return; }
            setRunId(data.runId);
            setRetrySourceRunId(data.runId);
            setFramework(data.framework);
            startPolling(data.runId);
        } catch (e) {
            setStatus('error'); setError(e.message); setHasRun(true);
        }
    };

    // Retry
    const handleRetry = async () => {
        const sourceId = retrySourceRunId || runId;
        if (!sourceId) return;
        setStatus('running'); setError(null); setResults(null); setLogs(''); setFailedCount(0); setLiveResults(null);
        logCursorRef.current = 0;
        try {
            const data = await retryFailedTests(sourceId);
            if (data.error) { setStatus('error'); setError(data.error); return; }
            setRunId(data.runId);
            // keep retrySourceRunId as the original run's ID so retry can use it again if needed
            setFramework(data.framework);
            startPolling(data.runId);
        } catch (e) {
            setStatus('error'); setError(e.message);
        }
    };

    const isRunning = status === 'running';
    const canRetry = hasRun && !isRunning && failedCount > 0;
    const summary = results?.summary;
    const liveSummary = liveResults?.summary;

    // ── Derive heal candidates whenever results change ──
    useEffect(() => {
        if (!results?.suites) { setHealCandidates([]); setSelectedHeals({}); return; }
        const candidates = [];
        results.suites.forEach(suite => {
            suite.tests.forEach(test => {
                if (test.healable) {
                    candidates.push({ ...test, suiteName: suite.name, key: `${test.classname}#${test.name}` });
                }
            });
        });
        setHealCandidates(candidates);
        // Default all selected
        const sel = {};
        candidates.forEach(c => { sel[c.key] = true; });
        setSelectedHeals(sel);
        setBatchId(null); setBatchProgress(null); setBatchDone(false); setHealApplyState({});
    }, [results]);

    // ── Batch heal polling ──
    const stopBatchPoll = () => { if (batchPollRef.current) { clearInterval(batchPollRef.current); batchPollRef.current = null; } };

    const handleHealSelected = async () => {
        const selected = healCandidates.filter(c => selectedHeals[c.key]);
        if (selected.length === 0) return;
        const tests = selected.map(c => ({
            testName: c.name,
            classname: c.classname,
            errorMessage: c.errorMessage,
            stackTrace: c.stackTrace,
            pageUrl: usePerTestUrls ? (perTestUrls[c.key] || sharedPageUrl) : sharedPageUrl,
        }));
        try {
            const { batchId: bid } = await startBatchHeal(runId, tests);
            setBatchId(bid);
            setBatchDone(false);
            setBatchProgress({ total: tests.length, processed: 0, results: tests.map(t => ({ testName: t.testName, status: 'pending' })) });
            stopBatchPoll();
            batchPollRef.current = setInterval(async () => {
                try {
                    const data = await getBatchHealStatus(bid);
                    setBatchProgress(data);
                    if (data.processed >= data.total) {
                        stopBatchPoll();
                        setBatchDone(true);
                    }
                } catch (e) { console.error('Batch poll error:', e); }
            }, 2000);
        } catch (e) { alert(`Failed to start batch heal: ${e.message}`); }
    };

    const handleApplyHeal = async (candidate, suggestion) => {
        const key = candidate.key;
        if (!candidate.failedLocator?.value) {
            alert('Cannot extract original locator from error — please patch manually.');
            return;
        }
        setHealApplyState(prev => ({ ...prev, [key]: { status: 'applying' } }));
        try {
            const resp = await applyHeal({
                runId,
                testName: candidate.name,
                classname: candidate.classname,
                oldLocator: candidate.failedLocator.value,
                newLocator: suggestion.locator,
                newStrategy: suggestion.strategy,
                projectRoot: projectRoot || projectPath,   // prefer server-confirmed root; fall back to user-typed path
                framework,                  // always available — detected from the run
            });
            const { healRunId, patchedFrom, patchedTo } = resp;
            console.log(`[AutoHeal] Patched: "${patchedFrom}" → "${patchedTo}"`);
            setHealApplyState(prev => ({ ...prev, [key]: { status: 'rerunning', healRunId } }));
            // Poll heal re-run
            const pollHeal = setInterval(async () => {
                try {
                    const data = await getRunStatus(healRunId);
                    if (data.status === 'completed' || data.status === 'error') {
                        clearInterval(pollHeal);
                        const passed = data.results?.summary?.failed === 0;
                        setHealApplyState(prev => ({ ...prev, [key]: { status: passed ? 'healed' : 'still-failing', healRunId } }));
                    }
                } catch (e) { clearInterval(pollHeal); }
            }, 2000);
            healPollRefs.current[key] = pollHeal;
        } catch (e) {
            setHealApplyState(prev => ({ ...prev, [key]: { status: 'conflict', reason: e.message } }));
            alert(`Auto-heal apply failed:\n${e.message}`);
        }
    };

    useEffect(() => () => {
        stopBatchPoll();
        Object.values(healPollRefs.current).forEach(t => clearInterval(t));
    }, []);

    // Download report as HTML
    const handleDownloadReport = () => {
        if (!results || !summary) return;
        const passRate = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;
        const now = new Date().toLocaleString();
        const suitesHtml = (results.suites || []).map(suite => {
            const testsHtml = suite.tests.map(t => `
                <tr>
                    <td>${t.name}</td>
                    <td>${t.classname || '-'}</td>
                    <td><span class="badge ${t.status.toLowerCase()}">${t.status}</span></td>
                    <td>${t.duration}</td>
                    <td class="error-cell">${t.errorMessage || '-'}</td>
                </tr>`).join('');
            return `<div class="suite"><h3>${suite.name} <small>(${suite.duration})</small></h3><table><thead><tr><th>Test</th><th>Class</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead><tbody>${testsHtml}</tbody></table></div>`;
        }).join('');

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Test Report - ${now}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',sans-serif;background:#0f1117;color:#e0e0e0;padding:2rem}
  h1{font-size:1.8rem;margin-bottom:.3rem;background:linear-gradient(to right,#a78bfa,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .subtitle{color:#9ca3af;margin-bottom:2rem;font-size:.9rem}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-bottom:2rem}
  .card{background:#1a1b26;border:1px solid #2a2d3a;border-radius:12px;padding:1.2rem;text-align:center}
  .card .val{font-size:2rem;font-weight:700;display:block}
  .card .lbl{font-size:.8rem;color:#9ca3af}
  .card.total .val{color:#818cf8} .card.pass .val{color:#34d399} .card.fail .val{color:#f87171} .card.skip .val{color:#fbbf24}
  .rate{text-align:center;margin-bottom:2rem;font-size:3rem;font-weight:700;color:#34d399}
  .rate small{font-size:1rem;color:#9ca3af;display:block}
  .suite{margin-bottom:1.5rem;background:#1a1b26;border:1px solid #2a2d3a;border-radius:12px;overflow:hidden}
  .suite h3{padding:1rem;font-size:1rem;border-bottom:1px solid #2a2d3a}
  .suite h3 small{color:#9ca3af;font-weight:400}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:.6rem 1rem;font-size:.75rem;text-transform:uppercase;color:#9ca3af;border-bottom:1px solid #2a2d3a}
  td{padding:.6rem 1rem;font-size:.85rem;border-bottom:1px solid rgba(255,255,255,.03)}
  .badge{padding:2px 10px;border-radius:10px;font-size:.7rem;font-weight:700}
  .badge.passed{background:rgba(16,185,129,.12);color:#34d399}
  .badge.failed{background:rgba(239,68,68,.12);color:#f87171}
  .badge.skipped{background:rgba(245,158,11,.12);color:#fbbf24}
  .error-cell{max-width:300px;font-size:.78rem;color:#f87171;word-break:break-all}
  footer{margin-top:2rem;text-align:center;color:#4b5563;font-size:.75rem}
</style></head><body>
  <h1>Test Execution Report</h1>
  <p class="subtitle">Generated: ${now} &bull; Framework: ${framework?.toUpperCase() || 'N/A'} &bull; Duration: ${summary.duration}</p>
  <div class="cards">
    <div class="card total"><span class="val">${summary.total}</span><span class="lbl">Total</span></div>
    <div class="card pass"><span class="val">${summary.passed}</span><span class="lbl">Passed</span></div>
    <div class="card fail"><span class="val">${summary.failed}</span><span class="lbl">Failed</span></div>
    <div class="card skip"><span class="val">${summary.skipped}</span><span class="lbl">Skipped</span></div>
  </div>
  <div class="rate">${passRate}%<small>Pass Rate</small></div>
  ${suitesHtml}
  <footer>AAQUA Test Runner &mdash; Auto-generated report</footer>
</body></html>`;

        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const fileName = `testreport_${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.html`;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        
        // Delay revocation to ensure the browser captures the filename and starts downloading before blob is destroyed
        setTimeout(() => {
            URL.revokeObjectURL(url);
            a.remove();
        }, 5000);
    };

    return (
        <div className="tr-page animate-fade-in">
            <div className="tr-header">
                <h1><BarChart3 size={28} style={{ verticalAlign: 'middle', marginRight: 8 }} />Test Runner</h1>
                <p className="tr-subtitle">Run your test suite and view live results with an interactive dashboard</p>
            </div>

            {/* Input Panel */}
            <div className="tr-input-panel card">
                <div className="tr-input-row">
                    <FolderOpen size={20} style={{ color: 'var(--accent-secondary)', flexShrink: 0 }} />
                    <div style={{ display: 'flex', flex: 1, gap: '0.5rem' }}>
                        <input
                            type="text"
                            className="input-field"
                            placeholder="Enter project path, e.g. D:\MyProject"
                            value={projectPath}
                            onChange={(e) => setProjectPath(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && !isRunning && handleRun()}
                            disabled={isRunning || isScheduled}
                            style={{ flex: 1 }}
                        />
                        <button 
                            className="btn" 
                            style={{ padding: '0.5rem 1rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}
                            onClick={async () => {
                                try {
                                    const res = await fetch('http://localhost:3001/api/browse-folder');
                                    const data = await res.json();
                                    if (data.path) setProjectPath(data.path);
                                } catch (err) {
                                    console.error("Browse folder error:", err);
                                }
                            }}
                            disabled={isRunning || isScheduled}
                        >
                            Browse
                        </button>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem', cursor: hasDisplayServer ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap', opacity: hasDisplayServer ? 1 : 0.5 }} title={!hasDisplayServer ? "No display server detected on host. Headed mode is disabled." : ""}>
                        <input
                            type="checkbox"
                            checked={headed}
                            onChange={(e) => setHeaded(e.target.checked)}
                            disabled={isRunning || isScheduled || !hasDisplayServer}
                        />
                        Show Browser (Headed)
                    </label>
                    <button className="btn btn-primary" onClick={handleRun} disabled={isRunning || isScheduled || !projectPath.trim()}>
                        <Play size={18} />{isRunning ? 'Running...' : 'Run Tests'}
                    </button>
                    <button className="btn btn-retry" onClick={handleRetry} disabled={!canRetry} title={!canRetry ? (isRunning ? 'Wait for run to finish' : failedCount === 0 ? 'No failed tests' : 'Run tests first') : 'Re-run failed tests'}>
                        <RotateCcw size={18} />Re-Run Failed
                    </button>
                </div>

                {/* Scheduler Row */}
                <div className="tr-scheduler-row">
                    <CalendarClock size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Schedule for:</span>
                    <input
                        type="date"
                        className="input-field tr-time-input"
                        value={scheduleDate}
                        min={new Date().toISOString().split('T')[0]}
                        onChange={(e) => setScheduleDate(e.target.value)}
                        disabled={isRunning || isScheduled}
                    />
                    <input
                        type="time"
                        className="input-field tr-time-input"
                        value={scheduleTime}
                        onChange={(e) => setScheduleTime(e.target.value)}
                        disabled={isRunning || isScheduled}
                    />
                    <button
                        className="btn tr-schedule-btn"
                        onClick={handleSchedule}
                        disabled={isRunning || isScheduled || !scheduleTime || !scheduleDate || !projectPath.trim()}
                    >
                        <CalendarClock size={16} /> Schedule Run
                    </button>
                    {isScheduled && (
                        <button className="btn tr-cancel-schedule-btn" onClick={handleCancelSchedule}>
                            ✕ Cancel
                        </button>
                    )}
                </div>

                {isScheduled && (
                    <div className="tr-schedule-banner animate-fade-in">
                        <CalendarClock size={18} />
                        <span>Test run scheduled for <strong>{new Date(`${scheduleDate}T${scheduleTime}`).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</strong>. Keep this tab open.</span>
                    </div>
                )}

                {framework && <div className="tr-framework-badge">Framework: <strong>{framework.toUpperCase()}</strong></div>}
            </div>

            {/* Error */}
            {error && status === 'error' && (
                <div className="tr-error-banner animate-fade-in">
                    <AlertTriangle size={18} /> {error}
                </div>
            )}

            {/* Live Console */}
            {(isRunning || logs) && <LiveConsole logs={logs} isRunning={isRunning} />}

            {/* Live Dashboard (during execution) */}
            {isRunning && liveResults && liveSummary && (
                <div className="tr-live-results animate-fade-in">
                    <h2 className="tr-results-title">Live Dashboard <span className="tr-live-indicator">● LIVE</span></h2>

                    <div className="tr-dashboard-grid">
                        <div className="tr-stats-row">
                            <SummaryCard label="Total" value={liveSummary.total} color="var(--accent-secondary)" icon={BarChart3} />
                            <SummaryCard label="Passed" value={liveSummary.passed} color="var(--success)" icon={CheckCircle2} />
                            <SummaryCard label="Failed" value={liveSummary.failed} color="var(--error)" icon={XCircle} />
                            <SummaryCard label="Skipped" value={liveSummary.skipped} color="var(--warning)" icon={MinusCircle} />
                        </div>

                        <div className="tr-visual-row">
                            <DonutChart passed={liveSummary.passed} failed={liveSummary.failed} skipped={liveSummary.skipped} />
                            <div className="tr-duration-card card">
                                <Clock size={20} style={{ color: 'var(--accent-secondary)' }} />
                                <span className="tr-dur-label">Elapsed</span>
                                <span className="tr-dur-value">{liveSummary.duration}</span>
                            </div>
                        </div>
                    </div>

                    {liveResults.suites && liveResults.suites.length > 0 && (
                        <div className="tr-suites-section">
                            <h3>Suite Breakdown</h3>
                            {liveResults.suites.map((suite, i) => <SuiteRow key={i} suite={suite} />)}
                        </div>
                    )}
                </div>
            )}

            {/* ── AUTO-HEAL CANDIDATES PANEL ── */}
            {healCandidates.length > 0 && status === 'completed' && (
                <div className="ah-panel animate-fade-in">
                    <div className="ah-panel-header">
                        <div className="ah-title">
                            <Wrench size={18} />
                            <span>Auto-Heal Candidates</span>
                            <span className="ah-count-badge">{healCandidates.length} of {summary?.failed || 0} failures healable</span>
                        </div>
                        <div className="ah-header-actions">
                            <button className="ah-select-all" onClick={() => {
                                const allSel = healCandidates.every(c => selectedHeals[c.key]);
                                const next = {}; healCandidates.forEach(c => { next[c.key] = !allSel; });
                                setSelectedHeals(next);
                            }}>
                                {healCandidates.every(c => selectedHeals[c.key]) ? '☑ Deselect All' : '☐ Select All'}
                            </button>
                            <button
                                className="btn ah-heal-btn"
                                onClick={handleHealSelected}
                                disabled={!Object.values(selectedHeals).some(Boolean) || !!batchId || !sharedPageUrl.trim()}
                            >
                                <Wrench size={15} /> Heal Selected
                            </button>
                        </div>
                    </div>

                    {/* Shared URL input */}
                    <div className="ah-url-row">
                        <Clock size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                        <span className="ah-url-label">Page URL:</span>
                        <input
                            type="url"
                            className="input-field ah-url-input"
                            placeholder="https://your-app.com/page-under-test"
                            value={sharedPageUrl}
                            onChange={e => setSharedPageUrl(e.target.value)}
                        />
                        <label className="ah-per-test-toggle">
                            <input type="checkbox" checked={usePerTestUrls} onChange={e => setUsePerTestUrls(e.target.checked)} />
                            Different pages
                        </label>
                    </div>

                    {/* Candidates table */}
                    <div className="ah-table">
                        {healCandidates.map(c => {
                            const applyState = healApplyState[c.key];
                            const batchItem = batchProgress?.results?.find(r => r.testName === c.name);
                            return (
                                <div key={c.key} className="ah-row">
                                    <input
                                        type="checkbox"
                                        checked={!!selectedHeals[c.key]}
                                        onChange={e => setSelectedHeals(prev => ({ ...prev, [c.key]: e.target.checked }))}
                                        disabled={!!batchId}
                                    />
                                    <div className="ah-test-info">
                                        <span className="ah-test-name">{c.name}</span>
                                        <span className="ah-exception">{c.errorMessage?.split(':')[0] || 'Element not found'}</span>
                                    </div>
                                    {usePerTestUrls && (
                                        <input
                                            type="url"
                                            className="input-field ah-per-url"
                                            placeholder={sharedPageUrl || 'https://...'}
                                            value={perTestUrls[c.key] || ''}
                                            onChange={e => setPerTestUrls(prev => ({ ...prev, [c.key]: e.target.value }))}
                                        />
                                    )}
                                    {/* Batch status badge */}
                                    {batchItem && (
                                        <span className={`ah-status-badge ah-status-${batchItem.status}`}>
                                            {batchItem.status === 'pending' && '⏳ Pending'}
                                            {batchItem.status === 'healing' && '🔄 Analysing...'}
                                            {batchItem.status === 'suggestions-ready' && `✅ ${batchItem.suggestions?.length} suggestions`}
                                            {batchItem.status === 'no-suggestion' && '❌ No suggestion'}
                                            {batchItem.status === 'conflict' && '🔶 Conflict'}
                                        </span>
                                    )}
                                    {/* Apply buttons — shown when suggestions ready */}
                                    {batchItem?.status === 'suggestions-ready' && !applyState && (
                                        <div className="ah-suggestions">
                                            {batchItem.suggestions.slice(0, 3).map((s, i) => (
                                                <div key={i} className="ah-suggestion-row">
                                                    <span className="ah-conf-bar" style={{ '--conf': s.confidence + '%' }} title={`${s.confidence}% confidence`}>
                                                        <span className="ah-conf-fill" />
                                                    </span>
                                                    <code className="ah-locator-code">{s.locator}</code>
                                                    <span className="ah-strategy-tag">{s.strategy}</span>
                                                    <span className="ah-conf-pct">{s.confidence}%</span>
                                                    <button className="btn ah-apply-btn" onClick={() => handleApplyHeal(c, s)}>Apply</button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {/* Apply state feedback */}
                                    {applyState?.status === 'applying' && <span className="ah-status-badge ah-status-healing">🔄 Patching file...</span>}
                                    {applyState?.status === 'rerunning' && <span className="ah-status-badge ah-status-healing">🔄 Re-running test...</span>}
                                    {applyState?.status === 'healed' && <span className="ah-status-badge ah-status-healed">✅ Healed &amp; Passing</span>}
                                    {applyState?.status === 'still-failing' && <span className="ah-status-badge ah-status-failing">⚠️ Still Failing — try another</span>}
                                    {applyState?.status === 'conflict' && <span className="ah-status-badge ah-status-conflict" title={applyState.reason}>🔶 Conflict — manual review</span>}
                                </div>
                            );
                        })}
                    </div>

                    {/* Batch progress bar */}
                    {batchId && batchProgress && (
                        <div className="ah-progress-row">
                            <div className="ah-progress-track">
                                <div className="ah-progress-fill" style={{ width: `${(batchProgress.processed / batchProgress.total) * 100}%` }} />
                            </div>
                            <span className="ah-progress-label">{batchProgress.processed} / {batchProgress.total} processed</span>
                        </div>
                    )}

                    {/* Batch summary */}
                    {batchDone && batchProgress && (() => {
                        const r = batchProgress.results;
                        const healed = r.filter(x => x.status === 'suggestions-ready').length;
                        const noSug = r.filter(x => x.status === 'no-suggestion').length;
                        const conflict = r.filter(x => x.status === 'conflict').length;
                        return (
                            <div className="ah-summary-box animate-fade-in">
                                <span className="ah-sum-title">Batch Analysis Complete</span>
                                <span className="ah-sum-item green">✅ With suggestions: {healed}</span>
                                <span className="ah-sum-item red">❌ No suggestion found: {noSug}</span>
                                <span className="ah-sum-item orange">🔶 Conflicts: {conflict}</span>
                            </div>
                        );
                    })()}
                </div>
            )}

            {/* Results Dashboard */}
            {results && status === 'completed' && (
                <div className="tr-results animate-fade-in">
                    <div className="tr-results-header">
                        <h2 className="tr-results-title">Results Dashboard</h2>
                        <button className="btn btn-download" onClick={handleDownloadReport}>
                            <Download size={16} /> Download Report
                        </button>
                    </div>

                    <div className="tr-dashboard-grid">
                        {/* Summary Cards */}
                        <div className="tr-stats-row">
                            <SummaryCard label="Total" value={summary.total} color="var(--accent-secondary)" icon={BarChart3} />
                            <SummaryCard label="Passed" value={summary.passed} color="var(--success)" icon={CheckCircle2} />
                            <SummaryCard label="Failed" value={summary.failed} color="var(--error)" icon={XCircle} />
                            <SummaryCard label="Skipped" value={summary.skipped} color="var(--warning)" icon={MinusCircle} />
                        </div>

                        {/* Donut + Duration */}
                        <div className="tr-visual-row">
                            <DonutChart passed={summary.passed} failed={summary.failed} skipped={summary.skipped} />
                            <div className="tr-duration-card card">
                                <Clock size={20} style={{ color: 'var(--accent-secondary)' }} />
                                <span className="tr-dur-label">Total Duration</span>
                                <span className="tr-dur-value">{summary.duration}</span>
                            </div>
                        </div>
                    </div>

                    {/* Suite Breakdown */}
                    {results.suites && results.suites.length > 0 && (
                        <div className="tr-suites-section">
                            <h3>Suite Breakdown</h3>
                            {results.suites.map((suite, i) => <SuiteRow key={i} suite={suite} />)}
                        </div>
                    )}
                </div>
            )}

            <style>{`
        .tr-page { padding: 1rem; }
        .tr-header { margin-bottom: 2rem; }
        .tr-header h1 {
          font-size: 2rem; margin-bottom: 0.5rem;
          background: linear-gradient(to right, var(--accent-primary), var(--accent-secondary));
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .tr-subtitle { color: var(--text-secondary); }

        /* Scheduler */
        .tr-scheduler-row {
          display: flex; align-items: center; gap: 0.75rem;
          margin-top: 0.75rem; padding-top: 0.75rem;
          border-top: 1px dashed var(--border-color);
        }
        .tr-time-input {
          width: 130px; flex: none;
          padding: 0.5rem 0.75rem; font-size: 0.9rem;
        }
        .tr-schedule-btn {
          background: rgba(59,130,246,0.12);
          color: #93c5fd;
          border: 1px solid rgba(59,130,246,0.35);
          border-radius: var(--radius-md);
          padding: 0.55rem 1rem;
          font-size: 0.85rem; font-weight: 600;
          display: flex; align-items: center; gap: 0.4rem;
          transition: all 0.2s;
        }
        .tr-schedule-btn:hover:not(:disabled) {
          background: rgba(59,130,246,0.22);
          border-color: rgba(59,130,246,0.6);
        }
        .tr-schedule-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .tr-cancel-schedule-btn {
          background: rgba(239,68,68,0.1);
          color: #fca5a5;
          border: 1px solid rgba(239,68,68,0.35);
          border-radius: var(--radius-md);
          padding: 0.55rem 0.9rem;
          font-size: 0.85rem; font-weight: 600;
          cursor: pointer; transition: all 0.2s;
        }
        .tr-cancel-schedule-btn:hover { background: rgba(239,68,68,0.2); }
        .tr-schedule-banner {
          display: flex; align-items: center; gap: 0.75rem;
          margin-top: 0.75rem; padding: 0.85rem 1rem;
          background: rgba(59,130,246,0.08);
          border: 1px solid rgba(59,130,246,0.3);
          border-radius: var(--radius-md);
          color: #93c5fd; font-size: 0.9rem;
        }
        .tr-schedule-banner strong { color: #bfdbfe; }

        /* Input Panel */
        .tr-input-panel { margin-bottom: 1.5rem; }
        .tr-input-row { display: flex; align-items: center; gap: 0.75rem; }
        .tr-input-row .input-field { flex: 1; }
        .tr-framework-badge {
          margin-top: 0.75rem; font-size: 0.8rem; color: var(--text-secondary);
          padding: 0.35rem 0.75rem; background: var(--bg-tertiary);
          border-radius: var(--radius-sm); display: inline-block;
        }
        .tr-headed-toggle {
          margin-top: 0.75rem; margin-right: 0.75rem;
          display: inline-flex; align-items: center; gap: 0.5rem;
          font-size: 0.8rem; color: var(--text-secondary);
          padding: 0.35rem 0.75rem; background: var(--bg-tertiary);
          border-radius: var(--radius-sm); cursor: pointer; user-select: none;
        }
        .tr-headed-toggle input { cursor: pointer; }
        .tr-headed-toggle input:disabled { cursor: not-allowed; }
        .btn-retry {
          display: inline-flex; align-items: center; gap: 0.5rem;
          padding: 0.75rem 1.25rem; border-radius: var(--radius-md);
          font-weight: 600; cursor: pointer; border: 1px solid var(--error);
          background: transparent; color: var(--error); transition: all 0.2s;
        }
        .btn-retry:hover:not(:disabled) { background: rgba(239, 68, 68, 0.1); }
        .btn-retry:disabled { opacity: 0.35; cursor: not-allowed; border-color: var(--border-color); color: var(--text-muted); }

        /* Error Banner */
        .tr-error-banner {
          display: flex; align-items: center; gap: 0.5rem;
          padding: 1rem 1.25rem; background: rgba(239, 68, 68, 0.08);
          border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--radius-md);
          color: var(--error); margin-bottom: 1.5rem; font-size: 0.9rem;
        }

        /* Console */
        .tr-console { margin-bottom: 1.5rem; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border-color); }
        .tr-console-header {
          display: flex; align-items: center; gap: 0.5rem;
          padding: 0.75rem 1rem; background: var(--bg-tertiary);
          font-size: 0.85rem; font-weight: 600; color: var(--text-secondary);
        }
        .tr-console-dot {
          width: 8px; height: 8px; border-radius: 50%; background: var(--success);
          animation: consolePulse 1.2s ease-in-out infinite; margin-left: auto;
        }
        @keyframes consolePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .tr-console-body {
          background: #0d0d14; padding: 1rem; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
          font-size: 0.78rem; line-height: 1.6; max-height: 380px; overflow-y: auto;
          color: #c4c4c4;
        }
        .log-line { white-space: pre-wrap; word-break: break-all; }
        .log-aaqua { color: #a78bfa; font-weight: 600; }
        .log-pass { color: #34d399; }
        .log-fail { color: #f87171; }
        .log-warn { color: #fbbf24; }

        /* Results */
        .tr-results { margin-top: 1rem; }
        .tr-results-header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 1.5rem;
        }
        .tr-results-title {
          font-size: 1.4rem; font-weight: 700;
          background: linear-gradient(to right, var(--accent-primary), var(--accent-secondary));
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .btn-download {
          display: inline-flex; align-items: center; gap: 0.5rem;
          padding: 0.6rem 1.1rem; border-radius: var(--radius-md);
          font-weight: 600; font-size: 0.8rem; cursor: pointer;
          border: 1px solid var(--accent-secondary); background: transparent;
          color: var(--accent-secondary); transition: all 0.2s;
        }
        .btn-download:hover { background: rgba(167,139,250,0.1); }

        /* Stats Row */
        .tr-stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
        .tr-stat-card {
          display: flex; align-items: center; gap: 1rem;
          padding: 1.25rem; background: var(--bg-secondary);
          border: 1px solid var(--border-color); border-radius: var(--radius-md);
          transition: transform 0.2s;
        }
        .tr-stat-card:hover { transform: translateY(-2px); }
        .tr-stat-icon { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; }
        .tr-stat-value { font-size: 1.6rem; font-weight: 700; display: block; }
        .tr-stat-label { font-size: 0.8rem; color: var(--text-secondary); }

        /* Visual Row */
        .tr-visual-row { display: flex; gap: 1.5rem; margin-bottom: 1.5rem; align-items: stretch; }
        .tr-donut-wrap {
          flex: 1; display: flex; align-items: center; gap: 2rem;
          padding: 1.5rem; background: var(--bg-secondary);
          border: 1px solid var(--border-color); border-radius: var(--radius-md);
        }
        .tr-donut-svg { width: 140px; height: 140px; flex-shrink: 0; }
        .tr-donut-legend { display: flex; flex-direction: column; gap: 0.6rem; font-size: 0.85rem; }
        .tr-donut-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; }
        .tr-duration-card {
          min-width: 180px; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 0.5rem; text-align: center;
        }
        .tr-dur-label { font-size: 0.8rem; color: var(--text-secondary); }
        .tr-dur-value { font-size: 1.8rem; font-weight: 700; }

        /* Suites */
        .tr-suites-section h3 { font-size: 1.1rem; margin-bottom: 1rem; font-weight: 600; }
        .tr-suite { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-md); margin-bottom: 0.6rem; overflow: hidden; }
        .tr-suite-header {
          display: flex; align-items: center; gap: 0.75rem;
          padding: 0.9rem 1rem; cursor: pointer; transition: background 0.15s;
        }
        .tr-suite-header:hover { background: var(--bg-tertiary); }
        .tr-suite-chevron { color: var(--text-muted); }
        .tr-suite-name { flex: 1; font-weight: 600; font-size: 0.9rem; }
        .tr-suite-counts { display: flex; gap: 0.4rem; }
        .tr-mini-badge {
          font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; font-weight: 600;
        }
        .tr-mini-badge.pass { background: rgba(16,185,129,0.12); color: var(--success); }
        .tr-mini-badge.fail { background: rgba(239,68,68,0.12); color: var(--error); }
        .tr-mini-badge.skip { background: rgba(245,158,11,0.12); color: var(--warning); }
        .tr-suite-duration { font-size: 0.8rem; color: var(--text-muted); min-width: 60px; text-align: right; }

        /* Test Row */
        .tr-suite-tests { border-top: 1px solid var(--border-color); }
        .tr-test-row { border-bottom: 1px solid var(--border-color); }
        .tr-test-row:last-child { border-bottom: none; }
        .tr-test-main {
          display: flex; align-items: center; gap: 0.75rem;
          padding: 0.65rem 1rem 0.65rem 2.25rem; cursor: pointer; transition: background 0.15s;
        }
        .tr-test-main:hover { background: var(--bg-tertiary); }
        .tr-test-name { flex: 1; font-size: 0.85rem; }
        .tr-status-badge {
          font-size: 0.7rem; padding: 2px 10px; border-radius: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
        }
        .tr-status-badge.passed { background: rgba(16,185,129,0.12); color: var(--success); }
        .tr-status-badge.failed { background: rgba(239,68,68,0.12); color: var(--error); }
        .tr-status-badge.skipped { background: rgba(245,158,11,0.12); color: var(--warning); }
        .tr-test-dur { font-size: 0.78rem; color: var(--text-muted); min-width: 60px; text-align: right; }

        /* Error Block */
        .tr-error-block { padding: 0.75rem 1rem 0.75rem 2.25rem; background: rgba(239,68,68,0.04); }
        .tr-error-msg { font-size: 0.8rem; color: var(--error); margin-bottom: 0.5rem; }
        .tr-stack {
          font-size: 0.72rem; color: var(--text-muted); font-family: monospace;
          white-space: pre-wrap; word-break: break-all; background: var(--bg-primary);
          padding: 0.5rem; border-radius: 6px; max-height: 200px; overflow-y: auto;
        }

        /* Live Results */
        .tr-live-results { margin-top: 1rem; margin-bottom: 1.5rem; }
        .tr-live-indicator {
          font-size: 0.75rem; color: var(--error); margin-left: 0.75rem;
          animation: consolePulse 1.2s ease-in-out infinite; font-weight: 600;
          -webkit-text-fill-color: var(--error);
        }
        .tr-live-table {
          background: var(--bg-secondary); border: 1px solid var(--border-color);
          border-radius: var(--radius-md); overflow: hidden;
        }

        @media (max-width: 900px) {
          .tr-stats-row { grid-template-columns: repeat(2, 1fr); }
          .tr-visual-row { flex-direction: column; }
          .tr-input-row { flex-wrap: wrap; }
        }

        /* ── Auto-Heal Panel ── */
        .ah-panel {
          background: var(--bg-secondary);
          border: 1px solid rgba(245,158,11,0.35);
          border-radius: var(--radius-lg);
          padding: 1.25rem;
          margin-bottom: 1.5rem;
        }
        .ah-panel-header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem;
        }
        .ah-title {
          display: flex; align-items: center; gap: 0.6rem;
          font-size: 1rem; font-weight: 700; color: #fbbf24;
        }
        .ah-count-badge {
          font-size: 0.75rem; font-weight: 500; color: var(--text-secondary);
          background: var(--bg-tertiary); border-radius: 20px; padding: 2px 10px;
        }
        .ah-header-actions { display: flex; align-items: center; gap: 0.75rem; }
        .ah-select-all {
          background: none; border: 1px solid var(--border-color);
          color: var(--text-secondary); border-radius: var(--radius-sm);
          padding: 0.4rem 0.75rem; font-size: 0.8rem; cursor: pointer;
          transition: all 0.2s;
        }
        .ah-select-all:hover { border-color: var(--border-focus); color: var(--text-primary); }
        .ah-heal-btn {
          background: rgba(245,158,11,0.15); color: #fbbf24;
          border: 1px solid rgba(245,158,11,0.4); border-radius: var(--radius-md);
          padding: 0.5rem 1rem; font-size: 0.85rem; font-weight: 600;
          display: flex; align-items: center; gap: 0.4rem; transition: all 0.2s;
        }
        .ah-heal-btn:hover:not(:disabled) { background: rgba(245,158,11,0.25); }
        .ah-heal-btn:disabled { opacity: 0.35; cursor: not-allowed; }

        /* URL row */
        .ah-url-row {
          display: flex; align-items: center; gap: 0.75rem;
          margin-bottom: 1rem; flex-wrap: wrap;
        }
        .ah-url-label { font-size: 0.82rem; color: var(--text-muted); white-space: nowrap; }
        .ah-url-input { flex: 1; min-width: 200px; padding: 0.5rem 0.75rem; font-size: 0.85rem; }
        .ah-per-test-toggle {
          display: flex; align-items: center; gap: 0.4rem;
          font-size: 0.8rem; color: var(--text-secondary); cursor: pointer; white-space: nowrap;
        }

        /* Candidates table */
        .ah-table { display: flex; flex-direction: column; gap: 0.5rem; }
        .ah-row {
          display: flex; align-items: flex-start; gap: 0.75rem; flex-wrap: wrap;
          padding: 0.75rem; background: var(--bg-tertiary);
          border-radius: var(--radius-md); border: 1px solid var(--border-color);
        }
        .ah-test-info { display: flex; flex-direction: column; gap: 0.15rem; flex: 1; min-width: 160px; }
        .ah-test-name { font-size: 0.88rem; font-weight: 600; color: var(--text-primary); }
        .ah-exception { font-size: 0.75rem; color: var(--error); font-family: monospace; }
        .ah-per-url { width: 200px; padding: 0.4rem 0.6rem; font-size: 0.8rem; }

        /* Status badges */
        .ah-status-badge {
          font-size: 0.75rem; font-weight: 600; padding: 3px 10px;
          border-radius: 10px; white-space: nowrap; align-self: center;
        }
        .ah-status-pending { background: rgba(156,163,175,0.15); color: var(--text-muted); }
        .ah-status-healing { background: rgba(59,130,246,0.12); color: #93c5fd; }
        .ah-status-suggestions-ready { background: rgba(16,185,129,0.12); color: var(--success); }
        .ah-status-healed { background: rgba(16,185,129,0.15); color: var(--success); }
        .ah-status-no-suggestion { background: rgba(239,68,68,0.1); color: var(--error); }
        .ah-status-conflict { background: rgba(245,158,11,0.12); color: #fbbf24; }
        .ah-status-failing { background: rgba(245,158,11,0.12); color: #fbbf24; }

        /* Suggestions list */
        .ah-suggestions { width: 100%; margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
        .ah-suggestion-row {
          display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
          padding: 0.5rem 0.75rem; background: var(--bg-primary);
          border-radius: var(--radius-sm); border: 1px solid var(--border-color);
        }
        .ah-conf-bar {
          width: 60px; height: 6px; background: var(--bg-tertiary);
          border-radius: 3px; flex-shrink: 0; position: relative; overflow: hidden;
        }
        .ah-conf-fill {
          position: absolute; left: 0; top: 0; height: 100%;
          width: var(--conf, 0%); background: var(--success); border-radius: 3px;
        }
        .ah-locator-code { font-family: monospace; font-size: 0.78rem; color: #a78bfa; flex: 1; min-width: 100px; word-break: break-all; }
        .ah-strategy-tag {
          font-size: 0.68rem; background: rgba(99,102,241,0.15); color: #818cf8;
          padding: 1px 6px; border-radius: 6px; font-weight: 600;
        }
        .ah-conf-pct { font-size: 0.75rem; color: var(--text-muted); min-width: 34px; text-align: right; }
        .ah-apply-btn {
          background: rgba(16,185,129,0.12); color: var(--success);
          border: 1px solid rgba(16,185,129,0.3); border-radius: var(--radius-sm);
          padding: 0.3rem 0.75rem; font-size: 0.78rem; font-weight: 600; cursor: pointer;
          transition: all 0.2s; white-space: nowrap;
        }
        .ah-apply-btn:hover { background: rgba(16,185,129,0.22); }

        /* Progress */
        .ah-progress-row { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.75rem; }
        .ah-progress-track { flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
        .ah-progress-fill { height: 100%; background: linear-gradient(to right, var(--accent-primary), var(--accent-secondary)); border-radius: 3px; transition: width 0.4s ease; }
        .ah-progress-label { font-size: 0.78rem; color: var(--text-muted); white-space: nowrap; }

        /* Summary box */
        .ah-summary-box {
          display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap;
          margin-top: 0.75rem; padding: 0.85rem 1rem;
          background: var(--bg-tertiary); border-radius: var(--radius-md);
          border: 1px solid var(--border-color);
        }
        .ah-sum-title { font-size: 0.85rem; font-weight: 700; color: var(--text-primary); }
        .ah-sum-item { font-size: 0.82rem; font-weight: 500; }
        .ah-sum-item.green { color: var(--success); }
        .ah-sum-item.red { color: var(--error); }
        .ah-sum-item.orange { color: #fbbf24; }
      `}</style>

        </div>
    );
};

export default TestRunner;
