import React from 'react';
import { useApiTestGen } from '../context/ApiTestGenContext';
import { useProject } from '../context/ProjectContext';
import { Webhook, Link2, FileCode, Upload, Loader2, AlertTriangle, Search, Lock, Sparkles, CheckCircle, XCircle, RefreshCw, Download, ListPlus, Plus, Trash2, Workflow, ArrowUp, ArrowDown, Clock } from 'lucide-react';
import { parseSpec, generateTestCases, downloadAutomationProject, generateFlows, downloadFlowProject, downloadLoadTest } from '../services/apiTestGenService';
import { exportToExcel, exportToJSON } from '../utils/exportUtils';

const METHOD_COLORS = {
    GET: '#22c55e',
    POST: '#3b82f6',
    PUT: '#f59e0b',
    PATCH: '#eab308',
    DELETE: '#ef4444',
    HEAD: '#6b7280',
    OPTIONS: '#6b7280',
};

const CATEGORY_COLORS = {
    positive: '#22c55e',
    negative: '#f59e0b',
    auth: '#a855f7',
    schema: '#3b82f6',
    boundary: '#ef4444',
};

const ALL_CATEGORIES = ['positive', 'negative', 'auth', 'schema', 'boundary'];
const DEFAULT_CATEGORIES = ['positive', 'negative', 'schema'];

const epKey = (e) => `${e.method} ${e.path}`;

// Format an elapsed-seconds value as "12.3s" or "1m 05s".
const fmtDuration = (s) => {
    if (s == null) return '';
    if (s >= 60) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
    return `${s.toFixed(1)}s`;
};

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Build a normalized catalog from manually-entered endpoint rows — same shape
// parseSpec() returns, so the rest of the pipeline (generate → download) is
// unchanged. A row's URI may be a full URL (origin becomes the server) or a
// bare path (combined with the optional Base URL).
function buildManualCatalog(baseUrl, rows) {
    let serverUrl = (baseUrl || '').trim().replace(/\/$/, '');
    const endpoints = [];
    for (const r of rows) {
        const uri = (r.uri || '').trim();
        if (!r.method || !uri) continue;
        let path = uri;
        if (/^https?:\/\//i.test(uri)) {
            try {
                const u = new URL(uri);
                if (!serverUrl) serverUrl = u.origin;
                path = u.pathname + (u.search || '');
            } catch { /* keep raw uri as path */ }
        }
        if (!path.startsWith('/')) path = '/' + path;
        const method = r.method.toUpperCase();
        const status = parseInt(r.expectedStatus, 10) || 200;
        endpoints.push({
            operationId: `${method.toLowerCase()}_${path}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || `endpoint_${endpoints.length}`,
            method,
            path,
            summary: '',
            tags: [],
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBodySchema: null,
            responses: { [String(status)]: { description: '', schema: null } },
            security: [],
        });
    }
    return {
        info: { title: 'Manual Endpoints', version: '', openApiVersion: 'manual', serverUrl, endpointCount: endpoints.length },
        endpoints,
    };
}

// Run `worker` over items with a bounded concurrency so we parallelize LLM
// calls without overwhelming a local model. A pool of ~5 balances speed
// against rate limits (generateWithRetry handles 429s per call).
async function runPool(items, limit, worker) {
    let i = 0;
    const runNext = async () => {
        while (i < items.length) {
            const idx = i++;
            await worker(items[idx], idx);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

// Capture map <-> "ctxVar=responseField, …" text, for inline editing.
function captureToText(cap) {
    return Object.entries(cap || {}).map(([k, v]) => `${k}=${v}`).join(', ');
}
function textToCapture(text) {
    const out = {};
    for (const pair of String(text).split(',')) {
        const [k, v] = pair.split('=');
        if (k && k.trim() && v && v.trim()) out[k.trim()] = v.trim();
    }
    return out;
}
function compactJson(v) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

const ApiTestGenerator = () => {
    // State lives in an app-level context (above the router) so navigating to
    // another AAQUA page doesn't unmount it and cancel an in-flight operation.
    const {
        mode, setMode, url, setUrl, text, setText, file, setFile, envFile, setEnvFile,
        baseUrl, setBaseUrl, manualRows, setManualRows,
        isParsing, setIsParsing, error, setError, catalog, setCatalog,
        categories, setCategories, selected, setSelected, isGenerating, setIsGenerating,
        genError, setGenError, genByEndpoint, setGenByEndpoint, genProgress, setGenProgress,
        genSeconds, setGenSeconds,
        framework, setFramework, isDownloading, setIsDownloading, dlError, setDlError,
        genMode, setGenMode, flows, setFlows, isFlowGen, setIsFlowGen,
        flowError, setFlowError, isFlowDl, setIsFlowDl, flowDlError, setFlowDlError,
    } = useApiTestGen();
    const { selectedProjectId } = useProject();

    const canParse =
        (mode === 'url' && url.trim()) ||
        (mode === 'text' && text.trim()) ||
        (mode === 'file' && file) ||
        (mode === 'manual' && manualRows.some(r => r.method && r.uri.trim()));

    const handleParse = async () => {
        setIsParsing(true);
        setError(null);
        setCatalog(null);
        setGenByEndpoint({});
        setGenError(null);
        try {
            let result;
            if (mode === 'manual') {
                result = buildManualCatalog(baseUrl, manualRows);
                if (result.endpoints.length === 0) throw new Error('Add at least one endpoint (method + URI).');
            } else {
                const input =
                    mode === 'url' ? { mode, url: url.trim() }
                        : mode === 'text' ? { mode, text }
                            : { mode, file, envFile };
                result = await parseSpec(input, selectedProjectId || null);
            }
            setCatalog(result);
            setSelected(new Set(result.endpoints.map(epKey))); // select all by default
        } catch (err) {
            setError(err.message);
        } finally {
            setIsParsing(false);
        }
    };

    // Manual-rows helpers
    const updateRow = (i, patch) => setManualRows(rows => rows.map((r, idx) => idx === i ? { ...r, ...patch } : r));
    const addRow = () => setManualRows(rows => [...rows, { method: 'GET', uri: '', expectedStatus: '200' }]);
    const removeRow = (i) => setManualRows(rows => rows.length > 1 ? rows.filter((_, idx) => idx !== i) : rows);

    const toggleCategory = (cat) => {
        setCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
    };

    const toggleEndpoint = (key) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    };

    const handleGenerate = async () => {
        const chosen = catalog.endpoints.filter(e => selected.has(epKey(e)));
        if (chosen.length === 0) { setGenError('Select at least one endpoint.'); return; }
        if (categories.length === 0) { setGenError('Select at least one category.'); return; }

        setIsGenerating(true);
        setGenError(null);
        setGenByEndpoint({});
        setGenProgress({ done: 0, total: chosen.length });
        setGenSeconds(null);
        const startedAt = performance.now();

        // One request per endpoint, 5 in flight at a time. Cards fill in as
        // each finishes, and a per-endpoint failure (incl. timeout) is isolated
        // to that card instead of stalling the whole batch.
        try {
            await runPool(chosen, 5, async (ep) => {
                const key = epKey(ep);
                try {
                    const { results } = await generateTestCases([ep], categories, selectedProjectId || null);
                    const r = (results && results[0]) || { cases: [], error: 'No result returned' };
                    setGenByEndpoint(prev => ({ ...prev, [key]: { cases: r.cases || [], error: r.error } }));
                } catch (err) {
                    setGenByEndpoint(prev => ({ ...prev, [key]: { cases: [], error: err.message } }));
                } finally {
                    setGenProgress(prev => ({ ...prev, done: prev.done + 1 }));
                }
            });
        } finally {
            setGenSeconds((performance.now() - startedAt) / 1000);
            setIsGenerating(false);
        }
    };

    // Flatten generated cases into one row per test case — handy as a manual
    // test checklist when handed to a tester.
    const buildCaseRows = () => {
        const rows = [];
        for (const e of catalog.endpoints) {
            const gen = genByEndpoint[epKey(e)];
            if (!gen || !gen.cases || gen.cases.length === 0) continue;
            for (const c of gen.cases) {
                rows.push({
                    'Endpoint': epKey(e),
                    'Operation ID': e.operationId,
                    'Test Case': c.name || '',
                    'Category': c.category || '',
                    'Preconditions': c.preconditions || 'None',
                    'Method': c.request?.method || e.method,
                    'Path': c.request?.path || e.path,
                    'Path Params': c.request?.pathParams || {},
                    'Query Params': c.request?.queryParams || {},
                    'Headers': c.request?.headers || {},
                    'Body': c.request?.body ?? '',
                    'Test Steps': Array.isArray(c.steps) ? c.steps : (c.steps || ''),
                    'Expected Status': c.expectedStatus ?? '',
                    'Assertions': Array.isArray(c.assertions) ? c.assertions : [],
                });
            }
        }
        return rows;
    };

    const hasGeneratedCases = Object.values(genByEndpoint).some(g => g && g.cases && g.cases.length > 0);

    const handleDownloadExcel = () => {
        const rows = buildCaseRows();
        if (rows.length === 0) return;
        const safe = (catalog.info.title || 'API').replace(/[^a-z0-9]+/gi, '_');
        exportToExcel(rows, `${safe}_API_Test_Cases`, 'API Test Cases');
    };

    const handleDownloadJson = () => {
        const structured = catalog.endpoints
            .map(e => ({ endpoint: epKey(e), operationId: e.operationId, cases: genByEndpoint[epKey(e)]?.cases || [] }))
            .filter(x => x.cases.length > 0);
        if (structured.length === 0) return;
        const safe = (catalog.info.title || 'API').replace(/[^a-z0-9]+/gi, '_');
        exportToJSON(structured, `${safe}_API_Test_Cases`);
    };

    // Build emitter input groups from catalog endpoints + their generated cases.
    const buildGroups = () => catalog.endpoints
        .map(e => ({
            operationId: e.operationId,
            method: e.method,
            path: e.path,
            tags: e.tags || [],
            secured: e.secured !== undefined ? e.secured : (Array.isArray(e.security) && e.security.length > 0),
            persona: e.persona || null,
            queryData: e.queryData || {},
            cases: genByEndpoint[epKey(e)]?.cases || [],
        }))
        .filter(g => g.cases.length > 0);

    const handleDownloadProject = async () => {
        const groups = buildGroups();
        if (groups.length === 0) return;
        setIsDownloading(true);
        setDlError(null);
        try {
            await downloadAutomationProject(
                framework,
                { title: catalog.info.title, serverUrl: catalog.info.serverUrl, auth: catalog.info.auth, dataVars: catalog.info.dataVars },
                groups,
                selectedProjectId || null,
            );
        } catch (err) {
            setDlError(err.message);
        } finally {
            setIsDownloading(false);
        }
    };

    // ── k6 load test (generate-only) — from the selected catalog endpoints ──
    const handleDownloadLoadTest = async () => {
        const chosen = catalog.endpoints.filter(e => selected.has(epKey(e)));
        if (chosen.length === 0) { setDlError('Select at least one endpoint for the load test.'); return; }
        setIsDownloading(true);
        setDlError(null);
        try {
            await downloadLoadTest(
                { title: catalog.info.title, serverUrl: catalog.info.serverUrl },
                chosen.map(e => ({ method: e.method, path: e.path, secured: e.secured, security: e.security })),
            );
        } catch (err) {
            setDlError(err.message);
        } finally {
            setIsDownloading(false);
        }
    };

    // ── Process flows (Feature B) ──
    const handleGenerateFlows = async () => {
        setIsFlowGen(true);
        setFlowError(null);
        setFlows(null);
        try {
            const { flows: result } = await generateFlows(catalog.endpoints, catalog.info, selectedProjectId || null);
            if (!result || result.length === 0) throw new Error('No flows could be inferred from these endpoints.');
            setFlows(result);
        } catch (err) {
            setFlowError(err.message);
        } finally {
            setIsFlowGen(false);
        }
    };

    const handleDownloadFlowProject = async () => {
        if (!flows || flows.length === 0) return;
        setIsFlowDl(true);
        setFlowDlError(null);
        try {
            await downloadFlowProject(
                { title: catalog.info.title, serverUrl: catalog.info.serverUrl, auth: catalog.info.auth, dataVars: catalog.info.dataVars },
                flows,
                selectedProjectId || null,
            );
        } catch (err) {
            setFlowDlError(err.message);
        } finally {
            setIsFlowDl(false);
        }
    };

    // Flow editing helpers (operate immutably on the flows array).
    const updateStep = (fi, si, patch) => setFlows(fs => fs.map((f, i) => i !== fi ? f
        : { ...f, steps: f.steps.map((s, j) => j === si ? { ...s, ...patch } : s) }));
    const removeStep = (fi, si) => setFlows(fs => fs.map((f, i) => i !== fi ? f
        : { ...f, steps: f.steps.filter((_, j) => j !== si) }).filter(f => f.steps.length > 0));
    const moveStep = (fi, si, dir) => setFlows(fs => fs.map((f, i) => {
        if (i !== fi) return f;
        const j = si + dir;
        if (j < 0 || j >= f.steps.length) return f;
        const steps = [...f.steps];
        [steps[si], steps[j]] = [steps[j], steps[si]];
        return { ...f, steps };
    }));
    const removeFlow = (fi) => setFlows(fs => fs.filter((_, i) => i !== fi));
    const updateCapture = (fi, si, captureObj) => updateStep(fi, si, { capture: captureObj });

    // Re-generate a single endpoint (e.g. after a timeout) without touching the rest.
    const retryEndpoint = async (ep) => {
        if (categories.length === 0) { setGenError('Select at least one category.'); return; }
        const key = epKey(ep);
        setGenByEndpoint(prev => ({ ...prev, [key]: { ...(prev[key] || { cases: [] }), retrying: true } }));
        try {
            const { results } = await generateTestCases([ep], categories);
            const r = (results && results[0]) || { cases: [], error: 'No result returned' };
            setGenByEndpoint(prev => ({ ...prev, [key]: { cases: r.cases || [], error: r.error } }));
        } catch (err) {
            setGenByEndpoint(prev => ({ ...prev, [key]: { cases: [], error: err.message } }));
        }
    };

    return (
        <div className="api-testgen animate-fade-in">
            <div className="atg-header">
                <h2><Webhook className="inline-icon" /> API Test Generator</h2>
                <p className="atg-subtitle">Import an OpenAPI/Swagger spec, then generate test cases per endpoint. (Code emitters coming next.)</p>
            </div>

            <div className="atg-container">
                <div className="control-panel">
                    <div className="mode-tabs">
                        <button className={`mode-tab ${mode === 'url' ? 'active' : ''}`} onClick={() => setMode('url')}>
                            <Link2 size={15} /> URL
                        </button>
                        <button className={`mode-tab ${mode === 'text' ? 'active' : ''}`} onClick={() => setMode('text')}>
                            <FileCode size={15} /> Paste
                        </button>
                        <button className={`mode-tab ${mode === 'file' ? 'active' : ''}`} onClick={() => setMode('file')}>
                            <Upload size={15} /> File
                        </button>
                        <button className={`mode-tab ${mode === 'manual' ? 'active' : ''}`} onClick={() => setMode('manual')}>
                            <ListPlus size={15} /> Endpoints
                        </button>
                    </div>

                    {mode === 'url' && (
                        <div className="form-group">
                            <label>Spec URL</label>
                            <input type="text" className="form-input" value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://petstore3.swagger.io/api/v3/openapi.json" />
                        </div>
                    )}
                    {mode === 'text' && (
                        <div className="form-group">
                            <label>Paste spec (JSON or YAML)</label>
                            <textarea className="form-input atg-textarea" rows={8} value={text}
                                onChange={(e) => setText(e.target.value)}
                                placeholder={'{\n  "openapi": "3.0.0",\n  ...\n}'} />
                        </div>
                    )}
                    {mode === 'file' && (
                        <div className="form-group">
                            <label>Upload spec or Postman collection (.json / .yaml)</label>
                            <input type="file" accept=".json,.yaml,.yml" className="form-input"
                                onChange={(e) => setFile(e.target.files?.[0] || null)} />
                            {file && <p className="atg-filename">Selected: {file.name}</p>}
                            <p className="atg-hint">OpenAPI/Swagger spec, or a Postman <em>collection</em> export.</p>

                            <label style={{ marginTop: '0.75rem' }}>Postman environment <span className="atg-optional">(optional)</span></label>
                            <input type="file" accept=".json" className="form-input"
                                onChange={(e) => setEnvFile(e.target.files?.[0] || null)} />
                            {envFile && <p className="atg-filename">Selected: {envFile.name}</p>}
                            <p className="atg-hint">Resolves <code>{'{{variables}}'}</code> (base URLs, tokens) in a Postman collection.</p>
                        </div>
                    )}
                    {mode === 'manual' && (
                        <div className="form-group">
                            <label>Base URL (optional — used for relative paths)</label>
                            <input type="text" className="form-input" value={baseUrl}
                                onChange={(e) => setBaseUrl(e.target.value)}
                                placeholder="https://dog.ceo" />
                            <label style={{ marginTop: '0.75rem' }}>Endpoints</label>
                            <div className="ep-rows">
                                {manualRows.map((r, i) => (
                                    <div key={i} className="ep-row">
                                        <select className="ep-method" value={r.method}
                                            onChange={(e) => updateRow(i, { method: e.target.value })}>
                                            {HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                                        </select>
                                        <input className="ep-uri" value={r.uri}
                                            onChange={(e) => updateRow(i, { uri: e.target.value })}
                                            placeholder="/api/breeds/image/random  or  https://dog.ceo/api/breeds/image/random" />
                                        <input className="ep-status" value={r.expectedStatus}
                                            onChange={(e) => updateRow(i, { expectedStatus: e.target.value })}
                                            placeholder="200" title="Expected status" />
                                        <button className="ep-del" onClick={() => removeRow(i)} title="Remove" disabled={manualRows.length === 1}>
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                            <button className="ep-add" onClick={addRow} type="button">
                                <Plus size={14} /> Add endpoint
                            </button>
                        </div>
                    )}

                    <button onClick={handleParse} disabled={!canParse || isParsing}
                        className="btn full-width"
                        style={{ background: '#2563eb', color: '#fff', border: 'none', marginTop: '1rem' }}>
                        {isParsing ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
                        {isParsing ? 'Working…' : (mode === 'manual' ? 'Use Endpoints' : 'Parse Spec')}
                    </button>

                    {error && <div className="error-banner"><AlertTriangle size={18} /> {error}</div>}

                    {catalog && (
                        <div className="gen-controls">
                            <label className="gen-label">Generation mode</label>
                            <div className="genmode-tabs">
                                <button className={`genmode-tab ${genMode === 'endpoints' ? 'active' : ''}`} onClick={() => setGenMode('endpoints')}>
                                    <Sparkles size={14} /> Per-endpoint
                                </button>
                                <button className={`genmode-tab ${genMode === 'flows' ? 'active' : ''}`} onClick={() => setGenMode('flows')}>
                                    <Workflow size={14} /> Process flows
                                </button>
                            </div>
                            <p className="gen-hint">
                                {genMode === 'flows'
                                    ? 'Ordered end-to-end flows that chain ids across steps — for process/BPMN APIs.'
                                    : 'One isolated test set per endpoint — for normal REST APIs.'}
                            </p>
                        </div>
                    )}

                    {catalog && genMode === 'flows' && (
                        <div className="gen-controls">
                            <button onClick={handleGenerateFlows} disabled={isFlowGen}
                                className="btn full-width"
                                style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none' }}>
                                {isFlowGen ? <Loader2 className="spin" size={18} /> : <Workflow size={18} />}
                                {isFlowGen ? 'Inferring flows…' : 'Generate Flows'}
                            </button>
                            {flowError && <div className="error-banner"><AlertTriangle size={18} /> {flowError}</div>}
                        </div>
                    )}

                    {catalog && genMode === 'endpoints' && (
                        <div className="gen-controls">
                            <label className="gen-label">Test categories</label>
                            <div className="cat-row">
                                {ALL_CATEGORIES.map(cat => (
                                    <label key={cat} className="cat-chip" style={{
                                        borderColor: categories.includes(cat) ? CATEGORY_COLORS[cat] : 'var(--border-color)',
                                        color: categories.includes(cat) ? CATEGORY_COLORS[cat] : 'var(--text-muted)',
                                    }}>
                                        <input type="checkbox" checked={categories.includes(cat)} onChange={() => toggleCategory(cat)} />
                                        {cat}
                                    </label>
                                ))}
                            </div>
                            <p className="gen-hint">{selected.size} of {catalog.endpoints.length} endpoints selected</p>
                            <button onClick={handleGenerate} disabled={isGenerating || selected.size === 0 || categories.length === 0}
                                className="btn full-width"
                                style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none' }}>
                                {isGenerating ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
                                {isGenerating ? `Generating… ${genProgress.done}/${genProgress.total}` : 'Generate Test Cases'}
                            </button>
                            <button onClick={handleDownloadLoadTest} disabled={isDownloading || selected.size === 0}
                                className="btn full-width"
                                title="Generate a runnable k6 load-test script for the selected endpoints"
                                style={{ background: 'transparent', color: 'var(--accent-secondary)', border: '1px solid var(--accent-secondary)', marginTop: '0.5rem' }}>
                                {isDownloading ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                                Download k6 Load Test
                            </button>
                            {dlError && <div className="error-banner" style={{ marginTop: '0.5rem' }}><AlertTriangle size={18} /> {dlError}</div>}
                            {isGenerating && genProgress.total > 0 && (
                                <div className="gen-progress-track">
                                    <div className="gen-progress-fill" style={{ width: `${Math.round((genProgress.done / genProgress.total) * 100)}%` }} />
                                </div>
                            )}
                            {!isGenerating && genSeconds != null && genProgress.total > 0 && (
                                <p className="gen-timing-line">
                                    <Clock size={13} /> Generated {genProgress.total} endpoint{genProgress.total === 1 ? '' : 's'} in {fmtDuration(genSeconds)}
                                </p>
                            )}
                            {genError && <div className="error-banner"><AlertTriangle size={18} /> {genError}</div>}
                        </div>
                    )}
                </div>

                <div className="results-panel">
                    {!catalog && !isParsing && (
                        <div className="empty-state">
                            <Webhook size={48} className="text-muted" />
                            <p>Import a spec to list its endpoints.</p>
                        </div>
                    )}

                    {catalog && (
                        <>
                            <div className="info-card">
                                <h3>{catalog.info.title} <span className="version-tag">{catalog.info.version || '—'}</span></h3>
                                <div className="info-meta">
                                    <span>Spec: <strong>{catalog.info.openApiVersion}</strong></span>
                                    <span>Server: <strong>{catalog.info.serverUrl || '—'}</strong></span>
                                    <span>Endpoints: <strong>{catalog.info.endpointCount}</strong></span>
                                </div>
                            </div>

                            {genMode === 'flows' && (
                                <div className="flows-wrap">
                                    {!flows && !isFlowGen && (
                                        <div className="flows-hint">Click <strong>Generate Flows</strong> to infer ordered process flows from these endpoints, then review and download.</div>
                                    )}
                                    {flows && (
                                        <>
                                            <div className="results-toolbar">
                                                <span className="toolbar-label">Flow project (Playwright):</span>
                                                <button className="dl-btn dl-btn--primary" onClick={handleDownloadFlowProject} disabled={isFlowDl}>
                                                    {isFlowDl ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                                                    {isFlowDl ? 'Building…' : 'Download Flow Project'}
                                                </button>
                                            </div>
                                            {flowDlError && <div className="error-banner"><AlertTriangle size={18} /> {flowDlError}</div>}
                                            {flows.map((flow, fi) => (
                                                <div key={fi} className="flow-card">
                                                    <div className="flow-head">
                                                        <Workflow size={15} />
                                                        <input className="flow-name" value={flow.name}
                                                            onChange={(e) => setFlows(fs => fs.map((f, i) => i === fi ? { ...f, name: e.target.value } : f))} />
                                                        <button className="ep-del" title="Remove flow" onClick={() => removeFlow(fi)}><Trash2 size={14} /></button>
                                                    </div>
                                                    {flow.description && <p className="flow-desc">{flow.description}</p>}
                                                    <ol className="flow-steps">
                                                        {flow.steps.map((s, si) => (
                                                            <li key={si} className="flow-step">
                                                                <div className="flow-step-head">
                                                                    <span className="step-order">{si + 1}</span>
                                                                    <span className="method-badge" style={{ background: METHOD_COLORS[s.method] || '#6b7280' }}>{s.method}</span>
                                                                    <code className="endpoint-path">{s.path}</code>
                                                                    <div className="flow-step-actions">
                                                                        <button className="icon-btn" title="Move up" disabled={si === 0} onClick={() => moveStep(fi, si, -1)}><ArrowUp size={13} /></button>
                                                                        <button className="icon-btn" title="Move down" disabled={si === flow.steps.length - 1} onClick={() => moveStep(fi, si, 1)}><ArrowDown size={13} /></button>
                                                                        <button className="icon-btn" title="Remove step" onClick={() => removeStep(fi, si)}><Trash2 size={13} /></button>
                                                                    </div>
                                                                </div>
                                                                <input className="flow-stepname" value={s.stepName}
                                                                    onChange={(e) => updateStep(fi, si, { stepName: e.target.value })} />
                                                                <div className="flow-step-fields">
                                                                    <label>persona
                                                                        <input value={s.persona || ''} onChange={(e) => updateStep(fi, si, { persona: e.target.value || null })} placeholder="(none)" />
                                                                    </label>
                                                                    <label>expects
                                                                        <input value={s.expectedStatus} onChange={(e) => updateStep(fi, si, { expectedStatus: parseInt(e.target.value, 10) || 0 })} />
                                                                    </label>
                                                                    <label className="cap-field">captures
                                                                        <input value={captureToText(s.capture)} onChange={(e) => updateCapture(fi, si, textToCapture(e.target.value))} placeholder="claimId=claimId" title="ctxVar=responseField, comma-separated" />
                                                                    </label>
                                                                </div>
                                                                {(Object.keys(s.query || {}).length > 0 || (s.body != null && s.body !== '')) && (
                                                                    <div className="flow-step-io">
                                                                        {Object.keys(s.query || {}).length > 0 && <span>query: <code>{JSON.stringify(s.query)}</code></span>}
                                                                        {s.body != null && s.body !== '' && <span>body: <code>{compactJson(s.body)}</code></span>}
                                                                    </div>
                                                                )}
                                                            </li>
                                                        ))}
                                                    </ol>
                                                </div>
                                            ))}
                                        </>
                                    )}
                                </div>
                            )}

                            {genMode === 'endpoints' && hasGeneratedCases && (
                                <>
                                    <div className="results-toolbar">
                                        <span className="toolbar-label">Manual test cases:</span>
                                        <button className="dl-btn" onClick={handleDownloadExcel}>
                                            <Download size={14} /> Excel
                                        </button>
                                        <button className="dl-btn" onClick={handleDownloadJson}>
                                            <Download size={14} /> JSON
                                        </button>
                                    </div>
                                    <div className="results-toolbar">
                                        <span className="toolbar-label">Automation project:</span>
                                        <select className="fw-select" value={framework} onChange={(e) => setFramework(e.target.value)} disabled={isDownloading}>
                                            <option value="playwright">Playwright (TS)</option>
                                            <option value="restassured">REST Assured (Java)</option>
                                        </select>
                                        <button className="dl-btn dl-btn--primary" onClick={handleDownloadProject} disabled={isDownloading}>
                                            {isDownloading ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                                            {isDownloading ? 'Building…' : 'Download Project'}
                                        </button>
                                    </div>
                                    {dlError && <div className="error-banner"><AlertTriangle size={18} /> {dlError}</div>}
                                </>
                            )}

                            {genMode === 'endpoints' && <div className="endpoint-list">
                                {catalog.endpoints.map((e, i) => {
                                    const key = epKey(e);
                                    const paramCount = e.pathParams.length + e.queryParams.length + e.headerParams.length;
                                    const secured = Array.isArray(e.security) && e.security.length > 0;
                                    const gen = genByEndpoint[key];
                                    return (
                                        <div key={`${key}-${i}`} className="endpoint-card">
                                            <div className="endpoint-head">
                                                <input type="checkbox" checked={selected.has(key)} onChange={() => toggleEndpoint(key)} title="Include in generation" />
                                                <span className="method-badge" style={{ background: METHOD_COLORS[e.method] || '#6b7280' }}>{e.method}</span>
                                                <code className="endpoint-path">{e.path}</code>
                                                {secured && <Lock size={13} title="Requires auth" style={{ color: 'var(--text-muted)' }} />}
                                            </div>
                                            {e.summary && <p className="endpoint-summary">{e.summary}</p>}
                                            <div className="endpoint-meta">
                                                <span>{paramCount} param{paramCount === 1 ? '' : 's'}</span>
                                                <span>{e.requestBodySchema ? 'has body' : 'no body'}</span>
                                                <span>responses: {Object.keys(e.responses).join(', ') || '—'}</span>
                                            </div>

                                            {gen && gen.error && (
                                                <div className="case-error">
                                                    <XCircle size={13} />
                                                    <span className="case-error-msg">{gen.error}</span>
                                                    <button className="retry-btn" onClick={() => retryEndpoint(e)} disabled={gen.retrying}>
                                                        {gen.retrying ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                                                        {gen.retrying ? 'Retrying…' : 'Retry'}
                                                    </button>
                                                </div>
                                            )}
                                            {gen && !gen.error && gen.cases.length > 0 && (
                                                <div className="case-list">
                                                    {gen.cases.map((c, ci) => (
                                                        <div key={ci} className="case-item">
                                                            <div className="case-head">
                                                                <span className="cat-badge" style={{ background: CATEGORY_COLORS[c.category] || '#6b7280' }}>{c.category}</span>
                                                                <span className="case-name">{c.name}</span>
                                                                <span className="case-status">→ {c.expectedStatus}</span>
                                                            </div>
                                                            {c.preconditions && c.preconditions !== 'None' && (
                                                                <div className="case-pre"><strong>Pre:</strong> {c.preconditions}</div>
                                                            )}
                                                            {Array.isArray(c.steps) && c.steps.length > 0 && (
                                                                <ol className="case-steps">
                                                                    {c.steps.map((s, si) => (
                                                                        <li key={si}>{String(s).replace(/^\s*\d+[.)]\s*/, '')}</li>
                                                                    ))}
                                                                </ol>
                                                            )}
                                                            {Array.isArray(c.assertions) && c.assertions.length > 0 && (
                                                                <ul className="case-assertions">
                                                                    {c.assertions.map((a, ai) => (
                                                                        <li key={ai}><CheckCircle size={11} /> {a}</li>
                                                                    ))}
                                                                </ul>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>}
                        </>
                    )}
                </div>
            </div>

            <style>{`
                .api-testgen { max-width: 1100px; margin: 0 auto; }
                .inline-icon { display: inline; vertical-align: middle; margin-right: 0.5rem; }
                .atg-header { margin-bottom: 2rem; }
                .atg-header h2 {
                    font-size: 2rem; margin-bottom: 0.5rem;
                    background: linear-gradient(to right, var(--accent-primary), var(--accent-secondary));
                    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
                    display: flex; align-items: center; gap: 0.5rem;
                }
                .atg-subtitle { color: var(--text-secondary); }

                .atg-container { display: grid; grid-template-columns: 1fr 1.5fr; gap: 2rem; }
                .control-panel, .results-panel {
                    background: var(--bg-secondary); border: 1px solid var(--border-color);
                    border-radius: var(--radius-lg); padding: 1.5rem;
                }

                .mode-tabs { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; }
                .mode-tab {
                    display: inline-flex; align-items: center; gap: 6px;
                    padding: 6px 12px; font-size: 0.85rem; font-weight: 600;
                    border-radius: 6px; cursor: pointer;
                    background: var(--bg-tertiary); border: 1px solid var(--border-color);
                    color: var(--text-secondary);
                }
                .mode-tab.active { background: var(--accent-glow); border-color: var(--accent-primary); color: var(--accent-primary); }

                .form-group label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
                .form-input {
                    width: 100%; padding: 0.7rem; border: 1px solid var(--border-color);
                    border-radius: var(--radius-md); background: var(--bg-primary); color: var(--text-primary);
                }
                .atg-textarea { font-family: monospace; font-size: 0.85rem; resize: vertical; }
                .atg-filename { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem; }
                .atg-hint { font-size: 0.75rem; color: var(--text-muted); margin-top: 0.35rem; }
                .atg-hint code { background: var(--bg-tertiary); padding: 1px 5px; border-radius: 4px; font-size: 0.72rem; }
                .atg-optional { color: var(--text-muted); font-weight: 400; font-size: 0.8rem; }

                .ep-rows { display: flex; flex-direction: column; gap: 0.5rem; }
                .ep-row { display: flex; gap: 0.4rem; align-items: center; }
                .ep-method { flex: 0 0 90px; padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; }
                .ep-uri { flex: 1; min-width: 0; padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); font-family: monospace; font-size: 0.82rem; }
                .ep-status { flex: 0 0 56px; padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); text-align: center; }
                .ep-del { flex: 0 0 auto; display: inline-flex; align-items: center; padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-tertiary); color: var(--text-muted); cursor: pointer; }
                .ep-del:hover:not(:disabled) { color: #ef4444; border-color: rgba(239,68,68,0.4); }
                .ep-del:disabled { opacity: 0.4; cursor: not-allowed; }
                .ep-add { margin-top: 0.6rem; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: 0.8rem; font-weight: 600; border-radius: 6px; cursor: pointer; background: var(--accent-glow); border: 1px solid var(--accent-primary); color: var(--accent-primary); }

                .genmode-tabs { display: flex; gap: 0.4rem; }
                .genmode-tab { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px; font-size: 0.82rem; font-weight: 600; border-radius: 6px; cursor: pointer; background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-muted); }
                .genmode-tab.active { background: var(--accent-glow); border-color: var(--accent-primary); color: var(--accent-primary); }

                .flows-wrap { display: flex; flex-direction: column; gap: 1rem; }
                .flows-hint { padding: 1rem; border: 1px dashed var(--border-color); border-radius: 8px; color: var(--text-muted); font-size: 0.85rem; }
                .flow-card { border: 1px solid var(--border-color); border-radius: 10px; padding: 0.9rem; background: var(--bg-secondary); }
                .flow-head { display: flex; align-items: center; gap: 0.5rem; }
                .flow-name { flex: 1; font-weight: 700; font-size: 0.95rem; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 4px 6px; color: var(--text-primary); }
                .flow-name:hover, .flow-name:focus { border-color: var(--border-color); background: var(--bg-primary); }
                .flow-desc { font-size: 0.8rem; color: var(--text-muted); margin: 0.3rem 0 0.6rem; }
                .flow-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
                .flow-step { border: 1px solid var(--border-color); border-radius: 8px; padding: 0.55rem 0.65rem; background: var(--bg-primary); }
                .flow-step-head { display: flex; align-items: center; gap: 0.45rem; }
                .step-order { flex: 0 0 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--accent-glow); color: var(--accent-primary); font-size: 0.72rem; font-weight: 700; }
                .flow-step-actions { margin-left: auto; display: flex; gap: 2px; }
                .icon-btn { display: inline-flex; padding: 4px; border: 1px solid var(--border-color); border-radius: 5px; background: var(--bg-tertiary); color: var(--text-muted); cursor: pointer; }
                .icon-btn:hover:not(:disabled) { color: var(--accent-primary); }
                .icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }
                .flow-stepname { width: 100%; margin-top: 0.4rem; font-size: 0.82rem; background: transparent; border: 1px solid transparent; border-radius: 5px; padding: 3px 5px; color: var(--text-primary); }
                .flow-stepname:hover, .flow-stepname:focus { border-color: var(--border-color); background: var(--bg-secondary); }
                .flow-step-fields { display: flex; gap: 0.5rem; margin-top: 0.4rem; flex-wrap: wrap; }
                .flow-step-fields label { font-size: 0.7rem; color: var(--text-muted); display: flex; flex-direction: column; gap: 2px; }
                .flow-step-fields input { font-size: 0.78rem; padding: 4px 6px; border: 1px solid var(--border-color); border-radius: 5px; background: var(--bg-secondary); color: var(--text-primary); width: 110px; }
                .flow-step-fields .cap-field { flex: 1; }
                .flow-step-fields .cap-field input { width: 100%; font-family: monospace; }
                .flow-step-io { margin-top: 0.4rem; font-size: 0.72rem; color: var(--text-muted); display: flex; flex-direction: column; gap: 2px; }
                .flow-step-io code { background: var(--bg-tertiary); padding: 1px 5px; border-radius: 4px; }
                .full-width { display: flex; align-items: center; justify-content: center; gap: 0.5rem; }

                .gen-controls { margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border-color); }
                .gen-label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
                .cat-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem; }
                .cat-chip {
                    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
                    padding: 4px 10px; border-radius: 99px; font-size: 0.75rem; font-weight: 700;
                    text-transform: capitalize; border: 1px solid var(--border-color);
                    background: var(--bg-tertiary);
                }
                .gen-hint { font-size: 0.78rem; color: var(--text-muted); margin: 0.25rem 0 0.75rem; }
                .gen-progress-track { margin-top: 0.6rem; height: 6px; background: var(--bg-primary); border-radius: 99px; overflow: hidden; }
                .gen-progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary)); border-radius: 99px; transition: width 0.3s ease; }
                .gen-timing-line { display: inline-flex; align-items: center; gap: 0.35rem; margin: 0.6rem 0 0; font-size: 0.78rem; font-weight: 600; color: var(--accent-secondary); }

                .error-banner {
                    margin-top: 1rem; padding: 0.75rem 1rem; border-radius: var(--radius-md);
                    background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3);
                    color: #ef4444; display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem;
                }

                .empty-state { text-align: center; padding: 3rem; color: var(--text-muted); }

                .info-card {
                    background: var(--bg-tertiary); border: 1px solid var(--border-color);
                    border-radius: var(--radius-md); padding: 1rem 1.25rem; margin-bottom: 1.25rem;
                }
                .info-card h3 { margin: 0 0 0.5rem; display: flex; align-items: center; gap: 8px; }
                .version-tag {
                    font-size: 0.7rem; font-weight: 700; background: var(--accent-glow);
                    color: var(--accent-primary); padding: 2px 8px; border-radius: 99px;
                }
                .info-meta { display: flex; flex-wrap: wrap; gap: 1rem; font-size: 0.8rem; color: var(--text-muted); }

                .results-toolbar {
                    display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;
                    padding: 0.6rem 0.85rem; background: var(--bg-tertiary);
                    border: 1px solid var(--border-color); border-radius: var(--radius-md);
                }
                .toolbar-label { font-size: 0.8rem; color: var(--text-muted); margin-right: auto; }
                .dl-btn {
                    display: inline-flex; align-items: center; gap: 6px;
                    padding: 5px 12px; font-size: 0.78rem; font-weight: 600; cursor: pointer;
                    border-radius: 6px; background: var(--accent-glow);
                    border: 1px solid var(--accent-primary); color: var(--accent-primary);
                }
                .dl-btn:hover:not(:disabled) { background: var(--accent-primary); color: #fff; }
                .dl-btn:disabled { cursor: not-allowed; opacity: 0.7; }
                .dl-btn--primary { background: var(--accent-primary); color: #fff; }
                .fw-select {
                    padding: 5px 10px; font-size: 0.78rem; border-radius: 6px;
                    border: 1px solid var(--border-color); background: var(--bg-primary);
                    color: var(--text-primary); cursor: pointer;
                }

                .endpoint-list { display: flex; flex-direction: column; gap: 0.75rem; max-height: 620px; overflow-y: auto; }
                .endpoint-card {
                    background: var(--bg-tertiary); border: 1px solid var(--border-color);
                    border-radius: var(--radius-md); padding: 0.9rem 1rem;
                }
                .endpoint-head { display: flex; align-items: center; gap: 0.6rem; }
                .method-badge {
                    color: #fff; font-weight: 700; font-size: 0.7rem; letter-spacing: 0.04em;
                    padding: 3px 8px; border-radius: 4px; min-width: 58px; text-align: center;
                }
                .endpoint-path { font-family: monospace; font-size: 0.9rem; color: var(--text-primary); }
                .endpoint-summary { margin: 0.5rem 0 0.4rem; font-size: 0.85rem; color: var(--text-secondary); }
                .endpoint-meta { display: flex; flex-wrap: wrap; gap: 1rem; font-size: 0.75rem; color: var(--text-muted); }

                .case-error {
                    margin-top: 0.6rem; font-size: 0.78rem; color: #ef4444;
                    display: flex; align-items: center; gap: 6px;
                }
                .case-error-msg { flex: 1; }
                .retry-btn {
                    display: inline-flex; align-items: center; gap: 5px;
                    padding: 3px 9px; font-size: 0.72rem; font-weight: 600;
                    border-radius: 6px; cursor: pointer; white-space: nowrap;
                    background: rgba(37, 99, 235, 0.08);
                    border: 1px solid rgba(37, 99, 235, 0.3); color: #2563eb;
                }
                .retry-btn:hover:not(:disabled) { background: rgba(37, 99, 235, 0.15); border-color: #2563eb; }
                .retry-btn:disabled { cursor: not-allowed; opacity: 0.7; }
                .case-list { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
                .case-item { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 0.6rem 0.75rem; }
                .case-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
                .cat-badge { color: #fff; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; }
                .case-name { font-size: 0.83rem; font-weight: 600; color: var(--text-primary); flex: 1; }
                .case-status { font-family: monospace; font-size: 0.78rem; color: var(--text-muted); }
                .case-pre { margin-top: 0.45rem; font-size: 0.77rem; color: var(--text-secondary); }
                .case-pre strong { color: var(--text-muted); text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.3px; margin-right: 4px; }
                .case-steps { margin: 0.45rem 0 0; padding-left: 1.1rem; }
                .case-steps li { font-size: 0.77rem; color: var(--text-secondary); margin-bottom: 2px; line-height: 1.45; }
                .case-assertions { margin: 0.45rem 0 0; padding-left: 0.25rem; list-style: none; }
                .case-assertions li { font-size: 0.77rem; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }

                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { 100% { transform: rotate(360deg); } }

                @media (max-width: 900px) { .atg-container { grid-template-columns: 1fr; } }
            `}</style>
        </div>
    );
};

export default ApiTestGenerator;
