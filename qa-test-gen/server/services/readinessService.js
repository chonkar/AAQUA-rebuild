import {
    AutomationResult,
    AccessibilityResult,
    LocalizationResult,
    PerformanceResult,
    ReleaseReadiness,
    Scan,
    GovernanceMetric,
    Project
} from '../models/index.js';

// ─── Enterprise readiness policy ─────────────────────────────────────────
// Weights are renormalized across only the dimensions that have been
// scanned, so partial coverage doesn't artificially deflate the score.
// Security carries the highest weight because Critical/High findings
// represent breach, compliance, and brand exposure that no amount of
// passing tests in other dimensions can offset.
const DIMENSION_WEIGHTS = {
    Security: 0.30,
    Automation: 0.25,
    Accessibility: 0.15,
    Localization: 0.15,
    Performance: 0.15,
};

// Hard gates: when any of these conditions are true the release MUST be
// blocked regardless of the weighted score. This honours the policy the
// security engine already enforces in governanceService.calculateGovernanceMetrics
// and extends the same logic to the other quality dimensions.
const HARD_GATE_THRESHOLDS = {
    automationPassRate: 70,
    accessibilityScore: 50,
    localizationScore: 50,
    performanceScore: 50,
};

const BLOCKED_CONFIDENCE_CAP = 25; // Confidence ceiling when any hard gate fires.

/**
 * Fetch the latest source row for each quality dimension. Returned objects
 * are raw Sequelize instances so callers can read any persisted column
 * without going through the (intentionally lossy) ReleaseReadiness snapshot.
 *
 * Returns null for any dimension that has never been scanned.
 */
export async function fetchLatestSources(projectId) {
    const [automation, accessibility, localization, performance, scan] = await Promise.all([
        AutomationResult.findOne({
            where: { project_id: projectId },
            order: [['execution_date', 'DESC']],
        }),
        AccessibilityResult.findOne({
            where: { project_id: projectId },
            order: [['execution_date', 'DESC']],
        }),
        LocalizationResult.findOne({
            where: { project_id: projectId },
            order: [['execution_date', 'DESC']],
        }),
        PerformanceResult.findOne({
            where: { project_id: projectId },
            order: [['execution_date', 'DESC']],
        }),
        Scan.findOne({
            where: { project_id: projectId, status: 'completed' },
            order: [['completed_at', 'DESC']],
            include: [{ model: GovernanceMetric, as: 'governance' }],
        }),
    ]);
    return { automation, accessibility, localization, performance, scan };
}

/**
 * Calculate the dynamic quality score across active dimensions.
 *
 * Two-tier policy:
 *  1. HARD GATES — any single failure (security release_blocked, automation
 *     pass_rate < 70, a11y score < 50, loc score < 50) forces production_risk
 *     = 'High' and caps release_confidence at BLOCKED_CONFIDENCE_CAP. This
 *     prevents strong scores in other dimensions from masking a deal-breaker.
 *  2. WEIGHTED AVERAGE — when no hard gate fires, the score is a weighted
 *     average across active dimensions (weights renormalized to sum to 1).
 *     Dimensions that haven't been scanned do not contribute and do not drag
 *     the score down.
 */
export async function calculateAndSaveReadiness(projectId, releaseVersion = 'v1.0.0') {
    // 1. Fetch latest results for each quality dimension
    const {
        automation: latestAutomation,
        accessibility: latestAccessibility,
        localization: latestLocalization,
        performance: latestPerformance,
        scan: latestScan,
    } = await fetchLatestSources(projectId);

    let automationHealth = null;
    let accessibilityHealth = null;
    let localizationHealth = null;
    let performanceHealth = null;
    let securityHealth = null;

    const activeDimensions = [];
    const blockingReasons = [];

    // Map Automation
    if (latestAutomation) {
        automationHealth = parseFloat(latestAutomation.pass_rate);
        activeDimensions.push({ name: 'Automation', score: automationHealth });
        if (automationHealth < HARD_GATE_THRESHOLDS.automationPassRate) {
            blockingReasons.push(
                `Automation pass rate ${automationHealth.toFixed(1)}% is below the ${HARD_GATE_THRESHOLDS.automationPassRate}% gate (${latestAutomation.failed_tests}/${latestAutomation.total_tests} tests failed).`
            );
        }
    }

    // Map Accessibility
    if (latestAccessibility) {
        accessibilityHealth = parseFloat(latestAccessibility.accessibility_score);
        activeDimensions.push({ name: 'Accessibility', score: accessibilityHealth });
        if (accessibilityHealth < HARD_GATE_THRESHOLDS.accessibilityScore) {
            blockingReasons.push(
                `Accessibility score ${accessibilityHealth.toFixed(1)} is below the ${HARD_GATE_THRESHOLDS.accessibilityScore} gate (WCAG/legal risk).`
            );
        }
    }

    // Map Localization
    if (latestLocalization) {
        localizationHealth = parseFloat(latestLocalization.localization_score);
        activeDimensions.push({ name: 'Localization', score: localizationHealth });
        if (localizationHealth < HARD_GATE_THRESHOLDS.localizationScore) {
            blockingReasons.push(
                `Localization score ${localizationHealth.toFixed(1)} is below the ${HARD_GATE_THRESHOLDS.localizationScore} gate (broken translations or overflow issues).`
            );
        }
    }

    // Map Performance (Lighthouse score 0–100)
    if (latestPerformance) {
        performanceHealth = parseFloat(latestPerformance.performance_score);
        activeDimensions.push({ name: 'Performance', score: performanceHealth });
        if (performanceHealth < HARD_GATE_THRESHOLDS.performanceScore) {
            blockingReasons.push(
                `Performance score ${performanceHealth.toFixed(1)} is below the ${HARD_GATE_THRESHOLDS.performanceScore} gate (slow page / poor Core Web Vitals).`
            );
        }
    }

    // Map Security from ZAP Scan Governance.
    // We honour governance.release_blocked as the authoritative security signal —
    // it already encodes Critical>0, High>2, health<6, and Crit+High concentration >30%.
    if (latestScan && latestScan.governance) {
        const gov = latestScan.governance;
        if (gov.critical_count > 0) {
            securityHealth = 0;
        } else {
            securityHealth = Math.max(
                0,
                100 - (gov.high_count * 20 + Math.max(0, gov.total_count - gov.high_count) * 2)
            );
        }
        activeDimensions.push({ name: 'Security', score: securityHealth });
        if (gov.release_blocked) {
            const detail = [
                gov.critical_count > 0 ? `${gov.critical_count} Critical` : null,
                gov.high_count > 2 ? `${gov.high_count} High` : null,
                `health ${Number(gov.health_score).toFixed(1)}/10`,
            ].filter(Boolean).join(', ');
            blockingReasons.push(`Security scan is BLOCKED by governance policy (${detail}).`);
        }
    }

    // 2. Compute weighted score and apply hard gates.
    let overallQualityScore = 0;
    let releaseConfidence = 0;
    let productionRisk = 'Not Scanned';
    let aiSummary = '';
    let deploymentRecommendation = '';

    if (activeDimensions.length > 0) {
        // Renormalize weights across only the active dimensions.
        const activeWeightSum = activeDimensions.reduce(
            (sum, dim) => sum + (DIMENSION_WEIGHTS[dim.name] || 0),
            0
        );
        const weightedScore = activeDimensions.reduce(
            (sum, dim) => sum + dim.score * ((DIMENSION_WEIGHTS[dim.name] || 0) / activeWeightSum),
            0
        );
        overallQualityScore = Math.round(weightedScore);

        // Coverage bonus rewards full-spectrum scanning (max +10 with all 4 dimensions).
        const coverageBonus = (activeDimensions.length / 4) * 10;
        releaseConfidence = Math.min(100, Math.round(overallQualityScore + coverageBonus));

        if (blockingReasons.length > 0) {
            // HARD GATE — overrides whatever the weighted score said.
            productionRisk = 'High';
            releaseConfidence = Math.min(releaseConfidence, BLOCKED_CONFIDENCE_CAP);
            aiSummary =
                `RELEASE BLOCKED by ${blockingReasons.length} hard gate failure(s):\n` +
                blockingReasons.map(r => `  • ${r}`).join('\n') +
                `\nWeighted quality score is ${overallQualityScore}/100, but enterprise policy requires ALL hard gates to pass before deployment.`;
            deploymentRecommendation =
                `🛑 RELEASE BLOCKED: Do not deploy to production. ` +
                `Resolve every failing gate listed in the executive summary, then re-run the affected scan(s) to recompute readiness.`;
        } else if (overallQualityScore >= 85) {
            productionRisk = 'Low';
            aiSummary = `All evaluated quality gates (${activeDimensions.map(d => d.name).join(', ')}) demonstrate outstanding compliance. Weighted quality score ${overallQualityScore}/100 with ${activeDimensions.length}/4 dimensions covered. No hard gates breached.`;
            deploymentRecommendation = `🚀 PROCEED TO DEPLOYMENT: Release confidence is at ${releaseConfidence}%. Quality thresholds are met across all evaluated dimensions.`;
        } else if (overallQualityScore >= 70) {
            productionRisk = 'Medium';
            const weakDims = activeDimensions.filter(d => d.score < 80).map(d => d.name);
            aiSummary = `Evaluated gates indicate moderate compliance (weighted score ${overallQualityScore}/100). Warning conditions detected in ${weakDims.join(', ') || 'no specific dimension'}. No hard gates breached, but deployment carries elevated risk.`;
            deploymentRecommendation = `⚠️ CAUTION DEPLOYMENT: Deploy to staging/canary first and monitor closely. Prioritise remediation tickets for ${weakDims.join(', ') || 'borderline dimensions'} in the next sprint.`;
        } else {
            productionRisk = 'High';
            const failedDims = activeDimensions.filter(d => d.score < 70).map(d => d.name);
            aiSummary = `Weighted quality score ${overallQualityScore}/100 is below the 70-point threshold for staging deployment. Concerning dimensions: ${failedDims.join(', ') || 'multiple'}. No single hard gate has fired, but the cumulative quality signal is insufficient.`;
            deploymentRecommendation = `🛑 RELEASE BLOCKED (low quality): Do not deploy. Address quality regressions in ${failedDims.join(', ') || 'the weakest dimensions'} before requesting re-evaluation.`;
        }
    } else {
        overallQualityScore = 0;
        releaseConfidence = 0;
        productionRisk = 'Not Scanned';
        aiSummary = 'No quality scans have been executed for this project yet. Please trigger an Automation, Security, Accessibility, or Localization scan to calculate your go-live readiness score.';
        deploymentRecommendation = '⏳ AWAITING SCAN RUNS: Complete at least one quality dimension scan to evaluate deployment feasibility.';
    }

    // 3. Save to database ReleaseReadiness profile
    const record = await ReleaseReadiness.create({
        project_id: projectId,
        release_version: releaseVersion,
        automation_health: automationHealth,
        security_health: securityHealth,
        accessibility_health: accessibilityHealth,
        localization_health: localizationHealth,
        performance_health: performanceHealth,
        overall_quality_score: overallQualityScore,
        release_confidence: releaseConfidence,
        production_risk: productionRisk,
        ai_summary: aiSummary,
        deployment_recommendation: deploymentRecommendation,
    });

    return record;
}

/**
 * Fetch the freshest Release Readiness Profile for a Project.
 *
 * Always recomputes from the latest source signals (AutomationResult,
 * AccessibilityResult, LocalizationResult, latest completed Scan) rather
 * than returning a possibly-stale snapshot. The cost is a handful of
 * SELECTs and arithmetic per page load, which is cheap and means readiness
 * never lies about the current state of the project — important when a
 * dimension has just transitioned (e.g. a security scan that flipped from
 * passing to BLOCKED would otherwise stay hidden until the next scan).
 */
export async function getLatestReadiness(projectId) {
    return calculateAndSaveReadiness(projectId);
}
