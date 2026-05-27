import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const AutomationResult = sequelize.define('automation_results', {
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
    pass_rate: {
        type: DataTypes.FLOAT,
        allowNull: false,
    },
    flaky_index: {
        type: DataTypes.FLOAT,
        allowNull: true,
    },
    failed_tests: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    total_tests: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    duration: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
});

export default AutomationResult;
