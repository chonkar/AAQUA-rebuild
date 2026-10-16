import express from 'express';
import AdmZip from 'adm-zip';
import path from 'path';
import { recorderService } from '../services/recorderService.js';
import { 
    generateProductionPlaywrightFiles, 
    generateProductionSeleniumFiles 
} from '../services/qaArchitectService.js';

const router = express.Router();

function addFoldersToZip(zip, filePath) {
    const dir = path.dirname(filePath);
    if (dir && dir !== '.') {
        zip.addFile(dir + '/', Buffer.alloc(0));
    }
}

function generateZipFromFiles(files) {
    const zip = new AdmZip();
    for (const file of files) {
        addFoldersToZip(zip, file.path);
        zip.addFile(file.path, Buffer.from(file.code, 'utf8'));
    }
    return zip.toBuffer();
}

/**
 * POST /api/recorder/start
 * Launch live recording session (Smart Mode or Codegen Inspector)
 */
router.post('/start', async (req, res) => {
    try {
        const { url, mode, browserType, headed } = req.body;
        const result = await recorderService.startSession({
            url: url || 'https://demoqa.com/automation-practice-form',
            mode: mode || 'smart',
            browserType: browserType || 'chromium',
            headed: headed !== undefined ? !!headed : true
        });

        res.json({
            message: 'Live recorder launched successfully.',
            ...result
        });
    } catch (err) {
        console.error('[Recorder API] Start error:', err);
        res.status(500).json({ error: 'Failed to start recorder: ' + err.message });
    }
});

/**
 * GET /api/recorder/session/:sessionId
 * Poll live session steps and status
 */
router.get('/session/:sessionId', (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = recorderService.getSession(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Recorder session not found: ' + sessionId });
        }
        res.json(session);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/recorder/stop/:sessionId
 * Stop recording session and return final steps and POM files
 */
router.post('/stop/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await recorderService.stopSession(sessionId);
        res.json({
            message: 'Recorder stopped successfully.',
            ...result
        });
    } catch (err) {
        console.error('[Recorder API] Stop error:', err);
        res.status(500).json({ error: 'Failed to stop recorder: ' + err.message });
    }
});

/**
 * GET /api/recorder/download/:sessionId/:framework
 * Download generated Playwright or Selenium POM zip archive
 */
router.get('/download/:sessionId/:framework', (req, res) => {
    try {
        const { sessionId, framework } = req.params;
        const session = recorderService.getSession(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Recorder session not found.' });
        }

        const steps = session.steps || [];
        const goal = `Recorded test workflow for ${session.url}`;

        let zipBuffer;
        let filename;

        if (framework.toLowerCase().includes('playwright')) {
            const files = generateProductionPlaywrightFiles(steps, goal);
            zipBuffer = generateZipFromFiles(files);
            filename = 'playwright-pom-suite.zip';
        } else {
            const files = generateProductionSeleniumFiles(steps, goal);
            zipBuffer = generateZipFromFiles(files);
            filename = 'selenium-automation-project.zip';
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(zipBuffer);
    } catch (err) {
        console.error('[Recorder Download] Error:', err);
        res.status(500).json({ error: 'Download failed: ' + err.message });
    }
});

/**
 * POST /api/recorder/click-coordinate
 * Dispatch in-viewer click at coordinate (x, y)
 */
router.post('/click-coordinate', async (req, res) => {
    try {
        const { sessionId, x, y } = req.body;
        if (!sessionId || x === undefined || y === undefined) {
            return res.status(400).json({ error: 'sessionId, x, and y are required' });
        }
        const result = await recorderService.clickCoordinate(sessionId, x, y);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/recorder/type-text
 * Send typed text to the active browser
 */
router.post('/type-text', async (req, res) => {
    try {
        const { sessionId, text } = req.body;
        if (!sessionId || text === undefined) {
            return res.status(400).json({ error: 'sessionId and text are required' });
        }
        const result = await recorderService.typeText(sessionId, text);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/recorder/press-key
 * Send keypress (e.g. Enter, Tab, Backspace) to active browser
 */
router.post('/press-key', async (req, res) => {
    try {
        const { sessionId, key } = req.body;
        if (!sessionId || !key) {
            return res.status(400).json({ error: 'sessionId and key are required' });
        }
        const result = await recorderService.pressKey(sessionId, key);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/**
 * POST /api/recorder/fill-field
 * Fill value into specific selector or active element
 */
router.post('/fill-field', async (req, res) => {
    try {
        const { sessionId, selector, value } = req.body;
        if (!sessionId || value === undefined) {
            return res.status(400).json({ error: 'sessionId and value are required' });
        }
        const result = await recorderService.fillField(sessionId, selector, value);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/recorder/auto-fill-form
 * Auto-detect and fill all form inputs on page with clean test data
 */
router.post('/auto-fill-form', async (req, res) => {
    try {
        const { sessionId, customValues } = req.body;
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId is required' });
        }
        const result = await recorderService.autoFillForm(sessionId, customValues || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/recorder/switch-tab
 * Switch active browser tab
 */
router.post('/switch-tab', async (req, res) => {
    try {
        const { sessionId, tabIndex } = req.body;
        if (!sessionId || tabIndex === undefined) {
            return res.status(400).json({ error: 'sessionId and tabIndex are required' });
        }
        const result = await recorderService.switchTab(sessionId, tabIndex);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/recorder/tabs/:sessionId
 * List all open tabs for session
 */
router.get('/tabs/:sessionId', (req, res) => {
    try {
        const { sessionId } = req.params;
        const tabs = recorderService.getTabs(sessionId);
        const session = recorderService.getSession(sessionId);
        res.json({
            tabs,
            activeTab: session?.activeTab || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/recorder/close-tab
 * Close a specific tab
 */
router.post('/close-tab', async (req, res) => {
    try {
        const { sessionId, tabIndex } = req.body;
        if (!sessionId || tabIndex === undefined) {
            return res.status(400).json({ error: 'sessionId and tabIndex are required' });
        }
        const result = await recorderService.closeTab(sessionId, tabIndex);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/recorder/live-screen/:sessionId
 * Serve high-speed raw JPEG frame
 */
router.get('/live-screen/:sessionId', (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = recorderService.getSession(sessionId);
        if (!session || !session.liveScreenshot) {
            return res.status(404).send('No frame captured yet.');
        }

        const base64Data = session.liveScreenshot.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(base64Data, 'base64');
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.send(buf);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

export default router;
