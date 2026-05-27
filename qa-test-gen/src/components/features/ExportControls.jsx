import React, { useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { createApiClient } from '../../utils/apiClient';
import { Download, FileJson, FileSpreadsheet, Send, Loader2, CheckCircle } from 'lucide-react';

const ExportControls = ({ onExportExcel, onExportJSON, testCases, disabled }) => {
    const auth = useAuth();
    const api = createApiClient(() => auth.user?.access_token);

    const [jiraKey, setJiraKey] = useState('');
    const [isAttaching, setIsAttaching] = useState(false);
    const [statusMessage, setStatusMessage] = useState(null);
    const [error, setError] = useState(null);

    const handleAttachJira = async () => {
        if (!jiraKey.trim() || !testCases || testCases.length === 0) return;
        setIsAttaching(true);
        setStatusMessage(null);
        setError(null);
        try {
            const data = await api.post(`/api/jira/story/${encodeURIComponent(jiraKey.trim())}/attach`, {
                testCases: testCases
            });
            setStatusMessage(data.message || 'Successfully compiled spreadsheet and uploaded/attached to JIRA Issue!');
        } catch (err) {
            console.error('[Jira Attach Error]', err);
            setError(err.message);
        } finally {
            setIsAttaching(false);
        }
    };

    return (
        <div className="export-controls-container animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
            <div className="export-controls" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                {/* JIRA Story Quick Attachment */}
                <div className="jira-attach-workbench" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flex: 1, minWidth: '300px' }}>
                    <input
                        type="text"
                        className="input-field"
                        placeholder="JIRA Issue Key to attach Excel (e.g. QA-123)"
                        value={jiraKey}
                        onChange={(e) => setJiraKey(e.target.value)}
                        disabled={isAttaching || disabled}
                        style={{ margin: 0, fontSize: '0.85rem', padding: '0.5rem 0.75rem', maxWidth: '280px' }}
                    />
                    <button
                        className="btn btn-secondary"
                        onClick={handleAttachJira}
                        disabled={isAttaching || disabled || !jiraKey.trim()}
                        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                    >
                        {isAttaching ? (
                            <>
                                <Loader2 className="spin" size={16} />
                                <span>Uploading...</span>
                            </>
                        ) : (
                            <>
                                <Send size={16} color="var(--accent-secondary)" />
                                <span>Attach to JIRA</span>
                            </>
                        )}
                    </button>
                </div>

                {/* Legacy Download Actions */}
                <div className="button-group" style={{ display: 'flex', gap: '0.75rem' }}>
                    <button
                        className="btn btn-secondary"
                        onClick={onExportExcel}
                        disabled={disabled || isAttaching}
                        style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                    >
                        <FileSpreadsheet size={16} className="icon-green" />
                        Download Excel
                    </button>
                    <button
                        className="btn btn-secondary"
                        onClick={onExportJSON}
                        disabled={disabled || isAttaching}
                        style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                    >
                        <FileJson size={16} className="icon-yellow" />
                        Download JSON
                    </button>
                </div>
            </div>

            {statusMessage && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#34d399', fontSize: '0.85rem', background: 'rgba(16, 185, 129, 0.1)', padding: '0.5rem 1rem', borderRadius: 'var(--radius-md)', border: '1px solid rgba(16, 185, 129, 0.3)' }} className="animate-fade-in">
                    <CheckCircle size={16} />
                    <span>{statusMessage}</span>
                </div>
            )}
            {error && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f87171', fontSize: '0.85rem', background: 'rgba(239, 68, 68, 0.1)', padding: '0.5rem 1rem', borderRadius: 'var(--radius-md)', border: '1px solid rgba(239, 68, 68, 0.3)' }} className="animate-fade-in">
                    <CheckCircle size={16} style={{ color: '#f87171' }} />
                    <span>{error}</span>
                </div>
            )}

            <style>{`
        .icon-green { color: var(--success); }
        .icon-yellow { color: var(--warning); }
        
        .btn-secondary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
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

export default ExportControls;
