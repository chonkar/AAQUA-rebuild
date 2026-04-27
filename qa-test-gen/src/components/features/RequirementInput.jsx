import React, { useState } from 'react';
import { Sparkles, Loader2, RotateCcw } from 'lucide-react';

const RequirementInput = ({ onGenerate, isGenerating, onCancel, contextCount = 0, onClearContext }) => {
    const [requirement, setRequirement] = useState('');

    const handleSubmit = () => {
        if (!requirement.trim()) return;
        onGenerate(requirement);
    };

    return (
        <div className="input-section animate-fade-in">
            <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '0.75rem' }}>
                    <label className="input-label" style={{ marginBottom: 0 }}>Describe your feature or requirement</label>
                    {contextCount > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', paddingBottom: '0.2rem' }}>
                            <span style={{ fontSize: '0.75rem', background: 'rgba(59, 130, 246, 0.1)', color: '#60a5fa', padding: '0.2rem 0.6rem', borderRadius: '1rem', border: '1px solid rgba(59, 130, 246, 0.3)' }}>
                                Context: {contextCount} previous
                            </span>
                            <button onClick={onClearContext} title="Start clean with no context" style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '0.75rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', padding: 0 }} className="hover-text-white">
                                <RotateCcw size={12} />
                                Clear
                            </button>
                        </div>
                    )}
                </div>
                <textarea
                    className="input-field textarea-premium"
                    placeholder="e.g. Create a login page with email validation, 'Forgot Password' link, and Google SSO integration..."
                    value={requirement}
                    onChange={(e) => setRequirement(e.target.value)}
                    rows={6}
                    disabled={isGenerating}
                />

                <div className="btn-group" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flex: 1 }}>
                    <button
                        className="btn btn-primary"
                        onClick={handleSubmit}
                        disabled={isGenerating || !requirement.trim()}
                    >
                        {isGenerating ? (
                            <>
                                <Loader2 className="spin" size={20} />
                                Analyzing & Generating...
                            </>
                        ) : (
                            <>
                                <Sparkles size={20} />
                                Generate Test Cases
                            </>
                        )}
                    </button>
                    {isGenerating && (
                        <button
                            className="btn btn-danger"
                            onClick={onCancel}
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
                            <span>Cancel</span>
                        </button>
                    )}
                </div>
            </div>


            <style>{`
        .input-label {
          display: block;
          margin-bottom: 0.75rem;
          font-weight: 600;
          color: var(--text-secondary);
          font-size: 0.9rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        
        .textarea-premium {
          resize: vertical;
          min-height: 120px;
          font-size: 1rem;
          line-height: 1.6;
          background: rgba(0, 0, 0, 0.2);
        }
        
        .action-row {
          margin-top: 1.5rem;
          display: flex;
          justify-content: flex-end;
        }
        
        .spin {
          animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
        </div>
    );
};

export default RequirementInput;
