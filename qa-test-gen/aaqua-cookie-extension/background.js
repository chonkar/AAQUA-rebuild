chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getCookies') {
        const targetUrl = message.url;
        try {
            chrome.cookies.getAll({ url: targetUrl }, (cookies) => {
                if (chrome.runtime.lastError) {
                    sendResponse({ error: chrome.runtime.lastError.message });
                } else {
                    // Map attributes to Playwright compatibility format
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
                    sendResponse({ cookies: formatted });
                }
            });
        } catch (err) {
            sendResponse({ error: err.message });
        }
        return true; // Keep messaging channel open for async response
    }
});
