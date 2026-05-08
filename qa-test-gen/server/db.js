import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://aaqua:aaqua@localhost:5433/aaqua_security';

const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    logging: process.env.DB_LOGGING === 'true' ? console.log : false,
    pool: {
        max: 10,
        min: 2,
        acquire: 30000,
        idle: 10000,
    },
    define: {
        underscored: true,   // snake_case column names
        timestamps: true,     // createdAt, updatedAt
        freezeTableName: true,
        schema: 'public',     // pin app tables to public; keycloak schema is off-limits
    },
    dialectOptions: {
        // Lock the search_path so sync({ alter: true }) cannot reach the keycloak schema.
        options: '-c search_path=public',
    },
});

export default sequelize;
