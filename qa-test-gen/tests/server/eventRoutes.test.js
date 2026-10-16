import { expect, test, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { EventEmitter } from 'node:events'

const emitter = new EventEmitter()
emitter.setMaxListeners(50)

// verifyToken resolves to this user; job rows carry owner_id to exercise the
// ownership gate.
const OWNER = 'u1'

const rows = {
  j1: { id: 'j1', status: 'running', progress: 10, phase: 'starting', result: null, error: null, owner_id: OWNER },
  'j-done': { id: 'j-done', status: 'completed', progress: 100, phase: 'done', result: { ok: true }, error: null, owner_id: OWNER },
  'j-other': { id: 'j-other', status: 'running', progress: 5, phase: 'starting', result: null, error: null, owner_id: 'u2' },
  'j-nobody': { id: 'j-nobody', status: 'running', progress: 7, phase: 'starting', result: null, error: null, owner_id: null },
  // Used by the subscribe-before-fetch race test: the mocked getJob emits a
  // terminal event just before resolving a still-running row.
  'j-race': { id: 'j-race', status: 'running', progress: 20, phase: 'starting', result: null, error: null, owner_id: OWNER },
}

let dbDown = false
let idpDown = false

vi.mock('../../server/services/jobStore.js', () => ({
  jobEvents: emitter,
  getJob: vi.fn(async (id) => {
    if (dbDown) throw new Error('connection refused')
    if (id === 'j-race') {
      // Terminal transition lands in the window between the route subscribing
      // and this read resolving — the classic lost-event race.
      emitter.emit('job:j-race', { ...rows['j-race'], status: 'completed', progress: 100, phase: 'done' })
    }
    return rows[id] ?? null
  }),
}))

class AuthError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

vi.mock('../../server/middleware/auth.js', () => ({
  AuthError,
  verifyToken: vi.fn(async (t) => {
    if (idpDown) throw new AuthError(503, 'Identity provider is not configured.')
    if (t !== 'good-token') throw new Error('bad token')
    return { id: OWNER, email: 't@aaseya.com' }
  }),
}))

const { default: eventRoutes } = await import('../../server/routes/eventRoutes.js')

function makeApp() {
  const app = express()
  app.use('/api/events', eventRoutes)
  return app
}

// Opens an SSE request, feeds every chunk to `onChunk`, and resolves as soon as
// `onChunk` returns true (or when the server ends the stream on its own).
function collectSse(app, path, onChunk) {
  return new Promise((resolve, reject) => {
    let body = ''
    let settled = false
    const finish = (res) => {
      if (settled) return
      settled = true
      resolve({ headers: res.headers, body })
    }
    const req = request(app).get(path)
      .buffer(false)
      .parse((res) => {
        res.on('data', (c) => {
          body += c.toString()
          if (onChunk(body)) { res.destroy(); finish(res) }
        })
        res.on('end', () => finish(res))
        res.on('close', () => finish(res))
        res.on('error', (e) => { if (!settled) reject(e) })
      })
    req.end((err) => {
      if (err && !settled && !/aborted|socket hang up|ECONNRESET/i.test(String(err))) reject(err)
    })
  })
}

async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return predicate()
}

test('rejects missing/invalid token with 401', async () => {
  await request(makeApp()).get('/api/events/j1').expect(401)
  await request(makeApp()).get('/api/events/j1?access_token=bad').expect(401)
})

test('a misconfigured identity provider surfaces as 503, not 401', async () => {
  idpDown = true
  try {
    const res = await request(makeApp()).get('/api/events/j1?access_token=good-token').expect(503)
    expect(res.body.error).toMatch(/identity provider/i)
  } finally {
    idpDown = false
  }
})

test('unknown job returns 404', async () => {
  await request(makeApp()).get('/api/events/nope?access_token=good-token').expect(404)
  expect(emitter.listenerCount('job:nope')).toBe(0)
})

test('job store failure returns 503', async () => {
  dbDown = true
  try {
    await request(makeApp()).get('/api/events/j1?access_token=good-token').expect(503)
  } finally {
    dbDown = false
  }
  expect(await waitFor(() => emitter.listenerCount('job:j1') === 0)).toBe(true)
})

test('a job owned by someone else returns 404 and leaks no listener', async () => {
  const res = await request(makeApp()).get('/api/events/j-other?access_token=good-token').expect(404)
  expect(res.body.error).toBe('job not found')
  expect(emitter.listenerCount('job:j-other')).toBe(0)
})

test('an ownerless (system) job streams to any authenticated user', async () => {
  const res = await collectSse(makeApp(), '/api/events/j-nobody?access_token=good-token',
    (body) => body.includes('"progress":7'))
  expect(res.headers['content-type']).toMatch('text/event-stream')
  expect(res.body).toContain('"progress":7')
})

test('streams initial state then live updates as SSE, and drains on disconnect', async () => {
  const app = makeApp()
  const pending = collectSse(app, '/api/events/j1?access_token=good-token',
    (body) => body.includes('"progress":55'))
  // Emit repeatedly until the subscriber is attached (avoids a fixed-delay race).
  const pump = setInterval(
    () => emitter.emit('job:j1', { ...rows.j1, progress: 55, phase: 'halfway' }), 25)
  try {
    const res = await pending
    expect(res.headers['content-type']).toMatch('text/event-stream')
    expect(res.body).toContain('"progress":10')  // replayed initial state
    expect(res.body).toContain('"progress":55')  // live event
  } finally {
    clearInterval(pump)
  }
  // collectSse destroyed the socket — the route must drop its listener and
  // clear the heartbeat, or every closed tab leaks one of each.
  expect(await waitFor(() => emitter.listenerCount('job:j1') === 0)).toBe(true)
})

test('a terminal job replays its state and closes the stream immediately', async () => {
  const res = await collectSse(makeApp(), '/api/events/j-done?access_token=good-token', () => false)
  expect(res.headers['content-type']).toMatch('text/event-stream')
  expect(res.body).toContain('"status":"completed"')
  expect(res.body).toContain('"progress":100')
  // Stream ended on its own — collectSse resolved via end/close, not a chunk match.
  expect(emitter.listenerCount('job:j-done')).toBe(0)
})

test('closes the stream when a live event reaches a terminal status', async () => {
  const app = makeApp()
  const pending = collectSse(app, '/api/events/j1?access_token=good-token', () => false)
  const pump = setInterval(
    () => emitter.emit('job:j1', { ...rows.j1, status: 'failed', error: 'boom' }), 25)
  try {
    const res = await pending
    expect(res.body).toContain('"status":"failed"')
  } finally {
    clearInterval(pump)
  }
  expect(await waitFor(() => emitter.listenerCount('job:j1') === 0)).toBe(true)
})

test('a job that goes terminal during the row read still delivers the terminal event', async () => {
  // getJob emits completed then resolves a running row. Subscribing only
  // after the read would lose that event and hang the stream open forever.
  const res = await collectSse(makeApp(), '/api/events/j-race?access_token=good-token', () => false)
  expect(res.body).toContain('"progress":20')        // replayed (stale) row state
  expect(res.body).toContain('"status":"completed"') // buffered event, flushed
  expect(emitter.listenerCount('job:j-race')).toBe(0)
})
