import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, FileText, ArrowRight, Star, Moon, Sun, Database, Target, ShieldCheck, Layers, Globe, PersonStanding, PlayCircle } from 'lucide-react';

const ServiceCard = ({ icon: Icon, title, description, badge, onClick }) => (
  <div className="service-card" onClick={onClick}>
    <div className="card-header">
      <div className={`icon-wrapper ${badge ? 'disabled' : ''}`}>
        <Icon size={24} color={badge ? 'var(--text-muted)' : 'var(--text-primary)'} />
      </div>
      {badge && <span className="badge">{badge}</span>}
    </div>
    <h3 className="card-title">{title}</h3>
    <p className="card-desc">{description}</p>
    <div className="card-footer">
      <span className="action-text">Explore Service</span>
      <ArrowRight size={16} />
    </div>
  </div>
);

const Home = () => {
  const navigate = useNavigate();

  return (
    <div className="home-dashboard animate-fade-in">
      <div className="dashboard-header">
        <h1>Welcome to AAQUA</h1>
        <p className="subtitle">Select an AI-powered quality assurance service to begin.</p>
      </div>

      <div className="services-grid">
        <ServiceCard
          icon={Sparkles}
          title="Functional Test Generator"
          description="Generate comprehensive functional test cases detailed steps, edge cases, and priority assignment using AI."
          onClick={() => navigate('/test-generator')}
        />

        <ServiceCard
          icon={FileText}
          title="Test Plan Generator"
          description="Create comprehensive ISTQB-standard Test Plans with automatic docx export."
          onClick={() => navigate('/test-plan-generator')}
        />

        <ServiceCard
          icon={Database}
          title="Test Data Generator"
          description="Create realistic synthetic test data using JSON Schema or Natural Language prompts."
          onClick={() => navigate('/test-data-generator')}
        />

        <ServiceCard
          icon={Target}
          title="Smart Locators"
          description="Generate resilient Selenium/Playwright locators (ID, XPath, CSS) from HTML source code."
          onClick={() => navigate('/locator-generator')}
        />

        <ServiceCard
          icon={() => <span style={{ fontSize: '24px' }}>🔄</span>}
          title="Migration Service"
          description="Transform legacy Selenium projects into modern Playwright or Cypress test suites using AI."
          onClick={() => navigate('/test-converter')}
        />

        <ServiceCard
          icon={Layers}
          title="Framework Generator"
          description="Scaffold enterprise-grade test automation frameworks with Page Objects, Allure reporting, and CI/CD pipelines."
          onClick={() => navigate('/framework-generator')}
        />

        <ServiceCard
          icon={PlayCircle}
          title="Test Runner"
          description="Run your test suites, view live execution logs, and get a rich results dashboard with re-run capabilities."
          onClick={() => navigate('/test-runner')}
        />

        <ServiceCard
          icon={Globe}
          title="Localization Tester"
          description="Detect untranslated text and localization issues using Gemini AI analysis."
          onClick={() => navigate('/localization')}
        />

        <ServiceCard
          icon={PersonStanding}
          title="Accessibility Scanner"
          description="Automated WCAG 2.2 AA compliance checking using axe-core integration."
          onClick={() => navigate('/accessibility-scanner')}
        />

        <ServiceCard
          icon={ShieldCheck}
          title="Security Scanner"
          description="AI-powered OWASP ZAP security scanning with vulnerability analysis, remediation, and release gating."
          onClick={() => navigate('/security-scanner')}
        />
      </div>

      <style>{`
        .home-dashboard {
          padding: 1rem;
        }

        .dashboard-header {
          margin-bottom: 3rem;
        }

        .dashboard-header h1 {
          font-size: 2rem;
          margin-bottom: 0.5rem;
          background: linear-gradient(to right, var(--accent-primary), var(--accent-secondary));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .subtitle {
          color: var(--text-secondary);
        }

        .services-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 2rem;
        }

        .service-card {
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-lg);
          padding: 2rem;
          cursor: pointer;
          transition: all 0.3s ease;
          position: relative;
          overflow: hidden;
        }

        .service-card:hover {
          transform: translateY(-5px);
          border-color: var(--border-focus);
          box-shadow: var(--shadow-lg), 0 0 20px rgba(139, 92, 246, 0.1);
        }

        .card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 1.5rem;
        }

        .icon-wrapper {
          width: 50px;
          height: 50px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
        }

        .icon-wrapper.disabled {
          background: var(--bg-tertiary);
        }

        .badge {
          font-size: 0.65rem;
          background: var(--bg-primary);
          border: 1px solid var(--border-color);
          padding: 4px 8px;
          border-radius: 20px;
          font-weight: 600;
          letter-spacing: 0.5px;
        }

        .card-title {
          font-size: 1.25rem;
          margin-bottom: 0.75rem;
          font-weight: 600;
        }

        .card-desc {
          font-size: 0.9rem;
          color: var(--text-secondary);
          margin-bottom: 2rem;
          line-height: 1.6;
        }

        .card-footer {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          color: var(--accent-secondary);
          font-weight: 500;
          font-size: 0.9rem;
        }

        .service-card:hover .action-text {
          text-decoration: underline;
        }
      `}</style>
    </div>
  );
};

export default Home;
