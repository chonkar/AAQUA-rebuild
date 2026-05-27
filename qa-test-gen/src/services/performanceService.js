// See testRunnerService.js for why this is relative + BASE_URL-prefixed.
const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

// Run a Lighthouse front-end performance scan against a URL.
// Returns { score, metrics: { lcp, cls, tbt, fcp, speedIndex, ttfb }, opportunities[], scannedUrl }.
export const analyzePerformance = async (url, projectId) => {
    const response = await fetch(`${API_URL}/analyze-performance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, projectId }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Performance scan failed (HTTP ${response.status})`);
    }
    return response.json();
};

// AI triage of a scan result — returns { summary }. Separate call so the scan
// stays fast and the (slow) AI insight loads progressively after.
export const getPerformanceInsights = async (payload, apiKey) => {
    const response = await fetch(`${API_URL}/performance-insights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `AI insights failed (HTTP ${response.status})`);
    }
    return response.json();
};
