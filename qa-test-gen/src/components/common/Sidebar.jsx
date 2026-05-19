import React from 'react';
import { NavLink } from 'react-router-dom';
import { Settings, HelpCircle, Database, Target, ShieldCheck, Layers, Globe, PersonStanding, RefreshCw, LayoutDashboard, FileCode, FileText } from 'lucide-react';

const Sidebar = () => {
  return (
    <aside className="sidebar">
      <div className="sidebar-content">
        <div className="nav-section">

          <NavLink to="/" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <LayoutDashboard size={20} />
            <span>Dashboard</span>
          </NavLink>

          <NavLink to="/test-plan-generator" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <FileText size={20} />
            <span>Test Plan Generator</span>
          </NavLink>

          <NavLink to="/test-generator" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <FileCode size={20} />
            <span>Functional Test Generator</span>
          </NavLink>

          <NavLink to="/test-data-generator" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Database size={20} />
            <span>Test Data Generator</span>
          </NavLink>

          <NavLink to="/locator-generator" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Target size={20} />
            <span>Smart Locators</span>
          </NavLink>

          <NavLink to="/test-converter" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            {({ isActive }) => (
              <>
                <RefreshCw size={20} style={!isActive ? { color: 'var(--accent-secondary)' } : {}} />
                <span>Migration Service</span>
              </>
            )}
          </NavLink>

          <NavLink to="/framework-generator" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Layers size={20} />
            <span>Framework Generator</span>
          </NavLink>

          <NavLink to="/test-runner" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <RefreshCw size={20} />
            <span>Test Runner</span>
          </NavLink>

          <NavLink to="/localization" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Globe size={20} />
            <span>Localization Tester</span>
          </NavLink>

          <NavLink to="/accessibility-scanner" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <PersonStanding size={20} />
            <span>Accessibility Scanner</span>
          </NavLink>

          <NavLink to="/security-scanner" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <ShieldCheck size={20} />
            <span>Security Scanner</span>
          </NavLink>
        </div>

        <div className="nav-section mt-auto">
          <p className="section-label">System</p>
          <div className="nav-link">
            <Settings size={20} />
            <span>Settings</span>
          </div>
          <div className="nav-link">
            <HelpCircle size={20} />
            <span>Support</span>
          </div>
        </div>
      </div>

      <style>{`
        .sidebar {
          width: 260px;
          background: var(--bg-secondary);
          border-right: 1px solid var(--border-color);
          display: flex;
          flex-direction: column;
          flex-shrink: 0;
          height: calc(100vh - 73px); /* Subtract header height */
          position: sticky;
          top: 73px;
        }

        .sidebar-content {
          padding: 1.5rem;
          padding-bottom: 2rem;
          display: flex;
          flex-direction: column;
          gap: 2rem;
          height: 100%;
          overflow-y: auto;
          overflow-x: hidden;
        }

        /* Custom thin scrollbar for sidebar */
        .sidebar-content::-webkit-scrollbar { width: 4px; }
        .sidebar-content::-webkit-scrollbar-track { background: transparent; }
        .sidebar-content::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; }
        .sidebar-content::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

        .section-label {
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--text-muted);
          margin-bottom: 0.75rem;
          font-weight: 600;
        }

        .nav-link {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.75rem 1rem;
          color: var(--text-secondary);
          text-decoration: none;
          border-radius: var(--radius-md);
          transition: all 0.2s;
          cursor: pointer;
          margin-bottom: 0.25rem;
        }

        .nav-link:hover {
          background: rgba(255, 255, 255, 0.03);
          color: var(--text-primary);
        }

        .nav-link.active {
          background: linear-gradient(90deg, rgba(109, 40, 217, 0.1), transparent);
          color: var(--accent-primary);
          border-left: 3px solid var(--accent-primary);
        }

        .nav-link.disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .mt-auto {
          margin-top: auto;
        }

        .badge-soon {
          font-size: 0.6rem;
          background: var(--bg-primary);
          padding: 2px 4px;
          border-radius: 4px;
          border: 1px solid var(--border-color);
          margin-left: auto;
        }

        @media (max-width: 768px) {
            .sidebar {
                display: none;
            }
        }
      `}</style>
    </aside >
  );
};

export default Sidebar;
