import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'aaqua-secure-engine-default-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const SALT_ROUNDS = 12;

/**
 * Hash a plaintext password
 */
export async function hashPassword(plaintext) {
    return bcrypt.hash(plaintext, SALT_ROUNDS);
}

/**
 * Compare plaintext against hashed password
 */
export async function comparePassword(plaintext, hash) {
    return bcrypt.compare(plaintext, hash);
}

/**
 * Generate a JWT token for a user
 */
export function generateToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET);
}

/**
 * Express middleware: authenticate JWT from Authorization header
 * Sets req.user = { id, email, role }
 */
export function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;

    if (!token) {
        return res.status(401).json({ error: 'Authentication required. Provide Bearer token.' });
    }

    try {
        req.user = verifyToken(token);
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired. Please login again.' });
        }
        return res.status(403).json({ error: 'Invalid token.' });
    }
}

/**
 * Express middleware: require specific role(s)
 */
export function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required.' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
        }
        next();
    };
}
