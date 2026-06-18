import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const UserActivity = sequelize.define('user_activity', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    user_id: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    email: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    username: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    name: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    action: {
        type: DataTypes.STRING(1024),
        allowNull: false,
    },
    details: {
        type: DataTypes.JSONB,
        allowNull: true,
    },
    ip_address: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
}, {
    tableName: 'user_activity',
    timestamps: true,
    updatedAt: false, // only createdAt is needed
});

export default UserActivity;
