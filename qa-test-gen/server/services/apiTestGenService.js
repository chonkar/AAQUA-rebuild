import { LocalLLM as GoogleGenerativeAI } from '../utils/llmClient.js';
import { generateWithRetry } from '../utils/aiUtils.js';

/**
 * API test-case generation (Phase A2).
 *
 * Turns the normalized endpoint catalog from apiSpecService into an abstract,
 * framework-agnostic set of test cases per endpoint. This JSON is what the
 * Phase A3 emitters (REST Assured / Playwright) render into real code — keeping
 * "what to test" (LLM) separate from "how to write it" (templates).
 */

const ALL_CATEGORIES = ['positive', 'negative', 'auth', 'schema', 'boundary'];

const CATEGORY_HINTS = {
    positive: 'a valid request that should succeed (2xx)',
    negative: "an invalid request that violates THIS endpoint's own parameters or body (a missing required field, a wrong type, or a value outside an allowed range/enum) and should fail with a 4xx. Do NOT invent transport-level violations such as sending a body on a GET, using an unsupported HTTP method, or omitting Content-Type — only invalidate the endpoint's actual inputs",
    auth: 'a request without/with bad credentials that should be rejected (401/403) — generate whenever the endpoint is secured',
    schema: 'a valid request asserting the response body matches the documented schema',
    boundary: 'edge values (empty, max length, min/max numbers, zero, negative) for a real parameter or body field of this endpoint',
};

/**
 * Trim a JSON schema to a bounded string so a huge deref'd schema can't blow
 * the prompt token budget.
 */
function compactSchema(schema, maxLen = 1500) {
    if (!schema) return 'none';
    let s;
    try { s = JSON.stringify(schema); } catch { return 'unserializable'; }
    return s.length > maxLen ? s.slice(0, maxLen) + ' …(truncated)' : s;
}

/**
 * Build the LLM prompt for a single endpoint. Pure function (testable).
 */
export function buildPrompt(endpoint, categories) {
    const cats = (categories && categories.length ? categories : ALL_CATEGORIES)
        .filter(c => ALL_CATEGORIES.includes(c));

    const params = [...endpoint.pathParams, ...endpoint.queryParams, ...endpoint.headerParams]
        .map(p => `${p.in}:${p.name} (${p.type}${p.required ? ', required' : ''})`)
        .join('; ') || 'none';

    const wantCats = cats.map(c => `- ${c}: ${CATEGORY_HINTS[c]}`).join('\n');

    return `You are an API test designer. Produce test cases for ONE HTTP endpoint.

Endpoint:
  Method: ${endpoint.method}
  Path: ${endpoint.path}
  Summary: ${endpoint.summary || 'n/a'}
  Secured: ${Array.isArray(endpoint.security) && endpoint.security.length > 0 ? 'yes' : 'no'}
  Parameters: ${params}
  Request body schema: ${compactSchema(endpoint.requestBodySchema)}
  Documented response codes: ${Object.keys(endpoint.responses).join(', ') || 'n/a'}

Generate test cases ONLY for these categories:
${wantCats}

Return STRICT JSON (no markdown, no prose) of this exact shape:
{
  "cases": [
    {
      "name": "short human-readable test name",
      "category": "positive|negative|auth|schema|boundary",
      "preconditions": "state/data/auth required before sending — e.g. 'A pet with id 10 already exists' or 'Caller has a valid admin token'; use 'None' if not applicable",
      "request": {
        "method": "${endpoint.method}",
        "path": "${endpoint.path}",
        "pathParams": {},
        "queryParams": {},
        "headers": {},
        "body": null
      },
      "steps": ["1. ...", "2. ...", "3. ..."],
      "expectedStatus": 200,
      "assertions": ["plain-english assertion", "..."]
    }
  ]
}

Rules:
- Produce ONE case for EACH requested category by default. Skip a category ONLY when it is genuinely inapplicable:
  * 'auth' — skip only if the endpoint is NOT secured (Secured: no above).
  * 'negative' / 'boundary' — skip only if the endpoint has NO parameters AND NO request body (there is genuinely nothing to invalidate).
  Do NOT skip a category merely because the spec doesn't document its error/status code — most catalogs (e.g. Postman/manual) document only success codes.
- Every 'negative'/'boundary' case must invalidate a SPECIFIC real parameter or body field of THIS endpoint (missing required field, wrong type, out-of-range/enum value). NEVER base a case on an HTTP transport assumption the spec does not describe — e.g. "GET with a body returns 400", unsupported methods, or a missing Content-Type header.
- expectedStatus: for 'positive'/'schema' use a documented 2xx (default 200). For 'negative'/'boundary' use a documented 4xx if one is listed, otherwise default to 400 (use 422 when violating a structured body schema). For 'auth' use a documented 401/403 if listed, otherwise 401.
- Use realistic sample values for path/query params and body fields.
- 'preconditions': state what must be true before the request (existing data, auth/role, environment). Use "None" when nothing is required.
- 'steps': DETAILED, numbered, plain-language manual instructions a tester can follow in an API client (e.g. Postman) WITHOUT prior context. State the exact request (method + full path with the sample params filled in), any header/auth to set, the body to use (and, for negative cases, WHICH field to omit/break), the action to send it, and what to check. Example: ["1. In Postman set method POST and URL {server}/pet", "2. Add header Content-Type: application/json", "3. Set the body to {\\"photoUrls\\":[]} — omit the required 'name' field", "4. Send the request", "5. Confirm the response status is 400 and the body contains an 'error' field"]. The steps must agree with the request and expectedStatus above.
- Keep assertions concrete and verifiable (max 3 per case), and assert only behavior the spec guarantees.
- Be concise — do not repeat the schema in the output.`;
}

/**
 * Extract a JSON object from an LLM response that may be fenced or padded.
 * Pure function (testable). Returns the parsed object or throws.
 */
export function extractJson(text) {
    if (!text || typeof text !== 'string') throw new Error('Empty LLM response');
    let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    // Grab the outermost { ... } if there's surrounding prose.
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
        cleaned = cleaned.slice(first, last + 1);
    }
    return JSON.parse(cleaned);
}

/**
 * Generate test cases for a list of endpoints.
 *
 * @param {Array} endpoints - catalog endpoints (from apiSpecService.parseSpec)
 * @param {Object} options - { categories: string[] }
 * @param {string} apiKey - LLM API key
 * @returns {Array} [{ endpoint: {operationId, method, path}, cases: [...] } | { ..., error }]
 */
export async function generateApiTestCases(endpoints, options = {}, apiKey) {
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
        throw new Error('No endpoints provided.');
    }
    if (!apiKey) {
        throw new Error('LLM API key missing.');
    }

    const categories = options.categories || ALL_CATEGORIES;
    const endpoint_limit = 40; // guardrail against runaway LLM cost
    const selected = endpoints.slice(0, endpoint_limit);

    const genAI = new GoogleGenerativeAI(apiKey, process.env.VITE_LLM_ENDPOINT);
    const model = genAI.getGenerativeModel({
        model: process.env.VITE_LLM_MODEL || 'gpt-oss-20b',
        // High ceiling, not a throttle: gpt-oss is a reasoning model that spends
        // ~1-2k tokens reasoning before the answer. A low cap truncated the JSON
        // (empty / "unterminated string"); the model still stops early when done.
        // reasoningEffort:'medium' bounds gpt-oss's reasoning so it doesn't spend the
        // whole budget thinking and return empty content (finish_reason=length).
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192, reasoningEffort: 'medium' },
    });

    const results = [];
    // Sequential here; the frontend parallelizes by sending one endpoint per
    // request. generateWithRetry handles 429 backoff. Each call is bounded by
    // a hard timeout so a hung/unreachable LLM can't block indefinitely.
    for (const endpoint of selected) {
        const meta = { operationId: endpoint.operationId, method: endpoint.method, path: endpoint.path };
        try {
            const raw = await withTimeout(
                generateWithRetry(model, buildPrompt(endpoint, categories)),
                LLM_TIMEOUT_MS,
                `LLM timed out after ${LLM_TIMEOUT_MS / 1000}s`
            );
            const parsed = extractJson(raw);
            const cases = Array.isArray(parsed.cases) ? parsed.cases : [];
            results.push({ endpoint: meta, cases });
        } catch (err) {
            results.push({ endpoint: meta, cases: [], error: err.message });
        }
    }

    return results;
}

const LLM_TIMEOUT_MS = 120000; // per-endpoint ceiling (slow local models need headroom)

/**
 * Reject if `promise` doesn't settle within ms. Note: the underlying LLM
 * fetch isn't aborted (the wrapper just stops waiting), but it frees the
 * batch to move on instead of hanging.
 */
function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
