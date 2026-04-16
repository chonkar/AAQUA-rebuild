import React from 'react';
import Header from './Header';
import Sidebar from './Sidebar';

const Layout = ({ children }) => {
  return (
    <div className="layout">
      <Header />
      <div className="app-body">
        <Sidebar />
        <main className="main-content">
          <div className="container-fluid">
            {children}
          </div>

          <footer className="app-footer">
            <p>© 2026 AAQUA. Aaseya AI Quality Assurance.</p>
          </footer>
        </main>
      </div>

      <style>{`
        .layout {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
        }

        .app-body {
          display: flex;
          flex: 1;
        }
        
        .main-content {
          flex: 1;
          background: var(--bg-primary);
          overflow-y: auto;
          display: flex;
          flex-direction: column;
        }

        .container-fluid {
           padding: 2rem;
           max-width: 1400px;
           margin: 0 auto;
           width: 100%;
           flex: 1;
        }
        
        .app-footer {
          border-top: 1px solid var(--border-color);
          padding: 1.5rem 2rem;
          text-align: center;
          color: var(--text-muted);
          font-size: 0.85rem;
          background: var(--bg-primary);
        }
      `}</style>
    </div>
  );
};

export default Layout;
