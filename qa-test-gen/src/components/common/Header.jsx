import React, { useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Select,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Sparkles, ShieldCheck, Sun, Moon, LogIn, LogOut, User as UserIcon, Plus, Link2, Puzzle } from 'lucide-react';
import { useAuth } from 'react-oidc-context';
import { useProject } from '../../context/ProjectContext';
import ExtensionInstallModal from './ExtensionInstallModal';

// theme/toggleTheme are owned by App.jsx (via the useTheme hook) and threaded
// down through Layout, rather than called here directly, so the MUI
// ThemeProvider (also wired in App.jsx from the same state) stays in sync
// with this toggle instead of holding an independent, out-of-sync copy.
// Defaults keep isolated renders (tests, storybook-style previews) from
// crashing when the props aren't supplied.
const Header = ({ theme = 'dark', toggleTheme = () => {} }) => {
  const auth = useAuth();
  const email = auth.user?.profile?.email;
  const token = auth.user?.access_token || '';
  const { projects, selectedProjectId, setSelectedProjectId, refreshProjects } = useProject();

  // New Project Modal States
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [targetUrl, setTargetUrl] = useState('https://');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [modalError, setModalError] = useState(null);

  // JIRA Settings Modal States
  const [isJiraModalOpen, setIsJiraModalOpen] = useState(false);
  const [isExtensionModalOpen, setIsExtensionModalOpen] = useState(false);
  const [jiraUrl, setJiraUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [jiraToken, setJiraToken] = useState('');
  const [jiraProjectKey, setJiraProjectKey] = useState('');

  // User menu anchor (replaces the always-expanded email + Sign Out pill).
  const [userMenuAnchor, setUserMenuAnchor] = useState(null);

  // Read config on open
  const openJiraModal = () => {
    try {
      const configStr = window.localStorage.getItem('aaqua_jira_config');
      if (configStr) {
        const config = JSON.parse(configStr);
        setJiraUrl(config.url || '');
        setJiraEmail(config.email || '');
        setJiraToken(config.token || '');
        setJiraProjectKey(config.projectKey || '');
      } else {
        setJiraUrl('');
        setJiraEmail('');
        setJiraToken('');
        setJiraProjectKey('');
      }
    } catch (e) {
      console.error('[Header] Failed to read JIRA config:', e);
    }
    setIsJiraModalOpen(true);
  };

  const handleSaveJiraConfig = (e) => {
    e.preventDefault();
    try {
      const config = {
        url: jiraUrl.trim().replace(/\/+$/, ''),
        email: jiraEmail.trim(),
        token: jiraToken.trim(),
        projectKey: jiraProjectKey.trim().toUpperCase(),
      };
      window.localStorage.setItem('aaqua_jira_config', JSON.stringify(config));
      setIsJiraModalOpen(false);
      // Trigger a window event so any listening pages can refresh their JIRA status immediately
      window.dispatchEvent(new Event('aaqua_jira_config_changed'));
    } catch (err) {
      console.error('[Header] Failed to save JIRA config:', err);
    }
  };

  const hasJiraConfig = (() => {
    try {
      const configStr = window.localStorage.getItem('aaqua_jira_config');
      if (!configStr) return false;
      const config = JSON.parse(configStr);
      return !!(config.url && config.email && config.token && config.projectKey);
    } catch {
      return false;
    }
  })();

  const handleSignIn = () => auth.signinRedirect();
  const handleSignOut = () => auth.signoutRedirect();

  // BASE_URL = '/' in dev (Vite proxies /api -> :3001) and '/aaqua/' in QA (shared-nginx
  // routes /aaqua/api -> backend). Stripping the trailing slash so we can concatenate '/api/...'
  // without producing '//api/...'. Returning '' in dev lets Vite's proxy do the work.
  const getBaseUrl = () => import.meta.env.BASE_URL.replace(/\/$/, '');

  const handleCreateProject = async (e) => {
    e.preventDefault();
    if (!projectName.trim() || !targetUrl.trim()) return;

    setIsSubmitting(true);
    setModalError(null);
    try {
      const endpoint = `${getBaseUrl()}/api/projects`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          name: projectName.trim(),
          target_url: targetUrl.trim(),
          description: description.trim() || null
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || errData.details || 'Failed to initialize project');
      }

      const data = await res.json();

      // Refresh global projects list
      if (refreshProjects) {
        await refreshProjects();
      }

      // Select the new project automatically
      if (data.project && data.project.id) {
        setSelectedProjectId(data.project.id);
      }

      // Reset and close
      setProjectName('');
      setTargetUrl('https://');
      setDescription('');
      setIsModalOpen(false);
    } catch (err) {
      console.error('[Header Project Creation Error]', err);
      setModalError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Guard against an out-of-range Select value (MUI warns when `value` has no
  // matching MenuItem — e.g. before ProjectContext has finished loading).
  const projectValue = projects.some((p) => String(p.id) === String(selectedProjectId))
    ? selectedProjectId
    : '';

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexGrow: 1, minWidth: 0 }}>
        <Tooltip title="Active Bound Project Context">
          <Select
            size="small"
            displayEmpty
            value={projectValue}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            inputProps={{ 'aria-label': 'Active project' }}
            sx={{ minWidth: 150, maxWidth: 220, fontSize: '0.85rem', fontWeight: 600 }}
          >
            {projects.length === 0 ? (
              <MenuItem value="">No Projects Found</MenuItem>
            ) : (
              [
                <MenuItem key="__placeholder" value="" disabled>
                  Select a project
                </MenuItem>,
                ...projects.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name}
                  </MenuItem>
                )),
              ]
            )}
          </Select>
        </Tooltip>

        {auth.isAuthenticated && (
          <Tooltip title="Initialize New Project Context">
            <IconButton
              size="small"
              color="primary"
              aria-label="new project"
              onClick={() => setIsModalOpen(true)}
            >
              <Plus size={16} />
            </IconButton>
          </Tooltip>
        )}

        <Box sx={{ flexGrow: 1 }} />

        {auth.isAuthenticated && (
          <>
            <Tooltip title="Download & Install AAQUA Chrome Extension">
              <Button
                size="small"
                variant="outlined"
                color="primary"
                onClick={() => setIsExtensionModalOpen(true)}
                startIcon={<Puzzle size={15} />}
                sx={{ borderRadius: 99, display: { xs: 'none', sm: 'inline-flex' }, mr: 1 }}
              >
                Extension
              </Button>
            </Tooltip>

            <Tooltip title="Configure Personal JIRA Integration">
              <Button
                size="small"
                variant={hasJiraConfig ? 'outlined' : 'text'}
                color={hasJiraConfig ? 'success' : 'inherit'}
                onClick={openJiraModal}
                startIcon={<Link2 size={15} />}
                sx={{ borderRadius: 99, display: { xs: 'none', sm: 'inline-flex' } }}
              >
                Jira
              </Button>
            </Tooltip>
          </>
        )}

        <Tooltip title="Toggle Theme">
          <IconButton color="inherit" aria-label="toggle theme" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </IconButton>
        </Tooltip>

        <Chip
          size="small"
          color="success"
          variant="outlined"
          icon={<ShieldCheck size={14} />}
          label="API Secure"
          sx={{ display: { xs: 'none', md: 'inline-flex' }, fontWeight: 600 }}
        />

        {auth.isAuthenticated ? (
          <>
            <Tooltip title={email || 'Account'}>
              <IconButton
                aria-label="account"
                onClick={(e) => setUserMenuAnchor(e.currentTarget)}
                size="small"
              >
                <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: '0.85rem' }}>
                  {(email || '?').charAt(0).toUpperCase()}
                </Avatar>
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={userMenuAnchor}
              open={Boolean(userMenuAnchor)}
              onClose={() => setUserMenuAnchor(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            >
              <Box sx={{ px: 2, py: 1, maxWidth: 260 }}>
                <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }} noWrap>
                  <UserIcon size={14} /> {email}
                </Typography>
              </Box>
              <Divider />
              <MenuItem
                onClick={() => {
                  setUserMenuAnchor(null);
                  handleSignOut();
                }}
              >
                <ListItemIcon><LogOut size={16} /></ListItemIcon>
                Sign Out
              </MenuItem>
            </Menu>
          </>
        ) : !auth.isLoading && (
          <Button
            variant="contained"
            size="small"
            onClick={handleSignIn}
            startIcon={<LogIn size={16} />}
            sx={{ borderRadius: 99 }}
          >
            Sign In
          </Button>
        )}
      </Box>

      {/* New Project Modal */}
      <Dialog open={isModalOpen} onClose={() => setIsModalOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Sparkles size={20} color="var(--accent-primary)" />
          <span>Initialize Quality Context</span>
        </DialogTitle>
        <form onSubmit={handleCreateProject}>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {modalError && (
              <Typography variant="body2" color="error">
                {modalError}
              </Typography>
            )}
            <TextField
              label="Project / Suite Name"
              placeholder="e.g. Customer Portal Revamp"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              required
              disabled={isSubmitting}
              fullWidth
            />
            <TextField
              label="Target Web Application URL"
              placeholder="https://app.example.com"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              required
              disabled={isSubmitting}
              fullWidth
            />
            <TextField
              label="Description (Optional)"
              placeholder="Provide details about standard parameters, release timeline..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSubmitting}
              multiline
              rows={3}
              fullWidth
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setIsModalOpen(false)} disabled={isSubmitting} color="inherit">
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={isSubmitting}
              startIcon={isSubmitting ? <CircularProgress size={16} color="inherit" /> : null}
            >
              {isSubmitting ? 'Initializing...' : 'Initialize Context'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      {/* JIRA Connection Settings Modal */}
      <Dialog open={isJiraModalOpen} onClose={() => setIsJiraModalOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Link2 size={20} color="#0052cc" />
          <span>Configure JIRA Workspace</span>
        </DialogTitle>
        <form onSubmit={handleSaveJiraConfig}>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Enable real-time synchronization of JIRA user stories and one-click bug raising. These
              credentials are saved securely in your local browser storage.
            </Typography>
            <TextField
              type="url"
              label="Jira Instance URL"
              placeholder="https://your-domain.atlassian.net"
              value={jiraUrl}
              onChange={(e) => setJiraUrl(e.target.value)}
              required
              fullWidth
            />
            <TextField
              type="email"
              label="Jira Username / Email"
              placeholder="name@company.com"
              value={jiraEmail}
              onChange={(e) => setJiraEmail(e.target.value)}
              required
              fullWidth
            />
            <TextField
              type="password"
              label="Jira API Token"
              placeholder="Enter your Atlassian API Token"
              value={jiraToken}
              onChange={(e) => setJiraToken(e.target.value)}
              required
              fullWidth
            />
            <TextField
              label="Default Project Key"
              placeholder="e.g. SEC, QA, PROJ"
              value={jiraProjectKey}
              onChange={(e) => setJiraProjectKey(e.target.value)}
              required
              fullWidth
              sx={{ '& input': { textTransform: 'uppercase' } }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setIsJiraModalOpen(false)} color="inherit">
              Cancel
            </Button>
            <Button type="submit" variant="contained">
              Save Connection
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <ExtensionInstallModal isOpen={isExtensionModalOpen} onClose={() => setIsExtensionModalOpen(false)} />
    </>
  );
};

export default Header;
