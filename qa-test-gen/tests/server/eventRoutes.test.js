import { expect, test, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { EventEmitter } from 'node:events'

const emitter = new EventEmitter()
emitter.setMaxListeners(50)

const jobRow = { id: 'j1', status: 'running', progress: 10, phase: 'starting', result: null, error: null }
const doneRow = { id: 'j-done', status: 'completed', progress: 100, phase: 'done', result: { ok: true }, error: null }

let dbDown = false

vi.mock('../../server/services/jobStore.js', () => ({
  jobEvents: emitter,
  getJob: vi.fn(async (id) => {
    if (dbDown) throw new Error('connection refused')
    if (id === 'j1') return jobRow
    if (id === 'j-done') return doneRow
    return null
  }),
}))
vi.mock('../../server/middleware/auth.js', () => ({
  verifyToken: vi.fn(async (t) => {
    if (t !== 'good-token') throw new Error('bad token')
    return { id: 'u1', email: 't@aaseya.com' }
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

test('rejects missing/invalid token with 401', async () => {
  await request(makeApp()).get('/api/events/j1').expect(401)
  await request(makeApp()).get('/api/events/j1?access_token=bad').expect(401)
})

test('unknown job returns 404', async () => {
  await request(makeApp()).get('/api/events/nope?access_token=good-token').expect(404)
})

test('job store failure returns 503', async () => {
  dbDown = true
  try {
    await request(makeApp()).get('/api/events/j1?access_token=good-token').expect(503)
  } finally {
    dbDown = false
  }
})

test('streams initial state then live updates as SSE', async () => {
  const app = makeApp()
  const pending = collectSse(app, '/api/events/j1?access_token=good-token',
    (body) => body.includes('"progress":55'))
  // Emit repeatedly until the subscriber is attached (avoids a fixed-delay race).
  const pump = setInterval(
    () => emitter.emit('job:j1', { ...jobRow, progress: 55, phase: 'halfway' }), 25)
  try {
    const res = await pending
    expect(res.headers['content-type']).toMatch('text/event-stream')
    expect(res.body).toContain('"progress":10')  // replayed initial state
    expect(res.body).toContain('"progress":55')  // live event
  } finally {
    clearInterval(pump)
  }
})

test('a terminal job replays its state and closes the stream immediately', async () => {
  const res = await collectSse(makeApp(), '/api/events/j-done?access_token=good-token', () => false)
  expect(res.headers['content-type']).toMatch('text/event-stream')
  expect(res.body).toContain('"status":"completed"')
  expect(res.body).toContain('"progress":100')
  // Stream ended on its own — collectSse resolved via 'end'/'close', not a chunk match.
  expect(emitter.listenerCount('job:j-done')).toBe(0)
})

test('closes the stream when a live event reaches a terminal status', async () => {
  const app = makeApp()
  const pending = collectSse(app, '/api/events/j1?access_token=good-token', () => false)
  const pump = setInterval(
    () => emitter.emit('job:j1', { ...jobRow, status: 'failed', error: 'boom' }), 25)
  try {
    const res = await pending
    expect(res.body).toContain('"status":"failed"')
  } finally {
    clearInterval(pump)
  }
})
