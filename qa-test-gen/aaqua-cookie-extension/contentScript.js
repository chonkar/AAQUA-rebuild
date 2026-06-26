// Notify AAQUA page that extension is loaded
function notifyReady() {
    window.postMessage({ source: 'aaqua-extension', type: 'AAQUA_EXTENSION_READY' }, '*');
}

// Listen to messages from AAQUA React UI page
window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'aaqua-app') return;

    if (event.data.type === 'AAQUA_PING') {
        notifyReady();
    }

    if (event.data.type === 'AAQUA_GET_COOKIES') {
        chrome.runtime.sendMessage({ action: 'getCookies', url: event.data.url }, (response) => {
            window.postMessage({
                source: 'aaqua-extension',
                type: 'AAQUA_SET_COOKIES',
                cookies: response?.cookies || [],
                error: response?.error || null
            }, '*');
        });
    }
});

// Run initial broadcast
notifyReady();
// Run another ready event a bit later to guarantee detection if page loads slower
setTimeout(notifyReady, 500);
setTimeout(notifyReady, 2000);
