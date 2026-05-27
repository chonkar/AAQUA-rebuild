import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const ReleaseReadiness = sequelize.define('release_readinesses', {
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
    release_version: {
        type: DataTypes.STRING(100),
        allowNull: false,
        defaultValue: 'v1.0.0',
    },
    automation_health: {
        type: DataTypes.FLOAT,
        allowNull: true,
    },
    security_health: {
        type: DataTypes.FLOAT,
        allowNull: true,
    },
    accessibility_health: {
        type: DataTypes.FLOAT,
        allowNull: true,
    },
    localization_health: {
        type: DataTypes.FLOAT,
        allowNull: true,
    },
    performance_health: {
        type: DataTypes.FLOAT,
        allowNull: true,
    },
    overall_quality_score: {
        type: DataTypes.FLOAT,
        allowNull: false,
    },
    release_confidence: {
        type: DataTypes.FLOAT,
        allowNull: false,
    },
    production_risk: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'Low',
    },
    ai_summary: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    deployment_recommendation: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    execution_date: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
});

export default ReleaseReadiness;
