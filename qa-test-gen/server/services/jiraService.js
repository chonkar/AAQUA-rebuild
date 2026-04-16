import dotenv from 'dotenv';
dotenv.config();

const JIRA_ENABLED = process.env.JIRA_ENABLED === 'true';
const JIRA_URL = process.env.JIRA_URL || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || '';

/**
 * Create a Jira ticket for a critical/high vulnerability
 *
 * @param {Object} vuln - Vulnerability record
 * @param {string} projectName - Project name for context
 * @returns {string|null} Jira issue key (e.g., "SEC-123") or null if disabled
 */
export async function createJiraTicket(vuln, projectName) {
    if (!JIRA_ENABLED) {
        console.log('[Jira] Integration disabled — skipping ticket creation');
        return null;
    }

    if (!JIRA_URL || !JIRA_EMAIL || !JIRA_TOKEN || !JIRA_PROJECT_KEY) {
        console.warn('[Jira] Missing configuration — check JIRA_URL, JIRA_EMAIL, JIRA_TOKEN, JIRA_PROJECT_KEY');
        return null;
    }

    const priority = vuln.risk === 'Critical' ? 'Highest' : 'High';

    const description = buildJiraDescription(vuln, projectName);

    const body = {
        fields: {
            project: { key: JIRA_PROJECT_KEY },
            summary: `[${vuln.risk}] ${vuln.alert_name} — ${projectName}`,
            description: {
                type: 'doc',
                version: 1,
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: description }],
                    },
                ],
            },
            issuetype: { name: 'Bug' },
            priority: { name: priority },
            labels: ['security', 'owasp-zap', vuln.risk.toLowerCase()],
        },
    };

    try {
        const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
        const response = await fetch(`${JIRA_URL}/rest/api/3/issue`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text();
            console.error(`[Jira] Failed to create ticket: ${response.status} ${text}`);
            return null;
        }

        const data = await response.json();
        console.log(`[Jira] Created ticket: ${data.key}`);
        return data.key;
    } catch (err) {
        console.error(`[Jira] Error creating ticket:`, err.message);
        return null;
    }
}

/**
 * Build Jira ticket description with AI analysis
 */
function buildJiraDescription(vuln, projectName) {
    const parts = [
        `🔒 Security Vulnerability: ${vuln.alert_name}`,
        ``,
        `Project: ${projectName}`,
        `Risk Level: ${vuln.risk}`,
        `URL: ${vuln.url || 'N/A'}`,
        `OWASP Category: ${vuln.owasp_category || 'N/A'}`,
        `CWE: ${vuln.cwe_id || 'N/A'}`,
        `Risk Score: ${vuln.risk_score || 'N/A'}/10`,
        `Exploitability: ${vuln.exploitability || 'N/A'}`,
        ``,
        `--- AI Summary ---`,
        vuln.ai_summary || vuln.description || 'No summary available.',
        ``,
        `--- Remediation Steps ---`,
        vuln.remediation || vuln.solution || 'No remediation available.',
        ``,
    ];

    if (vuln.code_example) {
        parts.push(`--- Secure Code Example ---`);
        parts.push(vuln.code_example);
    }

    if (vuln.is_regression) {
        parts.push(``, `⚠️ REGRESSION: This vulnerability was previously resolved and has reappeared.`);
    }

    return parts.join('\n');
}

/**
 * Bulk-create Jira tickets for all critical/high vulnerabilities
 */
export async function createTicketsForCriticalHigh(vulnerabilities, projectName) {
    if (!JIRA_ENABLED) return [];

    const critHigh = vulnerabilities.filter(v =>
        v.risk === 'Critical' || v.risk === 'High'
    );

    console.log(`[Jira] Creating tickets for ${critHigh.length} critical/high vulnerabilities`);

    const tickets = [];
    for (const vuln of critHigh) {
        const key = await createJiraTicket(vuln, projectName);
        if (key) {
            tickets.push({ vulnerability_id: vuln.id, jira_key: key });
        }
        // Rate limit Jira API calls
        await new Promise(r => setTimeout(r, 500));
    }

    return tickets;
}
