import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import dotenv from 'dotenv';
dotenv.config();

const REALM_URL = process.env.KEYCLOAK_REALM_URL;
const AUDIENCE = process.env.KEYCLOAK_AUDIENCE;

if (!REALM_URL) {
    console.warn('[auth] KEYCLOAK_REALM_URL is not set — token verification will fail.');
}

// Singleton JWKS — `jose` caches keys and refreshes on rotation automatically.
const JWKS = REALM_URL
    ? createRemoteJWKSet(new URL(`${REALM_URL}/protocol/openid-connect/certs`), {
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
    })
    : null;

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
                return res.status(403).json({ error: 'Token audience mismatch.' });
            }
        }

        req.user = {
            id: payload.sub,
            email: payload.email,
            name: payload.name || payload.preferred_username,
            username: payload.preferred_username,
            roles: payload.realm_access?.roles ?? [],
            raw: payload,
        };
        next();
    } catch (err) {
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
