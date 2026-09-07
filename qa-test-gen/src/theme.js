import { createTheme } from '@mui/material/styles'

// Brand tokens mirrored from src/index.css (:root and [data-theme='light']).
// Keep in sync manually until the old CSS-variable theme is retired.
const brand = {
  accent: '#6d28d9', // --accent-primary (dark)
  accentHover: '#7c3aed', // --accent-primary (light) / hover shade
  bgDark: '#0a0a0f', // --bg-primary (dark)
  paperDark: '#13131f', // --bg-secondary (dark)
  bgLight: '#ffffff', // --bg-primary (light)
  paperLight: '#f3f4f6', // --bg-secondary (light)
}

export function getTheme(mode = 'dark') {
  const dark = mode === 'dark'
  return createTheme({
    palette: {
      mode,
      primary: { main: brand.accent, dark: '#5b21b6', light: brand.accentHover },
      background: dark
        ? { default: brand.bgDark, paper: brand.paperDark }
        : { default: brand.bgLight, paper: brand.paperLight },
      ...(dark && { text: { primary: '#f3f4f6', secondary: '#9ca3af' } }),
    },
    typography: {
      fontFamily: `'Inter', system-ui, -apple-system, sans-serif`,
      h1: { fontSize: '2rem', fontWeight: 700 },
      h2: { fontSize: '1.5rem', fontWeight: 600 },
      h3: { fontSize: '1.25rem', fontWeight: 600 },
      button: { textTransform: 'none', fontWeight: 600 },
    },
    shape: { borderRadius: 10 },
    components: {
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiTooltip: { defaultProps: { arrow: true } },
    },
  })
}
