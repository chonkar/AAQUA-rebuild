import { Router } from 'express';
import { Project, Scan, GovernanceMetric } from '../models/index.js';
import { authenticateToken } from '../middleware/auth.js';
import { validateTargetUrl } from '../middleware/urlValidator.js';

const router = Router();

/**
 * POST /api/security/projects
 * Create a new security project
 */
router.post('/', authenticateToken, validateTargetUrl, async (req, res) => {
    try {
        const { name, target_url, description, auth_username, auth_password, login_url } = req.body;

        if (!name || !target_url) {
            return res.status(400).json({ error: 'name and target_url are required.' });
        }

        const project = await Project.create({
            name,
            target_url,
            description: description || null,
            auth_username: auth_username || null,
            auth_password: auth_password || null,
            login_url: login_url || null,
            owner_id: req.user.id,
        });

        res.status(201).json({
            message: 'Project created.',
            project,
        });
    } catch (err) {
        console.error('[Projects] Create error:', err);
        res.status(500).json({ error: 'Failed to create project.' });
    }
});

/**
 * GET /api/security/projects
 * List user's projects with latest scan info
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const projects = await Project.findAll({
            where: { owner_id: req.user.id },
            order: [['created_at', 'DESC']],
            include: [{
                model: Scan,
                as: 'scans',
                attributes: ['id', 'scan_type', 'status', 'completed_at', 'created_at'],
                order: [['created_at', 'DESC']],
                limit: 1,
                separate: true,
            }],
        });

        res.json({ projects });
    } catch (err) {
        console.error('[Projects] List error:', err);
        res.status(500).json({ error: 'Failed to list projects.' });
    }
});

/**
 * GET /api/security/projects/:id
 * Get project details with scan history
 */
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const project = await Project.findOne({
            where: { id: req.params.id, owner_id: req.user.id },
            include: [{
                model: Scan,
                as: 'scans',
                attributes: ['id', 'scan_type', 'status', 'started_at', 'completed_at', 'progress'],
                order: [['created_at', 'DESC']],
                limit: 30,
                separate: true,
                include: [{
                    model: GovernanceMetric,
                    as: 'governance',
                    attributes: ['total_count', 'critical_count', 'high_count', 'release_blocked'],
                }],
            }],
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        res.json({ project });
    } catch (err) {
        console.error('[Projects] Get error:', err);
        res.status(500).json({ error: 'Failed to get project.' });
    }
});

/**
 * DELETE /api/security/projects/:id
 * Delete a project and all associated data
 */
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const project = await Project.findOne({
            where: { id: req.params.id, owner_id: req.user.id },
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        await project.destroy();
        res.json({ message: 'Project deleted.' });
    } catch (err) {
        console.error('[Projects] Delete error:', err);
        res.status(500).json({ error: 'Failed to delete project.' });
    }
});

export default router;
