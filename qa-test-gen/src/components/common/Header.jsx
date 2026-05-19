import React from 'react';
import { Sparkles, FileJson, ShieldCheck, Sun, Moon } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';

const Header = () => {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="app-header">
      <div className="container-fluid header-content">
        <div className="logo-section">
          <div className="logo-icon">
            <Sparkles size={24} color="#fff" />
          </div>
          <h1 className="app-title">
            AAUQA <span className="full-title">- Aaseya AI quality assuarance</span>

          </h1>
        </div>

        <nav className="nav-links">
          {/* <a href="#" className="nav-item active">Generator</a> */}
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle Theme">
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>

          <div className="api-status">
            <ShieldCheck size={16} color="#10b981" />
            <span className="status-text">API Secure</span>
          </div>
        </nav>
      </div>

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
          background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
          width: 40px;
          height: 40px;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 15px var(--accent-glow);
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

        .full-title {
           font-size: 1rem;
           font-weight: 500;
           color: var(--text-secondary);
        }
        
        /* beta-tag removed */
          font-size: 0.65rem;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-color);
          padding: 2px 6px;
          border-radius: 4px;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        
        .nav-links {
          display: flex;
          align-items: center;
          gap: 1.5rem;
        }
        
        .theme-toggle {
          background: none;
          border: none;
          color: var(--text-secondary);
          cursor: pointer;
          transition: color 0.2s;
          display: flex;
          align-items: center;
        }
        .theme-toggle:hover {
          color: var(--text-primary);
        }
        
        .api-status {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.8rem;
          color: var(--text-muted);
          background: var(--bg-primary);
          padding: 0.25rem 0.75rem;
          border-radius: 20px;
          border: 1px solid var(--border-color);
        }

        /* Responsive Adjustments */
        @media (max-width: 768px) {
           .full-title { display: none; }
           .status-text { display: none; }
           .header-content { padding: 0 1rem; }
           .app-title { font-size: 1.25rem; }
        }
      `}</style>
    </header>
  );
};

export default Header;
