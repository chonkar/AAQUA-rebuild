import React from 'react';
import { Bug, Loader2, CheckCircle, XCircle, ExternalLink } from 'lucide-react';

// Inline "Log JIRA Ticket" button used on issue cards across the app
// (Accessibility, Localization, future Security raw findings, etc.).
// Accepts a per-issue state slice and click handler — the parent owns
// the state map keyed by whatever issue-id scheme fits its data shape.
//
// state shape: { status: 'idle'|'logging'|'logged'|'error', key?, url?, error? }
const JiraDefectButton = ({ state, onClick }) => {
    if (state?.status === 'logged') {
        return (
            <a
                className="jira-defect-btn jira-defect-btn--logged"
                href={state.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open JIRA ticket in a new tab"
            >
                <CheckCircle size={14} /> Logged as {state.key}
                <ExternalLink size={12} style={{ marginLeft: '4px' }} />
            </a>
        );
    }
    if (state?.status === 'error') {
        return (
            <button
                type="button"
                className="jira-defect-btn jira-defect-btn--error"
                onClick={onClick}
                title={state.error}
            >
                <XCircle size={14} /> Retry — {state.error?.slice(0, 60) || 'Failed'}
            </button>
        );
    }
    const isLogging = state?.status === 'logging';
    return (
        <button
            type="button"
            className="jira-defect-btn"
            onClick={onClick}
            disabled={isLogging}
            title="Raise a JIRA Bug for this issue using your configured JIRA credentials"
        >
            {isLogging ? <Loader2 size={14} className="spin" /> : <Bug size={14} />}
            {isLogging ? 'Logging…' : 'Log JIRA Ticket'}
        </button>
    );
};

export default JiraDefectButton;
