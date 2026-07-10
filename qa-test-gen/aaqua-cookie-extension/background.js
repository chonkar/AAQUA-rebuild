chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getCookies') {
        const targetUrl = message.url;
        try {
            chrome.tabs.query({ url: targetUrl + '*' }, (tabs) => {
                const targetTab = tabs[0];
                if (!targetTab) {
                    // Try domain query fallback
                    try {
                        const parsed = new URL(targetUrl);
                        chrome.tabs.query({ url: `${parsed.protocol}//${parsed.host}/*` }, (domainTabs) => {
                            getCookiesAndStorage(targetUrl, domainTabs[0], sendResponse);
                        });
                    } catch (e) {
                        getCookiesAndStorage(targetUrl, null, sendResponse);
                    }
                } else {
                    getCookiesAndStorage(targetUrl, targetTab, sendResponse);
                }
            });
        } catch (err) {
            sendResponse({ error: err.message });
        }
        return true; // Keep messaging channel open for async response
    }
});

function getCookiesAndStorage(targetUrl, tab, sendResponse) {
    chrome.cookies.getAll({ url: targetUrl }, (cookies) => {
        if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
            return;
        }

        const formatted = cookies.map(c => {
            const cookie = {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                expires: c.expirationDate || -1,
                httpOnly: c.httpOnly,
                secure: c.secure
            };
            if (c.sameSite) {
                cookie.sameSite = c.sameSite.charAt(0).toUpperCase() + c.sameSite.slice(1).toLowerCase();
            }
            return cookie;
        });

        if (tab && tab.id) {
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    return {
                        localStorage: { ...localStorage },
                        sessionStorage: { ...sessionStorage }
                    };
                }
            }, (results) => {
                const storage = results && results[0] ? results[0].result : null;
                sendResponse({ cookies: formatted, storage });
            });
        } else {
            sendResponse({ cookies: formatted, storage: null });
        }
    });
}
