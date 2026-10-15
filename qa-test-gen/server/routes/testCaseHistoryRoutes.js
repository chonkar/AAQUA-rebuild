import { Router } from 'express';
import { TestCaseHistory } from '../models/index.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/testcase-history
 * Save a new test case generation run.
 * Enforces the 10-run limit per User Story.
 */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const {
            project_id,
            story_key,
            story_description,
            business_rules,
            regression_context,
            tech_details,
            test_cases
        } = req.body;

        if (!project_id || !story_key || !story_description || !test_cases) {
            return res.status(400).json({
                error: 'project_id, story_key, story_description, and test_cases are required.'
            });
        }

        const userId = req.user.id;
        const email = req.user.email;

        // Fetch existing runs to check limit (10 runs per story)
        const existingRuns = await TestCaseHistory.findAll({
            where: {
                user_id: userId,
                project_id,
                story_key
            },
            order: [['created_at', 'ASC']] // Oldest first
        });

        let warningMsg = null;
        if (existingRuns.length >= 10) {
            // Delete oldest runs until we have exactly 9
            const toDeleteCount = existingRuns.length - 9;
            const runsToDelete = existingRuns.slice(0, toDeleteCount);
            for (const run of runsToDelete) {
                await run.destroy();
            }
            warningMsg = 'You reached the maximum limit of 10 runs per User Story. The oldest run was automatically deleted.';
        }

        const newRun = await TestCaseHistory.create({
            user_id: userId,
            email,
            project_id,
            story_key,
            story_description,
            business_rules: business_rules || null,
            regression_context: regression_context || null,
            tech_details: tech_details || null,
            test_cases
        });

        res.status(201).json({
            message: 'History run saved successfully.',
            warning: warningMsg,
            run: newRun
        });
    } catch (err) {
        console.error('[TestCaseHistory] Save error:', err);
        res.status(500).json({ error: 'Failed to save test case history.' });
    }
});

/**
 * GET /api/testcase-history/stories
 * Get list of distinct stories with latest description and run details.
 */
router.get('/stories', authenticateToken, async (req, res) => {
    try {
        const { project_id } = req.query;
        if (!project_id) {
            return res.status(400).json({ error: 'project_id query parameter is required.' });
        }

        const userId = req.user.id;

        const histories = await TestCaseHistory.findAll({
            where: {
                user_id: userId,
                project_id
            },
            order: [['created_at', 'DESC']]
        });

        // Group by story_key in memory to get distinct stories
        const storiesMap = new Map();
        for (const item of histories) {
            if (!storiesMap.has(item.story_key)) {
                storiesMap.set(item.story_key, {
                    storyKey: item.story_key,
                    description: item.story_description,
                    businessRules: item.business_rules,
                    regressionContext: item.regression_context,
                    techDetails: item.tech_details,
                    lastRunAt: item.created_at,
                    runCount: 0
                });
            }
            storiesMap.get(item.story_key).runCount++;
        }

        res.json({ stories: Array.from(storiesMap.values()) });
    } catch (err) {
        console.error('[TestCaseHistory] List stories error:', err);
        res.status(500).json({ error: 'Failed to list history stories.' });
    }
});

/**
 * GET /api/testcase-history/story/:storyKey/runs
 * Fetch all runs for a specific story key.
 */
router.get('/story/:storyKey/runs', authenticateToken, async (req, res) => {
    try {
        const { storyKey } = req.params;
        const { project_id } = req.query;

        if (!project_id) {
            return res.status(400).json({ error: 'project_id query parameter is required.' });
        }

        const userId = req.user.id;

        const runs = await TestCaseHistory.findAll({
            where: {
                user_id: userId,
                project_id,
                story_key: storyKey
            },
            order: [['created_at', 'DESC']]
        });

        res.json({ runs });
    } catch (err) {
        console.error('[TestCaseHistory] Fetch runs error:', err);
        res.status(500).json({ error: 'Failed to fetch history runs.' });
    }
});

/**
 * DELETE /api/testcase-history/run/:id
 * Delete a specific run.
 */
router.delete('/run/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const run = await TestCaseHistory.findOne({
            where: { id, user_id: userId }
        });

        if (!run) {
            return res.status(404).json({ error: 'History run not found or access denied.' });
        }

        await run.destroy();
        res.json({ message: 'History run deleted successfully.' });
    } catch (err) {
        console.error('[TestCaseHistory] Delete run error:', err);
        res.status(500).json({ error: 'Failed to delete history run.' });
    }
});

/**
 * DELETE /api/testcase-history/story/:storyKey
 * Delete all runs for a story.
 */
router.delete('/story/:storyKey', authenticateToken, async (req, res) => {
    try {
        const { storyKey } = req.params;
        const { project_id } = req.query;

        if (!project_id) {
            return res.status(400).json({ error: 'project_id query parameter is required.' });
        }

        const userId = req.user.id;

        const deletedCount = await TestCaseHistory.destroy({
            where: {
                user_id: userId,
                project_id,
                story_key: storyKey
            }
        });

        res.json({
            message: `Deleted ${deletedCount} history runs for story "${storyKey}".`
        });
    } catch (err) {
        console.error('[TestCaseHistory] Delete story error:', err);
        res.status(500).json({ error: 'Failed to delete story history.' });
    }
});

export default router;
