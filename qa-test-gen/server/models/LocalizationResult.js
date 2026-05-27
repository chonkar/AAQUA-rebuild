import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const LocalizationResult = sequelize.define('localization_results', {
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
    translation_accuracy: {
        type: DataTypes.FLOAT,
        allowNull: false,
    },
    localization_score: {
        type: DataTypes.FLOAT,
        allowNull: false,
    },
    missing_keys: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    overflow_issues: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    scanned_url: {
        type: DataTypes.STRING(2048),
        allowNull: true,
    },
});

export default LocalizationResult;
