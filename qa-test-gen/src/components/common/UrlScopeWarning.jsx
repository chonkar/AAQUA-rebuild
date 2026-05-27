import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';

// Phase 4 (warn mode): flags when a URL-driven service is pointed at an origin
// outside the active project's bound `target_url`. Third-party integrations
// legitimately use other origins, so this NEVER blocks — it only confirms the
// choice is intentional. Renders nothing when there's no project, no URL, no
// bound target_url, or the origins match.
const originOf = (u) => {
  try { return new URL(u).origin; } catch { return null; }
};

const UrlScopeWarning = ({ url }) => {
  const { selectedProject } = useProject();
  const target = selectedProject?.target_url;
  const entered = (url || '').trim();
  if (!target || !entered) return null;

  const enteredOrigin = originOf(entered);
  const targetOrigin = originOf(target);
  if (!enteredOrigin || !targetOrigin || enteredOrigin === targetOrigin) return null;

  return (
    <div className="url-scope-warning" role="status">
      <AlertTriangle size={15} />
      <span>
        This URL is outside the project&rsquo;s bound app (<strong>{targetOrigin}</strong>).
        That&rsquo;s fine for third-party integrations &mdash; just confirming it&rsquo;s intentional.
      </span>
      <style>{`
        .url-scope-warning {
          display: flex; align-items: flex-start; gap: 0.5rem;
          margin-top: 0.5rem; padding: 0.6rem 0.8rem;
          font-size: 0.8rem; line-height: 1.4;
          color: #f59e0b;
          background: rgba(245, 158, 11, 0.08);
          border: 1px solid rgba(245, 158, 11, 0.3);
          border-radius: var(--radius-md);
        }
        .url-scope-warning svg { flex-shrink: 0; margin-top: 1px; }
        .url-scope-warning strong { color: var(--text-primary); }
      `}</style>
    </div>
  );
};

export default UrlScopeWarning;
