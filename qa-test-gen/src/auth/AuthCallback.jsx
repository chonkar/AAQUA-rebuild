import React, { useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

/** Mounted at /auth/callback. The OIDC library completes the code exchange in the
 *  background; once authenticated, we route the user to the home page. */
export default function AuthCallback() {
    const auth = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        if (auth.isAuthenticated) {
            navigate('/', { replace: true });
        }
    }, [auth.isAuthenticated, navigate]);

    return (
        <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            minHeight: '60vh', flexDirection: 'column', gap: '1rem',
        }}>
            <Loader2 className="spin" size={32} />
            <p>Finishing sign-in…</p>
            {auth.error && <p style={{ color: 'var(--error)' }}>{auth.error.message}</p>}
            <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
        </div>
    );
}
