import { Router } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { getJob, jobEvents } from '../services/jobStore.js';

const router = Router();

// Terminal statuses mirror jobStore's — once a job reaches one, no further
// events will ever be emitted for it, so the stream is closed.
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

// Comment-only SSE frame sent periodically to keep idle connections alive
// through proxies (and to let the client notice a dead socket).
const HEARTBEAT_MS = 25_000;

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

    try {
        const token = req.query.access_token;
        if (!token || typeof token !== 'string') {
            return res.status(401).json({ error: 'Authentication required. Provide access_token query param.' });
        }
        await verifyToken(token);
    } catch {
        return res.status(401).json({ error: 'Invalid token.' });
    }

    let job;
    try {
        job = await getJob(jobId);
    } catch (err) {
        // getJob throws on DB failure (its documented contract). DB outage is
        // non-fatal app-wide, so answer 503 rather than let the rejection
        // bubble to the error handler as a 500.
        console.warn(`[events] job lookup failed for ${jobId}:`, err.message);
        return res.status(503).json({ error: 'job store unavailable' });
    }
    if (!job) {
        return res.status(404).json({ error: 'job not found' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx response buffering
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // Replay current state so reconnects never miss the latest status.
    send({
        id: job.id,
        status: job.status,
        progress: job.progress,
        phase: job.phase ?? null,
        result: job.result ?? null,
        error: job.error ?? null,
    });

    // Already finished: nothing more will ever be emitted, so don't hold a
    // dead stream (and its heartbeat timer) open.
    if (TERMINAL_STATUSES.has(job.status)) {
        return res.end();
    }

    const channel = `job:${jobId}`;
    const onEvent = (event) => {
        send(event);
        if (TERMINAL_STATUSES.has(event.status)) {
            cleanup();
            res.end();
        }
    };

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    let cleanedUp = false;
    function cleanup() {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        jobEvents.off(channel, onEvent);
    }

    jobEvents.on(channel, onEvent);
    req.on('close', cleanup);
    res.on('close', cleanup);
});

export default router;
