import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const McpServer = sequelize.define('mcp_servers', {
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
    name: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    url: {
        type: DataTypes.STRING(2048),
        allowNull: false,
    },
    type: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'sse', // 'sse' or 'stdio' or 'builtin'
    },
    status: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'inactive', // 'active', 'inactive', 'failed'
    },
});

export default McpServer;
