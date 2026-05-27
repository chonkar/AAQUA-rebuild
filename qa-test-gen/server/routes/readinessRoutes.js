import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import * as readinessService from '../services/readinessService.js';

const router = Router();

/**
 * GET /api/readiness/:projectId
 * Fetch the latest Release Readiness Profile for a project, plus the raw
 * source rows so the UI can render real per-dimension numbers (test counts,
 * vulnerability counts, etc.) instead of values derived from the aggregate
 * health score.
 */
router.get('/:projectId', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const [profile, sources] = await Promise.all([
            readinessService.getLatestReadiness(projectId),
            readinessService.fetchLatestSources(projectId),
        ]);

        const gov = sources.scan?.governance;
        res.json({
            profile,
            sources: {
                automation: sources.automation ? {
                    pass_rate: sources.automation.pass_rate,
                    failed_tests: sources.automation.failed_tests,
                    total_tests: sources.automation.total_tests,
                    duration: sources.automation.duration,
                    execution_date: sources.automation.execution_date,
                } : null,
                accessibility: sources.accessibility ? {
                    accessibility_score: sources.accessibility.accessibility_score,
                    wcag_compliance: sources.accessibility.wcag_compliance,
                    critical_violations: sources.accessibility.critical_violations,
                    serious_violations: sources.accessibility.serious_violations,
                    moderate_violations: sources.accessibility.moderate_violations,
                    minor_violations: sources.accessibility.minor_violations,
                    scanned_url: sources.accessibility.scanned_url,
                    execution_date: sources.accessibility.execution_date,
                } : null,
                localization: sources.localization ? {
                    localization_score: sources.localization.localization_score,
                    translation_accuracy: sources.localization.translation_accuracy,
                    missing_keys: sources.localization.missing_keys,
                    overflow_issues: sources.localization.overflow_issues,
                    scanned_url: sources.localization.scanned_url,
                    execution_date: sources.localization.execution_date,
                } : null,
                performance: sources.performance ? {
                    performance_score: sources.performance.performance_score,
                    lcp_ms: sources.performance.lcp_ms,
                    cls: sources.performance.cls,
                    tbt_ms: sources.performance.tbt_ms,
                    ttfb_ms: sources.performance.ttfb_ms,
                    scanned_url: sources.performance.scanned_url,
                    execution_date: sources.performance.execution_date,
                } : null,
                security: gov ? {
                    health_score: gov.health_score,
                    critical_count: gov.critical_count,
                    high_count: gov.high_count,
                    medium_count: gov.medium_count,
                    low_count: gov.low_count,
                    info_count: gov.info_count,
                    total_count: gov.total_count,
                    release_blocked: gov.release_blocked,
                    scan_type: sources.scan.scan_type,
                    completed_at: sources.scan.completed_at,
                } : null,
            },
        });
    } catch (err) {
        console.error('[Readiness Route] Fetch error:', err);
        res.status(500).json({ error: 'Failed to fetch release readiness profile.' });
    }
});

/**
 * POST /api/readiness/:projectId/calculate
 * Force compute a new Release Readiness Profile for a project
 */
router.post('/:projectId/calculate', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { releaseVersion } = req.body;
        const profile = await readinessService.calculateAndSaveReadiness(projectId, releaseVersion || 'v1.0.0');
        res.json({ message: 'Readiness profile calculated successfully.', profile });
    } catch (err) {
        console.error('[Readiness Route] Calculate error:', err);
        res.status(500).json({ error: 'Failed to calculate release readiness profile.' });
    }
});

export default router;
