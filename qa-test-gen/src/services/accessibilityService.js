// See testRunnerService.js for why this is BASE_URL-prefixed rather than a bare /api.
const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

export const launchBrowser = async (url) => {
    const response = await fetch(`${API_URL}/browser/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.details || err.error || `Browser launch failed (HTTP ${response.status})`);
    }
    return response.json();
};

export const runAccessibilityScan = async () => {
    const response = await fetch(`${API_URL}/analyze-accessibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Scan failed');
    }
    return response.json();
};
