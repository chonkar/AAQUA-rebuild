import { expect, test, vi, beforeEach } from 'vitest'

class FakeEventSource {
  static instances = []
  constructor(url) { this.url = url; this.listeners = {}; FakeEventSource.instances.push(this) }
  addEventListener(type, fn) { this.listeners[type] = fn }
  set onmessage(fn) { this.listeners.message = fn }
  get onmessage() { return this.listeners.message }
  close() { this.closed = true }
  emit(data) { this.listeners.message?.({ data: JSON.stringify(data) }) }
}
vi.stubGlobal('EventSource', FakeEventSource)

// Mutable token via vi.hoisted so individual tests can flip getAccessToken's
// return value (e.g. to simulate a logged-out user) without re-mocking.
const tokenState = vi.hoisted(() => ({ token: 'tok-123' }))
vi.mock('../../src/utils/apiClient.js', () => ({
  getAccessToken: () => tokenState.token,
  API_BASE: '/api',
}))

import { subscribeToJob } from '../../src/utils/sseClient.js'

beforeEach(() => {
  FakeEventSource.instances = []
  tokenState.token = 'tok-123'
})

test('opens EventSource with token query param and forwards updates', () => {
  const onUpdate = vi.fn()
  subscribeToJob('j1', { onUpdate })
  const es = FakeEventSource.instances[0]
  expect(es.url).toBe('/api/events/j1?access_token=tok-123')
  es.emit({ id: 'j1', status: 'running', progress: 30 })
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ progress: 30 }))
})

test('terminal events fire onDone/onError and close the stream', () => {
  const onDone = vi.fn(), onError = vi.fn()
  subscribeToJob('j1', { onDone, onError })
  const es = FakeEventSource.instances[0]
  es.emit({ status: 'completed', result: { ok: 1 } })
  expect(onDone).toHaveBeenCalledWith({ ok: 1 })
  expect(es.closed).toBe(true)
})

test('failed events fire onError with the error payload and close the stream', () => {
  const onError = vi.fn()
  subscribeToJob('j1', { onError })
  const es = FakeEventSource.instances[0]
  es.emit({ status: 'failed', error: 'boom' })
  expect(onError).toHaveBeenCalledWith('boom')
  expect(es.closed).toBe(true)
})

test('unsubscribe closes the stream', () => {
  const unsub = subscribeToJob('j1', {})
  unsub()
  expect(FakeEventSource.instances[0].closed).toBe(true)
})

test('missing access token fires onError and never opens a connection', async () => {
  tokenState.token = null
  const onError = vi.fn()
  const unsub = subscribeToJob('j1', { onError })

  expect(FakeEventSource.instances.length).toBe(0)
  expect(onError).not.toHaveBeenCalled()

  await Promise.resolve()

  expect(onError).toHaveBeenCalledWith('Not authenticated — please sign in again')
  expect(FakeEventSource.instances.length).toBe(0)
  expect(() => unsub()).not.toThrow()
})
