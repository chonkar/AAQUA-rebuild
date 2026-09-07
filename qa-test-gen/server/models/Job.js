import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const Job = sequelize.define('jobs', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    type: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'pending',
    },
    progress: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    phase: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    payload: {
        type: DataTypes.JSONB,
        allowNull: true,
    },
    result: {
        type: DataTypes.JSONB,
        allowNull: true,
    },
    error: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    // Keycloak `sub` claim — stable per-realm user identity.
    owner_id: {
        type: DataTypes.STRING,
        allowNull: true,
    },
});

export default Job;
