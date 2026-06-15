import React, { useState, useEffect } from 'react';
import { useAuth } from 'react-oidc-context'; // Ensure auth is available
import { AlertOctagon, Loader2, CheckCircle2, X } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import { createApiClient } from '../../utils/apiClient';

const TestCaseTable = ({ testCases: propTestCases }) => {
  const { selectedProject } = useProject();
  const { isLoading, error: authError, user } = useAuth();
  const [api, setApi] = useState(null);

  // Initialize API client when token is available
  useEffect(() => {
    if (user?.access_token) {
      setApi(createApiClient(() => user.access_token));
    }
  }, [user?.access_token]);

  // Local copy of test cases for editing/adding
  const [testCases, setTestCases] = useState(propTestCases || []);
  useEffect(() => {
    setTestCases(propTestCases || []);
  }, [propTestCases]);

  const [activeModalTc, setActiveModalTc] = useState(null);
  const [actualResult, setActualResult] = useState('');
  const [isRaising, setIsRaising] = useState({});
  const [raisedBugs, setRaisedBugs] = useState({}); // mapping from tc.id -> bugKey or status

  // Editing state
  const [editMode, setEditMode] = useState({}); // rowId => boolean
  const [editData, setEditData] = useState({}); // rowId => partial test case

  // Add new test case state
  const [showAddModal, setShowAddModal] = useState(false);
  const emptyNewTc = {
    module: '',
    scenario: '',
    preconditions: '',
    testData: '',
    steps: [],
    expectedResult: '',
    priority: 'Medium',
    testType: 'Functional',
    platform: ''
  };
  const [newTestCase, setNewTestCase] = useState(emptyNewTc);

  if (isLoading) {
        return <div className="loading-banner">Loading authentication...</div>;
      }
      if (authError) {
        return <div className="error-banner">Authentication error: {authError.message}</div>;
      }
      // If user is not logged in, allow UI to function locally but disable defect actions.
      const authWarning = !user ? (<div className="warning-banner" style={{ marginBottom: '1rem', padding: '0.5rem', background: 'rgba(255,165,0,0.1)', color: '#b8860b' }}>You are not logged in – defect integration is disabled.</div>) : null;
      if (!testCases || testCases.length === 0) return null;

  // ---------- Defect handling (unchanged) ----------
  const handleOpenRaiseModal = (tc) => {
    setActiveModalTc(tc);
    setActualResult(`Actual outcome deviated from expected: "${tc.expectedResult}"`);
  };

  const handleRaiseDefect = async () => {
    if (!activeModalTc) return;
    const tcId = activeModalTc.id;
    setIsRaising(prev => ({ ...prev, [tcId]: true }));
    setActiveModalTc(null); // close modal immediately

    if (!api) {
        console.warn('Defect integration unavailable – not logged in');
        setRaisedBugs(prev => ({ ...prev, [tcId]: { success: false, error: 'Not authenticated' } }));
        setIsRaising(prev => ({ ...prev, [tcId]: false }));
        return;
      }
      try {
        const data = await api.post('/api/jira/defect', {
          testCase: activeModalTc,
          actualResult: actualResult,
          projectName: selectedProject?.name || 'AAUQA Quality Run'
        });
        setRaisedBugs(prev => ({ ...prev, [tcId]: { success: true, key: data.jiraKey } }));
      } catch (err) {
        console.error('[Raise Defect Error]', err);
        const msg = err?.data?.error || err.message || 'Unknown error';
        setRaisedBugs(prev => ({ ...prev, [tcId]: { success: false, error: msg } }));
      } finally {
        setIsRaising(prev => ({ ...prev, [tcId]: false }));
      }
  };

  // ---------- Editing handlers ----------
  const handleEdit = (tcId, tc) => {
    setEditMode(prev => ({ ...prev, [tcId]: true }));
    setEditData(prev => ({ ...prev, [tcId]: { ...tc } }));
  };

  const handleChange = (tcId, field, value) => {
    setEditData(prev => ({
      ...prev,
      [tcId]: { ...prev[tcId], [field]: value }
    }));
  };

  const handleSave = async (tcId) => {
    // Save edited test case – placeholder for backend persistence
    if (!api) {
      console.warn('API client not ready – saving only locally');
      // Local update only
    } else {
      // Example API call (uncomment when endpoint exists)
      // await api.put(`/api/testcases/${tcId}`, editData[tcId]);
    }

    const updated = editData[tcId];
    // Placeholder API call – can be implemented later
    // await api.put(`/api/testcases/${tcId}`, updated);
    setTestCases(prev => prev.map(tc => (tc.id === tcId ? updated : tc)));
    setEditMode(prev => ({ ...prev, [tcId]: false }));
    const { [tcId]: _, ...rest } = editData;
    setEditData(rest);
  };

  const handleCancel = (tcId) => {
    setEditMode(prev => ({ ...prev, [tcId]: false }));
    const { [tcId]: _, ...rest } = editData;
    setEditData(rest);
  };

  // ---------- Add new test case handlers ----------
  const openAddModal = () => setShowAddModal(true);
  const closeAddModal = () => {
    setShowAddModal(false);
    setNewTestCase(emptyNewTc);
  };
  const handleAddChange = (field, value) => {
    setNewTestCase(prev => ({ ...prev, [field]: value }));
  };
  const handleCreate = async () => {
    const newTc = { ...newTestCase, id: `TC-${Date.now()}` };
    // Placeholder API call for creation
    // await api.post('/api/testcases', newTc);
    setTestCases(prev => [...prev, newTc]);
    closeAddModal();
  };

  return (
    <div className="table-container animate-fade-in" style={{ animationDelay: '0.2s' }}>
      <div className="card table-card">
        {authWarning}
        <div className="table-header">
          <h3>Generated Test Cases</h3>
          <span className="count-badge">{testCases.length} Cases</span>
          <button className="btn btn-primary" onClick={openAddModal}>+ Add Test Case</button>
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
                <th style={{ width: '120px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {testCases.map((tc, index) => {
                const tcId = tc.id || `TC-${index + 1}`;
                const isRaisingThis = isRaising[tcId];
                const bugState = raisedBugs[tcId];
                const isEditing = editMode[tcId];
                const editVals = editData[tcId] || {};

                return (
                  <tr key={tc.id || index}>
                    <td className="id-cell">{tc.id}</td>
                    <td>{isEditing ? (
                      <input className="input-field" value={editVals.module || ''} onChange={e => handleChange(tcId, 'module', e.target.value)} />
                    ) : (
                      <span className="module-tag">{tc.module}</span>
                    )}</td>
                    <td className="scenario-cell">{isEditing ? (
                      <input className="input-field" value={editVals.scenario || ''} onChange={e => handleChange(tcId, 'scenario', e.target.value)} />
                    ) : (
                      <>
                        {tc.scenario}
                        {tc.feature && <div className="feature-sub">{tc.feature}</div>}
                      </>
                    )}</td>
                    <td className="multiline-cell">{isEditing ? (
                      <textarea className="input-field" rows={2} value={editVals.preconditions || ''} onChange={e => handleChange(tcId, 'preconditions', e.target.value)} />
                    ) : (tc.preconditions || 'None')}</td>
                    <td className="multiline-cell">{isEditing ? (
                      <textarea className="input-field" rows={2} value={editVals.testData || ''} onChange={e => handleChange(tcId, 'testData', e.target.value)} />
                    ) : (tc.testData || 'N/A')}</td>
                    <td className="multiline-cell">{isEditing ? (
                      <textarea className="input-field" rows={2} value={Array.isArray(editVals.steps) ? editVals.steps.join('\n') : editVals.steps || ''} onChange={e => handleChange(tcId, 'steps', e.target.value.split('\n'))} />
                    ) : (Array.isArray(tc.steps) ? tc.steps.join('\n') : tc.steps)}</td>
                    <td className="multiline-cell">{isEditing ? (
                      <textarea className="input-field" rows={2} value={editVals.expectedResult || ''} onChange={e => handleChange(tcId, 'expectedResult', e.target.value)} />
                    ) : (tc.expectedResult)}</td>
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
                        <button className="btn-defect-trigger retry" onClick={() => handleOpenRaiseModal(tc)} title={`Click to retry: ${bugState.error}`}>
                          Retry Bug
                        </button>
                      ) : (
                        <button className="btn-defect-trigger" onClick={() => handleOpenRaiseModal(tc)} disabled={isRaisingThis}>
                          {isRaisingThis ? <Loader2 className="spin" size={14} /> : <><AlertOctagon size={14} /><span>Log Bug</span></>}
                        </button>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <>
                          <button className="btn btn-primary" onClick={() => handleSave(tcId)} style={{ marginRight: '0.5rem' }}>Save</button>
                          <button className="btn btn-secondary" onClick={() => handleCancel(tcId)}>Cancel</button>
                        </>
                      ) : (
                        <button className="btn btn-primary" onClick={() => handleEdit(tcId, tc)}>Edit</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Add Test Case Modal */}
        {showAddModal && (
          <div className="modal-backdrop">
            <div className="modal-content glass-panel animate-fade-in">
              <div className="modal-header">
                <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>Add New Test Case</h4>
                <button className="modal-close-btn" onClick={closeAddModal}><X size={18} /></button>
              </div>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
                <div className="form-group">
                  <label>Module</label>
                  <input className="input-field" value={newTestCase.module} onChange={e => handleAddChange('module', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Scenario</label>
                  <input className="input-field" value={newTestCase.scenario} onChange={e => handleAddChange('scenario', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Preconditions</label>
                  <textarea className="input-field" rows={2} value={newTestCase.preconditions} onChange={e => handleAddChange('preconditions', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Test Data</label>
                  <textarea className="input-field" rows={2} value={newTestCase.testData} onChange={e => handleAddChange('testData', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Test Steps (one per line)</label>
                  <textarea className="input-field" rows={3} value={newTestCase.steps.join('\n')} onChange={e => handleAddChange('steps', e.target.value.split('\n'))} />
                </div>
                <div className="form-group">
                  <label>Expected Result</label>
                  <textarea className="input-field" rows={2} value={newTestCase.expectedResult} onChange={e => handleAddChange('expectedResult', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Priority</label>
                  <select className="input-field" value={newTestCase.priority} onChange={e => handleAddChange('priority', e.target.value)}>
                    <option>High</option>
                    <option>Medium</option>
                    <option>Low</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Type</label>
                  <select className="input-field" value={newTestCase.testType} onChange={e => handleAddChange('testType', e.target.value)}>
                    <option>Functional</option>
                    <option>Regression</option>
                    <option>Smoke</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Platform</label>
                  <input className="input-field" value={newTestCase.platform} onChange={e => handleAddChange('platform', e.target.value)} />
                </div>
              </div>
              <div className="modal-footer" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
                <button className="btn btn-secondary" onClick={closeAddModal}>Cancel</button>
                <button className="btn btn-primary" onClick={handleCreate}>Create</button>
              </div>
            </div>
          </div>
        )}

        {/* Existing Raise Defect Modal */}
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
                  <p style={{ margin: '0.25rem 0 1rem 0', color: 'var(--accent-secondary)', fontWeight: 600 }}>{selectedProject?.name || 'AAUQA Default Context'}</p>
                </div>
                <div className="form-group">
                  <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '0.5rem' }}>Execution Failure Reason / Actual Result</label>
                  <textarea className="input-field" rows={4} value={actualResult} onChange={e => setActualResult(e.target.value)} placeholder="Describe what went wrong in detail..." style={{ margin: 0 }} />
                </div>
              </div>
              <div className="modal-footer" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
                <button className="btn btn-secondary" onClick={() => setActiveModalTc(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleRaiseDefect}>Raise Defect</button>
              </div>
            </div>
          </div>
        )}

        <style>{`\n          .table-card { padding: 0; overflow: hidden; }\n          .table-header { padding: 1.5rem; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; gap: 1rem; }\n          .table-header h3 { font-size: 1.25rem; font-weight: 600; }\n          .count-badge { background: var(--bg-primary); padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.85rem; color: var(--text-secondary); border: 1px solid var(--border-color); }\n          .table-responsive { overflow-x: auto; }\n          .qa-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }\n          .qa-table th { background: var(--bg-tertiary); text-align: left; padding: 1rem; font-weight: 600; color: var(--text-secondary); white-space: nowrap; }\n          .qa-table td { padding: 1rem; border-bottom: 1px solid var(--border-color); vertical-align: top; color: var(--text-primary); }\n          .qa-table tr:last-child td { border-bottom: none; }\n          .id-cell { font-family: monospace; color: var(--text-muted); }\n          .module-tag { background: rgba(59, 130, 246, 0.1); color: var(--accent-secondary); padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }\n          .scenario-cell { font-weight: 500; }\n          .feature-sub { margin-top: 0.25rem; font-size: 0.75rem; font-weight: 400; color: var(--text-muted); }\n          .multiline-cell { white-space: pre-wrap; line-height: 1.5; max-width: 300px; }\n          .priority-badge { padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }\n          .priority-badge.high, .priority-badge.p1, .priority-badge.p2 { background: rgba(239, 68, 68, 0.15); color: #fca5a5; }\n          .priority-badge.medium, .priority-badge.p3 { background: rgba(245, 158, 11, 0.15); color: #fcd34d; }\n          .priority-badge.low, .priority-badge.p4 { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; }\n          .type-badge { font-size: 0.75rem; color: var(--text-muted); border: 1px solid var(--border-color); padding: 2px 6px; border-radius: 4px; }\n          .btn-defect-trigger { display: inline-flex; align-items: center; gap: 0.4rem; background: rgba(239, 68, 68, 0.1); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); padding: 0.4rem 0.8rem; border-radius: var(--radius-md); font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }\n          .btn-defect-trigger:hover { background: rgba(239, 68, 68, 0.2); border-color: #f87171; box-shadow: 0 0 10px rgba(239, 68, 68, 0.2); }\n          .btn-defect-trigger.retry { background: rgba(245, 158, 11, 0.15); color: #fcd34d; border-color: rgba(245, 158, 11, 0.4); }\n          .bug-badge { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.4rem 0.8rem; border-radius: var(--radius-md); font-size: 0.8rem; font-weight: 700; }\n          .bug-badge.success { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }\n          .modal-backdrop { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 9999; }\n          .modal-content { width: 100%; max-width: 500px; padding: 2rem; border-radius: var(--radius-lg); border: 1px solid var(--border-color); box-shadow: var(--shadow-2xl); background: var(--bg-primary); }\n          .modal-header { display: flex; justify-content: space-between; align-items: center; }\n          .modal-close-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0.25rem; border-radius: 4px; transition: all 0.2s; }\n          .modal-close-btn:hover { color: var(--text-primary); background: rgba(255, 255, 255, 0.05); }\n          .spin { animation: spin 1s linear infinite; }\n          @keyframes spin { 100% { transform: rotate(360deg); } }\n          .input-field { width: 100%; padding: 0.4rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-secondary); color: var(--text-primary); font-size: 0.9rem; transition: border-color 0.2s; }\n          .input-field:focus { outline: none; border-color: var(--accent-primary); }\n          .btn { padding: 0.4rem 0.8rem; border-radius: var(--radius-md); font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none; }\n          .btn-primary { background: var(--accent-primary); color: #fff; }\n          .btn-secondary { background: var(--bg-secondary); color: var(--text-primary); }\n        `}</style>
      </div>
    </div>
  );
};

export default TestCaseTable;
