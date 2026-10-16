import { useMemo, useRef, useState, useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import {
    Alert,
    Box,
    Button,
    Chip,
    Grid,
    Paper,
    Stack,
    TextField,
    Typography,
    useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { DataGrid, useGridApiContext } from '@mui/x-data-grid';
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import BugReportIcon from '@mui/icons-material/BugReport';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import HistoryIcon from '@mui/icons-material/History';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ToolWorkflow from '../components/workflow/ToolWorkflow';
import GenerationProgress from '../components/workflow/GenerationProgress';
import RequirementInput from '../components/features/RequirementInput';
import ExportControls from '../components/features/ExportControls';
import RaiseDefectDialog from '../components/features/RaiseDefectDialog';
import { useNotify } from '../components/common/NotificationProvider';
import { useProject } from '../context/ProjectContext';
import { createApiClient } from '../utils/apiClient';
import { generateTestCases } from '../services/testCaseGenerationService';
import { exportToExcel, exportToJSON } from '../utils/exportUtils';

// Wizard step order — the single source of truth for both the stepper and any
// programmatic jump (`stepIndex('review')`). The steps array below is built
// from this list, so no numeric step index is maintained by hand.
const STEP_ORDER = ['input', 'generate', 'review', 'export'];
const stepIndex = (key) => STEP_ORDER.indexOf(key);

// Format an elapsed-seconds value as "12.3s" or "1m 05s".
const fmtDuration = (s) => {
    if (s == null) return '';
    if (s >= 60) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
    return `${s.toFixed(1)}s`;
};

// Columns hidden below the md breakpoint — the long-form context fields are
// the first to go so the narrow layout keeps ID/scenario/steps/result legible.
const NARROW_HIDDEN_COLUMNS = { preconditions: false, testData: false, testType: false, platform: false };

const EMPTY_FORM = {
    requirement: '',
    businessRules: '',
    regressionContext: '',
    techDetails: '',
    manualStoryKey: '',
    sourceType: 'manual',
    jiraKey: '',
};

const ftId = (n) => `FT_${String(n).padStart(3, '0')}`;

// Highest FT_nnn sequence number already present, so appended batches continue
// the numbering instead of colliding with earlier ones.
const maxFtNumber = (rows) => rows.reduce((max, tc) => {
    if (!tc?.id || !String(tc.id).startsWith('FT_')) return max;
    const num = parseInt(String(tc.id).replace('FT_', ''), 10);
    return !isNaN(num) && num > max ? num : max;
}, 0);

const priorityColor = (priority) => {
    const p = String(priority || '').split('-')[0].toLowerCase();
    if (p === 'p1' || p === 'p2' || p === 'high' || p === 'critical') return 'error';
    if (p === 'p3' || p === 'medium') return 'warning';
    if (p === 'p4' || p === 'low') return 'success';
    return 'default';
};

/**
 * Multi-line edit cell. DataGrid's default string editor is a single-line
 * input, which makes the long narrative fields (steps, preconditions,
 * expected result) unusable — the legacy table used textareas for these.
 * Enter is swallowed so it inserts a newline instead of committing the edit.
 */
function MultilineEditCell({ id, field, value }) {
    const apiRef = useGridApiContext();
    return (
        <TextField
            autoFocus
            multiline
            minRows={3}
            maxRows={10}
            fullWidth
            size="small"
            variant="standard"
            value={value ?? ''}
            onChange={(e) => apiRef.current.setEditCellValue({ id, field, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') e.stopPropagation(); }}
            sx={{ px: 1, '& .MuiInputBase-root': { fontSize: 13 } }}
        />
    );
}

const TestGenerator = () => {
    const notify = useNotify();
    const auth = useAuth();
    const { selectedProjectId, selectedProject } = useProject();
    const mui = useTheme();
    const isDownMd = useMediaQuery(mui.breakpoints.down('md'));

    // Wizard state
    const [step, setStep] = useState(stepIndex('input'));
    const [form, setForm] = useState(EMPTY_FORM);
    const [requirementHistory, setRequirementHistory] = useState([]);
    const [testCases, setTestCases] = useState([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [streamText, setStreamText] = useState('');
    const [error, setError] = useState(null);
    const [genSeconds, setGenSeconds] = useState(null);
    const [lastBatchCount, setLastBatchCount] = useState(0);
    const [expandRows, setExpandRows] = useState(false);
    const [colVis, setColVis] = useState(() => (isDownMd ? NARROW_HIDDEN_COLUMNS : {}));
    const [defectTarget, setDefectTarget] = useState(null);
    const [actualResult, setActualResult] = useState('');
    const [isRaising, setIsRaising] = useState({});
    const [raisedBugs, setRaisedBugs] = useState({});
    const abortControllerRef = useRef(null);

    // History tracking states
    const [historyStories, setHistoryStories] = useState([]);
    const [selectedStoryRuns, setSelectedStoryRuns] = useState([]);
    const [activeStoryKey, setActiveStoryKey] = useState('');
    const [historyWarning, setHistoryWarning] = useState(null);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);

    const api = createApiClient(() => auth.user?.access_token);
    const setField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

    // History API integration
    const fetchHistoryStories = async () => {
        if (!selectedProjectId || !api) return;
        setIsLoadingHistory(true);
        try {
            const data = await api.get(`/api/testcase-history/stories?project_id=${selectedProjectId}`);
            setHistoryStories(data.stories || []);
        } catch (err) {
            console.error('[Fetch Stories Error]', err);
        } finally {
            setIsLoadingHistory(false);
        }
    };

    const fetchStoryRuns = async (storyKey) => {
        if (!selectedProjectId || !api || !storyKey) return;
        try {
            const data = await api.get(`/api/testcase-history/story/${encodeURIComponent(storyKey)}/runs?project_id=${selectedProjectId}`);
            setSelectedStoryRuns(data.runs || []);
            setActiveStoryKey(storyKey);
        } catch (err) {
            console.error('[Fetch Runs Error]', err);
        }
    };

    const handleLoadRun = (run) => {
        setTestCases(run.test_cases || []);
        setGenSeconds(null);
        setLastBatchCount(run.test_cases?.length || 0);

        const isJira = /^[A-Z0-9]+-\d+$/i.test(run.story_key || '');
        setForm({
            requirement: run.story_description || '',
            businessRules: run.business_rules || '',
            regressionContext: run.regression_context || '',
            techDetails: run.tech_details || '',
            sourceType: isJira ? 'jira' : 'manual',
            jiraKey: isJira ? (run.story_key || '') : '',
            manualStoryKey: isJira ? '' : (run.story_key || ''),
        });

        notify.success(`Loaded ${run.test_cases?.length || 0} test cases from "${run.story_key}"`);
        setStep(stepIndex('review'));
    };

    const handleDeleteRun = async (runId, storyKey) => {
        if (!api) return;
        try {
            await api.del(`/api/testcase-history/run/${runId}`);
            fetchStoryRuns(storyKey);
            fetchHistoryStories();
            notify.info('Run removed');
        } catch (err) {
            console.error('[Delete Run Error]', err);
            notify.error('Failed to delete run');
        }
    };

    const handleDeleteStory = async (storyKey) => {
        if (!selectedProjectId || !api) return;
        if (!window.confirm(`Are you sure you want to delete all history runs for "${storyKey}"?`)) return;
        try {
            await api.del(`/api/testcase-history/story/${encodeURIComponent(storyKey)}?project_id=${selectedProjectId}`);
            setActiveStoryKey('');
            setSelectedStoryRuns([]);
            fetchHistoryStories();
            notify.info(`Deleted history for "${storyKey}"`);
        } catch (err) {
            console.error('[Delete Story Error]', err);
            notify.error('Failed to delete story');
        }
    };

    // Load history when project or auth updates
    useEffect(() => {
        if (selectedProjectId && auth.isAuthenticated) {
            fetchHistoryStories();
        } else {
            setHistoryStories([]);
            setActiveStoryKey('');
            setSelectedStoryRuns([]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedProjectId, auth.isAuthenticated, auth.user?.access_token]);

    // Breakpoint visibility handling
    const [trackedNarrow, setTrackedNarrow] = useState(isDownMd);
    if (isDownMd !== trackedNarrow) {
        setTrackedNarrow(isDownMd);
        setColVis(isDownMd ? NARROW_HIDDEN_COLUMNS : {});
    }

    const handleCancel = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsGenerating(false);
            setStreamText((prev) => (prev ? `${prev}\n\n[Cancelled]` : '[Cancelled]'));
        }
    };

    const handleGenerate = async () => {
        if (!form.requirement.trim()) return;
        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setIsGenerating(true);
        setError(null);
        setStreamText('');
        setGenSeconds(null);
        setHistoryWarning(null);
        const startedAt = performance.now();
        try {
            const results = await generateTestCases({
                requirement: form.requirement,
                requirementHistory,
                businessRules: form.businessRules,
                regressionContext: form.regressionContext,
                techDetails: form.techDetails,
                onToken: (_token, full) => setStreamText(full),
                signal: controller.signal,
            });

            const count = results.length;
            let reindexedResults = [];
            setTestCases((prev) => {
                const startAt = maxFtNumber(prev);
                reindexedResults = results.map((tc, idx) => ({ ...tc, id: ftId(startAt + idx + 1) }));
                return [...prev, ...reindexedResults];
            });
            setRequirementHistory((prev) => [...prev, form.requirement]);
            setLastBatchCount(count);
            setGenSeconds((performance.now() - startedAt) / 1000);
            notify.success(`Generated ${count} test case${count === 1 ? '' : 's'}`);
            setStep(stepIndex('review'));

            // Auto-save history run to backend
            const activeStoryKey = (form.sourceType === 'jira' ? form.jiraKey?.trim() : form.manualStoryKey?.trim()) ||
                form.requirement.trim().split(/\s+/).slice(0, 4).join(' ').replace(/[^a-zA-Z0-9 ]/g, '').trim() ||
                `Manual Run - ${new Date().toLocaleDateString()}`;

            if (selectedProjectId && api) {
                try {
                    const response = await api.post('/api/testcase-history', {
                        project_id: selectedProjectId,
                        story_key: activeStoryKey,
                        story_description: form.requirement,
                        business_rules: form.businessRules,
                        regression_context: form.regressionContext,
                        tech_details: form.techDetails,
                        test_cases: reindexedResults
                    });
                    if (response?.warning) {
                        setHistoryWarning(response.warning);
                    }
                    fetchHistoryStories();
                } catch (saveErr) {
                    console.error('[History Save Error]', saveErr);
                }
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                notify.info('Generation cancelled');
            } else {
                setError(err.message);
                notify.error(`Generation failed: ${err.message}`);
            }
        } finally {
            if (abortControllerRef.current === controller) {
                setIsGenerating(false);
                abortControllerRef.current = null;
            }
        }
    };

    const handleClearContext = () => {
        setRequirementHistory([]);
        setTestCases([]);
        setForm(EMPTY_FORM);
        setStreamText('');
        setGenSeconds(null);
        setLastBatchCount(0);
        setRaisedBugs({});
        notify.info('Context cleared');
    };

    // ---------- Review grid ----------
    const handleAddTestCase = () => {
        let assigned;
        setTestCases((prev) => {
            assigned = ftId(maxFtNumber(prev) + 1);
            return [...prev, {
                id: assigned,
                module: '',
                feature: '',
                scenario: '',
                preconditions: '',
                testData: '',
                steps: [],
                expectedResult: '',
                priority: 'P3-Medium',
                platform: '',
                testType: 'Functional',
            }];
        });
        notify.info(`${assigned} added — double-click a cell to edit it`);
    };

    const processRowUpdate = (newRow) => {
        setTestCases((prev) => prev.map((tc) => (tc.id === newRow.id ? { ...tc, ...newRow } : tc)));
        return newRow;
    };

    // ---------- JIRA defect logging (per test case) ----------
    const openDefectDialog = (tc) => {
        setDefectTarget(tc);
        setActualResult(`Actual outcome deviated from expected: "${tc.expectedResult}"`);
    };

    const recordBug = (tcId, entry) => setRaisedBugs((prev) => {
        const current = Array.isArray(prev[tcId]) ? prev[tcId] : [];
        return { ...prev, [tcId]: [...current.filter((b) => b.success), entry] };
    });

    const handleRaiseDefect = async () => {
        if (!defectTarget) return;
        const tc = defectTarget;
        const tcId = tc.id;
        setDefectTarget(null);
        setIsRaising((prev) => ({ ...prev, [tcId]: true }));

        if (!auth.user?.access_token) {
            console.warn('Defect integration unavailable – not logged in');
            recordBug(tcId, { success: false, error: 'Not authenticated' });
            setIsRaising((prev) => ({ ...prev, [tcId]: false }));
            return;
        }
        try {
            const data = await api.post('/api/jira/defect', {
                testCase: tc,
                actualResult,
                projectName: selectedProject?.name || 'AAQUA Quality Run',
            });
            recordBug(tcId, { success: true, key: data.jiraKey });
            notify.success(`Defect ${data.jiraKey} raised for ${tcId}`);
        } catch (err) {
            console.error('[Raise Defect Error]', err);
            const msg = err?.data?.error || err.message || 'Unknown error';
            recordBug(tcId, { success: false, error: msg });
            notify.error(`Failed to raise defect for ${tcId}: ${msg}`);
        } finally {
            setIsRaising((prev) => ({ ...prev, [tcId]: false }));
        }
    };

    const columns = useMemo(() => {
        const multiline = {
            editable: true,
            renderEditCell: (params) => <MultilineEditCell {...params} />,
        };
        return [
            { field: 'id', headerName: 'ID', width: 100, editable: false },
            { field: 'module', headerName: 'Module', flex: 0.6, minWidth: 120, editable: true },
            {
                field: 'scenario',
                headerName: 'Scenario',
                flex: 1.2,
                minWidth: 200,
                ...multiline,
            },
            { field: 'preconditions', headerName: 'Preconditions', flex: 1, minWidth: 160, ...multiline },
            { field: 'testData', headerName: 'Test Data', flex: 1, minWidth: 150, ...multiline },
            {
                field: 'steps',
                headerName: 'Test Steps',
                flex: 1.4,
                minWidth: 220,
                ...multiline,
                valueGetter: (value, row) => (Array.isArray(row?.steps) ? row.steps.join('\n') : (row?.steps || '')),
                valueSetter: (value, row) => ({ ...row, steps: String(value ?? '').split('\n') }),
            },
            { field: 'expectedResult', headerName: 'Expected Result', flex: 1, minWidth: 180, ...multiline },
            {
                field: 'priority',
                headerName: 'Priority',
                width: 130,
                editable: true,
                renderCell: (params) => (params.value
                    ? <Chip size="small" label={params.value} color={priorityColor(params.value)} variant="outlined" />
                    : null),
            },
            {
                field: 'testType',
                headerName: 'Type',
                width: 130,
                editable: true,
                valueGetter: (value, row) => row?.testType || 'Functional',
            },
            { field: 'platform', headerName: 'Platform', width: 110, editable: true },
            {
                field: '__jira',
                headerName: 'Jira Integration',
                width: 200,
                sortable: false,
                filterable: false,
                renderCell: (params) => {
                    const tcId = params.row.id;
                    const bugs = Array.isArray(raisedBugs[tcId]) ? raisedBugs[tcId] : [];
                    const busy = !!isRaising[tcId];
                    return (
                        <Stack direction="row" spacing={0.5} sx={{ height: '100%', alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}>
                            {bugs.map((bug, i) => (bug.success
                                ? <Chip key={i} size="small" color="success" variant="outlined" label={bug.key} />
                                : <Chip key={i} size="small" color="error" variant="outlined" label={`Err: ${bug.error}`} title={bug.error} />
                            ))}
                            <Button
                                size="small"
                                color="error"
                                startIcon={<BugReportIcon fontSize="small" />}
                                disabled={busy || !auth.user}
                                onClick={() => openDefectDialog(params.row)}
                            >
                                {busy ? 'Logging…' : (bugs.some((b) => b.success) ? 'Log another' : 'Log Bug')}
                            </Button>
                        </Stack>
                    );
                },
            },
        ];
    }, [raisedBugs, isRaising, auth.user]);

    // ---------- Exports ----------
    const handleExportExcel = () => {
        const rows = testCases.map((tc) => ({
            'Test Case ID': tc.id,
            'Module': tc.module || '',
            'Feature': tc.feature || '',
            'Scenario': tc.scenario || '',
            'Test Type': tc.testType || 'Functional',
            'Priority': tc.priority || '',
            'Platform': tc.platform || '',
            'Preconditions': tc.preconditions || 'None',
            'Test Data': tc.testData || 'N/A',
            'Test Steps': Array.isArray(tc.steps) ? tc.steps.join('\n') : (tc.steps || ''),
            'Expected Result': tc.expectedResult || '',
        }));
        exportToExcel(rows, 'Functional_Test_Cases', 'Test Cases');
    };
    const handleExportJSON = () => exportToJSON(testCases);

    const inputStep = (
        <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Transform your requirements into comprehensive functional test cases instantly.
            </Typography>

            {historyWarning && (
                <Alert
                    severity="warning"
                    sx={{ mb: 2 }}
                    onClose={() => setHistoryWarning(null)}
                >
                    {historyWarning}
                </Alert>
            )}

            <Grid container spacing={3}>
                <Grid item xs={12} lg={8}>
                    <RequirementInput
                        values={form}
                        onChange={setField}
                        isGenerating={isGenerating}
                        contextCount={requirementHistory.length}
                        onClearContext={handleClearContext}
                    />
                </Grid>
                <Grid item xs={12} lg={4}>
                    <Paper
                        variant="outlined"
                        sx={{
                            p: 2,
                            height: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            minHeight: 380,
                            bgcolor: 'background.paper',
                            borderRadius: 2,
                        }}
                    >
                        <Stack direction="row" alignItems="center" spacing={1} sx={{ pb: 1, mb: 1, borderBottom: 1, borderColor: 'divider' }}>
                            <HistoryIcon fontSize="small" color="primary" />
                            <Typography variant="subtitle1" fontWeight={600}>
                                Saved Stories History
                            </Typography>
                        </Stack>

                        <Alert severity="info" sx={{ mb: 1.5, py: 0.5, '& .MuiAlert-message': { fontSize: '0.75rem' } }}>
                            Up to 10 runs are stored per User Story. The 11th run automatically deletes the oldest.
                        </Alert>

                        {isLoadingHistory ? (
                            <Box sx={{ textAlign: 'center', py: 4, color: 'text.secondary', fontSize: '0.85rem' }}>
                                Loading history…
                            </Box>
                        ) : historyStories.length === 0 ? (
                            <Box sx={{ textAlign: 'center', py: 4, color: 'text.secondary', fontSize: '0.85rem' }}>
                                No history saved yet. Generated runs will appear here automatically.
                            </Box>
                        ) : (
                            <Stack spacing={1} sx={{ overflowY: 'auto', flex: 1, maxHeight: 420 }}>
                                {historyStories.map((story) => {
                                    const isExpanded = activeStoryKey === story.storyKey;
                                    return (
                                        <Box
                                            key={story.storyKey}
                                            sx={{
                                                border: 1,
                                                borderColor: 'divider',
                                                borderRadius: 1,
                                                bgcolor: isExpanded ? 'action.hover' : 'transparent',
                                                overflow: 'hidden',
                                            }}
                                        >
                                            <Stack
                                                direction="row"
                                                alignItems="center"
                                                justifyContent="space-between"
                                                sx={{ p: 1, cursor: 'pointer' }}
                                                onClick={() => (isExpanded ? setActiveStoryKey('') : fetchStoryRuns(story.storyKey))}
                                            >
                                                <Stack direction="row" alignItems="center" spacing={0.5} sx={{ overflow: 'hidden', flex: 1 }}>
                                                    {isExpanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                                                    <Box sx={{ overflow: 'hidden' }}>
                                                        <Typography variant="body2" fontWeight={600} noWrap title={story.storyKey}>
                                                            {story.storyKey}
                                                        </Typography>
                                                        <Typography variant="caption" color="text.secondary" noWrap display="block">
                                                            {story.description}
                                                        </Typography>
                                                    </Box>
                                                </Stack>
                                                <Stack direction="row" alignItems="center" spacing={1} sx={{ ml: 1 }}>
                                                    <Chip size="small" label={story.runCount} sx={{ height: 20, fontSize: '0.7rem' }} />
                                                    <Button
                                                        size="small"
                                                        color="error"
                                                        sx={{ minWidth: 'auto', p: 0.5 }}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDeleteStory(story.storyKey);
                                                        }}
                                                        title="Delete Story History"
                                                    >
                                                        <DeleteOutlineIcon fontSize="small" />
                                                    </Button>
                                                </Stack>
                                            </Stack>

                                            {isExpanded && (
                                                <Box sx={{ bgcolor: 'action.selected', borderTop: 1, borderColor: 'divider', p: 1 }}>
                                                    {selectedStoryRuns.length === 0 ? (
                                                        <Typography variant="caption" color="text.secondary" align="center" display="block">
                                                            Loading runs…
                                                        </Typography>
                                                    ) : (
                                                        <Stack spacing={0.5}>
                                                            {selectedStoryRuns.map((run, runIdx) => (
                                                                <Stack
                                                                    key={run.id}
                                                                    direction="row"
                                                                    alignItems="center"
                                                                    justifyContent="space-between"
                                                                    sx={{ fontSize: '0.75rem' }}
                                                                >
                                                                    <Typography
                                                                        variant="caption"
                                                                        onClick={() => handleLoadRun(run)}
                                                                        sx={{
                                                                            cursor: 'pointer',
                                                                            color: 'primary.main',
                                                                            textDecoration: 'underline',
                                                                            overflow: 'hidden',
                                                                            textOverflow: 'ellipsis',
                                                                            whiteSpace: 'nowrap',
                                                                            flex: 1,
                                                                        }}
                                                                        title="Click to load these test cases"
                                                                    >
                                                                        Run {selectedStoryRuns.length - runIdx} ({new Date(run.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})
                                                                    </Typography>
                                                                    <Button
                                                                        size="small"
                                                                        color="inherit"
                                                                        sx={{ minWidth: 'auto', p: 0.25, color: 'text.secondary', '&:hover': { color: 'error.main' } }}
                                                                        onClick={() => handleDeleteRun(run.id, story.storyKey)}
                                                                        title="Delete this run"
                                                                    >
                                                                        ×
                                                                    </Button>
                                                                </Stack>
                                                            ))}
                                                        </Stack>
                                                    )}
                                                </Box>
                                            )}
                                        </Box>
                                    );
                                })}
                            </Stack>
                        )}
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );

    const generateStep = (
        <Box>
            <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
                <Button
                    variant="contained"
                    startIcon={<AutoAwesomeIcon />}
                    onClick={handleGenerate}
                    disabled={isGenerating || !form.requirement.trim()}
                >
                    {isGenerating
                        ? 'Analyzing & Generating…'
                        : (testCases.length > 0 ? 'Generate More Test Cases' : 'Generate Test Cases')}
                </Button>
                {isGenerating && (
                    <Button variant="outlined" color="error" onClick={handleCancel}>Cancel</Button>
                )}
            </Stack>
            {error && (
                <Alert
                    severity="error"
                    sx={{ mb: 2 }}
                    action={<Button color="inherit" size="small" onClick={handleGenerate}>Retry</Button>}
                >
                    {error}
                </Alert>
            )}
            {!isGenerating && genSeconds != null && (
                <Alert severity="success" sx={{ mb: 2 }}>
                    Generated {lastBatchCount} test case{lastBatchCount === 1 ? '' : 's'} in {fmtDuration(genSeconds)}
                </Alert>
            )}
            <GenerationProgress streamText={streamText || null} onRetry={handleGenerate} />
        </Box>
    );

    const reviewStep = (
        <Box>
            {auth.isLoading && <Alert severity="info" sx={{ mb: 2 }}>Loading authentication…</Alert>}
            {auth.error && <Alert severity="error" sx={{ mb: 2 }}>Authentication error: {auth.error.message}</Alert>}
            {!auth.isLoading && !auth.user && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                    You are not logged in – defect integration is disabled.
                </Alert>
            )}

            <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                <Typography variant="h6" sx={{ mr: 'auto' }}>
                    Generated Test Cases <Chip size="small" label={`${testCases.length} Cases`} sx={{ ml: 1 }} />
                </Typography>
                <Button
                    size="small"
                    startIcon={expandRows ? <UnfoldLessIcon /> : <UnfoldMoreIcon />}
                    onClick={() => setExpandRows((v) => !v)}
                >
                    {expandRows ? 'Collapse rows' : 'Expand rows'}
                </Button>
                <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={handleAddTestCase}>
                    Add Test Case
                </Button>
            </Stack>

            {testCases.length === 0 ? (
                <Alert severity="info">No test cases yet — generate some on the previous step.</Alert>
            ) : (
                <Box sx={{ height: 600, width: '100%' }}>
                    <DataGrid
                        rows={testCases}
                        columns={columns}
                        getRowId={(row) => row.id}
                        disableRowSelectionOnClick
                        processRowUpdate={processRowUpdate}
                        onProcessRowUpdateError={(err) => notify.error(`Could not save edit: ${err.message}`)}
                        columnVisibilityModel={colVis}
                        onColumnVisibilityModelChange={setColVis}
                        getRowHeight={expandRows ? () => 'auto' : undefined}
                        initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
                        pageSizeOptions={[10, 25, 50, 100]}
                        sx={expandRows ? {
                            '& .MuiDataGrid-cell': {
                                whiteSpace: 'normal',
                                wordBreak: 'break-word',
                                alignItems: 'flex-start',
                                py: 1,
                            },
                        } : undefined}
                    />
                </Box>
            )}

            <RaiseDefectDialog
                target={defectTarget}
                projectName={selectedProject?.name || 'AAQUA Default Context'}
                actualResult={actualResult}
                onChange={setActualResult}
                onSubmit={handleRaiseDefect}
                onClose={() => setDefectTarget(null)}
            />
        </Box>
    );

    const exportStep = (
        <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {testCases.length} test case{testCases.length === 1 ? '' : 's'} ready to export or attach to a JIRA story.
            </Typography>
            <ExportControls
                onExportExcel={handleExportExcel}
                onExportJSON={handleExportJSON}
                testCases={testCases}
                disabled={isGenerating || testCases.length === 0}
            />
        </Box>
    );

    const stepDefs = {
        input: { label: 'Input', content: inputStep, canAdvance: form.requirement.trim().length > 0 },
        generate: { label: 'Generate', content: generateStep, canAdvance: testCases.length > 0 },
        review: { label: 'Review', content: reviewStep, canAdvance: testCases.length > 0 },
        export: { label: 'Export', content: exportStep },
    };
    const steps = STEP_ORDER.map((key) => ({ key, ...stepDefs[key] }));

    return (
        <ToolWorkflow
            title="Functional Test Generator"
            steps={steps}
            activeStep={step}
            onStepChange={setStep}
        />
    );
};

export default TestGenerator;
