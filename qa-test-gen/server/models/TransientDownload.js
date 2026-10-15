import { DataTypes } from 'sequelize';
import sequelize from '../db.js';

const TransientDownload = sequelize.define('transient_download', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    filename: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    contentType: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    base64Data: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
    },
}, {
    tableName: 'transient_downloads',
    timestamps: true,
});

export default TransientDownload;
