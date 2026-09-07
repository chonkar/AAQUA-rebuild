import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Layout from '../../src/components/common/Layout'

// The shell consumes react-oidc-context (Header user menu, Sidebar's per-user
// nav item) and ProjectContext (Header project selector, Sidebar lock state).
// Both are mocked so the shell renders without an OIDC provider or a network
// round-trip to /api/projects.
vi.mock('react-oidc-context', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { profile: { name: 'Tester', email: 't@aaseya.com' }, access_token: 'tok' },
    signinRedirect: vi.fn(),
    signoutRedirect: vi.fn(),
  }),
}))

let projectState
vi.mock('../../src/context/ProjectContext', () => ({
  useProject: () => projectState,
}))

// jsdom's matchMedia always reports `matches: false`, which would pin the shell
// to its mobile branch. Stub it so each test can pick a viewport and exercise
// the permanent (>= md) or temporary (< md) drawer.
let viewport = 'desktop'
const stubMatchMedia = () => {
  window.matchMedia = (query) => ({
    matches: viewport === 'desktop' && /min-width/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

beforeEach(() => {
  viewport = 'desktop'
  projectState = {
    projects: [],
    selectedProjectId: '',
    selectedProject: null,
    setSelectedProjectId: vi.fn(),
    refreshProjects: vi.fn(),
  }
  stubMatchMedia()
})

const renderShell = () => {
  stubMatchMedia()
  return render(
    <MemoryRouter>
      <Layout theme="dark" toggleTheme={vi.fn()}>
        <div>page-content</div>
      </Layout>
    </MemoryRouter>
  )
}

test('shell renders app bar, nav drawer and content area', () => {
  renderShell()
  expect(screen.getByRole('banner')).toBeInTheDocument() // AppBar
  expect(screen.getByLabelText(/main navigation/i)).toBeInTheDocument() // Drawer nav
  expect(screen.getByText('page-content')).toBeInTheDocument()
})

test('desktop nav renders the permanent drawer inline with the tool routes', () => {
  renderShell()
  const nav = screen.getByLabelText(/main navigation/i)
  expect(nav).toHaveTextContent('Release Intelligence')
  expect(nav).toHaveTextContent('All Services')
  expect(nav).toHaveTextContent('Security Scanner')
  // No hamburger on desktop — the drawer is always visible.
  expect(screen.queryByLabelText(/open menu/i)).not.toBeInTheDocument()
})

test('mobile shows a hamburger that opens the temporary drawer', async () => {
  viewport = 'mobile'
  renderShell()
  const button = screen.getByLabelText(/open menu/i)
  expect(button).toBeInTheDocument()
  await userEvent.click(button)
  expect(await screen.findByRole('presentation')).toBeInTheDocument() // Modal-backed drawer
  expect(screen.getByText('Release Intelligence')).toBeInTheDocument()
})

test('tool nav items are locked until a project is active', () => {
  renderShell()
  // No active project -> project-scoped tools render as disabled, hrefless rows.
  const locked = screen.getByText('Test Plan Generator').closest('a')
  expect(locked).toBeNull()
  expect(screen.getByText('Test Plan Generator')).toBeInTheDocument()

  const dashboard = screen.getByText('Release Intelligence').closest('a')
  expect(dashboard).toHaveAttribute('href', '/') // never project-gated
})

test('tool nav items become real links once a project is selected', () => {
  projectState = {
    ...projectState,
    projects: [{ id: 'p1', name: 'Portal' }],
    selectedProjectId: 'p1',
    selectedProject: { id: 'p1', name: 'Portal' },
  }
  renderShell()
  const link = screen.getByText('Test Plan Generator').closest('a')
  expect(link).toHaveAttribute('href', '/test-plan-generator')
})

test('header controls render inside the app bar', () => {
  renderShell()
  expect(screen.getByRole('banner')).toHaveTextContent('AAQUA')
  expect(screen.getByLabelText(/toggle theme/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/^account$/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/active project/i)).toBeInTheDocument()
})
