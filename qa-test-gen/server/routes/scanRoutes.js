import { Router } from 'express';
import { Scan, Vulnerability, Project, GovernanceMetric } from '../models/index.js';
import { authenticateToken } from '../middleware/auth.js';

import * as zapService from '../services/zapService.js';
import { analyzeVulnerabilities } from '../services/aiAnalysisService.js';
import { calculateGovernanceMetrics, checkForRegressions } from '../services/governanceService.js';
import { createTicketsForCriticalHigh } from '../services/jiraService.js';
import htmlDocx from 'html-docx-js';

const router = Router();

// Track active scans to prevent overload
const activeScans = new Set();
const MAX_CONCURRENT_SCANS = 2;

/**
 * POST /api/security/scan/start
 * Start a security scan (runs asynchronously)
 */
router.post('/start', authenticateToken, async (req, res) => {
    try {
        const { project_id, scan_type, target_url, openapi_url } = req.body;

        // Validation
        if (!project_id) {
            return res.status(400).json({ error: 'project_id is required.' });
        }
        if (!scan_type || !['baseline', 'active', 'api', 'passive', 'fuzzer'].includes(scan_type)) {
            return res.status(400).json({ error: 'scan_type must be one of: baseline, active, api, passive, fuzzer.' });
        }

        // Verify project exists and belongs to user
        const project = await Project.findOne({
            where: { id: project_id, owner_id: req.user.id },
        });
        if (!project) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        // Check concurrent scan limit
        if (activeScans.size >= MAX_CONCURRENT_SCANS) {
            return res.status(429).json({
                error: `Maximum ${MAX_CONCURRENT_SCANS} concurrent scans allowed. Please wait for an active scan to complete.`,
            });
        }

        // Determine target URL
        const scanTarget = target_url || project.target_url;

        // URL validation (SSRF check)
        const urlValidation = validateScanUrl(scanTarget);
        if (!urlValidation.valid) {
            return res.status(400).json({ error: urlValidation.error });
        }

        // Check ZAP health
        const zapHealth = await zapService.healthCheck();
        if (zapHealth.status !== 'ok') {
            return res.status(503).json({
                error: 'OWASP ZAP is not reachable. Please ensure ZAP is running.',
                details: zapHealth.error,
            });
        }

        // Create scan record
        const scan = await Scan.create({
            project_id,
            scan_type,
            status: 'queued',
            target_url: scanTarget,
            initiated_by: req.user.id,
            started_at: new Date(),
        });

        // Register active scan
        activeScans.add(scan.id);

        // Return immediately, run scan in background
        res.status(202).json({
            message: 'Scan queued successfully.',
            scan: {
                id: scan.id,
                scan_type: scan.scan_type,
                status: scan.status,
                target_url: scan.target_url,
            },
        });

        // ─── Background scan execution ───
        executeScan(scan, project, openapi_url).finally(() => {
            activeScans.delete(scan.id);
            zapService.abortedScans.delete(scan.id);
        });

    } catch (err) {
        console.error('[Scan] Start error:', err);
        res.status(500).json({ error: 'Failed to start scan.' });
    }
});

/**
 * Execute the scan in background
 */
async function executeScan(scan, project, openapiUrl) {
    try {
        console.log(`[Scan] Starting ${scan.scan_type} scan: ${scan.id}`);
        await scan.update({ status: 'spidering' });

        // Helper to update progress in DB
        const updateProgress = async (status, progress) => {
            console.log(`[Scan] Progress update: ${status} (${progress}%)`);
            // Check if aborted in-between to avoid database writes
            if (zapService.isAborted(scan.id)) {
                throw new Error('Scan stopped by user');
            }
            await scan.update({ status, progress });
        };

        // Phase 1: Run ZAP scan
        let alerts;
        switch (scan.scan_type) {
            case 'baseline':
                alerts = await zapService.runBaselineScan(project, updateProgress, scan);
                break;
            case 'passive':
                alerts = await zapService.runPassiveScan(project, updateProgress, scan);
                break;
            case 'active':
                alerts = await zapService.runFullActiveScan(project, updateProgress, scan);
                break;
            case 'fuzzer':
                alerts = await zapService.runFuzzerScan(project, updateProgress, scan);
                break;
            case 'api':
                if (!openapiUrl) throw new Error('openapi_url required for API scans');
                alerts = await zapService.runApiScan(openapiUrl, project, updateProgress, scan);
                break;
        }

        console.log(`[Scan] ZAP returned ${alerts.length} alerts`);
        await scan.update({ status: 'analyzing', progress: 60 });

        // Phase 2: AI analysis
        const enrichedVulns = await analyzeVulnerabilities(alerts);
        console.log(`[Scan] AI analysis completed for ${enrichedVulns.length} vulnerabilities`);

        // Phase 3: Check regressions
        const withRegressions = await checkForRegressions(project.id, enrichedVulns);

        // Phase 4: Persist vulnerabilities
        await scan.update({ progress: 80 });
        const savedVulns = [];
        for (const vuln of withRegressions) {
            const saved = await Vulnerability.create({
                scan_id: scan.id,
                ...vuln,
            });
            savedVulns.push(saved);
        }

        // Phase 5: Calculate governance metrics
        const governance = await calculateGovernanceMetrics(scan.id);
        console.log(`[Scan] Governance: ${governance.release_blocked ? '🚫 BLOCKED' : '✅ APPROVED'}`);

        // Phase 6: Jira tickets (optional)
        const tickets = await createTicketsForCriticalHigh(savedVulns, project.name);
        if (tickets.length > 0) {
            for (const ticket of tickets) {
                await Vulnerability.update(
                    { jira_ticket_key: ticket.jira_key },
                    { where: { id: ticket.vulnerability_id } }
                );
            }
        }

        // Mark complete
        await scan.update({
            status: 'completed',
            progress: 100,
            completed_at: new Date(),
        });

        console.log(`[Scan] ✅ Scan ${scan.id} completed. ${savedVulns.length} vulnerabilities found.`);

        // Enforce 30-scan retention limit per project
        await enforceScanRetention(project.id);

    } catch (err) {
        console.error(`[Scan] ❌ Scan ${scan.id} failed:`, err.message);
        await scan.update({
            status: 'failed',
            error_message: err.message,
            completed_at: new Date(),
        });
        
        // Enforce 30-scan retention limit per project
        try {
            await enforceScanRetention(project.id);
        } catch (retentionErr) {
            console.error('[Retention] Failed to enforce in catch block:', retentionErr);
        }
    }
}

/**
 * GET /api/security/scan/status/:scanId
 * Poll scan progress
 */
router.get('/status/:scanId', authenticateToken, async (req, res) => {
    try {
        const scan = await Scan.findByPk(req.params.scanId);
        if (!scan) {
            return res.status(404).json({ error: 'Scan not found.' });
        }

        res.json({
            id: scan.id,
            scan_type: scan.scan_type,
            status: scan.status,
            progress: scan.progress,
            target_url: scan.target_url,
            started_at: scan.started_at,
            completed_at: scan.completed_at,
            error_message: scan.error_message,
        });
    } catch (err) {
        console.error('[Scan] Status error:', err);
        res.status(500).json({ error: 'Failed to get scan status.' });
    }
});

/**
 * POST /api/security/scan/stop/:scanId
 * Stop an ongoing security scan
 */
router.post('/stop/:scanId', authenticateToken, async (req, res) => {
    try {
        const scan = await Scan.findByPk(req.params.scanId, {
            include: [{ model: Project, as: 'project' }],
        });

        if (!scan) {
            return res.status(404).json({ error: 'Scan not found.' });
        }

        // Verify project ownership
        if (scan.project.owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied.' });
        }

        // Check if the scan is already finished
        if (['completed', 'failed'].includes(scan.status)) {
            return res.status(400).json({ error: `Cannot stop scan as it is already in ${scan.status} state.` });
        }

        console.log(`[Scan] User requested stop scan for scan ID: ${scan.id}. Current ZAP Scan ID: ${scan.zap_scan_id}`);

        // Register abortion in zapService
        zapService.abortScan(scan.id, scan.status, scan.zap_scan_id);

        // Update scan status immediately to failed in the database
        await scan.update({
            status: 'failed',
            error_message: 'Scan stopped by user',
            completed_at: new Date(),
        });

        res.json({
            message: 'Scan stop initiated successfully.',
            scan: {
                id: scan.id,
                status: 'failed',
                error_message: 'Scan stopped by user',
            }
        });

    } catch (err) {
        console.error('[Scan] Stop scan error:', err);
        res.status(500).json({ error: 'Failed to stop scan.' });
    }
});

/**
 * GET /api/security/scan/results/:scanId
 * Get full scan results with AI-enriched vulnerabilities
 */
router.get('/results/:scanId', authenticateToken, async (req, res) => {
    try {
        const scan = await Scan.findByPk(req.params.scanId, {
            include: [
                {
                    model: Vulnerability,
                    as: 'vulnerabilities',
                    order: [['risk_score', 'DESC']],
                },
                {
                    model: GovernanceMetric,
                    as: 'governance',
                },
            ],
        });

        if (!scan) {
            return res.status(404).json({ error: 'Scan not found.' });
        }

        // Group by risk level
        const summary = {
            total: scan.vulnerabilities.length,
            critical: scan.vulnerabilities.filter(v => v.risk === 'Critical').length,
            high: scan.vulnerabilities.filter(v => v.risk === 'High').length,
            medium: scan.vulnerabilities.filter(v => v.risk === 'Medium').length,
            low: scan.vulnerabilities.filter(v => v.risk === 'Low').length,
            informational: scan.vulnerabilities.filter(v => v.risk === 'Informational').length,
            regressions: scan.vulnerabilities.filter(v => v.is_regression).length,
        };

        // Group by OWASP category
        const owaspBreakdown = {};
        for (const vuln of scan.vulnerabilities) {
            const cat = vuln.owasp_category || 'General Security / NA';
            owaspBreakdown[cat] = (owaspBreakdown[cat] || 0) + 1;
        }

        res.json({
            scan: {
                id: scan.id,
                scan_type: scan.scan_type,
                status: scan.status,
                target_url: scan.target_url,
                started_at: scan.started_at,
                completed_at: scan.completed_at,
            },
            summary,
            owasp_breakdown: owaspBreakdown,
            governance: scan.governance,
            vulnerabilities: scan.vulnerabilities,
        });
    } catch (err) {
        console.error('[Scan] Results error:', err);
        res.status(500).json({ error: 'Failed to get scan results.' });
    }
});

/**
 * Basic URL validation helper (inline, for non-middleware use)
 */
function validateScanUrl(url) {
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { valid: false, error: 'Only HTTP/HTTPS URLs are allowed.' };
        }
        // Block obvious private IPs
        const blockedPatterns = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^localhost$/i];
        const isPrivate = blockedPatterns.some(pattern => pattern.test(parsed.hostname));

        if (isPrivate && process.env.ALLOW_PRIVATE_SCAN !== 'true') {
            return { valid: false, error: 'Internal/private addresses are not allowed (SSRF protection). System administrators can bypass this by setting ALLOW_PRIVATE_SCAN=true in .env.' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format.' };
    }
}

/**
 * GET /api/security/scan/report/:scanId/download
 * Download a beautifully formatted DOCX report for a scan
 */
router.get('/report/:scanId/download', authenticateToken, async (req, res) => {
    try {
        const scan = await Scan.findByPk(req.params.scanId, {
            include: [
                {
                    model: Vulnerability,
                    as: 'vulnerabilities',
                    order: [['risk_score', 'DESC']],
                },
                {
                    model: GovernanceMetric,
                    as: 'governance',
                },
                {
                    model: Project,
                    as: 'project',
                }
            ],
        });

        if (!scan) {
            return res.status(404).json({ error: 'Scan not found.' });
        }

        // Verify project ownership
        if (scan.project.owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied.' });
        }

        // Generate report HTML content
        const htmlContent = generateScanReportHtml(scan);

        // Convert to DOCX format using html-docx-js
        const blob = htmlDocx.asBlob(htmlContent);
        const arrayBuffer = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const dateObj = new Date(scan.started_at || Date.now());
        const formattedDate = dateObj.getFullYear() + '-' +
            String(dateObj.getMonth() + 1).padStart(2, '0') + '-' +
            String(dateObj.getDate()).padStart(2, '0');
        const formattedTime = String(dateObj.getHours()).padStart(2, '0') + '-' +
            String(dateObj.getMinutes()).padStart(2, '0') + '-' +
            String(dateObj.getSeconds()).padStart(2, '0');
        const filename = `Security_Scan_Report_${scan.scan_type}_${formattedDate}_${formattedTime}.docx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition'); // Allow frontend fetch to read it
        res.send(buffer);

    } catch (err) {
        console.error('[Scan] Report download error:', err);
        res.status(500).json({ error: 'Failed to generate report.' });
    }
});

/**
 * Enforce database retention: keep only the 30 most recent scans for a project
 */
async function enforceScanRetention(projectId) {
    try {
        const scans = await Scan.findAll({
            where: { project_id: projectId },
            order: [['created_at', 'DESC']],
        });

        if (scans.length > 30) {
            const scansToDelete = scans.slice(30);
            console.log(`[Retention] Pruning ${scansToDelete.length} scans for project ${projectId} to maintain 30-scan limit`);
            for (const oldScan of scansToDelete) {
                await oldScan.destroy(); // Cascades to delete vulnerabilities and governance metrics
            }
        }
    } catch (err) {
        console.error('[Retention] Failed to enforce scan retention:', err);
    }
}

/**
 * Generate premium HTML content for DOCX conversion
 */
function generateScanReportHtml(scan) {
    const gov = scan.governance;
    const project = scan.project;
    const vulns = scan.vulnerabilities || [];

    const critical = vulns.filter(v => v.risk === 'Critical');
    const high = vulns.filter(v => v.risk === 'High');
    const medium = vulns.filter(v => v.risk === 'Medium');
    const low = vulns.filter(v => v.risk === 'Low');
    const info = vulns.filter(v => v.risk === 'Informational');

    const statusText = gov?.release_blocked ? 'BLOCKED' : 'APPROVED';
    const statusColor = gov?.release_blocked ? '#ef4444' : '#22c55e';

    let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Security Scan Report</title>
        <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333333; }
            h1 { color: #1e3a8a; border-bottom: 3px solid #1e3a8a; padding-bottom: 12px; font-size: 24pt; margin-bottom: 20px; }
            h2 { color: #2563eb; margin-top: 35px; border-bottom: 1px solid #d1d5db; padding-bottom: 6px; font-size: 18pt; }
            h3 { color: #1e40af; font-size: 14pt; margin-top: 20px; }
            p { font-size: 11pt; margin-bottom: 12px; }
            .meta-table, .stats-table { width: 100%; border-collapse: collapse; margin-bottom: 25px; margin-top: 10px; }
            .meta-table td { padding: 10px; border: 1px solid #d1d5db; font-size: 11pt; }
            .meta-table td.label { font-weight: bold; background-color: #f3f4f6; width: 35%; }
            .stats-table th { background-color: #1e3a8a; color: white; padding: 12px; text-align: left; font-size: 11pt; }
            .stats-table td { padding: 12px; border: 1px solid #d1d5db; font-size: 11pt; }
            .status-banner { padding: 18px; border-radius: 6px; font-weight: bold; font-size: 14pt; text-align: center; margin-bottom: 25px; color: white; }
            .vuln-card { border: 1px solid #cbd5e1; border-radius: 6px; padding: 18px; margin-bottom: 25px; background-color: #ffffff; }
            .vuln-header { border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; margin-bottom: 15px; }
            .vuln-title { font-size: 14pt; font-weight: bold; color: #0f172a; }
            .risk-tag { font-weight: bold; font-size: 10pt; text-transform: uppercase; color: #ffffff; padding: 4px 10px; border-radius: 4px; display: inline-block; }
            .pre-remediation { background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; border-radius: 4px; font-family: 'Courier New', Courier, monospace; font-size: 9.5pt; white-space: pre-wrap; margin-top: 8px; }
        </style>
    </head>
    <body>
        <h1>AI Secure Engine: Vulnerability Analysis Report</h1>
        
        <div class="status-banner" style="background-color: ${statusColor};">
            GOVERNANCE COMPLIANCE STATUS: ${statusText}
        </div>

        <h2>1. Metadata</h2>
        <table class="meta-table">
            <tr>
                <td class="label">Project Name</td>
                <td>${project.name}</td>
            </tr>
            <tr>
                <td class="label">Target Endpoint</td>
                <td>${scan.target_url}</td>
            </tr>
            <tr>
                <td class="label">Scan Type</td>
                <td style="text-transform: capitalize;">${scan.scan_type}</td>
            </tr>
            <tr>
                <td class="label">Scan Execution Date</td>
                <td>${new Date(scan.started_at || Date.now()).toLocaleString()}</td>
            </tr>
            <tr>
                <td class="label">Overall Posture Score</td>
                <td>${gov?.health_score !== undefined ? gov.health_score : 'N/A'} / 10</td>
            </tr>
        </table>

        <h2>2. Executive Summary</h2>
        <p style="white-space: pre-wrap; font-size: 11pt; line-height: 1.6; background-color: #f8fafc; border-left: 4px solid #1e3a8a; padding: 15px; border-radius: 4px;">
            ${gov?.executive_summary || 'No summary available.'}
        </p>

        <h2>3. Vulnerability Distribution</h2>
        <table class="stats-table">
            <thead>
                <tr>
                    <th style="width: 70%;">Severity</th>
                    <th style="width: 30%;">Count</th>
                </tr>
            </thead>
            <tbody>
                <tr style="background-color: rgba(239, 68, 68, 0.08);">
                    <td style="color: #ef4444; font-weight: bold;">Critical</td>
                    <td>${critical.length}</td>
                </tr>
                <tr style="background-color: rgba(249, 115, 22, 0.08);">
                    <td style="color: #f97316; font-weight: bold;">High</td>
                    <td>${high.length}</td>
                </tr>
                <tr style="background-color: rgba(234, 179, 8, 0.08);">
                    <td style="color: #eab308; font-weight: bold;">Medium</td>
                    <td>${medium.length}</td>
                </tr>
                <tr style="background-color: rgba(34, 197, 94, 0.08);">
                    <td style="color: #22c55e; font-weight: bold;">Low</td>
                    <td>${low.length}</td>
                </tr>
                <tr style="background-color: rgba(107, 114, 128, 0.08);">
                    <td style="color: #6b7280; font-weight: bold;">Informational</td>
                    <td>${info.length}</td>
                </tr>
                <tr style="font-weight: bold; background-color: #f1f5f9;">
                    <td>Total Findings</td>
                    <td>${vulns.length}</td>
                </tr>
            </tbody>
        </table>

        <h2>4. Detailed Intelligence Findings</h2>
    `;

    if (vulns.length === 0) {
        html += `<p>No vulnerabilities were identified during this scan.</p>`;
    } else {
        vulns.forEach((v, index) => {
            const riskColor = v.risk === 'Critical' ? '#ef4444' :
                              v.risk === 'High' ? '#f97316' :
                              v.risk === 'Medium' ? '#eab308' :
                              v.risk === 'Low' ? '#22c55e' : '#6b7280';

            html += `
            <div class="vuln-card">
                <div class="vuln-header">
                    <div style="float: right; margin-top: 5px;">
                        <span class="risk-tag" style="background-color: ${riskColor};">${v.risk}</span>
                    </div>
                    <span class="vuln-title">${index + 1}. ${v.alert_name}</span>
                </div>
                <table class="meta-table" style="margin-top: 10px;">
                    <tr>
                        <td class="label">OWASP Top 10 Category</td>
                        <td>${v.owasp_category || 'General Security'}</td>
                    </tr>
                    <tr>
                        <td class="label">Vulnerability Risk Score</td>
                        <td>${v.risk_score !== null ? v.risk_score.toFixed(1) : 'N/A'} / 10</td>
                    </tr>
                    <tr>
                        <td class="label">Confidence Level</td>
                        <td>${v.confidence || 'N/A'}</td>
                    </tr>
                    <tr>
                        <td class="label">Target URL</td>
                        <td><code>${v.url}</code></td>
                    </tr>
                    <tr>
                        <td class="label">Exploitability Level</td>
                        <td>${v.exploitability || 'N/A'}</td>
                    </tr>
                    ${v.jira_ticket_key ? `
                    <tr>
                        <td class="label">Jira Reference Key</td>
                        <td><code>${v.jira_ticket_key}</code></td>
                    </tr>` : ''}
                </table>

                <h3 style="margin-top: 15px; color: #1e40af;">AI Security Insight</h3>
                <p style="font-size: 10.5pt; color: #334155;">${v.ai_summary || 'AI insight not available.'}</p>

                <h3 style="color: #1e40af;">Remediation Strategy</h3>
                <div class="pre-remediation">${v.remediation || v.solution || 'No remediation details provided.'}</div>
                
                ${v.code_example ? `
                <h3 style="color: #16a34a;">Secure Implementation Example</h3>
                <div class="pre-remediation" style="background-color: #f0fdf4; border-color: #bbf7d0; color: #14532d;">${v.code_example}</div>` : ''}
            </div>
            `;
        });
    }

    html += `
    </body>
    </html>
    `;

    return html;
}

export default router;
