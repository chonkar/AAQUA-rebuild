// Relative path: in dev the Vite proxy maps /api → :3001; in QA the BASE_URL
// prefix turns this into /aaqua/api/... which shared-nginx routes to the backend.
// A hardcoded http://localhost:3001 would 404 in the browser when deployed.
const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

export const runTestsLocal = async (projectPath, isHeadless = true, projectId = null) => {
    const response = await fetch(`${API_URL}/run-tests-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, isHeadless, projectId }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Failed to start test run');
    }
    return response.json(); // { runId, framework }
};

export const runTestsZip = async (zipFile, isHeadless = true, projectId = null) => {
    const formData = new FormData();
    formData.append('projectZip', zipFile);
    formData.append('headed', String(!isHeadless));
    if (projectId) {
        formData.append('projectId', projectId);
    }

    const response = await fetch(`${API_URL}/run-tests`, {
        method: 'POST',
        body: formData,
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Failed to start test run');
    }
    return response.json(); // { runId, framework }
};


export const getRunStatus = async (runId, since = 0) => {
    const q = since ? `?since=${since}` : '';
    const response = await fetch(`${API_URL}/run-status/${runId}${q}`);
    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Failed to fetch run status');
    }
    return response.json(); // { status, framework, logs, cursor, results, failedCount, error }
};

export const retryFailedTests = async (runId) => {
    const response = await fetch(`${API_URL}/retry-tests/${runId}`, {
        method: 'POST',
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Failed to retry tests');
    }
    return response.json(); // { runId, framework }
};

export const getRuntimeInfo = async () => {
    const response = await fetch(`${API_URL}/runtime-info`);
    if (!response.ok) throw new Error('Failed to fetch runtime info');
    return response.json(); // { hasDisplayServer, isContainer, platform }
};
