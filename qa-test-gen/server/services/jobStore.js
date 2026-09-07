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

export async function createJob({ type, ownerId = null, payload = null }) {
    return Job.create({ type, owner_id: ownerId, payload });
}

export async function updateProgress(id, { progress, phase }) {
    const job = await Job.findByPk(id);
    if (!job) return null;
    await job.update({ status: 'running', progress, ...(phase !== undefined && { phase }) });
    emit(job);
    return job;
}

export async function completeJob(id, result) {
    const job = await Job.findByPk(id);
    if (!job) return null;
    await job.update({ status: 'completed', progress: 100, result });
    emit(job);
    return job;
}

export async function failJob(id, err) {
    const job = await Job.findByPk(id);
    if (!job) return null;
    await job.update({ status: 'failed', error: String(err?.message ?? err) });
    emit(job);
    return job;
}

export async function getJob(id) {
    return Job.findByPk(id);
}
