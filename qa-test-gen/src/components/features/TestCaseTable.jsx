import React from 'react';

const TestCaseTable = ({ testCases }) => {
  if (!testCases || testCases.length === 0) return null;

  return (
    <div className="table-container animate-fade-in" style={{ animationDelay: '0.2s' }}>
      <div className="card table-card">
        <div className="table-header">
          <h3>Generated Test Cases</h3>
          <span className="count-badge">{testCases.length} Cases</span>
        </div>

        <div className="table-responsive">
          <table className="qa-table">
            <thead>
              <tr>
                <th style={{ width: '80px' }}>ID</th>
                <th>Module</th>
                <th>Scenario</th>
                <th>Test Steps</th>
                <th>Expected Result</th>
                <th style={{ width: '100px' }}>Priority</th>
                <th style={{ width: '100px' }}>Type</th>
                <th style={{ width: '100px' }}>Platform</th>
              </tr>
            </thead>
            <tbody>
              {testCases.map((tc, index) => (
                <tr key={tc.id || index}>
                  <td className="id-cell">{tc.id}</td>
                  <td><span className="module-tag">{tc.module}</span></td>
                  <td className="scenario-cell">{tc.scenario}</td>
                  <td className="multiline-cell">{tc.steps}</td>
                  <td className="multiline-cell">{tc.expectedResult}</td>
                  <td>
                    <span className={`priority-badge ${tc.priority?.split('-')[0].toLowerCase()}`}>
                      {tc.priority}
                    </span>
                  </td>
                  <td><span className="type-badge">{tc.testType || 'Functional'}</span></td>
                  <td>{tc.platform}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <style>{`
        .table-card {
          padding: 0;
          overflow: hidden;
        }
        
        .table-header {
          padding: 1.5rem;
          border-bottom: 1px solid var(--border-color);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .table-header h3 {
          font-size: 1.25rem;
          font-weight: 600;
        }
        
        .count-badge {
          background: var(--bg-primary);
          padding: 0.25rem 0.75rem;
          border-radius: 20px;
          font-size: 0.85rem;
          color: var(--text-secondary);
          border: 1px solid var(--border-color);
        }
        
        .table-responsive {
          overflow-x: auto;
        }
        
        .qa-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.9rem;
        }
        
        .qa-table th {
          background: var(--bg-tertiary);
          text-align: left;
          padding: 1rem;
          font-weight: 600;
          color: var(--text-secondary);
          white-space: nowrap;
        }
        
        .qa-table td {
          padding: 1rem;
          border-bottom: 1px solid var(--border-color);
          vertical-align: top;
          color: var(--text-primary);
        }
        
        .qa-table tr:last-child td {
          border-bottom: none;
        }
        
        .id-cell {
          font-family: monospace;
          color: var(--text-muted);
        }
        
        .module-tag {
          background: rgba(59, 130, 246, 0.1);
          color: var(--accent-secondary);
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 0.8rem;
        }
        
        .scenario-cell {
          font-weight: 500;
        }
        
        .multiline-cell {
          white-space: pre-wrap;
          line-height: 1.5;
          max-width: 300px;
        }
        
        .priority-badge {
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 0.75rem;
          font-weight: 600;
          text-transform: uppercase;
        }
        
        .priority-badge.high, .priority-badge.p1, .priority-badge.p2 {
          background: rgba(239, 68, 68, 0.15);
          color: #fca5a5;
        }
        
        .priority-badge.medium, .priority-badge.p3 {
          background: rgba(245, 158, 11, 0.15);
          color: #fcd34d;
        }
        
        .priority-badge.low, .priority-badge.p4 {
          background: rgba(16, 185, 129, 0.15);
          color: #6ee7b7;
        }

        .type-badge {
          font-size: 0.75rem;
          color: var(--text-muted);
          border: 1px solid var(--border-color);
          padding: 2px 6px;
          border-radius: 4px;
        }
      `}</style>
    </div>
  );
};

export default TestCaseTable;
