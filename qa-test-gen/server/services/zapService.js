import dotenv from 'dotenv';
dotenv.config();

const ZAP_API_URL = process.env.ZAP_API_URL || 'http://localhost:8080';
const ZAP_API_KEY = process.env.ZAP_API_KEY || '';

// --- SCAN ABORTION REGISTRY ---
export const abortedScans = new Set();

export function abortScan(dbScanId, dbScanStatus, zapScanId) {
    abortedScans.add(dbScanId);
    if (zapScanId) {
        // Fire-and-forget ZAP stop requests to prevent blocking Express API response
        (async () => {
            try {
                if (zapScanId.startsWith('spider-')) {
                    const spiderId = zapScanId.replace('spider-', '');
                    console.log(`[ZAP] Stop spider requested for ZAP Scan ID: ${spiderId}`);
                    await zapRequest('/JSON/spider/action/stop/', { scanId: spiderId });
                } else if (zapScanId.startsWith('active-')) {
                    const activeId = zapScanId.replace('active-', '');
                    console.log(`[ZAP] Stop active scan requested for ZAP Scan ID: ${activeId}`);
                    await zapRequest('/JSON/ascan/action/stop/', { scanId: activeId });
                }
            } catch (err) {
                console.warn(`[ZAP] Failed to send stop action to ZAP for ID ${zapScanId}: ${err.message}`);
            }
        })();
    }
}

export function isAborted(dbScanId) {
    return abortedScans.has(dbScanId);
}

/**
 * Make a request to the ZAP REST API
 */
async function zapRequest(endpoint, params = {}) {
    const isAction = endpoint.includes('/action/');
    const url = new URL(endpoint, ZAP_API_URL);
    
    if (ZAP_API_KEY) params.apikey = ZAP_API_KEY;

    let response;
    if (isAction) {
        // Use POST for actions to handle complex parameters
        const body = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => body.append(k, v));
        response = await fetch(url.toString(), {
            method: 'POST',
            body: body,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
    } else {
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
        response = await fetch(url.toString());
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`ZAP API error [${response.status}]: ${text}`);
    }
    return response.json();
}

/**
 * Normalize URL for ZAP (running in Docker)
 * Replaces localhost/127.0.0.1 with host.docker.internal
 */
function normalizeUrlForZap(url) {
    if (!url) return url;
    return url.replace(/localhost/g, 'host.docker.internal').replace(/127\.0\.0\.1/g, 'host.docker.internal');
}

/**
 * Access a URL to prime the ZAP site tree
 */
export async function accessUrl(targetUrl) {
    const normalized = normalizeUrlForZap(targetUrl);
    try {
        const result = await zapRequest('/JSON/core/action/accessUrl/', { url: normalized });
        console.log(`[ZAP] URL accessed and added to tree: ${normalized}`, result);
    } catch (err) {
        console.warn(`[ZAP] Failed to prime URL tree for ${normalized}: ${err.message}`);
    }
}

// ─── Spider ──────────────────────────────────────────────

/**
 * Start ZAP spider to crawl the target URL
 * @returns {string} Spider scan ID
 */
export async function startSpider(targetUrl, contextName = null) {
    const normalized = normalizeUrlForZap(targetUrl);
    const params = {
        url: normalized,
        maxChildren: '10',
        recurse: 'true',
        subtreeOnly: 'true', // Restrict strictly to the target URL's subtree to avoid massive runaway crawls
    };
    if (contextName) {
        params.contextName = contextName;
    }
    const data = await zapRequest('/JSON/spider/action/scan/', params);
    console.log(`[ZAP] Spider started: ID=${data.scan} for ${normalized} (Context: ${contextName || 'None'})`);
    return data.scan;
}

/**
 * Get spider progress (0-100)
 */
export async function getSpiderProgress(scanId) {
    const data = await zapRequest('/JSON/spider/view/status/', { scanId });
    return parseInt(data.status, 10);
}

/**
 * Wait for spider to complete with timeout and callback
 */
export async function waitForSpider(scanId, onProgress, pollInterval = 3000, timeoutMs = 300000, dbScanId = null) {
    const start = Date.now();
    let progress = 0;
    while (progress < 100) {
        if (dbScanId && isAborted(dbScanId)) {
            throw new Error('Scan stopped by user');
        }
        if (Date.now() - start > timeoutMs) {
            console.warn(`[ZAP] Spider scan ${scanId} timed out after ${timeoutMs}ms`);
            break;
        }
        await new Promise(r => setTimeout(r, pollInterval));
        progress = await getSpiderProgress(scanId);
        console.log(`[ZAP] Spider progress: ${progress}%`);
        if (onProgress) onProgress(progress);
    }
    console.log('[ZAP] Spider phase check completed.');
}

/**
 * Verify that the spider actually fetched pages into ZAP's site tree.
 * If the spider completed but ZAP has I/O errors (can't reach the target),
 * throw a clear error instead of letting the active scan fail cryptically.
 */
async function verifySpiderResults(spiderId, targetUrl) {
    const normalized = normalizeUrlForZap(targetUrl);
    try {
        const fullResults = await zapRequest('/JSON/spider/view/fullResults/', { scanId: spiderId });
        const ioErrors = fullResults.fullResults?.[2]?.urlsIoError || [];
        const inScope = fullResults.fullResults?.[0]?.urlsInScope || [];
        console.log(`[ZAP] Spider full results — in scope: ${inScope.length}, I/O errors: ${ioErrors.length}`);

        if (ioErrors.length > 0 && inScope.length === 0) {
            const sampleErrors = ioErrors.slice(0, 3).map(e => `${e.url} (${e.reasonNotProcessed})`).join(', ');
            throw new Error(
                `ZAP cannot reach the target URL "${targetUrl}". The spider found URLs but all requests failed with I/O errors. ` +
                `This usually means the ZAP Docker container has no network access to the target. ` +
                `Sample errors: ${sampleErrors}. ` +
                `If scanning localhost, ensure docker-compose.security.yml has "extra_hosts: host.docker.internal:host-gateway" configured.`
            );
        }
    } catch (err) {
        if (err.message.includes('ZAP cannot reach')) throw err;
        console.warn(`[ZAP] Could not verify spider results: ${err.message}`);
    }

    // Also verify site tree is populated
    try {
        const urlData = await zapRequest('/JSON/core/view/urls/', { baseurl: normalized });
        const treeUrls = urlData.urls || [];
        if (treeUrls.length === 0) {
            // Try without baseurl filter in case normalization differs
            const allData = await zapRequest('/JSON/core/view/urls/', {});
            const allUrls = allData.urls || [];
            if (allUrls.length === 0) {
                throw new Error(
                    `ZAP site tree is empty after spidering "${targetUrl}". ` +
                    `The target may be unreachable from the ZAP Docker container, or it returned no crawlable content. ` +
                    `Verify the target is accessible and try a Baseline scan first.`
                );
            }
            console.log(`[ZAP] Site tree has ${allUrls.length} URLs (none matched baseurl filter, will resolve during active scan)`);
        } else {
            console.log(`[ZAP] Site tree verified: ${treeUrls.length} URLs for ${normalized}`);
        }
    } catch (err) {
        if (err.message.includes('ZAP site tree is empty')) throw err;
        console.warn(`[ZAP] Could not verify site tree: ${err.message}`);
    }
}

// ─── Passive Scan (Baseline) ─────────────────────────────

/**
 * Wait for passive scan to finish (ZAP runs passive scanning automatically)
 */
export async function waitForPassiveScan(onProgress, pollInterval = 2000, dbScanId = null) {
    let remaining = -1;
    let initialRemaining = -1;
    while (remaining !== 0) {
        if (dbScanId && isAborted(dbScanId)) {
            throw new Error('Scan stopped by user');
        }
        const data = await zapRequest('/JSON/pscan/view/recordsToScan/');
        remaining = parseInt(data.recordsToScan, 10);
        if (initialRemaining === -1) {
            initialRemaining = remaining;
        }
        if (remaining > 0) {
            console.log(`[ZAP] Passive scan: ${remaining} records remaining (initial: ${initialRemaining})`);
            const p = initialRemaining > 0 ? Math.max(0, Math.min(99, Math.round(((initialRemaining - remaining) / initialRemaining) * 100))) : 0;
            if (onProgress) onProgress(p);
        }
        if (remaining !== 0) {
            await new Promise(r => setTimeout(r, pollInterval));
        }
    }
    if (onProgress) onProgress(100);
    console.log('[ZAP] Passive scan completed.');
}

// ─── Active Scan ─────────────────────────────────────────

/**
 * Start an active scan against the target
 * Resolves the URL from ZAP's site tree to avoid "URL Not Found" errors
 * @returns {string} Active scan ID
 */
export async function startActiveScan(targetUrl) {
    const normalized = normalizeUrlForZap(targetUrl);
    const scanUrl = await resolveUrlFromSiteTree(normalized);
    const data = await zapRequest('/JSON/ascan/action/scan/', {
        url: scanUrl,
        recurse: 'true',
        inScopeOnly: 'false',
    });
    console.log(`[ZAP] Active scan started: ID=${data.scan} for ${scanUrl}`);
    return data.scan;
}

/**
 * Resolve the actual URL from ZAP's site tree.
 * ZAP's active scan requires a URL that exists as a node in its URL tree,
 * not just a site origin. Queries both /core/view/urls/ and /core/view/sites/
 * to find the best match.
 */
async function resolveUrlFromSiteTree(normalizedUrl) {
    try {
        // Query all URLs in ZAP's tree (actual crawled pages)
        const urlData = await zapRequest('/JSON/core/view/urls/', { baseurl: normalizedUrl });
        const urls = urlData.urls || [];
        console.log(`[ZAP] Site tree has ${urls.length} URLs for baseurl=${normalizedUrl}`);

        if (urls.length > 0) {
            // Exact match first
            if (urls.includes(normalizedUrl)) return normalizedUrl;
            // Try with/without trailing slash
            const withSlash = normalizedUrl.endsWith('/') ? normalizedUrl : normalizedUrl + '/';
            const withoutSlash = normalizedUrl.endsWith('/') ? normalizedUrl.slice(0, -1) : normalizedUrl;
            const slashMatch = urls.find(u => u === withSlash || u === withoutSlash);
            if (slashMatch) {
                console.log(`[ZAP] Resolved URL (slash match): ${normalizedUrl} -> ${slashMatch}`);
                return slashMatch;
            }
            // Use the first URL that starts with our target (closest to root)
            const sorted = urls.sort((a, b) => a.length - b.length);
            console.log(`[ZAP] Resolved URL (shortest match): ${normalizedUrl} -> ${sorted[0]}`);
            return sorted[0];
        }

        // Fallback: try baseurl without filter in case normalization differs
        const allUrlData = await zapRequest('/JSON/core/view/urls/', {});
        const allUrls = allUrlData.urls || [];
        console.log(`[ZAP] Full site tree has ${allUrls.length} URLs total`);

        if (allUrls.length > 0) {
            // Find URLs matching our hostname
            const parsed = new URL(normalizedUrl);
            const hostMatches = allUrls.filter(u => {
                try { return new URL(u).hostname === parsed.hostname; } catch { return false; }
            });
            if (hostMatches.length > 0) {
                const sorted = hostMatches.sort((a, b) => a.length - b.length);
                console.log(`[ZAP] Resolved URL (host match): ${normalizedUrl} -> ${sorted[0]}`);
                return sorted[0];
            }
            // Last resort: use the first available URL in the tree
            const sorted = allUrls.sort((a, b) => a.length - b.length);
            console.log(`[ZAP] Resolved URL (first available): ${normalizedUrl} -> ${sorted[0]}`);
            return sorted[0];
        }

        console.warn(`[ZAP] Site tree is completely empty after spidering`);
    } catch (err) {
        console.warn(`[ZAP] Failed to query site tree: ${err.message}`);
    }
    return normalizedUrl;
}

/**
 * Get active scan progress (0-100)
 */
export async function getActiveScanProgress(scanId) {
    const data = await zapRequest('/JSON/ascan/view/status/', { scanId });
    return parseInt(data.status, 10);
}

/**
 * Wait for active scan to complete with timeout and callback
 */
export async function waitForActiveScan(scanId, onProgress, pollInterval = 5000, timeoutMs = 900000, dbScanId = null) {
    const start = Date.now();
    let progress = 0;
    while (progress < 100) {
        if (dbScanId && isAborted(dbScanId)) {
            throw new Error('Scan stopped by user');
        }
        if (Date.now() - start > timeoutMs) {
            console.warn(`[ZAP] Active scan ${scanId} timed out after ${timeoutMs}ms`);
            break;
        }
        await new Promise(r => setTimeout(r, pollInterval));
        progress = await getActiveScanProgress(scanId);
        console.log(`[ZAP] Active scan progress: ${progress}%`);
        if (onProgress) onProgress(progress);
    }
    console.log('[ZAP] Active scan phase check completed.');
}

// ─── API Scan ────────────────────────────────────────────

/**
 * Import an OpenAPI spec into ZAP
 */
export async function importOpenApiSpec(specUrl, targetUrl) {
    const data = await zapRequest('/JSON/openapi/action/importUrl/', {
        url: specUrl,
        hostOverride: targetUrl || '',
    });
    console.log(`[ZAP] OpenAPI spec imported:`, data);
    return data;
}

// ─── Alerts ──────────────────────────────────────────────

/**
 * Get all alerts from ZAP for a given base URL
 * @returns {Array} Array of alert objects
 */
export async function getAlerts(baseUrl, start = 0, count = 500) {
    const normalized = normalizeUrlForZap(baseUrl);
    const data = await zapRequest('/JSON/alert/view/alerts/', {
        baseurl: normalized,
        start: String(start),
        count: String(count),
    });
    return data.alerts || [];
}

/**
 * Get alert summary counts
 */
export async function getAlertSummary(baseUrl) {
    const alerts = await getAlerts(baseUrl);
    const summary = { Informational: 0, Low: 0, Medium: 0, High: 0 };
    for (const alert of alerts) {
        const risk = alert.risk || 'Informational';
        summary[risk] = (summary[risk] || 0) + 1;
    }
    return { total: alerts.length, ...summary };
}

// ─── Session Management ──────────────────────────────────

/**
 * Create a new ZAP session (cleans state between scans)
 */
export async function newSession(name) {
    await zapRequest('/JSON/core/action/newSession/', {
        name: name || '',
        overwrite: 'true',
    });
    console.log(`[ZAP] New session created: ${name || 'default'}`);
}

/**
 * Check if ZAP is running and reachable
 */
export async function healthCheck() {
    try {
        const data = await zapRequest('/JSON/core/view/version/');
        return { status: 'ok', version: data.version };
    } catch (err) {
        return { status: 'error', error: err.message };
    }
}

/**
 * Setup ZAP Context for authenticated scans
 */
export async function setupZapContext(project) {
    if (!project.auth_username || !project.auth_password || !project.login_url) {
        // Disable forced user mode if no credentials provided (cleanup)
        await zapRequest('/JSON/forcedUser/action/setForcedUserModeEnabled/', { boolean: 'false' }).catch(() => { });
        return null;
    }

    const contextName = `project-${project.id}`;
    const baseUrl = project.target_url;

    try {
        // 1. Create context
        await zapRequest('/JSON/context/action/newContext/', { contextName }).catch(() => { });
        const ctxData = await zapRequest('/JSON/context/view/context/', { contextName });
        console.log(`[ZAP] Context data retrieved:`, JSON.stringify(ctxData));
        const contextId = ctxData.context?.id || ctxData.context;

        // 2. Include the target URL in the context
        const normalizedBaseUrl = normalizeUrlForZap(baseUrl);
        await zapRequest('/JSON/context/action/includeInContext/', { contextName, regex: `${normalizedBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*` });

        // 3. Set Auth Method (Form-based)
        const loginRequestData = `username={%username%}&password={%password%}`;
        // ZAP expects a string of key=value pairs separated by &
        const configParams = `loginUrl=${normalizeUrlForZap(project.login_url)}&loginRequestData=${loginRequestData}`;
        
        console.log(`[ZAP] Setting auth method for context ${contextId} with params: ${configParams}`);
        await zapRequest('/JSON/authentication/action/setAuthenticationMethod/', {
            contextId,
            authMethodName: 'formBasedAuthentication',
            authMethodConfigParams: configParams
        });

        // 4. Set Logged In Indicator (Required for some versions to validate the method)
        // We'll use a generic "Logout" or "Sign Out" pattern as a default
        await zapRequest('/JSON/authentication/action/setLoggedInIndicator/', {
            contextId,
            loggedInIndicatorRegex: '(Logout|Sign Out|Sign-out|Welcome)'
        }).catch(err => console.warn('[ZAP] Failed to set LoggedIn indicator:', err.message));

        // 4. Create User
        let userId;
        try {
            const userData = await zapRequest('/JSON/users/action/newUser/', { contextId, userName: 'sec-user' });
            userId = userData.userId;
        } catch {
            const users = await zapRequest('/JSON/users/view/usersList/', { contextId });
            userId = users.usersList.find(u => u.name === 'sec-user')?.id;
        }

        // 5. Configure User Credentials
        await zapRequest('/JSON/users/action/setAuthenticationCredentials/', {
            contextId,
            userId,
            authCredentialsConfigParams: `username=${encodeURIComponent(project.auth_username)}&password=${encodeURIComponent(project.auth_password)}`
        });

        // 6. Enable User
        await zapRequest('/JSON/users/action/setUserEnabled/', { contextId, userId, enabled: 'true' });

        // 7. Enable Forced User Mode
        await zapRequest('/JSON/forcedUser/action/setForcedUser/', { contextId, userId });
        await zapRequest('/JSON/forcedUser/action/setForcedUserModeEnabled/', { boolean: 'true' });

        console.log(`[ZAP] Authenticated context setup for project: ${project.name}`);
        return { contextId, userId };
    } catch (err) {
        console.error('[ZAP] Failed to setup authenticated context:', err.message);
        await zapRequest('/JSON/forcedUser/action/setForcedUserModeEnabled/', { boolean: 'false' }).catch(() => { });
        return null;
    }
}

// ─── Full Scan Orchestration ─────────────────────────────

const log = (line) => console.log(line);

/**
 * Run a complete baseline scan (spider → passive scan → get alerts)
 */
export async function runBaselineScan(project, onProgress, dbScan = null) {
    const targetUrl = project.target_url;
    log(`[ZAP] Baseline scan starting for ${targetUrl}`);
    await newSession(`baseline-${Date.now()}`);
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    await accessUrl(targetUrl); // Prime the tree
    const hasContext = await setupZapContext(project);
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    const spiderId = await startSpider(targetUrl, hasContext ? `project-${project.id}` : null);
    if (dbScan) await dbScan.update({ zap_scan_id: `spider-${spiderId}` });
    
    // Spidering phase: 0% - 40%
    await waitForSpider(spiderId, (p) => onProgress && onProgress('spidering', Math.round(p * 0.4)), 3000, 300000, dbScan?.id);
    
    // Passive scan phase: 40% - 60%
    await waitForPassiveScan((p) => onProgress && onProgress('passive_scanning', 40 + Math.round(p * 0.2)), 2000, dbScan?.id);
    
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    return getAlerts(targetUrl);
}

/**
 * Run a complete active scan (spider → passive → active → get alerts)
 */
export async function runFullActiveScan(project, onProgress, dbScan = null) {
    const targetUrl = project.target_url;
    log(`[ZAP] Active scan starting for ${targetUrl}`);
    await newSession(`active-${Date.now()}`);
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    await accessUrl(targetUrl); // Prime the tree
    const hasContext = await setupZapContext(project);
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    const spiderId = await startSpider(targetUrl, hasContext ? `project-${project.id}` : null);
    if (dbScan) await dbScan.update({ zap_scan_id: `spider-${spiderId}` });
    
    // Spidering phase: 0% - 15%
    await waitForSpider(spiderId, (p) => onProgress && onProgress('spidering', Math.round(p * 0.15)), 3000, 300000, dbScan?.id);

    // Verify the spider actually fetched pages successfully
    await verifySpiderResults(spiderId, targetUrl);

    // Passive scan phase: 15% - 25%
    await waitForPassiveScan((p) => onProgress && onProgress('passive_scanning', 15 + Math.round(p * 0.1)), 2000, dbScan?.id);
    
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    const activeScanId = await startActiveScan(targetUrl);
    if (dbScan) await dbScan.update({ zap_scan_id: `active-${activeScanId}` });
    
    // Active scan phase: 25% - 65%
    await waitForActiveScan(activeScanId, (p) => onProgress && onProgress('scanning', 25 + Math.round(p * 0.4)), 5000, 900000, dbScan?.id);
    
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    return getAlerts(targetUrl);
}

/**
 * Run an API scan (import OpenAPI spec → spider → active scan → get alerts)
 */
export async function runApiScan(specUrl, project, onProgress, dbScan = null) {
    const targetUrl = project?.target_url;
    log(`[ZAP] API scan starting; importing OpenAPI spec from ${specUrl}`);
    await newSession(`api-${Date.now()}`);
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    let hasContext = null;
    if (project) hasContext = await setupZapContext(project);
    if (targetUrl) await accessUrl(targetUrl); // Prime the tree
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    await importOpenApiSpec(specUrl, targetUrl);
    
    if (targetUrl) {
        const spiderId = await startSpider(targetUrl, hasContext ? `project-${project.id}` : null);
        if (dbScan) await dbScan.update({ zap_scan_id: `spider-${spiderId}` });
        // Spidering phase: 0% - 15%
        await waitForSpider(spiderId, (p) => onProgress && onProgress('spidering', Math.round(p * 0.15)), 3000, 300000, dbScan?.id);
        await verifySpiderResults(spiderId, targetUrl);
    } else {
        if (onProgress) onProgress('spidering', 15);
    }
    
    // Passive scan phase: 15% - 25%
    await waitForPassiveScan((p) => onProgress && onProgress('passive_scanning', 15 + Math.round(p * 0.1)), 2000, dbScan?.id);
    
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    if (targetUrl) {
        const activeScanId = await startActiveScan(targetUrl);
        if (dbScan) await dbScan.update({ zap_scan_id: `active-${activeScanId}` });
        // Active scan phase: 25% - 65%
        await waitForActiveScan(activeScanId, (p) => onProgress && onProgress('scanning', 25 + Math.round(p * 0.4)), 5000, 900000, dbScan?.id);
    } else {
        if (onProgress) onProgress('scanning', 65);
    }
    
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    return getAlerts(targetUrl || specUrl);
}

/**
 * Run a passive scan only (spider → wait for passive scan → get alerts)
 */
export async function runPassiveScan(project, onProgress, dbScan = null) {
    const targetUrl = project.target_url;
    log(`[ZAP] Passive scan starting for ${targetUrl}`);
    await newSession(`passive-${Date.now()}`);
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    await accessUrl(targetUrl); // Prime the tree
    const hasContext = await setupZapContext(project);
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    const spiderId = await startSpider(targetUrl, hasContext ? `project-${project.id}` : null);
    if (dbScan) await dbScan.update({ zap_scan_id: `spider-${spiderId}` });
    
    // Spidering phase: 0% - 40%
    await waitForSpider(spiderId, (p) => onProgress && onProgress('spidering', Math.round(p * 0.4)), 3000, 300000, dbScan?.id);
    
    // Passive scan phase: 40% - 60%
    await waitForPassiveScan((p) => onProgress && onProgress('passive_scanning', 40 + Math.round(p * 0.2)), 2000, dbScan?.id);
    
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    return getAlerts(targetUrl);
}

/**
 * Run a fuzzer scan (aggressive active scan)
 */
export async function runFuzzerScan(project, onProgress, dbScan = null) {
    const targetUrl = project.target_url;
    log(`[ZAP] Fuzzer scan starting for ${targetUrl}`);
    await newSession(`fuzzer-${Date.now()}`);
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    await accessUrl(targetUrl); // Prime the tree
    const hasContext = await setupZapContext(project);
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    const spiderId = await startSpider(targetUrl, hasContext ? `project-${project.id}` : null);
    if (dbScan) await dbScan.update({ zap_scan_id: `spider-${spiderId}` });
    
    // Spidering phase: 0% - 15%
    await waitForSpider(spiderId, (p) => onProgress && onProgress('spidering', Math.round(p * 0.15)), 3000, 300000, dbScan?.id);
    await verifySpiderResults(spiderId, targetUrl);
    
    // Passive scan phase: 15% - 25%
    await waitForPassiveScan((p) => onProgress && onProgress('passive_scanning', 15 + Math.round(p * 0.1)), 2000, dbScan?.id);
    
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    const activeScanId = await startActiveScan(targetUrl);
    if (dbScan) await dbScan.update({ zap_scan_id: `active-${activeScanId}` });
    
    // Active scan phase: 25% - 65%
    await waitForActiveScan(activeScanId, (p) => onProgress && onProgress('scanning', 25 + Math.round(p * 0.4)), 5000, 900000, dbScan?.id);
    
    if (dbScan && isAborted(dbScan.id)) throw new Error('Scan stopped by user');
    return getAlerts(targetUrl);
}

/**
 * Get current scan progress for status polling
 */
export async function getScanProgress(scanType, zapScanId) {
    try {
        if (scanType === 'spider') {
            return await getSpiderProgress(zapScanId);
        } else if (scanType === 'active' || scanType === 'fuzzer') {
            return await getActiveScanProgress(zapScanId);
        }
        return 0;
    } catch {
        return 0;
    }
}
