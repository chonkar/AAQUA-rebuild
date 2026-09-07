import dotenv from 'dotenv';
import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';

dotenv.config();

const router = Router();

// Env resolution mirrors server/utils/llmClient.js and every call site in
// server/index.js exactly (VITE_* names, same defaults) — NOT the
// LLM_ENDPOINT/LLM_API_KEY/LLM_MODEL names from the original plan sketch, so
// this proxy works against the existing .env unchanged. Non-VITE names are
// accepted as a secondary fallback in case a future deploy sets those instead.
const LLM_ENDPOINT = process.env.VITE_LLM_ENDPOINT || process.env.LLM_ENDPOINT || 'https://llm.lab.aaseya.com/v1';
const LLM_MODEL = process.env.VITE_LLM_MODEL || process.env.LLM_MODEL || 'gemma-4';
const API_KEY = process.env.VITE_LLM_API_KEY || process.env.LLM_API_KEY;

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
    const { prompt, maxTokens, temperature } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
        return res.status(400).json({ error: 'prompt is required' });
    }
    if (temperature !== undefined && !Number.isFinite(temperature)) {
        return res.status(400).json({ error: 'temperature must be a finite number' });
    }

    const clampedMaxTokens = clampMaxTokens(maxTokens ?? DEFAULT_MAX_TOKENS);

    let upstream;
    try {
        upstream = await fetch(`${LLM_ENDPOINT}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(API_KEY && { Authorization: `Bearer ${API_KEY}` }),
            },
            body: JSON.stringify({
                model: LLM_MODEL,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: clampedMaxTokens,
                ...(temperature !== undefined && { temperature }),
                stream: true,
            }),
        });
    } catch (err) {
        return res.status(502).json({ error: 'LLM upstream unreachable', detail: err?.message });
    }

    if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
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
