// See testRunnerService.js for why this is relative + BASE_URL-prefixed.
const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

export const launchBrowser = async (url) => {
    const response = await fetch(`${API_URL}/browser/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.details || err.error || `Browser launch failed (HTTP ${response.status})`);
    }
    return response.json();
};

export const capturePage = async () => {
    const response = await fetch(`${API_URL}/browser/capture`);
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.details || err.error || `Page capture failed (HTTP ${response.status})`);
    }
    return response.json();
};

// Start an async localization analysis. Returns { jobId, totalChunks } immediately;
// the actual analysis runs in the background and is polled via getLocalizationStatus.
export const startLocalizationAnalysis = async (html, targetLanguage, apiKey, projectId) => {
    const response = await fetch(`${API_URL}/analyze-localization`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey
        },
        body: JSON.stringify({ html, targetLanguage, projectId }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Analysis failed: ${text}`);
    }
    return response.json(); // { jobId, totalChunks }
};

// Poll a running job. Returns { status: 'running'|'completed'|'failed',
// done, total, issues (cumulative), error }.
export const getLocalizationStatus = async (jobId) => {
    const response = await fetch(`${API_URL}/analyze-localization/status/${jobId}`);
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Status check failed (HTTP ${response.status})`);
    }
    return response.json();
};
