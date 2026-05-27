import React from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';

// Phase 1 project gate: feature pages require an active project. While the
// project list is still loading we hold the route (no flash-redirect); once
// loaded, a missing selection sends the user to the All Services launcher,
// where the header's "+" creates a project.
const RequireProject = ({ children }) => {
  const { selectedProject, initialized, isLoading } = useProject();

  if (!initialized || isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '4rem', color: 'var(--text-muted)' }}>
        <Loader2 size={18} style={{ animation: 'rp-spin 1s linear infinite' }} />
        <span>Loading project context…</span>
        <style>{`@keyframes rp-spin { 100% { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!selectedProject) {
    return <Navigate to="/services" replace />;
  }

  return children;
};

export default RequireProject;
