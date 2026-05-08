import sequelize from '../db.js';
import Project from './Project.js';
import Scan from './Scan.js';
import Vulnerability from './Vulnerability.js';
import GovernanceMetric from './GovernanceMetric.js';

// ─── Associations ────────────────────────────────────────
// User identity is owned by Keycloak; `owner_id` and `initiated_by` store the
// Keycloak `sub` UUID directly, with no FK to a local users table.

// Project → Scans (one-to-many)
Project.hasMany(Scan, { foreignKey: 'project_id', as: 'scans' });
Scan.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });

// Scan → Vulnerabilities (one-to-many)
Scan.hasMany(Vulnerability, { foreignKey: 'scan_id', as: 'vulnerabilities' });
Vulnerability.belongsTo(Scan, { foreignKey: 'scan_id', as: 'scan' });

// Scan → GovernanceMetric (one-to-one)
Scan.hasOne(GovernanceMetric, { foreignKey: 'scan_id', as: 'governance' });
GovernanceMetric.belongsTo(Scan, { foreignKey: 'scan_id', as: 'scan' });

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
    } catch (err) {
        console.error('[DB] Connection failed:', err.message);
        console.warn('[DB] Server will continue without database — security features will be unavailable.');
    }
}

export {
    sequelize,
    Project,
    Scan,
    Vulnerability,
    GovernanceMetric,
    initDatabase,
};
