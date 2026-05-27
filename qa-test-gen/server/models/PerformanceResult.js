import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const PerformanceResult = sequelize.define('performance_results', {
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
    execution_date: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
    performance_score: {
        type: DataTypes.FLOAT,
        allowNull: false,
    },
    lcp_ms: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    cls: {
        type: DataTypes.FLOAT,
        allowNull: true,
    },
    tbt_ms: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    ttfb_ms: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    scanned_url: {
        type: DataTypes.STRING(2048),
        allowNull: true,
    },
});

export default PerformanceResult;
