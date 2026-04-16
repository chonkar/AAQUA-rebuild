const API_URL = "http://localhost:3001/api";

export const launchBrowser = async (url) => {
    const response = await fetch(`${API_URL}/browser/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
    });
    if (!response.ok) throw new Error("Failed to launch browser");
    return response.json();
};

export const capturePage = async () => {
    const response = await fetch(`${API_URL}/browser/capture`);
    if (!response.ok) throw new Error("Failed to capture page");
    return response.json();
};

export const analyzeLocalization = async (html, targetLanguage, apiKey) => {
    const response = await fetch(`${API_URL}/analyze-localization`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey
        },
        body: JSON.stringify({ html, targetLanguage }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Analysis failed: ${text}`);
    }
    return response.json();
};
