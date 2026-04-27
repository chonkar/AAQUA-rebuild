import React, { useState, useRef } from 'react';
import RequirementInput from '../components/features/RequirementInput';
import TestCaseTable from '../components/features/TestCaseTable';
import ExportControls from '../components/features/ExportControls';
import { generateTestCases } from '../services/testCaseGenerationService';
import { exportToExcel, exportToJSON } from '../utils/exportUtils';
import { AlertCircle } from 'lucide-react';

const TestGenerator = () => {
    const [testCases, setTestCases] = useState([]);
    const [requirementHistory, setRequirementHistory] = useState([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState(null);
    const abortControllerRef = useRef(null);

    const handleCancel = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsGenerating(false);
        }
    };

    const handleGenerate = async (requirement) => {
        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setIsGenerating(true);
        setError(null);
        try {
            const results = await generateTestCases(requirement, requirementHistory, controller.signal);
            setTestCases(prev => [...prev, ...results]);
            setRequirementHistory(prev => [...prev, requirement]);
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

    const handleExportExcel = () => exportToExcel(testCases, 'Functional_Test_Cases', 'Test Cases');
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
                    <ExportControls
                        onExportExcel={handleExportExcel}
                        onExportJSON={handleExportJSON}
                        disabled={isGenerating}
                    />
                    <TestCaseTable testCases={testCases} />
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
      `}</style>
        </div>
    );
};

export default TestGenerator;
