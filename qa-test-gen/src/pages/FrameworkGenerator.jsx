import React, { useState } from 'react';
import { Download, Layers, Check, AlertCircle, Loader2, Code2, FileCode, Settings } from 'lucide-react';
import { generateFramework } from '../services/frameworkGeneratorService';
import { useProject } from '../context/ProjectContext';

const FrameworkGenerator = () => {
    const { selectedProjectId } = useProject();
    const [projectName, setProjectName] = useState('my-test-framework');
    const [framework, setFramework] = useState('Playwright');
    const [language, setLanguage] = useState('TypeScript');
    const [features, setFeatures] = useState({
        pageObjectModel: true,
        reporting: 'Allure',
        cicd: 'GitHub Actions',
        docker: true,
        parallel: true,
        logging: true,
        cucumber: false,
        apiTesting: false
    });
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState(null);
    const [progress, setProgress] = useState(0);
    const [progressDetail, setProgressDetail] = useState('');

    const frameworkOptions = ['Playwright', 'Cypress', 'Selenium'];
    const languageOptions = {
        'Playwright': ['TypeScript', 'JavaScript'],
        'Cypress': ['TypeScript', 'JavaScript'],
        'Selenium': ['Java', 'Python', 'JavaScript']
    };
    const reportingOptions = ['Allure', 'Extent Reports', 'Mochawesome', 'HTML Reporter'];
    const cicdOptions = ['GitHub Actions', 'Jenkins', 'GitLab CI', 'None'];

    const handleFeatureToggle = (feature) => {
        setFeatures(prev => ({ ...prev, [feature]: !prev[feature] }));
    };

    const handleReportingChange = (value) => {
        setFeatures(prev => ({ ...prev, reporting: value }));
    };

    const handleCICDChange = (value) => {
        setFeatures(prev => ({ ...prev, cicd: value }));
    };

    const handleGenerate = async () => {
        if (!projectName.trim()) {
            setError('Please enter a project name');
            return;
        }

        setIsGenerating(true);
        setError(null);
        setProgress(0);
        setProgressDetail('');

        const progressInterval = setInterval(() => {
            setProgress(prev => {
                if (prev >= 85) return prev;
                return prev + Math.random() * 10;
            });
        }, 800);

        try {
            setProgress(10);
            setProgressDetail('Initializing framework structure...');

            const config = {
                projectName,
                framework,
                language,
                features,
                projectId: selectedProjectId || null
            };
            const blob = await generateFramework(config);
            setProgress(100);
            setProgressDetail('Done!');

            console.log('[Framework] Triggering zip download');
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${projectName}.zip`;
            document.body.appendChild(a);
            a.click();
            
            setTimeout(() => {
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
            }, 5000);

        } catch (err) {
            clearInterval(progressInterval);
            setError(err.message);
            setProgress(0);
        } finally {
            clearInterval(progressInterval);
            setIsGenerating(false);
            setTimeout(() => {
                setProgressDetail('');
            }, 2000);
        }
    };

    return (
        <div className="framework-generator animate-fade-in">
            <div className="page-header">
                <h2>Framework Generator</h2>
                <p>Generate enterprise-grade test automation frameworks with best practices built-in.</p>
            </div>

            <div className="generator-container">
                <div className="config-panel">
                    <div className="config-section">
                        <h3><Settings size={18} /> Project Configuration</h3>

                        <div className="form-group">
                            <label>Project Name</label>
                            <input
                                type="text"
                                className="form-input"
                                value={projectName}
                                onChange={(e) => setProjectName(e.target.value)}
                                placeholder="my-test-framework"
                                disabled={isGenerating}
                            />
                        </div>

                        <div className="form-group">
                            <label>Framework</label>
                            <select
                                className="form-select"
                                value={framework}
                                onChange={(e) => {
                                    setFramework(e.target.value);
                                    setLanguage(languageOptions[e.target.value][0]);
                                }}
                                disabled={isGenerating}
                            >
                                {frameworkOptions.map(fw => (
                                    <option key={fw} value={fw}>{fw}</option>
                                ))}
                            </select>
                        </div>

                        <div className="form-group">
                            <label>Language</label>
                            <select
                                className="form-select"
                                value={language}
                                onChange={(e) => setLanguage(e.target.value)}
                                disabled={isGenerating}
                            >
                                {languageOptions[framework].map(lang => (
                                    <option key={lang} value={lang}>{lang}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="config-section">
                        <h3><Code2 size={18} /> Features</h3>

                        <label className="checkbox-label">
                            <input
                                type="checkbox"
                                checked={features.pageObjectModel}
                                onChange={() => handleFeatureToggle('pageObjectModel')}
                                disabled={isGenerating}
                            />
                            <span>Page Object Model (POM)</span>
                        </label>

                        <div className="form-group">
                            <label>Reporting</label>
                            <select
                                className="form-select"
                                value={features.reporting}
                                onChange={(e) => handleReportingChange(e.target.value)}
                                disabled={isGenerating}
                            >
                                {reportingOptions.map(opt => (
                                    <option key={opt} value={opt}>{opt}</option>
                                ))}
                            </select>
                        </div>

                        <label className="checkbox-label">
                            <input
                                type="checkbox"
                                checked={features.logging}
                                onChange={() => handleFeatureToggle('logging')}
                                disabled={isGenerating}
                            />
                            <span>Advanced Logging (Winston/Log4j)</span>
                        </label>

                        <div className="form-group">
                            <label>CI/CD</label>
                            <select
                                className="form-select"
                                value={features.cicd}
                                onChange={(e) => handleCICDChange(e.target.value)}
                                disabled={isGenerating}
                            >
                                {cicdOptions.map(opt => (
                                    <option key={opt} value={opt}>{opt}</option>
                                ))}
                            </select>
                        </div>

                        <label className="checkbox-label">
                            <input
                                type="checkbox"
                                checked={features.docker}
                                onChange={() => handleFeatureToggle('docker')}
                                disabled={isGenerating}
                            />
                            <span>Docker Support</span>
                        </label>

                        <label className="checkbox-label">
                            <input
                                type="checkbox"
                                checked={features.parallel}
                                onChange={() => handleFeatureToggle('parallel')}
                                disabled={isGenerating}
                            />
                            <span>Parallel Execution</span>
                        </label>

                        <label className="checkbox-label" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem', marginTop: '1rem' }}>
                            <input
                                type="checkbox"
                                checked={features.apiTesting}
                                onChange={() => handleFeatureToggle('apiTesting')}
                                disabled={isGenerating}
                            />
                            <span style={{ color: 'var(--accent-secondary)', fontWeight: '600' }}>🌐 Include API Testing Support</span>
                        </label>

                        {framework === 'Selenium' && language === 'Java' && (
                            <label className="checkbox-label" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem', marginTop: '1rem' }}>
                                <input
                                    type="checkbox"
                                    checked={features.cucumber}
                                    onChange={() => handleFeatureToggle('cucumber')}
                                    disabled={isGenerating}
                                />
                                <span style={{ color: 'var(--accent-primary)', fontWeight: '600' }}>✨ Enable Cucumber BDD</span>
                            </label>
                        )}
                    </div>

                    <button
                        className="btn btn-primary btn-lg full-width"
                        onClick={handleGenerate}
                        disabled={isGenerating || !projectName.trim()}
                    >
                        {isGenerating ? (
                            <>
                                <Loader2 className="spin" size={20} />
                                Generating...
                            </>
                        ) : (
                            <>
                                <Layers size={20} />
                                Generate Framework
                            </>
                        )}
                    </button>

                    {isGenerating && progress > 0 && (
                        <div className="progress-container animate-fade-in">
                            <div className="progress-header">
                                <span className="progress-label">{progressDetail || 'Generating...'}</span>
                                <span className="progress-percentage">{Math.round(progress)}%</span>
                            </div>
                            <div className="progress-bar">
                                <div className="progress-fill" style={{ width: `${progress}%` }}></div>
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="error-banner animate-fade-in">
                            <AlertCircle size={20} />
                            <span>{error}</span>
                        </div>
                    )}
                </div>

                <div className="preview-panel">
                    <h3><FileCode size={18} /> Framework Preview</h3>
                    <div className="folder-structure">
                        <div className="folder-item">📁 {projectName}/</div>
                        {language === 'Java' ? (
                            <>
                                <div className="folder-item indent-1">📁 src/</div>
                                <div className="folder-item indent-2">📁 main/java/com/test/{projectName.replace(/-/g, '')}/</div>
                                {features.pageObjectModel && (
                                    <>
                                        <div className="folder-item indent-3">📁 pages/</div>
                                        <div className="folder-item indent-4">📄 BasePage.java</div>
                                        <div className="folder-item indent-4">📄 LoginPage.java</div>
                                    </>
                                )}
                                <div className="folder-item indent-2">📁 test/java/com/test/{projectName.replace(/-/g, '')}/</div>
                                {features.cucumber ? (
                                    <>
                                        <div className="folder-item indent-3">📁 runners/</div>
                                        <div className="folder-item indent-4">📄 CucumberTestRunner.java</div>
                                        <div className="folder-item indent-3">📁 stepdefinitions/</div>
                                        <div className="folder-item indent-4">📄 LoginStepDefinitions.java</div>
                                        <div className="folder-item indent-2">📁 test/resources/features/</div>
                                        <div className="folder-item indent-3">📄 login.feature</div>
                                    </>
                                ) : (
                                    <>
                                        <div className="folder-item indent-3">📁 tests/</div>
                                        <div className="folder-item indent-4">📄 LoginTest.java</div>
                                        {features.apiTesting && (
                                            <>
                                                <div className="folder-item indent-3">📁 api/</div>
                                                <div className="folder-item indent-4">📄 ApiBaseTest.java</div>
                                                <div className="folder-item indent-4">📄 UsersApiTest.java</div>
                                            </>
                                        )}
                                    </>
                                )}
                                <div className="folder-item indent-3">📁 utils/</div>
                                <div className="folder-item indent-4">📄 DriverManager.java</div>
                            </>
                        ) : (
                            <>
                                <div className="folder-item indent-1">📁 src/</div>
                                {features.pageObjectModel && (
                                    <>
                                        <div className="folder-item indent-2">📁 pages/</div>
                                        <div className="folder-item indent-3">📄 BasePage.{language === 'TypeScript' ? 'ts' : 'py'}</div>
                                        <div className="folder-item indent-3">📄 LoginPage.{language === 'TypeScript' ? 'ts' : 'py'}</div>
                                    </>
                                )}
                                <div className="folder-item indent-2">📁 tests/</div>
                                {features.apiTesting && (
                                    <>
                                        <div className="folder-item indent-3">📁 api/</div>
                                        <div className="folder-item indent-4">📄 users.spec.{language === 'TypeScript' ? 'ts' : 'js'}</div>
                                    </>
                                )}
                                <div className="folder-item indent-3">📄 login.spec.{language === 'TypeScript' ? 'ts' : 'js'}</div>
                                <div className="folder-item indent-2">📁 utils/</div>
                                {features.logging && (
                                    <div className="folder-item indent-3">📄 logger.{language === 'TypeScript' ? 'ts' : 'js'}</div>
                                )}
                                <div className="folder-item indent-3">📄 helpers.{language === 'TypeScript' ? 'ts' : 'js'}</div>
                                {features.reporting && (
                                    <>
                                        <div className="folder-item indent-1">📁 reports/</div>
                                        <div className="folder-item indent-2">📄 {features.reporting.toLowerCase()}-config</div>
                                    </>
                                )}
                            </>
                        )}
                        {features.cicd !== 'None' && (
                            <>
                                <div className="folder-item indent-1">📁 .github/workflows/</div>
                                <div className="folder-item indent-2">📄 test.yml</div>
                            </>
                        )}
                        {features.docker && (
                            <div className="folder-item indent-1">📄 Dockerfile</div>
                        )}
                        {language === 'Java' ? (
                            <>
                                <div className="folder-item indent-1">📄 pom.xml</div>
                                {features.logging && <div className="folder-item indent-3">📄 log4j2.xml (in src/main/resources)</div>}
                            </>
                        ) : language === 'Python' ? (
                            <div className="folder-item indent-1">📄 requirements.txt</div>
                        ) : (
                            <div className="folder-item indent-1">📄 package.json</div>
                        )}
                        <div className="folder-item indent-1">📄 README.md</div>
                    </div>

                    <div className="features-summary">
                        <h4>Included Features:</h4>
                        <ul>
                            {features.pageObjectModel && <li><Check size={14} /> Page Object Model</li>}
                            {features.reporting && <li><Check size={14} /> {features.reporting} Reporting</li>}
                            {features.logging && <li><Check size={14} /> Advanced Logging</li>}
                            {features.cicd !== 'None' && <li><Check size={14} /> {features.cicd} Pipeline</li>}
                            {features.docker && <li><Check size={14} /> Docker Support</li>}
                            {features.parallel && <li><Check size={14} /> Parallel Execution</li>}
                            {features.cucumber && <li><Check size={14} /> Cucumber BDD Framework</li>}
                            {features.apiTesting && <li><Check size={14} /> API Testing Support</li>}
                        </ul>
                    </div>
                </div>
            </div>

            <style>{`
                .framework-generator { max-width: 1200px; margin: 0 auto; }
                .page-header { margin-bottom: 2rem; }
                .page-header h2 { font-size: 1.75rem; margin-bottom: 0.5rem; }
                .page-header p { color: var(--text-secondary); }

                .generator-container {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 2rem;
                }

                .config-panel, .preview-panel {
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-lg);
                    padding: 2rem;
                    box-shadow: var(--shadow-lg);
                }

                .config-section {
                    margin-bottom: 2rem;
                    padding-bottom: 2rem;
                    border-bottom: 1px solid var(--border-color);
                }
                .config-section:last-of-type { border-bottom: none; }
                .config-section h3 {
                    font-size: 1rem;
                    margin-bottom: 1.25rem;
                    color: var(--text-primary);
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                }

                .form-group {
                    margin-bottom: 1.25rem;
                }
                .form-group label {
                    display: block;
                    font-size: 0.9rem;
                    color: var(--text-secondary);
                    margin-bottom: 0.5rem;
                    font-weight: 500;
                }
                .form-input, .form-select {
                    width: 100%;
                    padding: 0.75rem;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-md);
                    color: var(--text-primary);
                    font-size: 0.95rem;
                    transition: all 0.2s;
                }
                .form-input:focus, .form-select:focus {
                    outline: none;
                    border-color: var(--accent-primary);
                    background: var(--bg-secondary);
                }

                .checkbox-label {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    margin-bottom: 1rem;
                    cursor: pointer;
                    color: var(--text-primary);
                }
                .checkbox-label input[type="checkbox"] {
                    width: 18px;
                    height: 18px;
                    cursor: pointer;
                }

                .btn-lg { padding: 1rem; font-size: 1.1rem; }
                .full-width { width: 100%; display: flex; justify-content: center; gap: 0.5rem; }

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
                    margin-bottom: 0.75rem;
                }
                .progress-label {
                    font-size: 0.9rem;
                    color: var(--text-secondary);
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
                    transition: width 0.3s ease;
                }

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

                .preview-panel h3 {
                    font-size: 1rem;
                    margin-bottom: 1.5rem;
                    color: var(--text-primary);
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                }

                .folder-structure {
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-md);
                    padding: 1.5rem;
                    font-family: 'Courier New', monospace;
                    font-size: 0.9rem;
                    max-height: 400px;
                    overflow-y: auto;
                    margin-bottom: 1.5rem;
                }
                .folder-item {
                    padding: 0.25rem 0;
                    color: var(--text-secondary);
                }
                .indent-1 { padding-left: 1.5rem; }
                .indent-2 { padding-left: 3rem; }
                .indent-3 { padding-left: 4.5rem; }

                .features-summary {
                    background: rgba(109, 40, 217, 0.05);
                    border: 1px solid var(--accent-primary);
                    border-radius: var(--radius-md);
                    padding: 1.25rem;
                }
                .features-summary h4 {
                    font-size: 0.95rem;
                    margin-bottom: 0.75rem;
                    color: var(--accent-primary);
                }
                .features-summary ul {
                    list-style: none;
                    padding: 0;
                    margin: 0;
                }
                .features-summary li {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.4rem 0;
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                }

                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { 100% { transform: rotate(360deg); } }

                @media (max-width: 968px) {
                    .generator-container {
                        grid-template-columns: 1fr;
                    }
                }
            `}</style>
        </div>
    );
};

export default FrameworkGenerator;
