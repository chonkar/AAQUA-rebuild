import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from 'react-oidc-context';
import { oidcConfig } from './auth/oidcConfig';
import ProtectedRoute from './auth/ProtectedRoute';
import AuthCallback from './auth/AuthCallback';
import Layout from './components/common/Layout';
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

const authed = (el) => <ProtectedRoute>{el}</ProtectedRoute>;
const adminOnly = (el) => <ProtectedRoute requireRoles={['admin']}>{el}</ProtectedRoute>;

function App() {
  return (
    <AuthProvider {...oidcConfig}>
      <Router>
        <Layout>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/test-generator" element={authed(<TestGenerator />)} />
            <Route path="/test-plan-generator" element={authed(<TestPlanGenerator />)} />
            <Route path="/test-data-generator" element={authed(<TestDataGenerator />)} />
            <Route path="/locator-generator" element={authed(<LocatorGenerator />)} />
            <Route path="/test-converter" element={authed(<TestConverter />)} />
            <Route path="/framework-generator" element={authed(<FrameworkGenerator />)} />
            <Route path="/test-runner" element={authed(<TestRunner />)} />
            <Route path="/localization" element={authed(<LocalizationTester />)} />
            <Route path="/accessibility-scanner" element={authed(<AccessibilityScanner />)} />
            <Route path="/security-scanner" element={adminOnly(<SecurityScanner />)} />
            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </Router>
    </AuthProvider>
  );
}

export default App;
