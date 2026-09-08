import { render, screen } from '@testing-library/react'

test('vitest + RTL renders JSX', () => {
  render(<div>aaqua-test-ok</div>)
  expect(screen.getByText('aaqua-test-ok')).toBeInTheDocument()
})
