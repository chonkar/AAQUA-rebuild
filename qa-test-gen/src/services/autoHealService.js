const API_URL = 'http://localhost:3001/api';

/** Analyse a single failed test and get locator suggestions */
export const analyseHeal = async ({ testName, classname, errorMessage, stackTrace, pageUrl }) => {
    const res = await fetch(`${API_URL}/auto-heal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testName, classname, errorMessage, stackTrace, pageUrl }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Auto-heal analysis failed');
    }
    return res.json(); // { suggestions, failedLocator }
};

/** Queue multiple tests for batch healing — returns batchId */
export const startBatchHeal = async (runId, tests) => {
    const res = await fetch(`${API_URL}/auto-heal-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, tests }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Batch heal failed to start');
    }
    return res.json(); // { batchId }
};

/** Poll batch heal progress */
export const getBatchHealStatus = async (batchId) => {
    const res = await fetch(`${API_URL}/heal-batch-status/${batchId}`);
    if (!res.ok) throw new Error('Failed to fetch batch status');
    return res.json(); // { total, processed, results }
};

/** Apply a chosen locator — patches source file and re-runs the test */
export const applyHeal = async ({ runId, testName, classname, oldLocator, newLocator, newStrategy, projectRoot, framework }) => {
    const res = await fetch(`${API_URL}/apply-heal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, testName, classname, oldLocator, newLocator, newStrategy, projectRoot, framework }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Apply heal failed');
    }
    return res.json(); // { healRunId, sourceFile, backupFile, patchedFrom, patchedTo }
};
