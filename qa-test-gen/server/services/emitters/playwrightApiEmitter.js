/**
 * Playwright API (TypeScript) emitter — Phase A3.
 *
 * Template-driven: renders the abstract A2 cases into Playwright `request`
 * fixture tests. Status code is asserted, and the AI's assertions are turned
 * into real expect() checks where parseable (JSON validity, non-empty body,
 * "contains key X"); anything else is left as a TODO comment.
 *
 * Input: { info: { title, serverUrl }, groups: [{ operationId, method, path, tags, secured, cases }] }
 * Output: { [relativePath]: fileContents }
 */

export function emitPlaywright({ info = {}, groups = [] }) {
    const files = {};
    const serverUrl = preferIpv4(info.serverUrl || 'https://api.example.com');
    const auth = info.auth && info.auth.type === 'keycloak'
        ? { ...info.auth, tokenUrl: preferIpv4(info.auth.tokenUrl) }
        : null;

    const dataVars = info.dataVars && Object.keys(info.dataVars).length > 0 ? info.dataVars : null;

    files['package.json'] = packageJson(info.title || 'api-tests');
    files['playwright.config.ts'] = config(!!auth);
    files['README.md'] = readme(serverUrl, auth, dataVars);
    if (dataVars) files['test-data.ts'] = testDataFile(dataVars);

    if (auth) {
        // Personas actually exercised by the suite (+ the default, used by
        // unfoldered/public requests) — only fetch tokens we need.
        const used = new Set();
        for (const g of groups) if (g.secured && g.persona) used.add(g.persona);
        if (auth.defaultPersona) used.add(auth.defaultPersona);
        const usedPersonas = [...used].filter(p => auth.personas[p]);

        files['auth/credentials.ts'] = credentialsFile(auth);
        files['auth/global-setup.ts'] = globalSetupFile(usedPersonas);
        files['auth/tokens.ts'] = tokensFile();
        files['.gitignore'] = 'node_modules/\nauth/.tokens.json\nplaywright-report/\ntest-results/\n';
    }

    const dataKeys = dataVars ? Object.keys(dataVars) : [];
    const byTag = groupByTag(groups);
    for (const [tag, tagGroups] of Object.entries(byTag)) {
        files[`tests/${kebab(tag)}.spec.ts`] = specFile(tag, tagGroups, serverUrl, !!auth, dataKeys);
    }
    return files;
}

function groupByTag(groups) {
    const out = {};
    for (const g of groups) {
        const tag = (Array.isArray(g.tags) && g.tags[0]) || 'Default';
        (out[tag] = out[tag] || []).push(g);
    }
    return out;
}

function specFile(tag, groups, serverUrl, hasAuth, dataKeys = []) {
    const tests = [];
    const used = new Set();
    for (const g of groups) {
        for (let i = 0; i < (g.cases || []).length; i++) {
            tests.push(testBlock(g, g.cases[i], i, used, hasAuth, dataKeys));
        }
    }
    const authImport = hasAuth ? `import { getToken } from '../auth/tokens';\n` : '';
    const dataImport = dataKeys.length > 0 ? `import { DATA } from '../test-data';\n` : '';
    const tokenConst = hasAuth ? '' : `const TOKEN = process.env.API_TOKEN || '';\n`;
    return `import { test, expect } from '@playwright/test';
${authImport}${dataImport}
const BASE_URL = process.env.BASE_URL || ${jstr(serverUrl)};
${tokenConst}
test.describe(${jstr(tag)}, () => {
${tests.join('\n\n')}
});
`;
}

function testBlock(group, testCase, idx, used, hasAuth, dataKeys = []) {
    const method = (testCase.request?.method || group.method || 'GET').toLowerCase();
    const expected = toInt(testCase.expectedStatus, 200);
    const isAuthNegative = (testCase.category || '').toLowerCase() === 'auth';
    const includeAuth = group.secured && !isAuthNegative;

    const name = uniqueName(testCase.name || `${testCase.category || 'case'} ${idx + 1}`, used);
    // Build the URL from the canonical group path (keeps {name} placeholders);
    // data-var placeholders resolve to DATA.<name>, others to the case's value.
    const url = substitutePath(group.path || testCase.request?.path || '/', testCase.request?.pathParams || {}, dataKeys);

    const opts = [];
    if (includeAuth) {
        // Keycloak: pull the persona token fetched in global-setup. Otherwise
        // fall back to a static API_TOKEN env var.
        const authVal = hasAuth && group.persona
            ? `\`Bearer \${getToken(${jstr(group.persona)})}\``
            : '`Bearer ${TOKEN}`';
        opts.push(`        headers: { Authorization: ${authVal} },`);
    }
    const params = buildParams(testCase.request?.queryParams || {}, group.queryData || {}, dataKeys);
    if (params) opts.push(`        params: ${params},`);
    const body = testCase.request?.body;
    if (body !== undefined && body !== null && body !== '') opts.push(`        data: ${tsValue(body)},`);
    // Process-orchestrated endpoints can block on the workflow engine.
    opts.push('        timeout: 180000,');

    const optsBlock = opts.length > 0 ? `, {\n${opts.join('\n')}\n    }` : '';

    const reqLine = `    const res = await request.${method}(\`\${BASE_URL}${url}\`${optsBlock});`;
    const checkLines = renderChecks(testCase, expected);
    return `  test(${jstr(name)}, async ({ request }) => {
${reqLine}
${checkLines.join('\n')}
  });`;
}

// Turn the AI's plain-English assertions into REAL expect() calls where we can
// confidently parse them (JSON validity, non-empty body, "contains key X").
// Anything we can't translate stays as a TODO comment, so a fuzzy assertion is
// never silently turned into a wrong (failing) check. Status is always asserted.
function renderChecks(testCase, expected) {
    const out = [`    expect(res.status()).toBe(${expected});`];
    const bodyChecks = [];
    const todos = [];
    const seen = new Set();
    let needBody = false, didJson = false, didNonEmpty = false;

    for (const raw of Array.isArray(testCase.assertions) ? testCase.assertions : []) {
        const a = String(raw).trim();
        if (!a) continue;
        if (/\bstatus\b/i.test(a) && /\d{3}/.test(a)) continue; // status already asserted above
        const m = a.match(/(?:key|property|field|attribute)s?\s*[:=]?\s*['"]?([A-Za-z_][\w.]*)['"]?/i)
            || a.match(/contains?\s+['"]([A-Za-z_][\w.]*)['"]/i);
        if (m) {
            const prop = m[1];
            if (!seen.has(prop)) {
                seen.add(prop); needBody = true;
                bodyChecks.push(`    expect(body, ${jstr(`body should contain "${prop}"`)}).toHaveProperty(${jstr(prop)});`);
            }
            continue;
        }
        if (/not\s+empty|non[- ]?empty/i.test(a)) {
            if (!didNonEmpty) { didNonEmpty = true; needBody = true; bodyChecks.push(`    expect(Object.keys(body ?? {}).length, 'response body should not be empty').toBeGreaterThan(0);`); }
            continue;
        }
        if (/valid\s+json|is\s+json|json\s+(?:object|response)/i.test(a)) {
            if (!didJson) { didJson = true; needBody = true; bodyChecks.push(`    expect(body, 'response should be valid JSON').not.toBeNull();`); }
            continue;
        }
        todos.push(`    //  - ${escapeComment(a)}`);
    }

    if (needBody) {
        out.push(`    const body = await res.json().catch(() => null);`);
        out.push(...bodyChecks);
    }
    if (todos.length) {
        out.push('    // TODO: assert the following (could not auto-generate):');
        out.push(...todos);
    }
    return out;
}

export function packageJson(name) {
    return JSON.stringify({
        name: kebab(name),
        version: '1.0.0',
        private: true,
        scripts: { test: 'playwright test', 'test:report': 'playwright show-report' },
        devDependencies: { '@playwright/test': '^1.58.0' },
    }, null, 2) + '\n';
}

export function config(hasAuth) {
    const globalSetup = hasAuth ? `\n  globalSetup: './auth/global-setup.ts',` : '';
    // Generous test timeout: process-orchestrated (BPMN) endpoints can block for
    // a long time — claim creation runs document/AI validation synchronously.
    return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',${globalSetup}
  timeout: 240000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { ignoreHTTPSErrors: true },
});
`;
}

// ─── Keycloak auto-auth scaffolding ──────────────────────
// Exported so the flow emitter can reuse the same auth/test-data scaffolding.
export function credentialsFile(auth) {
    const personaLines = Object.entries(auth.personas).map(([name, c]) => {
        const ENV = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
        return `  ${jstr(name)}: { username: process.env.${ENV}_USER || ${jstr(c.username)}, password: process.env.${ENV}_PASS || ${jstr(c.password)} },`;
    }).join('\n');

    return `// Auth config generated from your Postman environment. These are local/QA
// seed credentials — override any value at run time via environment variables.
export interface PersonaCreds { username: string; password: string; }

export const KC_TOKEN_URL = process.env.KC_TOKEN_URL || ${jstr(auth.tokenUrl)};
export const KC_CLIENT_ID = process.env.KC_CLIENT_ID || ${jstr(auth.clientId)};
export const KC_CLIENT_SECRET = process.env.KC_CLIENT_SECRET || ${jstr(auth.clientSecret || '')};

export const PERSONAS: Record<string, PersonaCreds> = {
${personaLines}
};
`;
}

export function globalSetupFile(usedPersonas) {
    const list = usedPersonas.map(p => jstr(p)).join(', ');
    return `import { KC_TOKEN_URL, KC_CLIENT_ID, KC_CLIENT_SECRET, PERSONAS } from './credentials';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// Personas exercised by this suite. Tokens are fetched once, before all tests.
const USED_PERSONAS: string[] = [${list}];
const TOKENS_FILE = 'auth/.tokens.json';

async function fetchToken(persona: string): Promise<string> {
  const creds = PERSONAS[persona];
  if (!creds) throw new Error('No credentials for persona ' + persona);
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: KC_CLIENT_ID,
    username: creds.username,
    password: creds.password,
  });
  if (KC_CLIENT_SECRET) body.set('client_secret', KC_CLIENT_SECRET);

  // Hard timeout so a non-responding Keycloak (e.g. still booting) fails fast
  // instead of hanging the whole run forever.
  let res;
  try {
    res = await fetch(KC_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    const msg = (err as Error).name === 'TimeoutError'
      ? 'no response within 30s (Keycloak unreachable or still starting)'
      : (err as Error).message;
    throw new Error(msg);
  }
  if (!res.ok) {
    throw new Error('Token fetch failed for ' + persona + ' (' + res.status + '): ' + (await res.text()));
  }
  const data = await res.json();
  return data.access_token;
}

// Retry a few times so a cold-starting Keycloak (slow first responses) doesn't
// leave early personas without a token while later ones succeed.
async function fetchTokenWithRetry(persona: string, attempts = 3): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchToken(persona);
    } catch (err) {
      if (i === attempts - 1) throw err;
      console.warn('[auth] ' + persona + ' attempt ' + (i + 1) + ' failed (' + (err as Error).message + ') — retrying in 5s');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error('unreachable');
}

export default async function globalSetup() {
  const tokens: Record<string, string> = {};
  const failures: string[] = [];
  for (const persona of USED_PERSONAS) {
    try {
      tokens[persona] = await fetchTokenWithRetry(persona);
      console.log('[auth] fetched token for persona=' + persona);
    } catch (err) {
      failures.push(persona + ': ' + (err as Error).message);
      console.error('[auth] ' + persona + ' -> ' + (err as Error).message);
    }
  }
  mkdirSync(dirname(TOKENS_FILE), { recursive: true });
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));

  // No tokens at all means every secured test will fail — stop now with a clear
  // message instead of letting them fail one-by-one with empty Bearer headers.
  if (USED_PERSONAS.length > 0 && Object.keys(tokens).length === 0) {
    throw new Error(
      '[auth] Could not fetch ANY token from ' + KC_TOKEN_URL + '.\\n' +
      'Check that Keycloak is running and reachable, then re-run.\\n' +
      'Failures:\\n  ' + failures.join('\\n  ')
    );
  }
}
`;
}

export function tokensFile() {
    return `import { readFileSync } from 'fs';

// Reads the tokens written by global-setup. Cached after first read.
let cache: Record<string, string> | null = null;

export function getToken(persona: string): string {
  if (!cache) {
    try { cache = JSON.parse(readFileSync('auth/.tokens.json', 'utf8')); }
    catch { cache = {}; }
  }
  const tok = cache[persona];
  if (!tok) console.warn('[auth] no token for persona=' + persona + ' (check global-setup logs)');
  return tok || '';
}
`;
}

// Map a data-var name to an env-var override name: claimId → CLAIM_ID.
function envName(name) {
    return String(name)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .toUpperCase();
}

export function testDataFile(dataVars) {
    const lines = Object.entries(dataVars).map(([name, def]) =>
        `  ${jstr(name)}: process.env.${envName(name)} || ${jstr(def || '')},`).join('\n');
    return `// Shared test data — path/query identifiers reused across tests, seeded from
// your Postman environment. Set runtime IDs here once (or via the matching env
// var, e.g. ${Object.keys(dataVars).map(envName).slice(0, 1).join('')}=…), and every test that uses them picks it up.
//
// Blank values are IDs that don't exist until you create the resource at runtime
// (e.g. a claim). Paste a real one here, or wire up a create-then-reuse flow.
export const DATA: Record<string, string> = {
${lines}
};
`;
}

function readme(serverUrl, auth, dataVars) {
    const dataSection = dataVars ? `

## Test data (\`test-data.ts\`)
Path and query identifiers come from \`DATA\` in \`test-data.ts\`, seeded from your
Postman environment. Values that were blank there (e.g. \`claimId\`, \`submissionId\`)
are runtime IDs — set them once in \`test-data.ts\` or via env var
(e.g. \`CLAIM_ID=… npx playwright test\`). Tests using those IDs will 400/404 until set.` : '';
    if (auth) {
        const personas = Object.keys(auth.personas).join(', ');
        return `# Generated Playwright API Tests (Keycloak auto-auth)

Generated by AAQUA from your Postman collection. Tokens are fetched automatically
before the suite runs — no manual token pasting, mirroring your collection's
pre-request script.

## Setup & run
\`\`\`bash
npm install
npx playwright install
BASE_URL=${serverUrl} npx playwright test
\`\`\`

## How auth works
- \`auth/global-setup.ts\` runs once before all tests. For each persona used
  (${personas}) it POSTs \`grant_type=password\` to Keycloak and caches the
  access token in \`auth/.tokens.json\`.
- Each test attaches \`Authorization: Bearer <persona token>\` based on the
  folder/persona it came from. Public/unfoldered requests use the default persona.
- Credentials live in \`auth/credentials.ts\` (seeded from your environment file).
  Override any value with env vars, e.g. \`CLAIMANT_PASS=… npx playwright test\`,
  or point at QA with \`KC_TOKEN_URL=… BASE_URL=…\`.

> \`auth/.tokens.json\` is gitignored — it holds live tokens. Each test asserts the
> HTTP status code plus the AI's response checks (JSON validity, non-empty body,
> required fields); assertions that couldn't be auto-generated are left as TODO comments.
${dataSection}
`;
    }
    return `# Generated Playwright API Tests

Generated by AAQUA from your API spec.

## Setup & run
\`\`\`bash
npm install
npx playwright install
BASE_URL=${serverUrl} API_TOKEN=<your-token> npx playwright test
\`\`\`

- \`BASE_URL\` overrides the target server (defaults to the spec's server URL).
- \`API_TOKEN\` is sent as \`Authorization: Bearer <token>\` for secured endpoints.
${dataSection}
> Each test asserts the HTTP status code plus the AI's response checks (JSON
> validity, non-empty body, required fields). Assertions that couldn't be
> auto-generated are left as TODO comments to expand.
`;
}

// ─── helpers ─────────────────────────────────────────────
export function preferIpv4(url) {
    // Windows + Node resolve `localhost` to IPv6 (::1); local servers usually
    // bind IPv4 only, so requests fail with `ECONNREFUSED ::1`. Pin to 127.0.0.1.
    return String(url).replace(/(\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1');
}
function toInt(v, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; }
function jstr(s) { return JSON.stringify(String(s)); }
function tsValue(v) { return JSON.stringify(v, null, 2).replace(/\n/g, '\n    '); }
// Build the Playwright `params` object source. Data-bound query keys reference
// the shared DATA file; everything else uses the case's literal value. Returns
// '' when there are no params. Emits a raw object literal (not JSON) so DATA
// references stay as live code.
function buildParams(query, queryData, dataKeys) {
    const parts = [];
    const seen = new Set();
    for (const [k, v] of Object.entries(query)) {
        seen.add(k);
        const varName = queryData[k];
        if (varName && dataKeys.includes(varName)) {
            parts.push(`${jstr(k)}: DATA[${jstr(varName)}]`);
        } else {
            parts.push(`${jstr(k)}: ${JSON.stringify(typeof v === 'object' ? JSON.stringify(v) : v)}`);
        }
    }
    // Ensure data-bound params present in the collection but omitted by the AI
    // are still sent, sourced from DATA.
    for (const [k, varName] of Object.entries(queryData)) {
        if (!seen.has(k) && dataKeys.includes(varName)) parts.push(`${jstr(k)}: DATA[${jstr(varName)}]`);
    }
    return parts.length > 0 ? `{ ${parts.join(', ')} }` : '';
}
function substitutePath(p, pathParams, dataKeys = []) {
    let out = String(p);
    // Data-var placeholders → live DATA reference inside the URL template literal.
    for (const k of dataKeys) {
        out = out.replace(new RegExp(`\\{${escapeRegex(k)}\\}`, 'g'), '${DATA[' + jstr(k) + ']}');
    }
    // Remaining placeholders → the case's concrete value.
    for (const [k, v] of Object.entries(pathParams)) {
        out = out.replace(new RegExp(`\\{${escapeRegex(k)}\\}`, 'g'), encodeURIComponent(String(v)));
    }
    return out;
}
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeComment(s) { return String(s).replace(/\r?\n/g, ' '); }
export function kebab(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default'; }
function uniqueName(name, used) {
    let n = String(name), i = 2;
    while (used.has(n)) n = `${name} (${i++})`;
    used.add(n);
    return n;
}
