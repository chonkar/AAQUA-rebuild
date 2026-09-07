import { expect, test, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

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

test('proxies prompt upstream with stream:true and relays token chunks', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/llm', llmRoutes)
  const res = await request(app).post('/api/llm/generate')
    .send({ prompt: 'hi', maxTokens: 100 }).expect(200)
  expect(res.headers['content-type']).toMatch('text/event-stream')
  expect(res.text).toContain('Hello')
  expect(res.text).toContain(' world')
  expect(res.text).toContain('[DONE]')
  const upstreamCall = fetch.mock.calls[0]
  expect(upstreamCall[0]).toMatch('/chat/completions')
  expect(JSON.parse(upstreamCall[1].body).stream).toBe(true)
})

test('missing prompt is a 400', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/llm', llmRoutes)
  await request(app).post('/api/llm/generate').send({}).expect(400)
})
