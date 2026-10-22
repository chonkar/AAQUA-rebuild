import React, { useState, useEffect, useRef } from 'react';
import { Monitor, Maximize2, Minimize2, ExternalLink, RefreshCw, Info, CheckCircle, Smartphone, Globe, Shield } from 'lucide-react';

/**
 * LiveBrowserViewer - Embedded Live Browser Stream & noVNC Viewer
 * 
 * Supports:
 * 1. Direct Chromium CDP / Screenshot Live Stream (Works everywhere: Local Windows, Mac, Linux, Docker, Cloud)
 * 2. Virtual Desktop noVNC HTML5 stream (when deployed on Docker/Server with Xvfb)
 * 3. Pop-out, expand/collapse, fit-to-window, and full session recording visibility
 */
const LiveBrowserViewer = ({ 
    height = '520px', 
    title = 'Live Browser Display', 
    subtitle = 'Virtual Desktop & CDP Live Stream', 
    isExecuting = false,
    liveScreenshot = null,
    runId = null,
    pollEndpoint = null,
    agentStatus: _agentStatus = 'idle',
    className = '',
    // Headed mode and execution context props
    isHeaded = false,
    hasDisplayServer = true,
    hasVnc: propHasVnc = null,
    onToggleHeaded = null,
    framework = null,
    logs: _logs = '',
    status: _status = 'idle',
    results: _results = null
}) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isFitMode, setIsFitMode] = useState(true);
    const [iframeKey, setIframeKey] = useState(0);
    const [vncUrl, setVncUrl] = useState('');
    const [, setRuntimeInfo] = useState(null);
    const [isCheckingVnc, setIsCheckingVnc] = useState(true);
    const [vncAvailable, setVncAvailable] = useState(false);
    const [imageBlobUrl, setImageBlobUrl] = useState(null);
    const [directScreenshot, setDirectScreenshot] = useState(null);
    const [clickRipple, setClickRipple] = useState(null);
    const [quickText, setQuickText] = useState('');
    const [isInteracting, setIsInteracting] = useState(false);
    const [isAutoFilling, setIsAutoFilling] = useState(false);
    const [browserTabs, setBrowserTabs] = useState([]);
    const [activeTabIndex, setActiveTabIndex] = useState(0);
    const [activeField, setActiveField] = useState(null);
    const [inlineValue, setInlineValue] = useState('');
    const iframeRef = useRef(null);
    const viewportContainerRef = useRef(null);
    const inlineInputRef = useRef(null);

    // Interactive Viewport Click Handler with exact letterbox/aspect-ratio math
    const handleViewportClick = async (e) => {
        if (!runId && !pollEndpoint) return;
        const img = e.currentTarget;
        const rect = img.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        // Focus viewport container so subsequent physical keyboard typing works immediately
        if (viewportContainerRef.current) {
            viewportContainerRef.current.focus();
        }

        const naturalWidth = img.naturalWidth || 1280;
        const naturalHeight = img.naturalHeight || 800;

        let clickX, clickY;
        if (isFitMode) {
            const imageRatio = naturalWidth / naturalHeight;
            const containerRatio = rect.width / rect.height;

            let renderedWidth = rect.width;
            let renderedHeight = rect.height;
            let offsetX = 0;
            let offsetY = 0;

            if (containerRatio > imageRatio) {
                renderedWidth = rect.height * imageRatio;
                offsetX = (rect.width - renderedWidth) / 2;
            } else {
                renderedHeight = rect.width / imageRatio;
                offsetY = (rect.height - renderedHeight) / 2;
            }

            const clickXRel = e.clientX - rect.left - offsetX;
            const clickYRel = e.clientY - rect.top - offsetY;

            if (clickXRel < 0 || clickXRel > renderedWidth || clickYRel < 0 || clickYRel > renderedHeight) {
                return;
            }

            clickX = Math.round((clickXRel / renderedWidth) * naturalWidth);
            clickY = Math.round((clickYRel / renderedHeight) * naturalHeight);
        } else {
            clickX = Math.round(((e.clientX - rect.left) / rect.width) * naturalWidth);
            clickY = Math.round(((e.clientY - rect.top) / rect.height) * naturalHeight);
        }

        setClickRipple({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            id: Date.now()
        });
        setTimeout(() => setClickRipple(null), 600);

        setIsInteracting(true);
        const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
        const isBrowserApi = pollEndpoint && pollEndpoint.includes('/browser/');
        try {
            const clickUrl = isBrowserApi
                ? `${basePath}/api/browser/click-coordinate`
                : `${basePath}/api/recorder/click-coordinate`;
            const payload = isBrowserApi
                ? { x: clickX, y: clickY }
                : { sessionId: runId, x: clickX, y: clickY };

            const res = await fetch(clickUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                const data = await res.json();
                if (data.liveScreenshot) setDirectScreenshot(data.liveScreenshot);
                if (data.elementInfo && data.elementInfo.isInput) {
                    setActiveField(data.elementInfo);
                    setInlineValue(data.elementInfo.value || '');
                    setTimeout(() => inlineInputRef.current?.focus(), 80);
                } else {
                    setActiveField(null);
                }
                if (data.tabs && data.tabs.length > 0) {
                    setBrowserTabs(data.tabs);
                }
                if (data.activeTab !== undefined) {
                    setActiveTabIndex(data.activeTab);
                }
            }
        } catch {}
        setIsInteracting(false);
    };

    // Physical Keyboard Direct Typing Handler
    const handleViewerKeyDown = async (e) => {
        // Don't intercept if user is typing in our form input
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            return;
        }

        if (!runId && !pollEndpoint) return;

        if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace'].includes(e.key)) {
            e.preventDefault();
        }

        const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
        const isBrowserApi = pollEndpoint && pollEndpoint.includes('/browser/');
        if (['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            await handleSendKey(e.key);
        } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            try {
                const typeUrl = isBrowserApi
                    ? `${basePath}/api/browser/type-text`
                    : `${basePath}/api/recorder/type-text`;
                const payload = isBrowserApi
                    ? { text: e.key }
                    : { sessionId: runId, text: e.key };
                const res = await fetch(typeUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.liveScreenshot) setDirectScreenshot(data.liveScreenshot);
                }
            } catch {}
        }
    };

    // Direct Field Fill Handler (from Quick-Fill HUD)
    const handleDirectFill = async (val) => {
        if ((!runId && !pollEndpoint) || val === undefined) return;
        setIsInteracting(true);
        const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
        const isBrowserApi = pollEndpoint && pollEndpoint.includes('/browser/');
        try {
            const fillUrl = isBrowserApi
                ? `${basePath}/api/browser/fill-field`
                : `${basePath}/api/recorder/fill-field`;
            const payload = isBrowserApi
                ? { selector: activeField?.selector || '', value: val }
                : { sessionId: runId, selector: activeField?.selector || '', value: val };

            const res = await fetch(fillUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                const data = await res.json();
                if (data.liveScreenshot) setDirectScreenshot(data.liveScreenshot);
                if (activeField) {
                    setActiveField(prev => prev ? { ...prev, value: val } : null);
                }
            }
        } catch {}
        setIsInteracting(false);
    };

    // Auto-fill entire form with clean QA test data
    const handleAutoFillForm = async () => {
        if (!runId) return;
        setIsAutoFilling(true);
        setIsInteracting(true);
        const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
        try {
            const res = await fetch(`${basePath}/api/recorder/auto-fill-form`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: runId })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.liveScreenshot) setDirectScreenshot(data.liveScreenshot);
                setActiveField(null);
            }
        } catch {}
        setIsAutoFilling(false);
        setIsInteracting(false);
    };

    // Switch Tab Handler
    const handleSwitchTab = async (tabIdx) => {
        if (!runId) return;
        setIsInteracting(true);
        const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
        try {
            const res = await fetch(`${basePath}/api/recorder/switch-tab`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: runId, tabIndex: tabIdx })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.liveScreenshot) setDirectScreenshot(data.liveScreenshot);
                if (data.tabs) setBrowserTabs(data.tabs);
                if (data.activeTab !== undefined) setActiveTabIndex(data.activeTab);
            }
        } catch {}
        setIsInteracting(false);
    };

    // Close Tab Handler
    const handleCloseTab = async (tabIdx) => {
        if (!runId) return;
        setIsInteracting(true);
        const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
        try {
            const res = await fetch(`${basePath}/api/recorder/close-tab`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: runId, tabIndex: tabIdx })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.liveScreenshot) setDirectScreenshot(data.liveScreenshot);
                if (data.tabs) setBrowserTabs(data.tabs);
                if (data.activeTab !== undefined) setActiveTabIndex(data.activeTab);
            }
        } catch {}
        setIsInteracting(false);
    };

    // Quick text entry handler for in-viewer typing
    const handleSendText = async (e) => {
        if (e) e.preventDefault();
        if (!quickText || (!runId && !pollEndpoint)) return;
        setIsInteracting(true);
        const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
        const isBrowserApi = pollEndpoint && pollEndpoint.includes('/browser/');
        try {
            const typeUrl = isBrowserApi
                ? `${basePath}/api/browser/type-text`
                : `${basePath}/api/recorder/type-text`;
            const payload = isBrowserApi
                ? { text: quickText }
                : { sessionId: runId, text: quickText };

            const res = await fetch(typeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                const data = await res.json();
                if (data.liveScreenshot) setDirectScreenshot(data.liveScreenshot);
            }
            setQuickText('');
        } catch {}
        setIsInteracting(false);
    };

    // Keypress handler for in-viewer keyboard
    const handleSendKey = async (key) => {
        if (!runId && !pollEndpoint) return;
        setIsInteracting(true);
        const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
        const isBrowserApi = pollEndpoint && pollEndpoint.includes('/browser/');
        try {
            const keyUrl = isBrowserApi
                ? `${basePath}/api/browser/type-text`
                : `${basePath}/api/recorder/press-key`;
            const payload = isBrowserApi
                ? { key }
                : { sessionId: runId, key };

            const res = await fetch(keyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                const data = await res.json();
                if (data.liveScreenshot) setDirectScreenshot(data.liveScreenshot);
            }
        } catch {}
        setIsInteracting(false);
    };

    // 1. Fetch runtime-info to detect whether noVNC is available
    useEffect(() => {
        const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
        const apiPrefix = `${basePath}/api`;

        fetch(`${apiPrefix}/runtime-info`)
            .then(res => res.json())
            .then(info => {
                setRuntimeInfo(info);
                
                const host = window.location.hostname;
                const protocol = window.location.protocol;
                
                let targetUrl = '';
                if (basePath.includes('aaqua')) {
                    targetUrl = `${protocol}//${window.location.host}${basePath}/vnc/vnc.html?autoconnect=true&resize=scale&reconnect=true`;
                } else if (info.vncUrl) {
                    targetUrl = info.vncUrl;
                } else {
                    targetUrl = `${protocol}//${host}:6080/vnc.html?autoconnect=true&resize=scale&reconnect=true`;
                }
                setVncUrl(targetUrl);
                setVncAvailable(propHasVnc !== null ? !!propHasVnc : !!info.hasVnc);
                setIsCheckingVnc(false);
            })
            .catch(() => {
                setIsCheckingVnc(false);
                setVncAvailable(propHasVnc !== null ? !!propHasVnc : false);
            });
    }, [iframeKey, propHasVnc]);

    // 2. High-frequency local frame polling and tab synchronization
    useEffect(() => {
        if (!isExecuting || (!runId && !pollEndpoint)) {
            return;
        }

        const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
        const targetEndpoint = pollEndpoint || (
            String(runId).includes('rec_') 
                ? `${basePath}/api/recorder/live-screen/${runId}` 
                : `${basePath}/api/mcp/agent/live-screen/${runId}`
        );

        let isMounted = true;
        const fetchFrame = () => {
            fetch(`${targetEndpoint}?t=${Date.now()}`)
                .then(res => {
                    if (res.ok) return res.blob();
                    return null;
                })
                .then(blob => {
                    if (blob && isMounted) {
                        const url = URL.createObjectURL(blob);
                        setImageBlobUrl(prev => {
                            if (prev) URL.revokeObjectURL(prev);
                            return url;
                        });
                        setDirectScreenshot(null);
                    }
                })
                .catch(() => {});
        };

        // Fetch first frame immediately for instant feedback
        fetchFrame();
        const interval = setInterval(fetchFrame, 400);

        // Synchronize open tabs periodically
        let tabInterval = null;
        if (runId) {
            tabInterval = setInterval(() => {
                if (!isMounted) return;
                fetch(`${basePath}/api/recorder/tabs/${runId}`)
                    .then(r => r.ok ? r.json() : null)
                    .then(data => {
                        if (data && data.tabs && data.tabs.length > 0 && isMounted) {
                            setBrowserTabs(data.tabs);
                            if (data.activeTab !== undefined) setActiveTabIndex(data.activeTab);
                        }
                    })
                    .catch(() => {});
            }, 1000);
        }

        return () => {
            isMounted = false;
            clearInterval(interval);
            if (tabInterval) clearInterval(tabInterval);
        };
    }, [isExecuting, runId, pollEndpoint]);

    // Cleanup blob url on unmount
    useEffect(() => {
        return () => {
            if (imageBlobUrl) {
                URL.revokeObjectURL(imageBlobUrl);
            }
        };
    }, [imageBlobUrl]);

    // Active screenshot source: prefer instant directScreenshot, then local polled blob, then prop liveScreenshot
    const activeScreenshot = directScreenshot || imageBlobUrl || (liveScreenshot ? (liveScreenshot.startsWith('data:') ? liveScreenshot : `data:image/jpeg;base64,${liveScreenshot}`) : null);

    const handleRefresh = () => {
        setIsCheckingVnc(true);
        setIframeKey(prev => prev + 1);
    };

    const handlePopOut = () => {
        if (activeScreenshot) {
            const w = window.open('', '_blank', 'width=1280,height=760,menubar=no,toolbar=no');
            if (w) {
                const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
                const targetEndpoint = pollEndpoint || (runId ? `${basePath}/api/mcp/agent/live-screen/${runId}` : '');
                w.document.write(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>${title} - Live Stream</title>
                        <style>
                            body { margin: 0; background: #0b0f19; display: flex; align-items: center; justify-content: center; height: 100vh; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
                            .container { position: relative; max-width: 95vw; max-height: 95vh; display: flex; justify-content: center; align-items: center; }
                            img { max-width: 100%; max-height: 92vh; object-fit: contain; border-radius: 6px; box-shadow: 0 10px 40px rgba(0,0,0,0.8); }
                            .badge { position: absolute; top: 12px; left: 12px; background: rgba(0,0,0,0.75); color: #22c55e; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; border: 1px solid rgba(255,255,255,0.1); }
                            .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 8px #22c55e; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="badge"><div class="dot"></div> LIVE STREAM</div>
                            <img id="live-screen" src="${activeScreenshot}" />
                        </div>
                        ${targetEndpoint ? `
                        <script>
                            setInterval(() => {
                                fetch('${targetEndpoint}?t=' + Date.now())
                                    .then(r => { if(r.ok) return r.blob(); return null; })
                                    .then(b => {
                                        if (b) document.getElementById('live-screen').src = URL.createObjectURL(b);
                                    }).catch(()=>{});
                            }, 500);
                        </script>
                        ` : ''}
                    </body>
                    </html>
                `);
            }
        } else if (vncUrl && vncAvailable) {
            window.open(vncUrl, '_blank', 'width=1280,height=720,menubar=no,toolbar=no');
        }
    };

    return (
        <div 
            className={`live-browser-viewer ${isExpanded ? 'expanded' : ''} ${className}`}
            style={{
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--bg-secondary, #1e1e2d)',
                border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
                borderRadius: 'var(--radius-md, 8px)',
                overflow: 'hidden',
                marginTop: '1rem',
                marginBottom: '1rem',
                boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
                transition: 'all 0.2s ease'
            }}
        >
            {/* Header bar */}
            <div 
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.65rem 1rem',
                    background: 'var(--bg-tertiary, #252538)',
                    borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))',
                    fontSize: '0.85rem'
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <div 
                        style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'center',
                            width: '26px', 
                            height: '26px', 
                            borderRadius: '6px',
                            background: isExecuting ? 'rgba(34, 197, 94, 0.15)' : 'rgba(99, 102, 241, 0.15)',
                            color: isExecuting ? 'var(--success, #22c55e)' : 'var(--accent-primary, #6366f1)'
                        }}
                    >
                        <Monitor size={15} />
                    </div>
                    <div>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary, #fff)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            {title}
                            <span 
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.35rem',
                                    fontSize: '0.7rem',
                                    padding: '0.15rem 0.5rem',
                                    borderRadius: '10px',
                                    background: isExecuting ? 'rgba(34, 197, 94, 0.15)' : 'rgba(255, 255, 255, 0.08)',
                                    color: isExecuting ? '#22c55e' : 'var(--text-secondary, #a1a1aa)',
                                    fontWeight: 500,
                                    border: isExecuting ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid rgba(255,255,255,0.06)'
                                }}
                            >
                                <span 
                                    style={{
                                        width: '6px',
                                        height: '6px',
                                        borderRadius: '50%',
                                        background: isExecuting ? '#22c55e' : (activeScreenshot ? '#38bdf8' : (vncAvailable ? '#6366f1' : '#a1a1aa')),
                                        boxShadow: isExecuting ? '0 0 8px #22c55e' : 'none'
                                    }}
                                />
                                {isExecuting ? 'Running Live' : (activeScreenshot ? 'Session Captured' : (vncAvailable ? 'Virtual Display Ready' : 'Stream Ready'))}
                            </span>
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary, #94a3b8)' }}>
                            {activeScreenshot ? 'Chromium CDP Live Stream' : (vncAvailable ? subtitle : 'Direct In-Browser Chromium View')}
                        </div>
                    </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    {runId && (
                        <button
                            type="button"
                            onClick={handleAutoFillForm}
                            disabled={isAutoFilling}
                            className="btn-icon"
                            title="Auto-fill form inputs with clean QA test data (First/Last Name, Email, Phone, Gender, etc.)"
                            style={{
                                background: isAutoFilling ? 'rgba(99, 102, 241, 0.4)' : 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
                                border: '1px solid rgba(167, 139, 250, 0.5)',
                                color: '#fff',
                                cursor: isAutoFilling ? 'wait' : 'pointer',
                                padding: '0.35rem 0.65rem',
                                borderRadius: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.35rem',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                boxShadow: '0 2px 8px rgba(79, 70, 229, 0.35)'
                            }}
                        >
                            <span>⚡</span>
                            <span>{isAutoFilling ? 'Filling Form...' : 'Auto-Fill Form'}</span>
                        </button>
                    )}

                    {activeScreenshot && (
                        <button
                            type="button"
                            onClick={() => setIsFitMode(!isFitMode)}
                            className="btn-icon"
                            title={isFitMode ? "Switch to Actual Size" : "Fit image to window"}
                            style={{
                                background: 'transparent',
                                border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
                                color: 'var(--text-secondary, #cbd5e1)',
                                cursor: 'pointer',
                                padding: '0.35rem 0.55rem',
                                borderRadius: '4px',
                                fontSize: '0.75rem'
                            }}
                        >
                            <span>{isFitMode ? '100% Size' : 'Fit Window'}</span>
                        </button>
                    )}

                    <button
                        type="button"
                        onClick={handleRefresh}
                        className="btn-icon"
                        title="Reconnect / Refresh Screen"
                        style={{
                            background: 'transparent',
                            border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
                            color: 'var(--text-secondary, #cbd5e1)',
                            cursor: 'pointer',
                            padding: '0.35rem 0.5rem',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            fontSize: '0.75rem'
                        }}
                    >
                        <RefreshCw size={13} />
                        <span>Refresh</span>
                    </button>

                    {(activeScreenshot || vncAvailable) && (
                        <button
                            type="button"
                            onClick={handlePopOut}
                            className="btn-icon"
                            title="Open in new window"
                            style={{
                                background: 'transparent',
                                border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
                                color: 'var(--text-secondary, #cbd5e1)',
                                cursor: 'pointer',
                                padding: '0.35rem 0.5rem',
                                borderRadius: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                fontSize: '0.75rem'
                            }}
                        >
                            <ExternalLink size={13} />
                            <span>Pop Out</span>
                        </button>
                    )}

                    <button
                        type="button"
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="btn-icon"
                        title={isExpanded ? "Collapse View" : "Expand View"}
                        style={{
                            background: 'transparent',
                            border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
                            color: 'var(--text-secondary, #cbd5e1)',
                            cursor: 'pointer',
                            padding: '0.35rem 0.5rem',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            fontSize: '0.75rem'
                        }}
                    >
                        {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                        <span>{isExpanded ? 'Collapse' : 'Expand'}</span>
                    </button>
                </div>
            </div>

            {/* Frame Container */}
            <div 
                style={{ 
                    position: 'relative', 
                    width: '100%', 
                    height: isExpanded ? '780px' : height,
                    background: '#090d16',
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column'
                }}
            >
                {isCheckingVnc ? (
                    <div 
                        style={{
                            height: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--text-primary, #fff)',
                            gap: '0.75rem',
                            fontSize: '0.85rem'
                        }}
                    >
                        <RefreshCw size={24} className="spin" style={{ color: 'var(--accent-primary, #6366f1)' }} />
                        <span>Initializing browser viewport...</span>
                    </div>
                ) : activeScreenshot ? (
                    /* 1. Live Chromium Browser Stream View */
                    <div 
                        style={{
                            position: 'relative',
                            width: '100%',
                            height: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            background: '#0a0e17',
                            overflow: 'hidden'
                        }}
                    >
                        {/* Browser Tab Strip (Chrome Style) */}
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            background: '#0d1117',
                            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                            padding: '4px 8px 0 8px',
                            gap: '4px',
                            overflowX: 'auto',
                            scrollbarWidth: 'none'
                        }}>
                            {(browserTabs && browserTabs.length > 0 ? browserTabs : [{ index: 0, url: 'Active Page', isActive: true }]).map((t, idx) => {
                                const isActive = t.isActive !== undefined ? t.isActive : (idx === activeTabIndex);
                                const cleanUrl = (t.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || `Tab ${idx + 1}`;
                                const titleText = (t.url && t.url.length > 25) ? cleanUrl : (t.url || `Tab ${idx + 1}`);

                                return (
                                    <div 
                                        key={idx}
                                        onClick={() => handleSwitchTab(idx)}
                                        title={`Switch to Tab ${idx + 1}: ${t.url || ''}`}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '6px',
                                            padding: '5px 12px',
                                            fontSize: '0.73rem',
                                            borderRadius: '6px 6px 0 0',
                                            background: isActive ? '#1e2433' : 'rgba(255,255,255,0.03)',
                                            color: isActive ? '#fff' : '#94a3b8',
                                            cursor: 'pointer',
                                            border: isActive ? '1px solid rgba(255,255,255,0.1)' : '1px solid transparent',
                                            borderBottom: 'none',
                                            maxWidth: '180px',
                                            minWidth: '90px',
                                            transition: 'all 0.15s ease',
                                            userSelect: 'none'
                                        }}
                                    >
                                        <Globe size={11} style={{ color: isActive ? '#38bdf8' : '#64748b', flexShrink: 0 }} />
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontWeight: isActive ? 600 : 400 }}>
                                            {titleText}
                                        </span>
                                        {browserTabs.length > 1 && (
                                            <span 
                                                onClick={(e) => { e.stopPropagation(); handleCloseTab(idx); }}
                                                title="Close tab"
                                                style={{
                                                    fontSize: '0.65rem',
                                                    padding: '1px 3px',
                                                    borderRadius: '3px',
                                                    color: '#94a3b8',
                                                    lineHeight: 1
                                                }}
                                                onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                                                onMouseLeave={(e) => e.currentTarget.style.color = '#94a3b8'}
                                            >
                                                ✕
                                            </span>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* Mock Browser Omnibox / Session Bar */}
                        <div 
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px',
                                padding: '6px 12px',
                                background: '#131824',
                                borderBottom: '1px solid rgba(255,255,255,0.08)',
                                fontSize: '0.75rem',
                                color: '#94a3b8',
                                flexShrink: 0
                            }}
                        >
                            <div style={{ display: 'flex', gap: '5px' }}>
                                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#eab308', display: 'inline-block' }} />
                                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                            </div>
                            <div 
                                style={{
                                    flex: 1,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    padding: '3px 10px',
                                    borderRadius: '4px',
                                    background: 'rgba(0,0,0,0.3)',
                                    border: '1px solid rgba(255,255,255,0.06)',
                                    color: '#cbd5e1',
                                    fontFamily: 'monospace',
                                    fontSize: '0.72rem',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap'
                                }}
                            >
                                <Shield size={11} style={{ color: '#22c55e', flexShrink: 0 }} />
                                <span>{browserTabs[activeTabIndex]?.url || 'chromium://session • Automated Web Viewport (1280x800)'}</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.7rem', color: isExecuting ? '#22c55e' : '#94a3b8' }}>
                                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: isExecuting ? '#22c55e' : '#a1a1aa' }} />
                                <span>{isExecuting ? (browserTabs.length > 1 ? `${browserTabs.length} TABS ACTIVE` : 'STREAMING') : 'IDLE'}</span>
                            </div>
                        </div>

                        {/* Interactive Direct Field Quick-Fill HUD */}
                        {activeField && (
                            <div style={{
                                padding: '8px 12px',
                                background: 'linear-gradient(90deg, #1e1b4b 0%, #0f172a 100%)',
                                borderBottom: '1px solid rgba(99, 102, 241, 0.4)',
                                display: 'flex',
                                flexWrap: 'wrap',
                                alignItems: 'center',
                                gap: '8px',
                                fontSize: '0.75rem'
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', color: '#a5b4fc', fontWeight: 600 }}>
                                    <span>✏️</span>
                                    <span>Fill Field:</span>
                                    <span style={{ 
                                        background: 'rgba(99, 102, 241, 0.25)', 
                                        color: '#c7d2fe', 
                                        padding: '2px 8px', 
                                        borderRadius: '4px',
                                        border: '1px solid rgba(99, 102, 241, 0.35)',
                                        fontFamily: 'monospace'
                                    }}>
                                        {activeField.placeholder || activeField.name || activeField.id || activeField.tagName}
                                    </span>
                                </div>

                                <form 
                                    onSubmit={(e) => { e.preventDefault(); handleDirectFill(inlineValue); }}
                                    style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: '220px' }}
                                >
                                    <input 
                                        ref={inlineInputRef}
                                        type="text"
                                        value={inlineValue}
                                        onChange={(e) => setInlineValue(e.target.value)}
                                        placeholder={`Type here and press Enter ↵ to fill...`}
                                        style={{
                                            flex: 1,
                                            padding: '4px 8px',
                                            borderRadius: '4px',
                                            background: '#090d16',
                                            border: '1px solid #6366f1',
                                            color: '#fff',
                                            fontSize: '0.75rem',
                                            outline: 'none',
                                            boxShadow: '0 0 6px rgba(99, 102, 241, 0.4)'
                                        }}
                                    />
                                    <button 
                                        type="submit"
                                        style={{
                                            padding: '4px 12px',
                                            borderRadius: '4px',
                                            background: '#4f46e5',
                                            color: '#fff',
                                            border: 'none',
                                            fontSize: '0.72rem',
                                            fontWeight: 600,
                                            cursor: 'pointer'
                                        }}
                                    >
                                        Fill & Enter ↵
                                    </button>
                                </form>

                                {/* Quick Test Data Presets */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: '0.68rem', color: '#94a3b8' }}>Presets:</span>
                                    {['John', 'Doe', 'john.doe@example.com', '9876543210', '123 Automation St'].map((preset, pIdx) => (
                                        <button
                                            key={pIdx}
                                            type="button"
                                            onClick={() => { setInlineValue(preset); handleDirectFill(preset); }}
                                            style={{
                                                padding: '2px 6px',
                                                borderRadius: '3px',
                                                background: 'rgba(255,255,255,0.08)',
                                                border: '1px solid rgba(255,255,255,0.12)',
                                                color: '#e2e8f0',
                                                fontSize: '0.68rem',
                                                cursor: 'pointer'
                                            }}
                                        >
                                            +{preset}
                                        </button>
                                    ))}
                                    <button
                                        type="button"
                                        onClick={() => setActiveField(null)}
                                        style={{
                                            padding: '2px 6px',
                                            borderRadius: '3px',
                                            background: 'transparent',
                                            border: 'none',
                                            color: '#94a3b8',
                                            fontSize: '0.72rem',
                                            cursor: 'pointer'
                                        }}
                                        title="Dismiss quick-fill bar"
                                    >
                                        ✕
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Image Viewport (Captures Physical Keyboard Input when focused) */}
                        <div 
                            ref={viewportContainerRef}
                            tabIndex={0}
                            onKeyDown={handleViewerKeyDown}
                            style={{
                                position: 'relative',
                                flex: 1,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                overflow: isFitMode ? 'hidden' : 'auto',
                                background: '#070a10',
                                outline: 'none'
                            }}
                        >
                            <div 
                                style={{
                                    position: 'relative',
                                    display: 'inline-block',
                                    maxWidth: '100%',
                                    maxHeight: '100%'
                                }}
                            >
                                <img 
                                    src={activeScreenshot}
                                    alt="MCP Agent Live Viewport"
                                    onClick={handleViewportClick}
                                    title={runId ? "Interactive Live View: Click fields to type directly or click to focus" : "Live Viewport"}
                                    style={{
                                        maxWidth: isFitMode ? '100%' : 'none',
                                        maxHeight: isFitMode ? '100%' : 'none',
                                        width: isFitMode ? '100%' : 'auto',
                                        height: isFitMode ? '100%' : 'auto',
                                        objectFit: isFitMode ? 'contain' : 'initial',
                                        display: 'block',
                                        cursor: runId ? 'crosshair' : 'default'
                                    }}
                                />

                                {/* Interactive Click Ripple Indicator */}
                                {clickRipple && (
                                    <div 
                                        style={{
                                            position: 'absolute',
                                            left: `${clickRipple.x}px`,
                                            top: `${clickRipple.y}px`,
                                            width: '24px',
                                            height: '24px',
                                            marginLeft: '-12px',
                                            marginTop: '-12px',
                                            borderRadius: '50%',
                                            background: 'rgba(56, 189, 248, 0.4)',
                                            border: '2px solid #38bdf8',
                                            boxShadow: '0 0 12px #38bdf8',
                                            pointerEvents: 'none',
                                            animation: 'aaquaClickRipple 0.5s ease-out forwards'
                                        }}
                                    />
                                )}
                            </div>

                            {/* Floating HUD Live Indicator */}
                            <div 
                                style={{
                                    position: 'absolute',
                                    bottom: '12px',
                                    left: '12px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    padding: '4px 10px',
                                    borderRadius: '16px',
                                    background: 'rgba(15, 23, 42, 0.85)',
                                    backdropFilter: 'blur(8px)',
                                    border: '1px solid rgba(56, 189, 248, 0.25)',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                                    fontSize: '0.7rem',
                                    color: '#38bdf8',
                                    pointerEvents: 'none'
                                }}
                            >
                                <span 
                                    style={{
                                        width: '7px',
                                        height: '7px',
                                        borderRadius: '50%',
                                        background: isInteracting ? '#f59e0b' : (isExecuting ? '#22c55e' : '#a1a1aa'),
                                        boxShadow: isExecuting ? '0 0 8px #22c55e' : 'none'
                                    }} 
                                />
                                <span>{isInteracting ? '● DISPATCHING...' : ((runId || pollEndpoint) ? '● CLICK OR TYPE ON SCREEN • LIVE EMBEDDED SESSION' : (isExecuting ? '● LIVE CDP STREAM' : '● FINAL FRAME CAPTURED'))}</span>
                            </div>
                        </div>

                        {/* Interactive In-Viewer Typing Bar */}
                        {(runId || pollEndpoint) && (
                            <div style={{
                                padding: '6px 12px',
                                background: '#111827',
                                borderTop: '1px solid rgba(255, 255, 255, 0.1)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                fontSize: '0.75rem'
                            }}>
                                <span style={{ color: '#38bdf8', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                                    <span>⌨️</span> <span>Type:</span>
                                </span>
                                <form onSubmit={handleSendText} style={{ display: 'flex', gap: '6px', flex: 1 }}>
                                    <input 
                                        type="text"
                                        value={quickText}
                                        onChange={(e) => setQuickText(e.target.value)}
                                        placeholder="Click any input field above, then type text or use your physical keyboard..."
                                        style={{
                                            flex: 1,
                                            padding: '4px 8px',
                                            borderRadius: '4px',
                                            background: 'rgba(255, 255, 255, 0.08)',
                                            border: '1px solid rgba(255, 255, 255, 0.18)',
                                            color: '#fff',
                                            fontSize: '0.75rem'
                                        }}
                                    />
                                    <button 
                                        type="submit" 
                                        disabled={!quickText} 
                                        style={{ 
                                            padding: '3px 10px', 
                                            fontSize: '0.7rem', 
                                            background: quickText ? '#3b82f6' : 'rgba(255,255,255,0.1)', 
                                            color: '#fff', 
                                            border: 'none', 
                                            borderRadius: '4px', 
                                            cursor: quickText ? 'pointer' : 'default',
                                            fontWeight: 600
                                        }}
                                    >
                                        Send Text
                                    </button>
                                </form>
                                <button 
                                    type="button" 
                                    onClick={() => handleSendKey('Backspace')} 
                                    title="Press Backspace key in browser"
                                    style={{ padding: '3px 8px', fontSize: '0.7rem', background: 'rgba(255,255,255,0.08)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '4px', cursor: 'pointer' }}
                                >
                                    ⌫ Backspace
                                </button>
                                <button 
                                    type="button" 
                                    onClick={() => handleSendKey('Enter')} 
                                    title="Press Enter key in browser"
                                    style={{ padding: '3px 8px', fontSize: '0.7rem', background: 'rgba(255,255,255,0.08)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '4px', cursor: 'pointer' }}
                                >
                                    Enter ↵
                                </button>
                                <button 
                                    type="button" 
                                    onClick={() => handleSendKey('Tab')} 
                                    title="Press Tab key in browser"
                                    style={{ padding: '3px 8px', fontSize: '0.7rem', background: 'rgba(255,255,255,0.08)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '4px', cursor: 'pointer' }}
                                >
                                    Tab ⇥
                                </button>
                            </div>
                        )}
                    </div>
                ) : vncAvailable ? (
                    /* 2. Server noVNC HTML5 Iframe */
                    <iframe
                        key={iframeKey}
                        ref={iframeRef}
                        src={vncUrl}
                        title="noVNC Virtual Desktop Stream"
                        style={{
                            width: '100%',
                            height: '100%',
                            border: 'none',
                            background: '#000',
                            display: 'block'
                        }}
                        allow="fullscreen"
                    />
                ) : isExecuting ? (
                    /* 3. Executing State (Native Headed Desktop or Headless) */
                    <div 
                        style={{
                            height: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'radial-gradient(circle at center, rgba(30, 41, 59, 0.4) 0%, rgba(10, 13, 20, 0.95) 100%)',
                            color: 'var(--text-primary, #fff)',
                            gap: '1.2rem',
                            padding: '2rem',
                            textAlign: 'center'
                        }}
                    >
                        <div 
                            style={{
                                width: '64px',
                                height: '64px',
                                borderRadius: '50%',
                                background: pollEndpoint ? 'rgba(56, 189, 248, 0.15)' : (isHeaded ? 'rgba(34, 197, 94, 0.15)' : 'rgba(99, 102, 241, 0.15)'),
                                border: pollEndpoint ? '1px solid rgba(56, 189, 248, 0.4)' : (isHeaded ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid rgba(99, 102, 241, 0.4)'),
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: pollEndpoint ? '#38bdf8' : (isHeaded ? '#22c55e' : '#818cf8'),
                                boxShadow: pollEndpoint ? '0 0 25px rgba(56, 189, 248, 0.3)' : (isHeaded ? '0 0 25px rgba(34, 197, 94, 0.3)' : '0 0 24px rgba(99, 102, 241, 0.25)')
                            }}
                        >
                            {pollEndpoint ? <RefreshCw size={28} className="spin" /> : (isHeaded ? <Monitor size={30} /> : <RefreshCw size={28} className="spin" />)}
                        </div>
                        <div style={{ maxWidth: '480px' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '3px 10px', borderRadius: '12px', background: pollEndpoint ? 'rgba(56, 189, 248, 0.12)' : (isHeaded ? 'rgba(34, 197, 94, 0.12)' : 'rgba(99, 102, 241, 0.12)'), border: pollEndpoint ? '1px solid rgba(56, 189, 248, 0.3)' : (isHeaded ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid rgba(99, 102, 241, 0.3)'), color: pollEndpoint ? '#38bdf8' : (isHeaded ? '#22c55e' : '#a5b4fc'), fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.6rem' }}>
                                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: pollEndpoint ? '#38bdf8' : (isHeaded ? '#22c55e' : '#818cf8'), boxShadow: '0 0 6px currentColor' }} />
                                {pollEndpoint ? 'EMBEDDED LIVE BROWSER' : (isHeaded ? 'HEADED MODE ACTIVE' : 'HEADLESS EXECUTION')}
                            </div>
                            <h3 style={{ margin: '0 0 0.4rem 0', fontSize: '1.15rem', fontWeight: 600 }}>
                                {pollEndpoint
                                    ? 'Launching Browser Inside AAQUA...'
                                    : (isHeaded 
                                        ? `${framework ? framework.toUpperCase() + ' ' : ''}Browser Launched on Desktop` 
                                        : 'Executing Tests in Background')}
                            </h3>
                            <p style={{ margin: '0 0 1rem 0', fontSize: '0.84rem', color: '#94a3b8', lineHeight: 1.55 }}>
                                {pollEndpoint
                                    ? 'Opening page and streaming viewport directly into this window. You can interact, click, and navigate inside.'
                                    : (isHeaded 
                                        ? 'The browser window has opened directly on your desktop screen. You can watch tests interact with the page in real-time. Any test screenshots or failure captures will automatically stream here.' 
                                        : 'Tests are running in background headless mode. Step/failure screenshots will render here when captured.')}
                            </p>

                            {!isHeaded && onToggleHeaded && (
                                <button
                                    type="button"
                                    onClick={onToggleHeaded}
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '6px',
                                        padding: '0.45rem 1rem',
                                        borderRadius: '6px',
                                        background: 'rgba(99, 102, 241, 0.2)',
                                        border: '1px solid rgba(99, 102, 241, 0.4)',
                                        color: '#c7d2fe',
                                        fontSize: '0.78rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    <Monitor size={14} />
                                    <span>Enable Headed Browser for Next Run</span>
                                </button>
                            )}
                        </div>
                    </div>
                ) : (
                    /* 4. Ready / Idle State */
                    <div 
                        style={{
                            height: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '2rem',
                            textAlign: 'center',
                            background: 'radial-gradient(circle at center, rgba(30, 41, 59, 0.4) 0%, rgba(15, 23, 42, 0.95) 100%)',
                            color: 'var(--text-primary, #fff)'
                        }}
                    >
                        <div 
                            style={{
                                width: '56px',
                                height: '56px',
                                borderRadius: '50%',
                                background: 'rgba(56, 189, 248, 0.12)',
                                border: '1px solid rgba(56, 189, 248, 0.3)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: '#38bdf8',
                                marginBottom: '1rem',
                                boxShadow: '0 0 20px rgba(56, 189, 248, 0.15)'
                            }}
                        >
                            <Monitor size={28} />
                        </div>
                        <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.15rem', fontWeight: 600 }}>
                            Automated Test Browser Viewport
                        </h3>
                        <p style={{ maxWidth: '520px', margin: '0 0 1.25rem 0', fontSize: '0.85rem', color: 'var(--text-secondary, #94a3b8)', lineHeight: 1.6 }}>
                            {hasDisplayServer && !vncAvailable
                                ? (isHeaded 
                                    ? 'Headed mode is enabled. When you run tests, Chromium will launch directly on your desktop so you can watch execution live.' 
                                    : 'Tests are set to headless mode. You can watch the physical browser window launch on your desktop by toggling Headed Mode.')
                                : 'When you execute an automated test suite or MCP Agent task, the browser stream and test screenshots will render directly in this window.'}
                        </p>

                        {/* Interactive Mode Card */}
                        <div 
                            style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '0.75rem',
                                background: 'rgba(0, 0, 0, 0.35)',
                                border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
                                borderRadius: '8px',
                                padding: '1rem 1.4rem',
                                maxWidth: '520px',
                                textAlign: 'left',
                                fontSize: '0.8rem',
                                color: 'var(--text-secondary, #cbd5e1)'
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '0.6rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: isHeaded ? '#22c55e' : '#a1a1aa' }} />
                                    <span style={{ fontWeight: 600, color: '#fff' }}>
                                        {isHeaded ? 'Headed Browser: Enabled' : 'Headed Browser: Disabled (Headless)'}
                                    </span>
                                </div>
                                {onToggleHeaded && hasDisplayServer && (
                                    <button
                                        type="button"
                                        onClick={onToggleHeaded}
                                        style={{
                                            background: isHeaded ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)',
                                            border: isHeaded ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(34, 197, 94, 0.3)',
                                            color: isHeaded ? '#fca5a5' : '#86efac',
                                            padding: '3px 10px',
                                            borderRadius: '4px',
                                            fontSize: '0.74rem',
                                            fontWeight: 600,
                                            cursor: 'pointer'
                                        }}
                                    >
                                        {isHeaded ? 'Switch to Headless' : '⚡ Enable Headed Mode'}
                                    </button>
                                )}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <CheckCircle size={15} style={{ color: '#22c55e', flexShrink: 0 }} />
                                <span><strong>Desktop Execution:</strong> Chromium/Chrome opens visibly on your Windows screen in Headed mode.</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <CheckCircle size={15} style={{ color: '#38bdf8', flexShrink: 0 }} />
                                <span><strong>Auto-Captured Frames:</strong> Playwright failure screenshots & MCP CDP streams render inside this frame.</span>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Sub-footer banner */}
            <div 
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.4rem 0.85rem',
                    background: 'var(--bg-primary, #151521)',
                    borderTop: '1px solid var(--border-color, rgba(255,255,255,0.06))',
                    fontSize: '0.72rem',
                    color: 'var(--text-secondary, #94a3b8)'
                }}
            >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <Info size={12} style={{ color: 'var(--accent-primary, #6366f1)' }} />
                    {activeScreenshot 
                        ? 'Live Chromium DevTools stream active. Page viewport rendered in real-time.' 
                        : (vncAvailable 
                            ? 'Live stream from Xvfb + noVNC. Remote browser session on DISPLAY=:99.' 
                            : (isHeaded 
                                ? 'Headed mode active. Chromium launches natively on your desktop.' 
                                : 'Headless execution mode. Enable headed mode to watch the browser live.'))}
                </span>
                <span style={{ fontFamily: 'monospace', opacity: 0.8 }}>
                    {activeScreenshot 
                        ? 'Mode: CDP Live Stream (1280x720)' 
                        : (vncAvailable 
                            ? 'Mode: noVNC Stream (:99)' 
                            : (isHeaded ? 'Mode: Native Desktop (Headed)' : 'Mode: Background Headless'))}
                </span>
            </div>
        </div>
    );
};

export default LiveBrowserViewer;
