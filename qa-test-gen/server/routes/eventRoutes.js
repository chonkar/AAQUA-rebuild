import { Router } from 'express';
import { AuthError, verifyToken } from '../middleware/auth.js';
import { getJob, jobEvents } from '../services/jobStore.js';

const router = Router();

// Terminal statuses mirror jobStore's — once a job reaches one, no further
// events will ever be emitted for it, so the stream is closed.
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

// Comment-only SSE frame sent periodically to keep idle connections alive
// through proxies (and to let the client notice a dead socket).
const HEARTBEAT_MS = 25_000;

function snapshot(job) {
    // Key order matches jobStore's emit() payload so the dedupe below can
    // compare serialized frames directly.
    return {
        id: job.id,
        status: job.status,
        progress: job.progress,
        phase: job.phase ?? null,
        result: job.result ?? null,
        error: job.error ?? null,
    };
}

/**
 * GET /api/events/:jobId — Server-Sent Events stream of job progress.
 *
 * Auth rides a query param rather than the Authorization header because the
 * browser EventSource API cannot set headers. The token is verified with the
 * same Keycloak/JWKS logic as every other endpoint (see middleware/auth.js
 * `verifyToken`); this route is deliberately mounted WITHOUT
 * `authenticateToken` so it can read the token from the query string.
 *
 * Emits the job's current state immediately on connect, so a client that
 * reconnects (or subscribes after the job already advanced) never misses the
 * latest status — the DB row is the source of truth, events are a live
 * notification layered on top.
 */
router.get('/:jobId', async (req, res) => {
    const { jobId } = req.params;

    // Auth first: nothing is subscribed and no row is read until the token
    // checks out.
    let user;
    try {
        const token = req.query.access_token;
        if (!token || typeof token !== 'string') {
            return res.status(401).json({ error: 'Authentication required. Provide access_token query param.' });
        }
        user = await verifyToken(token);
    } catch (err) {
        // A misconfigured identity provider is a server fault — it must not
        // masquerade as a client-side "invalid token".
        if (err instanceof AuthError && err.status === 503) {
            return res.status(503).json({ error: err.message });
        }
        return res.status(401).json({ error: 'Invalid token.' });
    }

    const channel = `job:${jobId}`;

    // ─── Subscribe BEFORE reading the row ───────────────────────────────
    // The job can reach a terminal status during the `await getJob(...)`.
    // Subscribing afterwards would drop that event: the row read would show
    // "running", nothing further would ever be emitted, and the heartbeat
    // would hold a stale stream open forever. So we attach the listener
    // first and buffer anything that arrives before the stream is open,
    // then replay the row snapshot and flush the buffer.
    let buffered = [];
    let streaming = false;
    let lastFrame = null;
    let heartbeat = null;
    let cleanedUp = false;

    const send = (data) => {
        const frame = JSON.stringify(data);
        // A buffered event is often exactly the state the row read already
        // reflects (emit happens after the DB write) — don't send it twice.
        if (frame === lastFrame) return false;
        lastFrame = frame;
        res.write(`data: ${frame}\n\n`);
        return true;
    };

    function onEvent(event) {
        if (!streaming) {
            buffered.push(event);
            return;
        }
        send(event);
        if (TERMINAL_STATUSES.has(event.status)) {
            cleanup();
            res.end();
        }
    }

    function cleanup() {
        if (cleanedUp) return;
        cleanedUp = true;
        if (heartbeat) clearInterval(heartbeat);
        jobEvents.off(channel, onEvent);
    }

    jobEvents.on(channel, onEvent);
    // Registered immediately so a disconnect during the row read (or on the
    // 404/503 branches below) still drains the listener.
    req.on('close', cleanup);
    res.on('close', cleanup);

    let job;
    try {
        job = await getJob(jobId);
    } catch (err) {
        // getJob throws on DB failure (its documented contract). DB outage is
        // non-fatal app-wide, so answer 503 rather than let the rejection
        // bubble to the error handler as a 500.
        console.warn(`[events] job lookup failed for ${jobId}:`, err.message);
        cleanup();
        return res.status(503).json({ error: 'job store unavailable' });
    }
    if (!job) {
        cleanup();
        return res.status(404).json({ error: 'job not found' });
    }
    // Ownership: 404 rather than 403 so the endpoint doesn't leak which job
    // ids exist. Jobs with no owner_id are system jobs and stay readable.
    if (job.owner_id && job.owner_id !== user.id) {
        cleanup();
        return res.status(404).json({ error: 'job not found' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx response buffering
    });
    streaming = true;

    // Replay current state so reconnects never miss the latest status.
    send(snapshot(job));

    // Already finished: the row is authoritative and final, so discard the
    // buffer (it can only hold states this snapshot supersedes) and don't
    // hold a dead stream — or its heartbeat timer — open.
    if (TERMINAL_STATUSES.has(job.status)) {
        cleanup();
        return res.end();
    }

    // Flush anything emitted while we were reading the row, in order.
    const pending = buffered;
    buffered = [];
    for (const event of pending) {
        send(event);
        if (TERMINAL_STATUSES.has(event.status)) {
            cleanup();
            return res.end();
        }
    }

    heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
});

export default router;
