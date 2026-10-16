import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import dotenv from 'dotenv';
import UserActivity from '../models/UserActivity.js';
dotenv.config();

// Two URLs because they often need to differ in containerized deploys:
//   - KEYCLOAK_REALM_URL is what Keycloak puts in the `iss` claim (public URL,
//     e.g. https://aaqua.aaseya.com:8443/auth/realms/aaseya-platform). jwtVerify
//     uses this to validate the token's issuer with exact string equality.
//   - KEYCLOAK_JWKS_URL (optional) is the URL the backend uses to fetch the
//     JWKS. Inside docker-compose, the public hostname often isn't reachable
//     from the app container — use the docker service name instead, e.g.
//     http://shared-keycloak:8080/auth/realms/aaseya-platform/protocol/openid-connect/certs
//   - If KEYCLOAK_JWKS_URL is not set, we derive it from KEYCLOAK_REALM_URL
//     (the historical behavior — fine for local dev and any deploy where the
//     issuer URL is reachable from the backend).
const REALM_URL = process.env.KEYCLOAK_REALM_URL;
const AUDIENCE = process.env.KEYCLOAK_AUDIENCE;
const JWKS_URL = process.env.KEYCLOAK_JWKS_URL
    || (REALM_URL ? `${REALM_URL}/protocol/openid-connect/certs` : null);

if (!REALM_URL) {
    console.warn('[auth] KEYCLOAK_REALM_URL is not set — token verification will fail.');
}

// Singleton JWKS — `jose` caches keys and refreshes on rotation automatically.
const JWKS = JWKS_URL
    ? createRemoteJWKSet(new URL(JWKS_URL), {
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
    })
    : null;

/**
 * Raised for verification failures that carry their own HTTP semantics
 * (identity provider unconfigured, audience mismatch) so callers can map them
 * back to the exact status/message the middleware has always returned.
 */
export class AuthError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'AuthError';
        this.status = status;
    }
}

/**
 * Verify a Keycloak-issued JWT and return the user object, or throw.
 *
 * This is the transport-agnostic core of `authenticateToken` — extracted so
 * flows that cannot use an Authorization header can still verify a token
 * (e.g. the SSE endpoint at /api/events/:jobId, where the browser EventSource
 * API forces the token onto a query param).
 *
 * Throws `AuthError` for configuration/claim failures and the raw `jose`
 * errors (JWTExpired, JWTInvalid, ...) for signature/format failures, so
 * callers can distinguish expired-vs-invalid the same way the middleware does.
 *
 * @param {string} token Raw JWT (no "Bearer " prefix).
 * @returns {Promise<{id: string, email: string, name: string, username: string, roles: string[], raw: object}>}
 */
export async function verifyToken(token) {
    if (!JWKS) {
        throw new AuthError(503, 'Identity provider is not configured.');
    }

    const { payload } = await jwtVerify(token, JWKS, {
        issuer: REALM_URL,
    });

    // Audience check: Keycloak puts the client ID in `azp` and may include it in `aud`.
    // We accept either to handle both confidential-client and public-client tokens.
    if (AUDIENCE) {
        const aud = payload.aud;
        const audOk = aud === AUDIENCE
            || (Array.isArray(aud) && aud.includes(AUDIENCE))
            || payload.azp === AUDIENCE;
        if (!audOk) {
            throw new AuthError(403, 'Token audience mismatch.');
        }
    }

    return {
        id: payload.sub,
        email: payload.email,
        name: payload.name || payload.preferred_username,
        username: payload.preferred_username,
        roles: payload.realm_access?.roles ?? [],
        raw: payload,
    };
}

/**
 * Express middleware: verify a Keycloak-issued JWT from the Authorization header.
 * On success, sets req.user = { id (sub), email, name, roles, raw }.
 */
export async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;

    if (!token) {
        return res.status(401).json({ error: 'Authentication required. Provide Bearer token.' });
    }

    if (!JWKS) {
        return res.status(503).json({ error: 'Identity provider is not configured.' });
    }

    try {
        req.user = await verifyToken(token);

        // Log user activity asynchronously (Audit Trail)
        // Skip logging usage dashboard API requests to prevent logs clutter
        if (req.user.email && !req.originalUrl?.includes('/api/admin/usage') && !req.url?.includes('/api/admin/usage')) {
            UserActivity.create({
                user_id: req.user.id,
                email: req.user.email,
                username: req.user.username,
                name: req.user.name,
                action: `${req.method} ${req.originalUrl || req.url}`,
                ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
                details: {
                    userAgent: req.headers['user-agent'],
                }
            }).catch(err => {
                console.error('[auth] Failed to log user activity:', err.message);
            });
        }

        next();
    } catch (err) {
        if (err instanceof AuthError) {
            return res.status(err.status).json({ error: err.message });
        }
        if (err instanceof joseErrors.JWTExpired) {
            return res.status(401).json({ error: 'Token expired. Please login again.' });
        }
        if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JWSInvalid
            || err instanceof joseErrors.JWTClaimValidationFailed) {
            return res.status(403).json({ error: 'Invalid token.' });
        }
        console.error('[auth] Unexpected token verification error:', err);
        return res.status(403).json({ error: 'Invalid token.' });
    }
}

/**
 * Express middleware factory: require the user to hold at least one of the given realm roles.
 * Roles are read from the Keycloak `realm_access.roles` claim (now an array on req.user.roles).
 */
export function requireRole(...allowed) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required.' });
        }
        const has = allowed.some(r => req.user.roles.includes(r));
        if (!has) {
            return res.status(403).json({ error: `Requires role: ${allowed.join(' or ')}` });
        }
        next();
    };
}

/**
 * Express middleware factory: require the user's email to match the admin email.
 * Defaults to 'kavita.chonkar@aaseya.com', but can be overridden by ADMIN_EMAIL env var.
 */
export function requireAdminEmail() {
    const adminEmail = process.env.ADMIN_EMAIL || 'kavita.chonkar@aaseya.com';
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required.' });
        }
        if (req.user.email !== adminEmail) {
            return res.status(403).json({ error: 'Access denied. You do not have permission to access this resource.' });
        }
        next();
    };
}
