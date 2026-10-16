import sequelize from '../db.js';
import Project from './Project.js';
import AutomationResult from './AutomationResult.js';
import AccessibilityResult from './AccessibilityResult.js';
import LocalizationResult from './LocalizationResult.js';
import ReleaseReadiness from './ReleaseReadiness.js';
import UserActivity from './UserActivity.js';
import McpServer from './McpServer.js';
import AgentRun from './AgentRun.js';
import McpLocatorLearning from './McpLocatorLearning.js';
import TestCaseHistory from './TestCaseHistory.js';
import TransientDownload from './TransientDownload.js';
import Job from './Job.js';

// ─── Associations ────────────────────────────────────────
// User identity is owned by Keycloak; `owner_id` stores the
// Keycloak `sub` UUID directly, with no FK to a local users table.

// Project → AutomationResult (one-to-many)
Project.hasMany(AutomationResult, { foreignKey: 'project_id', as: 'automationResults', onDelete: 'CASCADE', hooks: true });
AutomationResult.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });

// Project → AccessibilityResult (one-to-many)
Project.hasMany(AccessibilityResult, { foreignKey: 'project_id', as: 'accessibilityResults', onDelete: 'CASCADE', hooks: true });
AccessibilityResult.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });

// Project → LocalizationResult (one-to-many)
Project.hasMany(LocalizationResult, { foreignKey: 'project_id', as: 'localizationResults', onDelete: 'CASCADE', hooks: true });
LocalizationResult.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });

// Project → ReleaseReadiness (one-to-many)
Project.hasMany(ReleaseReadiness, { foreignKey: 'project_id', as: 'releaseReadinesses', onDelete: 'CASCADE', hooks: true });
ReleaseReadiness.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });

// Project → McpServer (one-to-many)
Project.hasMany(McpServer, { foreignKey: 'project_id', as: 'mcpServers', onDelete: 'CASCADE', hooks: true });
McpServer.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });

// Project → AgentRun (one-to-many)
Project.hasMany(AgentRun, { foreignKey: 'project_id', as: 'agentRuns', onDelete: 'CASCADE', hooks: true });
AgentRun.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });

// Project → McpLocatorLearning (one-to-many)
Project.hasMany(McpLocatorLearning, { foreignKey: 'project_id', as: 'mcpLocatorLearnings', onDelete: 'CASCADE', hooks: true });
McpLocatorLearning.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });

// Project → TestCaseHistory (one-to-many)
Project.hasMany(TestCaseHistory, { foreignKey: 'project_id', as: 'testCaseHistories', onDelete: 'CASCADE', hooks: true });
TestCaseHistory.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });

// ─── Sync helper ─────────────────────────────────────────

async function initDatabase() {
    try {
        console.log('[DB] Attempting to connect to PostgreSQL...');

        // Timeout after 10 seconds to prevent server hang
        const connectionTimeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Database connection timed out (10s)')), 10000)
        );

        await Promise.race([
            sequelize.authenticate(),
            connectionTimeout
        ]);

        console.log('[DB] PostgreSQL connected.');
        console.log('[DB] Synchronizing tables (alter: true)...');
        await sequelize.sync({ alter: true });
        console.log('[DB] Tables synchronized.');

        // Clean up and normalize any legacy unquoted locators in the Database
        try {
            const learnings = await McpLocatorLearning.findAll();
            let cleanedCount = 0;
            for (const learn of learnings) {
                if (learn.selector) {
                    let s = learn.selector.trim();
                    // Wrap unquoted text arguments in :has-text() with single quotes
                    s = s.replace(/:has-text\(\s*([^'"].*?)\s*\)/g, (match, textVal) => {
                        const trimmed = textVal.trim();
                        return `:has-text('${trimmed}')`;
                    });
                    // Normalize unquoted attribute values inside square brackets [attr=val]
                    s = s.replace(/\[([a-zA-Z_:][-a-zA-Z0-9_:]*)\s*=\s*([^'"\]]+)\]/g, (match, attrName, attrValue) => {
                        const val = attrValue.trim();
                        return `[${attrName}='${val}']`;
                    });
                    if (s !== learn.selector) {
                        await learn.update({ selector: s });
                        cleanedCount++;
                    }
                }
            }
            if (cleanedCount > 0) {
                console.log(`[DB Migration] Normalized ${cleanedCount} legacy unquoted selector mappings in Database.`);
            }
        } catch (migErr) {
            console.error('[DB Migration] Selector cleanup failed:', migErr);
        }
    } catch (err) {
        console.error('[DB] Connection failed:', err.message);
        console.warn('[DB] Server will continue without database — persistent features will be unavailable.');
    }
}

export {
    sequelize,
    Project,
    AutomationResult,
    AccessibilityResult,
    LocalizationResult,
    ReleaseReadiness,
    UserActivity,
    McpServer,
    AgentRun,
    McpLocatorLearning,
    TestCaseHistory,
    TransientDownload,
    Job,
    initDatabase,
};
