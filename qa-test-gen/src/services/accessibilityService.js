export const launchBrowser = async (url) => {
    const response = await fetch('/api/browser/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
    });
    if (!response.ok) throw new Error('Failed to launch browser');
    return response.json();
};

export const runAccessibilityScan = async () => {
    const response = await fetch('/api/analyze-accessibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Scan failed');
    }
    return response.json();
};
