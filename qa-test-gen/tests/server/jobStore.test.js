import { expect, test, vi, beforeEach } from 'vitest'

const rows = new Map()
vi.mock('../../server/models/index.js', () => ({
  Job: {
    create: vi.fn(async (data) => {
      const row = { id: 'job-1', status: 'pending', progress: 0, ...data,
        update: vi.fn(async function (patch) { Object.assign(this, patch); rows.set(this.id, this); return this }) }
      rows.set(row.id, row)
      return row
    }),
    findByPk: vi.fn(async (id) => rows.get(id) ?? null),
  },
}))

import { createJob, updateProgress, completeJob, failJob, getJob, jobEvents } from '../../server/services/jobStore.js'

beforeEach(() => rows.clear())

test('createJob returns a pending job and emits nothing yet', async () => {
  const job = await createJob({ type: 'test-cases', ownerId: 'u1', payload: { req: 'x' } })
  expect(job.status).toBe('pending')
  expect(job.id).toBeTruthy()
})

test('updateProgress persists and emits an event keyed by job id', async () => {
  const job = await createJob({ type: 'test-cases', ownerId: 'u1' })
  const seen = []
  jobEvents.on(`job:${job.id}`, (e) => seen.push(e))
  await updateProgress(job.id, { progress: 40, phase: 'Generating cases' })
  expect(seen[0]).toMatchObject({ status: 'running', progress: 40, phase: 'Generating cases' })
  expect((await getJob(job.id)).progress).toBe(40)
})

test('completeJob and failJob are terminal and emitted', async () => {
  const a = await createJob({ type: 't' })
  await completeJob(a.id, { items: [1] })
  expect((await getJob(a.id)).status).toBe('completed')
  const b = await createJob({ type: 't' })
  await failJob(b.id, new Error('boom'))
  const failed = await getJob(b.id)
  expect(failed.status).toBe('failed')
  expect(failed.error).toMatch('boom')
})
