import { Router } from 'express';
import { Project, Scan, Vulnerability, GovernanceMetric } from '../models/index.js';
import { authenticateToken } from '../middleware/auth.js';
import { Op, fn, col, literal } from 'sequelize';

const router = Router();

/**
 * GET /api/security/dashboard/summary/:projectId
 * Get aggregated dashboard stats for a project
 */
router.get('/summary/:projectId', authenticateToken, async (req, res) => {
    try {
        const project = await Project.findOne({
            where: { id: req.params.projectId, owner_id: req.user.id },
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        // Get all completed scans
        const scans = await Scan.findAll({
            where: { project_id: project.id, status: 'completed' },
            order: [['completed_at', 'DESC']],
            include: [{
                model: GovernanceMetric,
                as: 'governance',
            }],
        });

        // Latest scan details
        const latestScan = scans[0] || null;
        let latestVulnerabilities = [];
        let riskDistribution = {};
        let owaspBreakdown = {};

        if (latestScan) {
            latestVulnerabilities = await Vulnerability.findAll({
                where: { scan_id: latestScan.id },
                order: [['risk_score', 'DESC']],
            });

            // Risk distribution
            riskDistribution = {
                critical: latestVulnerabilities.filter(v => v.risk === 'Critical').length,
                high: latestVulnerabilities.filter(v => v.risk === 'High').length,
                medium: latestVulnerabilities.filter(v => v.risk === 'Medium').length,
                low: latestVulnerabilities.filter(v => v.risk === 'Low').length,
                informational: latestVulnerabilities.filter(v => v.risk === 'Informational').length,
            };

            // OWASP breakdown
            for (const vuln of latestVulnerabilities) {
                const cat = vuln.owasp_category || 'Uncategorized';
                owaspBreakdown[cat] = (owaspBreakdown[cat] || 0) + 1;
            }
        }

        // Historical trend (last 10 scans)
        const trend = scans.slice(0, 10).map(s => ({
            scan_id: s.id,
            date: s.completed_at,
            scan_type: s.scan_type,
            total: s.governance?.total_count || 0,
            critical: s.governance?.critical_count || 0,
            high: s.governance?.high_count || 0,
            release_blocked: s.governance?.release_blocked || false,
            health_score: s.governance?.health_score || 0,
        })).reverse();

        // Top vulnerabilities (highest risk score)
        const topVulnerabilities = latestVulnerabilities
            .slice(0, 10)
            .map(v => ({
                id: v.id,
                name: v.alert_name,
                risk: v.risk,
                risk_score: v.risk_score,
                owasp_category: v.owasp_category,
                url: v.url,
                is_regression: v.is_regression,
                ai_summary: v.ai_summary,
            }));

        res.json({
            project: {
                id: project.id,
                name: project.name,
                target_url: project.target_url,
            },
            stats: {
                total_scans: scans.length,
                last_scan_date: latestScan?.completed_at || null,
                last_scan_type: latestScan?.scan_type || null,
                total_vulnerabilities: latestVulnerabilities.length,
                release_status: latestScan?.governance?.release_blocked ? 'BLOCKED' : 'APPROVED',
                critical_high_pct: latestScan?.governance?.critical_high_percentage || 0,
                avg_health_score: latestScan?.governance?.health_score || 0,
            },
            risk_distribution: riskDistribution,
            owasp_breakdown: owaspBreakdown,
            trend,
            top_vulnerabilities: topVulnerabilities,
            executive_summary: latestScan?.governance?.executive_summary || null,
        });
    } catch (err) {
        console.error('[Dashboard] Summary error:', err);
        res.status(500).json({ error: 'Failed to get dashboard summary.' });
    }
});

export default router;
