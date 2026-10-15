const API_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/agent`;

/**
 * Execute LangGraph Auto-Healing Agent loop for a failed test.
 */
export const runAutoHealAgent = async (params) => {
    const res = await fetch(`${API_URL}/auto-heal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown agent error' }));
        throw new Error(err.error || 'LangGraph Auto-Heal agent failed');
    }
    return res.json();
};

/**
 * Execute LangGraph Self-Correcting Test Generator Agent.
 */
export const runTestGenAgent = async (prompt, framework = 'playwright') => {
    const res = await fetch(`${API_URL}/generate-tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, framework }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown agent error' }));
        throw new Error(err.error || 'LangGraph Test Generator agent failed');
    }
    return res.json();
};
