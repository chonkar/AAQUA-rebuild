import { expect, test, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import http from 'node:http'

vi.mock('../../server/middleware/auth.js', () => ({
  authenticateToken: (req, _res, next) => { req.user = { id: 'u1' }; next() },
}))

// Mock upstream fetch: an OpenAI-style streaming body with two chunks then [DONE].
const sseBody = [
  'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
  'data: [DONE]\n\n',
].join('')
vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody, {
  status: 200, headers: { 'content-type': 'text/event-stream' },
})))

import llmRoutes from '../../server/routes/llmRoutes.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/llm', llmRoutes)
  return app
}

test('proxies prompt upstream with stream:true and relays token chunks', async () => {
  const res = await request(makeApp()).post('/api/llm/generate')
    .send({ prompt: 'hi', maxTokens: 100 }).expect(200)
  expect(res.headers['content-type']).toMatch('text/event-stream')
  expect(res.text).toContain('Hello')
  expect(res.text).toContain(' world')
  expect(res.text).toContain('[DONE]')
  const upstreamCall = fetch.mock.calls[0]
  expect(upstreamCall[0]).toMatch('/chat/completions')
  expect(JSON.parse(upstreamCall[1].body).stream).toBe(true)
})

test('reasoningEffort is forwarded upstream as reasoning_effort', async () => {
  fetch.mockClear()
  await request(makeApp()).post('/api/llm/generate')
    .send({ prompt: 'hi', reasoningEffort: 'low' }).expect(200)
  const body = JSON.parse(fetch.mock.calls[0][1].body)
  expect(body.reasoning_effort).toBe('low')
})

test('omitting reasoningEffort leaves reasoning_effort out of the upstream body', async () => {
  fetch.mockClear()
  await request(makeApp()).post('/api/llm/generate').send({ prompt: 'hi' }).expect(200)
  const body = JSON.parse(fetch.mock.calls[0][1].body)
  expect(body).not.toHaveProperty('reasoning_effort')
})

test('an invalid reasoningEffort is a 400 and never reaches upstream', async () => {
  fetch.mockClear()
  const res = await request(makeApp()).post('/api/llm/generate')
    .send({ prompt: 'hi', reasoningEffort: 'extreme' }).expect(400)
  expect(res.body.error).toMatch(/reasoningEffort must be one of/)
  expect(fetch).not.toHaveBeenCalled()
})

test('missing prompt is a 400', async () => {
  await request(makeApp()).post('/api/llm/generate').send({}).expect(400)
})

test('upstream 500 surfaces as a 502 with error JSON', async () => {
  fetch.mockImplementationOnce(async () => new Response('boom upstream', { status: 500 }))
  const res = await request(makeApp()).post('/api/llm/generate')
    .send({ prompt: 'hi' }).expect(502)
  expect(res.body.error).toMatch(/LLM upstream 500/)
})

test('a rejected upstream fetch (network failure) surfaces as a 502', async () => {
  fetch.mockImplementationOnce(async () => { throw new Error('ECONNREFUSED') })
  const res = await request(makeApp()).post('/api/llm/generate')
    .send({ prompt: 'hi' }).expect(502)
  expect(res.body.error).toMatch(/LLM upstream unreachable/)
})

test('a mid-stream upstream failure relays a sentinel error frame instead of a silent cutoff', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
  ]
  let i = 0
  const failingStream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[i]))
        i += 1
      } else {
        controller.error(new Error('upstream socket reset'))
      }
    },
  })
  fetch.mockImplementationOnce(async () => new Response(failingStream, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }))

  const res = await request(makeApp()).post('/api/llm/generate')
    .send({ prompt: 'hi' }).expect(200)
  expect(res.text).toContain('Hello')
  expect(res.text).toContain(' world')
  expect(res.text).toContain('data: {"error":"upstream stream terminated"}')
  // No [DONE] — the client must be able to tell this apart from a clean finish.
  expect(res.text).not.toContain('[DONE]')
})

// Live probe for the res.on('close') fix: a real TCP client that aborts mid-
// response, proving the disconnect handler actually fires (unlike the
// req.on('close') it replaced, which fires too early — during the upstream
// fetch await — and never again on a later socket abort).
test('client disconnect mid-stream cancels the upstream reader via res "close"', async () => {
  let cancelCalled = false
  const encoder = new TextEncoder()
  let pullCount = 0
  const neverEndingStream = new ReadableStream({
    async pull(controller) {
      pullCount += 1
      if (pullCount === 1) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'))
      } else {
        // Simulate a slow/live upstream that would otherwise keep streaming
        // forever — the only way this resolves is via reader.cancel().
        await new Promise((r) => setTimeout(r, 20))
      }
    },
    cancel() {
      cancelCalled = true
    },
  })
  fetch.mockImplementationOnce(async () => new Response(neverEndingStream, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }))

  const app = makeApp()
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const port = server.address().port

  try {
    await new Promise((resolvePromise, reject) => {
      const deadline = Date.now() + 3000
      const clientReq = http.request(
        { method: 'POST', host: '127.0.0.1', port, path: '/api/llm/generate',
          headers: { 'Content-Type': 'application/json' } },
        (res) => {
          res.on('data', () => {
            // First byte arrived — now simulate the browser tab closing.
            clientReq.destroy()
          })
          res.on('error', () => {}) // expected once destroyed mid-response
        },
      )
      clientReq.on('error', () => {}) // ECONNRESET etc. — expected
      clientReq.write(JSON.stringify({ prompt: 'hi' }))
      clientReq.end()

      const check = () => {
        if (cancelCalled) return resolvePromise()
        if (Date.now() > deadline) return reject(new Error('timed out waiting for reader.cancel()'))
        setTimeout(check, 20)
      }
      setTimeout(check, 20)
    })
  } finally {
    server.close()
  }

  expect(cancelCalled).toBe(true)
})
