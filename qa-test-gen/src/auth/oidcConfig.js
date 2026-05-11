import { WebStorageStateStore } from 'oidc-client-ts';

const KC_URL = import.meta.env.VITE_KEYCLOAK_URL;
const KC_REALM = import.meta.env.VITE_KEYCLOAK_REALM;
const KC_CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID;

if (!KC_URL || !KC_REALM || !KC_CLIENT_ID) {
    console.error('[oidc] Missing VITE_KEYCLOAK_URL / VITE_KEYCLOAK_REALM / VITE_KEYCLOAK_CLIENT_ID. ' +
        'Login will fail until these are set in .env.');
}

const BASE = import.meta.env.BASE_URL;       // '/' in dev, '/aaqua/' in QA

export const oidcConfig = {
    authority: `${KC_URL}/realms/${KC_REALM}`,
    client_id: KC_CLIENT_ID,
    redirect_uri: `${window.location.origin}${BASE}auth/callback`,
    post_logout_redirect_uri: `${window.location.origin}${BASE}`,
    response_type: 'code',
    scope: 'openid profile email',
    automaticSilentRenew: true,
    loadUserInfo: true,
    // Persist session across reloads. Using localStorage rather than sessionStorage so
    // the user stays signed in across tab restarts; tokens are short-lived (15 min) anyway.
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    // Strip OIDC params from the URL after a successful redirect callback.
    onSigninCallback: () => {
        window.history.replaceState({}, document.title, window.location.pathname);
    },
};

/**
 * Read realm roles from the user's Keycloak access_token.
 *
 * Realm roles live in the access_token's `realm_access.roles` claim, not in
 * `profile` (which is built from the id_token / /userinfo response and carries
 * identity claims only). This decoder accepts the oidc-client-ts user object
 * and returns the roles array, or [] if anything along the path is missing.
 */
export function rolesOf(user) {
    const token = user?.access_token;
    if (!token) return [];
    try {
        const payload = JSON.parse(
            atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
        );
        return payload?.realm_access?.roles ?? [];
    } catch {
        return [];
    }
}
