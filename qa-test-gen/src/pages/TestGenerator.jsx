import { useMemo, useRef, useState } from 'react';
import { useAuth } from 'react-oidc-context';
import {
    Alert,
    Box,
    Button,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
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
import ToolWorkflow from '../components/workflow/ToolWorkflow';
import GenerationProgress from '../components/workflow/GenerationProgress';
import RequirementInput from '../components/features/RequirementInput';
import ExportControls from '../components/features/ExportControls';
import { useNotify } from '../components/common/NotificationProvider';
import { useProject } from '../context/ProjectContext';
import { createApiClient } from '../utils/apiClient';
import { generateTestCases } from '../services/testCaseGenerationService';
import { exportToExcel, exportToJSON } from '../utils/exportUtils';

const STEP_INPUT = 0;
const STEP_REVIEW = 2;

// Format an elapsed-seconds value as "12.3s" or "1m 05s".
const fmtDuration = (s) => {
    if (s == null) return '';
    if (s >= 60) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
    return `${s.toFixed(1)}s`;
};

// Columns hidden below the md breakpoint — the long-form context fields are
// the first to go so the narrow layout keeps ID/scenario/steps/result legible.
const NARROW_HIDDEN_COLUMNS = { preconditions: false, testData: false, testType: false, platform: false };

const EMPTY_FORM = { requirement: '', businessRules: '', regressionContext: '', techDetails: '' };

const ftId = (n) => `FT_${String(n).padStart(3, '0')}`;

// Highest FT_nnn sequence number already present, so appended batches continue
// the numbering instead of colliding with earlier ones.
const maxFtNumber = (rows) => rows.reduce((max, tc) => {
    if (!tc?.id || !String(tc.id).startsWith('FT_')) return max;
    const num = parseInt(String(tc.id).replace('FT_', ''), 10);
    return !isNaN(num) && num > max ? num : max;
}, 0);

// The grid keys rows by `id`; a model that omits it (or a hand-added row) gets
// a generated one here so DataGrid never sees an undefined row id.
const withRowIds = (rows) => {
    let next = maxFtNumber(rows);
    return rows.map((tc) => (tc?.id ? tc : { ...tc, id: ftId(++next) }));
};

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
    const { selectedProject } = useProject();
    const mui = useTheme();
    const isDownMd = useMediaQuery(mui.breakpoints.down('md'));

    // Every piece of user-visible state lives here, not inside a step's
    // content: ToolWorkflow unmounts the previous step on navigation, so
    // anything held below this component would be lost on Back/Next.
    const [step, setStep] = useState(STEP_INPUT);
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

    const api = createApiClient(() => auth.user?.access_token);
    const setField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

    // Low-priority columns collapse on narrow viewports rather than forcing a
    // horizontal scroll through eleven columns. Applied with React's documented
    // "adjusting state during render" pattern (not an effect) so the grid never
    // paints one frame with the wrong column set; the user's own toggles via
    // onColumnVisibilityModelChange survive until the breakpoint actually flips.
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

            // Continue the FT_ numbering from whatever is already in the table,
            // so a second generation appends instead of overwriting.
            const startAt = maxFtNumber(testCases);
            const appended = results.map((tc, idx) => ({ ...tc, id: ftId(startAt + idx + 1) }));
            setTestCases([...testCases, ...appended]);
            setRequirementHistory([...requirementHistory, form.requirement]);
            setLastBatchCount(appended.length);
            setGenSeconds((performance.now() - startedAt) / 1000);
            notify.success(`Generated ${appended.length} test case${appended.length === 1 ? '' : 's'}`);
            setStep(STEP_REVIEW);
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
        const next = ftId(maxFtNumber(testCases) + 1);
        setTestCases([...testCases, {
            id: next,
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
        }]);
        notify.info(`${next} added — double-click a cell to edit it`);
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
                projectName: selectedProject?.name || 'AAUQA Quality Run',
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

    // ---------- Exports (formats unchanged from the legacy page) ----------
    // Map to an ordered, human-labeled "Test Cases" sheet so a first-time
    // reviewer can read it top-to-bottom (ID → context → detailed steps → result).
    const handleExportExcel = () => {
        const rows = testCases.map((tc, i) => ({
            'Test Case ID': tc.id || ftId(i + 1),
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

    const rows = useMemo(() => withRowIds(testCases), [testCases]);

    const inputStep = (
        <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Transform your requirements into comprehensive functional test cases instantly.
            </Typography>
            <RequirementInput
                values={form}
                onChange={setField}
                showSubmit={false}
                isGenerating={isGenerating}
                contextCount={requirementHistory.length}
                onClearContext={handleClearContext}
            />
        </>
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
                        rows={rows}
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

            <Dialog open={!!defectTarget} onClose={() => setDefectTarget(null)} fullWidth maxWidth="sm">
                <DialogTitle>Raise JIRA Defect ticket for {defectTarget?.id}</DialogTitle>
                <DialogContent>
                    <Typography variant="caption" color="text.secondary">Test Case Scenario</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600, mb: 2 }}>{defectTarget?.scenario}</Typography>
                    <Typography variant="caption" color="text.secondary">Target Project Context</Typography>
                    <Typography variant="body2" color="primary" sx={{ fontWeight: 600, mb: 2 }}>
                        {selectedProject?.name || 'AAUQA Default Context'}
                    </Typography>
                    <TextField
                        label="Execution Failure Reason / Actual Result"
                        placeholder="Describe what went wrong in detail..."
                        multiline
                        minRows={4}
                        fullWidth
                        value={actualResult}
                        onChange={(e) => setActualResult(e.target.value)}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDefectTarget(null)}>Cancel</Button>
                    <Button variant="contained" onClick={handleRaiseDefect}>Raise Defect</Button>
                </DialogActions>
            </Dialog>
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

    const steps = [
        { key: 'input', label: 'Input', content: inputStep, canAdvance: form.requirement.trim().length > 0 },
        { key: 'generate', label: 'Generate', content: generateStep, canAdvance: testCases.length > 0 },
        { key: 'review', label: 'Review', content: reviewStep, canAdvance: testCases.length > 0 },
        { key: 'export', label: 'Export', content: exportStep },
    ];

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
