import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const Scan = sequelize.define('scans', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    project_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'projects', key: 'id' },
    },
    scan_type: {
        type: DataTypes.ENUM('baseline', 'active', 'api', 'passive', 'fuzzer'),
        allowNull: false,
    },
    status: {
        type: DataTypes.ENUM('queued', 'spidering', 'scanning', 'analyzing', 'completed', 'failed'),
        defaultValue: 'queued',
    },
    zap_scan_id: {
        type: DataTypes.STRING(100),
        allowNull: true,
    },
    target_url: {
        type: DataTypes.STRING(2048),
        allowNull: false,
    },
    progress: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    started_at: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    completed_at: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    error_message: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    // Append-only run log surfaced in the UI. Capped to ~500 newline-separated
    // lines on the server side before being persisted on phase transitions.
    logs: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    // Keycloak `sub` claim of the user who triggered the scan.
    initiated_by: {
        type: DataTypes.UUID,
        allowNull: true,
    },
});

export default Scan;
