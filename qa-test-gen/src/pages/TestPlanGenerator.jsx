import React, { useState, useRef } from 'react';
import { generateTestPlan } from '../services/testPlanService';
import { Download, FileText, Loader, AlertCircle } from 'lucide-react';
import { asBlob } from 'html-docx-js-typescript';
import { saveAs } from 'file-saver';

const TestPlanGenerator = () => {
    const [clientName, setClientName] = useState('');
    const [projectName, setProjectName] = useState('');
    const [requirement, setRequirement] = useState('');
    const [generatedPlan, setGeneratedPlan] = useState(null);
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

    const handleGenerate = async () => {
        if (!clientName || !projectName || !requirement) {
            setError("All fields are required.");
            return;
        }

        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setIsGenerating(true);
        setError(null);
        try {
            const planHtml = await generateTestPlan(clientName, projectName, requirement, controller.signal);
            setGeneratedPlan(planHtml);
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

    const handleExportDocx = async () => {
        if (!generatedPlan) return;

        try {
            // Wrap generated HTML in a standard document structure for better conversion
            const fullHtml = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>Test Plan - ${projectName}</title>
                    <style>
                        body { font-family: 'Calibri', sans-serif; line-height: 1.5; color: #333; }
                        h1, h2, h3 { color: #2E4053; }
                        table { border-collapse: collapse; width: 100%; margin: 20px 0; }
                        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                        th { background-color: #f2f2f2; }
                    </style>
                </head>
                <body>
                    <h1 style="text-align: center; color: #1a237e;">Test Plan</h1>
                    <p style="text-align: center; font-size: 1.2em;"><strong>Client:</strong> ${clientName}</p>
                    <p style="text-align: center; font-size: 1.2em;"><strong>Project:</strong> ${projectName}</p>
                    <hr/>
                    ${generatedPlan}
                </body>
                </html>
            `;

            const blob = await asBlob(fullHtml);
            const fileName = `${clientName.replace(/\s+/g, '_')}_TestPlan.docx`;
            saveAs(blob, fileName);
        } catch (err) {
            console.error("Export Error:", err);
            setError("Failed to export document.");
        }
    };

    return (
        <div className="test-plan-generator animate-fade-in">
            <div className="page-header">
                <h2>ISTQB Test Plan Generator</h2>
                <p>Create professional, standard-compliant test strategy documents.</p>
            </div>

            <div className="input-grid">
                <div className="form-group">
                    <label>Client Name</label>
                    <input
                        type="text"
                        className="input-field"
                        value={clientName}
                        onChange={(e) => setClientName(e.target.value)}
                        placeholder="e.g. Acme Corp"
                        disabled={isGenerating}
                    />
                </div>
                <div className="form-group">
                    <label>Project Name</label>
                    <input
                        type="text"
                        className="input-field"
                        value={projectName}
                        onChange={(e) => setProjectName(e.target.value)}
                        placeholder="e.g. E-Commerce Revamp"
                        disabled={isGenerating}
                    />
                </div>
            </div>

            <div className="form-group mb-4">
                <label>Project Requirements / Scope</label>
                <textarea
                    className="input-field textarea"
                    value={requirement}
                    onChange={(e) => setRequirement(e.target.value)}
                    placeholder="Describe the project scope, key features, and objectives..."
                    rows={6}
                    disabled={isGenerating}
                />
            </div>

            <div className="btn-group-action" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', alignItems: 'center' }}>
                <button
                    className="btn btn-primary generate-btn"
                    onClick={handleGenerate}
                    disabled={isGenerating || !requirement}
                    style={{ flex: 1 }}
                >
                    {isGenerating ? (
                        <>
                            <Loader className="spin" size={20} />
                            <span>Generating Plan...</span>
                        </>
                    ) : (
                        <>
                            <FileText size={20} />
                            <span>Generate Test Plan</span>
                        </>
                    )}
                </button>
                {isGenerating && (
                    <button
                        className="btn btn-danger"
                        onClick={handleCancel}
                        title="Cancel Generation"
                        style={{
                            background: 'rgba(239, 68, 68, 0.2)',
                            color: '#fca5a5',
                            border: '1px solid rgba(239, 68, 68, 0.5)',
                            borderRadius: 'var(--radius-md)',
                            padding: '0.75rem 1rem',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem'
                        }}
                    >
                        <AlertCircle size={20} />
                        <span>Cancel</span>
                    </button>
                )}
            </div>

            {error && (
                <div className="error-banner animate-fade-in">
                    <AlertCircle size={20} />
                    <span>{error}</span>
                </div>
            )}

            {generatedPlan && (
                <div className="preview-section animate-fade-in">
                    <div className="preview-header">
                        <h3>Plan Preview</h3>
                        <button className="btn btn-secondary" onClick={handleExportDocx}>
                            <Download size={18} />
                            <span>Download as Word Doc</span>
                        </button>
                    </div>
                    <div className="document-preview">
                        <div dangerouslySetInnerHTML={{ __html: generatedPlan }} />
                    </div>
                </div>
            )}

            <style>{`
                .test-plan-generator {
                    max-width: 1000px;
                    margin: 0 auto;
                }
                .page-header { margin-bottom: 2rem; }
                .page-header h2 { font-size: 1.75rem; margin-bottom: 0.5rem; }
                .page-header p { color: var(--text-secondary); }

                .input-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 1.5rem;
                    margin-bottom: 1.5rem;
                }

                .form-group label {
                    display: block;
                    margin-bottom: 0.5rem;
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                    font-weight: 500;
                }

                .textarea { resize: vertical; min-height: 120px; }
                .mb-4 { margin-bottom: 2rem; }

                .error-banner {
                   background: rgba(239, 68, 68, 0.1);
                   border: 1px solid var(--error);
                   color: #fca5a5;
                   padding: 1rem;
                   border-radius: var(--radius-md);
                   margin-top: 1rem;
                   display: flex;
                   align-items: center;
                   gap: 0.75rem;
                }

                .preview-section {
                    margin-top: 3rem;
                    border-top: 1px solid var(--border-color);
                    padding-top: 2rem;
                }

                .preview-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1.5rem;
                }

                .document-preview {
                    background: white;
                    color: #333;
                    padding: 3rem;
                    border-radius: var(--radius-md);
                    box-shadow: var(--shadow-lg);
                    min-height: 500px;
                }

                /* Override dark mode styles for the document preview explicitly */
                .document-preview h1, .document-preview h2, .document-preview h3, .document-preview p, .document-preview li {
                     color: #333 !important;
                }
                
                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { 100% { transform: rotate(360deg); } }

                @media (max-width: 768px) {
                    .input-grid { grid-template-columns: 1fr; }
                    .document-preview { padding: 1.5rem; }
                }
            `}</style>
        </div>
    );
};

export default TestPlanGenerator;
