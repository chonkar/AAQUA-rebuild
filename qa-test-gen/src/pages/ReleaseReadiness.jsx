import React, { useState, useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import { useProject } from '../context/ProjectContext';
import {
  TrendingUp, Shield, Globe, Award, Sparkles, RefreshCw,
  CheckCircle, AlertTriangle, XCircle, Info, ChevronRight, Gauge
} from 'lucide-react';

// Total number of quality pillars the readiness score can draw from:
// automation, accessibility, localization, performance, security.
// Keep in sync with the per-pillar checks in mapReadinessProfile.
const TOTAL_PILLARS = 5;

const ReleaseReadiness = () => {
  const auth = useAuth();
  const { selectedProjectId, selectedProject } = useProject();
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const token = auth.user?.access_token || '';

  const mapReadinessProfile = (profile, sources = {}) => {
    if (!profile) return null;

    let evaluatedCount = 0;
    if (profile.automation_health !== null) evaluatedCount++;
    if (profile.accessibility_health !== null) evaluatedCount++;
    if (profile.localization_health !== null) evaluatedCount++;
    if (profile.performance_health !== null) evaluatedCount++;
    if (profile.security_health !== null) evaluatedCount++;

    let confidenceLevel = 'UNAVAILABLE';
    if (profile.release_confidence >= 85) confidenceLevel = 'HIGH';
    else if (profile.release_confidence >= 65) confidenceLevel = 'MEDIUM';
    else if (profile.release_confidence > 0) confidenceLevel = 'LOW';

    let recommendations = [];
    if (profile.deployment_recommendation) {
      recommendations.push(profile.deployment_recommendation);
    }
    if (profile.ai_summary) {
      recommendations.push(profile.ai_summary);
    }

    // Pull real counts from the source rows the API now returns. Each
    // source row is null when that dimension has never been scanned —
    // in which case we leave the dimension itself null so the UI doesn't
    // render a card with placeholder zeros.
    const auto = sources.automation;
    const a11y = sources.accessibility;
    const loc = sources.localization;
    const perf = sources.performance;
    const sec = sources.security;

    return {
      overallScore: profile.overall_quality_score ?? 0,
      confidenceLevel,
      summary: profile.ai_summary || 'No stats recorded yet.',
      evaluatedDimensionsCount: evaluatedCount,
      automation: auto ? {
        score: profile.automation_health,
        passRate: Math.round(auto.pass_rate * 10) / 10,
        // Derive passed from the authoritative pass_rate so it agrees with the
        // Pass Rate shown above (total - failed overcounts when tests are skipped).
        passed: Math.round(((auto.pass_rate || 0) / 100) * (auto.total_tests || 0)),
        total: auto.total_tests || 0,
        failed: auto.failed_tests || 0,
        duration: auto.duration,
      } : null,
      accessibility: a11y ? {
        score: profile.accessibility_health,
        wcagCompliance: Math.round(a11y.wcag_compliance * 10) / 10,
        criticalCount: a11y.critical_violations || 0,
        seriousCount: a11y.serious_violations || 0,
        moderateCount: a11y.moderate_violations || 0,
        minorCount: a11y.minor_violations || 0,
      } : null,
      localization: loc ? {
        score: profile.localization_health,
        translationAccuracy: Math.round(loc.translation_accuracy * 10) / 10,
        missingKeys: loc.missing_keys || 0,
        overflowIssues: loc.overflow_issues || 0,
      } : null,
      performance: perf ? {
        score: profile.performance_health,
        lcp: perf.lcp_ms,
        cls: perf.cls,
        tbt: perf.tbt_ms,
        ttfb: perf.ttfb_ms,
      } : null,
      security: sec ? {
        score: profile.security_health,
        vulnerabilitiesCount: sec.total_count || 0,
        criticalCount: sec.critical_count || 0,
        highCount: sec.high_count || 0,
        mediumCount: sec.medium_count || 0,
        lowCount: sec.low_count || 0,
        healthScore: sec.health_score,
        riskRating: sec.release_blocked
          ? 'High'
          : (sec.critical_count > 0 || sec.high_count > 0)
            ? 'Medium'
            : 'Low',
      } : null,
      recommendations
    };
  };

  const fetchReadiness = async () => {
    if (!selectedProjectId) return;
    setIsLoading(true);
    setError(null);
    try {
      const endpoint = window.location.origin.includes('localhost')
        ? `http://localhost:3001/api/readiness/${selectedProjectId}`
        : `/api/readiness/${selectedProjectId}`;
      const res = await fetch(endpoint, {
        headers: {
          'Authorization': token ? `Bearer ${token}` : ''
        }
      });
      if (!res.ok) throw new Error('Failed to fetch release readiness');
      const result = await res.json();
      setData(mapReadinessProfile(result?.profile, result?.sources) || null);
    } catch (err) {
      console.error('[ReleaseReadiness] Fetch error:', err);
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (selectedProjectId) {
      fetchReadiness();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, token]);

  const getScoreColor = (score) => {
    if (score === null || score === undefined) return '#475569'; // Gray for unrun
    if (score >= 90) return '#10b981'; // Emerald
    if (score >= 75) return '#f59e0b'; // Amber
    return '#ef4444'; // Red
  };

  const formatScore = (score) => {
    if (score === null || score === undefined) return 'Not Run';
    return `${Math.round(score)}%`;
  };

  const getConfidenceBadge = (level) => {
    switch (level) {
      case 'HIGH':
        return <span className="conf-badge high">HIGH CONFIDENCE</span>;
      case 'MEDIUM':
        return <span className="conf-badge medium">MEDIUM CONFIDENCE</span>;
      case 'LOW':
        return <span className="conf-badge low">LOW CONFIDENCE</span>;
      default:
        return <span className="conf-badge none">UNAVAILABLE</span>;
    }
  };

  return (
    <div className="release-readiness-dashboard animate-fade-in">
      <div className="dashboard-header-row">
        <div>
          <h2>Release Readiness & Quality Intelligence</h2>
          <p className="subtitle">
            Dynamic, weighted Go-Live evaluation for <span className="project-highlight">{selectedProject?.name || 'Selected Project'}</span>.
          </p>
        </div>
        <div className="action-buttons">
          <button
            className="btn btn-secondary"
            onClick={fetchReadiness}
            disabled={isLoading || !selectedProjectId}
          >
            <RefreshCw className={isLoading ? 'spin' : ''} size={16} />
            <span>Sync Scores</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner animate-fade-in">
          <AlertTriangle size={20} />
          <span>{error}</span>
        </div>
      )}

      {!selectedProjectId ? (
        <div className="no-project-selected">
          <Info size={48} />
          <h3>No Project Context Active</h3>
          <p>Please select or create a project context from the dropdown in the header to view quality readiness scores.</p>
        </div>
      ) : isLoading && !data ? (
        <div className="loading-state">
          <RefreshCw className="spin" size={48} />
          <p>Fetching Quality Metrics & Intelligence...</p>
        </div>
      ) : (
        <>
          {/* Main Gauges Row */}
          <div className="readiness-main-card glass-panel">
            <div className="gauge-section">
              <div className="radial-gauge-container">
                <svg className="radial-svg" viewBox="0 0 120 120">
                  <circle className="radial-bg" cx="60" cy="60" r="50"></circle>
                  <circle 
                    className="radial-fill" 
                    cx="60" 
                    cy="60" 
                    r="50"
                    style={{
                      strokeDasharray: '314',
                      strokeDashoffset: 314 - (314 * (data?.overallScore || 0)) / 100,
                      stroke: getScoreColor(data?.overallScore)
                    }}
                  ></circle>
                </svg>
                <div className="radial-text">
                  <span className="gauge-num">{data?.overallScore !== null && data?.overallScore !== undefined ? Math.round(data.overallScore) : '--'}%</span>
                  <span className="gauge-lbl">READINESS SCORE</span>
                </div>
              </div>
            </div>

            <div className="intelligence-section">
              <div className="header-info">
                <h3>Executive Summary & AI Recommendation</h3>
                {data && getConfidenceBadge(data.confidenceLevel)}
              </div>
              <p className="summary-text">
                {data?.summary || 'No evaluation stats available yet. Switch project contexts, run audits (Accessibility, Localization, Security), or trigger a Mock Quality Run above to instantly populate release readiness data!'}
              </p>
              
              <div className="metrics-summary-chips">
                <div className="summary-chip">
                  <span className="chip-label">Evaluation Scope</span>
                  <span className="chip-val">{data?.evaluatedDimensionsCount || 0} / {TOTAL_PILLARS} Pillars Active</span>
                </div>
                <div className="summary-chip">
                  <span className="chip-label">Source Repository</span>
                  <span className="chip-val text-truncate" title={selectedProject?.git_url}>{selectedProject?.git_url || 'No VCS Bound'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Quality Pillars Grid */}
          <h3 className="section-title">Core Quality Pillars</h3>
          <div className="pillars-grid">
            {/* Automation */}
            <div className="pillar-card glass-panel">
              <div className="pillar-header">
                <div className="pillar-icon-wrapper blue">
                  <Award size={20} />
                </div>
                <h4>Test Automation</h4>
                <span className="pillar-score" style={{ color: getScoreColor(data?.automation?.score) }}>
                  {formatScore(data?.automation?.score)}
                </span>
              </div>
              <div className="pillar-body">
                {data?.automation ? (
                  <>
                    <div className="progress-bar-bg">
                      <div 
                        className="progress-bar-fill blue-bg" 
                        style={{ width: `${data.automation.score}%` }}
                      ></div>
                    </div>
                    <div className="pillar-stats">
                      <div className="stat-row">
                        <span>Pass Rate:</span>
                        <strong>{data.automation.passRate}%</strong>
                      </div>
                      <div className="stat-row">
                        <span>Test Coverage:</span>
                        <strong>{data.automation.passed}/{data.automation.total} passed</strong>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="no-data-text">No test suite execution statistics found. Run automated tests in the Test Runner to activate.</p>
                )}
              </div>
            </div>

            {/* Accessibility */}
            <div className="pillar-card glass-panel">
              <div className="pillar-header">
                <div className="pillar-icon-wrapper green">
                  <Sparkles size={20} />
                </div>
                <h4>Accessibility SCAN</h4>
                <span className="pillar-score" style={{ color: getScoreColor(data?.accessibility?.score) }}>
                  {formatScore(data?.accessibility?.score)}
                </span>
              </div>
              <div className="pillar-body">
                {data?.accessibility ? (
                  <>
                    <div className="progress-bar-bg">
                      <div 
                        className="progress-bar-fill green-bg" 
                        style={{ width: `${data.accessibility.score}%` }}
                      ></div>
                    </div>
                    <div className="pillar-stats">
                      <div className="stat-row">
                        <span>WCAG Compliance:</span>
                        <strong>{data.accessibility.wcagCompliance}%</strong>
                      </div>
                      <div className="stat-row">
                        <span>Critical Violations:</span>
                        <strong className={data.accessibility.criticalCount > 0 ? 'text-red' : ''}>
                          {data.accessibility.criticalCount}
                        </strong>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="no-data-text">No accessibility profiles recorded. Launch scanner in Accessibility Scanner to activate.</p>
                )}
              </div>
            </div>

            {/* Localization */}
            <div className="pillar-card glass-panel">
              <div className="pillar-header">
                <div className="pillar-icon-wrapper purple">
                  <Globe size={20} />
                </div>
                <h4>Localization Tester</h4>
                <span className="pillar-score" style={{ color: getScoreColor(data?.localization?.score) }}>
                  {formatScore(data?.localization?.score)}
                </span>
              </div>
              <div className="pillar-body">
                {data?.localization ? (
                  <>
                    <div className="progress-bar-bg">
                      <div 
                        className="progress-bar-fill purple-bg" 
                        style={{ width: `${data.localization.score}%` }}
                      ></div>
                    </div>
                    <div className="pillar-stats">
                      <div className="stat-row">
                        <span>Translation Accuracy:</span>
                        <strong>{data.localization.translationAccuracy}%</strong>
                      </div>
                      <div className="stat-row">
                        <span>Untranslated Keys:</span>
                        <strong>{data.localization.missingKeys}</strong>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="no-data-text">No translation profiles found. Perform site scan in Localization Tester to activate.</p>
                )}
              </div>
            </div>

            {/* Performance */}
            <div className="pillar-card glass-panel">
              <div className="pillar-header">
                <div className="pillar-icon-wrapper amber">
                  <Gauge size={20} />
                </div>
                <h4>Performance</h4>
                <span className="pillar-score" style={{ color: getScoreColor(data?.performance?.score) }}>
                  {formatScore(data?.performance?.score)}
                </span>
              </div>
              <div className="pillar-body">
                {data?.performance ? (
                  <>
                    <div className="progress-bar-bg">
                      <div
                        className="progress-bar-fill amber-bg"
                        style={{ width: `${data.performance.score}%` }}
                      ></div>
                    </div>
                    <div className="pillar-stats">
                      <div className="stat-row">
                        <span>LCP:</span>
                        <strong>{data.performance.lcp == null ? '—' : (data.performance.lcp >= 1000 ? `${(data.performance.lcp / 1000).toFixed(1)} s` : `${data.performance.lcp} ms`)}</strong>
                      </div>
                      <div className="stat-row">
                        <span>CLS:</span>
                        <strong>{data.performance.cls == null ? '—' : data.performance.cls}</strong>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="no-data-text">No performance scans found. Run a scan in the Performance Scanner to activate.</p>
                )}
              </div>
            </div>

            {/* Security */}
            <div className="pillar-card glass-panel">
              <div className="pillar-header">
                <div className="pillar-icon-wrapper red">
                  <Shield size={20} />
                </div>
                <h4>Security Scanner</h4>
                <span className="pillar-score" style={{ color: getScoreColor(data?.security?.score) }}>
                  {formatScore(data?.security?.score)}
                </span>
              </div>
              <div className="pillar-body">
                {data?.security ? (
                  <>
                    <div className="progress-bar-bg">
                      <div 
                        className="progress-bar-fill red-bg" 
                        style={{ width: `${data.security.score}%` }}
                      ></div>
                    </div>
                    <div className="pillar-stats">
                      <div className="stat-row">
                        <span>Vulnerabilities:</span>
                        <strong className={data.security.vulnerabilitiesCount > 0 ? 'text-red' : ''}>
                          {data.security.vulnerabilitiesCount} issues
                        </strong>
                      </div>
                      <div className="stat-row">
                        <span>Risk Rating:</span>
                        <strong style={{ color: getScoreColor(100 - (data.security.vulnerabilitiesCount * 10)) }}>
                          {data.security.riskRating}
                        </strong>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="no-data-text">No security scan summaries available. Scan the target URL in Security Scanner to activate.</p>
                )}
              </div>
            </div>
          </div>

          {/* AI Recommended Release Gate Checklist */}
          {data?.recommendations && data.recommendations.length > 0 && (
            <>
              <h3 className="section-title">AI Quality Gate Requirements</h3>
              <div className="checklist-card glass-panel">
                <div className="checklist-list">
                  {data.recommendations.map((rec, idx) => (
                    <div key={idx} className="checklist-item animate-fade-in" style={{ animationDelay: `${idx * 0.1}s` }}>
                      <div className="status-indicator">
                        {data.overallScore >= 90 ? (
                          <CheckCircle className="icon text-green" size={20} />
                        ) : data.overallScore >= 75 ? (
                          <AlertTriangle className="icon text-amber" size={20} />
                        ) : (
                          <XCircle className="icon text-red" size={20} />
                        )}
                      </div>
                      <div className="checklist-content">
                        <h5>Pillar Action Item #{idx + 1}</h5>
                        <p>{rec}</p>
                      </div>
                      <ChevronRight className="chevron-end" size={16} />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}

      <style>{`
        .release-readiness-dashboard {
          max-width: 1200px;
          margin: 0 auto;
          padding: 1rem 0;
        }

        .dashboard-header-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 2rem;
          gap: 1rem;
        }

        .dashboard-header-row h2 {
          font-size: 1.75rem;
          margin-bottom: 0.25rem;
          font-weight: 700;
        }

        .project-highlight {
          color: var(--accent-primary);
          font-weight: 600;
        }

        .action-buttons {
          display: flex;
          gap: 0.75rem;
        }

        .glass-panel {
          background: rgba(30, 41, 59, 0.4);
          backdrop-filter: blur(16px);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-lg);
          transition: all 0.3s;
        }

        .glass-panel:hover {
          border-color: var(--border-focus);
          box-shadow: var(--shadow-xl), 0 0 30px rgba(139, 92, 246, 0.05);
        }

        .readiness-main-card {
          display: grid;
          grid-template-columns: 280px 1fr;
          padding: 2.5rem;
          gap: 2.5rem;
          align-items: center;
          margin-bottom: 2.5rem;
        }

        .radial-gauge-container {
          position: relative;
          width: 200px;
          height: 200px;
          margin: 0 auto;
        }

        .radial-svg {
          transform: rotate(-90deg);
          width: 100%;
          height: 100%;
        }

        .radial-bg {
          fill: none;
          stroke: rgba(255, 255, 255, 0.05);
          stroke-width: 8;
        }

        .radial-fill {
          fill: none;
          stroke-width: 8;
          stroke-linecap: round;
          transition: stroke-dashoffset 1s ease-in-out;
        }

        .radial-text {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
        }

        .gauge-num {
          font-size: 2.25rem;
          font-weight: 800;
          color: var(--text-primary);
          line-height: 1;
        }

        .gauge-lbl {
          font-size: 0.7rem;
          font-weight: 700;
          color: var(--text-muted);
          letter-spacing: 1px;
          margin-top: 0.25rem;
        }

        .intelligence-section {
          display: flex;
          flex-direction: column;
          justify-content: center;
        }

        .intelligence-section .header-info {
          display: flex;
          align-items: center;
          gap: 1rem;
          margin-bottom: 1rem;
        }

        .intelligence-section h3 {
          font-size: 1.5rem;
          font-weight: 700;
          color: var(--text-primary);
        }

        .conf-badge {
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.5px;
          padding: 0.25rem 0.6rem;
          border-radius: 4px;
        }

        .conf-badge.high { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3); }
        .conf-badge.medium { background: rgba(245, 158, 11, 0.15); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.3); }
        .conf-badge.low { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }

        .summary-text {
          font-size: 1rem;
          color: var(--text-secondary);
          line-height: 1.7;
          margin-bottom: 1.5rem;
        }

        .metrics-summary-chips {
          display: flex;
          gap: 1rem;
        }

        .summary-chip {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--border-color);
          padding: 0.5rem 1rem;
          border-radius: var(--radius-md);
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
          max-width: 250px;
        }

        .summary-chip .chip-label {
          font-size: 0.75rem;
          color: var(--text-muted);
        }

        .summary-chip .chip-val {
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--text-primary);
        }

        .section-title {
          font-size: 1.25rem;
          font-weight: 700;
          margin-bottom: 1.25rem;
          margin-top: 1.5rem;
          letter-spacing: -0.2px;
        }

        .pillars-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 1.5rem;
          margin-bottom: 2.5rem;
        }

        .pillar-card {
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
        }

        .pillar-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .pillar-icon-wrapper {
          width: 36px;
          height: 36px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .pillar-icon-wrapper.blue { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
        .pillar-icon-wrapper.amber { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
        .pillar-icon-wrapper.green { background: rgba(16, 185, 129, 0.15); color: #34d399; }
        .pillar-icon-wrapper.purple { background: rgba(167, 139, 250, 0.15); color: #c084fc; }
        .pillar-icon-wrapper.red { background: rgba(239, 68, 68, 0.15); color: #f87171; }

        .pillar-header h4 {
          font-size: 1rem;
          font-weight: 600;
          color: var(--text-primary);
          flex: 1;
        }

        .pillar-score {
          font-size: 1.1rem;
          font-weight: 700;
        }

        .progress-bar-bg {
          height: 6px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 3px;
          overflow: hidden;
          margin-bottom: 0.75rem;
        }

        .progress-bar-fill {
          height: 100%;
          border-radius: 3px;
          transition: width 0.8s ease-in-out;
        }

        .progress-bar-fill.blue-bg { background: linear-gradient(90deg, #3b82f6, #60a5fa); }
        .progress-bar-fill.green-bg { background: linear-gradient(90deg, #10b981, #34d399); }
        .progress-bar-fill.purple-bg { background: linear-gradient(90deg, #8b5cf6, #c084fc); }
        .progress-bar-fill.amber-bg { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
        .progress-bar-fill.red-bg { background: linear-gradient(90deg, #ef4444, #f87171); }

        .pillar-stats {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .stat-row {
          display: flex;
          justify-content: space-between;
          font-size: 0.8rem;
          color: var(--text-secondary);
        }

        .stat-row strong {
          color: var(--text-primary);
        }

        .no-data-text {
          font-size: 0.8rem;
          color: var(--text-muted);
          line-height: 1.5;
        }

        .checklist-card {
          padding: 1rem 0;
        }

        .checklist-item {
          display: flex;
          align-items: center;
          padding: 1rem 2rem;
          border-bottom: 1px solid var(--border-color);
          gap: 1.25rem;
          cursor: pointer;
          transition: background 0.2s;
        }

        .checklist-item:last-child {
          border-bottom: none;
        }

        .checklist-item:hover {
          background: rgba(255, 255, 255, 0.02);
        }

        .checklist-item .icon {
          flex-shrink: 0;
        }

        .checklist-content {
          flex: 1;
        }

        .checklist-content h5 {
          font-size: 0.9rem;
          font-weight: 600;
          margin-bottom: 0.15rem;
          color: var(--text-primary);
        }

        .checklist-content p {
          font-size: 0.85rem;
          color: var(--text-secondary);
        }

        .chevron-end {
          color: var(--text-muted);
        }

        .text-red { color: #f87171 !important; }
        .text-green { color: #34d399 !important; }
        .text-amber { color: #fbbf24 !important; }

        .loading-state, .no-project-selected {
          min-height: 350px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          gap: 1rem;
          color: var(--text-secondary);
        }

        .loading-state p {
          font-size: 1.1rem;
        }

        .spin {
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          100% { transform: rotate(360deg); }
        }

        @media (max-width: 900px) {
          .readiness-main-card {
            grid-template-columns: 1fr;
            padding: 1.5rem;
            gap: 1.5rem;
          }
        }
      `}</style>
    </div>
  );
};

export default ReleaseReadiness;
