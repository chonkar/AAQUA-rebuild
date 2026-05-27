import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import * as jiraService from '../services/jiraService.js';
import { Vulnerability, Scan, Project } from '../models/index.js';
import * as XLSXModule from 'xlsx';

const XLSX = XLSXModule.default || XLSXModule;
const router = Router();

/**
 * GET /api/jira/story/:issueKey
 * Fetch details of a JIRA User Story or Task to seed the requirement
 */
router.get('/story/:issueKey', authenticateToken, async (req, res) => {
    try {
        const { issueKey } = req.params;
        if (!issueKey) {
            return res.status(400).json({ error: 'Jira Story Key is required.' });
        }

        const customConfig = {
            url: req.headers['x-jira-url'],
            email: req.headers['x-jira-email'],
            token: req.headers['x-jira-token'],
            projectKey: req.headers['x-jira-project-key'],
        };

        const maskedToken = customConfig.token 
            ? `${customConfig.token.substring(0, 4)}...${customConfig.token.substring(customConfig.token.length - 4)}` 
            : 'undefined';
        
        console.log(`[Jira Route] GET /story/${issueKey} - config: URL=${customConfig.url}, Email=${customConfig.email}, Token=${maskedToken}, ProjectKey=${customConfig.projectKey}`);

        const story = await jiraService.fetchJiraStory(issueKey, customConfig);
        console.log(`[Jira Route] Successfully fetched story: ${issueKey} - Title: "${story.title}", Desc Length: ${story.description ? story.description.length : 0} chars`);
        res.json({ story });
    } catch (err) {
        console.error('[Jira Route] Fetch story error:', err);
        res.status(500).json({ error: err.message || 'Failed to fetch Jira story.' });
    }
});

/**
 * POST /api/jira/story/:issueKey/attach
 * Generate Excel workbook of test cases and attach it directly to the JIRA User Story/Task
 */
router.post('/story/:issueKey/attach', authenticateToken, async (req, res) => {
    try {
        const { issueKey } = req.params;
        const { testCases } = req.body;

        if (!issueKey) {
            return res.status(400).json({ error: 'Jira Story Key is required.' });
        }
        if (!testCases || !Array.isArray(testCases) || testCases.length === 0) {
            return res.status(400).json({ error: 'A non-empty testCases array is required.' });
        }

        // Map test cases to clean Excel headers
        const processedData = testCases.map(tc => ({
            'Test Case ID': tc.id || '',
            'Module': tc.module || '',
            'Feature': tc.feature || '',
            'Scenario': tc.scenario || '',
            'Steps': Array.isArray(tc.steps) ? tc.steps.join('\n') : tc.steps || '',
            'Expected Result': tc.expectedResult || '',
            'Priority': tc.priority || '',
            'Platform': tc.platform || '',
            'Test Type': tc.testType || '',
        }));

        // Build SheetJS workbook
        const worksheet = XLSX.utils.json_to_sheet(processedData);
        
        // Apply column widths to make it highly professional
        worksheet['!cols'] = [
            { wch: 15 }, // Test Case ID
            { wch: 15 }, // Module
            { wch: 15 }, // Feature
            { wch: 40 }, // Scenario
            { wch: 50 }, // Steps
            { wch: 40 }, // Expected Result
            { wch: 15 }, // Priority
            { wch: 12 }, // Platform
            { wch: 12 }, // Test Type
        ];

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Functional Test Cases');

        // Write as standard binary buffer
        const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        const customConfig = {
            url: req.headers['x-jira-url'],
            email: req.headers['x-jira-email'],
            token: req.headers['x-jira-token'],
            projectKey: req.headers['x-jira-project-key'],
        };

        // Attach to JIRA Task
        const result = await jiraService.attachExcelToJiraStory(issueKey, excelBuffer, `AAQUA_Functional_Test_Cases_${issueKey}.xlsx`, customConfig);

        res.json({
            message: `Excel workbook attached to JIRA issue ${issueKey} successfully.`,
            result,
        });
    } catch (err) {
        console.error('[Jira Route] Attach Excel error:', err);
        res.status(500).json({ error: err.message || 'Failed to attach Excel to Jira story.' });
    }
});

/**
 * POST /api/jira/defect
 * Raise a single defect bug in JIRA based on a failed manual test case
 */
router.post('/defect', authenticateToken, async (req, res) => {
    try {
        const { testCase, actualResult, projectName } = req.body;

        if (!testCase || !testCase.scenario || !projectName) {
            return res.status(400).json({ error: 'testCase and projectName are required.' });
        }

        const customConfig = {
            url: req.headers['x-jira-url'],
            email: req.headers['x-jira-email'],
            token: req.headers['x-jira-token'],
            projectKey: req.headers['x-jira-project-key'],
        };

        const jiraKey = await jiraService.createDefectTicket(testCase, actualResult, projectName, customConfig);

        res.json({
            message: 'Defect successfully raised in JIRA.',
            jiraKey,
        });
    } catch (err) {
        console.error('[Jira Route] Defect creation error:', err);
        res.status(500).json({ error: err.message || 'Failed to raise defect in JIRA.' });
    }
});

/**
 * POST /api/jira/accessibility-defect
 * Raise a JIRA Bug for a single accessibility issue (Axe rule violation or AI Audit finding).
 */
router.post('/accessibility-defect', authenticateToken, async (req, res) => {
    try {
        const { issue, projectName, scannedUrl } = req.body;
        if (!issue || typeof issue !== 'object') {
            return res.status(400).json({ error: 'issue payload is required.' });
        }
        if (!issue.source || !['axe', 'ai'].includes(issue.source)) {
            return res.status(400).json({ error: 'issue.source must be "axe" or "ai".' });
        }

        const customConfig = {
            url: req.headers['x-jira-url'],
            email: req.headers['x-jira-email'],
            token: req.headers['x-jira-token'],
            projectKey: req.headers['x-jira-project-key'],
        };

        const result = await jiraService.createAccessibilityDefect(issue, projectName, scannedUrl, customConfig);
        res.json({ message: 'Accessibility defect raised in JIRA.', ...result });
    } catch (err) {
        console.error('[Jira Route] Accessibility defect error:', err);
        res.status(500).json({ error: err.message || 'Failed to raise accessibility defect in JIRA.' });
    }
});

/**
 * POST /api/jira/localization-defect
 * Raise a JIRA Bug for a single localization (l10n) issue.
 */
router.post('/localization-defect', authenticateToken, async (req, res) => {
    try {
        const { issue, projectName, scannedUrl, targetLanguage } = req.body;
        if (!issue || typeof issue !== 'object') {
            return res.status(400).json({ error: 'issue payload is required.' });
        }
        if (!issue.original && !issue.suggestion) {
            return res.status(400).json({ error: 'issue must include at least original or suggestion text.' });
        }

        const customConfig = {
            url: req.headers['x-jira-url'],
            email: req.headers['x-jira-email'],
            token: req.headers['x-jira-token'],
            projectKey: req.headers['x-jira-project-key'],
        };

        const result = await jiraService.createLocalizationDefect(issue, projectName, scannedUrl, targetLanguage, customConfig);
        res.json({ message: 'Localization defect raised in JIRA.', ...result });
    } catch (err) {
        console.error('[Jira Route] Localization defect error:', err);
        res.status(500).json({ error: err.message || 'Failed to raise localization defect in JIRA.' });
    }
});

/**
 * POST /api/jira/performance-defect
 * Raise a JIRA Bug for a performance finding (Lighthouse score + Core Web Vitals).
 */
router.post('/performance-defect', authenticateToken, async (req, res) => {
    try {
        const { perf, projectName, scannedUrl } = req.body;
        if (!perf || typeof perf !== 'object') {
            return res.status(400).json({ error: 'perf payload is required.' });
        }
        const customConfig = {
            url: req.headers['x-jira-url'],
            email: req.headers['x-jira-email'],
            token: req.headers['x-jira-token'],
            projectKey: req.headers['x-jira-project-key'],
        };
        const result = await jiraService.createPerformanceDefect(perf, projectName, scannedUrl, customConfig);
        res.json({ message: 'Performance defect raised in JIRA.', ...result });
    } catch (err) {
        console.error('[Jira Route] Performance defect error:', err);
        res.status(500).json({ error: err.message || 'Failed to raise performance defect in JIRA.' });
    }
});

/**
 * POST /api/jira/vulnerability-defect
 * Raise a JIRA Bug for a single security vulnerability and persist the
 * returned key onto the Vulnerability row so subsequent fetches show it
 * as already-logged.
 */
router.post('/vulnerability-defect', authenticateToken, async (req, res) => {
    try {
        const { vulnerabilityId } = req.body;
        if (!vulnerabilityId) {
            return res.status(400).json({ error: 'vulnerabilityId is required.' });
        }

        // Fetch the vuln with scan → project so we know the project name and
        // can verify ownership matches the calling user (defence-in-depth).
        const vuln = await Vulnerability.findByPk(vulnerabilityId, {
            include: [{
                model: Scan,
                as: 'scan',
                include: [{ model: Project, as: 'project' }],
            }],
        });
        if (!vuln) {
            return res.status(404).json({ error: 'Vulnerability not found.' });
        }
        if (vuln.scan?.project?.owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied.' });
        }

        const projectName = vuln.scan.project.name;

        // Short-circuit if a ticket already exists — return the existing key
        // so the UI just renders the "logged" badge without a redundant call.
        if (vuln.jira_ticket_key) {
            const jiraUrl = (req.headers['x-jira-url'] || '').trim();
            const url = jiraUrl ? `${jiraUrl.replace(/\/$/, '')}/browse/${vuln.jira_ticket_key}` : null;
            return res.json({ message: 'Ticket already exists.', key: vuln.jira_ticket_key, url });
        }

        const customConfig = {
            url: req.headers['x-jira-url'],
            email: req.headers['x-jira-email'],
            token: req.headers['x-jira-token'],
            projectKey: req.headers['x-jira-project-key'],
        };

        const result = await jiraService.createJiraTicket(vuln, projectName, customConfig);
        if (!result?.key) {
            return res.status(500).json({ error: 'Jira returned no ticket key.' });
        }

        await vuln.update({ jira_ticket_key: result.key });
        res.json({ message: 'Vulnerability defect raised in JIRA.', key: result.key, url: result.url });
    } catch (err) {
        console.error('[Jira Route] Vulnerability defect error:', err);
        res.status(500).json({ error: err.message || 'Failed to raise vulnerability defect in JIRA.' });
    }
});

export default router;
