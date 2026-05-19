import sequelize from '../db.js';
import User from './User.js';
import Project from './Project.js';
import Scan from './Scan.js';
import Vulnerability from './Vulnerability.js';
import GovernanceMetric from './GovernanceMetric.js';

// ─── Associations ────────────────────────────────────────

// User → Projects (one-to-many)
User.hasMany(Project, { foreignKey: 'owner_id', as: 'projects' });
Project.belongsTo(User, { foreignKey: 'owner_id', as: 'owner' });

// Project → Scans (one-to-many)
Project.hasMany(Scan, { foreignKey: 'project_id', as: 'scans', onDelete: 'CASCADE', hooks: true });
Scan.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });

// User → Scans (initiator)
User.hasMany(Scan, { foreignKey: 'initiated_by', as: 'initiatedScans' });
Scan.belongsTo(User, { foreignKey: 'initiated_by', as: 'initiator' });

// Scan → Vulnerabilities (one-to-many)
Scan.hasMany(Vulnerability, { foreignKey: 'scan_id', as: 'vulnerabilities', onDelete: 'CASCADE', hooks: true });
Vulnerability.belongsTo(Scan, { foreignKey: 'scan_id', as: 'scan' });

// Scan → GovernanceMetric (one-to-one)
Scan.hasOne(GovernanceMetric, { foreignKey: 'scan_id', as: 'governance', onDelete: 'CASCADE', hooks: true });
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
    User,
    Project,
    Scan,
    Vulnerability,
    GovernanceMetric,
    initDatabase,
};
