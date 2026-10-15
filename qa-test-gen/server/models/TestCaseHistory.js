import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const TestCaseHistory = sequelize.define('test_case_history', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    user_id: {
        type: DataTypes.UUID,
        allowNull: false,
    },
    email: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    project_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'projects', key: 'id' },
    },
    story_key: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    story_description: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    business_rules: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    regression_context: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    tech_details: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    test_cases: {
        type: DataTypes.JSONB,
        allowNull: false,
    },
}, {
    tableName: 'test_case_history',
    timestamps: true,
});

export default TestCaseHistory;
