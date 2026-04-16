import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
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

function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/test-generator" element={<TestGenerator />} />
          <Route path="/test-plan-generator" element={<TestPlanGenerator />} />
          <Route path="/test-data-generator" element={<TestDataGenerator />} />
          <Route path="/locator-generator" element={<LocatorGenerator />} />
          <Route path="/test-converter" element={<TestConverter />} />
          <Route path="/framework-generator" element={<FrameworkGenerator />} />
          <Route path="/test-runner" element={<TestRunner />} />
          <Route path="/localization" element={<LocalizationTester />} />
          <Route path="/accessibility-scanner" element={<AccessibilityScanner />} />
          <Route path="/security-scanner" element={<SecurityScanner />} />
          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
