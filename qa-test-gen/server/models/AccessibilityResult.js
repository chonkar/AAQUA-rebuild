import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const AccessibilityResult = sequelize.define('accessibility_results', {
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
    wcag_compliance: {
        type: DataTypes.FLOAT,
        allowNull: false,
    },
    accessibility_score: {
        type: DataTypes.FLOAT,
        allowNull: false,
    },
    critical_violations: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    serious_violations: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    moderate_violations: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    minor_violations: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    scanned_url: {
        type: DataTypes.STRING(2048),
        allowNull: true,
    },
});

export default AccessibilityResult;
