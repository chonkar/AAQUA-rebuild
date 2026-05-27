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
 * Create a Jira ticket for a security vulnerability.
 *
 * Two modes:
 *  - Auto-creation during scan completion (called by createTicketsForCriticalHigh)
 *    uses env-var config and returns null on missing config so the scan keeps going.
 *  - Manual creation from the UI passes customConfig — in that case missing config
 *    THROWS so the user sees a clear "Jira is not configured" message instead of a
 *    silent no-op.
 *
 * @returns {{ key: string, url: string } | null}
 */
export async function createJiraTicket(vuln, projectName, customConfig = null) {
    const useCustom = customConfig && (customConfig.url || customConfig.email || customConfig.token || customConfig.projectKey);

    const url = sanitizeJiraUrl((customConfig?.url) || JIRA_URL);
    const email = customConfig?.email || JIRA_EMAIL;
    const token = customConfig?.token || JIRA_TOKEN;
    const projectKey = customConfig?.projectKey || JIRA_PROJECT_KEY;

    // Auto-creation path: respect the JIRA_ENABLED toggle and skip silently
    // if config is missing — the calling scan must not fail because Jira isn't set up.
    if (!useCustom) {
        if (!JIRA_ENABLED) {
            console.log('[Jira] Integration disabled — skipping ticket creation');
            return null;
        }
        if (!url || !email || !token || !projectKey) {
            console.warn('[Jira] Missing configuration — check JIRA_URL, JIRA_EMAIL, JIRA_TOKEN, JIRA_PROJECT_KEY');
            return null;
        }
    } else {
        // Manual path: user invoked this from the UI — throw on missing config.
        if (!url || !email || !token || !projectKey) {
            throw new Error('Jira is not configured. Please supply Jira credentials in settings or .env');
        }
    }

    const priority = vuln.risk === 'Critical' ? 'Highest' : 'High';
    const description = buildJiraDescription(vuln, projectName);

    const body = {
        fields: {
            project: { key: projectKey },
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
            console.error(`[Jira] Failed to create ticket: ${response.status} ${text}`);
            if (useCustom) {
                throw new Error(`Jira Bug creation failed: ${response.status} ${text}`);
            }
            return null;
        }

        const data = await response.json();
        console.log(`[Jira] Created ticket: ${data.key}`);
        return { key: data.key, url: `${url}/browse/${data.key}` };
    } catch (err) {
        console.error(`[Jira] Error creating ticket:`, err.message);
        if (useCustom) throw err;
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
        const result = await createJiraTicket(vuln, projectName);
        if (result?.key) {
            tickets.push({ vulnerability_id: vuln.id, jira_key: result.key });
        }
        // Rate limit Jira API calls
        await new Promise(r => setTimeout(r, 500));
    }

    return tickets;
}

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
    const response = await fetch(`${url}/rest/api/2/issue/${issueKey}?fields=summary,description`, {
        method: 'GET',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira fetch failed: ${response.status} ${text}`);
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
 * Create a JIRA Bug for a performance finding (Lighthouse score + Core Web
 * Vitals + top opportunities, plus the optional AI triage summary).
 */
export async function createPerformanceDefect(perf, projectName, scannedUrl, customConfig = {}) {
    const url = sanitizeJiraUrl(customConfig.url || JIRA_URL);
    const email = customConfig.email || JIRA_EMAIL;
    const token = customConfig.token || JIRA_TOKEN;
    const projectKey = customConfig.projectKey || JIRA_PROJECT_KEY;

    if (!url || !email || !token || !projectKey) {
        throw new Error('Jira is not configured. Please supply Jira credentials in settings or .env');
    }

    const score = perf && perf.score != null ? perf.score : 'N/A';
    const m = (perf && perf.metrics) || {};
    const opps = Array.isArray(perf && perf.opportunities) ? perf.opportunities : [];
    const priority = typeof score === 'number' && score < 50 ? 'High' : (typeof score === 'number' && score < 90 ? 'Medium' : 'Low');
    const host = String(scannedUrl || '').replace(/^https?:\/\//, '').slice(0, 60);
    const title = `[Perf] Lighthouse score ${score} — ${host}`;

    const descParts = [
        `⚡ Performance defect raised from AAQUA Performance Scanner.`,
        ``,
        `Project: ${projectName || 'N/A'}`,
        `Page URL: ${scannedUrl || 'N/A'}`,
        `Lighthouse Performance score: ${score}/100`,
        ``,
        `--- Core Web Vitals ---`,
        `LCP: ${m.lcp ?? '?'} ms | CLS: ${m.cls ?? '?'} | TBT: ${m.tbt ?? '?'} ms | TTFB: ${m.ttfb ?? '?'} ms`,
        ``,
        `--- Top Opportunities ---`,
        ...(opps.length ? opps.map(o => `- ${o.title}${o.savingsMs ? ` (~${o.savingsMs} ms savings)` : ''}`) : ['(none flagged)']),
    ];
    if (perf && perf.aiSummary) {
        descParts.push(``, `--- AI Triage ---`, perf.aiSummary);
    }

    const body = {
        fields: {
            project: { key: projectKey },
            summary: title,
            description: {
                type: 'doc',
                version: 1,
                content: [{ type: 'paragraph', content: [{ type: 'text', text: descParts.join('\n') }] }],
            },
            issuetype: { name: 'Bug' },
            priority: { name: priority },
            labels: ['performance', 'web-vitals'],
        },
    };

    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const response = await fetch(`${url}/rest/api/3/issue`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
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
