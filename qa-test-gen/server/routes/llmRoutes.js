import fs from 'fs';
import dotenv from 'dotenv';
import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';

dotenv.config();

const router = Router();

function isValidKey(k) {
    if (!k || typeof k !== 'string') return false;
    const trimmed = k.trim();
    if (trimmed.length < 15) return false;
    if (trimmed.includes('replace-with') || trimmed.includes('your-api-key') || trimmed.endsWith('-key')) return false;
    return true;
}

function resolveApiKey() {
    const candidates = [
        process.env.VITE_LLM_API_KEY,
        process.env.LLM_API_KEY,
    ];
    try {
        if (fs.existsSync('/run/secrets/llm_api_key')) {
            candidates.push(fs.readFileSync('/run/secrets/llm_api_key', 'utf8').trim());
        }
        if (fs.existsSync('/opt/shared-infra/secrets/aaqua/llm_api_key.txt')) {
            candidates.push(fs.readFileSync('/opt/shared-infra/secrets/aaqua/llm_api_key.txt', 'utf8').trim());
        }
    } catch {}

    for (const c of candidates) {
        if (isValidKey(c)) return c.trim();
    }
    return undefined;
}

// gpt-oss and friends accept only these three levels; anything else is a
// client bug worth surfacing as a 400 rather than forwarding upstream.
const VALID_REASONING_EFFORTS = ['low', 'medium', 'high'];

const MIN_MAX_TOKENS = 1;
const MAX_MAX_TOKENS = 32000;
const DEFAULT_MAX_TOKENS = 12000;

function clampMaxTokens(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return DEFAULT_MAX_TOKENS;
    return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, n));
}

/**
 * POST /api/llm/generate — server-side proxy for LLM chat completions.
 *
 * The browser never talks to the LLM gateway directly: it POSTs a prompt
 * here (Bearer-authenticated like every other API route) and this route
 * relays the upstream OpenAI-compatible `/chat/completions` SSE stream back
 * verbatim. Keeps the LLM API key server-side only.
 */
router.post('/generate', authenticateToken, async (req, res) => {
    const { prompt, maxTokens, temperature, reasoningEffort } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
        return res.status(400).json({ error: 'prompt is required' });
    }
    if (temperature !== undefined && !Number.isFinite(temperature)) {
        return res.status(400).json({ error: 'temperature must be a finite number' });
    }
    if (reasoningEffort !== undefined && reasoningEffort !== null
        && !VALID_REASONING_EFFORTS.includes(reasoningEffort)) {
        return res.status(400).json({
            error: `reasoningEffort must be one of ${VALID_REASONING_EFFORTS.join(', ')}`,
        });
    }

    const clampedMaxTokens = clampMaxTokens(maxTokens ?? DEFAULT_MAX_TOKENS);
    const endpoint = process.env.VITE_LLM_ENDPOINT || process.env.LLM_ENDPOINT || 'https://llm.lab.aaseya.com/v1';
    const model = process.env.VITE_LLM_MODEL || process.env.LLM_MODEL || 'gemma-4';
    const apiKey = resolveApiKey();

    let upstream;
    try {
        upstream = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: clampedMaxTokens,
                ...(temperature !== undefined && { temperature }),
                ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
                stream: true,
            }),
        });
    } catch (err) {
        console.error('[LLM Proxy] Connection failed to', endpoint, err?.message);
        return res.status(502).json({ error: 'LLM upstream unreachable', detail: err?.message });
    }

    if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        console.error('[LLM Proxy] Upstream returned error:', upstream.status, detail.slice(0, 500));
        return res.status(502).json({ error: `LLM upstream ${upstream.status}`, detail: detail.slice(0, 500) });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
    });

    const reader = upstream.body.getReader();

    // `req.on('close')` looks like the right disconnect hook but is dead code
    // here: per Node 16+ semantics it fires once the request MESSAGE finishes
    // arriving — which happens while we're still awaiting the upstream fetch,
    // long before this listener is even attached — and it never fires again
    // on a later socket abort. `res.on('close')` is what actually fires when
    // the client goes away mid-response (abort, navigation, tab close), so
    // that's the one that can cancel the upstream reader.
    res.on('close', () => {
        if (!res.writableEnded) reader.cancel().catch(() => {});
    });

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value); // relay OpenAI SSE bytes verbatim — no decode/re-encode needed
        }
    } catch {
        // Upstream stream broke mid-flight (network error, upstream crash).
        // Tell the client explicitly rather than just closing — a silent
        // res.end() here is indistinguishable from a clean [DONE] finish.
        res.write('data: {"error":"upstream stream terminated"}\n\n');
    } finally {
        res.end();
    }
});

export default router;
