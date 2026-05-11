import fs from 'fs';
import htmlDocx from 'html-docx-js';

const htmlContent = `
<!DOCTYPE html>
<html>
<head><title>Infrastructure Plan</title></head>
<body>
<h1>Infrastructure Plan: Digihive QA Framework (AAQUA)</h1>

<h2>1. Executive Summary</h2>
<p>This document outlines the infrastructure and architectural design for the Digihive QA Framework (AAQUA). The system is a full-stack web application designed for automated QA testing, accessibility scanning, test data generation, and security testing, powered by local LLMs.</p>

<h2>2. System Architecture Overview</h2>
<ul>
  <li><strong>Frontend (Presentation Layer):</strong> React 19 built with Vite.</li>
  <li><strong>Backend (Application Layer):</strong> Node.js with Express.js.</li>
  <li><strong>Database (Data Layer):</strong> PostgreSQL 16.</li>
  <li><strong>Security Scanner:</strong> OWASP ZAP (Daemon Mode).</li>
  <li><strong>AI Engine:</strong> Local LLM Service (gpt-oss-20b).</li>
</ul>

<h2>3. Component Details</h2>
<h3>3.1 Frontend</h3>
<p>Built using React 19, Vite, and React Router. Served to the client. Uses Tailwind CSS / Custom CSS for styling. Manages state and communicates with backend APIs.</p>

<h3>3.2 Backend APIs</h3>
<p>Node.js server using Express. Features include:</p>
<ul>
  <li><strong>Authentication:</strong> JWT based with bcryptjs for password hashing.</li>
  <li><strong>File Uploads:</strong> Managed via Multer for test data and framework zips.</li>
  <li><strong>Automation Drivers:</strong> Playwright for UI interaction, and Axe-core for accessibility scanning.</li>
  <li><strong>Security:</strong> Express-rate-limit for endpoint protection.</li>
</ul>

<h3>3.3 Database</h3>
<p>PostgreSQL 16 containerized via Docker. Managed via Sequelize ORM. Stores user credentials, test plans, generated test data, and reports.</p>

<h3>3.4 Security Scanning</h3>
<p>OWASP ZAP container running in daemon mode. Provides security scanning capabilities through an API interface. Required resources: 2GB Memory minimum.</p>

<h3>3.5 AI Integration</h3>
<p>Integrated with a local OpenAI-compatible endpoint (<code>https://llm.lab.aaseya.com/v1</code>). Models used include <code>gpt-oss-20b</code>. It handles Test Plan, Test Case, Test Data, Locator, and Accessibility analysis generations.</p>

<h2>4. Deployment Strategy</h2>
<p>The application components are heavily containerized for consistent deployment environments:</p>
<ul>
  <li><strong>Docker Compose:</strong> Manages PostgreSQL (port 5433 mapped to 5432) and OWASP ZAP (port 8080).</li>
  <li><strong>Node Server:</strong> Runs directly or can be containerized. Port mapping handles backend API routing.</li>
  <li><strong>Frontend:</strong> Statically built via Vite (<code>npm run build</code>) and served via Node or Nginx.</li>
</ul>

<h2>5. Resource Requirements (Estimates)</h2>
<ul>
  <li><strong>App Server (Node + React):</strong> 2-4 vCPUs, 4GB RAM (due to Playwright memory usage).</li>
  <li><strong>Database (PostgreSQL):</strong> 2 vCPUs, 4GB RAM.</li>
  <li><strong>Security Scanner (OWASP ZAP):</strong> 2 vCPUs, 2GB RAM minimum limit.</li>
  <li><strong>Storage:</strong> 20GB+ SSD for PostgreSQL data and temporary test artifacts.</li>
</ul>

<h2>6. Security & Compliance</h2>
<p>Database uses trust auth internally but is isolated on the Docker network. The APIs are protected with JWT tokens. Rate limiting is enforced on sensitive endpoints to prevent abuse.</p>
</body>
</html>
`;

try {
  const blob = htmlDocx.asBlob(htmlContent);
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync('Infrastructure_Plan.docx', buffer);
  console.log("Infrastructure_Plan.docx created successfully.");
} catch (e) {
  console.error("Error creating docx:", e);
}
