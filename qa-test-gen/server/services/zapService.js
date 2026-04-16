import dotenv from 'dotenv';
dotenv.config();

const ZAP_API_URL = process.env.ZAP_API_URL || 'http://localhost:8080';
const ZAP_API_KEY = process.env.ZAP_API_KEY || '';

/**
 * Make a request to the ZAP REST API
 */
async function zapRequest(endpoint, params = {}) {
    const url = new URL(endpoint, ZAP_API_URL);
    if (ZAP_API_KEY) params.apikey = ZAP_API_KEY;
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const response = await fetch(url.toString());
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`ZAP API error [${response.status}]: ${text}`);
    }
    return response.json();
}

// ─── Spider ──────────────────────────────────────────────

/**
 * Start ZAP spider to crawl the target URL
 * @returns {string} Spider scan ID
 */
export async function startSpider(targetUrl) {
    const data = await zapRequest('/JSON/spider/action/scan/', {
        url: targetUrl,
        maxChildren: '10',
        recurse: 'true',
        subtreeOnly: 'true',
    });
    console.log(`[ZAP] Spider started: ID=${data.scan}`);
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
export async function waitForSpider(scanId, onProgress, pollInterval = 3000, timeoutMs = 300000) {
    const start = Date.now();
    let progress = 0;
    while (progress < 100) {
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

// ─── Passive Scan (Baseline) ─────────────────────────────

/**
 * Wait for passive scan to finish (ZAP runs passive scanning automatically)
 */
export async function waitForPassiveScan(pollInterval = 2000) {
    let remaining = -1;
    while (remaining !== 0) {
        await new Promise(r => setTimeout(r, pollInterval));
        const data = await zapRequest('/JSON/pscan/view/recordsToScan/');
        remaining = parseInt(data.recordsToScan, 10);
        if (remaining > 0) console.log(`[ZAP] Passive scan: ${remaining} records remaining`);
    }
    console.log('[ZAP] Passive scan completed.');
}

// ─── Active Scan ─────────────────────────────────────────

/**
 * Start an active scan against the target
 * @returns {string} Active scan ID
 */
export async function startActiveScan(targetUrl) {
    const data = await zapRequest('/JSON/ascan/action/scan/', {
        url: targetUrl,
        recurse: 'true',
        inScopeOnly: 'false',
    });
    console.log(`[ZAP] Active scan started: ID=${data.scan}`);
    return data.scan;
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
export async function waitForActiveScan(scanId, onProgress, pollInterval = 5000, timeoutMs = 900000) {
    const start = Date.now();
    let progress = 0;
    while (progress < 100) {
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
    const data = await zapRequest('/JSON/alert/view/alerts/', {
        baseurl: baseUrl,
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
        const contextId = ctxData.context.id;

        // 2. Include the target URL in the context
        await zapRequest('/JSON/context/action/includeInContext/', { contextName, regex: `${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*` });

        // 3. Set Auth Method (Form-based)
        // We assume common parameter names: username and password. 
        // In a more advanced version, we could let the user configure these.
        const loginParams = `username={%username%}&password={%password%}`;
        await zapRequest('/JSON/authentication/action/setAuthenticationMethod/', {
            contextId,
            authMethodName: 'formBasedAuthentication',
            authMethodConfigParams: `loginUrl=${encodeURIComponent(project.login_url)}&loginRequestData=${encodeURIComponent(loginParams)}`
        });

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

/**
 * Run a complete baseline scan (spider → passive scan → get alerts)
 */
export async function runBaselineScan(project, onProgress) {
    const targetUrl = project.target_url;
    await newSession(`baseline-${Date.now()}`);
    await setupZapContext(project);
    const spiderId = await startSpider(targetUrl);
    await waitForSpider(spiderId, (p) => onProgress && onProgress('spidering', p));
    await waitForPassiveScan();
    return getAlerts(targetUrl);
}

/**
 * Run a complete active scan (spider → passive → active → get alerts)
 */
export async function runFullActiveScan(project, onProgress) {
    const targetUrl = project.target_url;
    await newSession(`active-${Date.now()}`);
    await setupZapContext(project);
    const spiderId = await startSpider(targetUrl);
    await waitForSpider(spiderId, (p) => onProgress && onProgress('spidering', p * 0.3));
    await waitForPassiveScan();
    const activeScanId = await startActiveScan(targetUrl);
    await waitForActiveScan(activeScanId, (p) => onProgress && onProgress('scanning', 30 + p * 0.7));
    return getAlerts(targetUrl);
}

/**
 * Run an API scan (import OpenAPI spec → spider → active scan → get alerts)
 */
export async function runApiScan(specUrl, project, onProgress) {
    const targetUrl = project?.target_url;
    await newSession(`api-${Date.now()}`);
    if (project) await setupZapContext(project);
    await importOpenApiSpec(specUrl, targetUrl);
    if (targetUrl) {
        const spiderId = await startSpider(targetUrl);
        await waitForSpider(spiderId, (p) => onProgress && onProgress('spidering', p * 0.3));
    }
    await waitForPassiveScan();
    if (targetUrl) {
        const activeScanId = await startActiveScan(targetUrl);
        await waitForActiveScan(activeScanId, (p) => onProgress && onProgress('scanning', 30 + p * 0.7));
    }
    return getAlerts(targetUrl || specUrl);
}

/**
 * Run a passive scan only (spider → wait for passive scan → get alerts)
 */
export async function runPassiveScan(project, onProgress) {
    const targetUrl = project.target_url;
    await newSession(`passive-${Date.now()}`);
    await setupZapContext(project);
    const spiderId = await startSpider(targetUrl);
    await waitForSpider(spiderId, (p) => onProgress && onProgress('spidering', p));
    await waitForPassiveScan();
    return getAlerts(targetUrl);
}

/**
 * Run a fuzzer scan (aggressive active scan)
 */
export async function runFuzzerScan(project, onProgress) {
    const targetUrl = project.target_url;
    await newSession(`fuzzer-${Date.now()}`);
    await setupZapContext(project);
    const spiderId = await startSpider(targetUrl);
    await waitForSpider(spiderId, (p) => onProgress && onProgress('spidering', p * 0.2));
    await waitForPassiveScan();

    const activeScanId = await startActiveScan(targetUrl);
    await waitForActiveScan(activeScanId, (p) => onProgress && onProgress('scanning', 20 + p * 0.8));
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
