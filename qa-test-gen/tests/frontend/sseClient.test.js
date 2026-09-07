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
vi.mock('../../src/utils/apiClient.js', () => ({ getAccessToken: () => 'tok-123', API_BASE: '/api' }))

import { subscribeToJob } from '../../src/utils/sseClient.js'

beforeEach(() => { FakeEventSource.instances = [] })

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

test('unsubscribe closes the stream', () => {
  const unsub = subscribeToJob('j1', {})
  unsub()
  expect(FakeEventSource.instances[0].closed).toBe(true)
})
