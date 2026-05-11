const API_URL = "http://localhost:3001/api";

export const runTestsLocal = async (projectPath, options = {}) => {
    const { headed = false } = options;
    const response = await fetch(`${API_URL}/run-tests-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, headed }),
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
