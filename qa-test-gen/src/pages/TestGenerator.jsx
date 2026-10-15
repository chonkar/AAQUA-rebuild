import React, { useState, useRef, useEffect } from 'react';
import RequirementInput from '../components/features/RequirementInput';
import TestCaseTable from '../components/features/TestCaseTable';
import ExportControls from '../components/features/ExportControls';
import { generateTestCases } from '../services/testCaseGenerationService';
import { exportToExcel, exportToJSON } from '../utils/exportUtils';
import { AlertCircle, Clock, Trash2, Calendar, FileText, ChevronRight, ChevronDown, X } from 'lucide-react';
import { useProject } from '../context/ProjectContext';
import { useAuth } from 'react-oidc-context';
import { createApiClient } from '../utils/apiClient';

// Format an elapsed-seconds value as "12.3s" or "1m 05s".
const fmtDuration = (s) => {
    if (s == null) return '';
    if (s >= 60) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
    return `${s.toFixed(1)}s`;
};

const TestGenerator = () => {
    const { selectedProjectId } = useProject();
    const auth = useAuth();
    const api = createApiClient(() => auth.user?.access_token);

    const [testCases, setTestCases] = useState([]);
    const [requirementHistory, setRequirementHistory] = useState([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState(null);
    const [genSeconds, setGenSeconds] = useState(null);
    const [lastBatchCount, setLastBatchCount] = useState(0);
    const abortControllerRef = useRef(null);

    // Form input states (lifted from RequirementInput to support reloading runs)
    const [sourceType, setSourceType] = useState('manual');
    const [jiraKey, setJiraKey] = useState('');
    const [manualStoryKey, setManualStoryKey] = useState('');
    const [requirement, setRequirement] = useState('');
    const [businessRules, setBusinessRules] = useState('');
    const [regressionContext, setRegressionContext] = useState('');
    const [techDetails, setTechDetails] = useState('');

    // History tracking states
    const [historyStories, setHistoryStories] = useState([]);
    const [selectedStoryRuns, setSelectedStoryRuns] = useState([]);
    const [activeStoryKey, setActiveStoryKey] = useState('');
    const [historyWarning, setHistoryWarning] = useState(null);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);

    const fetchHistoryStories = async () => {
        if (!selectedProjectId || !api) return;
        setIsLoadingHistory(true);
        try {
            const data = await api.get(`/api/testcase-history/stories?project_id=${selectedProjectId}`);
            setHistoryStories(data.stories || []);
        } catch (err) {
            console.error('[Fetch Stories Error]', err);
        } finally {
            setIsLoadingHistory(false);
        }
    };

    const fetchStoryRuns = async (storyKey) => {
        if (!selectedProjectId || !api || !storyKey) return;
        try {
            const data = await api.get(`/api/testcase-history/story/${encodeURIComponent(storyKey)}/runs?project_id=${selectedProjectId}`);
            setSelectedStoryRuns(data.runs || []);
            setActiveStoryKey(storyKey);
        } catch (err) {
            console.error('[Fetch Runs Error]', err);
        }
    };

    const handleLoadRun = (run) => {
        setTestCases(run.test_cases || []);
        setGenSeconds(null);
        setLastBatchCount(run.test_cases?.length || 0);

        // Restore all requirement parameters into the UI inputs
        setRequirement(run.story_description || '');
        setBusinessRules(run.business_rules || '');
        setRegressionContext(run.regression_context || '');
        setTechDetails(run.tech_details || '');

        // Determine if story key belongs to Jira key or manual input
        const isJira = /^[A-Z0-9]+-\d+$/i.test(run.story_key);
        if (isJira) {
            setSourceType('jira');
            setJiraKey(run.story_key);
            setManualStoryKey('');
        } else {
            setSourceType('manual');
            setManualStoryKey(run.story_key || '');
            setJiraKey('');
        }
    };

    const handleDeleteRun = async (runId, storyKey) => {
        if (!api) return;
        try {
            await api.del(`/api/testcase-history/run/${runId}`);
            fetchStoryRuns(storyKey);
            fetchHistoryStories();
        } catch (err) {
            console.error('[Delete Run Error]', err);
        }
    };

    const handleDeleteStory = async (storyKey) => {
        if (!selectedProjectId || !api) return;
        if (!window.confirm(`Are you sure you want to delete all history runs for "${storyKey}"?`)) return;
        try {
            await api.del(`/api/testcase-history/story/${encodeURIComponent(storyKey)}?project_id=${selectedProjectId}`);
            setActiveStoryKey('');
            setSelectedStoryRuns([]);
            fetchHistoryStories();
        } catch (err) {
            console.error('[Delete Story Error]', err);
        }
    };

    // Load history when project or auth state updates
    useEffect(() => {
        if (selectedProjectId && auth.isAuthenticated) {
            fetchHistoryStories();
        } else {
            setHistoryStories([]);
            setActiveStoryKey('');
            setSelectedStoryRuns([]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedProjectId, auth.isAuthenticated, auth.user?.access_token]);

    const handleCancel = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsGenerating(false);
        }
    };

    const handleGenerate = async (requirement, businessRules = '', regressionContext = '', techDetails = '', storyKey = '') => {
        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setIsGenerating(true);
        setError(null);
        setGenSeconds(null);
        setHistoryWarning(null);
        const startedAt = performance.now();
        try {
            const results = await generateTestCases(requirement, requirementHistory, businessRules, regressionContext, techDetails, controller.signal);
            
            let maxNum = 0;
            testCases.forEach(tc => {
                if (tc.id && tc.id.startsWith('FT_')) {
                    const num = parseInt(tc.id.replace('FT_', ''), 10);
                    if (!isNaN(num) && num > maxNum) {
                        maxNum = num;
                    }
                }
            });
            const reindexedResults = results.map((tc, idx) => ({
                ...tc,
                id: `FT_${String(maxNum + idx + 1).padStart(3, '0')}`
            }));

            setTestCases(prev => [...prev, ...reindexedResults]);
            setRequirementHistory(prev => [...prev, requirement]);
            setLastBatchCount(Array.isArray(results) ? results.length : 0);
            setGenSeconds((performance.now() - startedAt) / 1000);

            // Auto-save history run to backend
            if (selectedProjectId && api) {
                try {
                    const response = await api.post('/api/testcase-history', {
                        project_id: selectedProjectId,
                        story_key: storyKey,
                        story_description: requirement,
                        business_rules: businessRules,
                        regression_context: regressionContext,
                        tech_details: techDetails,
                        test_cases: reindexedResults
                    });
                    if (response?.warning) {
                        setHistoryWarning(response.warning);
                    }
                    fetchHistoryStories();
                } catch (saveErr) {
                    console.error('[History Save Error]', saveErr);
                }
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                console.log("Cancelled");
            } else {
                setError(err.message);
            }
        } finally {
            if (abortControllerRef.current === controller) {
                setIsGenerating(false);
                abortControllerRef.current = null;
            }
        }
    };

    // Map to an ordered, human-labeled "Test Cases" sheet so a first-time
    // reviewer can read it top-to-bottom (ID → context → detailed steps → result).
    const handleExportExcel = () => {
        const rows = testCases.map((tc, i) => ({
            'Test Case ID': tc.id || `FT_${String(i + 1).padStart(3, '0')}`,
            'Module': tc.module || '',
            'Feature': tc.feature || '',
            'Scenario': tc.scenario || '',
            'Test Type': tc.testType || 'Functional',
            'Priority': tc.priority || '',
            'Platform': tc.platform || '',
            'Preconditions': tc.preconditions || 'None',
            'Test Data': tc.testData || 'N/A',
            'Test Steps': Array.isArray(tc.steps) ? tc.steps.join('\n') : (tc.steps || ''),
            'Expected Result': tc.expectedResult || '',
        }));
        exportToExcel(rows, 'Functional_Test_Cases', 'Test Cases');
    };
    const handleExportJSON = () => exportToJSON(testCases);

    return (
        <div className="test-generator">
            <div className="page-header">
                <h2>Functional Test Generator</h2>
                <p>Transform your requirements into comprehensive functional test cases instantly.</p>
            </div>

            {historyWarning && (
                <div className="warning-banner animate-fade-in" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
                    <span>⚠️</span>
                    <span style={{ flex: 1 }}>{historyWarning}</span>
                    <button onClick={() => setHistoryWarning(null)} style={{ background: 'none', border: 'none', color: '#fef3c7', cursor: 'pointer', fontWeight: 'bold' }}><X size={16} /></button>
                </div>
            )}

            <div className="test-generator-grid">
                <div className="generator-main">
                    <RequirementInput
                        onGenerate={handleGenerate}
                        isGenerating={isGenerating}
                        onCancel={handleCancel}
                        contextCount={requirementHistory.length}
                        onClearContext={() => {
                            setRequirementHistory([]);
                            setTestCases([]);
                            setRequirement('');
                            setManualStoryKey('');
                            setJiraKey('');
                            setBusinessRules('');
                            setRegressionContext('');
                            setTechDetails('');
                        }}
                        sourceType={sourceType}
                        setSourceType={setSourceType}
                        jiraKey={jiraKey}
                        setJiraKey={setJiraKey}
                        manualStoryKey={manualStoryKey}
                        setManualStoryKey={setManualStoryKey}
                        requirement={requirement}
                        setRequirement={setRequirement}
                        businessRules={businessRules}
                        setBusinessRules={setBusinessRules}
                        regressionContext={regressionContext}
                        setRegressionContext={setRegressionContext}
                        techDetails={techDetails}
                        setTechDetails={setTechDetails}
                    />
                </div>

                <div className="generator-sidebar">
                    <div className="card history-card" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: '380px' }}>
                        <div className="history-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', marginBottom: '0.75rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
                                <Clock size={16} /> Saved Stories History
                            </h3>
                        </div>

                        <div className="history-warning-box" style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.25)', color: '#fcd34d', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', lineHeight: 1.4, marginBottom: '0.75rem' }}>
                            ⚠️ <strong>Limit Notice:</strong> Up to 10 runs are stored per User Story. The 11th run automatically deletes the oldest.
                        </div>

                        {isLoadingHistory ? (
                            <div style={{ textAlign: 'center', padding: '2rem 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                                Loading history...
                            </div>
                        ) : historyStories.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                                No history saved yet. Generated runs will appear here automatically.
                            </div>
                        ) : (
                            <div className="history-list" style={{ overflowY: 'auto', flex: 1, maxHeight: '380px', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {historyStories.map((story) => {
                                    const isExpanded = activeStoryKey === story.storyKey;
                                    return (
                                        <div key={story.storyKey} style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: isExpanded ? 'rgba(255,255,255,0.02)' : 'transparent', overflow: 'hidden' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', cursor: 'pointer' }} onClick={() => isExpanded ? setActiveStoryKey('') : fetchStoryRuns(story.storyKey)}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', overflow: 'hidden', flex: 1 }}>
                                                    {isExpanded ? <ChevronDown size={14} style={{ flexShrink: 0 }} /> : <ChevronRight size={14} style={{ flexShrink: 0 }} />}
                                                    <div style={{ overflow: 'hidden' }}>
                                                        <div style={{ fontWeight: 600, fontSize: '0.85rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={story.storyKey}>
                                                            {story.storyKey}
                                                        </div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                            {story.description}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.5rem' }}>
                                                    <span style={{ fontSize: '0.7rem', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', padding: '0.1rem 0.4rem', borderRadius: '10px', color: 'var(--text-secondary)' }}>
                                                        {story.runCount}
                                                    </span>
                                                    <button 
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDeleteStory(story.storyKey);
                                                        }} 
                                                        style={{ background: 'none', border: 'none', color: '#ef4444', padding: '0.2rem', cursor: 'pointer', opacity: 0.7 }}
                                                        className="hover-opacity-100"
                                                        title="Delete Story History"
                                                    >
                                                        <Trash2 size={12} />
                                                    </button>
                                                </div>
                                            </div>

                                            {isExpanded && (
                                                <div style={{ background: 'rgba(0,0,0,0.15)', borderTop: '1px solid var(--border-color)', padding: '0.4rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                                    {selectedStoryRuns.length === 0 ? (
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', padding: '0.5rem 0' }}>Loading runs...</div>
                                                    ) : (
                                                        selectedStoryRuns.map((run, runIdx) => (
                                                            <div key={run.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', padding: '0.25rem 0' }}>
                                                                <span 
                                                                    onClick={() => handleLoadRun(run)} 
                                                                    style={{ cursor: 'pointer', color: 'var(--accent-secondary)', textDecoration: 'underline', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                                                    title="Click to load these test cases"
                                                                >
                                                                    Run {selectedStoryRuns.length - runIdx} ({new Date(run.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})
                                                                </span>
                                                                <button 
                                                                    onClick={() => handleDeleteRun(run.id, story.storyKey)}
                                                                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0.1rem' }}
                                                                    className="hover-text-danger"
                                                                    title="Delete this run"
                                                                >
                                                                    <X size={10} />
                                                                </button>
                                                            </div>
                                                        ))
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {error && (
                <div className="error-banner animate-fade-in">
                    <AlertCircle size={20} />
                    <span>{error}</span>
                </div>
            )}

            {testCases.length > 0 && (
                <div className="results-section">
                    {genSeconds != null && (
                        <div className="gen-timing">
                            <Clock size={14} />
                            <span>Generated {lastBatchCount} test case{lastBatchCount === 1 ? '' : 's'} in {fmtDuration(genSeconds)}</span>
                        </div>
                    )}
                    <ExportControls
                        onExportExcel={handleExportExcel}
                        onExportJSON={handleExportJSON}
                        testCases={testCases}
                        disabled={isGenerating}
                    />
                    <TestCaseTable testCases={testCases} onTestCasesChange={setTestCases} />
                </div>
            )}

            <style>{`
        .page-header {
            margin-bottom: 2rem;
        }
        .page-header h2 {
            font-size: 1.75rem;
            margin-bottom: 0.5rem;
        }
        .page-header p {
            color: var(--text-secondary);
        }
        .error-banner {
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid var(--error);
          color: #fca5a5;
          padding: 1rem;
          border-radius: var(--radius-md);
          margin-top: 1.5rem;
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }
        .results-section {
          margin-top: 2rem;
        }
        .gen-timing {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          margin-bottom: 0.75rem;
          padding: 0.35rem 0.7rem;
          font-size: 0.8rem;
          font-weight: 600;
          color: var(--accent-secondary);
          background: rgba(59, 130, 246, 0.08);
          border: 1px solid rgba(59, 130, 246, 0.25);
          border-radius: 99px;
        }
        .test-generator-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 1.5rem;
            align-items: start;
            margin-bottom: 1.5rem;
        }
         @media (min-width: 1200px) {
             .test-generator-grid {
                 grid-template-columns: minmax(0, 2.2fr) minmax(280px, 1fr);
             }
         }
        .history-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            padding: 1.25rem;
        }
        .warning-banner {
            background: rgba(245, 158, 11, 0.1);
            border: 1px solid #f59e0b;
            color: #fef3c7;
            padding: 1rem;
            border-radius: var(--radius-md);
            margin-bottom: 1.5rem;
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }
        .hover-opacity-100:hover {
            opacity: 1 !important;
        }
        .hover-text-danger:hover {
            color: #ef4444 !important;
        }
      `}</style>
        </div>
    );
};

export default TestGenerator;
