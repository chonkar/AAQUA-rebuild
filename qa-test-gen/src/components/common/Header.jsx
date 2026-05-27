import React, { useState } from 'react';
import { Sparkles, ShieldCheck, Sun, Moon, LogIn, LogOut, User as UserIcon, Plus, X, Loader2, Link2 } from 'lucide-react';
import { useAuth } from 'react-oidc-context';
import { useTheme } from '../../hooks/useTheme';
import { useProject } from '../../context/ProjectContext';

const Header = () => {
  const { theme, toggleTheme } = useTheme();
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
  const [jiraUrl, setJiraUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [jiraToken, setJiraToken] = useState('');
  const [jiraProjectKey, setJiraProjectKey] = useState('');

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
        url: jiraUrl.trim(),
        email: jiraEmail.trim(),
        token: jiraToken.trim(),
        projectKey: jiraProjectKey.trim(),
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

  const getBaseUrl = () => window.location.origin.includes('localhost') ? 'http://localhost:3001' : '';

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

  return (
    <header className="app-header">
      <div className="container-fluid header-content">
        <div className="logo-section">
          <div className="logo-icon" style={{ background: 'none', boxShadow: 'none', padding: 0 }}>
            <svg className="logo-icon-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '38px', height: '38px', display: 'block' }}>
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
            </svg>
          </div>
          <div className="brand-text-container" style={{ display: 'flex', flexDirection: 'column', lineHeight: '1.1' }}>
            <h1 className="app-title" style={{ fontSize: '1.4rem', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
              AAQUA
            </h1>
            <span className="brand-subtitle" style={{ fontSize: '0.625rem', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: '2px' }}>
              AASEYA AI Quality Assurance
            </span>
          </div>

          <div className="project-selector-wrapper" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginLeft: '0.75rem' }}>
            <select
              className="project-select-dropdown"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              title="Active Bound Project Context"
            >
              {projects.length === 0 ? (
                <option value="">No Projects Found</option>
              ) : (
                projects.map(p => (
                  <option key={p.id} value={p.id} style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
                    {p.name}
                  </option>
                ))
              )}
            </select>

            {auth.isAuthenticated && (
              <button 
                className="btn-add-project-header" 
                onClick={() => setIsModalOpen(true)}
                title="Initialize New Project Context"
              >
                <Plus size={14} />
              </button>
            )}
          </div>
        </div>

        <nav className="nav-links">
          {auth.isAuthenticated && (
            <button 
              className={`jira-settings-toggle-btn ${hasJiraConfig ? 'configured' : ''}`} 
              onClick={openJiraModal} 
              title="Configure Personal JIRA Integration"
            >
              <Link2 size={15} />
              <span>Jira</span>
              {hasJiraConfig && <span className="active-dot" />}
            </button>
          )}

          <button className="theme-toggle" onClick={toggleTheme} title="Toggle Theme">
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>

          <div className="api-status">
            <ShieldCheck size={16} color="#10b981" />
            <span className="status-text">API Secure</span>
          </div>

          {auth.isAuthenticated ? (
            <div className="user-menu">
              <span className="user-email" title={email}>
                <UserIcon size={14} /> {email}
              </span>
              <button className="auth-btn" onClick={handleSignOut} title="Sign Out">
                <LogOut size={16} /> <span className="auth-btn-label">Sign Out</span>
              </button>
            </div>
          ) : !auth.isLoading && (
            <button className="auth-btn primary" onClick={handleSignIn} title="Sign In">
              <LogIn size={16} /> <span className="auth-btn-label">Sign In</span>
            </button>
          )}
        </nav>
      </div>

      {/* New Project Modal Overlay */}
      {isModalOpen && (
        <div className="modal-backdrop-premium">
          <div className="modal-content-premium animate-fade-in">
            <div className="modal-header">
              <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
                <Sparkles size={20} color="var(--accent-primary)" />
                <span>Initialize Quality Context</span>
              </h4>
              <button className="modal-close-btn" onClick={() => setIsModalOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreateProject}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
                {modalError && (
                  <div style={{ color: '#f87171', background: 'rgba(239, 68, 68, 0.1)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-md)', border: '1px solid rgba(239, 68, 68, 0.3)', fontSize: '0.85rem' }}>
                    {modalError}
                  </div>
                )}
                
                <div className="form-group-premium">
                  <label>Project / Suite Name</label>
                  <input
                    type="text"
                    className="form-input-premium"
                    placeholder="e.g. Customer Portal Revamp"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    required
                    disabled={isSubmitting}
                  />
                </div>

                <div className="form-group-premium">
                  <label>Target Web Application URL</label>
                  <input
                    type="text"
                    className="form-input-premium"
                    placeholder="https://app.example.com"
                    value={targetUrl}
                    onChange={(e) => setTargetUrl(e.target.value)}
                    required
                    disabled={isSubmitting}
                  />
                </div>

                <div className="form-group-premium">
                  <label>Description (Optional)</label>
                  <textarea
                    className="form-input-premium"
                    rows={3}
                    placeholder="Provide details about standard parameters, release timeline..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
              </div>
              <div className="modal-footer" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setIsModalOpen(false)} disabled={isSubmitting}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="spin" size={16} />
                      <span>Initializing...</span>
                    </>
                  ) : (
                    <span>Initialize Context</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* JIRA Connection Settings Modal */}
      {isJiraModalOpen && (
        <div className="modal-backdrop-premium" style={{ zIndex: 10000 }}>
          <div className="modal-content-premium animate-fade-in" style={{ maxWidth: '460px' }}>
            <div className="modal-header">
              <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
                <Link2 size={20} color="#0052cc" />
                <span>Configure JIRA Workspace</span>
              </h4>
              <button className="modal-close-btn" onClick={() => setIsJiraModalOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleSaveJiraConfig}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.25rem' }}>
                <p style={{ margin: 0, fontSize: '0.825rem', color: '#94a3b8', lineHeight: '1.4' }}>
                  Enable real-time synchronization of JIRA user stories and one-click bug raising. These credentials are saved securely in your local browser storage.
                </p>

                <div className="form-group-premium">
                  <label>Jira Instance URL</label>
                  <input
                    type="url"
                    className="form-input-premium"
                    placeholder="https://your-domain.atlassian.net"
                    value={jiraUrl}
                    onChange={(e) => setJiraUrl(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group-premium">
                  <label>Jira Username / Email</label>
                  <input
                    type="email"
                    className="form-input-premium"
                    placeholder="name@company.com"
                    value={jiraEmail}
                    onChange={(e) => setJiraEmail(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group-premium">
                  <label>Jira API Token</label>
                  <input
                    type="password"
                    className="form-input-premium"
                    placeholder="Enter your Atlassian API Token"
                    value={jiraToken}
                    onChange={(e) => setJiraToken(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group-premium">
                  <label>Default Project Key</label>
                  <input
                    type="text"
                    className="form-input-premium"
                    placeholder="e.g. SEC, QA, PROJ"
                    value={jiraProjectKey}
                    onChange={(e) => setJiraProjectKey(e.target.value)}
                    required
                    style={{ textTransform: 'uppercase' }}
                  />
                </div>
              </div>
              
              <div className="modal-footer" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
                <button 
                  type="button" 
                  className="btn btn-secondary" 
                  onClick={() => setIsJiraModalOpen(false)}
                  style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8' }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" style={{ background: '#0052cc', borderColor: '#0052cc', color: '#fff' }}>
                  Save Connection
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <style>{`
        .app-header {
          background: var(--bg-secondary);
          backdrop-filter: blur(10px);
          border-bottom: 1px solid var(--border-color);
          position: sticky;
          top: 0;
          z-index: 100;
          padding: 1rem 0;
          transition: background 0.3s, border 0.3s;
        }
        
        .header-content {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0 2rem;
        }
        
        .logo-section {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }
        
        .logo-icon {
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .app-title {
          font-size: 1.5rem;
          font-weight: 700;
          letter-spacing: -0.5px;
          color: var(--text-primary);
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .project-select-dropdown {
          background: rgba(255, 255, 255, 0.05);
          color: var(--text-primary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          padding: 0.35rem 0.75rem;
          font-size: 0.85rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          outline: none;
          max-width: 220px;
        }

        .project-select-dropdown:hover {
          background: rgba(255, 255, 255, 0.1);
          border-color: var(--accent-primary);
          box-shadow: 0 0 8px rgba(139, 92, 246, 0.2);
        }

        .btn-add-project-header {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: var(--radius-md);
          background: rgba(139, 92, 246, 0.15);
          color: var(--accent-primary);
          border: 1px solid rgba(139, 92, 246, 0.3);
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-add-project-header:hover {
          background: var(--accent-primary);
          color: #fff;
          box-shadow: 0 0 10px var(--accent-glow);
        }

        .full-title {
           font-size: 1rem;
           font-weight: 500;
           color: var(--text-secondary);
        }

        /* Modal Overlay Overlay Styles */
        .modal-backdrop-premium {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: rgba(15, 23, 42, 0.85);
          backdrop-filter: blur(12px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
        }

        .modal-content-premium {
          width: 100%;
          max-width: 500px;
          padding: 2.5rem;
          background: #1e293b;
          border-radius: var(--radius-lg);
          border: 1px solid rgba(255, 255, 255, 0.15);
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
          color: #f8fafc;
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .modal-close-btn {
          background: none;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          padding: 0.25rem;
          border-radius: 4px;
          transition: all 0.2s;
        }

        .modal-close-btn:hover {
          color: var(--text-primary);
          background: rgba(255, 255, 255, 0.05);
        }

        .form-group-premium {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }

        .form-group-premium label {
          font-size: 0.8rem;
          color: #94a3b8;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .form-input-premium {
          background: rgba(15, 23, 42, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #f8fafc;
          border-radius: var(--radius-md);
          padding: 0.65rem 0.75rem;
          font-size: 0.95rem;
          outline: none;
          transition: all 0.2s;
        }

        .form-input-premium:focus {
          border-color: var(--accent-primary);
          box-shadow: 0 0 8px rgba(139, 92, 246, 0.25);
        }

        /* Cohesive Header Navigation Layout */
        .nav-links {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          flex-wrap: nowrap;
        }

        .jira-settings-toggle-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          background: rgba(255, 255, 255, 0.03);
          color: var(--text-secondary);
          border: 1px solid var(--border-color);
          border-radius: 99px;
          padding: 0.45rem 0.95rem;
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          position: relative;
          outline: none;
        }

        .jira-settings-toggle-btn:hover {
          background: rgba(0, 82, 204, 0.08);
          border-color: #3b82f6;
          color: var(--text-primary);
          transform: translateY(-1px) scale(1.02);
          box-shadow: 0 0 12px rgba(59, 130, 246, 0.2);
        }

        .jira-settings-toggle-btn:active {
          transform: translateY(0) scale(0.98);
        }

        .jira-settings-toggle-btn.configured {
          background: rgba(16, 185, 129, 0.08);
          border-color: rgba(16, 185, 129, 0.3);
          color: #10b981;
        }

        .jira-settings-toggle-btn.configured:hover {
          background: rgba(16, 185, 129, 0.15);
          border-color: #10b981;
          box-shadow: 0 0 12px rgba(16, 185, 129, 0.2);
        }

        .jira-settings-toggle-btn .active-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #10b981;
          position: absolute;
          top: 3px;
          right: 6px;
          box-shadow: 0 0 6px #10b981;
        }

        .theme-toggle {
          width: 36px;
          height: 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-color);
          border-radius: 50%;
          color: var(--text-primary);
          cursor: pointer;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          outline: none;
        }

        .theme-toggle:hover {
          background: var(--bg-primary);
          border-color: var(--accent-primary);
          color: var(--accent-primary);
          transform: translateY(-1px) scale(1.05) rotate(15deg);
          box-shadow: 0 0 12px var(--accent-glow);
        }

        .theme-toggle:active {
          transform: scale(0.95);
        }

        .api-status {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          background: rgba(16, 185, 129, 0.08);
          border: 1px solid rgba(16, 185, 129, 0.2);
          color: #10b981;
          padding: 0.45rem 0.85rem;
          border-radius: 99px;
          font-size: 0.8rem;
          font-weight: 600;
          letter-spacing: 0.3px;
          transition: all 0.25s ease;
          user-select: none;
        }

        .api-status:hover {
          background: rgba(16, 185, 129, 0.15);
          border-color: rgba(16, 185, 129, 0.4);
          box-shadow: 0 0 10px rgba(16, 185, 129, 0.25);
        }

        .user-menu {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-color);
          border-radius: 99px;
          padding: 0.25rem 0.25rem 0.25rem 0.75rem;
          transition: all 0.25s ease;
        }

        .user-menu:hover {
          background: var(--bg-secondary);
          border-color: var(--border-focus);
        }

        .user-email {
          font-size: 0.8rem;
          font-weight: 500;
          color: var(--text-secondary);
          display: flex;
          align-items: center;
          gap: 0.35rem;
          max-width: 180px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .auth-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          background: rgba(239, 68, 68, 0.08);
          border: 1px solid rgba(239, 68, 68, 0.25);
          color: #ef4444;
          padding: 0.4rem 0.85rem;
          border-radius: 99px;
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          outline: none;
        }

        .auth-btn:hover {
          background: #ef4444;
          color: #ffffff;
          border-color: #ef4444;
          box-shadow: 0 4px 12px rgba(239, 68, 68, 0.35);
          transform: translateY(-1px) scale(1.02);
        }

        .auth-btn:active {
          transform: translateY(0) scale(0.98);
        }

        .auth-btn.primary {
          background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
          border: 1px solid transparent;
          color: #ffffff;
        }

        .auth-btn.primary:hover {
          box-shadow: 0 4px 12px var(--accent-glow);
          transform: translateY(-1px) scale(1.02);
        }

        .spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </header>
  );
};

export default Header;
