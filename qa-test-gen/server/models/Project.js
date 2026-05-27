import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const Project = sequelize.define('projects', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    name: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    target_url: {
        type: DataTypes.STRING(2048),
        allowNull: false,
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    auth_username: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    auth_password: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    login_url: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    // Keycloak `sub` claim — stable per-realm user identity.
    owner_id: {
        type: DataTypes.UUID,
        allowNull: false,
    },
    git_url: {
        type: DataTypes.STRING(2048),
        allowNull: true,
    },
});

export default Project;
