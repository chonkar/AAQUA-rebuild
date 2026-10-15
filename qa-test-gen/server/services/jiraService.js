import dotenv from 'dotenv';
dotenv.config();

const JIRA_ENABLED = process.env.JIRA_ENABLED === 'true';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || '';

function sanitizeJiraUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
        const trimmed = rawUrl.trim();
        // If it starts with http:// or https://, parse it as a URL
        if (/^https?:\/\//i.test(trimmed)) {
            const parsed = new URL(trimmed);
            return `${parsed.protocol}//${parsed.host}`;
        }
        // Fallback for simple domain strings
        return trimmed;
    } catch {
        return rawUrl.trim();
    }
}

const JIRA_URL = sanitizeJiraUrl(process.env.JIRA_URL || '');



/**
 * Helper to recursively parse Jira ADF (Atlassian Document Format) description to clean text
 */
function parseADF(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.type === 'text') return node.text || '';
    if (node.content && Array.isArray(node.content)) {
        return node.content.map(parseADF).join(' ');
    }
    return '';
}

/**
 * Fetch a User Story/Task description from JIRA
 */
export async function fetchJiraStory(issueKey, customConfig = {}) {
    const url = sanitizeJiraUrl(customConfig.url || JIRA_URL);
    const email = customConfig.email || JIRA_EMAIL;
    const token = customConfig.token || JIRA_TOKEN;

    if (!url || !email || !token) {
        throw new Error('Jira is not configured. Please supply Jira credentials in settings or .env');
    }
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    
    // Try Jira API v3 first (standard for Jira Cloud), fallback to v2 (Jira Server/Data Center)
    let response = await fetch(`${url}/rest/api/3/issue/${issueKey}?fields=summary,description`, {
        method: 'GET',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
        },
    });

    if (!response.ok && response.status === 404) {
        response = await fetch(`${url}/rest/api/2/issue/${issueKey}?fields=summary,description`, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Accept': 'application/json',
            },
        });
    }

    if (!response.ok) {
        const text = await response.text();
        let errorDetails = text;
        try {
            const errObj = JSON.parse(text);
            if (errObj.errorMessages && errObj.errorMessages.length > 0) {
                errorDetails = errObj.errorMessages.join(', ');
            }
        } catch { /* ignore */ }

        if (response.status === 404) {
            throw new Error(`Jira fetch failed (404 Not Found): ${errorDetails}. Please verify that Issue Key "${issueKey}" exists, the Jira URL is correct, and your API token account has permission to view it.`);
        }
        throw new Error(`Jira fetch failed (${response.status}): ${errorDetails}`);
    }

    const data = await response.json();
    const summary = data.fields?.summary || 'Untitled Story';
    
    // Log all fields that are not null to see where data might be
    if (data.fields) {
        const activeFields = Object.keys(data.fields).filter(k => data.fields[k] !== null);
        console.log('[Jira Service] Non-null JIRA fields:', activeFields);
        activeFields.forEach(k => {
            if (typeof data.fields[k] === 'string' && data.fields[k].length > 0) {
                console.log(`  - field "${k}": "${data.fields[k].substring(0, 60)}..."`);
            }
        });
    }

    let description = '';
    
    // Parse description if it's ADF (Atlassian Document Format)
    const descObj = data.fields?.description;
    if (descObj) {
        if (typeof descObj === 'string') {
            description = descObj;
        } else if (descObj.content) {
            description = parseADF(descObj).trim();
        }
    }

    console.log(`[Jira Service] Result for ${issueKey} - Summary: "${summary}", Description Length: ${description ? description.length : 0} chars`);

    return {
        key: issueKey,
        title: summary,
        description: description || 'No description provided.',
    };
}

/**
 * Upload an Excel file as an attachment to a Jira User Story/Task
 */
export async function attachExcelToJiraStory(issueKey, excelBuffer, filename = 'Functional_Test_Cases.xlsx', customConfig = {}) {
    const url = sanitizeJiraUrl(customConfig.url || JIRA_URL);
    const email = customConfig.email || JIRA_EMAIL;
    const token = customConfig.token || JIRA_TOKEN;

    if (!url || !email || !token) {
        throw new Error('Jira is not configured. Please supply Jira credentials in settings or .env');
    }
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    
    // Use native FormData and Blob (Node 18+)
    const formData = new FormData();
    const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    formData.append('file', blob, filename);

    const response = await fetch(`${url}/rest/api/3/issue/${issueKey}/attachments`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'X-Atlassian-Token': 'no-check',
        },
        body: formData,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira attachment upload failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    return data;
}

/**
 * Create a Bug defect ticket in JIRA for an accessibility (a11y) issue.
 *
 * Handles both shapes the AccessibilityScanner surfaces:
 *  - Axe-core violation: { source: 'axe', impact, id, description, help, helpUrl, nodes: [{ target }] }
 *  - AI Audit issue:    { source: 'ai',  severity, wcag, issue, whyItMatters, recommendedFix, affectedUsers }
 *
 * The two sources have very different fields; we normalize into a single
 * Bug ticket with a description that reads naturally regardless of origin.
 */
export async function createAccessibilityDefect(issue, projectName, scannedUrl, customConfig = {}) {
    const url = sanitizeJiraUrl(customConfig.url || JIRA_URL);
    const email = customConfig.email || JIRA_EMAIL;
    const token = customConfig.token || JIRA_TOKEN;
    const projectKey = customConfig.projectKey || JIRA_PROJECT_KEY;

    if (!url || !email || !token || !projectKey) {
        throw new Error('Jira is not configured. Please supply Jira credentials in settings or .env');
    }

    const isAxe = issue.source === 'axe';
    const severityRaw = isAxe ? issue.impact : issue.severity;
    const severity = (severityRaw || 'moderate').toLowerCase();

    // Map a11y severity → JIRA priority. Axe uses minor/moderate/serious/critical,
    // AI uses Critical/Serious/Moderate — both fold into this table.
    const priorityMap = {
        critical: 'Highest',
        serious:  'High',
        moderate: 'Medium',
        minor:    'Low',
    };
    const priority = priorityMap[severity] || 'Medium';

    const title = isAxe
        ? `[A11y] ${issue.id || 'Violation'} — ${(issue.help || issue.description || '').slice(0, 80)}`
        : `[A11y] ${issue.wcag || 'WCAG'} — ${(issue.issue || '').slice(0, 80)}`;

    const descParts = [
        `♿ Accessibility defect raised from AAQUA Accessibility Scanner.`,
        ``,
        `Project: ${projectName || 'N/A'}`,
        `Page URL: ${scannedUrl || 'N/A'}`,
        `Severity: ${severityRaw || 'Unknown'}`,
    ];

    if (isAxe) {
        descParts.push(
            `Rule ID: ${issue.id || 'N/A'}`,
            `WCAG Reference: ${issue.helpUrl || 'See axe-core documentation'}`,
            ``,
            `--- Description ---`,
            issue.description || 'No description provided.',
            ``,
            `--- How to fix ---`,
            issue.help || 'See axe-core help for this rule.',
        );
        if (Array.isArray(issue.nodes) && issue.nodes.length > 0) {
            descParts.push(``, `--- Affected DOM nodes (${issue.nodes.length}) ---`);
            for (const node of issue.nodes.slice(0, 10)) {
                const selector = Array.isArray(node.target) ? node.target.join(' ') : (node.target || '');
                descParts.push(`  ${selector}`);
            }
            if (issue.nodes.length > 10) {
                descParts.push(`  ...and ${issue.nodes.length - 10} more`);
            }
        }
    } else {
        descParts.push(
            `WCAG Reference: ${issue.wcag || 'N/A'}`,
            `Affected Users: ${Array.isArray(issue.affectedUsers) ? issue.affectedUsers.join(', ') : (issue.affectedUsers || 'N/A')}`,
            ``,
            `--- Issue ---`,
            issue.issue || 'No description provided.',
            ``,
            `--- Why it matters ---`,
            issue.whyItMatters || 'N/A',
            ``,
            `--- Recommended fix ---`,
            issue.recommendedFix || 'N/A',
        );
    }

    const body = {
        fields: {
            project: { key: projectKey },
            summary: title,
            description: {
                type: 'doc',
                version: 1,
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: descParts.join('\n') }],
                    },
                ],
            },
            issuetype: { name: 'Bug' },
            priority: { name: priority },
            labels: ['accessibility', 'wcag', isAxe ? 'axe-core' : 'ai-audit', severity],
        },
    };

    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const response = await fetch(`${url}/rest/api/3/issue`, {
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
        throw new Error(`Jira Bug creation failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    return { key: data.key, url: `${url}/browse/${data.key}` };
}

/**
 * Create a Bug defect ticket in JIRA for a localization issue.
 *
 * Issue shape from the LocalizationTester:
 *   { original, suggestion, context }
 * Plus the target language and the URL of the page that was scanned.
 *
 * Localization issues are all functionally "leaks" — untranslated English on
 * a non-English page (or wrong dialect for en-US/en-GB) — so we default to
 * Medium priority. Callers can override via `priority` on the issue payload
 * if the workflow ever needs it.
 */
export async function createLocalizationDefect(issue, projectName, scannedUrl, targetLanguage, customConfig = {}) {
    const url = sanitizeJiraUrl(customConfig.url || JIRA_URL);
    const email = customConfig.email || JIRA_EMAIL;
    const token = customConfig.token || JIRA_TOKEN;
    const projectKey = customConfig.projectKey || JIRA_PROJECT_KEY;

    if (!url || !email || !token || !projectKey) {
        throw new Error('Jira is not configured. Please supply Jira credentials in settings or .env');
    }

    const priority = issue.priority || 'Medium';
    const original = (issue.original || '').toString().trim();
    const suggestion = (issue.suggestion || '').toString().trim();
    const context = (issue.context || '').toString().trim();

    const title = `[L10n] ${targetLanguage || 'Untranslated'} — "${original.slice(0, 70)}"`;

    const descParts = [
        `🌐 Localization defect raised from AAQUA Localization Tester.`,
        ``,
        `Project: ${projectName || 'N/A'}`,
        `Page URL: ${scannedUrl || 'N/A'}`,
        `Target Language: ${targetLanguage || 'N/A'}`,
        ``,
        `--- Found (untranslated / wrong dialect) ---`,
        original || '(empty)',
        ``,
        `--- Suggested ---`,
        suggestion || '(none provided)',
    ];
    if (context) {
        descParts.push(``, `--- Context ---`, context);
    }

    const body = {
        fields: {
            project: { key: projectKey },
            summary: title,
            description: {
                type: 'doc',
                version: 1,
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: descParts.join('\n') }],
                    },
                ],
            },
            issuetype: { name: 'Bug' },
            priority: { name: priority },
            labels: ['localization', 'l10n', (targetLanguage || 'unknown').toLowerCase().replace(/[^a-z0-9-]+/g, '-')],
        },
    };

    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const response = await fetch(`${url}/rest/api/3/issue`, {
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
        throw new Error(`Jira Bug creation failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    return { key: data.key, url: `${url}/browse/${data.key}` };
}



/**
 * Create a Bug defect ticket in JIRA for a failed manual test case
 */
export async function createDefectTicket(testCase, actualResult, projectName, customConfig = {}) {
    const url = sanitizeJiraUrl(customConfig.url || JIRA_URL);
    const email = customConfig.email || JIRA_EMAIL;
    const token = customConfig.token || JIRA_TOKEN;
    const projectKey = customConfig.projectKey || JIRA_PROJECT_KEY;

    if (!url || !email || !token || !projectKey) {
        throw new Error('Jira is not configured. Please supply Jira credentials in settings or .env');
    }

    const priorityMap = {
        'P1-Critical': 'Highest',
        'P2-High': 'High',
        'P3-Medium': 'Medium',
        'P4-Low': 'Lowest',
    };
    const priority = priorityMap[testCase.priority] || 'Medium';

    const descParts = [
        `🐞 Defect raised from AAQUA Functional Test Case workbench.`,
        ``,
        `Project: ${projectName}`,
        `Module: ${testCase.module}`,
        `Feature: ${testCase.feature}`,
        `Scenario: ${testCase.scenario}`,
        ``,
        `--- Step-by-Step Instructions ---`,
        ...(Array.isArray(testCase.steps) ? testCase.steps : [testCase.steps || '']),
        ``,
        `--- Expected Result ---`,
        testCase.expectedResult,
        ``,
        `--- Actual Output / Observation ---`,
        actualResult || 'Failed during manual execution verification.',
    ];

    const body = {
        fields: {
            project: { key: projectKey },
            summary: `[Defect] Failed Test: ${testCase.scenario} — ${projectName}`,
            description: {
                type: 'doc',
                version: 1,
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: descParts.join('\n') }],
                    },
                ],
            },
            issuetype: { name: 'Bug' },
            priority: { name: priority },
            labels: ['defect', 'qa-test-case-failure', testCase.priority.toLowerCase()],
        },
    };

    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const response = await fetch(`${url}/rest/api/3/issue`, {
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
        throw new Error(`Jira Bug creation failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    return data.key;
}
