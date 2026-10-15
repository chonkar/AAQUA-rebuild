import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from 'react-oidc-context';
import { useProject } from '../context/ProjectContext';
import { 
  Bot, Server, Terminal, Play, Plus, Trash2, Cpu, CheckCircle, 
  AlertTriangle, RefreshCw, Layers, Shield, Sparkles, Send, CircleAlert,
  FileSpreadsheet, Upload, Download, FileText, Eye, Copy, Check, Camera, Monitor,
  BookOpen, ShieldCheck, Radio, Square, MousePointerClick, Info
} from 'lucide-react';
import LiveBrowserViewer from '../components/common/LiveBrowserViewer';

const McpAgentHub = () => {
  const auth = useAuth();
  const { selectedProjectId, selectedProject } = useProject();
  const token = auth.user?.access_token || '';

  // Tab State: 'playground' or 'servers'
  const [activeTab, setActiveTab] = useState('playground');
  
  // Playground mode: 'text' (prompt goal) or 'excel' (run spreadsheet steps)
  const [playgroundMode, setPlaygroundMode] = useState('text');

  // Servers State
  const [servers, setServers] = useState([]);
  const [loadingServers, setLoadingServers] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerUrl, setNewServerUrl] = useState('');
  const [newServerType, setNewServerType] = useState('sse');
  const [addingServer, setAddingServer] = useState(false);

  // Agent State
  const [goal, setGoal] = useState('');
  const [excelFile, setExcelFile] = useState(null);
  const [currentRunId, setCurrentRunId] = useState(null);
  const [agentStatus, setAgentStatus] = useState('idle'); // idle, planned, running, completed, failed
  const [logs, setLogs] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [headedMode, setHeadedMode] = useState(true);
  const [activeConsoleTab, setActiveConsoleTab] = useState('terminal'); // 'terminal' | 'browser'
  const [plannedSteps, setPlannedSteps] = useState([]);
  const [exportingFramework, setExportingFramework] = useState(null);
  const [liveScreenshot, setLiveScreenshot] = useState(null);

  // Preview Modal State
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [previewFramework, setPreviewFramework] = useState('selenium');
  const [previewFiles, setPreviewFiles] = useState([]);
  const [selectedPreviewFileIdx, setSelectedPreviewFileIdx] = useState(0);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [copiedFileIdx, setCopiedFileIdx] = useState(null);

  // Staged learnings state
  const [pendingLearningsList, setPendingLearningsList] = useState([]);
  const [learningsAccepted, setLearningsAccepted] = useState(false);

  // Execution steps and screenshots
  const [executionSteps, setExecutionSteps] = useState([]);
  const [activeScreenshot, setActiveScreenshot] = useState(null);

  // QA Architect 10-Section Deliverable state
  const [showReportModal, setShowReportModal] = useState(false);
  const [architectReport, setArchitectReport] = useState(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [activeReportTab, setActiveReportTab] = useState('workflow');

  const fileInputRef = useRef(null);
  const terminalEndRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const hasAutoOpenedPreviewRef = useRef(false);

  // Live Click-to-Record State
  const [recorderUrl, setRecorderUrl] = useState('https://demoqa.com/automation-practice-form');
  const [recorderMode, setRecorderMode] = useState('smart'); // 'smart' | 'codegen'
  const [recorderDisplayMode, setRecorderDisplayMode] = useState('headed'); // 'headed' | 'vnc'
  const [recorderBrowser, setRecorderBrowser] = useState('chromium');
  const [recorderStatus, setRecorderStatus] = useState('idle'); // 'idle' | 'recording' | 'completed'
  const [recorderSessionId, setRecorderSessionId] = useState(null);
  const [recordedSteps, setRecordedSteps] = useState([]);
  const [recorderDuration, setRecorderDuration] = useState('0s');
  const [recorderStopping, setRecorderStopping] = useState(false);
  const [recorderScreenshot, setRecorderScreenshot] = useState(null);
  const recorderPollIntervalRef = useRef(null);

  // Base API path helper
  const API_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '');

  // Fetch MCP Servers
  const fetchServers = async () => {
    if (!selectedProjectId) return;
    setLoadingServers(true);
    try {
      const res = await fetch(`${API_PREFIX}/api/mcp/servers?projectId=${selectedProjectId}`, {
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        }
      });
      if (!res.ok) throw new Error('Failed to fetch MCP servers');
      const data = await res.json();
      setServers(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingServers(false);
    }
  };

  // Add MCP Server
  const handleAddServer = async (e) => {
    e.preventDefault();
    if (!newServerName || !newServerUrl) return;
    setAddingServer(true);
    try {
      const res = await fetch(`${API_PREFIX}/api/mcp/servers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({
          project_id: selectedProjectId,
          name: newServerName,
          url: newServerUrl,
          type: newServerType,
        }),
      });
      if (!res.ok) throw new Error('Failed to add MCP server');
      
      setNewServerName('');
      setNewServerUrl('');
      setNewServerType('sse');
      setShowAddModal(false);
      fetchServers();
    } catch (err) {
      console.error(err);
    } finally {
      setAddingServer(false);
    }
  };

  // Delete MCP Server
  const handleDeleteServer = async (serverId) => {
    if (!window.confirm('Are you sure you want to remove this MCP server configuration?')) return;
    try {
      const res = await fetch(`${API_PREFIX}/api/mcp/servers/${serverId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        }
      });
      if (!res.ok) throw new Error('Failed to delete server');
      fetchServers();
    } catch (err) {
      console.error(err);
    }
  };

  // Start Prompt-based Agent Run
  const handleStartAgent = async () => {
    if (!goal || !selectedProjectId) return;
    setAgentStatus('running');
    setLogs([]);
    setCursor(0);
    setCurrentRunId(null);
    setLiveScreenshot(null);
    setPlannedSteps([]);
    hasAutoOpenedPreviewRef.current = false;
    setPendingLearningsList([]);
    setLearningsAccepted(false);
    setExecutionSteps([]);
    setActiveScreenshot(null);

    try {
      const res = await fetch(`${API_PREFIX}/api/mcp/agent/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({
          projectId: selectedProjectId,
          goal,
          headed: headedMode,
        }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to start agent execution');
      }
      const data = await res.json();
      setCurrentRunId(data.runId);
      sessionStorage.setItem('aaqua_active_run_id', data.runId);
      setAgentStatus(data.status);
      
      if (data.status === 'planned') {
        setPlannedSteps(data.steps || []);
        setLogs([
          `[INFO] Agent Goal received: "${goal}"`,
          `[INFO] AI Planning completed. Generated ${data.steps ? data.steps.length : 0} steps. Awaiting confirmation...`
        ]);
      } else {
        setLogs([`[INFO] Simulated Agent execution started...`]);
      }
    } catch (err) {
      console.error(err);
      setAgentStatus('failed');
      setLogs([`[ERROR] Failed to initiate agent execution: ${err.message}`]);
    }
  };

  // Human Confirmation to execute steps
  const handleConfirmAgent = async () => {
    if (!currentRunId) return;
    setAgentStatus('running');
    setLogs([`[INFO] Human approval received. Starting execution...`]);
    setCursor(0);
    setLiveScreenshot(null);
    hasAutoOpenedPreviewRef.current = false;

    try {
      if (headedMode) setActiveConsoleTab('browser');
      const res = await fetch(`${API_PREFIX}/api/mcp/agent/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({
          runId: currentRunId,
          headed: headedMode,
        }),
      });
      if (!res.ok) throw new Error('Failed to confirm and execute agent run');
      const data = await res.json();
      // Polling will begin automatically because status changes to 'running'
    } catch (err) {
      console.error(err);
      setAgentStatus('failed');
      setLogs(prev => [...prev, `[ERROR] Failed to execute confirmed run: ${err.message}`]);
    }
  };

  // Convert and Export verified script code as a full project framework ZIP
  const handleExportCode = (framework) => {
    if (!currentRunId) return;
    const filename = framework === 'playwright' ? 'playwright-automation-project.zip' : 'selenium-automation-project.zip';
    const downloadUrl = `${API_PREFIX}/api/mcp/agent/download/${currentRunId}/${filename}`;
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleFetchCodePreview = async (framework) => {
    if (!currentRunId) return;
    setLoadingPreview(true);
    setPreviewFramework(framework);
    setSelectedPreviewFileIdx(0);
    setCopiedFileIdx(null);
    setShowCodeModal(true);
    try {
      const res = await fetch(`${API_PREFIX}/api/mcp/agent/preview-code?runId=${currentRunId}&targetFramework=${framework}`, {
        method: 'GET',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        }
      });
      if (!res.ok) {
        throw new Error('Failed to retrieve code preview');
      }
      const data = await res.json();
      setPreviewFiles(data.files || []);
    } catch (err) {
      console.error(err);
      alert('Failed to retrieve preview: ' + err.message);
      setShowCodeModal(false);
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleFetchArchitectReport = async () => {
    if (!currentRunId) return;
    setLoadingReport(true);
    setShowReportModal(true);
    try {
      const res = await fetch(`${API_PREFIX}/api/mcp/agent/architect-report/${currentRunId}`, {
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        }
      });
      if (!res.ok) throw new Error('Failed to retrieve QA Architect report');
      const data = await res.json();
      setArchitectReport(data);
    } catch (err) {
      console.error(err);
      alert('Failed to load QA Architect report: ' + err.message);
    } finally {
      setLoadingReport(false);
    }
  };

  const handleCancelAgent = async () => {
    if (!currentRunId) {
      setAgentStatus('idle');
      return;
    }
    try {
      setLogs(prev => [...prev, '[CANCEL] Requesting cancellation of active agent task...']);
      const res = await fetch(`${API_PREFIX}/api/mcp/agent/cancel/${currentRunId}`, {
        method: 'POST',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        }
      });
      if (res.ok) {
        setAgentStatus('cancelled');
        setLogs(prev => [...prev, '🛑 [CANCELLED] Operation cancelled by user. Halting execution.']);
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      }
    } catch (err) {
      console.error('Failed to cancel agent run:', err);
      setAgentStatus('cancelled');
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }
  };

  const handleDownloadReport = () => {
    if (!currentRunId) return;
    window.open(`${API_PREFIX}/api/mcp/agent/download-report/${currentRunId}`);
  };

  const handleCopyCode = (code, index) => {
    navigator.clipboard.writeText(code);
    setCopiedFileIdx(index);
    setTimeout(() => setCopiedFileIdx(null), 2000);
  };

  // Start Excel-based Agent Run
  const handleStartExcelAgent = async () => {
    if (!excelFile || !selectedProjectId) return;
    setAgentStatus('running');
    setPlannedSteps([]);
    setLogs([]);
    setCursor(0);
    setCurrentRunId(null);
    setPendingLearningsList([]);
    setLearningsAccepted(false);
    setExecutionSteps([]);
    setActiveScreenshot(null);
    setLiveScreenshot(null);
    hasAutoOpenedPreviewRef.current = false;

    const formData = new FormData();
    formData.append('projectId', selectedProjectId);
    formData.append('excelFile', excelFile);
    formData.append('headed', headedMode);

    try {
      if (headedMode) setActiveConsoleTab('browser');
      const res = await fetch(`${API_PREFIX}/api/mcp/agent/run-excel`, {
        method: 'POST',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        },
        body: formData
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to start Excel agent execution');
      }
      const data = await res.json();
      setCurrentRunId(data.runId);
      sessionStorage.setItem('aaqua_active_run_id', data.runId);
    } catch (err) {
      console.error(err);
      setAgentStatus('failed');
      setLogs([`[ERROR] Failed to initiate Excel agent execution: ${err.message}`]);
    }
  };

  const handleAcceptLearnings = async () => {
    if (!currentRunId) return;
    try {
      const res = await fetch(`${API_PREFIX}/api/mcp/agent/accept/${currentRunId}`, {
        method: 'POST',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        }
      });
      if (!res.ok) throw new Error('Failed to accept staged learnings');
      const data = await res.json();
      setLearningsAccepted(true);
      setLogs(prev => [...prev, `[INFO] ${data.message} Staged records committed: ${data.count}`]);
    } catch (err) {
      console.error(err);
      alert('Failed to accept staged learnings: ' + err.message);
    }
  };

  // Download Sample Template
  const handleDownloadTemplate = async () => {
    try {
      const res = await fetch(`${API_PREFIX}/api/mcp/templates/excel`, {
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        }
      });
      if (!res.ok) throw new Error('Failed to download template');
      const blob = await res.blob();
      
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'aaqua_mcp_test_template.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert('Failed to download template: ' + err.message);
    }
  };

  // Poll Agent Status and Logs
  const pollAgentStatus = async () => {
    if (!currentRunId) return;
    try {
      const res = await fetch(`${API_PREFIX}/api/mcp/agent/status/${currentRunId}?since=${cursor}`, {
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        }
      });
      if (!res.ok) throw new Error('Failed to fetch agent status');
      const data = await res.json();

      setAgentStatus(data.status);
      if (data.logs && data.logs.length > 0) {
        setLogs(prev => [...prev, ...data.logs]);
        setCursor(data.cursor);
      }
      if (data.steps) {
        setExecutionSteps(data.steps);
      }
      if (data.live_screenshot) {
        setLiveScreenshot(data.live_screenshot);
      }

      if (data.pending_learnings) {
        try {
          const parsed = JSON.parse(data.pending_learnings);
          setPendingLearningsList(parsed);
        } catch {
          setPendingLearningsList([]);
        }
      } else {
        setPendingLearningsList([]);
      }

      if (data.status === 'completed') {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
        if (!hasAutoOpenedPreviewRef.current) {
          hasAutoOpenedPreviewRef.current = true;
          // Automatically retrieve and display the POM code preview for Playwright upon completion!
          setTimeout(() => {
            handleFetchCodePreview('playwright');
          }, 800);
        }
      } else if (data.status === 'failed' || data.status === 'cancelled') {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    } catch (err) {
      console.error(err);
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  useEffect(() => {
    if (selectedProjectId) {
      fetchServers();
    }
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, token]);

  // Restore any active or previous run from sessionStorage so refreshing the page never clears operations
  useEffect(() => {
    const savedRunId = sessionStorage.getItem('aaqua_active_run_id');
    if (savedRunId && !currentRunId) {
      setCurrentRunId(savedRunId);
      fetch(`${API_PREFIX}/api/mcp/agent/status/${savedRunId}?since=0`, {
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        }
      })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data) {
            setAgentStatus(data.status);
            if (data.logs && data.logs.length > 0) {
              setLogs(data.logs);
              setCursor(data.cursor);
            }
            if (data.steps && data.steps.length > 0) {
              setExecutionSteps(data.steps);
            }
            if (data.live_screenshot) {
              setLiveScreenshot(data.live_screenshot);
            }
            if (data.pending_learnings) {
              try {
                setPendingLearningsList(JSON.parse(data.pending_learnings));
              } catch {}
            }
            if (data.status === 'completed') {
              hasAutoOpenedPreviewRef.current = true;
            }
          }
        })
        .catch(err => console.error('[Restore Run]', err));
    }
  }, [token]);

  useEffect(() => {
    if (currentRunId && agentStatus === 'running') {
      pollIntervalRef.current = setInterval(pollAgentStatus, 500);
    }
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRunId, cursor, agentStatus]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const selectPrompt = (promptText) => {
    setGoal(promptText);
    setPlaygroundMode('text');
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setExcelFile(e.target.files[0]);
    }
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  // Initialize recorder URL from project if available
  useEffect(() => {
    if (selectedProject?.url) {
      setRecorderUrl(selectedProject.url);
    }
  }, [selectedProject]);

  // Polling for live recorder steps
  useEffect(() => {
    if (recorderSessionId && recorderStatus === 'recording') {
      recorderPollIntervalRef.current = setInterval(async () => {
        try {
          const res = await fetch(`${API_PREFIX}/api/recorder/session/${recorderSessionId}`);
          if (res.ok) {
            const data = await res.json();
            if (data.steps && data.steps.length > 0) {
              setRecordedSteps(data.steps);
            }
            if (data.liveScreenshot) {
              setRecorderScreenshot(data.liveScreenshot);
            }
            if (data.duration) {
              setRecorderDuration(data.duration);
            }
            if (data.status === 'completed') {
              setRecorderStatus('completed');
              clearInterval(recorderPollIntervalRef.current);
            }
          }
        } catch {}
      }, 800);
    }
    return () => {
      if (recorderPollIntervalRef.current) {
        clearInterval(recorderPollIntervalRef.current);
        recorderPollIntervalRef.current = null;
      }
    };
  }, [recorderSessionId, recorderStatus]);

  const handleStartRecorder = async () => {
    try {
      setRecorderStatus('recording');
      setRecordedSteps([]);
      setRecorderScreenshot(null);
      setRecorderDuration('0s');
      const res = await fetch(`${API_PREFIX}/api/recorder/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: recorderUrl || 'https://demoqa.com/automation-practice-form',
          mode: recorderMode,
          browserType: recorderBrowser,
          headed: recorderDisplayMode === 'headed'
        })
      });
      if (!res.ok) throw new Error('Failed to launch recorder');
      const data = await res.json();
      setRecorderSessionId(data.sessionId);
    } catch (err) {
      console.error(err);
      setRecorderStatus('idle');
      alert('Could not start recorder: ' + err.message);
    }
  };

  const handleStopRecorder = async () => {
    if (!recorderSessionId) return;
    setRecorderStopping(true);
    try {
      const res = await fetch(`${API_PREFIX}/api/recorder/stop/${recorderSessionId}`, {
        method: 'POST'
      });
      if (res.ok) {
        const data = await res.json();
        if (data.steps && data.steps.length > 0) {
          setRecordedSteps(data.steps);
        }
        setRecorderStatus('completed');
      }
    } catch (err) {
      console.error(err);
    } finally {
      setRecorderStopping(false);
      if (recorderPollIntervalRef.current) {
        clearInterval(recorderPollIntervalRef.current);
      }
    }
  };

  const handleImportRecordedSteps = () => {
    if (recordedSteps.length === 0) return;
    setPlannedSteps(recordedSteps);
    setGoal(`Interactive User Journey recorded from ${recorderUrl} (${recordedSteps.length} steps)`);
    setPlaygroundMode('text');
    setAgentStatus('planned');
  };

  const handleDownloadRecordedSuite = (framework) => {
    if (!recorderSessionId) return;
    window.location.href = `${API_PREFIX}/api/recorder/download/${recorderSessionId}/${framework}`;
  };

  return (
    <div className="mcp-agent-hub animate-fade-in">
      <div className="hub-header-row">
        <div>
          <h2>Agentic QA & MCP Playground</h2>
          <p className="subtitle">
            Autonomous agent workflows powered by **Model Context Protocol (MCP)** tools.
          </p>
        </div>
        <div className="tab-buttons">
          <button 
            className={`tab-btn ${activeTab === 'playground' ? 'active' : ''}`}
            onClick={() => setActiveTab('playground')}
          >
            <Bot size={16} />
            <span>Agent Sandbox</span>
          </button>
          <button 
            className={`tab-btn ${activeTab === 'servers' ? 'active' : ''}`}
            onClick={() => setActiveTab('servers')}
          >
            <Server size={16} />
            <span>MCP Servers ({servers.length})</span>
          </button>
        </div>
      </div>

      {!selectedProjectId ? (
        <div className="no-project-selected">
          <CircleAlert size={48} />
          <h3>No Project Context Active</h3>
          <p>Please select a project context from the header dropdown to run autonomous agent testing.</p>
        </div>
      ) : (
        <>
          {activeTab === 'playground' && (
            <div className="playground-layout">
              {/* Agent Setup Console */}
              <div className="setup-panel glass-panel">
                <div className="setup-header">
                  <h3>Goal & Context Scopes</h3>
                  <div className="mode-toggle">
                    <button 
                      className={`mode-btn ${playgroundMode === 'text' ? 'active' : ''}`}
                      onClick={() => setPlaygroundMode('text')}
                      disabled={agentStatus === 'running' || recorderStatus === 'recording'}
                    >
                      <FileText size={14} />
                      <span>Text Goal</span>
                    </button>
                    <button 
                      className={`mode-btn ${playgroundMode === 'excel' ? 'active' : ''}`}
                      onClick={() => setPlaygroundMode('excel')}
                      disabled={agentStatus === 'running' || recorderStatus === 'recording'}
                    >
                      <FileSpreadsheet size={14} />
                      <span>Excel Cases</span>
                    </button>
                    <button 
                      className={`mode-btn ${playgroundMode === 'record' ? 'active' : ''}`}
                      onClick={() => setPlaygroundMode('record')}
                      disabled={agentStatus === 'running'}
                      style={recorderStatus === 'recording' ? { borderColor: '#ef4444', color: '#fca5a5' } : {}}
                    >
                      <Radio size={14} style={{ color: recorderStatus === 'recording' ? '#ef4444' : 'inherit' }} />
                      <span>Click-to-Record {recorderStatus === 'recording' ? '●' : ''}</span>
                    </button>
                  </div>
                </div>
                
                <p className="panel-desc">
                  {playgroundMode === 'text' 
                    ? "Define the task you want the Agent to perform. It will scan available files, locate targets, connect to database schemas, and output/heal scripts."
                    : playgroundMode === 'excel'
                    ? "Upload an Excel file containing manual test cases. The Agent will execute browser automation steps step-by-step and write logs."
                    : "Visually click and type on the target application in real time. AAUQA records exact element IDs, labels, and actions without AI guessing."
                  }
                </p>

                {playgroundMode === 'text' ? (
                  agentStatus === 'planned' ? (
                    <div className="plan-review-container">
                      <h4>Planned Agent Execution Checklist</h4>
                      <p className="plan-review-subtitle">
                        Review the steps planned by the AI. Approve to execute them in Playwright.
                      </p>
                      <div className="steps-checklist">
                        {plannedSteps.map((step, idx) => (
                          <div key={idx} className="step-item animate-typewriter">
                            <span className="step-badge">{idx + 1}</span>
                            <div className="step-details">
                              <span className="step-action-name">{step.action}</span>
                              <span className="step-target-name">{step.target || 'N/A'}</span>
                              {step.inputData && <span className="step-input-data">("{step.inputData}")</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="plan-actions">
                        <button
                          className="btn btn-secondary cancel-run-btn"
                          onClick={() => {
                            setAgentStatus('idle');
                            setPlannedSteps([]);
                            setLogs([]);
                            setCurrentRunId(null);
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          className="btn btn-primary approve-run-btn animate-pulse"
                          onClick={handleConfirmAgent}
                        >
                          <Play size={14} />
                          <span>Confirm & Run</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="goal-input-container">
                      <div className="qa-architect-badge-banner" style={{
                        padding: '0.75rem 1rem',
                        background: 'linear-gradient(90deg, rgba(139, 92, 246, 0.15), rgba(59, 130, 246, 0.08))',
                        border: '1px solid rgba(139, 92, 246, 0.3)',
                        borderRadius: 'var(--radius-md)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.75rem'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                          <Sparkles size={16} style={{ color: '#8b5cf6', flexShrink: 0 }} />
                          <div>
                            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                              QA Architect: Discover Once → Generate Once → Execute Many Times
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                              MCP explores enterprise Pega/OutSystems workflows once. Generated Playwright & Selenium POM suites execute independently in CI/CD without AI/MCP.
                            </div>
                          </div>
                        </div>
                        <span style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: '4px', background: 'rgba(139, 92, 246, 0.25)', color: '#c4b5fd', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          CI/CD Ready
                        </span>
                      </div>
                      <textarea
                        placeholder="E.g., Query the database schema, find recent locator mappings in src/utils/locatorUtils.js, and verify we have tests for checkout flows."
                        value={goal}
                        onChange={(e) => setGoal(e.target.value)}
                        disabled={agentStatus === 'running'}
                      />
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button
                          className="btn btn-primary run-btn"
                          style={{ flex: 1 }}
                          onClick={handleStartAgent}
                          disabled={agentStatus === 'running' || !goal.trim()}
                        >
                          {agentStatus === 'running' ? (
                            <>
                              <RefreshCw className="spin" size={16} />
                              <span>Planning...</span>
                            </>
                          ) : (
                            <>
                              <Play size={16} />
                              <span>Run Agent Task</span>
                            </>
                          )}
                        </button>
                        {agentStatus === 'running' && (
                          <button
                            type="button"
                            className="btn btn-danger"
                            style={{
                              padding: '0 1.25rem',
                              background: 'rgba(239, 68, 68, 0.2)',
                              border: '1px solid #ef4444',
                              color: '#fca5a5',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              borderRadius: 'var(--radius-md)',
                              cursor: 'pointer',
                              fontWeight: 600
                            }}
                            onClick={handleCancelAgent}
                          >
                            <CircleAlert size={16} />
                            <span>Cancel</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )
                ) : playgroundMode === 'excel' ? (
                  <div className="excel-input-container">
                    <div className="excel-upload-zone" onClick={triggerFileSelect}>
                      <Upload size={32} className="upload-icon" />
                      {excelFile ? (
                        <div className="file-info">
                          <span className="file-name">{excelFile.name}</span>
                          <span className="file-size">{(excelFile.size / 1024).toFixed(1)} KB</span>
                        </div>
                      ) : (
                        <p>Drag and drop or click to upload your Excel test cases sheet (.xlsx, .xls)</p>
                      )}
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileChange}
                        accept=".xlsx, .xls, .csv"
                        style={{ display: 'none' }}
                        disabled={agentStatus === 'running'}
                      />
                    </div>

                    <div className="excel-actions">
                      <button 
                        className="btn btn-secondary template-btn"
                        onClick={handleDownloadTemplate}
                      >
                        <Download size={14} />
                        <span>Get Template Example</span>
                      </button>
                      <div style={{ display: 'flex', gap: '8px', flex: 1 }}>
                        <button
                          className="btn btn-primary run-btn"
                          style={{ flex: 1 }}
                          onClick={handleStartExcelAgent}
                          disabled={agentStatus === 'running' || !excelFile}
                        >
                          {agentStatus === 'running' ? (
                            <>
                              <RefreshCw className="spin" size={16} />
                              <span>Running Excel...</span>
                            </>
                          ) : (
                            <>
                              <Play size={16} />
                              <span>Run Excel Agent</span>
                            </>
                          )}
                        </button>
                        {agentStatus === 'running' && (
                          <button
                            type="button"
                            className="btn btn-danger"
                            style={{
                              padding: '0 1.25rem',
                              background: 'rgba(239, 68, 68, 0.2)',
                              border: '1px solid #ef4444',
                              color: '#fca5a5',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              borderRadius: 'var(--radius-md)',
                              cursor: 'pointer',
                              fontWeight: 600
                            }}
                            onClick={handleCancelAgent}
                          >
                            <CircleAlert size={16} />
                            <span>Cancel</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="recorder-panel animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {/* Hero Header */}
                    <div className="qa-architect-badge-banner" style={{
                      padding: '0.85rem 1.1rem',
                      background: 'linear-gradient(90deg, rgba(239, 68, 68, 0.15), rgba(139, 92, 246, 0.1))',
                      border: '1px solid rgba(239, 68, 68, 0.35)',
                      borderRadius: 'var(--radius-md)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.75rem'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div style={{
                          width: '32px', height: '32px', borderRadius: '50%',
                          background: 'rgba(239, 68, 68, 0.2)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center'
                        }}>
                          <Radio size={18} style={{ color: '#ef4444' }} />
                        </div>
                        <div>
                          <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                            Interactive Live Recorder: Zero Guesswork, Exact Locators
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            Click, type, and select elements naturally in real time. AAUQA captures exact IDs, resilient XPath, and labels without AI guessing.
                          </div>
                        </div>
                      </div>
                      <span style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: '4px', background: 'rgba(239, 68, 68, 0.25)', color: '#fca5a5', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        Live Interactive
                      </span>
                    </div>

                    {/* URL & Controls */}
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '12px' }}>
                      <div>
                        <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                          Target Application URL
                        </label>
                        <input
                          type="text"
                          className="form-control"
                          placeholder="https://demoqa.com/automation-practice-form"
                          value={recorderUrl}
                          onChange={(e) => setRecorderUrl(e.target.value)}
                          disabled={recorderStatus === 'recording'}
                          style={{ width: '100%', padding: '0.6rem 0.75rem', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)' }}
                        />
                      </div>

                      <div>
                        <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                          Recording Engine
                        </label>
                        <select
                          value={recorderMode}
                          onChange={(e) => setRecorderMode(e.target.value)}
                          disabled={recorderStatus === 'recording'}
                          style={{ width: '100%', padding: '0.6rem 0.75rem', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)' }}
                        >
                          <option value="smart">Live Smart Recorder (Real-time Stream)</option>
                          <option value="codegen">Playwright Codegen (Official Inspector)</option>
                        </select>
                      </div>

                      <div>
                        <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                          Browser & Display Mode
                        </label>
                        <select
                          value={recorderDisplayMode}
                          onChange={(e) => setRecorderDisplayMode(e.target.value)}
                          disabled={recorderStatus === 'recording'}
                          style={{ width: '100%', padding: '0.6rem 0.75rem', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)' }}
                        >
                          <option value="headed">Desktop Window (Local Monitor)</option>
                          <option value="vnc">Virtual Desktop (Server / noVNC Stream)</option>
                        </select>
                      </div>
                    </div>

                    {/* Launch / Stop Button */}
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                      {recorderStatus !== 'recording' ? (
                        <button
                          className="btn btn-primary"
                          onClick={handleStartRecorder}
                          disabled={!recorderUrl.trim()}
                          style={{
                            flex: 1,
                            padding: '0.75rem 1.5rem',
                            background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 50%, #b91c1c 100%)',
                            border: 'none',
                            fontWeight: 700,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px',
                            boxShadow: '0 4px 15px rgba(239, 68, 68, 0.4)'
                          }}
                        >
                          <Radio size={16} />
                          <span>Launch Live Click-to-Record Browser</span>
                        </button>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: 1 }}>
                          <div style={{
                            padding: '0.65rem 0.95rem',
                            borderRadius: 'var(--radius-md)',
                            background: 'rgba(56, 189, 248, 0.1)',
                            border: '1px solid rgba(56, 189, 248, 0.35)',
                            fontSize: '0.8rem',
                            color: '#bae6fd',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px'
                          }}>
                            <Info size={16} style={{ color: '#38bdf8', flexShrink: 0 }} />
                            <span>
                              {recorderMode === 'codegen' ? (
                                <><strong>Playwright Inspector is active!</strong> Interact with the inspector/browser window on your desktop, then click <strong>Stop & Finalize Steps</strong> to convert into test steps.</>
                              ) : recorderDisplayMode === 'headed' ? (
                                <><strong>Desktop Browser is open!</strong> Switch to the opened Chrome window and click/type naturally. Actions will record below live.</>
                              ) : (
                                <><strong>Live Recording is active!</strong> Actions stream below as you interact with the page.</>
                              )}
                            </span>
                          </div>

                          <div style={{ display: 'flex', gap: '10px', flex: 1 }}>
                            <div style={{
                              flex: 1,
                              display: 'flex',
                              alignItems: 'center',
                              gap: '12px',
                              padding: '0.6rem 1rem',
                              background: 'rgba(239, 68, 68, 0.1)',
                              border: '1px solid rgba(239, 68, 68, 0.4)',
                              borderRadius: 'var(--radius-md)'
                            }}>
                              <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ef4444', boxShadow: '0 0 10px #ef4444' }} />
                              <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fca5a5' }}>
                                Recording Active... ({recordedSteps.length} actions captured)
                              </span>
                              <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                {recorderDuration}
                              </span>
                            </div>

                            <button
                              className="btn btn-danger"
                              onClick={handleStopRecorder}
                              disabled={recorderStopping}
                              style={{
                                padding: '0.75rem 1.5rem',
                                fontWeight: 700,
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px'
                              }}
                            >
                              {recorderStopping ? <RefreshCw className="spin" size={16} /> : <Square size={16} />}
                              <span>Stop & Finalize Steps</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Live Captured Steps Feed */}
                    {recordedSteps.length > 0 && (
                      <div style={{
                        marginTop: '0.5rem',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--bg-secondary)',
                        overflow: 'hidden'
                      }}>
                        <div style={{
                          padding: '0.6rem 1rem',
                          background: 'rgba(0,0,0,0.2)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          borderBottom: '1px solid var(--border-color)'
                        }}>
                          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                            Captured User Actions ({recordedSteps.length})
                          </span>
                          {recorderStatus === 'completed' && (
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <button
                                className="btn btn-sm btn-secondary"
                                onClick={handleImportRecordedSteps}
                                style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                              >
                                <CheckCircle size={14} style={{ color: '#10b981' }} />
                                <span>Import into Agent Checklist</span>
                              </button>
                              <button
                                className="btn btn-sm btn-primary"
                                onClick={() => handleDownloadRecordedSuite('selenium')}
                                style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                              >
                                <Download size={14} />
                                <span>Download Selenium POM (.zip)</span>
                              </button>
                              <button
                                className="btn btn-sm btn-outline"
                                onClick={() => handleDownloadRecordedSuite('playwright')}
                                style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                              >
                                <Download size={14} />
                                <span>Download Playwright (.zip)</span>
                              </button>
                            </div>
                          )}
                        </div>
                        <div style={{ maxHeight: '220px', overflowY: 'auto', padding: '0.5rem' }}>
                          {recordedSteps.map((s, idx) => (
                            <div key={idx} style={{
                              display: 'grid',
                              gridTemplateColumns: '40px 100px 1fr 140px',
                              gap: '8px',
                              padding: '6px 10px',
                              borderBottom: '1px solid rgba(255,255,255,0.05)',
                              fontSize: '0.8rem',
                              alignItems: 'center'
                            }}>
                              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>#{idx + 1}</span>
                              <span style={{
                                fontWeight: 700,
                                color: s.action === 'Click' ? '#38bdf8' : s.action === 'Type' ? '#a78bfa' : '#34d399'
                              }}>
                                {s.action}
                              </span>
                              <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {s.target}
                              </span>
                              <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {s.inputData ? `"${s.inputData}"` : '-'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="options-section">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={headedMode}
                      onChange={(e) => setHeadedMode(e.target.checked)}
                      disabled={agentStatus === 'running'}
                    />
                    <span className="checkbox-text">Run browser in headed mode (visible browser window)</span>
                  </label>
                </div>

                <div className="templates-section">
                  <h4>Suggested Tasks</h4>
                  <div className="template-cards">
                    <div className="template-card" onClick={() => selectPrompt('Find locator mappings in src/utils/locatorUtils.js, test them in a headless browser, and heal any broken definitions')}>
                      <h5>Heal Broken Selectors</h5>
                      <p>Traverses files to test selectors, finding fallback targets dynamically if validation fails.</p>
                    </div>
                    <div className="template-card" onClick={() => selectPrompt('Inspect local PostgreSQL schemas, check for consistency in migrations, and seed mock test data')}>
                      <h5>Verify & Seed DB Tables</h5>
                      <p>Inspects PostgreSQL schemas, maps table indexes, and creates realistic dataset seeds.</p>
                    </div>
                    <div className="template-card" onClick={() => selectPrompt('Analyze local localization coverage, locate untranslated keys, and write appropriate translation tests')}>
                      <h5>Verify Localization Coverage</h5>
                      <p>Audits local keys against localized dictionary properties for translation consistency.</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Terminal Logs Output & Live Browser Stream */}
              <div className="console-panel glass-panel">
                <div className="console-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div className="console-title" style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Terminal size={18} />
                      <span>Agent Execution</span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.25rem', background: 'rgba(0,0,0,0.25)', padding: '0.2rem', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                      <button
                        type="button"
                        onClick={() => setActiveConsoleTab('terminal')}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.25rem 0.65rem',
                          border: 'none',
                          borderRadius: '4px',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                          background: activeConsoleTab === 'terminal' ? 'var(--accent-primary)' : 'transparent',
                          color: activeConsoleTab === 'terminal' ? '#fff' : 'var(--text-secondary)'
                        }}
                      >
                        <Terminal size={13} /> Console Stream
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveConsoleTab('browser')}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.25rem 0.65rem',
                          border: 'none',
                          borderRadius: '4px',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                          background: activeConsoleTab === 'browser' ? 'var(--accent-primary)' : 'transparent',
                          color: activeConsoleTab === 'browser' ? '#fff' : 'var(--text-secondary)'
                        }}
                      >
                        <Monitor size={13} /> Live Browser
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {agentStatus === 'running' && (
                      <button
                        type="button"
                        className="btn btn-danger"
                        style={{
                          padding: '0.35rem 0.85rem',
                          fontSize: '0.75rem',
                          background: 'rgba(239, 68, 68, 0.25)',
                          border: '1px solid #ef4444',
                          color: '#f87171',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px',
                          borderRadius: 'var(--radius-sm)',
                          cursor: 'pointer',
                          fontWeight: 600
                        }}
                        onClick={handleCancelAgent}
                        title="Cancel running operation"
                      >
                        <CircleAlert size={13} />
                        <span>Cancel Operation</span>
                      </button>
                    )}
                    <span className={`status-badge ${agentStatus}`}>
                      {agentStatus.toUpperCase()}
                    </span>
                  </div>
                </div>
                
                {pendingLearningsList.length > 0 && (
                  <div className="export-code-section learnings-approval-section animate-fade-in" style={{ marginTop: '20px', border: '1px solid rgba(139, 92, 246, 0.3)', background: 'rgba(139, 92, 246, 0.05)', padding: '15px', borderRadius: 'var(--radius-md)' }}>
                    <div className="export-banner" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Sparkles size={16} className="sparkle-icon" style={{ color: '#8b5cf6' }} />
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Staged {pendingLearningsList.length} locator learnings for approval:</span>
                      </div>
                      {!learningsAccepted ? (
                        <button 
                          className="btn btn-primary"
                          style={{ background: '#8b5cf6', borderColor: '#8b5cf6', padding: '0.4rem 1.2rem', fontSize: '0.85rem' }}
                          onClick={handleAcceptLearnings}
                        >
                          <CheckCircle size={14} style={{ marginRight: '6px', display: 'inline' }} />
                          <span>Accept & Save Locators</span>
                        </button>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#10b981', fontWeight: 600, fontSize: '0.9rem' }}>
                          <CheckCircle size={16} />
                          <span>Accepted & Committed!</span>
                        </div>
                      )}
                    </div>
                    <div className="staged-learnings-list" style={{ marginTop: '12px', padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--radius-sm)', maxHeight: '150px', overflowY: 'auto' }}>
                      {pendingLearningsList.map((learn, idx) => (
                        <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', padding: '4px 0', borderBottom: idx < pendingLearningsList.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none', color: 'var(--text-secondary)' }}>
                          <span>Action: <strong>{learn.action_key}</strong></span>
                          <span style={{ color: '#a78bfa' }}>Selector: <code>{learn.selector}</code></span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {activeConsoleTab === 'browser' ? (
                  <LiveBrowserViewer 
                    title={recorderStatus === 'recording' ? "Interactive Live Recorder Browser" : "MCP Agent Live Browser"} 
                    subtitle={recorderStatus === 'recording' ? "Direct In-Browser Recording Session" : "Virtual Desktop & CDP Live Stream — Watching Playwright Automation Actions"}
                    isExecuting={agentStatus === 'running' || recorderStatus === 'recording'} 
                    liveScreenshot={recorderStatus === 'recording' ? (recorderScreenshot || liveScreenshot) : liveScreenshot}
                    runId={recorderStatus === 'recording' ? recorderSessionId : currentRunId}
                    agentStatus={recorderStatus === 'recording' ? 'running' : agentStatus}
                    isHeaded={recorderDisplayMode === 'headed' || headedMode}
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginTop: '20px' }}>
                    {logs.length > 0 && (
                      <div className="terminal-screen" style={{ maxHeight: '500px', overflowY: 'auto', padding: '15px' }}>
                        <h4 style={{ margin: '0 0 12px 0', fontSize: '0.9rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <CheckCircle size={14} style={{ color: '#10b981' }} />
                          <span>Execution Steps Checklist</span>
                        </h4>
                        {executionSteps.length === 0 ? (
                          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Steps loading...</p>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {executionSteps.map((step, idx) => {
                              const hasScreenshot = !!step.screenshot;
                              return (
                                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(255,255,255,0.05)' }}>
                                  <span className="step-badge" style={{ minWidth: '22px', height: '22px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', background: hasScreenshot ? '#ef4444' : '#10b981', color: '#fff', borderRadius: '50%' }}>{idx + 1}</span>
                                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', textAlign: 'left' }}>
                                      {step.action}
                                    </span>
                                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', textAlign: 'left' }}>
                                      {step.target || 'N/A'}
                                    </span>
                                  </div>
                                  {hasScreenshot && (
                                    <button
                                      className="btn btn-secondary"
                                      style={{ padding: '4px 8px', fontSize: '0.7rem', background: '#3b0764', borderColor: '#6b21a8', color: '#c084fc', display: 'flex', alignItems: 'center', gap: '4px' }}
                                      onClick={() => setActiveScreenshot(step.screenshot)}
                                      title="View screenshot of element recognition failure"
                                    >
                                      <Camera size={12} />
                                      <span>Failed SS</span>
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="terminal-screen" style={{ height: '500px' }}>
                      {logs.length === 0 ? (
                        <div className="terminal-placeholder">
                          <Cpu size={40} className="floating" />
                          <p>Console idle. Submit a goal or upload a spreadsheet to see logs.</p>
                        </div>
                      ) : (
                        <div className="terminal-logs">
                          {logs.map((log, index) => (
                            <div key={index} className="log-line animate-typewriter">
                              {log}
                            </div>
                          ))}
                          <div ref={terminalEndRef} />
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {(agentStatus === 'completed' || agentStatus === 'failed') && currentRunId && (
                  <div className="export-code-section animate-fade-in">
                    <div className="export-banner" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Sparkles size={16} className="sparkle-icon" />
                        <span style={{ fontWeight: 700 }}>QA Architecture Deliverable & CI/CD Frameworks:</span>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button 
                          className="btn btn-primary"
                          style={{ padding: '0.45rem 1rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
                          onClick={handleFetchArchitectReport}
                        >
                          <BookOpen size={14} />
                          <span>QA Architecture Report (10-Section)</span>
                        </button>
                        <button 
                          className="btn btn-secondary"
                          style={{ padding: '0.45rem 1rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
                          onClick={handleDownloadReport}
                          title="Download Markdown Report"
                        >
                          <Download size={14} />
                          <span>Report (.md)</span>
                        </button>
                      </div>
                    </div>
                    <div className="export-buttons" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
                      <button 
                        className="btn btn-secondary export-btn"
                        onClick={() => handleExportCode('playwright')}
                      >
                        <Download size={14} />
                        <span>Playwright (ZIP)</span>
                      </button>
                      <button 
                        className="btn btn-outline export-btn"
                        style={{ border: '1px solid rgba(255,255,255,0.15)', background: 'transparent' }}
                        onClick={() => handleFetchCodePreview('playwright')}
                      >
                        <Eye size={14} />
                        <span>View Playwright POM</span>
                      </button>
                      <button 
                        className="btn btn-secondary export-btn"
                        onClick={() => handleExportCode('selenium')}
                      >
                        <Download size={14} />
                        <span>Selenium (ZIP)</span>
                      </button>
                      <button 
                        className="btn btn-outline export-btn"
                        style={{ border: '1px solid rgba(255,255,255,0.15)', background: 'transparent' }}
                        onClick={() => handleFetchCodePreview('selenium')}
                      >
                        <Eye size={14} />
                        <span>View Selenium POM</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'servers' && (
            <div className="servers-layout">
              <div className="servers-header">
                <div>
                  <h3>Registered Model Context Protocol Servers</h3>
                  <p className="panel-desc">
                    These servers provide safe tool environments (Filesystem, Postgres database client, Web browsers) to the agent.
                  </p>
                </div>
                <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
                  <Plus size={16} />
                  <span>Register MCP Server</span>
                </button>
              </div>

              {loadingServers ? (
                <div className="loading-state">
                  <RefreshCw className="spin" size={48} />
                  <p>Resolving MCP server configurations...</p>
                </div>
              ) : (
                <div className="servers-grid">
                  {servers.map((server) => (
                    <div key={server.id} className="server-card glass-panel">
                      <div className="server-card-header">
                        <div className="server-icon-wrapper">
                          {server.type === 'builtin' ? <Cpu size={22} /> : <Server size={22} />}
                        </div>
                        <span className={`status-indicator-dot ${server.status}`}></span>
                      </div>
                      <h4>{server.name}</h4>
                      <p className="server-url">Endpoint: <code>{server.url}</code></p>
                      
                      <div className="server-card-footer">
                        <span className="type-badge">{server.type.toUpperCase()}</span>
                        {server.type !== 'builtin' && (
                          <button 
                            className="delete-server-btn"
                            onClick={() => handleDeleteServer(server.id)}
                            title="Delete configuration"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Register Server Modal */}
      {showAddModal && (
        <div className="modal-overlay">
          <div className="modal-content glass-panel animate-fade-in">
            <h3>Register Custom MCP Server</h3>
            <form onSubmit={handleAddServer}>
              <div className="form-group">
                <label>Server Name</label>
                <input
                  type="text"
                  placeholder="E.g., GitHub Issues MCP"
                  value={newServerName}
                  onChange={(e) => setNewServerName(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>Connection URL / Command Path</label>
                <input
                  type="text"
                  placeholder="E.g., http://localhost:5001/sse or npx @modelcontextprotocol/server-github"
                  value={newServerUrl}
                  onChange={(e) => setNewServerUrl(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>Transport Mode</label>
                <select
                  value={newServerType}
                  onChange={(e) => setNewServerType(e.target.value)}
                >
                  <option value="sse">SSE (HTTP Server-Sent Events)</option>
                  <option value="stdio">stdio (Local Subprocess)</option>
                </select>
              </div>
              <div className="modal-actions">
                <button 
                  type="button" 
                  className="btn btn-secondary" 
                  onClick={() => setShowAddModal(false)}
                  disabled={addingServer}
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="btn btn-primary"
                  disabled={addingServer}
                >
                  {addingServer ? 'Registering...' : 'Register'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showReportModal && (
        <div className="modal-overlay select-modal-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, backdropFilter: 'blur(6px)' }}>
          <div className="modal-content glass-panel animate-zoom-in" style={{ maxWidth: '1050px', width: '92%', maxHeight: '88vh', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-xl)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Modal Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <ShieldCheck size={20} style={{ color: '#8b5cf6' }} />
                  <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                    QA Automation Architecture Deliverable
                  </h3>
                  <span style={{ fontSize: '0.7rem', padding: '2px 8px', borderRadius: '4px', background: 'rgba(16, 185, 129, 0.2)', color: '#10b981', fontWeight: 600 }}>
                    10-SECTION DELIVERABLE
                  </span>
                </div>
                <p style={{ margin: '4px 0 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Architecture: DISCOVER ONCE (via MCP) → GENERATE ONCE → EXECUTE MANY TIMES (in CI/CD)
                </p>
              </div>
              <button 
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '1.5rem', cursor: 'pointer', lineHeight: 1 }} 
                onClick={() => setShowReportModal(false)}
              >
                ×
              </button>
            </div>

            {/* Navigation Tabs */}
            <div style={{ display: 'flex', gap: '6px', padding: '10px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.15)', overflowX: 'auto' }}>
              {[
                { id: 'workflow', label: 'Discovered Workflow' },
                { id: 'locators', label: 'Locator Strategy' },
                { id: 'sync', label: 'Sync & Assertions' },
                { id: 'objective', label: 'Objective & Preconditions' },
                { id: 'humanReview', label: 'Human Review Items' }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveReportTab(tab.id)}
                  style={{
                    padding: '0.45rem 1rem',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: activeReportTab === tab.id ? 'var(--accent-primary)' : 'transparent',
                    color: activeReportTab === tab.id ? '#fff' : 'var(--text-secondary)',
                    transition: 'all 0.2s',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Modal Body */}
            <div style={{ flex: 1, padding: '20px 24px', overflowY: 'auto', minHeight: '380px' }}>
              {loadingReport ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '320px', gap: '12px' }}>
                  <RefreshCw className="spin" size={32} style={{ color: '#8b5cf6' }} />
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Synthesizing QA Architect report & locator mappings...</p>
                </div>
              ) : !architectReport ? (
                <p style={{ color: 'var(--text-muted)' }}>No report data available for this run.</p>
              ) : (
                <>
                  {/* TAB 1: WORKFLOW */}
                  {activeReportTab === 'workflow' && (
                    <div>
                      <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                        Phase 5 — Discovered End-to-End Workflow
                      </h4>
                      <div style={{ overflowX: 'auto', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 'var(--radius-md)' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', textAlign: 'left' }}>
                          <thead>
                            <tr style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                              <th style={{ padding: '10px 12px' }}>Step</th>
                              <th style={{ padding: '10px 12px' }}>Page</th>
                              <th style={{ padding: '10px 12px' }}>Action</th>
                              <th style={{ padding: '10px 12px' }}>Element / Target</th>
                              <th style={{ padding: '10px 12px' }}>Input</th>
                              <th style={{ padding: '10px 12px' }}>Expected Result</th>
                              <th style={{ padding: '10px 12px' }}>Synchronization</th>
                            </tr>
                          </thead>
                          <tbody>
                            {architectReport.reportJson?.discoveredWorkflow?.map((w, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                                <td style={{ padding: '10px 12px', fontWeight: 700, color: '#a78bfa' }}>{w.stepNum}</td>
                                <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>{w.page}</td>
                                <td style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-primary)' }}>{w.action}</td>
                                <td style={{ padding: '10px 12px', color: '#c4b5fd', fontFamily: 'monospace' }}>{w.element}</td>
                                <td style={{ padding: '10px 12px', color: '#fbbf24' }}>{w.input || '-'}</td>
                                <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>{w.expectedResult}</td>
                                <td style={{ padding: '10px 12px', color: '#6ee7b7', fontSize: '0.78rem' }}>{w.synchronization}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* TAB 2: LOCATOR STRATEGY */}
                  {activeReportTab === 'locators' && (
                    <div>
                      <div style={{ marginBottom: '14px', padding: '12px', background: 'rgba(139, 92, 246, 0.08)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(139, 92, 246, 0.2)' }}>
                        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#c4b5fd' }}>
                          Locator Prioritization Order:
                        </span>
                        <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginLeft: '8px' }}>
                          1. Accessible Role + Name → 2. Label → 3. data-testid → 4. Stable ID → 5. Scoped CSS → 6. Relative XPath
                        </span>
                      </div>
                      <div style={{ overflowX: 'auto', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 'var(--radius-md)' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', textAlign: 'left' }}>
                          <thead>
                            <tr style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                              <th style={{ padding: '10px 12px' }}>Step</th>
                              <th style={{ padding: '10px 12px' }}>Action</th>
                              <th style={{ padding: '10px 12px' }}>Discovered Target</th>
                              <th style={{ padding: '10px 12px' }}>Playwright POM Locator</th>
                              <th style={{ padding: '10px 12px' }}>Selenium By Locator</th>
                              <th style={{ padding: '10px 12px' }}>Quality Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {architectReport.reportJson?.locatorStrategy?.map((l, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                <td style={{ padding: '10px 12px', fontWeight: 700 }}>{l.stepNum}</td>
                                <td style={{ padding: '10px 12px' }}>{l.action}</td>
                                <td style={{ padding: '10px 12px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{l.target}</td>
                                <td style={{ padding: '10px 12px', fontFamily: 'monospace', color: '#60a5fa' }}>{l.playwright}</td>
                                <td style={{ padding: '10px 12px', fontFamily: 'monospace', color: '#a78bfa' }}>{l.selenium}</td>
                                <td style={{ padding: '10px 12px' }}>
                                  {l.isFragile ? (
                                    <span style={{ padding: '2px 8px', borderRadius: '4px', background: 'rgba(239, 68, 68, 0.2)', color: '#f87171', fontWeight: 600, fontSize: '0.75rem' }}>
                                      ⚠️ REVIEW NEEDED
                                    </span>
                                  ) : (
                                    <span style={{ padding: '2px 8px', borderRadius: '4px', background: 'rgba(16, 185, 129, 0.2)', color: '#34d399', fontWeight: 600, fontSize: '0.75rem' }}>
                                      ✅ STABLE
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* TAB 3: SYNC & ASSERTIONS */}
                  {activeReportTab === 'sync' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                      <div style={{ padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 'var(--radius-md)' }}>
                        <h4 style={{ margin: '0 0 10px 0', fontSize: '0.95rem', color: '#6ee7b7', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <CheckCircle size={16} />
                          <span>Synchronization Strategy</span>
                        </h4>
                        <p style={{ fontSize: '0.82rem', color: '#f87171', fontWeight: 600, marginBottom: '10px' }}>
                          Strict Policy: Zero arbitrary fixed sleeps (Thread.sleep or waitForTimeout forbidden)
                        </p>
                        <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                          <li>Automatic waiting for Pega/OutSystems loaders (.full-screen-loader-wrapper, .loading-spinner, .pega-loading-indicator).</li>
                          <li>Condition-based element interactability checks (waitForLoadState, elementToBeClickable).</li>
                          <li>Controlled retries for StaleElementReferenceException during asynchronous DOM swaps.</li>
                          <li>Web-first assertions with automatic retry in Playwright.</li>
                        </ul>
                      </div>

                      <div style={{ padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 'var(--radius-md)' }}>
                        <h4 style={{ margin: '0 0 10px 0', fontSize: '0.95rem', color: '#60a5fa', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <ShieldCheck size={16} />
                          <span>Business Assertions & Checkpoints</span>
                        </h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {architectReport.reportJson?.assertions?.map((a, idx) => (
                            <div key={idx} style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px', borderLeft: '3px solid #60a5fa' }}>
                              <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                Step {a.stepNum}: {a.checkpoint}
                              </div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                Type: {a.verificationType}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB 4: OBJECTIVE & PRECONDITIONS */}
                  {activeReportTab === 'objective' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                      <div style={{ padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 'var(--radius-md)' }}>
                        <h4 style={{ margin: '0 0 8px 0', fontSize: '0.95rem', color: 'var(--text-primary)' }}>1. Business Objective</h4>
                        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          {architectReport.reportJson?.testObjective}
                        </p>
                      </div>

                      <div style={{ padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 'var(--radius-md)' }}>
                        <h4 style={{ margin: '0 0 8px 0', fontSize: '0.95rem', color: 'var(--text-primary)' }}>2. Preconditions</h4>
                        <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                          {architectReport.reportJson?.preconditions?.map((p, idx) => (
                            <li key={idx}>{p}</li>
                          ))}
                        </ul>
                      </div>

                      <div style={{ padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 'var(--radius-md)' }}>
                        <h4 style={{ margin: '0 0 8px 0', fontSize: '0.95rem', color: 'var(--text-primary)' }}>3. Discovered Test Data</h4>
                        {architectReport.reportJson?.testData?.length > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                            {architectReport.reportJson.testData.map((d, idx) => (
                              <div key={idx} style={{ padding: '6px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: '4px', fontSize: '0.8rem' }}>
                                <span style={{ color: 'var(--text-muted)' }}>{d.field}: </span>
                                <strong style={{ color: '#fbbf24' }}>"{d.value}"</strong>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                            No parameterized inputs detected; uses standard session defaults.
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* TAB 5: HUMAN REVIEW */}
                  {activeReportTab === 'humanReview' && (
                    <div>
                      <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                        Phase 8 & 10 — Human Review Checklist
                      </h4>
                      {architectReport.reportJson?.humanReviewItems?.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          {architectReport.reportJson.humanReviewItems.map((h, idx) => (
                            <div key={idx} style={{ padding: '12px', background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 'var(--radius-md)' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                <AlertTriangle size={16} style={{ color: '#ef4444' }} />
                                <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#fca5a5' }}>
                                  Step {h.stepNum} ({h.action}): Element "{h.target}"
                                </span>
                              </div>
                              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                {h.reason}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ padding: '24px', textAlign: 'center', background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: 'var(--radius-md)' }}>
                          <CheckCircle size={32} style={{ color: '#10b981', margin: '0 auto 8px' }} />
                          <h5 style={{ margin: '0 0 4px 0', color: '#6ee7b7' }}>All Elements Conforming to Stable Standards</h5>
                          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                            No fragile, auto-generated, or index-based selectors detected. All locators use accessible roles, labels, or verified attributes.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Modal Footer */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 24px', borderTop: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.15)' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button 
                  className="btn btn-secondary" 
                  style={{ padding: '0.45rem 1rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
                  onClick={handleDownloadReport}
                >
                  <Download size={14} />
                  <span>Download Report (.md)</span>
                </button>
                <button 
                  className="btn btn-secondary" 
                  style={{ padding: '0.45rem 1rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
                  onClick={() => handleExportCode('playwright')}
                >
                  <Download size={14} />
                  <span>Playwright POM (ZIP)</span>
                </button>
                <button 
                  className="btn btn-secondary" 
                  style={{ padding: '0.45rem 1rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
                  onClick={() => handleExportCode('selenium')}
                >
                  <Download size={14} />
                  <span>Selenium POM (ZIP)</span>
                </button>
              </div>
              <button 
                className="btn btn-primary" 
                style={{ padding: '0.45rem 1.4rem', fontSize: '0.8rem' }}
                onClick={() => setShowReportModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showCodeModal && (
        <div className="modal-overlay select-modal-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, backdropFilter: 'blur(4px)' }}>
          <div className="modal-content preview-code-modal glass-panel animate-zoom-in" style={{ maxWidth: '950px', width: '90%', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Terminal size={18} style={{ color: 'var(--accent-secondary)' }} />
                <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)' }}>Generated POM Code Preview ({previewFramework.toUpperCase()})</h3>
              </div>
              <button className="close-btn" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '1.5rem', cursor: 'pointer' }} onClick={() => setShowCodeModal(false)}>×</button>
            </div>
            
            <div className="preview-framework-toggle" style={{ display: 'flex', gap: '10px', padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <button 
                className={`btn btn-sm ${previewFramework === 'selenium' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}
                onClick={() => handleFetchCodePreview('selenium')}
                disabled={loadingPreview}
              >
                Selenium (Java)
              </button>
              <button 
                className={`btn btn-sm ${previewFramework === 'playwright' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}
                onClick={() => handleFetchCodePreview('playwright')}
                disabled={loadingPreview}
              >
                Playwright (JS)
              </button>
            </div>

            {loadingPreview ? (
              <div className="loading-state" style={{ minHeight: '350px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
                <RefreshCw className="spin" size={32} style={{ color: 'var(--accent-primary)' }} />
                <p style={{ color: 'var(--text-secondary)' }}>Generating page objects and methods...</p>
              </div>
            ) : (
              <div className="preview-code-body" style={{ display: 'flex', minHeight: '400px' }}>
                {/* File Sidebar */}
                <div className="preview-sidebar" style={{ width: '220px', borderRight: '1px solid rgba(255,255,255,0.08)', padding: '15px', background: 'rgba(0,0,0,0.1)' }}>
                  <span style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '1.5px', fontWeight: 'bold' }}>Files</span>
                  <div className="file-list" style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {previewFiles.map((file, idx) => (
                      <button
                        key={idx}
                        className={`btn btn-sm ${selectedPreviewFileIdx === idx ? 'btn-secondary' : 'btn-ghost'}`}
                        style={{ textAlign: 'left', display: 'block', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0.5rem', border: selectedPreviewFileIdx === idx ? '1px solid var(--border-color)' : '1px solid transparent', background: selectedPreviewFileIdx === idx ? 'var(--bg-tertiary)' : 'transparent', color: selectedPreviewFileIdx === idx ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                        onClick={() => { setSelectedPreviewFileIdx(idx); setCopiedFileIdx(null); }}
                      >
                        <FileText size={12} style={{ marginRight: '6px', verticalAlign: 'middle', display: 'inline' }} />
                        <span style={{ fontSize: '0.85rem' }}>{file.name}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Code display pane */}
                <div className="preview-pane" style={{ flex: 1, padding: '15px', position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  {previewFiles[selectedPreviewFileIdx] ? (
                    <>
                      <div className="preview-pane-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Path: <code style={{ color: 'var(--text-secondary)' }}>{previewFiles[selectedPreviewFileIdx].path}</code></span>
                        <button
                          className="btn btn-sm btn-secondary"
                          style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                          onClick={() => handleCopyCode(previewFiles[selectedPreviewFileIdx].code, selectedPreviewFileIdx)}
                        >
                          {copiedFileIdx === selectedPreviewFileIdx ? (
                            <>
                              <CheckCircle size={12} style={{ color: 'var(--success)' }} />
                              <span>Copied!</span>
                            </>
                          ) : (
                            <>
                              <Copy size={12} />
                              <span>Copy Code</span>
                            </>
                          )}
                        </button>
                      </div>
                      <div style={{ flex: 1, overflow: 'auto', maxHeight: '420px', background: '#090d16', padding: '15px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <pre style={{ margin: 0, fontSize: '12px', fontFamily: 'Consolas, Monaco, monospace', color: '#a9b2c3', whiteSpace: 'pre', textAlign: 'left' }}>
                          <code>{previewFiles[selectedPreviewFileIdx].code}</code>
                        </pre>
                      </div>
                    </>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                      No files available.
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="modal-overlay-footer" style={{ padding: '15px 20px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.1)' }}>
              <button 
                className="btn btn-primary"
                style={{ padding: '0.45rem 1.2rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px' }}
                onClick={() => handleExportCode(previewFramework)}
              >
                <Download size={14} />
                <span>Download {previewFramework === 'playwright' ? 'Playwright' : 'Selenium'} (ZIP)</span>
              </button>
              <button className="btn btn-secondary" style={{ padding: '0.5rem 1.2rem', fontSize: '0.85rem' }} onClick={() => setShowCodeModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Failure Screenshot Overlay Modal */}
      {activeScreenshot && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: 9999,
            background: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
          }}
          onClick={() => setActiveScreenshot(null)}
        >
          <div 
            style={{
              position: 'relative',
              background: '#0c0a0f',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '12px',
              padding: '16px',
              maxWidth: '90%',
              maxHeight: '90%',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.95rem' }}>Failed Field Recognition Screenshot</span>
              <button 
                className="btn btn-secondary" 
                style={{ padding: '4px 8px', fontSize: '0.75rem' }}
                onClick={() => setActiveScreenshot(null)}
              >
                Close
              </button>
            </div>
            <img 
              src={activeScreenshot} 
              alt="Recognition Failure Screenshot" 
              style={{
                maxWidth: '100%',
                maxHeight: '70vh',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.05)',
                objectFit: 'contain'
              }} 
            />
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center' }}>
              This shows the page state at the moment the Agent failed to locate the selector.
            </p>
          </div>
        </div>
      )}

      <style>{`
        .mcp-agent-hub {
          max-width: 1200px;
          margin: 0 auto;
          padding: 1rem 0;
        }

        .hub-header-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 2rem;
          gap: 1rem;
        }

        .hub-header-row h2 {
          font-size: 1.75rem;
          margin-bottom: 0.25rem;
          font-weight: 700;
        }

        .tab-buttons {
          display: flex;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-color);
          padding: 4px;
          border-radius: var(--radius-lg);
          gap: 4px;
        }

        .tab-btn {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          background: transparent;
          border: none;
          padding: 0.5rem 1rem;
          color: var(--text-secondary);
          cursor: pointer;
          border-radius: var(--radius-md);
          font-size: 0.9rem;
          font-weight: 500;
          transition: all 0.2s;
        }

        .tab-btn.active {
          background: var(--bg-secondary);
          color: var(--accent-primary);
          box-shadow: var(--shadow-sm);
        }

        .glass-panel {
          background: rgba(30, 41, 59, 0.4);
          backdrop-filter: blur(16px);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-lg);
          transition: all 0.3s;
        }

        .glass-panel:hover {
          border-color: var(--border-focus);
          box-shadow: var(--shadow-xl), 0 0 30px rgba(139, 92, 246, 0.05);
        }

        .panel-desc {
          font-size: 0.9rem;
          color: var(--text-secondary);
          margin-bottom: 1.5rem;
          line-height: 1.5;
        }

        .no-project-selected {
          text-align: center;
          padding: 5rem 2rem;
          background: var(--bg-secondary);
          border: 1px dashed var(--border-color);
          border-radius: var(--radius-lg);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1rem;
        }

        .no-project-selected h3 {
          font-size: 1.25rem;
          font-weight: 600;
        }

        .no-project-selected p {
          color: var(--text-secondary);
          max-width: 400px;
        }

        /* Playground Layout */
        .playground-layout {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 2rem;
        }

        .setup-panel, .console-panel {
          padding: 2rem;
          display: flex;
          flex-direction: column;
        }

        .setup-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.5rem;
        }

        .setup-panel h3, .console-panel h3 {
          font-size: 1.25rem;
          font-weight: 700;
        }

        .mode-toggle {
          display: flex;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-color);
          padding: 2px;
          border-radius: var(--radius-md);
          gap: 2px;
        }

        .mode-btn {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 0.75rem;
          background: transparent;
          border: none;
          padding: 4px 8px;
          border-radius: var(--radius-sm);
          color: var(--text-secondary);
          cursor: pointer;
          transition: all 0.2s;
        }

        .mode-btn.active {
          background: var(--bg-secondary);
          color: var(--accent-primary);
        }

        .goal-input-container, .excel-input-container {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          margin-bottom: 2rem;
        }

        .goal-input-container textarea {
          width: 100%;
          min-height: 120px;
          background: var(--bg-primary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          padding: 1rem;
          color: var(--text-primary);
          font-family: inherit;
          font-size: 0.95rem;
          line-height: 1.5;
          resize: vertical;
          outline: none;
          transition: border-color 0.2s;
        }

        .goal-input-container textarea:focus {
          border-color: var(--border-focus);
        }

        /* Excel input Zone */
        .excel-upload-zone {
          border: 2px dashed var(--border-color);
          border-radius: var(--radius-md);
          padding: 2rem;
          text-align: center;
          cursor: pointer;
          background: rgba(255, 255, 255, 0.01);
          transition: all 0.2s;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.75rem;
          min-height: 120px;
        }

        .excel-upload-zone:hover {
          border-color: var(--border-focus);
          background: rgba(255, 255, 255, 0.02);
        }

        .upload-icon {
          color: var(--text-muted);
          transition: color 0.2s;
        }

        .excel-upload-zone:hover .upload-icon {
          color: var(--accent-primary);
        }

        .excel-upload-zone p {
          font-size: 0.85rem;
          color: var(--text-secondary);
          max-width: 250px;
        }

        .file-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .file-name {
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--text-primary);
          word-break: break-all;
        }

        .file-size {
          font-size: 0.75rem;
          color: var(--text-muted);
        }

        .excel-actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 1rem;
        }

        .template-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.85rem;
        }

        .run-btn {
          align-self: flex-end;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.75rem 1.5rem;
        }

        .options-section {
          margin-bottom: 2rem;
          padding-top: 1.25rem;
          border-top: 1px solid var(--border-color);
        }

        .checkbox-label {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          cursor: pointer;
          user-select: none;
        }

        .checkbox-label input {
          width: 16px;
          height: 16px;
          cursor: pointer;
          accent-color: var(--accent-primary);
        }

        .checkbox-text {
          font-size: 0.9rem;
          color: var(--text-primary);
          font-weight: 500;
        }

        .templates-section h4 {
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--text-muted);
          margin-bottom: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .template-cards {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }

        .template-card {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid var(--border-color);
          padding: 1rem;
          border-radius: var(--radius-md);
          cursor: pointer;
          transition: all 0.2s;
        }

        .template-card:hover {
          background: rgba(255, 255, 255, 0.04);
          border-color: var(--border-focus);
          transform: translateX(4px);
        }

        .template-card h5 {
          font-size: 0.9rem;
          font-weight: 600;
          margin-bottom: 0.25rem;
          color: var(--text-primary);
        }

        .template-card p {
          font-size: 0.8rem;
          color: var(--text-secondary);
          line-height: 1.4;
        }

        /* Console styling */
        .console-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1.5rem;
        }

        .console-title {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-weight: 600;
          font-size: 1.05rem;
        }

        .status-badge {
          font-size: 0.75rem;
          font-weight: 700;
          padding: 4px 10px;
          border-radius: 20px;
          letter-spacing: 0.5px;
        }

        .status-badge.idle { background: rgba(71, 85, 105, 0.15); color: var(--text-muted); border: 1px solid rgba(71, 85, 105, 0.3); }
        .status-badge.running { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }
        .status-badge.completed { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
        .status-badge.cancelled {
          background: rgba(239, 68, 68, 0.15);
          color: #f87171;
          border: 1px solid rgba(239, 68, 68, 0.4);
        }

        .status-badge.failed { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }

        .terminal-screen {
          flex: 1;
          background: #090d16;
          border: 1px solid #1e293b;
          border-radius: var(--radius-md);
          min-height: 400px;
          max-height: 550px;
          padding: 1.5rem;
          font-family: 'Fira Code', 'Courier New', Courier, monospace;
          font-size: 0.85rem;
          overflow-y: auto;
          position: relative;
        }

        .terminal-placeholder {
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1rem;
          color: var(--text-muted);
          text-align: center;
        }

        .terminal-logs {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
        }

        .log-line {
          color: #38bdf8;
          white-space: pre-wrap;
          line-height: 1.5;
        }

        .log-line[class*="[ERROR]"] {
          color: #f87171;
        }

        /* Servers layout */
        .servers-layout {
          display: flex;
          flex-direction: column;
          gap: 2rem;
        }

        .servers-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .servers-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 1.5rem;
        }

        .server-card {
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .server-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .server-icon-wrapper {
          width: 44px;
          height: 44px;
          border-radius: 8px;
          background: rgba(139, 92, 246, 0.1);
          color: var(--accent-primary);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .status-indicator-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }

        .status-indicator-dot.active {
          background-color: #10b981;
          box-shadow: 0 0 10px #10b981;
        }

        .status-indicator-dot.inactive {
          background-color: #f59e0b;
        }

        .status-indicator-dot.failed {
          background-color: #ef4444;
          box-shadow: 0 0 10px #ef4444;
        }

        .server-card h4 {
          font-size: 1.1rem;
          font-weight: 600;
        }

        .server-url {
          font-size: 0.8rem;
          color: var(--text-secondary);
          word-break: break-all;
        }

        .server-card-footer {
          margin-top: auto;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .type-badge {
          font-size: 0.7rem;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-color);
          padding: 2px 6px;
          border-radius: 4px;
          font-weight: 600;
          color: var(--text-muted);
        }

        .delete-server-btn {
          background: transparent;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          transition: color 0.2s;
        }

        .delete-server-btn:hover {
          color: #ef4444;
        }

        /* Modal styling */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .modal-content {
          width: 100%;
          max-width: 500px;
          padding: 2rem;
        }

        .form-group {
          margin-bottom: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .form-group label {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--text-secondary);
        }

        .form-group input, .form-group select {
          background: var(--bg-primary);
          border: 1px solid var(--border-color);
          padding: 0.75rem;
          border-radius: var(--radius-md);
          color: var(--text-primary);
          outline: none;
          font-size: 0.95rem;
        }

        .form-group input:focus, .form-group select:focus {
          border-color: var(--border-focus);
        }

        .modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 0.75rem;
          margin-top: 2rem;
        }

        /* Animations */
        @keyframes typewriter {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .animate-typewriter {
          animation: typewriter 0.2s ease-out forwards;
        }

        .floating {
          animation: float 3s ease-in-out infinite;
        }

        @keyframes float {
          0% { transform: translateY(0px); }
          50% { transform: translateY(-8px); }
          100% { transform: translateY(0px); }
        }

        .plan-review-container {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          margin-bottom: 2rem;
          animation: typewriter 0.3s ease-out forwards;
        }

        .plan-review-subtitle {
          font-size: 0.85rem;
          color: var(--text-secondary);
          line-height: 1.4;
        }

        .steps-checklist {
          background: rgba(15, 23, 42, 0.4);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          padding: 1rem;
          max-height: 250px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }

        .step-item {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.6rem 0.8rem;
          border-radius: var(--radius-sm);
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .step-badge {
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 22px;
          height: 22px;
          border-radius: 50%;
          background: var(--accent-primary);
          color: white;
          font-size: 0.75rem;
          font-weight: bold;
        }

        .step-details {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 0.5rem;
          font-size: 0.85rem;
          color: var(--text-secondary);
        }

        .step-action-name {
          font-weight: 700;
          color: var(--accent-primary);
        }

        .step-target-name {
          color: var(--text-primary);
          word-break: break-all;
        }

        .step-input-data {
          color: #a78bfa;
          font-style: italic;
        }

        .plan-actions {
          display: flex;
          justify-content: flex-end;
          gap: 1rem;
          margin-top: 0.5rem;
        }

        .cancel-run-btn {
          padding: 0.6rem 1.2rem;
        }

        .approve-run-btn {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.6rem 1.5rem;
          background: var(--accent-primary);
          border-color: var(--accent-primary);
        }

        .export-code-section {
          margin-top: 1.5rem;
          padding: 1.25rem;
          background: rgba(139, 92, 246, 0.05);
          border: 1px dashed rgba(139, 92, 246, 0.3);
          border-radius: var(--radius-lg);
          display: flex;
          flex-direction: column;
          gap: 1rem;
          animation: typewriter 0.3s ease-out forwards;
        }

        .export-banner {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--text-primary);
        }

        .sparkle-icon {
          color: #fbbf24;
        }

        .export-buttons {
          display: flex;
          gap: 1rem;
        }

        .export-btn {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          font-size: 0.85rem;
          padding: 0.65rem 1rem;
          transition: all 0.2s;
        }

        .export-btn:hover:not(:disabled) {
          border-color: var(--accent-primary);
          background: rgba(139, 92, 246, 0.08);
          color: var(--text-primary);
        }

        @media (max-width: 992px) {
          .playground-layout {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
};

export default McpAgentHub;
