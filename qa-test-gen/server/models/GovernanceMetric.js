import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const GovernanceMetric = sequelize.define('governance_metrics', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    scan_id: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        references: { model: 'scans', key: 'id' },
    },
    critical_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    high_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    medium_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    low_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    info_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    total_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    critical_high_percentage: {
        type: DataTypes.FLOAT,
        defaultValue: 0,
    },
    release_blocked: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
    },
    reopened_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    executive_summary: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    health_score: {
        type: DataTypes.FLOAT,
        defaultValue: 10.0,
    },
});

export default GovernanceMetric;
