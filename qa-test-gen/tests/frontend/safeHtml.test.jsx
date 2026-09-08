import { render, screen } from '@testing-library/react'
import SafeHtml from '../../src/components/common/SafeHtml.jsx'

const MALICIOUS = `<p>ok</p><img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`

test('SafeHtml renders document markup but strips the executable surface', () => {
  delete window.__pwned
  const { container } = render(<SafeHtml html={MALICIOUS} />)

  // benign content survives
  expect(screen.getByText('ok')).toBeInTheDocument()

  // nothing executed, and nothing is left that could execute later
  expect(window.__pwned).toBeUndefined()
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('[onerror]')).toBeNull()
  expect(container.innerHTML).not.toContain('onerror')
  expect(container.innerHTML).not.toContain('<script')
})

test('SafeHtml keeps ordinary test-plan markup intact', () => {
  const { container } = render(
    <SafeHtml html={'<h2>1. Introduction</h2><table><tr><td>Scope</td></tr></table>'} />,
  )
  expect(screen.getByText('1. Introduction')).toBeInTheDocument()
  expect(container.querySelector('table td')).not.toBeNull()
})

test('SafeHtml tolerates null/undefined html without crashing', () => {
  const { container } = render(<SafeHtml html={null} />)
  expect(container.firstChild).not.toBeNull()
})
