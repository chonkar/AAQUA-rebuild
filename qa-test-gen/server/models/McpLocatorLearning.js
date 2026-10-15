import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const McpLocatorLearning = sequelize.define('mcp_locator_learnings', {
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
    url: {
        type: DataTypes.STRING(2048),
        allowNull: false,
    },
    action_key: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    selector: {
        type: DataTypes.STRING(2048),
        allowNull: false,
    },
    confidence: {
        type: DataTypes.DOUBLE,
        allowNull: false,
        defaultValue: 1.0,
    },
    user_provided: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    times_used: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
    },
});

export default McpLocatorLearning;
