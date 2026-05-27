// See testRunnerService.js for why this is BASE_URL-prefixed rather than a bare /api.
const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

/**
 * Build an error message from a failed response. Prefers a JSON {error} body,
 * but falls back to raw text (e.g. an nginx/proxy HTML 500 when the backend is
 * down) so the real cause surfaces instead of a bare status code.
 */
async function readError(response, label) {
    const raw = await response.text().catch(() => '');
    let msg = '';
    try { msg = JSON.parse(raw).error || ''; } catch { /* not JSON */ }
    if (!msg) {
        const snippet = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        msg = snippet
            ? `${label} failed (HTTP ${response.status}): ${snippet}`
            : `${label} failed (HTTP ${response.status}) — backend may be down. Restart it with: npm run server`;
    }
    return msg;
}

/**
 * Parse an OpenAPI/Swagger spec into a normalized endpoint catalog.
 * input is one of:
 *   { mode: 'url',  url:  '<spec url>' }
 *   { mode: 'text', text: '<raw JSON/YAML>' }
 *   { mode: 'file', file: File, envFile?: File }   // envFile: optional Postman environment
 * Returns { info, endpoints }.
 */
export const parseSpec = async (input, projectId = null) => {
    let response;
    if (input.mode === 'file') {
        const fd = new FormData();
        fd.append('specFile', input.file);
        if (input.envFile) fd.append('envFile', input.envFile);
        if (projectId) fd.append('projectId', projectId);
        // No Content-Type header — the browser sets the multipart boundary.
        response = await fetch(`${API_URL}/parse-spec`, { method: 'POST', body: fd });
    } else {
        const body = input.mode === 'url' ? { specUrl: input.url } : { specText: input.text };
        response = await fetch(`${API_URL}/parse-spec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, projectId }),
        });
    }

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Spec parse failed (HTTP ${response.status})`);
    }
    return response.json(); // { info, endpoints }
};

/**
 * Generate abstract test cases for the given catalog endpoints.
 * @param {Array} endpoints - endpoint objects from parseSpec()
 * @param {string[]} categories - e.g. ['positive','negative','schema']
 * Returns { results: [{ endpoint, cases, error? }] }.
 */
export const generateTestCases = async (endpoints, categories, projectId = null) => {
    const response = await fetch(`${API_URL}/generate-api-testcases`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': import.meta.env.VITE_LLM_API_KEY,
        },
        body: JSON.stringify({ endpoints, categories, projectId }),
    });
    if (!response.ok) {
        throw new Error(await readError(response, 'Test-case generation'));
    }
    return response.json(); // { results }
};

/**
 * Emit a runnable test project (ZIP) from already-generated cases.
 * @param {string} framework - 'restassured' | 'playwright'
 * @param {{title:string, serverUrl:string}} info
 * @param {Array} groups - [{ operationId, method, path, tags, secured, cases }]
 * Triggers a browser download; returns nothing.
 */
export const downloadAutomationProject = async (framework, info, groups, projectId = null) => {
    const response = await fetch(`${API_URL}/generate-api-tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ framework, info, groups, projectId }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Project generation failed (HTTP ${response.status})`);
    }

    await triggerDownload(response, `${framework}-api-tests.zip`);
};

/**
 * Infer ordered process flows from the catalog endpoints (Phase B1).
 * Returns { flows: [{ name, description, steps }] }.
 */
export const generateFlows = async (endpoints, info, projectId = null) => {
    const response = await fetch(`${API_URL}/generate-api-flows`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': import.meta.env.VITE_LLM_API_KEY,
        },
        body: JSON.stringify({ endpoints, info, projectId }),
    });
    if (!response.ok) throw new Error(await readError(response, 'Flow generation'));
    return response.json(); // { flows }
};

/**
 * Emit a runnable Playwright flow project (ZIP) from reviewed flows (Phase B3).
 * Triggers a browser download.
 */
export const downloadFlowProject = async (info, flows, projectId = null) => {
    const response = await fetch(`${API_URL}/generate-api-flow-tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ info, flows, projectId }),
    });
    if (!response.ok) throw new Error(await readError(response, 'Flow project generation'));
    await triggerDownload(response, 'playwright-flows.zip');
};

/**
 * Emit a runnable k6 load-test project (ZIP) from the selected catalog endpoints.
 * Generate-only — the team runs it with k6. Triggers a browser download.
 */
export const downloadLoadTest = async (info, endpoints) => {
    const response = await fetch(`${API_URL}/generate-load-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ info, endpoints }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Load-test generation failed (HTTP ${response.status})`);
    }
    await triggerDownload(response, 'k6-load-test.zip');
};

// Stream a ZIP response to a browser download, naming it from Content-Disposition.
async function triggerDownload(response, fallbackName) {
    let filename = fallbackName;
    const disp = response.headers.get('Content-Disposition');
    const m = disp && /filename=([^;]+)/.exec(disp);
    if (m && m[1]) filename = m[1].trim().replace(/["']/g, '');

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { window.URL.revokeObjectURL(url); a.remove(); }, 2000);
}
