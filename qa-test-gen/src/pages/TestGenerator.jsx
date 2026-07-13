import React, { useState, useRef } from 'react';
import RequirementInput from '../components/features/RequirementInput';
import TestCaseTable from '../components/features/TestCaseTable';
import ExportControls from '../components/features/ExportControls';
import { generateTestCases } from '../services/testCaseGenerationService';
import { exportToExcel, exportToJSON } from '../utils/exportUtils';
import { AlertCircle, Clock } from 'lucide-react';

// Format an elapsed-seconds value as "12.3s" or "1m 05s".
const fmtDuration = (s) => {
    if (s == null) return '';
    if (s >= 60) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
    return `${s.toFixed(1)}s`;
};

const TestGenerator = () => {
    const [testCases, setTestCases] = useState([]);
    const [requirementHistory, setRequirementHistory] = useState([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState(null);
    const [genSeconds, setGenSeconds] = useState(null);
    const [lastBatchCount, setLastBatchCount] = useState(0);
    const abortControllerRef = useRef(null);

    const handleCancel = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsGenerating(false);
        }
    };

    const handleGenerate = async (requirement, businessRules = '', regressionContext = '', techDetails = '') => {
        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setIsGenerating(true);
        setError(null);
        setGenSeconds(null);
        const startedAt = performance.now();
        try {
            const results = await generateTestCases(requirement, requirementHistory, businessRules, regressionContext, techDetails, controller.signal);
            setTestCases(prev => {
                let maxNum = 0;
                prev.forEach(tc => {
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
                return [...prev, ...reindexedResults];
            });
            setRequirementHistory(prev => [...prev, requirement]);
            setLastBatchCount(Array.isArray(results) ? results.length : 0);
            setGenSeconds((performance.now() - startedAt) / 1000);
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

            <RequirementInput
                onGenerate={handleGenerate}
                isGenerating={isGenerating}
                onCancel={handleCancel}
                contextCount={requirementHistory.length}
                onClearContext={() => {
                    setRequirementHistory([]);
                    setTestCases([]);
                }}
            />

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
      `}</style>
        </div>
    );
};

export default TestGenerator;
