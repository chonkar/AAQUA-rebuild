import sequelize from './server/db.js';
import { Project } from './server/models/index.js';

async function check() {
    try {
        await sequelize.authenticate();
        console.log('Database connection authenticated.');
        const projects = await Project.findAll();
        console.log('Projects list:');
        projects.forEach(p => {
            console.log(`ID: ${p.id}, Name: ${p.name}, Target URL: ${p.target_url}`);
        });
    } catch (e) {
        console.error('Error:', e);
    } finally {
        await sequelize.close();
    }
}

check();
