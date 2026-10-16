import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Settings, HelpCircle, Database, Target, ShieldCheck, Layers, Globe, PersonStanding,
  RefreshCw, LayoutDashboard, FileCode, FileText, Webhook, Gauge, Users, Lock, Bot,
} from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import { useAuth } from 'react-oidc-context';

const LOCKED_HINT = 'Select or create a project to use this service';

// Project-gated tools (Phase 1 project gate mirrors the route-level guard in
// App.jsx's RequireProject wrapper).
const SERVICE_ITEMS = [
  { to: '/test-plan-generator', icon: FileText, label: 'Test Plan Generator' },
  { to: '/test-generator', icon: FileCode, label: 'Functional Test Generator' },
  { to: '/test-data-generator', icon: Database, label: 'Test Data Generator' },
  { to: '/locator-generator', icon: Target, label: 'Smart Locators' },
  { to: '/test-converter', icon: RefreshCw, label: 'Migration Service', inactiveColor: 'var(--accent-secondary)' },
  { to: '/framework-generator', icon: Layers, label: 'Framework Generator' },
  { to: '/api-test-generator', icon: Webhook, label: 'API Test Generator' },
  { to: '/test-runner', icon: RefreshCw, label: 'Test Runner' },
  { to: '/localization', icon: Globe, label: 'Localization Tester' },
  { to: '/accessibility-scanner', icon: PersonStanding, label: 'Accessibility Scanner' },
  { to: '/mcp-agent-hub', icon: Bot, label: 'MCP Agent Hub' },
];

const itemSx = {
  borderRadius: 1.5,
  mb: 0.25,
  '&.Mui-selected': {
    color: 'primary.main',
    bgcolor: 'action.selected',
    borderLeft: '3px solid',
    borderColor: 'primary.main',
  },
};

const NavItem = ({ to, icon, label, iconColor, selected, onNavigate }) => {
  const Icon = icon;
  return (
    <ListItem disablePadding>
      <ListItemButton
        component={NavLink}
        to={to}
        selected={selected}
        onClick={onNavigate}
        sx={itemSx}
      >
        <ListItemIcon sx={{ minWidth: 36, color: selected ? 'primary.main' : iconColor || 'inherit' }}>
          <Icon size={20} />
        </ListItemIcon>
        <ListItemText primary={label} slotProps={{ primary: { fontSize: '0.9rem' } }} />
      </ListItemButton>
    </ListItem>
  );
};

// A locked service renders as a disabled, non-navigating row. The Tooltip needs
// the wrapping span because disabled buttons emit no pointer events.
const LockedItem = ({ icon, label }) => {
  const Icon = icon;
  return (
    <ListItem disablePadding>
      <Tooltip title={LOCKED_HINT} placement="right">
        <Box component="span" sx={{ width: '100%' }}>
          <ListItemButton disabled sx={itemSx}>
            <ListItemIcon sx={{ minWidth: 36 }}>
              <Icon size={20} />
            </ListItemIcon>
            <ListItemText primary={label} slotProps={{ primary: { fontSize: '0.9rem' } }} />
            <Lock size={14} />
          </ListItemButton>
        </Box>
      </Tooltip>
    </ListItem>
  );
};

const Sidebar = ({ onNavigate }) => {
  const { selectedProject } = useProject();
  const locked = !selectedProject;
  const auth = useAuth();
  const isKavita = auth.user?.profile?.email === 'kavita.chonkar@aaseya.com';
  const { pathname } = useLocation();
  const isActive = (to) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`));

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
        px: 1.5,
        py: 2,
        '&::-webkit-scrollbar': { width: 4 },
        '&::-webkit-scrollbar-thumb': { bgcolor: 'divider', borderRadius: 2 },
      }}
    >
      <List disablePadding>
        <NavItem
          to="/"
          icon={LayoutDashboard}
          label="Release Intelligence"
          selected={isActive('/')}
          onNavigate={onNavigate}
        />

        {isKavita && (
          <NavItem
            to="/usage-dashboard"
            icon={Users}
            label="User Dashboard"
            iconColor="var(--success)"
            selected={isActive('/usage-dashboard')}
            onNavigate={onNavigate}
          />
        )}

        <NavItem
          to="/services"
          icon={Layers}
          label="All Services"
          selected={isActive('/services')}
          onNavigate={onNavigate}
        />

        {SERVICE_ITEMS.map((item) =>
          locked ? (
            <LockedItem key={item.to} icon={item.icon} label={item.label} />
          ) : (
            <NavItem
              key={item.to}
              to={item.to}
              icon={item.icon}
              label={item.label}
              iconColor={item.inactiveColor}
              selected={isActive(item.to)}
              onNavigate={onNavigate}
            />
          )
        )}
      </List>

      <Box sx={{ mt: 'auto', pt: 2 }}>
        <Typography
          component="p"
          sx={{
            px: 2,
            fontSize: '0.75rem',
            textTransform: 'uppercase',
            letterSpacing: '1px',
            color: 'text.secondary',
            fontWeight: 600,
            mb: 0.75,
          }}
        >
          System
        </Typography>
        <List disablePadding>
          {/* Placeholders — these were non-navigating rows before the MUI
              re-skin and stay non-navigating. */}
          <ListItem disablePadding>
            <ListItemButton sx={itemSx}>
              <ListItemIcon sx={{ minWidth: 36 }}><Settings size={20} /></ListItemIcon>
              <ListItemText primary="Settings" slotProps={{ primary: { fontSize: '0.9rem' } }} />
            </ListItemButton>
          </ListItem>
          <ListItem disablePadding>
            <ListItemButton sx={itemSx}>
              <ListItemIcon sx={{ minWidth: 36 }}><HelpCircle size={20} /></ListItemIcon>
              <ListItemText primary="Support" slotProps={{ primary: { fontSize: '0.9rem' } }} />
            </ListItemButton>
          </ListItem>
        </List>
      </Box>
    </Box>
  );
};

export default Sidebar;
