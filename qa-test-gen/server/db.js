import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

// Connection-string resolution, in order of precedence:
//   1. DATABASE_URL — used by local dev (set in .env)
//   2. DB_HOST / DB_PORT / DB_USER / DB_NAME / DB_PASSWORD_FILE — set by
//      docker-compose.yml in deployed environments. Password comes from a
//      file-mounted Docker secret at /run/secrets/db_password (Compose's
//      non-swarm secret model writes secrets to files, not env vars).
//   3. Hardcoded fallback for first-time local-dev runs without .env.
function resolveDatabaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

    const host = process.env.DB_HOST;
    if (host) {
        const port = process.env.DB_PORT || '5432';
        const user = process.env.DB_USER || 'aaqua_app';
        const name = process.env.DB_NAME || 'aaqua_security';
        const passwordFile = process.env.DB_PASSWORD_FILE || '/run/secrets/db_password';
        let password = process.env.DB_PASSWORD || '';
        if (!password && fs.existsSync(passwordFile)) {
            password = fs.readFileSync(passwordFile, 'utf8').trim();
        }
        const auth = password ? `${user}:${encodeURIComponent(password)}` : user;
        return `postgresql://${auth}@${host}:${port}/${name}`;
    }
    return 'postgresql://aaqua:aaqua@localhost:5433/aaqua_security';
}

const DATABASE_URL = resolveDatabaseUrl();

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
