import React, { useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import { Loader2, ShieldOff } from 'lucide-react';
import { rolesOf } from './oidcConfig';

/**
 * Wrap a route to require authentication and (optionally) one of a set of realm roles.
 *
 *   <ProtectedRoute><MyPage /></ProtectedRoute>
 *   <ProtectedRoute requireRoles={['admin']}><AdminPage /></ProtectedRoute>
 */
export default function ProtectedRoute({ children, requireRoles, allowedEmails }) {
    const auth = useAuth();

    useEffect(() => {
        // Trigger redirect to Keycloak only once auth has finished initializing.
        if (!auth.isLoading && !auth.isAuthenticated && !auth.activeNavigator && !auth.error) {
            auth.signinRedirect();
        }
        // signinRedirect is stable across renders in oidc-client-ts; depending on
        // the booleans avoids re-firing the effect when the rest of `auth` mutates.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [auth.isLoading, auth.isAuthenticated, auth.activeNavigator, auth.error]);

    if (auth.isLoading || auth.activeNavigator) {
        return <FullscreenStatus icon={<Loader2 className="spin" size={32} />} text="Authenticating…" />;
    }

    if (auth.error) {
        return <FullscreenStatus
            icon={<ShieldOff size={32} />}
            text={`Authentication error: ${auth.error.message}`}
        />;
    }

    if (!auth.isAuthenticated) {
        return <FullscreenStatus icon={<Loader2 className="spin" size={32} />} text="Redirecting to sign in…" />;
    }

    if (requireRoles && requireRoles.length) {
        const roles = rolesOf(auth.user);
        const ok = requireRoles.some(r => roles.includes(r));
        if (!ok) {
            return <FullscreenStatus
                icon={<ShieldOff size={32} />}
                text={`Forbidden — requires role: ${requireRoles.join(' or ')}`}
            />;
        }
    }

    if (allowedEmails && allowedEmails.length) {
        const email = auth.user?.profile?.email;
        if (!allowedEmails.includes(email)) {
            return <FullscreenStatus
                icon={<ShieldOff size={32} />}
                text="Forbidden — Access restricted to authorized administrators."
            />;
        }
    }

    return children;
}

function FullscreenStatus({ icon, text }) {
    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: '1rem',
            minHeight: '60vh',
            color: 'var(--text-secondary)',
        }}>
            {icon}
            <p>{text}</p>
            <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
        </div>
    );
}
