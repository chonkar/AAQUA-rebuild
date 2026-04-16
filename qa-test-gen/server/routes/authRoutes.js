import { Router } from 'express';
import { User } from '../models/index.js';
import { hashPassword, comparePassword, generateToken } from '../middleware/auth.js';
import { authRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

/**
 * POST /api/security/auth/register
 * Create a new user account
 */
router.post('/register', authRateLimiter, async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'email, password, and name are required.' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        // Check if user already exists
        const existing = await User.findOne({ where: { email } });
        if (existing) {
            return res.status(409).json({ error: 'Email already registered.' });
        }

        const hashed = await hashPassword(password);
        const user = await User.create({ email, password: hashed, name });

        const token = generateToken(user);

        res.status(201).json({
            message: 'User registered successfully.',
            user: { id: user.id, email: user.email, name: user.name, role: user.role },
            token,
        });
    } catch (err) {
        console.error('[Auth] Register error:', err);
        res.status(500).json({ error: 'Registration failed.' });
    }
});

/**
 * POST /api/security/auth/login
 * Authenticate and return JWT
 */
router.post('/login', authRateLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'email and password are required.' });
        }

        const user = await User.findOne({ where: { email } });
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const valid = await comparePassword(password, user.password);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const token = generateToken(user);

        res.json({
            message: 'Login successful.',
            user: { id: user.id, email: user.email, name: user.name, role: user.role },
            token,
        });
    } catch (err) {
        console.error('[Auth] Login error:', err);
        res.status(500).json({ error: 'Login failed.' });
    }
});

export default router;
