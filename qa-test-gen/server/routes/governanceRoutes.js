import { Router } from 'express';
import { Scan, GovernanceMetric, Vulnerability, Project } from '../models/index.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { getGovernanceTrend } from '../services/governanceService.js';

const router = Router();

/**
 * GET /api/security/governance/release-check/:scanId
 * Check if a scan passes the release gate
 */
router.get('/release-check/:scanId', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const scan = await Scan.findByPk(req.params.scanId, {
            include: [
                { model: GovernanceMetric, as: 'governance' },
                { model: Project, as: 'project' },
            ],
        });

        if (!scan) {
            return res.status(404).json({ error: 'Scan not found.' });
        }

        if (scan.status !== 'completed') {
            return res.status(400).json({
                error: 'Scan is not completed yet.',
                status: scan.status,
            });
        }

        const governance = scan.governance;
        if (!governance) {
            return res.status(404).json({ error: 'Governance data not available for this scan.' });
        }

        // Get regression details
        const regressions = await Vulnerability.findAll({
            where: { scan_id: scan.id, is_regression: true },
            attributes: ['id', 'alert_name', 'risk', 'url', 'owasp_category'],
        });

        res.json({
            scan_id: scan.id,
            project: scan.project?.name || 'Unknown',
            release_decision: governance.release_blocked ? 'BLOCKED' : 'APPROVED',
            release_blocked: governance.release_blocked,
            metrics: {
                total_vulnerabilities: governance.total_count,
                critical: governance.critical_count,
                high: governance.high_count,
                medium: governance.medium_count,
                low: governance.low_count,
                informational: governance.info_count,
                critical_high_percentage: governance.critical_high_percentage,
                threshold: 30,
                regressions: governance.reopened_count,
                health_score: governance.health_score,
            },
            regressions: regressions.map(r => ({
                name: r.alert_name,
                risk: r.risk,
                url: r.url,
                owasp_category: r.owasp_category,
            })),
            executive_summary: governance.executive_summary,
        });
    } catch (err) {
        console.error('[Governance] Release check error:', err);
        res.status(500).json({ error: 'Failed to perform release check.' });
    }
});

/**
 * GET /api/security/governance/trend/:projectId
 * Get historical governance trend for a project
 */
router.get('/trend/:projectId', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const project = await Project.findOne({
            where: { id: req.params.projectId, owner_id: req.user.id },
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        const trend = await getGovernanceTrend(project.id);

        res.json({
            project: { id: project.id, name: project.name },
            trend,
        });
    } catch (err) {
        console.error('[Governance] Trend error:', err);
        res.status(500).json({ error: 'Failed to get governance trend.' });
    }
});

export default router;
