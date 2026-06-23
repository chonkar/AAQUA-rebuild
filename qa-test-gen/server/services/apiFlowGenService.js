import { LocalLLM as GoogleGenerativeAI } from '../utils/llmClient.js';
import { generateWithRetry } from '../utils/aiUtils.js';
import { extractJson } from './apiTestGenService.js';

/**
 * API flow generation (Phase B1) — for process-orchestrated (BPMN/Camunda) APIs.
 *
 * Where the per-endpoint generator (apiTestGenService) treats each endpoint in
 * isolation, this infers ORDERED flows that walk a business process: later steps
 * reuse ids captured from earlier responses (e.g. a claimId from "start process").
 * The LLM proposes the flows; the deterministic flow emitter renders them.
 */

const LLM_TIMEOUT_MS = 120000;

// Identity-provider auth endpoints (OIDC token, OAuth token, login). These are
// NOT application flow steps — authentication is injected per-persona by the
// generated harness (auth/global-setup + getToken). They also typically live on
// a different host (Keycloak) than the API's serverUrl, so emitting them under
// BASE_URL produces wrong-host 404s. Excluded from flows entirely.
const AUTH_STEP_RE = /openid-connect\/token|\/oauth2?\/token|\/realms\/[^/]+\/protocol\/|\/login(?:\b|$)/i;

function compact(s, n = 100) {
    if (s == null) return '';
    const t = String(s);
    return t.length > n ? t.slice(0, n) + '…' : t;
}

/** Build the flow-inference prompt. Pure function (testable). */
export function buildFlowPrompt(endpoints, info = {}) {
    const lines = endpoints.map((e, i) => {
        const tag = (Array.isArray(e.tags) && e.tags[0]) || '-';
        const persona = e.persona ? ` persona=${e.persona}` : '';
        const body = e.requestBodySchema ? ' [has body]' : '';
        const summary = e.summary ? ` — ${compact(e.summary, 80)}` : '';
        return `${i + 1}. [${tag}] ${e.method} ${e.path}${summary}${persona}${body}`;
    }).join('\n');

    return `You design END-TO-END API test FLOWS for a process-orchestrated (BPMN/workflow) backend titled "${info.title || 'API'}".
A flow is an ORDERED sequence of API calls that walks one business process. Later steps reuse ids RETURNED by earlier steps (e.g. an id created by a "create/start" call), so order matters.

Available endpoints (grouped by folder/role):
${lines}

Infer the flows from the ACTUAL endpoints, folder names, and summaries above — do not assume any particular domain. STRONGLY PREFER a SINGLE end-to-end happy-path flow that walks the whole process for ONE resource instance and spans whatever roles/personas are involved (each step carries its own persona) — so an id created by an early step (e.g. a claimId from "start/create") is reused by every later step. Do NOT split one business process into separate per-persona flows: each generated flow runs in its OWN isolated spec, so a "review"/"decision" flow that doesn't itself create the resource will hit \`/undefined/\` and fail. Only add a 2nd/3rd flow for a genuinely independent process or a distinct alternate/negative path. For EACH step specify:
- the endpoint by its METHOD and PATH exactly as listed above,
- the persona/role that performs it (use the persona shown for that endpoint, or null if none),
- how each path param / query param / body is filled: a literal value, "$data.<name>" for shared seed inputs that exist before the flow runs, or "$ctx.<name>" for a value captured from an earlier step,
- what to capture from this step's JSON response for later steps, as { "<ctxVar>": "<responseFieldName>" } (best guess at the field holding the id),
- expectedStatus (a number).

Return STRICT JSON only (no markdown, no prose). The values below are placeholders that illustrate the SHAPE — replace them with values derived from the real endpoints:
{
  "flows": [
    {
      "name": "<flow name>",
      "description": "<short description>",
      "steps": [
        {
          "stepName": "<what this step does>",
          "method": "POST",
          "path": "<a create/start endpoint from the list>",
          "persona": "<persona or null>",
          "pathParams": {},
          "query": {},
          "body": null,
          "capture": { "<idName>": "<response field holding the new id>" },
          "expectedStatus": 200
        },
        {
          "stepName": "<a follow-up step that uses the created id>",
          "method": "POST",
          "path": "<a later endpoint from the list>",
          "persona": "<persona or null>",
          "pathParams": { "<idPathParam>": "$ctx.<idName>" },
          "query": {},
          "body": null,
          "capture": {},
          "expectedStatus": 200
        }
      ]
    }
  ]
}

Rules:
- Use ONLY endpoints from the list, matching METHOD and PATH exactly.
- Order steps so any "$ctx.<name>" is captured by an earlier step before it is used.
- Each flow MUST be self-contained: any id referenced via "$ctx.<name>" has to be captured by an EARLIER step IN THE SAME FLOW. If a step needs a resource id (e.g. a claim to review/decide), include that resource's create/start step earlier in the SAME flow — never assume the resource already exists in another flow.
- Use "$data.<name>" for seed inputs that exist before the flow runs.
- Do NOT include authentication / login / token-acquisition endpoints as steps (e.g. OIDC token endpoints like ".../protocol/openid-connect/token", "/oauth/token", or "/login"). Authentication is injected automatically per persona — assume every step is already authenticated.
- Keep each flow focused — at most ~8 steps.`;
}

/**
 * Validate LLM flows against the real catalog: drop steps whose method+path
 * don't exist, attach operationId/secured/persona from the catalog, and apply
 * safe defaults. Returns a clean flow array.
 */
function normalizeFlows(flows, endpoints) {
    const byKey = new Map();
    for (const e of endpoints) byKey.set(`${e.method} ${e.path}`, e);

    const out = [];
    for (const f of Array.isArray(flows) ? flows : []) {
        if (!f || !Array.isArray(f.steps)) continue;
        const steps = [];
        for (const s of f.steps) {
            const method = String(s.method || '').toUpperCase();
            const path = s.path || '';
            const ep = byKey.get(`${method} ${path}`);
            if (!ep) continue; // skip hallucinated endpoints
            if (AUTH_STEP_RE.test(path)) continue; // auth is injected per-persona — never a flow step
            steps.push({
                stepName: s.stepName || `${method} ${path}`,
                operationId: ep.operationId,
                method,
                path,
                persona: s.persona || ep.persona || null,
                secured: !!ep.secured,
                pathParams: s.pathParams && typeof s.pathParams === 'object' ? s.pathParams : {},
                query: s.query && typeof s.query === 'object' ? s.query : {},
                body: s.body !== undefined ? s.body : null,
                capture: s.capture && typeof s.capture === 'object' ? s.capture : {},
                expectedStatus: toInt(s.expectedStatus, 200),
                multipart: ep.multipart || undefined, // file/text parts from the catalog
            });
        }
        if (steps.length > 0) {
            out.push({ name: f.name || 'Flow', description: f.description || '', steps });
        }
    }
    return out;
}

/**
 * Infer ordered flows for the given catalog endpoints.
 * @returns {Array} normalized flows: [{ name, description, steps: [...] }]
 */
export async function generateFlows(endpoints, options = {}, apiKey) {
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
        throw new Error('No endpoints provided.');
    }
    if (!apiKey) {
        throw new Error('LLM API key missing.');
    }

    const genAI = new GoogleGenerativeAI(apiKey, process.env.VITE_LLM_ENDPOINT);
    const model = genAI.getGenerativeModel({
        model: process.env.VITE_LLM_MODEL || 'gemma-4',
        // reasoningEffort:'medium' bounds gpt-oss's reasoning so it doesn't spend the
        // whole budget thinking and return empty content (finish_reason=length).
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192, reasoningEffort: 'medium' },
    });

    const raw = await withTimeout(
        generateWithRetry(model, buildFlowPrompt(endpoints, options.info || {})),
        LLM_TIMEOUT_MS,
        `LLM timed out after ${LLM_TIMEOUT_MS / 1000}s`
    );
    return normalizeFlows(extractJson(raw).flows, endpoints);
}

// ─── helpers ─────────────────────────────────────────────
function toInt(v, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; }

function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
