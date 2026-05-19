import { Vulnerability, GovernanceMetric, Scan } from '../models/index.js';
import { Op } from 'sequelize';

/**
 * Calculate governance metrics for a completed scan
 * And determine if release should be blocked
 *
 * @param {string} scanId - The scan ID to evaluate
 * @returns {Object} GovernanceMetric record
 */
export async function calculateGovernanceMetrics(scanId) {
    const vulnerabilities = await Vulnerability.findAll({ where: { scan_id: scanId } });

    const counts = {
        critical: 0, high: 0, medium: 0, low: 0, info: 0, total: vulnerabilities.length,
    };

    for (const vuln of vulnerabilities) {
        switch (vuln.risk) {
            case 'Critical': counts.critical++; break;
            case 'High': counts.high++; break;
            case 'Medium': counts.medium++; break;
            case 'Low': counts.low++; break;
            default: counts.info++; break;
        }
    }

    // Calculate overall health score (0-10 scale)
    // Formula: 10 - weighted deductions
    let deductions = (counts.critical * 3.0) + (counts.high * 1.5) + (counts.medium * 0.5) + (counts.low * 0.1) + (counts.info * 0.05);
    // Cap deductions at 10, ensure non-negative
    const healthScore = Math.max(0, Math.min(10, 10 - deductions));

    // Release gate: block if:
    // 1. Any Critical vulnerability is detected (critical > 0)
    // 2. More than 2 High-severity vulnerabilities are found (high > 2)
    // 3. Overall health score is poor (healthScore < 6.0)
    // 4. Critical+High issues exceed 30% of total
    const critHighPct = counts.total > 0
        ? ((counts.critical + counts.high) / counts.total) * 100
        : 0;
    const releaseBlocked = counts.critical > 0 || counts.high > 2 || healthScore < 6.0 || critHighPct > 30;

    // Count regressions
    const regressionCount = vulnerabilities.filter(v => v.is_regression).length;

    // Generate executive summary
    const executiveSummary = generateExecutiveSummary(counts, healthScore, releaseBlocked, regressionCount, critHighPct);

    // Persist
    const [metric] = await GovernanceMetric.upsert({
        scan_id: scanId,
        critical_count: counts.critical,
        high_count: counts.high,
        medium_count: counts.medium,
        low_count: counts.low,
        info_count: counts.info,
        total_count: counts.total,
        critical_high_percentage: Math.round(critHighPct * 100) / 100,
        release_blocked: releaseBlocked,
        reopened_count: regressionCount,
        executive_summary: executiveSummary,
        health_score: Math.round(healthScore * 10) / 10, // Store rounded to 1 decimal
    });

    return metric;
}

/**
 * Generate a plain-language executive summary
 */
function generateExecutiveSummary(counts, healthScore, releaseBlocked, regressionCount, critHighPct) {
    const parts = [];

    parts.push(`Security scan identified ${counts.total} vulnerabilities across the target application.`);
    parts.push(`Breakdown: ${counts.critical} Critical, ${counts.high} High, ${counts.medium} Medium, ${counts.low} Low, ${counts.info} Informational.`);
    parts.push(`Overall security health score: ${healthScore.toFixed(1)}/10.`);

    if (regressionCount > 0) {
        parts.push(`⚠️ ${regressionCount} vulnerability(ies) have been flagged as regressions — previously resolved issues that have reappeared.`);
    }

    if (releaseBlocked) {
        parts.push(`🚫 RELEASE BLOCKED due to security policy violations:`);
        if (counts.critical > 0) {
            parts.push(`  - CRITICAL vulnerability detected (Count: ${counts.critical}, Policy Gate Limit: 0).`);
        }
        if (counts.high > 2) {
            parts.push(`  - High-severity vulnerability count exceeds threshold (Count: ${counts.high}, Policy Gate Limit: 2).`);
        }
        if (healthScore < 6.0) {
            parts.push(`  - Overall security health score is critically low (Score: ${healthScore.toFixed(1)}/10, Policy Gate Limit: 6.0/10).`);
        }
        if (critHighPct > 30) {
            parts.push(`  - Critical+High severity concentration is too high (Percentage: ${critHighPct.toFixed(1)}%, Policy Gate Limit: 30.0%).`);
        }
        parts.push(`These issues must be resolved before this application version can be approved for release.`);
    } else {
        parts.push(`✅ RELEASE APPROVED: The application meets all defined security governance thresholds.`);
    }

    return parts.join('\n');
}

/**
 * Check for regressions by comparing current scan results against previous scans
 * @param {string} projectId - The project to check
 * @param {Array} currentVulns - Current scan's vulnerabilities
 * @returns {Array} Updated vulnerabilities with regression flags
 */
export async function checkForRegressions(projectId, currentVulns) {
    // Get the previous completed scan's vulnerabilities
    const previousScan = await Scan.findOne({
        where: {
            project_id: projectId,
            status: 'completed',
        },
        order: [['completed_at', 'DESC']],
        offset: 1, // Skip the current scan (most recent)
    });

    if (!previousScan) return currentVulns; // First scan, no regressions possible

    const previousVulns = await Vulnerability.findAll({
        where: { scan_id: previousScan.id },
    });

    // Mark regressions: same alert_name + url found in previous scan
    return currentVulns.map(vuln => {
        const wasFound = previousVulns.some(prev =>
            prev.alert_name === vuln.alert_name &&
            prev.url === vuln.url
        );
        return { ...vuln, is_regression: wasFound };
    });
}

/**
 * Get historical governance trends for a project
 * @param {string} projectId
 * @returns {Array} Historical metrics
 */
export async function getGovernanceTrend(projectId) {
    const scans = await Scan.findAll({
        where: { project_id: projectId, status: 'completed' },
        order: [['completed_at', 'ASC']],
        include: [{ model: GovernanceMetric, as: 'governance' }],
    });

    return scans
        .filter(s => s.governance)
        .map(s => ({
            scan_id: s.id,
            date: s.completed_at,
            scan_type: s.scan_type,
            total: s.governance.total_count,
            critical: s.governance.critical_count,
            high: s.governance.high_count,
            medium: s.governance.medium_count,
            low: s.governance.low_count,
            critical_high_pct: s.governance.critical_high_percentage,
            release_blocked: s.governance.release_blocked,
        }));
}
