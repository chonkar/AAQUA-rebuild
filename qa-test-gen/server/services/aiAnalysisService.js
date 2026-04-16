import { LocalLLM as GoogleGenerativeAI } from '../utils/llmClient.js';
import dotenv from 'dotenv';
import { generateWithRetry } from '../utils/aiUtils.js';
dotenv.config();

const GEMINI_API_KEY = process.env.VITE_LLM_API_KEY;
const LLM_ENDPOINT = process.env.VITE_LLM_ENDPOINT;
const LLM_MODEL = process.env.VITE_LLM_MODEL || 'gpt-oss-20b';
/**
 * Analyze vulnerabilities using Gemini AI
 * Processes in batches to minimize API calls
 *
 * @param {Array} alerts - Array of ZAP alert objects
 * @returns {Array} Enriched vulnerability objects with AI analysis
 */
export async function analyzeVulnerabilities(alerts) {
    if (!GEMINI_API_KEY) {
        console.warn('[AI] No Gemini API key found — skipping AI analysis');
        return alerts.map(alert => ({
            ...mapAlertToVuln(alert),
            ai_summary: null,
            owasp_category: null,
            risk_score: getDefaultRiskScore(mapRiskLevel(alert.risk)),
            exploitability: null,
            remediation: alert.solution || null,
            code_example: null,
        }));
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY, LLM_ENDPOINT);
    const model = genAI.getGenerativeModel({ model: LLM_MODEL });

    const BATCH_SIZE = 5;
    const results = [];

    for (let i = 0; i < alerts.length; i += BATCH_SIZE) {
        const batch = alerts.slice(i, i + BATCH_SIZE);
        console.log(`[AI] Analyzing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(alerts.length / BATCH_SIZE)}`);

        try {
            const enriched = await analyzeBatch(model, batch);
            results.push(...enriched);
        } catch (err) {
            // Fallback: return unenriched data
            console.log(`[AI] Falling back to default risk scores for batch due to: ${err.message}`);
            results.push(...batch.map(a => ({
                ...mapAlertToVuln(a),
                ai_summary: `AI Security Insight unavailable (Rate Limit reached). Basic risk analysis applied.`,
                owasp_category: null,
                risk_score: getDefaultRiskScore(mapRiskLevel(a.risk)),
                exploitability: null,
                remediation: a.solution || null,
                code_example: null,
            })));
        }

        // Rate limit: small delay between batches
        if (i + BATCH_SIZE < alerts.length) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    return results;
}

/**
 * Map a raw ZAP alert to our vulnerability structure
 */
function mapAlertToVuln(alert) {
    return {
        alert_name: alert.alert || alert.name || 'Unknown',
        risk: mapRiskLevel(alert.risk),
        confidence: alert.confidence || 'Low',
        description: alert.description || '',
        url: alert.url || alert.uri || '',
        solution: alert.solution || '',
        reference: alert.reference || '',
        cwe_id: parseInt(alert.cweid, 10) || null,
        wasc_id: parseInt(alert.wascid, 10) || null,
    };
}

/**
 * Map ZAP risk levels to our enum
 */
function mapRiskLevel(zapRisk) {
    const map = {
        '0': 'Informational',
        '1': 'Low',
        '2': 'Medium',
        '3': 'High',
        'Informational': 'Informational',
        'Low': 'Low',
        'Medium': 'Medium',
        'High': 'High',
        'Critical': 'Critical',
    };
    return map[zapRisk] || 'Informational';
}

/**
 * Get a default numeric risk score based on severity level
 */
function getDefaultRiskScore(risk) {
    const scores = {
        'Critical': 9.5,
        'High': 8.0,
        'Medium': 5.0,
        'Low': 2.5,
        'Informational': 0.0
    };
    return scores[risk] || 0.0;
}

/**
 * Analyze a batch of alerts using Gemini
 */
async function analyzeBatch(model, alerts) {
    const alertSummaries = alerts.map((a, i) => {
        return `[${i + 1}] Name: "${a.alert || a.name}"
Risk: ${a.risk} | CWE: ${a.cweid || 'N/A'}
URL: ${a.url || 'N/A'}
Description: ${(a.description || '').substring(0, 300)}
Solution: ${(a.solution || '').substring(0, 200)}`;
    }).join('\n\n');

    const prompt = `You are a senior application security engineer. Analyze these OWASP ZAP scan findings and provide structured analysis.

For EACH vulnerability below, provide:
1. "ai_summary" — Plain-language explanation of the vulnerability (2-3 sentences, understandable by a non-technical manager)
2. "owasp_category" — Which OWASP Top 10 (2021) category it maps to (e.g., "A01:2021 - Broken Access Control")
3. "risk_score" — Numeric risk score from 1.0 to 10.0 based on impact + exploitability
4. "exploitability" — One of: "Low", "Medium", "High", "Critical"
5. "remediation" — Step-by-step remediation advice (3-5 actionable steps)
6. "code_example" — A secure coding example that fixes this type of vulnerability (use appropriate language, 5-15 lines)

VULNERABILITIES:
${alertSummaries}

Respond with a VALID JSON array only. Each item must have keys: index (1-based), ai_summary, owasp_category, risk_score, exploitability, remediation, code_example.
DO NOT include any text outside the JSON array.`;

    const text = await generateWithRetry(model, prompt);

    // Extract JSON from response
    let parsed;
    try {
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array found in AI response');
        parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error('[AI] Failed to parse response:', err.message);
        throw err;
    }

    // Merge AI analysis with original alert data
    return alerts.map((alert, i) => {
        const ai = parsed.find(p => p.index === i + 1) || {};
        const base = mapAlertToVuln(alert);
        const aiScore = parseFloat(ai.risk_score);
        const finalScore = (!isNaN(aiScore)) ? aiScore : getDefaultRiskScore(base.risk);
        console.log(`[AI] Vulnerability "${base.alert_name}" assigned score: ${finalScore}/10 (AI: ${aiScore || 'N/A'}, Base: ${base.risk})`);
        return {
            ...base,
            ai_summary: ai.ai_summary || null,
            owasp_category: ai.owasp_category || null,
            risk_score: finalScore,
            exploitability: ai.exploitability || null,
            remediation: ai.remediation || base.solution || null,
            code_example: ai.code_example || null,
        };
    });
}

/**
 * Check if a vulnerability is a regression (previously found and reopened)
 * @param {Object} vuln - Current vulnerability
 * @param {Array} previousVulns - Vulnerabilities from previous scans
 * @returns {boolean}
 */
export function checkRegression(vuln, previousVulns) {
    return previousVulns.some(prev =>
        prev.alert_name === vuln.alert_name &&
        prev.url === vuln.url &&
        prev.is_regression === false // Was previously resolved
    );
}
