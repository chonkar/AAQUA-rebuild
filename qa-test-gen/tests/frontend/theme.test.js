import { getTheme } from '../../src/theme'

test('dark theme carries AAQUA brand tokens', () => {
  const t = getTheme('dark')
  expect(t.palette.mode).toBe('dark')
  expect(t.palette.primary.main).toBe('#6d28d9')
  expect(t.palette.background.default.toLowerCase()).toBe('#0a0a0f')
  expect(t.typography.fontFamily).toMatch(/Inter/)
})

test('light theme keeps the same primary accent', () => {
  const t = getTheme('light')
  expect(t.palette.mode).toBe('light')
  expect(t.palette.primary.main).toBe('#6d28d9')
})
