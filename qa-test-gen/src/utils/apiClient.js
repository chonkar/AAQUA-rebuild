/**
 * Thin fetch wrapper that injects the Keycloak access token from the OIDC context.
 * Usage:
 *   const auth = useAuth();
 *   const api = createApiClient(() => auth.user?.access_token);
 *   const data = await api.get('/api/projects');
 */
import { oidcConfig } from '../auth/oidcConfig.js';

const API_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '');   // '' in dev, '/aaqua' in QA

/**
 * Base path for backend API calls, including the '/api' segment
 * (e.g. '/api' in dev, '/aaqua/api' in QA). Consumers that can't route through
 * createApiClient's fetch wrapper (EventSource, raw fetch to non-JSON
 * endpoints) build their URLs as `${API_BASE}/whatever`.
 */
export const API_BASE = `${API_PREFIX}/api`;

/**
 * Read the current Keycloak access token outside of a React component.
 *
 * react-oidc-context (see src/auth/oidcConfig.js) persists the oidc-client-ts
 * user in localStorage via WebStorageStateStore under the key
 * `oidc.user:{authority}:{client_id}` — the same session createApiClient's
 * callers read via `auth.user?.access_token` from useAuth(). This reads that
 * same storage entry directly for call sites (EventSource, SSE) that can't
 * use a hook.
 */
export function getAccessToken() {
    try {
        const key = `oidc.user:${oidcConfig.authority}:${oidcConfig.client_id}`;
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const user = JSON.parse(raw);
        return user?.access_token ?? null;
    } catch (e) {
        console.error('[apiClient] Failed reading access token from storage:', e);
        return null;
    }
}

export function createApiClient(getToken) {
    async function request(path, { method = 'GET', body, headers = {} } = {}) {
        const token = typeof getToken === 'function' ? getToken() : getToken;
        
        // Auto-inject user's dynamic JIRA configuration if present in localStorage
        const jiraConfigStr = window.localStorage.getItem('aaqua_jira_config');
        const jiraHeaders = {};
        if (jiraConfigStr) {
            try {
                const config = JSON.parse(jiraConfigStr);
                if (config.url) jiraHeaders['x-jira-url'] = config.url.trim();
                if (config.email) jiraHeaders['x-jira-email'] = config.email.trim();
                if (config.token) jiraHeaders['x-jira-token'] = config.token.trim();
                if (config.projectKey) jiraHeaders['x-jira-project-key'] = config.projectKey.trim();
            } catch (e) {
                console.error('[apiClient] Failed parsing local JIRA config:', e);
            }
        }

        const res = await fetch(`${API_PREFIX}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...jiraHeaders,
                ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        const text = await res.text();
        const data = text ? safeJson(text) : null;

        if (!res.ok) {
            const err = new Error((data && data.error) || `Request failed (${res.status})`);
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    return {
        get: (path, opts) => request(path, { ...opts, method: 'GET' }),
        post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
        put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
        del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
    };
}

function safeJson(text) {
    try { return JSON.parse(text); } catch { return text; }
}
