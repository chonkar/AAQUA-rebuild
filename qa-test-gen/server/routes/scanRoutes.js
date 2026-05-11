import { Router } from 'express';
import { Scan, Vulnerability, Project, GovernanceMetric } from '../models/index.js';
import { authenticateToken } from '../middleware/auth.js';
import { validateTargetUrl } from '../middleware/urlValidator.js';
import * as zapService from '../services/zapService.js';
import { analyzeVulnerabilities } from '../services/aiAnalysisService.js';
import { calculateGovernanceMetrics, checkForRegressions } from '../services/governanceService.js';
import { createTicketsForCriticalHigh } from '../services/jiraService.js';

const router = Router();

// Track active scans to prevent overload
const activeScans = new Set();
const MAX_CONCURRENT_SCANS = 2;

// In-memory per-scan log ring buffer. Lines accumulate here during execution
// and are flushed to Scan.logs on phase transitions and on terminal status.
// Bounded to MAX_LOG_LINES so a chatty scan can't OOM the process.
const scanLogBuffers = new Map(); // scanId -> string[]
const MAX_LOG_LINES = 500;

function logScan(scanId, line) {
    const text = line == null ? '' : String(line);
    const stamped = `[${new Date().toISOString()}] ${text}`;
    let buf = scanLogBuffers.get(scanId);
    if (!buf) { buf = []; scanLogBuffers.set(scanId, buf); }
    buf.push(stamped);
    if (buf.length > MAX_LOG_LINES) buf.splice(0, buf.length - MAX_LOG_LINES);
    // Mirror to the server console so docker logs / journalctl still capture
    // everything, in case of post-mortem debugging beyond what the UI shows.
    console.log(`[Scan ${scanId.slice(0, 8)}] ${text}`);
}

async function flushScanLogs(scan) {
    const buf = scanLogBuffers.get(scan.id);
    if (!buf || buf.length === 0) return;
    try {
        await scan.update({ logs: buf.join('\n') });
    } catch (err) {
        console.error(`[Scan ${scan.id}] Failed to flush logs:`, err.message);
    }
}

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
    const log = (line) => logScan(scan.id, line);
    try {
        log(`Starting ${scan.scan_type} scan against ${scan.target_url}`);
        await scan.update({ status: 'spidering' });
        await flushScanLogs(scan);

        // Progress callback from zapService. We flush logs on each phase
        // transition so a tester reloading mid-scan sees up-to-date history
        // even if the in-memory buffer is dropped.
        let lastStatus = scan.status;
        const updateProgress = async (status, progress) => {
            const next = { progress: Math.round(progress) };
            if (status && status !== lastStatus) {
                next.status = status;
                lastStatus = status;
                log(`Phase: ${status} (${next.progress}%)`);
                await scan.update(next);
                await flushScanLogs(scan);
            } else {
                await scan.update(next);
            }
        };

        // Phase 1: Run ZAP scan
        let alerts;
        switch (scan.scan_type) {
            case 'baseline':
                alerts = await zapService.runBaselineScan(project, updateProgress, log);
                break;
            case 'passive':
                alerts = await zapService.runPassiveScan(project, updateProgress, log);
                break;
            case 'active':
                alerts = await zapService.runFullActiveScan(project, updateProgress, log);
                break;
            case 'fuzzer':
                alerts = await zapService.runFuzzerScan(project, updateProgress, log);
                break;
            case 'api':
                if (!openapiUrl) throw new Error('openapi_url required for API scans');
                alerts = await zapService.runApiScan(openapiUrl, project, updateProgress, log);
                break;
        }

        log(`ZAP returned ${alerts.length} alert(s); starting AI analysis`);
        await scan.update({ status: 'analyzing', progress: 60 });
        await flushScanLogs(scan);

        // Phase 2: AI analysis
        const enrichedVulns = await analyzeVulnerabilities(alerts);
        log(`AI analysis complete for ${enrichedVulns.length} vulnerability/ies`);

        // Phase 3: Check regressions
        const withRegressions = await checkForRegressions(project.id, enrichedVulns);
        log(`Regression check complete (${withRegressions.filter(v => v.is_regression).length} regressions flagged)`);

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
        log(`Persisted ${savedVulns.length} vulnerability record(s)`);

        // Phase 5: Calculate governance metrics
        const governance = await calculateGovernanceMetrics(scan.id);
        log(`Governance: ${governance.release_blocked ? 'BLOCKED' : 'APPROVED'}`);

        // Phase 6: Jira tickets (optional)
        const tickets = await createTicketsForCriticalHigh(savedVulns, project.name);
        if (tickets.length > 0) {
            for (const ticket of tickets) {
                await Vulnerability.update(
                    { jira_ticket_key: ticket.jira_key },
                    { where: { id: ticket.vulnerability_id } }
                );
            }
            log(`Created ${tickets.length} Jira ticket(s) for Critical/High findings`);
        }

        // Mark complete
        log(`Scan completed: ${savedVulns.length} vulnerabilities found`);
        await scan.update({
            status: 'completed',
            progress: 100,
            completed_at: new Date(),
        });
        await flushScanLogs(scan);

    } catch (err) {
        log(`Scan failed: ${err.message}`);
        await scan.update({
            status: 'failed',
            error_message: err.message,
            completed_at: new Date(),
        });
        await flushScanLogs(scan);
    } finally {
        // Drop the in-memory buffer; subsequent reads serve from Scan.logs.
        scanLogBuffers.delete(scan.id);
    }
}

/**
 * GET /api/security/scan/status/:scanId?since=<cursor>
 *
 * Returns scan status, progress, and the delta of log lines since `cursor`.
 * Live buffer is preferred for in-flight scans; falls back to the persisted
 * Scan.logs column once the buffer has been dropped (terminal status, or
 * server restart between polls).
 */
router.get('/status/:scanId', authenticateToken, async (req, res) => {
    try {
        const scan = await Scan.findByPk(req.params.scanId);
        if (!scan) {
            return res.status(404).json({ error: 'Scan not found.' });
        }

        const since = Math.max(0, parseInt(req.query.since, 10) || 0);
        const buf = scanLogBuffers.get(scan.id);
        const allLines = buf
            ? buf.slice()
            : (scan.logs ? scan.logs.split('\n') : []);
        const logs = allLines.slice(since);
        const cursor = allLines.length;

        res.json({
            id: scan.id,
            scan_type: scan.scan_type,
            status: scan.status,
            progress: scan.progress,
            target_url: scan.target_url,
            started_at: scan.started_at,
            completed_at: scan.completed_at,
            error_message: scan.error_message,
            logs,
            cursor,
        });
    } catch (err) {
        console.error('[Scan] Status error:', err);
        res.status(500).json({ error: 'Failed to get scan status.' });
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
            const cat = vuln.owasp_category || 'Uncategorized';
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

export default router;
