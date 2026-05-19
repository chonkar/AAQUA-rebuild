const API_URL = "http://localhost:3001/api";

export const runTestsLocal = async (projectPath, isHeadless = true) => {
    const response = await fetch(`${API_URL}/run-tests-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, isHeadless }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Failed to start test run');
    }
    return response.json(); // { runId, framework }
};

export const getRunStatus = async (runId) => {
    const response = await fetch(`${API_URL}/run-status/${runId}`);
    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Failed to fetch run status');
    }
    return response.json(); // { status, framework, logs, results, failedCount, error }
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
