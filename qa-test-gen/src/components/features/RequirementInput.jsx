import React, { useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { createApiClient } from '../../utils/apiClient';
import { Sparkles, Loader2, RotateCcw, Database, AlertCircle } from 'lucide-react';

const RequirementInput = ({ onGenerate, isGenerating, onCancel, contextCount = 0, onClearContext }) => {
    const auth = useAuth();
    const api = createApiClient(() => auth.user?.access_token);

    const [sourceType, setSourceType] = useState('manual'); // 'manual' | 'jira'
    const [jiraKey, setJiraKey] = useState('');
    const [requirement, setRequirement] = useState('');
    const [isFetchingJira, setIsFetchingJira] = useState(false);
    const [jiraError, setJiraError] = useState(null);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [businessRules, setBusinessRules] = useState('');
    const [regressionContext, setRegressionContext] = useState('');
    const [techDetails, setTechDetails] = useState('');

    const handleFetchJiraStory = async () => {
        if (!jiraKey.trim()) return;
        setIsFetchingJira(true);
        setJiraError(null);
        try {
            const data = await api.get(`/api/jira/story/${encodeURIComponent(jiraKey.trim())}`);
            if (data?.story?.description) {
                setRequirement(data.story.description);
            } else {
                throw new Error('Jira story fetched, but no description or requirements found in it.');
            }
        } catch (err) {
            console.error('[Jira Fetch Error]', err);
            setJiraError(err.message);
        } finally {
            setIsFetchingJira(false);
        }
    };

    const handleSubmit = () => {
        if (!requirement.trim()) return;
        onGenerate(requirement, businessRules, regressionContext, techDetails);
    };

    return (
        <div className="input-section animate-fade-in">
            <div className="card">
                {/* Source Selector Toggles */}
                <div className="source-selector-tabs" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
                    <button
                        className={`tab-btn ${sourceType === 'manual' ? 'active' : ''}`}
                        onClick={() => setSourceType('manual')}
                        style={{
                            background: sourceType === 'manual' ? 'rgba(109, 40, 217, 0.15)' : 'transparent',
                            color: sourceType === 'manual' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                            border: '1px solid ' + (sourceType === 'manual' ? 'var(--accent-primary)' : 'transparent'),
                            padding: '0.4rem 1rem',
                            borderRadius: 'var(--radius-md)',
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: '0.85rem',
                            transition: 'all 0.2s'
                        }}
                    >
                        📝 Manual Input
                    </button>
                    <button
                        className={`tab-btn ${sourceType === 'jira' ? 'active' : ''}`}
                        onClick={() => setSourceType('jira')}
                        style={{
                            background: sourceType === 'jira' ? 'rgba(109, 40, 217, 0.15)' : 'transparent',
                            color: sourceType === 'jira' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                            border: '1px solid ' + (sourceType === 'jira' ? 'var(--accent-primary)' : 'transparent'),
                            padding: '0.4rem 1rem',
                            borderRadius: 'var(--radius-md)',
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: '0.85rem',
                            transition: 'all 0.2s'
                        }}
                    >
                        🔌 JIRA Story Integration
                    </button>
                </div>

                {/* JIRA Import Workbench */}
                {sourceType === 'jira' && (
                    <div className="jira-workbench animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem', padding: '1rem', background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border-color)' }}>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <input
                                type="text"
                                className="input-field"
                                placeholder="JIRA Issue Key (e.g. QA-123)"
                                value={jiraKey}
                                onChange={(e) => setJiraKey(e.target.value)}
                                disabled={isFetchingJira}
                                style={{ margin: 0, flex: 1 }}
                            />
                            <button
                                className="btn btn-secondary"
                                onClick={handleFetchJiraStory}
                                disabled={isFetchingJira || !jiraKey.trim()}
                                style={{ padding: '0.75rem 1.25rem', whiteSpace: 'nowrap' }}
                            >
                                {isFetchingJira ? (
                                    <>
                                        <Loader2 className="spin" size={16} />
                                        <span>Fetching...</span>
                                    </>
                                ) : (
                                    <span>Fetch Story Description</span>
                                )}
                            </button>
                        </div>
                        {jiraError && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f87171', fontSize: '0.85rem' }}>
                                <AlertCircle size={14} />
                                <span>{jiraError}</span>
                            </div>
                        )}
                    </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '0.75rem' }}>
                    <label className="input-label" style={{ marginBottom: 0 }}>Describe your feature or requirement</label>
                    {contextCount > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', paddingBottom: '0.2rem' }}>
                            <span style={{ fontSize: '0.75rem', background: 'rgba(59, 130, 246, 0.1)', color: '#60a5fa', padding: '0.2rem 0.6rem', borderRadius: '1rem', border: '1px solid rgba(59, 130, 246, 0.3)' }}>
                                Context: {contextCount} previous
                            </span>
                            <button onClick={() => {
                                onClearContext();
                                setRequirement('');
                                setBusinessRules('');
                                setRegressionContext('');
                                setTechDetails('');
                            }} title="Start clean with no context" style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '0.75rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', padding: 0 }} className="hover-text-white">
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

                {/* Advanced Configuration Toggle */}
                <div style={{ margin: '1rem 0' }}>
                    <button
                        type="button"
                        onClick={() => setShowAdvanced(!showAdvanced)}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--accent-secondary)',
                            fontSize: '0.85rem',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            padding: 0,
                            fontWeight: 600
                        }}
                    >
                        <span>{showAdvanced ? '▼' : '▶'} Advanced Context (Business Rules & Regression)</span>
                    </button>
                    
                    {showAdvanced && (
                        <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.75rem', padding: '1rem', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Business Rules & Constraints (Optional)</label>
                                <textarea
                                    className="input-field"
                                    placeholder="e.g. Only manager role can approve request; Max transaction amount is 10000..."
                                    value={businessRules}
                                    onChange={(e) => setBusinessRules(e.target.value)}
                                    rows={2}
                                    disabled={isGenerating}
                                    style={{ margin: 0, fontSize: '0.85rem', background: 'rgba(0,0,0,0.1)' }}
                                />
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Existing Features / Regression Context (Optional)</label>
                                <textarea
                                    className="input-field"
                                    placeholder="e.g. Must integrate with the existing 'Patient Database' module and backward support the user history view..."
                                    value={regressionContext}
                                    onChange={(e) => setRegressionContext(e.target.value)}
                                    rows={2}
                                    disabled={isGenerating}
                                    style={{ margin: 0, fontSize: '0.85rem', background: 'rgba(0,0,0,0.1)' }}
                                />
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Application Behavior & Tech Details (Optional)</label>
                                <textarea
                                    className="input-field"
                                    placeholder="e.g. App is built on OutSystems; Screens reload asynchronously via AJAX; Password requires custom hashing..."
                                    value={techDetails}
                                    onChange={(e) => setTechDetails(e.target.value)}
                                    rows={2}
                                    disabled={isGenerating}
                                    style={{ margin: 0, fontSize: '0.85rem', background: 'rgba(0,0,0,0.1)' }}
                                />
                            </div>
                        </div>
                    )}
                </div>

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
