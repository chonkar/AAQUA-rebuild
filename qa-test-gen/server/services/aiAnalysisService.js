import { LocalLLM as GoogleGenerativeAI } from '../utils/llmClient.js';
import dotenv from 'dotenv';
import { generateWithRetry } from '../utils/aiUtils.js';
dotenv.config();

const LLM_API_KEY = process.env.VITE_LLM_API_KEY;
const LLM_ENDPOINT = process.env.VITE_LLM_ENDPOINT;
const LLM_MODEL = process.env.VITE_LLM_MODEL || 'gemma-4';
/**
 * Analyze vulnerabilities using Local LLM
 * Processes in batches to minimize API calls
 *
 * @param {Array} alerts - Array of ZAP alert objects
 * @returns {Array} Enriched vulnerability objects with AI analysis
 */
/**
 * analyzeVulnerabilities
 * ---------------------
 * Takes an array of ZAP alerts and optionally a progress callback.
 * Performs batched calls to the Local LLM to enrich each alert with AI‑generated
 * insights such as a plain‑language summary, OWASP category, risk score, exploitability,
 * remediation steps and a secure code example.
 *
 * The function respects the LLM API key presence; if missing it gracefully falls back
 * to returning the raw alerts with default risk scores.
 *
 * Batching (default size 5) reduces the number of LLM calls and introduces a small
 * delay between batches to avoid rate‑limit errors.
 *
 * @param {Array} alerts - Raw ZAP alert objects.
 * @param {function} [onProgress] - Optional callback invoked after each batch with
 *                                 (batchIndex, totalBatches).
 * @returns {Array} Array of enriched vulnerability objects.
 */
export async function analyzeVulnerabilities(alerts, onProgress) {
    if (!LLM_API_KEY) {
        console.warn('[AI] No Local LLM API key found — skipping AI analysis');
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

    const genAI = new GoogleGenerativeAI(LLM_API_KEY, LLM_ENDPOINT);
    const model = genAI.getGenerativeModel({ 
        model: LLM_MODEL,
        generationConfig: { temperature: 0.2 }
    });

    const BATCH_SIZE = 5;
    const results = [];
    const totalBatches = Math.ceil(alerts.length / BATCH_SIZE);

    for (let i = 0; i < alerts.length; i += BATCH_SIZE) {
        const batch = alerts.slice(i, i + BATCH_SIZE);
        const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
        console.log(`[AI] Analyzing batch ${batchIndex}/${totalBatches}`);

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

        if (onProgress) {
            onProgress(batchIndex, totalBatches);
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
/**
 * mapAlertToVuln
 * ---------------
 * Normalises a raw ZAP alert into the internal vulnerability shape used by the UI
 * and database. Only the fields required downstream are retained.
 *
 * @param {Object} alert - A ZAP alert object.
 * @returns {Object} Normalised vulnerability representation.
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
/**
 * mapRiskLevel
 * --------------
 * Converts ZAP’s numeric risk level (0‑3) or textual description into a unified
 * string representation used throughout the application.
 *
 * @param {string|number} zapRisk - Risk level from ZAP.
 * @returns {string} Normalised risk string (Informational, Low, Medium, High, Critical).
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
/**
 * getDefaultRiskScore
 * -------------------
 * Provides a fallback numeric risk score when AI analysis is unavailable.
 * The mapping mirrors typical CVSS‑like weighting.
 *
 * @param {string} risk - Normalised risk string.
 * @returns {number} Numeric risk score (0‑9.5).
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
 * Analyze a batch of alerts using Local LLM
 */
/**
 * analyzeBatch
 * ------------
 * Sends a single LLM request for a batch of alerts.
 * Builds a concise prompt containing a summary of each alert and asks the model
 * to return a JSON array with AI‑generated fields for every vulnerability.
 *
 * The function extracts the JSON payload from the LLM response, handling possible
 * markdown wrappers or stray text.
 *
 * @param {Object} model - Initialized generative model instance.
 * @param {Array} alerts - Batch of raw alerts.
 * @returns {Promise<Array>} Parsed AI analysis results.
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

CRITICAL: Output the JSON array of objects wrapped in a markdown \`\`\`json code block. Do NOT include any conversational introduction, explanation, or internal reasoning. Start your response directly with the \`\`\`json code block.

Each item must have exactly these keys: index (1-based), ai_summary, owasp_category, risk_score, exploitability, remediation, code_example.`;

    const text = await generateWithRetry(model, prompt);

    // Extract JSON from response robustly
    let parsed;
    try {
        // Strip markdown backticks if present
        let cleanedText = text.trim();
        if (cleanedText.includes('```')) {
            const matches = cleanedText.match(/```json\s*([\s\S]*?)\s*```/i) || cleanedText.match(/```\s*([\s\S]*?)\s*```/i);
            if (matches) {
                cleanedText = matches[1];
            }
        }
        const jsonMatch = cleanedText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array found in AI response');
        parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error('[AI] Failed to parse response:', err.message);
        console.error('[AI] Raw response was:', text);
        throw err;
    }

    // Merge AI analysis with original alert data
    return alerts.map((alert, i) => {
        const ai = parsed.find(p => p.index === i + 1) || {};
        const base = mapAlertToVuln(alert);
        const aiScore = parseFloat(ai.risk_score);
        const finalScore = (!isNaN(aiScore)) ? aiScore : getDefaultRiskScore(base.risk);
        console.log(`[AI] Vulnerability "${base.alert_name}" assigned score: ${finalScore}/10 (AI: ${aiScore || 'N/A'}, Base: ${base.risk})`);
        // Ensure fields that MUST be strings are not objects/arrays (avoids DB string violations)
        const formatString = (val) => {
            if (!val) return null;
            if (typeof val === 'string') return val;
            if (Array.isArray(val)) return val.join('\n');
            return JSON.stringify(val, null, 2);
        };

        return {
            ...base,
            ai_summary: formatString(ai.ai_summary),
            owasp_category: formatString(ai.owasp_category),
            risk_score: finalScore,
            exploitability: formatString(ai.exploitability),
            remediation: formatString(ai.remediation) || base.solution || null,
            code_example: formatString(ai.code_example),
        };
    });
}

/**
 * Check if a vulnerability is a regression (previously found and reopened)
 * @param {Object} vuln - Current vulnerability
 * @param {Array} previousVulns - Vulnerabilities from previous scans
 * @returns {boolean}
 */
/**
 * checkRegression
 * --------------
 * Determines whether a vulnerability found in the current scan already existed in a
 * previous scan and was previously marked as resolved. This helps flag regressions.
 *
 * @param {Object} vuln - Current vulnerability object.
 * @param {Array} previousVulns - Vulnerabilities from previous scans.
 * @returns {boolean} True if the vulnerability is a regression.
 */
export function checkRegression(vuln, previousVulns) {
    return previousVulns.some(prev =>
        prev.alert_name === vuln.alert_name &&
        prev.url === vuln.url &&
        prev.is_regression === false // Was previously resolved
    );
}
