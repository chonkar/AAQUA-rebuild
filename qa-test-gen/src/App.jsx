import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from 'react-oidc-context';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { getTheme } from './theme';
import { useTheme } from './hooks/useTheme';
import { oidcConfig } from './auth/oidcConfig';
import ProtectedRoute from './auth/ProtectedRoute';
import AuthCallback from './auth/AuthCallback';
import Layout from './components/common/Layout';
import RequireProject from './components/common/RequireProject';
import Home from './pages/Home';
import TestGenerator from './pages/TestGenerator';
import TestPlanGenerator from './pages/TestPlanGenerator';
import TestDataGenerator from './pages/TestDataGenerator';
import LocatorGenerator from './pages/LocatorGenerator';
import TestConverter from './pages/TestConverter';
import FrameworkGenerator from './pages/FrameworkGenerator';
import TestRunner from './pages/TestRunner';
import LocalizationTester from './pages/LocalizationTester';
import AccessibilityScanner from './pages/AccessibilityScanner';
import SecurityScanner from './pages/SecurityScanner';
import PerformanceScanner from './pages/PerformanceScanner';
import ReleaseReadiness from './pages/ReleaseReadiness';
import ApiTestGenerator from './pages/ApiTestGenerator';
import UsageDashboard from './pages/UsageDashboard';
import { ProjectProvider } from './context/ProjectContext';
import { ApiTestGenProvider } from './context/ApiTestGenContext';

const authed = (el) => <ProtectedRoute>{el}</ProtectedRoute>;
const adminOnly = (el) => <ProtectedRoute requireRoles={['admin']}>{el}</ProtectedRoute>;
const kavitaOnly = (el) => <ProtectedRoute allowedEmails={['kavita.chonkar@aaseya.com']}>{el}</ProtectedRoute>;
// Phase 1: feature pages require an active project on top of authentication.
const scoped = (el) => authed(<RequireProject>{el}</RequireProject>);
const scopedAdmin = (el) => adminOnly(<RequireProject>{el}</RequireProject>);

function App() {
  // Single source of truth for the dark/light toggle. Owned here (rather than
  // inside Header, where it used to live as a self-contained hook call) so the
  // MUI ThemeProvider and the legacy CSS-variable toggle (Header's button)
  // share the same state instead of drifting out of sync.
  const { theme, toggleTheme } = useTheme();

  return (
    <ThemeProvider theme={getTheme(theme)}>
      <CssBaseline />
      <AuthProvider {...oidcConfig}>
        <ProjectProvider>
          <ApiTestGenProvider>
            <Router basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
              <Layout theme={theme} toggleTheme={toggleTheme}>
                <Routes>
                  <Route path="/" element={authed(<ReleaseReadiness />)} />
                  <Route path="/services" element={authed(<Home />)} />
                  <Route path="/auth/callback" element={<AuthCallback />} />
                  <Route path="/test-generator" element={scoped(<TestGenerator />)} />
                  <Route path="/test-plan-generator" element={scoped(<TestPlanGenerator />)} />
                  <Route path="/test-data-generator" element={scoped(<TestDataGenerator />)} />
                  <Route path="/locator-generator" element={scoped(<LocatorGenerator />)} />
                  <Route path="/test-converter" element={scoped(<TestConverter />)} />
                  <Route path="/framework-generator" element={scoped(<FrameworkGenerator />)} />
                  <Route path="/api-test-generator" element={scoped(<ApiTestGenerator />)} />
                  <Route path="/test-runner" element={scoped(<TestRunner />)} />
                  <Route path="/localization" element={scoped(<LocalizationTester />)} />
                  <Route path="/accessibility-scanner" element={scoped(<AccessibilityScanner />)} />
                  <Route path="/performance-scanner" element={scoped(<PerformanceScanner />)} />
                  <Route path="/security-scanner" element={scopedAdmin(<SecurityScanner />)} />
                  <Route path="/usage-dashboard" element={kavitaOnly(<UsageDashboard />)} />
                  {/* Fallback */}
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Layout>
            </Router>
          </ApiTestGenProvider>
        </ProjectProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
