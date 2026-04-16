import rateLimit from 'express-rate-limit';

/**
 * Rate limiter for security API endpoints
 * 100 requests per minute per IP
 */
export const securityRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too many requests. Please try again later.',
        retryAfter: '60 seconds',
    },
});

/**
 * Stricter rate limiter for auth endpoints
 * 10 requests per minute per IP (prevents brute force)
 */
export const authRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too many login attempts. Please try again later.',
        retryAfter: '60 seconds',
    },
});
