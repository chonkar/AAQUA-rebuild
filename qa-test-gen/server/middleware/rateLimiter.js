import rateLimit from 'express-rate-limit';

/**
 * Rate limiter for security API endpoints — 100 requests per minute per IP.
 * Login/registration are no longer rate-limited here because Keycloak owns
 * the credential surface; brute-force protection is configured per-realm.
 */
export const securityRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too many requests. Please try again later.',
        retryAfter: '60 seconds',
    },
});
