/**
 * Playwright FLOW emitter — Phase B3 (process-orchestrated / BPMN APIs).
 *
 * Renders inferred flows (apiFlowGenService) into ordered `test.describe.serial`
 * specs that share a `ctx` object: each step captures ids from its response and
 * later steps consume them via $ctx.<name>; seed inputs come from $data.<name>.
 * Reuses the auth + test-data scaffolding from the per-endpoint emitter.
 *
 * Input: { info: { title, serverUrl, auth, dataVars }, flows: [{ name, description, steps }] }
 * Output: { [relativePath]: fileContents }
 */
import {
    packageJson, config, credentialsFile, globalSetupFile, tokensFile,
    testDataFile, preferIpv4, kebab,
} from './playwrightApiEmitter.js';

export function emitPlaywrightFlows({ info = {}, flows = [] }) {
    const files = {};
    const serverUrl = preferIpv4(info.serverUrl || 'https://api.example.com');
    const auth = info.auth && info.auth.type === 'keycloak'
        ? { ...info.auth, tokenUrl: preferIpv4(info.auth.tokenUrl) }
        : null;
    const dataVars = info.dataVars && Object.keys(info.dataVars).length > 0 ? info.dataVars : null;
    const dataKeys = dataVars ? Object.keys(dataVars) : [];

    const hasMultipart = flows.some(f => (f.steps || []).some(s => Array.isArray(s.multipart) && s.multipart.length > 0));

    files['package.json'] = packageJson(info.title || 'api-flow-tests');
    files['playwright.config.ts'] = config(!!auth);
    files['README.md'] = readme(serverUrl, auth, hasMultipart);
    if (dataVars) files['test-data.ts'] = testDataFile(dataVars);

    if (auth) {
        const used = new Set();
        for (const f of flows) for (const s of f.steps || []) if (s.secured && s.persona) used.add(s.persona);
        if (auth.defaultPersona) used.add(auth.defaultPersona);
        const usedPersonas = [...used].filter(p => auth.personas[p]);

        files['auth/credentials.ts'] = credentialsFile(auth);
        files['auth/global-setup.ts'] = globalSetupFile(usedPersonas);
        files['auth/tokens.ts'] = tokensFile();
        files['.gitignore'] = 'node_modules/\nauth/.tokens.json\nplaywright-report/\ntest-results/\nfixtures/**/*.pdf\n';
    }

    if (hasMultipart) {
        // One folder per upload endpoint; the test uploads everything inside it.
        const fileDirs = new Set();
        for (const f of flows) for (const s of f.steps || []) {
            const hasFile = (Array.isArray(s.multipart) ? s.multipart : []).some(p => p.kind === 'file');
            if (hasFile) fileDirs.add(pathSlug(s.path));
        }
        for (const dir of fileDirs) files[`fixtures/${dir}/sample-document.pdf`] = SAMPLE_PDF;
        files['fixtures/README.md'] = FIXTURES_README;
    }

    const usedNames = new Set();
    for (const flow of flows) {
        const base = kebab(flow.name || 'flow');
        let name = base, n = 2;
        while (usedNames.has(name)) name = `${base}-${n++}`;
        usedNames.add(name);
        files[`tests/flows/${name}.spec.ts`] = flowSpec(flow, serverUrl, !!auth, dataKeys);
    }
    return files;
}

function flowSpec(flow, serverUrl, hasAuth, dataKeys) {
    const steps = (flow.steps || []).map((s, i) => stepBlock(s, i, hasAuth, dataKeys)).join('\n\n');
    const hasMultipart = (flow.steps || []).some(s => Array.isArray(s.multipart) && s.multipart.length > 0);
    const authImport = hasAuth ? `import { getToken } from '../../auth/tokens';\n` : '';
    const dataImport = dataKeys.length > 0 ? `import { DATA } from '../../test-data';\n` : '';
    const fsImport = hasMultipart ? `import { readFileSync, readdirSync } from 'fs';\nimport { join } from 'path';\n` : '';
    const filesHelper = hasMultipart
        ? `
// Upload everything in a fixtures folder (so a step can send several files).
function filesFrom(dir: string): { name: string; buffer: Buffer }[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* no fixtures dir yet */ }
  return names.map((n) => ({ name: n, buffer: readFileSync(join(dir, n)) }));
}

// Content-type from file extension, so any file type uploads correctly.
const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', csv: 'text/csv', json: 'application/json', txt: 'text/plain',
  xml: 'application/xml', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function mimeFor(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}
`
        : '';
    const tokenConst = hasAuth ? '' : `const TOKEN = process.env.API_TOKEN || '';\n`;
    const desc = flow.description ? `// ${escapeComment(flow.description)}\n` : '';
    return `import { test, expect } from '@playwright/test';
${authImport}${dataImport}${fsImport}
const BASE_URL = process.env.BASE_URL || ${jstr(serverUrl)};
${filesHelper}${tokenConst}${desc}test.describe.serial(${jstr(flow.name || 'Flow')}, () => {
  // Shared across steps: ids captured from earlier responses live here.
  const ctx: Record<string, any> = {};

${steps}
});
`;
}

function stepBlock(step, idx, hasAuth, dataKeys) {
    const method = (step.method || 'GET').toLowerCase();
    const expected = toInt(step.expectedStatus, 200);
    const url = substitutePath(step.path || '/', step.pathParams || {}, dataKeys);

    const opts = [];
    if (step.secured) {
        const authVal = hasAuth && step.persona
            ? `\`Bearer \${getToken(${jstr(step.persona)})}\``
            : '`Bearer ${TOKEN}`';
        opts.push(`      headers: { Authorization: ${authVal} },`);
    }
    const query = step.query && typeof step.query === 'object' ? step.query : {};
    const qEntries = Object.entries(query);
    if (qEntries.length > 0) {
        const parts = qEntries.map(([k, v]) => `${jstr(k)}: ${jsExpr(v)}`);
        opts.push(`      params: { ${parts.join(', ')} },`);
    }

    // Multipart steps build a FormData first (supports several files under one
    // field). File parts upload everything in fixtures/<field>/; text parts use
    // their value. Non-multipart steps fall back to a JSON body.
    const isMultipart = Array.isArray(step.multipart) && step.multipart.length > 0;
    const preLines = [];
    if (isMultipart) {
        preLines.push('    const form = new FormData();');
        const dir = `fixtures/${pathSlug(step.path)}`; // one folder per endpoint
        for (const f of step.multipart) {
            if (f.kind === 'file') {
                preLines.push(`    for (const __f of filesFrom(${jstr(dir)})) form.append(${jstr(f.name)}, new Blob([__f.buffer], { type: mimeFor(__f.name) }), __f.name);`);
            } else {
                preLines.push(`    form.append(${jstr(f.name)}, ${JSON.stringify(String(f.value == null ? '' : f.value))});`);
            }
        }
        opts.push('      multipart: form,');
    } else if (step.body !== undefined && step.body !== null && step.body !== '') {
        opts.push(`      data: ${jsExpr(step.body)},`);
    }
    // BPMN steps can block on the workflow engine (claim creation runs doc/AI
    // validation synchronously); allow plenty of room.
    opts.push('      timeout: 180000,');
    const optsBlock = opts.length > 0 ? `, {\n${opts.join('\n')}\n    }` : '';

    // Capture ids from the response for later steps (reuse the already-read body).
    const captures = Object.entries(step.capture && typeof step.capture === 'object' ? step.capture : {});
    const captureLines = captures.length > 0
        ? `\n    const body = (() => { try { return JSON.parse(bodyText); } catch { return {} as any; } })();\n`
            + captures.map(([k, field]) =>
                `    ctx[${jstr(k)}] = body[${jstr(field)}];\n`
                + `    if (ctx[${jstr(k)}] === undefined) console.warn(\`[capture] field ${jstr(field)} not in response — available fields: \${Object.keys(body).join(', ') || '(body is not a JSON object)'} | raw: \${bodyText.slice(0, 300)}\`);`
            ).join('\n')
        : '';

    const name = step.stepName || `Step ${idx + 1}`;
    const pre = preLines.length > 0 ? '\n' + preLines.join('\n') : '';
    // Read the body before asserting so a failure shows WHY (the server's message).
    return `  test(${jstr(name)}, async ({ request }) => {${pre}
    const res = await request.${method}(\`\${BASE_URL}${url}\`${optsBlock});
    const bodyText = await res.text().catch(() => '');
    expect(res.status(), \`expected ${expected}, got \${res.status()} — \${bodyText.slice(0, 500)}\`).toBe(${expected});${captureLines}
  });`;
}

function readme(serverUrl, auth, hasMultipart) {
    const authNote = auth
        ? `\n## Auth\nPersona tokens are fetched once before the suite (see \`auth/\`). Each step uses its persona's token.\n`
        : '';
    const fixturesNote = hasMultipart
        ? `\n## File uploads\nEach upload endpoint has its own folder under \`fixtures/\` (named after its path) and sends every file inside it — so different endpoints can use different documents. Placeholders are included so it runs, but the backend validates them — **drop your real documents into each endpoint's folder**. See \`fixtures/README.md\`.\n`
        : '';
    return `# Generated Playwright Flow Tests (process / BPMN)

Generated by AAQUA. Each spec is an ordered \`test.describe.serial\` flow that walks
a business process — early steps create resources and capture their ids into a
shared \`ctx\`, later steps consume them. Seed inputs come from \`test-data.ts\`.

## Setup & run
\`\`\`bash
npm install
npx playwright install
BASE_URL=${serverUrl} npx playwright test
\`\`\`
${authNote}${fixturesNote}
> Steps run in order; if one fails the rest are skipped (that's intentional — a
> broken step means downstream ids were never produced). Captured-field guesses
> (\`ctx.<id> = body.<field>\`) may need correcting to match your real responses.
`;
}

// A readable, unique fixtures-folder slug per endpoint path, so different upload
// endpoints (which may share the field name "files") use different documents.
function pathSlug(p) {
    return String(p || '').replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'files';
}

// Minimal valid PDF so readFileSync succeeds out of the box; replace with a real
// document for the upload to pass server-side validation.
const SAMPLE_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;

const FIXTURES_README = `# Fixtures

Each subfolder maps to one **upload endpoint** (named after its path). The test
uploads *every* file in that folder for that endpoint — so different endpoints can
require different documents.

Example:
- \`fixtures/healthcare-startHealthCareProcess/\` → drop the 3 claim documents here
- \`fixtures/healthcare-doctor-upload-documents/\` → drop the 2 doctor documents here

The \`sample-document.pdf\` placeholders just let the suite run out of the box; the
backend validates uploads, so they'll be rejected (400). **Replace them with the
real documents** for each endpoint — add as many as needed, no code change.
`;

// ─── helpers ─────────────────────────────────────────────
function toInt(v, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; }
function jstr(s) { return JSON.stringify(String(s)); }
function escapeComment(s) { return String(s).replace(/\r?\n/g, ' '); }
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Render a value source as a JS expression: "$ctx.x" → ctx["x"],
 * "$data.x" → DATA["x"], everything else → a literal. Recurses into
 * arrays/objects so a body can mix literals and captured ids.
 */
function jsExpr(v) {
    if (typeof v === 'string') {
        const ctx = /^\$ctx\.(.+)$/.exec(v);
        if (ctx) return `ctx[${jstr(ctx[1])}]`;
        const data = /^\$data\.(.+)$/.exec(v);
        if (data) return `DATA[${jstr(data[1])}]`;
        return JSON.stringify(v);
    }
    if (Array.isArray(v)) return `[${v.map(jsExpr).join(', ')}]`;
    if (v && typeof v === 'object') {
        const parts = Object.entries(v).map(([k, val]) => `${jstr(k)}: ${jsExpr(val)}`);
        return `{ ${parts.join(', ')} }`;
    }
    return JSON.stringify(v);
}

function substitutePath(p, pathParams, dataKeys = []) {
    let out = String(p);
    const names = (out.match(/\{([A-Za-z0-9_]+)\}/g) || []).map(m => m.slice(1, -1));
    for (const name of names) {
        let expr;
        if (pathParams[name] !== undefined) expr = jsExpr(pathParams[name]);
        else if (dataKeys.includes(name)) expr = `DATA[${jstr(name)}]`;
        else expr = `ctx[${jstr(name)}]`;
        out = out.replace(new RegExp(`\\{${escapeRegex(name)}\\}`, 'g'), '${' + expr + '}');
    }
    return out;
}
