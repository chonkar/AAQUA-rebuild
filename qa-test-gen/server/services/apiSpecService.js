import SwaggerParser from '@apidevtools/swagger-parser';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * API Spec ingestion (Phase A1).
 *
 * Parses an OpenAPI/Swagger 2.0 or 3.x document from a URL, raw text, or an
 * uploaded file, then returns a *normalized endpoint catalog* the rest of the
 * test-generation pipeline consumes. swagger-parser validates and fully
 * dereferences ($ref → inline), so downstream code never has to chase refs or
 * branch on spec version.
 *
 * input: { type: 'url' | 'text' | 'file', value: string, envValue?: string }
 *   - url:  a (already SSRF-validated) http(s) URL to the spec
 *   - text: the raw spec body (JSON or YAML)
 *   - file: a path on disk (e.g. a multer temp upload)
 *   - envValue: (optional) raw Postman environment JSON, used to resolve
 *     {{variables}} when the spec is a Postman collection.
 */
export async function parseSpec(input) {
    if (!input || !input.type || input.value == null) {
        throw new Error('parseSpec requires { type, value }.');
    }

    // Postman collections (file/text) are JSON we detect and flatten ourselves;
    // OpenAPI/Swagger documents go through swagger-parser below.
    if (input.type === 'file' || input.type === 'text') {
        const raw = input.type === 'file' ? fs.readFileSync(input.value, 'utf8') : String(input.value);
        const maybeJson = tryParseJson(raw);
        if (maybeJson && isPostmanEnvironment(maybeJson)) {
            throw new Error('That is a Postman *environment* file (variables only) — it has no requests. '
                + 'Upload the Postman *collection* file (the one with your API requests); '
                + 'you can attach the environment file separately as the optional variables file.');
        }
        if (maybeJson && isPostmanCollection(maybeJson)) {
            return normalizePostmanCollection(maybeJson, parsePostmanEnv(input.envValue));
        }
    }

    let api;
    let tempFile = null;
    try {
        if (input.type === 'url') {
            // External resolution allowed: a remote spec may legitimately
            // reference sibling files. The top URL is SSRF-checked by the caller.
            api = await SwaggerParser.dereference(input.value);
        } else if (input.type === 'file') {
            // Local file: disable HTTP resolution so a malicious $ref can't
            // reach out to the network (SSRF via spec).
            api = await SwaggerParser.dereference(input.value, { resolve: { http: false } });
        } else if (input.type === 'text') {
            // swagger-parser needs a path to sniff format, so stage the raw
            // body to a temp file with a format-appropriate extension.
            const trimmed = String(input.value).trimStart();
            const ext = trimmed.startsWith('{') ? 'json' : 'yaml';
            tempFile = path.join(os.tmpdir(), `aaqua-spec-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
            fs.writeFileSync(tempFile, input.value, 'utf8');
            api = await SwaggerParser.dereference(tempFile, { resolve: { http: false } });
        } else {
            throw new Error(`Unsupported spec input type: ${input.type}`);
        }
    } finally {
        if (tempFile) {
            try { fs.unlinkSync(tempFile); } catch { /* best-effort cleanup */ }
        }
    }

    return normalizeCatalog(api);
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/**
 * Turn a dereferenced OpenAPI/Swagger document into a flat, version-agnostic
 * endpoint catalog.
 */
function normalizeCatalog(api) {
    const isV2 = typeof api.swagger === 'string' && api.swagger.startsWith('2');
    const openApiVersion = api.openapi || api.swagger || 'unknown';

    // Resolve a base server URL across v2 (host+basePath+schemes) and v3 (servers[]).
    let serverUrl = '';
    if (isV2) {
        const scheme = (api.schemes && api.schemes[0]) || 'https';
        if (api.host) serverUrl = `${scheme}://${api.host}${api.basePath || ''}`;
    } else if (Array.isArray(api.servers) && api.servers[0]) {
        serverUrl = api.servers[0].url || '';
    }

    const endpoints = [];
    const paths = api.paths || {};

    for (const [routePath, pathItem] of Object.entries(paths)) {
        if (!pathItem || typeof pathItem !== 'object') continue;
        // Path-level parameters apply to every operation under this path.
        const pathLevelParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

        for (const method of HTTP_METHODS) {
            const op = pathItem[method];
            if (!op || typeof op !== 'object') continue;

            const allParams = [...pathLevelParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];

            const pathParams = allParams.filter(p => p.in === 'path').map(mapParam);
            const queryParams = allParams.filter(p => p.in === 'query').map(mapParam);
            const headerParams = allParams.filter(p => p.in === 'header').map(mapParam);

            // Request body: v3 uses requestBody.content; v2 uses an in:body parameter.
            let requestBodySchema = null;
            if (isV2) {
                const bodyParam = allParams.find(p => p.in === 'body');
                requestBodySchema = bodyParam ? (bodyParam.schema || null) : null;
            } else if (op.requestBody && op.requestBody.content) {
                const json = op.requestBody.content['application/json']
                    || op.requestBody.content[Object.keys(op.requestBody.content)[0]];
                requestBodySchema = json ? (json.schema || null) : null;
            }

            // Responses → { status: { description, schema } }
            const responses = {};
            for (const [status, resp] of Object.entries(op.responses || {})) {
                let schema = null;
                if (isV2) {
                    schema = resp && resp.schema ? resp.schema : null;
                } else if (resp && resp.content) {
                    const json = resp.content['application/json']
                        || resp.content[Object.keys(resp.content)[0]];
                    schema = json ? (json.schema || null) : null;
                }
                responses[status] = { description: (resp && resp.description) || '', schema };
            }

            // operationId fallback: method + path, sanitized.
            const operationId = op.operationId
                || `${method}_${routePath}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');

            endpoints.push({
                operationId,
                method: method.toUpperCase(),
                path: routePath,
                summary: op.summary || op.description || '',
                tags: Array.isArray(op.tags) ? op.tags : [],
                pathParams,
                queryParams,
                headerParams,
                requestBodySchema,
                responses,
                // Operation-level security overrides document-level.
                security: op.security || api.security || [],
            });
        }
    }

    return {
        info: {
            title: (api.info && api.info.title) || 'Untitled API',
            version: (api.info && api.info.version) || '',
            openApiVersion,
            serverUrl,
            endpointCount: endpoints.length,
        },
        endpoints,
    };
}

// ─── Postman collection ingestion ────────────────────────
// Postman collections are a different shape than OpenAPI (`{ item: [...] }`
// instead of `{ paths: {...} }`), so we flatten them into the same catalog the
// rest of the pipeline consumes.

function tryParseJson(s) {
    try { return JSON.parse(s); } catch { return null; }
}

function isPostmanCollection(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const schema = obj.info && obj.info.schema;
    if (typeof schema === 'string' && schema.includes('getpostman.com/json/collection')) return true;
    return !!(obj.info && obj.info._postman_id) && Array.isArray(obj.item);
}

function isPostmanEnvironment(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj._postman_variable_scope === 'environment') return true;
    // values[] without item[]/paths{} is the environment-export shape.
    return Array.isArray(obj.values) && !Array.isArray(obj.item) && !obj.paths;
}

/** Build a {key: value} map from a Postman environment export. */
function parsePostmanEnv(envValue) {
    if (!envValue) return {};
    const obj = typeof envValue === 'string' ? tryParseJson(envValue) : envValue;
    const vars = {};
    if (obj && Array.isArray(obj.values)) {
        for (const v of obj.values) {
            if (v && v.key && v.enabled !== false) vars[v.key] = v.value;
        }
    }
    return vars;
}

/** Substitute {{var}} placeholders, leaving unknown ones intact. */
function resolveVars(str, vars) {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{([^{}]+)\}\}/g, (m, k) => {
        const key = k.trim();
        return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m;
    });
}

/**
 * "Infrastructure" vars are resolved inline (host, auth). Everything else is a
 * "data" var (claimId, ssn, …) the test author fills per run.
 */
function isInfraVar(key) {
    return key === 'base_url'
        || /^keycloak_/.test(key)
        || key === 'default_persona'
        || /_(user|pass|token|token_exp)$/.test(key)
        || /^camunda_/.test(key);
}

/**
 * Resolve a URL's infra vars (so the host is concrete) but keep data vars as
 * single-brace `{name}` placeholders so they survive into the catalog as named
 * params instead of collapsing to a blank value (which produced `//` URLs).
 * Records each data var it sees into `dataVarsOut` with its env default.
 */
function templatizeUrl(str, vars, dataVarsOut) {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{([^{}]+)\}\}/g, (m, k) => {
        const key = k.trim();
        if (isInfraVar(key)) {
            return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m;
        }
        if (dataVarsOut) dataVarsOut[key] = vars[key] || '';
        return `{${key}}`;
    });
}

function mostCommon(arr) {
    const counts = {};
    let best = arr[0], bestN = 0;
    for (const x of arr) {
        counts[x] = (counts[x] || 0) + 1;
        if (counts[x] > bestN) { bestN = counts[x]; best = x; }
    }
    return best;
}

function normalizePostmanCollection(collection, envVars = {}) {
    // Variable precedence: collection-level vars first, environment overrides.
    const vars = {};
    if (Array.isArray(collection.variable)) {
        for (const v of collection.variable) if (v && v.key) vars[v.key] = v.value;
    }
    Object.assign(vars, envVars);

    const endpoints = [];
    const serverUrls = [];
    const dataVars = {}; // data placeholders seen in URLs → env default value
    const defaultPersona = vars.default_persona || '';

    // Folder vars (persona / skipAuth) drive which token gets attached; they
    // inherit down the folder tree, mirroring the collection's pre-request script.
    const folderVar = (item, key) => {
        const list = Array.isArray(item.variable) ? item.variable : [];
        const found = list.find(v => v && v.key === key);
        return found ? found.value : undefined;
    };

    // Folders nest via item[]; requests are leaf items with a `request`.
    const walk = (items, folderName, authCtx) => {
        for (const item of items || []) {
            if (!item || typeof item !== 'object') continue;
            if (Array.isArray(item.item)) {
                const rawSkip = folderVar(item, 'skipAuth');
                const childCtx = {
                    persona: folderVar(item, 'persona') !== undefined ? folderVar(item, 'persona') : authCtx.persona,
                    skipAuth: rawSkip !== undefined ? (rawSkip === 'true' || rawSkip === true) : authCtx.skipAuth,
                };
                walk(item.item, item.name || folderName, childCtx);
            } else if (item.request) {
                // Skip auth-helper requests (e.g. the manual token-fetch in a
                // skipAuth folder) — they're not real API endpoints to test.
                if (authCtx.skipAuth) continue;
                endpoints.push(mapPostmanRequest(item, folderName, vars, serverUrls, authCtx, defaultPersona, dataVars));
            }
        }
    };
    walk(collection.item, '', { persona: undefined, skipAuth: false });

    const serverUrl = serverUrls.length ? mostCommon(serverUrls) : '';

    return {
        info: {
            title: (collection.info && collection.info.name) || 'Postman Collection',
            version: '',
            openApiVersion: 'postman',
            serverUrl,
            endpointCount: endpoints.length,
            auth: buildKeycloakAuth(vars),
            dataVars: Object.keys(dataVars).length > 0 ? dataVars : undefined,
        },
        endpoints,
    };
}

/**
 * Detect a Keycloak password-grant setup in the collection's variables and
 * return a config block the emitter uses to auto-authenticate generated tests.
 * Returns undefined for non-Keycloak collections (no behavior change).
 */
function buildKeycloakAuth(vars) {
    const kcBase = vars.keycloak_base;
    const realm = vars.keycloak_realm;
    if (!kcBase || !realm) return undefined;

    // Persona credentials: any `<name>_user` with a matching `<name>_pass`.
    const personas = {};
    for (const key of Object.keys(vars)) {
        const m = /^(.+)_user$/.exec(key);
        if (m && vars[`${m[1]}_pass`] !== undefined) {
            personas[m[1]] = { username: vars[key], password: vars[`${m[1]}_pass`] };
        }
    }
    if (Object.keys(personas).length === 0) return undefined;

    return {
        type: 'keycloak',
        tokenUrl: `${String(kcBase).replace(/\/$/, '')}/realms/${realm}/protocol/openid-connect/token`,
        clientId: vars.keycloak_client_id || '',
        clientSecret: vars.keycloak_client_secret || '',
        defaultPersona: vars.default_persona || '',
        personas,
    };
}

function mapPostmanRequest(item, folderName, vars, serverUrls, authCtx = {}, defaultPersona = '', dataVarsOut = null) {
    const req = typeof item.request === 'string' ? { method: 'GET', url: item.request } : item.request;
    const method = (req.method || 'GET').toUpperCase();

    const urlObj = req.url && typeof req.url === 'object' ? req.url : null;
    const rawUrl = typeof req.url === 'string' ? req.url : (urlObj && urlObj.raw) || '';
    // Resolve host/auth vars but keep data vars as {name} placeholders.
    const resolved = templatizeUrl(rawUrl, vars, dataVarsOut);

    let routePath = resolved;
    try {
        const u = new URL(resolved);
        if (u.origin) serverUrls.push(u.origin);
        // Decode so `{name}` placeholders survive (URL() percent-encodes braces).
        routePath = decodeURIComponent(u.pathname) || '/';
    } catch {
        // Relative path, or still-unresolved {{vars}} — drop any query string.
        routePath = (resolved.split('?')[0]) || '/';
    }
    if (!routePath.startsWith('/')) routePath = '/' + routePath;

    // Path params come from Postman `:param` and from kept `{name}` data vars.
    routePath = routePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const pathParams = (routePath.match(/\{([A-Za-z0-9_]+)\}/g) || [])
        .map(pv => ({ name: pv.slice(1, -1), in: 'path', required: true, type: 'string', description: '' }));

    // Query params; note which ones are bound to a data var (value is {{var}})
    // so the emitter can wire them to the shared test-data file.
    const queryParams = [];
    const queryData = {};
    if (urlObj && Array.isArray(urlObj.query)) {
        for (const q of urlObj.query) {
            if (q && q.key && q.disabled !== true) {
                queryParams.push({ name: q.key, in: 'query', required: false, type: 'string', description: q.description || '' });
                const dm = /^\{\{([^{}]+)\}\}$/.exec(String(q.value || '').trim());
                if (dm && !isInfraVar(dm[1].trim())) {
                    const v = dm[1].trim();
                    queryData[q.key] = v;
                    if (dataVarsOut) dataVarsOut[v] = vars[v] || '';
                }
            }
        }
    }

    const headerParams = [];
    for (const h of Array.isArray(req.header) ? req.header : []) {
        if (h && h.key && h.disabled !== true) {
            headerParams.push({ name: h.key, in: 'header', required: false, type: 'string', description: '' });
        }
    }

    // Request body: keep a concrete example (the LLM infers structure from it).
    let requestBodySchema = null;
    let multipart;
    const body = req.body;
    if (body && body.mode === 'raw' && body.raw) {
        const parsed = tryParseJson(resolveVars(body.raw, vars));
        requestBodySchema = parsed !== null ? parsed : resolveVars(body.raw, vars);
    } else if (body && body.mode === 'urlencoded' && Array.isArray(body.urlencoded)) {
        const obj = {};
        for (const p of body.urlencoded) if (p && p.key && p.disabled !== true) obj[p.key] = resolveVars(p.value || '', vars);
        requestBodySchema = obj;
    } else if (body && body.mode === 'formdata' && Array.isArray(body.formdata)) {
        const obj = {};
        // Multipart descriptor: which parts are files vs text, so the emitter can
        // attach a fixture file for file parts and the value for text parts.
        multipart = [];
        for (const p of body.formdata) {
            if (!p || !p.key || p.disabled === true) continue;
            if (p.type === 'file') {
                multipart.push({ name: p.key, kind: 'file' });
            } else {
                const val = resolveVars(p.value || '', vars);
                obj[p.key] = val;
                multipart.push({ name: p.key, kind: 'text', value: val });
            }
        }
        requestBodySchema = obj;
    }

    // Responses from saved examples; default to 200 if none captured.
    const responses = {};
    for (const r of Array.isArray(item.response) ? item.response : []) {
        if (r && r.code) responses[String(r.code)] = { description: r.name || '', schema: null };
    }
    if (Object.keys(responses).length === 0) responses['200'] = { description: '', schema: null };

    const operationId = (item.name && item.name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, ''))
        || `${method.toLowerCase()}_${routePath}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');

    // Effective persona = folder persona, else env default — unless the folder
    // marked skipAuth (e.g. the token-fetch request itself).
    const skipAuth = !!authCtx.skipAuth;
    const persona = skipAuth ? null : (authCtx.persona || defaultPersona || null);
    const secured = !skipAuth && !!persona;

    return {
        operationId,
        method,
        path: routePath,
        summary: item.name || '',
        tags: folderName ? [folderName] : [],
        pathParams,
        queryParams,
        headerParams,
        requestBodySchema,
        responses,
        security: secured ? [{ keycloak: [] }] : [],
        persona,
        secured,
        queryData: Object.keys(queryData).length > 0 ? queryData : undefined,
        multipart: multipart && multipart.length > 0 ? multipart : undefined,
    };
}

/**
 * Reduce a parameter object to the fields the generator needs.
 */
function mapParam(p) {
    // v3 wraps type info in `schema`; v2 puts type/format on the param itself.
    const schema = p.schema || {};
    return {
        name: p.name,
        in: p.in,
        required: !!p.required,
        type: schema.type || p.type || 'string',
        format: schema.format || p.format || undefined,
        enum: schema.enum || p.enum || undefined,
        description: p.description || '',
    };
}
