import React, { useState } from 'react';
import { Upload, FileText, Check, AlertCircle, Loader2, Download, Code } from 'lucide-react';
import { convertProject } from '../services/migrationService';

const TestConverter = () => {
    const [file, setFile] = useState(null);
    const [targetFramework, setTargetFramework] = useState('Playwright');
    const [isConverting, setIsConverting] = useState(false);
    const [error, setError] = useState(null);
    const [status, setStatus] = useState('');
    const [downloadUrl, setDownloadUrl] = useState(null);
    const [progress, setProgress] = useState(0);
    const [progressDetail, setProgressDetail] = useState('');

    const handleFileChange = (e) => {
        const selectedFile = e.target.files[0];
        if (selectedFile && (selectedFile.name.endsWith('.zip') || selectedFile.type.includes('zip'))) {
            setFile(selectedFile);
            setError(null);
            setDownloadUrl(null);
        } else {
            setError("Please upload a valid .zip file.");
        }
    };

    const handleConvert = async () => {
        if (!file) return;

        setIsConverting(true);
        setError(null);
        setProgress(0);
        setProgressDetail('');
        setStatus("Uploading and analyzing project...");

        const formData = new FormData();
        formData.append('projectZip', file);
        formData.append('targetFramework', targetFramework);

        const apiKey = import.meta.env.VITE_LLM_API_KEY;
        if (!apiKey) {
            setError("API Key not found. Please check your .env file.");
            setIsConverting(false);
            return;
        }

        // Simulate progress updates
        const progressInterval = setInterval(() => {
            setProgress(prev => {
                if (prev >= 90) return prev; // Cap at 90% until complete
                return prev + Math.random() * 15;
            });
        }, 1500);

        try {
            setProgress(10);
            setProgressDetail('Extracting files...');

            const responseBlob = await convertProject(file, targetFramework, apiKey);

            clearInterval(progressInterval);
            setProgress(95);
            setProgressDetail('Finalizing...');
            setStatus("Conversion complete! Downloading...");

            const url = window.URL.createObjectURL(responseBlob);
            setDownloadUrl(url);

            setProgress(100);
            setProgressDetail('Done!');

            // Auto download
            const a = document.createElement('a');
            a.href = url;
            a.download = `converted_${targetFramework.toLowerCase()}.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();

        } catch (err) {
            clearInterval(progressInterval);
            setError(err.message);
            setProgress(0);
        } finally {
            clearInterval(progressInterval);
            setIsConverting(false);
            setTimeout(() => {
                setStatus('');
                setProgressDetail('');
            }, 2000);
        }
    };

    return (
        <div className="test-converter animate-fade-in">
            <div className="page-header">
                <h2>Selenium Migration Service</h2>
                <p>Modernize your legacy test suite. Convert Selenium projects to Playwright or Cypress using AI.</p>
            </div>

            <div className="converter-card">
                <div className="upload-section">
                    <label className="upload-box">
                        <input
                            type="file"
                            accept=".zip"
                            onChange={handleFileChange}
                            hidden
                            disabled={isConverting}
                        />
                        {file ? (
                            <div className="file-info animate-fade-in">
                                <FileText size={48} className="text-accent" />
                                <p className="file-name">{file.name}</p>
                                <p className="file-size">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                                <span className="change-btn">Click to change</span>
                            </div>
                        ) : (
                            <div className="upload-placeholder">
                                <Upload size={48} className="text-muted" />
                                <p>Drag & Drop your Selenium Project (.zip)</p>
                                <span className="btn btn-secondary">Browse Files</span>
                            </div>
                        )}
                    </label>
                </div>

                <div className="settings-section">
                    <h3>Target Framework</h3>
                    <div className="framework-options">
                        <label className={`framework-card ${targetFramework === 'Playwright' ? 'active' : ''}`}>
                            <input
                                type="radio"
                                name="framework"
                                value="Playwright"
                                checked={targetFramework === 'Playwright'}
                                onChange={(e) => setTargetFramework(e.target.value)}
                            />
                            <div className="fw-icon playwright">P</div>
                            <div className="fw-details">
                                <span className="fw-name">Playwright</span>
                                <span className="fw-desc">Fast, reliable, modern.</span>
                            </div>
                            {targetFramework === 'Playwright' && <Check size={18} className="check-icon" />}
                        </label>

                        <label className={`framework-card ${targetFramework === 'Cypress' ? 'active' : ''}`}>
                            <input
                                type="radio"
                                name="framework"
                                value="Cypress"
                                checked={targetFramework === 'Cypress'}
                                onChange={(e) => setTargetFramework(e.target.value)}
                            />
                            <div className="fw-icon cypress">C</div>
                            <div className="fw-details">
                                <span className="fw-name">Cypress</span>
                                <span className="fw-desc">Developer-friendly, simple.</span>
                            </div>
                            {targetFramework === 'Cypress' && <Check size={18} className="check-icon" />}
                        </label>
                    </div>
                </div>

                <div className="action-section">
                    <button
                        className="btn btn-primary btn-lg full-width"
                        onClick={handleConvert}
                        disabled={!file || isConverting}
                    >
                        {isConverting ? (
                            <>
                                <Loader2 className="spin" size={20} />
                                {status || 'Processing...'}
                            </>
                        ) : (
                            file ? (
                                <>
                                    <Code size={20} />
                                    Convert to {targetFramework}
                                </>
                            ) : (
                                "Select a File to Start"
                            )
                        )}
                    </button>

                    {isConverting && progress > 0 && (
                        <div className="progress-container animate-fade-in">
                            <div className="progress-header">
                                <span className="progress-label">{progressDetail || 'Converting files...'}</span>
                                <span className="progress-percentage">{Math.round(progress)}%</span>
                            </div>
                            <div className="progress-bar">
                                <div
                                    className="progress-fill"
                                    style={{ width: `${progress}%` }}
                                ></div>
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="error-banner animate-fade-in">
                            <AlertCircle size={20} />
                            <span>{error}</span>
                        </div>
                    )}

                    {downloadUrl && !isConverting && (
                        <div className="success-banner animate-fade-in">
                            <Check size={20} />
                            <span>Conversion successful! Download started.</span>
                            <a href={downloadUrl} download={`converted_${targetFramework.toLowerCase()}.zip`} className="download-link">
                                Download again
                            </a>
                        </div>
                    )}
                </div>
            </div>

            <style>{`
                .test-converter { max-width: 900px; margin: 0 auto; }
                .page-header { margin-bottom: 2rem; }
                .page-header h2 { font-size: 1.75rem; margin-bottom: 0.5rem; }
                .page-header p { color: var(--text-secondary); }

                .converter-card {
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-lg);
                    padding: 2rem;
                    box-shadow: var(--shadow-lg);
                }

                .upload-section { margin-bottom: 2rem; }
                .upload-box {
                    border: 2px dashed var(--border-color);
                    border-radius: var(--radius-md);
                    padding: 3rem;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    cursor: pointer;
                    transition: all 0.2s;
                    background: rgba(255, 255, 255, 0.01);
                    min-height: 250px;
                }
                .upload-box:hover {
                    border-color: var(--accent-primary);
                    background: rgba(109, 40, 217, 0.05);
                }
                
                .upload-placeholder {
                    text-align: center;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 1rem;
                    color: var(--text-secondary);
                }
                .text-muted { color: var(--text-muted); }
                .text-accent { color: var(--accent-primary); }

                .file-info {
                    text-align: center;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                }
                .file-name { font-weight: 600; font-size: 1.1rem; margin: 0.5rem 0 0.25rem 0; }
                .file-size { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem; }
                .change-btn { font-size: 0.85rem; color: var(--accent-secondary); text-decoration: underline; }

                .settings-section { margin-bottom: 2rem; }
                .settings-section h3 { font-size: 1rem; margin-bottom: 1rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1px; }

                .framework-options {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 1rem;
                }

                .framework-card {
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-md);
                    padding: 1rem;
                    display: flex;
                    align-items: center;
                    gap: 1rem;
                    cursor: pointer;
                    transition: all 0.2s;
                    position: relative;
                }
                .framework-card input { display: none; }
                .framework-card.active {
                    background: rgba(109, 40, 217, 0.1);
                    border-color: var(--accent-primary);
                }

                .fw-icon {
                    width: 40px;
                    height: 40px;
                    border-radius: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: bold;
                    font-size: 1.2rem;
                }
                .fw-icon.playwright { background: #2EAD33; color: white; } /* Playwright Green-ish */
                .fw-icon.cypress { background: #1b1e2e; border: 1px solid #ddd; color: white; } /* Cypress Dark */

                .fw-details { flex: 1; display: flex; flex-direction: column; }
                .fw-name { font-weight: 600; color: var(--text-primary); }
                .fw-desc { font-size: 0.8rem; color: var(--text-secondary); }

                .check-icon { color: var(--accent-primary); }

                .btn-lg { padding: 1rem; font-size: 1.1rem; }
                .full-width { width: 100%; display: flex; justify-content: center; }

                .error-banner {
                    margin-top: 1rem;
                    background: rgba(239, 68, 68, 0.1);
                    border: 1px solid var(--error);
                    color: #fca5a5;
                    padding: 1rem;
                    border-radius: var(--radius-md);
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                }
                
                .success-banner {
                    margin-top: 1rem;
                    background: rgba(16, 185, 129, 0.1);
                    border: 1px solid var(--success);
                    color: #6ee7b7;
                    padding: 1rem;
                    border-radius: var(--radius-md);
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    justify-content: space-between;
                }
                .download-link { color: white; text-decoration: underline; font-weight: 600; font-size: 0.9rem;}

                .progress-container {
                    margin-top: 1.5rem;
                    padding: 1rem;
                    background: var(--bg-tertiary);
                    border-radius: var(--radius-md);
                    border: 1px solid var(--border-color);
                }
                .progress-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 0.75rem;
                }
                .progress-label {
                    font-size: 0.9rem;
                    color: var(--text-secondary);
                    font-weight: 500;
                }
                .progress-percentage {
                    font-size: 0.9rem;
                    color: var(--accent-primary);
                    font-weight: 600;
                }
                .progress-bar {
                    width: 100%;
                    height: 8px;
                    background: var(--bg-primary);
                    border-radius: 10px;
                    overflow: hidden;
                }
                .progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
                    border-radius: 10px;
                    transition: width 0.3s ease;
                }

                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { 100% { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
};

export default TestConverter;
