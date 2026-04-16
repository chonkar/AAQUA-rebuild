import React from 'react';
import { Download, FileJson, FileSpreadsheet } from 'lucide-react';

const ExportControls = ({ onExportExcel, onExportJSON, disabled }) => {
    return (
        <div className="export-controls animate-fade-in" style={{ animationDelay: '0.3s' }}>
            <div className="button-group">
                <button
                    className="btn btn-secondary"
                    onClick={onExportExcel}
                    disabled={disabled}
                >
                    <FileSpreadsheet size={18} className="icon-green" />
                    Export to Excel
                </button>
                <button
                    className="btn btn-secondary"
                    onClick={onExportJSON}
                    disabled={disabled}
                >
                    <FileJson size={18} className="icon-yellow" />
                    Export to JSON
                </button>
            </div>

            <style>{`
        .export-controls {
          display: flex;
          justify-content: flex-end;
          margin-bottom: 1rem;
        }
        
        .button-group {
          display: flex;
          gap: 1rem;
        }
        
        .icon-green { color: var(--success); }
        .icon-yellow { color: var(--warning); }
        
        .btn-secondary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
        </div>
    );
};

export default ExportControls;
