import React, { useState } from 'react';
import { AppBar, Box, Drawer, IconButton, Toolbar, Typography, useMediaQuery } from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import { useTheme as useMuiTheme } from '@mui/material/styles';
import Header from './Header';
import Sidebar from './Sidebar';

const DRAWER_WIDTH = 264;

// AAQUA mark. Colours come from the CSS-variable theme in src/index.css so the
// logo keeps following the legacy data-theme attribute (light/dark) that the
// old pages still use.
const BrandMark = () => (
  <Box
    component="svg"
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    sx={{ width: 38, height: 38, display: 'block', flexShrink: 0 }}
  >
    <defs>
      <linearGradient id="logo-grad-1" x1="0%" y1="100%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="var(--logo-gradient-1-start)" />
        <stop offset="100%" stopColor="var(--logo-gradient-1-end)" />
      </linearGradient>
      <linearGradient id="logo-grad-2" x1="0%" y1="100%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="var(--logo-gradient-2-start)" />
        <stop offset="100%" stopColor="var(--logo-gradient-2-end)" />
      </linearGradient>
    </defs>
    <path d="M25 80 L48 24 C49.5 20.5, 51.5 20.5, 53 24 L76 80 L62 80 L50.5 53 L39 80 Z" fill="url(#logo-grad-1)" />
    <path d="M43 80 L50.5 61 L58 80 L51.5 80 L50.5 77 L49.5 80 Z" fill="url(#logo-grad-2)" opacity="0.85" />
  </Box>
);

// Responsive app shell: fixed AppBar + adaptive Drawer (permanent >= md,
// temporary below) + scrollable main content. `theme`/`toggleTheme` are owned
// by App.jsx (single useTheme() call) and forwarded to Header.
const Layout = ({ children, theme, toggleTheme }) => {
  const mui = useMuiTheme();
  const isDesktop = useMediaQuery(mui.breakpoints.up('md'));
  const [mobileOpen, setMobileOpen] = useState(false);

  const drawer = <Sidebar onNavigate={() => setMobileOpen(false)} />;

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar
        position="fixed"
        elevation={0}
        color="default"
        sx={{
          zIndex: (t) => t.zIndex.drawer + 1,
          bgcolor: 'background.paper',
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Toolbar sx={{ gap: 1 }}>
          {!isDesktop && (
            <IconButton
              color="inherit"
              edge="start"
              aria-label="open menu"
              onClick={() => setMobileOpen(true)}
            >
              <MenuIcon />
            </IconButton>
          )}
          <BrandMark />
          <Box sx={{ display: { xs: 'none', sm: 'flex' }, flexDirection: 'column', lineHeight: 1.1, mr: 1 }}>
            <Typography component="h1" sx={{ fontSize: '1.4rem', fontWeight: 700, lineHeight: 1.1 }}>
              AAQUA
            </Typography>
            <Typography
              component="span"
              sx={{
                fontSize: '0.625rem',
                fontWeight: 600,
                color: 'text.secondary',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              AASEYA AI Quality Assurance
            </Typography>
          </Box>
          {/* Brand-less on xs so the controls fit; the mark above stays visible. */}
          <Typography component="span" sx={{ display: { xs: 'inline', sm: 'none' }, fontWeight: 700 }}>
            AAQUA
          </Typography>
          <Header theme={theme} toggleTheme={toggleTheme} />
        </Toolbar>
      </AppBar>

      <Box
        component="nav"
        aria-label="main navigation"
        sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}
      >
        {isDesktop ? (
          <Drawer
            variant="permanent"
            open
            sx={{
              '& .MuiDrawer-paper': {
                width: DRAWER_WIDTH,
                boxSizing: 'border-box',
                bgcolor: 'background.paper',
                borderRight: '1px solid',
                borderColor: 'divider',
              },
            }}
          >
            <Toolbar />
            {drawer}
          </Drawer>
        ) : (
          <Drawer
            variant="temporary"
            open={mobileOpen}
            onClose={() => setMobileOpen(false)}
            ModalProps={{ keepMounted: true }}
            sx={{ '& .MuiDrawer-paper': { width: DRAWER_WIDTH, bgcolor: 'background.paper' } }}
          >
            {drawer}
          </Drawer>
        )}
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          bgcolor: 'background.default',
        }}
      >
        <Toolbar />
        <Box sx={{ flex: 1, width: '100%', maxWidth: 1400, mx: 'auto', p: { xs: 2, md: 3 } }}>
          {children}
        </Box>
        <Box
          component="footer"
          sx={{
            borderTop: '1px solid',
            borderColor: 'divider',
            px: { xs: 2, md: 3 },
            py: 2,
            textAlign: 'center',
          }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.85rem' }}>
            © 2026 AAQUA. Aaseya AI Quality Assurance.
          </Typography>
        </Box>
      </Box>
    </Box>
  );
};

export default Layout;
