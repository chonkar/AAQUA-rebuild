import { EventEmitter } from 'node:events';
import { Job } from '../models/index.js';

// In-process pub/sub for job progress. Consumers (e.g. the SSE endpoint in
// Task 8) subscribe to `job:${id}` to get pushed updates without polling the
// DB. The DB row remains the source of truth — jobs survive process restarts,
// events are just a live-notification convenience layered on top.
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(200);

function emit(job) {
    jobEvents.emit(`job:${job.id}`, {
        id: job.id,
        status: job.status,
        progress: job.progress,
        phase: job.phase ?? null,
        result: job.result ?? null,
        error: job.error ?? null,
    });
}

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

// Contract split: createJob/getJob are called directly from request handlers
// that need to surface a 5xx on DB failure, so they throw normally. The three
// mutators below are typically invoked from detached background runners (no
// caller waiting to turn a rejection into a response) — an unhandled
// rejection there would crash the process, which violates the app-wide "DB
// failure is non-fatal" invariant. They catch, warn, and resolve null instead.

export async function createJob({ type, ownerId = null, payload = null }) {
    return Job.create({ type, owner_id: ownerId, payload });
}

export async function updateProgress(id, { progress, phase }) {
    try {
        const job = await Job.findByPk(id);
        if (!job) return null;
        if (TERMINAL_STATUSES.has(job.status)) return job; // first terminal state wins; no re-emit
        await job.update({ status: 'running', progress, ...(phase !== undefined && { phase }) });
        emit(job);
        return job;
    } catch (err) {
        console.warn(`[jobStore] updateProgress failed for job ${id}:`, err.message);
        return null;
    }
}

export async function completeJob(id, result) {
    try {
        const job = await Job.findByPk(id);
        if (!job) return null;
        if (TERMINAL_STATUSES.has(job.status)) return job; // first terminal state wins; no re-emit
        await job.update({ status: 'completed', progress: 100, result });
        emit(job);
        return job;
    } catch (err) {
        console.warn(`[jobStore] completeJob failed for job ${id}:`, err.message);
        return null;
    }
}

export async function failJob(id, err) {
    try {
        const job = await Job.findByPk(id);
        if (!job) return null;
        if (TERMINAL_STATUSES.has(job.status)) return job; // first terminal state wins; no re-emit
        await job.update({ status: 'failed', error: String(err?.message ?? err) });
        emit(job);
        return job;
    } catch (e) {
        console.warn(`[jobStore] failJob failed for job ${id}:`, e.message);
        return null;
    }
}

export async function getJob(id) {
    return Job.findByPk(id);
}
