import sequelize from '../server/db.js';
import { QueryTypes } from 'sequelize';
import crypto from 'crypto';
import UserActivity from '../server/models/UserActivity.js'; // Ensure UserActivity is registered

async function backfill() {
    try {
        console.log("Syncing database schema to ensure 'name' column is created...");
        await sequelize.sync({ alter: true });
        console.log("Database schema synced.");

        console.log("Starting backfill of user activities from historical scans and projects...");

        // 1. Fetch Keycloak users mapping
        const users = await sequelize.query(
            "SELECT id, email, username, first_name, last_name FROM keycloak.user_entity",
            { type: QueryTypes.SELECT }
        );
        const userMap = new Map();
        users.forEach(u => {
            userMap.set(u.id, {
                email: u.email || 'unknown@aaseya.com',
                username: u.username,
                name: u.first_name && u.last_name ? `${u.first_name} ${u.last_name}` : (u.first_name || u.username)
            });
        });

        // 2. Clear existing UserActivity logs to prevent duplicates
        await sequelize.query("DELETE FROM public.user_activity", { type: QueryTypes.DELETE });
        console.log("Cleared existing user activity logs.");

        // 3. Fetch all projects
        const projects = await sequelize.query(
            "SELECT id, name, owner_id, created_at FROM public.projects",
            { type: QueryTypes.SELECT }
        );

        let projectCount = 0;
        for (const p of projects) {
            const u = userMap.get(p.owner_id) || { email: 'unknown@aaseya.com', username: 'unknown', name: 'Unknown User' };
            await sequelize.query(
                `INSERT INTO public.user_activity (id, user_id, email, username, name, action, ip_address, details, created_at) 
                 VALUES (:id, :user_id, :email, :username, :name, :action, :ip_address, :details, :created_at)`,
                {
                    replacements: {
                        id: crypto.randomUUID(),
                        user_id: p.owner_id,
                        email: u.email,
                        username: u.username,
                        name: u.name,
                        action: `POST /api/projects (Created project: ${p.name})`,
                        ip_address: '127.0.0.1',
                        details: JSON.stringify({ systemGenerated: true }),
                        created_at: p.created_at
                    },
                    type: QueryTypes.INSERT
                }
            );
            projectCount++;
        }
        console.log(`Backfilled ${projectCount} project creation activities.`);

        // 4. Fetch all scans
        const scans = await sequelize.query(
            "SELECT id, scan_type, target_url, initiated_by, created_at FROM public.scans",
            { type: QueryTypes.SELECT }
        );

        let scanCount = 0;
        for (const s of scans) {
            if (!s.initiated_by) continue;
            const u = userMap.get(s.initiated_by) || { email: 'unknown@aaseya.com', username: 'unknown', name: 'Unknown User' };
            await sequelize.query(
                `INSERT INTO public.user_activity (id, user_id, email, username, name, action, ip_address, details, created_at) 
                 VALUES (:id, :user_id, :email, :username, :name, :action, :ip_address, :details, :created_at)`,
                {
                    replacements: {
                        id: crypto.randomUUID(),
                        user_id: s.initiated_by,
                        email: u.email,
                        username: u.username,
                        name: u.name,
                        action: `POST /api/security/scan/start (Triggered ${s.scan_type} scan on ${s.target_url})`,
                        ip_address: '127.0.0.1',
                        details: JSON.stringify({ systemGenerated: true }),
                        created_at: s.created_at
                    },
                    type: QueryTypes.INSERT
                }
            );
            scanCount++;
        }
        console.log(`Backfilled ${scanCount} scan trigger activities.`);
        
        console.log("Backfill completed successfully.");
    } catch (err) {
        console.error("Backfill failed:", err);
    } finally {
        await sequelize.close();
    }
}

backfill();
