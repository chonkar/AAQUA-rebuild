import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const AgentRun = sequelize.define('agent_runs', {
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
    goal: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    status: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'running', // 'running', 'completed', 'failed'
    },
    logs: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: '',
    },
    steps: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: '',
    },
    pending_learnings: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: '',
    },
    architect_report: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: '',
    },
});

export default AgentRun;
