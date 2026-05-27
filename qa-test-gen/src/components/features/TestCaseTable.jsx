import React, { useState } from 'react';
import { AlertOctagon, Loader2, CheckCircle2, X } from 'lucide-react';
import { useAuth } from 'react-oidc-context';
import { useProject } from '../../context/ProjectContext';
import { createApiClient } from '../../utils/apiClient';

const TestCaseTable = ({ testCases }) => {
  const { selectedProject } = useProject();
  const auth = useAuth();
  const api = createApiClient(() => auth.user?.access_token);

  const [activeModalTc, setActiveModalTc] = useState(null);
  const [actualResult, setActualResult] = useState('');
  const [isRaising, setIsRaising] = useState({});
  const [raisedBugs, setRaisedBugs] = useState({}); // mapping from tc.id -> bugKey or status

  if (!testCases || testCases.length === 0) return null;

  const handleOpenRaiseModal = (tc) => {
    setActiveModalTc(tc);
    setActualResult(`Actual outcome deviated from expected: "${tc.expectedResult}"`);
  };

  const handleRaiseDefect = async () => {
    if (!activeModalTc) return;
    const tcId = activeModalTc.id;
    
    setIsRaising(prev => ({ ...prev, [tcId]: true }));
    setActiveModalTc(null); // close modal immediately

    try {
      const data = await api.post('/api/jira/defect', {
        testCase: activeModalTc,
        actualResult: actualResult,
        projectName: selectedProject?.name || 'AAUQA Quality Run'
      });

      setRaisedBugs(prev => ({ ...prev, [tcId]: { success: true, key: data.jiraKey } }));
    } catch (err) {
      console.error('[Raise Defect Error]', err);
      setRaisedBugs(prev => ({ ...prev, [tcId]: { success: false, error: err.message } }));
    } finally {
      setIsRaising(prev => ({ ...prev, [tcId]: false }));
    }
  };

  return (
    <div className="table-container animate-fade-in" style={{ animationDelay: '0.2s' }}>
      <div className="card table-card">
        <div className="table-header">
          <h3>Generated Test Cases</h3>
          <span className="count-badge">{testCases.length} Cases</span>
        </div>

        <div className="table-responsive">
          <table className="qa-table">
            <thead>
              <tr>
                <th style={{ width: '80px' }}>ID</th>
                <th>Module</th>
                <th>Scenario</th>
                <th>Preconditions</th>
                <th>Test Data</th>
                <th>Test Steps</th>
                <th>Expected Result</th>
                <th style={{ width: '100px' }}>Priority</th>
                <th style={{ width: '100px' }}>Type</th>
                <th style={{ width: '100px' }}>Platform</th>
                <th style={{ width: '140px', textAlign: 'center' }}>Jira Integration</th>
              </tr>
            </thead>
            <tbody>
              {testCases.map((tc, index) => {
                const tcId = tc.id || `TC-${index + 1}`;
                const isRaisingThis = isRaising[tcId];
                const bugState = raisedBugs[tcId];

                return (
                  <tr key={tc.id || index}>
                    <td className="id-cell">{tc.id}</td>
                    <td><span className="module-tag">{tc.module}</span></td>
                    <td className="scenario-cell">
                      {tc.scenario}
                      {tc.feature && <div className="feature-sub">{tc.feature}</div>}
                    </td>
                    <td className="multiline-cell">{tc.preconditions || 'None'}</td>
                    <td className="multiline-cell">{tc.testData || 'N/A'}</td>
                    <td className="multiline-cell">{Array.isArray(tc.steps) ? tc.steps.join('\n') : tc.steps}</td>
                    <td className="multiline-cell">{tc.expectedResult}</td>
                    <td>
                      <span className={`priority-badge ${tc.priority?.split('-')[0].toLowerCase()}`}>
                        {tc.priority}
                      </span>
                    </td>
                    <td><span className="type-badge">{tc.testType || 'Functional'}</span></td>
                    <td>{tc.platform}</td>
                    <td style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                      {bugState?.success ? (
                        <div className="bug-badge success animate-fade-in" title="Defect Logged Successfully">
                          <CheckCircle2 size={14} />
                          <span>{bugState.key}</span>
                        </div>
                      ) : bugState?.error ? (
                        <button 
                          className="btn-defect-trigger retry" 
                          onClick={() => handleOpenRaiseModal(tc)}
                          title={`Click to retry: ${bugState.error}`}
                        >
                          Retry Bug
                        </button>
                      ) : (
                        <button
                          className="btn-defect-trigger"
                          onClick={() => handleOpenRaiseModal(tc)}
                          disabled={isRaisingThis}
                        >
                          {isRaisingThis ? (
                            <Loader2 className="spin" size={14} />
                          ) : (
                            <>
                              <AlertOctagon size={14} />
                              <span>Log Bug</span>
                            </>
                          )}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modern Premium Popup Modal overlay */}
      {activeModalTc && (
        <div className="modal-backdrop">
          <div className="modal-content glass-panel animate-fade-in">
            <div className="modal-header">
              <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
                <AlertOctagon size={20} color="var(--error)" />
                <span>Raise JIRA Defect ticket for {activeModalTc.id}</span>
              </h4>
              <button className="modal-close-btn" onClick={() => setActiveModalTc(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Test Case Scenario</label>
                <p style={{ margin: '0.25rem 0', fontWeight: 600 }}>{activeModalTc.scenario}</p>
              </div>

              <div className="form-group">
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Target Project Context</label>
                <p style={{ margin: '0.25rem 0 1rem 0', color: 'var(--accent-secondary)', fontWeight: 600 }}>
                  {selectedProject?.name || 'AAUQA Default Context'}
                </p>
              </div>

              <div className="form-group">
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '0.5rem' }}>
                  Execution Failure Reason / Actual Result
                </label>
                <textarea
                  className="input-field"
                  rows={4}
                  value={actualResult}
                  onChange={(e) => setActualResult(e.target.value)}
                  placeholder="Describe what went wrong in detail..."
                  style={{ margin: 0 }}
                />
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
              <button className="btn btn-secondary" onClick={() => setActiveModalTc(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleRaiseDefect}>Raise Defect</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .table-card {
          padding: 0;
          overflow: hidden;
        }
        
        .table-header {
          padding: 1.5rem;
          border-bottom: 1px solid var(--border-color);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .table-header h3 {
          font-size: 1.25rem;
          font-weight: 600;
        }
        
        .count-badge {
          background: var(--bg-primary);
          padding: 0.25rem 0.75rem;
          border-radius: 20px;
          font-size: 0.85rem;
          color: var(--text-secondary);
          border: 1px solid var(--border-color);
        }
        
        .table-responsive {
          overflow-x: auto;
        }
        
        .qa-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.9rem;
        }
        
        .qa-table th {
          background: var(--bg-tertiary);
          text-align: left;
          padding: 1rem;
          font-weight: 600;
          color: var(--text-secondary);
          white-space: nowrap;
        }
        
        .qa-table td {
          padding: 1rem;
          border-bottom: 1px solid var(--border-color);
          vertical-align: top;
          color: var(--text-primary);
        }
        
        .qa-table tr:last-child td {
          border-bottom: none;
        }
        
        .id-cell {
          font-family: monospace;
          color: var(--text-muted);
        }
        
        .module-tag {
          background: rgba(59, 130, 246, 0.1);
          color: var(--accent-secondary);
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 0.8rem;
        }
        
        .scenario-cell {
          font-weight: 500;
        }

        .feature-sub {
          margin-top: 0.25rem;
          font-size: 0.75rem;
          font-weight: 400;
          color: var(--text-muted);
        }
        
        .multiline-cell {
          white-space: pre-wrap;
          line-height: 1.5;
          max-width: 300px;
        }
        
        .priority-badge {
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 0.75rem;
          font-weight: 600;
          text-transform: uppercase;
        }
        
        .priority-badge.high, .priority-badge.p1, .priority-badge.p2 {
          background: rgba(239, 68, 68, 0.15);
          color: #fca5a5;
        }
        
        .priority-badge.medium, .priority-badge.p3 {
          background: rgba(245, 158, 11, 0.15);
          color: #fcd34d;
        }
        
        .priority-badge.low, .priority-badge.p4 {
          background: rgba(16, 185, 129, 0.15);
          color: #6ee7b7;
        }

        .type-badge {
          font-size: 0.75rem;
          color: var(--text-muted);
          border: 1px solid var(--border-color);
          padding: 2px 6px;
          border-radius: 4px;
        }

        .btn-defect-trigger {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          background: rgba(239, 68, 68, 0.1);
          color: #f87171;
          border: 1px solid rgba(239, 68, 68, 0.3);
          padding: 0.4rem 0.8rem;
          border-radius: var(--radius-md);
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-defect-trigger:hover {
          background: rgba(239, 68, 68, 0.2);
          border-color: #f87171;
          box-shadow: 0 0 10px rgba(239, 68, 68, 0.2);
        }

        .btn-defect-trigger.retry {
          background: rgba(245, 158, 11, 0.15);
          color: #fcd34d;
          border-color: rgba(245, 158, 11, 0.4);
        }

        .bug-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0.4rem 0.8rem;
          border-radius: var(--radius-md);
          font-size: 0.8rem;
          font-weight: 700;
        }

        .bug-badge.success {
          background: rgba(16, 185, 129, 0.15);
          color: #34d399;
          border: 1px solid rgba(16, 185, 129, 0.4);
        }

        /* Modal Overlay Overlay Styles */
        .modal-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: rgba(15, 23, 42, 0.6);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
        }

        .modal-content {
          width: 100%;
          max-width: 500px;
          padding: 2rem;
          border-radius: var(--radius-lg);
          border: 1px solid var(--border-color);
          box-shadow: var(--shadow-2xl);
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .modal-close-btn {
          background: none;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          padding: 0.25rem;
          border-radius: 4px;
          transition: all 0.2s;
        }

        .modal-close-btn:hover {
          color: var(--text-primary);
          background: rgba(255, 255, 255, 0.05);
        }

        .spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default TestCaseTable;
