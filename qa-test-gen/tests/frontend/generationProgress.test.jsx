import { render, screen, act } from '@testing-library/react'
import { vi } from 'vitest'

let handlers
vi.mock('../../src/utils/sseClient.js', () => ({
  subscribeToJob: vi.fn((id, h) => { handlers = h; return vi.fn() }),
}))

import GenerationProgress from '../../src/components/workflow/GenerationProgress'

test('shows phase + progress from job updates, streamed text, and completion', () => {
  const onDone = vi.fn()
  render(<GenerationProgress jobId="j1" onDone={onDone} />)
  act(() => handlers.onUpdate({ progress: 40, phase: 'Generating test cases' }))
  expect(screen.getByText('Generating test cases')).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  act(() => handlers.onDone({ items: [1, 2] }))
  expect(onDone).toHaveBeenCalledWith({ items: [1, 2] })
})

test('failure shows error alert with retry callback', async () => {
  const onRetry = vi.fn()
  render(<GenerationProgress jobId="j1" onRetry={onRetry} />)
  act(() => handlers.onError('LLM timeout'))
  expect(screen.getByRole('alert')).toHaveTextContent('LLM timeout')
})

test('renders streamed text when streamText prop is provided (LLM mode, no jobId)', () => {
  render(<GenerationProgress streamText="Once upon a test..." />)
  expect(screen.getByText(/Once upon a test/)).toBeInTheDocument()
})
