import { expect, test, vi, beforeEach } from 'vitest'

// Mutable token via vi.hoisted so individual tests can flip getAccessToken's
// return value, matching the pattern used by tests/frontend/sseClient.test.js.
const tokenState = vi.hoisted(() => ({ token: 'tok-123' }))
vi.mock('../../src/utils/apiClient.js', () => ({
  getAccessToken: () => tokenState.token,
  API_BASE: '/api',
}))

import { streamLLM } from '../../src/utils/llmStream.js'

beforeEach(() => {
  tokenState.token = 'tok-123'
})

// Builds a fetch mock whose response body is a reader yielding the given raw
// byte chunks (already-encoded strings) in order, then signals done.
function fetchReturning(chunks) {
  const encoder = new TextEncoder()
  let i = 0
  return vi.fn(async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) {
            const value = encoder.encode(chunks[i])
            i += 1
            return { done: false, value }
          }
          return { done: true, value: undefined }
        },
      }),
    },
  }))
}

test('parses frames split across chunk boundaries (mid-JSON split) and reports tokens in order', async () => {
  const frame1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
  const frame2 = 'data: {"choices":[{"delta":{"content":" world"}}]}\n\n'
  const doneFrame = 'data: [DONE]\n\n'
  const wholeStream = frame1 + frame2 + doneFrame
  // Split mid-JSON, not on a frame boundary: partway through frame1's object.
  const splitPoint = frame1.indexOf('"delta"')
  const chunkA = wholeStream.slice(0, splitPoint)
  const chunkB = wholeStream.slice(splitPoint)

  global.fetch = fetchReturning([chunkA, chunkB])

  const onToken = vi.fn()
  const full = await streamLLM({ prompt: 'hi', onToken })

  expect(onToken.mock.calls.map((c) => c[0])).toEqual(['Hello', ' world'])
  expect(onToken.mock.calls[1][1]).toBe('Hello world')
  expect(full).toBe('Hello world')
})

test('reasoningEffort and the other generation params are sent in the POST body', async () => {
  const doneFrame = 'data: [DONE]\n\n'
  const fetchMock = fetchReturning([doneFrame])
  global.fetch = fetchMock

  await streamLLM({ prompt: 'hi', maxTokens: 4321, temperature: 0.2, reasoningEffort: 'low' })

  const body = JSON.parse(fetchMock.mock.calls[0][1].body)
  expect(body).toMatchObject({ prompt: 'hi', maxTokens: 4321, temperature: 0.2, reasoningEffort: 'low' })
})

test('a stream that ends without [DONE] throws "ended unexpectedly"', async () => {
  const frame1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
  global.fetch = fetchReturning([frame1]) // no [DONE] frame

  await expect(streamLLM({ prompt: 'hi' })).rejects.toThrow('LLM stream ended unexpectedly')
})

test('an error frame from the proxy is thrown as an Error', async () => {
  const frame1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
  const errorFrame = 'data: {"error":"upstream stream terminated"}\n\n'
  global.fetch = fetchReturning([frame1, errorFrame])

  await expect(streamLLM({ prompt: 'hi' })).rejects.toThrow('upstream stream terminated')
})

test('missing access token throws before calling fetch (null-token guard)', async () => {
  tokenState.token = null
  const fetchSpy = vi.fn()
  global.fetch = fetchSpy

  await expect(streamLLM({ prompt: 'hi' })).rejects.toThrow('Not authenticated — please sign in again')
  expect(fetchSpy).not.toHaveBeenCalled()
})
