import React, { useState, useRef } from 'react';
import { generateTestData } from '../services/testDataService';
import { exportToJSON, exportToExcel, exportToCSV } from '../utils/exportUtils';
import { Database, Loader, AlertCircle, Download, Code, FileText, LayoutGrid, XCircle, PieChart } from 'lucide-react';

const StatsChart = ({ stats }) => {
    if (!stats) return null;

    const { fakerCount, llmCount, totalFields } = stats;
    const fakerPercent = totalFields > 0 ? Math.round((fakerCount / totalFields) * 100) : 0;
    const llmPercent = 100 - fakerPercent;

    // SVG parameters
    const size = 160;
    const strokeWidth = 20;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const fakerOffset = circumference - (fakerPercent / 100) * circumference;

    return (
        <div className="stats-card">
            <div className="chart-container">
                <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="donut-chart">
                    <circle
                        cx={size / 2} cy={size / 2} r={radius}
                        fill="transparent"
                        stroke="var(--accent-primary)"
                        strokeWidth={strokeWidth}
                    />
                    <circle
                        cx={size / 2} cy={size / 2} r={radius}
                        fill="transparent"
                        stroke="var(--accent-secondary)"
                        strokeWidth={strokeWidth}
                        strokeDasharray={circumference}
                        strokeDashoffset={fakerOffset}
                        strokeLinecap="round"
                        transform={`rotate(-90 ${size / 2} ${size / 2})`}
                    />
                    <text x="50%" y="54%" textAnchor="middle" dy=".1em" className="chart-text">
                        {fakerPercent}%
                    </text>
                    <text x="50%" y="42%" textAnchor="middle" dy=".1em" className="chart-label">
                        Hybrid
                    </text>
                </svg>
            </div>
            <div className="legend">
                <h4>Generation Source</h4>
                <div className="legend-item">
                    <span className="dot dot-faker"></span>
                    <span className="label">Faker (Hybrid)</span>
                    <span className="value">{fakerCount} fields</span>
                </div>
                <div className="legend-item">
                    <span className="dot dot-llm"></span>
                    <span className="label">LLM Generated</span>
                    <span className="value">{llmCount} fields</span>
                </div>
            </div>
            <style>{`
                .stats-card {
                    display: flex;
                    align-items: center;
                    gap: 2rem;
                    background: var(--bg-secondary);
                    padding: 1.5rem;
                    border-radius: var(--radius-md);
                    border: 1px solid var(--border-color);
                    margin-top: 2rem;
                    animation: fadeIn 0.5s ease-out;
                }
                .donut-chart circle { transition: stroke-dashoffset 1s ease-out; }
                .chart-text { fill: var(--text-primary); font-size: 1.6rem; font-weight: bold; }
                .chart-label { fill: var(--text-secondary); font-size: 0.8rem; text-transform: uppercase; }
                .legend h4 { margin: 0 0 0.75rem 0; font-size: 0.9rem; color: var(--text-secondary); text-transform: uppercase; }
                .legend-item { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; font-size: 0.9rem; }
                .dot { width: 10px; height: 10px; border-radius: 50%; }
                .dot-faker { background: var(--accent-secondary); }
                .dot-llm { background: var(--accent-primary); }
                .label { color: var(--text-primary); flex: 1; }
                .value { color: var(--text-secondary); font-family: monospace; }
                @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
            `}</style>
        </div>
    );
};

const TestDataGenerator = () => {
    const [mode, setMode] = useState('prompt'); // 'prompt' or 'schema'
    const [viewMode, setViewMode] = useState('table'); // 'table' or 'json'
    const [input, setInput] = useState('');
    const [count, setCount] = useState(5);
    const [generatedData, setGeneratedData] = useState(null);
    const [generatedStats, setGeneratedStats] = useState(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState(null);

    const abortControllerRef = useRef(null);

    const handleCountChange = (e) => {
        let val = parseInt(e.target.value);
        if (isNaN(val)) val = 5;
        if (val > 100) val = 100;
        if (val < 1) val = 1;
        setCount(val);
    };

    const handleGenerate = async () => {
        if (!input.trim()) {
            setError("Please enter a description or schema.");
            return;
        }

        // Cancel previous request if any
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        const controller = new AbortController();
        abortControllerRef.current = controller;

        setIsGenerating(true);
        setError(null);
        setGeneratedData(null);
        setGeneratedStats(null);

        try {
            const result = await generateTestData(input, mode, count, controller.signal);
            // Destructure data and stats
            setGeneratedData(result.data);
            setGeneratedStats(result.stats);
        } catch (err) {
            if (err.name === 'AbortError') {
                console.log('Generation cancelled');
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

    const handleCancel = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsGenerating(false);
        }
    };

    const handleExportJSON = () => exportToJSON(generatedData, 'synthetic_data');
    const handleExportExcel = () => exportToExcel(generatedData, 'synthetic_data', 'Test Data');
    const handleExportCSV = () => exportToCSV(generatedData, 'synthetic_data');

    return (
        <div className="test-data-generator animate-fade-in">
            <div className="page-header">
                <h2>Synthetic Test Data Generator</h2>
                <p>Generate realistic datasets using AI + Faker.js hybrid engine.</p>
            </div>

            <div className="mode-toggle">
                <button
                    className={`mode-btn ${mode === 'prompt' ? 'active' : ''}`}
                    onClick={() => setMode('prompt')}
                >
                    <FileText size={18} />
                    <span>Natural Language</span>
                </button>
                <button
                    className={`mode-btn ${mode === 'schema' ? 'active' : ''}`}
                    onClick={() => setMode('schema')}
                >
                    <Code size={18} />
                    <span>JSON Schema</span>
                </button>
            </div>

            <div className="input-section">
                <div className="form-group">
                    <label>
                        {mode === 'prompt' ? 'Describe your data needs:' : 'Paste your JSON Schema:'}
                    </label>
                    <textarea
                        className="input-field textarea"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={mode === 'prompt' ? "e.g., 50 records of ecommerce users with email, name, and purchase history..." : '{\n  "type": "object",\n  "properties": {\n    "id": { "type": "integer" },\n    "name": { "type": "string" }\n  }\n}'}
                        rows={8}
                        disabled={isGenerating}
                    />
                </div>

                <div className="controls-row">
                    <div className="form-group count-group">
                        <label>Count (Max 100)</label>
                        <input
                            type="number"
                            className="input-field"
                            value={count}
                            onChange={handleCountChange}
                            min={1}
                            max={100}
                            disabled={isGenerating}
                        />
                    </div>

                    <div className="btn-group-action">
                        <button
                            className="btn btn-primary generate-btn"
                            onClick={handleGenerate}
                            disabled={isGenerating || !input}
                        >
                            {isGenerating ? (
                                <>
                                    <Loader className="spin" size={20} />
                                    <span>Generating...</span>
                                </>
                            ) : (
                                <>
                                    <Database size={20} />
                                    <span>Generate Data</span>
                                </>
                            )}
                        </button>

                        {isGenerating && (
                            <button
                                className="btn btn-danger cancel-btn"
                                onClick={handleCancel}
                                title="Cancel Operation"
                            >
                                <XCircle size={20} />
                                <span>Cancel</span>
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {error && (
                <div className="error-banner animate-fade-in">
                    <AlertCircle size={20} />
                    <span>{error}</span>
                </div>
            )}

            {generatedData && (
                <>
                    <StatsChart stats={generatedStats} />

                    <div className="results-section animate-fade-in">
                        <div className="results-header">
                            <div className="header-left">
                                <h3>Generated Data ({generatedData.length})</h3>
                                <div className="view-toggles">
                                    <button
                                        className={`icon-btn ${viewMode === 'table' ? 'active' : ''}`}
                                        onClick={() => setViewMode('table')}
                                        title="Table View"
                                    >
                                        <LayoutGrid size={18} />
                                    </button>
                                    <button
                                        className={`icon-btn ${viewMode === 'json' ? 'active' : ''}`}
                                        onClick={() => setViewMode('json')}
                                        title="JSON View"
                                    >
                                        <Code size={18} />
                                    </button>
                                </div>
                            </div>
                            <div className="export-actions">
                                <button className="btn btn-secondary btn-sm" onClick={handleExportJSON}>
                                    <Download size={16} /> JSON
                                </button>
                                <button className="btn btn-secondary btn-sm" onClick={handleExportExcel}>
                                    <Download size={16} /> Excel
                                </button>
                                <button className="btn btn-secondary btn-sm" onClick={handleExportCSV}>
                                    <Download size={16} /> CSV
                                </button>
                            </div>
                        </div>

                        <div className="data-preview">
                            {viewMode === 'json' ? (
                                <pre>{JSON.stringify(generatedData, null, 2)}</pre>
                            ) : (
                                <div className="table-responsive">
                                    <table>
                                        <thead>
                                            <tr>
                                                {(Array.isArray(generatedData) ? generatedData : [generatedData]).length > 0 &&
                                                    Object.keys((Array.isArray(generatedData) ? generatedData : [generatedData])[0] || {}).map(key => (
                                                        <th key={key}>{key}</th>
                                                    ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {(Array.isArray(generatedData) ? generatedData : [generatedData]).map((row, idx) => (
                                                <tr key={idx}>
                                                    {Object.values(row || {}).map((val, i) => (
                                                        <td key={i}>
                                                            {typeof val === 'object' && val !== null ? (
                                                                Array.isArray(val) ? val.map((v, idx) => <div key={idx}>• {typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>) : JSON.stringify(val)
                                                            ) : String(val ?? '')}
                                                        </td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                        </div>
                    </div>
                </>
            )}

            <style>{`
                .test-data-generator { max-width: 1000px; margin: 0 auto; }
                .page-header { margin-bottom: 2rem; }
                .page-header h2 { font-size: 1.75rem; margin-bottom: 0.5rem; }
                .page-header p { color: var(--text-secondary); }

                .mode-toggle {
                    display: flex;
                    gap: 1rem;
                    margin-bottom: 1.5rem;
                    border-bottom: 1px solid var(--border-color);
                    padding-bottom: 1rem;
                }

                .mode-btn {
                    background: none;
                    border: none;
                    color: var(--text-secondary);
                    padding: 0.5rem 1rem;
                    border-radius: var(--radius-sm);
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-weight: 500;
                    transition: all 0.2s;
                }

                .mode-btn.active {
                    background: var(--bg-tertiary);
                    color: var(--accent-primary);
                }

                .textarea { font-family: monospace; font-size: 0.9rem; }
                
                .controls-row {
                    display: flex;
                    align-items: flex-end;
                    gap: 1rem;
                    margin-top: 1rem;
                }

                .count-group { width: 150px; }

                .btn-group-action {
                    display: flex;
                    flex: 1;
                    gap: 0.5rem;
                }

                .generate-btn { flex: 1; }

                .btn-danger {
                    background: rgba(239, 68, 68, 0.2);
                    color: #fca5a5;
                    border: 1px solid rgba(239, 68, 68, 0.5);
                    border-radius: var(--radius-md);
                    padding: 0.75rem 1rem;
                    cursor: pointer;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    transition: all 0.2s;
                }

                .btn-danger:hover {
                    background: rgba(239, 68, 68, 0.3);
                }

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

                .results-section { margin-top: 2rem; } /* Reduced margin for chart */
                
                .results-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1rem;
                }

                .header-left {
                    display: flex;
                    align-items: center;
                    gap: 1.5rem;
                }

                .view-toggles {
                    display: flex;
                    gap: 0.5rem;
                    background: var(--bg-tertiary);
                    padding: 4px;
                    border-radius: var(--radius-sm);
                }

                .icon-btn {
                    background: none;
                    border: none;
                    color: var(--text-secondary);
                    padding: 4px 8px;
                    border-radius: 4px;
                    cursor: pointer;
                }

                .icon-btn.active {
                    background: var(--bg-primary);
                    color: var(--accent-primary);
                    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                }

                .export-actions {
                    display: flex;
                    gap: 0.5rem;
                }

                .btn-sm { padding: 0.5rem 0.75rem; font-size: 0.85rem; }

                .data-preview {
                    background: var(--bg-tertiary);
                    padding: 1.5rem;
                    border-radius: var(--radius-md);
                    overflow-x: auto;
                    max-height: 600px;
                    border: 1px solid var(--border-color);
                }

                .data-preview pre { margin: 0; color: var(--text-primary); font-size: 0.85rem; }

                .table-responsive {
                    overflow-x: auto;
                }

                table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 0.9rem;
                }

                th {
                    text-align: left;
                    padding: 1rem;
                    border-bottom: 2px solid var(--border-color);
                    color: var(--text-secondary);
                    font-weight: 600;
                    white-space: nowrap;
                }

                td {
                    padding: 0.75rem 1rem;
                    border-bottom: 1px solid var(--border-color);
                    color: var(--text-primary);
                }

                tr:last-child td { border-bottom: none; }
                
                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { 100% { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
};

export default TestDataGenerator;
