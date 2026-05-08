/**
 * Thin fetch wrapper that injects the Keycloak access token from the OIDC context.
 * Usage:
 *   const auth = useAuth();
 *   const api = createApiClient(() => auth.user?.access_token);
 *   const data = await api.get('/api/security/projects');
 */
export function createApiClient(getToken) {
    async function request(path, { method = 'GET', body, headers = {} } = {}) {
        const token = typeof getToken === 'function' ? getToken() : getToken;
        const res = await fetch(path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
