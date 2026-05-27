/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from 'react-oidc-context';

const ProjectContext = createContext(null);

export const ProjectProvider = ({ children }) => {
  const auth = useAuth();
  const STORAGE_KEY = 'aaqua_selected_project_id';
  const readStoredProjectId = () => {
    try { return window.localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
  };

  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectIdState] = useState(readStoredProjectId);
  const [isLoading, setIsLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState(null);

  // Persist selection so a reload restores the same project context instead of
  // snapping back to the first project.
  const setSelectedProjectId = (id) => {
    setSelectedProjectIdState(id);
    try {
      if (id) window.localStorage.setItem(STORAGE_KEY, id);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch { /* localStorage unavailable — selection stays in-memory only */ }
  };

  const fetchProjects = async () => {
    if (!auth.isAuthenticated) return;
    setIsLoading(true);
    try {
      const endpoint = window.location.origin.includes('localhost')
        ? 'http://localhost:3001/api/projects'
        : '/api/projects';
      
      const token = auth.user?.access_token || '';
      const res = await fetch(endpoint, {
        headers: {
          'Authorization': token ? `Bearer ${token}` : ''
        }
      });
      if (!res.ok) throw new Error('Failed to fetch projects');
      const data = await res.json();
      const projList = Array.isArray(data) ? data : (data?.projects || []);
      setProjects(projList);
      // Restore the persisted selection if it still exists; otherwise fall back
      // to the first project (or clear it when the user has none).
      const stored = readStoredProjectId();
      const storedExists = projList.some(p => String(p.id) === String(stored));
      if (stored && storedExists) {
        setSelectedProjectId(stored);
      } else {
        setSelectedProjectId(projList.length > 0 ? projList[0].id : '');
      }
    } catch (err) {
      console.error('[ProjectContext] Fetch error:', err);
      setError(err.message);
    } finally {
      setIsLoading(false);
      setInitialized(true);
    }
  };

  useEffect(() => {
    if (auth.isAuthenticated) {
      fetchProjects();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.isAuthenticated, auth.user?.access_token]);

  const selectedProject = projects.find(p => String(p.id) === String(selectedProjectId)) || null;

  return (
    <ProjectContext.Provider value={{
      projects,
      selectedProjectId,
      setSelectedProjectId,
      selectedProject,
      isLoading,
      initialized,
      error,
      refreshProjects: fetchProjects
    }}>
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = () => {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
};
