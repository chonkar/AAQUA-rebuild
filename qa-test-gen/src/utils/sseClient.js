import { getAccessToken, API_BASE } from './apiClient.js'

/**
 * Subscribe to a backend job's progress over Server-Sent Events
 * (`GET /api/events/:jobId`).
 *
 * Frames are STATE SNAPSHOTS, not deltas — the server replays the job's
 * current state on connect, and immediately after that replay it may
 * deliver one stale, already-superseded non-terminal frame (a buffered
 * event older than the row the replay read). That means `onUpdate` can
 * observe `progress` tick backwards exactly once right after connecting.
 * Consumers that need strictly monotonic progress should clamp
 * (`next = Math.max(prev, next)`) rather than assuming frames only move
 * forward.
 *
 * The browser's native EventSource auto-reconnects on network drops; the
 * server's replay-on-connect behavior means a reconnect naturally resumes
 * from current state rather than replaying full history.
 *
 * @param {string} jobId
 * @param {{ onUpdate?: (frame: object) => void, onDone?: (result: any) => void, onError?: (error: any) => void }} handlers
 * @returns {() => void} unsubscribe function that closes the stream
 */
export function subscribeToJob(jobId, { onUpdate, onDone, onError } = {}) {
    const url = `${API_BASE}/events/${jobId}?access_token=${encodeURIComponent(getAccessToken())}`
    const es = new EventSource(url)

    es.onmessage = (evt) => {
        let data
        try {
            data = JSON.parse(evt.data)
        } catch {
            // Ignore unparseable frames (heartbeat comments never reach onmessage,
            // but be defensive against malformed payloads regardless).
            return
        }

        if (data.status === 'completed') {
            onDone?.(data.result)
            es.close()
        } else if (data.status === 'failed') {
            onError?.(data.error)
            es.close()
        } else {
            onUpdate?.(data)
        }
    }

    return () => es.close()
}
