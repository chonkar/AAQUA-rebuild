import { URL } from 'url';
import dns from 'dns';
import { promisify } from 'util';

const dnsResolve = promisify(dns.resolve4);

// Private/internal IP ranges that should be blocked (SSRF prevention)
const BLOCKED_IP_PATTERNS = [
    /^127\./,                 // Loopback
    /^10\./,                  // Private Class A
    /^172\.(1[6-9]|2\d|3[01])\./, // Private Class B
    /^192\.168\./,            // Private Class C
    /^169\.254\./,            // Link-local
    /^0\./,                   // Current network
    /^fc00:/i,                // IPv6 unique local
    /^fe80:/i,                // IPv6 link-local
    /^::1$/,                  // IPv6 loopback
    /^localhost$/i,
];

/**
 * Check if a hostname resolves to a private/internal IP
 */
async function isPrivateHost(hostname) {
    // Direct IP check
    for (const pattern of BLOCKED_IP_PATTERNS) {
        if (pattern.test(hostname)) return true;
    }

    // DNS resolution check
    try {
        const addresses = await dnsResolve(hostname);
        for (const addr of addresses) {
            for (const pattern of BLOCKED_IP_PATTERNS) {
                if (pattern.test(addr)) return true;
            }
        }
    } catch {
        // DNS resolution failed — allow (ZAP will handle unreachable targets)
    }

    return false;
}

/**
 * Express middleware: validate scan target URL
 * Blocks: private IPs, file:// URIs, non-HTTP schemes, SSRF attempts
 */
export async function validateTargetUrl(req, res, next) {
    const targetUrl = req.body.target_url || req.body.targetUrl;

    if (!targetUrl) {
        return res.status(400).json({ error: 'target_url is required.' });
    }

    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch {
        return res.status(400).json({ error: 'Invalid URL format.' });
    }

    // Only allow http and https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are allowed.' });
    }

    // Block internal/private hosts (if not explicitly allowed)
    const isPrivate = await isPrivateHost(parsed.hostname);
    if (isPrivate && process.env.ALLOW_PRIVATE_SCAN !== 'true') {
        return res.status(400).json({
            error: 'Scanning internal/private network addresses is not allowed (SSRF protection). System administrators can bypass this by setting ALLOW_PRIVATE_SCAN=true.',
        });
    }

    // Normalize and store
    req.validatedUrl = parsed.href;
    next();
}

/**
 * Validate OpenAPI spec URL for API scans
 */
export async function validateOpenApiUrl(req, res, next) {
    const specUrl = req.body.openapi_url || req.body.openapiUrl;

    if (!specUrl) {
        return res.status(400).json({ error: 'openapi_url is required for API scans.' });
    }

    let parsed;
    try {
        parsed = new URL(specUrl);
    } catch {
        return res.status(400).json({ error: 'Invalid OpenAPI spec URL.' });
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are allowed for OpenAPI specs.' });
    }

    // Block internal/private hosts (if not explicitly allowed)
    const isPrivate = await isPrivateHost(parsed.hostname);
    if (isPrivate && process.env.ALLOW_PRIVATE_SCAN !== 'true') {
        return res.status(400).json({
            error: 'Scanning internal/private network addresses is not allowed (SSRF protection). System administrators can bypass this by setting ALLOW_PRIVATE_SCAN=true.',
        });
    }

    req.validatedOpenApiUrl = parsed.href;
    next();
}
