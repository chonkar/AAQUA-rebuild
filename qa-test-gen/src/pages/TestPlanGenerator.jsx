import { useMemo, useRef, useState } from 'react';
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
    ToggleButton,
    ToggleButtonGroup,
    Typography,
} from '@mui/material';
import ArticleIcon from '@mui/icons-material/Article';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import EditNoteIcon from '@mui/icons-material/EditNote';
import LinkIcon from '@mui/icons-material/Link';
import ToolWorkflow from '../components/workflow/ToolWorkflow';
import GenerationProgress from '../components/workflow/GenerationProgress';
import SafeHtml from '../components/common/SafeHtml';
import { useNotify } from '../components/common/NotificationProvider';
import { createApiClient } from '../utils/apiClient';
import { generateTestPlan, TEST_PLAN_SECTIONS } from '../services/testPlanService';
import { asBlob } from 'html-docx-js-typescript';
import { downloadBlob } from '../utils/exportUtils';

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

// Escape a user-supplied value before interpolating it into the DOCX cover
// block's HTML. Only the client/project fields go through this — the generated
// plan itself is interpolated raw on purpose (see handleExportDocx).
const escapeHtml = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const EMPTY_FORM = { clientName: '', projectName: '', requirement: '' };

// The generated fragment is styled by the model with inline CSS for a light
// "document" look, so the preview sheet is pinned to white/dark-grey in both
// app themes (as the legacy page did with `.document-preview` and `!important`)
// rather than inheriting the dark app surface and rendering dark-on-dark.
// Table rules mirror the DOCX wrapper below so the preview matches the export.
const DOCUMENT_SX = {
    bgcolor: '#ffffff',
    color: '#333333',
    p: { xs: 2, md: 6 },
    minHeight: 480,
    overflowX: 'auto',
    '& h1, & h2, & h3, & h4, & p, & li, & td, & th, & span, & div': { color: '#333333' },
    '& table': { borderCollapse: 'collapse', width: '100%', margin: '20px 0' },
    '& th, & td': { border: '1px solid #ddd', padding: '8px', textAlign: 'left' },
    '& th': { backgroundColor: '#f2f2f2' },
};

const TestPlanGenerator = () => {
    const notify = useNotify();
    const auth = useAuth();

    // Every piece of user-visible state lives here, not inside a step's
    // content: ToolWorkflow unmounts the previous step on navigation, so
    // anything held below this component (the JIRA key being typed, the
    // generated plan, the stream buffer) would be lost on Back/Next.
    // Index into STEP_ORDER; jumps elsewhere go through stepIndex(key).
    const [step, setStep] = useState(stepIndex('input'));
    const [form, setForm] = useState(EMPTY_FORM);
    const [sourceType, setSourceType] = useState('manual'); // 'manual' | 'jira'
    const [jiraKey, setJiraKey] = useState('');
    const [isFetchingJira, setIsFetchingJira] = useState(false);
    const [jiraError, setJiraError] = useState(null);
    const [generatedPlan, setGeneratedPlan] = useState(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [streamText, setStreamText] = useState('');
    const [error, setError] = useState(null);
    const [genSeconds, setGenSeconds] = useState(null);
    const abortControllerRef = useRef(null);

    const api = createApiClient(() => auth.user?.access_token);
    const setField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

    const { clientName, projectName, requirement } = form;
    const isFormComplete = Boolean(clientName.trim() && projectName.trim() && requirement.trim());
    const docxFileName = `${(clientName.trim() || 'Client').replace(/\s+/g, '_')}_TestPlan.docx`;

    // Heading count is a cheap "did the model actually emit the eight sections"
    // signal for the reviewer. Deliberately reported as a neutral count rather
    // than a pass/fail gate: the model is free to use h1/h3 for sections and
    // sub-sections, so any threshold check would raise false alarms.
    const headingCount = useMemo(
        () => (generatedPlan ? (generatedPlan.match(/<h[1-3][\s>]/gi) || []).length : 0),
        [generatedPlan],
    );

    const handleFetchJiraStory = async () => {
        if (!jiraKey.trim()) return;
        setIsFetchingJira(true);
        setJiraError(null);
        try {
            const data = await api.get(`/api/jira/story/${encodeURIComponent(jiraKey.trim())}`);
            if (data?.story?.description) {
                setField('requirement', data.story.description);
                notify.success(`Imported requirements from ${jiraKey.trim()}`);
            } else {
                throw new Error('Jira story fetched, but no description or requirements found in it.');
            }
        } catch (err) {
            console.error('[Jira Fetch Error]', err);
            setJiraError(err.message);
            notify.error(`Jira import failed: ${err.message}`);
        } finally {
            setIsFetchingJira(false);
        }
    };

    const handleCancel = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsGenerating(false);
            // Mark the pane so a half-streamed plan doesn't read as still running.
            setStreamText((prev) => (prev ? `${prev}\n\n[Cancelled]` : '[Cancelled]'));
        }
    };

    const handleGenerate = async () => {
        if (!isFormComplete) {
            setError('All fields are required.');
            return;
        }
        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setIsGenerating(true);
        setError(null);
        setStreamText('');
        setGenSeconds(null);
        const startedAt = performance.now();
        try {
            const planHtml = await generateTestPlan({
                clientName: clientName.trim(),
                projectName: projectName.trim(),
                requirement,
                onToken: (_token, full) => setStreamText(full),
                signal: controller.signal,
            });

            // Unlike the Test Case Generator (where an async batch merges into a
            // table the user may have edited mid-run, so its updater must be
            // functional), a plan is one document that wholly replaces the
            // previous one — there is no prior value to read, so a functional
            // updater here would be ceremony. The stale-run hazard is instead
            // handled by aborting the previous controller above: a superseded
            // run throws AbortError out of streamLLM and never reaches this line.
            setGeneratedPlan(planHtml);
            setGenSeconds((performance.now() - startedAt) / 1000);
            notify.success('Test plan generated');
            setStep(stepIndex('review'));
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

    // ---------- DOCX export (conversion logic unchanged from the legacy page) ----------
    const handleExportDocx = async () => {
        if (!generatedPlan) return;

        try {
            // Wrap generated HTML in a standard document structure for better conversion.
            //
            // `generatedPlan` is interpolated RAW here, deliberately: sanitizing is a
            // render-time concern (the preview goes through SafeHtml), whereas
            // html-docx-js needs the full original markup — DOMPurify's html profile
            // would strip the <style> block and inline document styling the converter
            // relies on — and a .docx is not a browser execution context. The two
            // user-supplied cover fields ARE escaped, since they are the only values
            // a user could inject markup into this wrapper through.
            const fullHtml = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>Test Plan - ${escapeHtml(projectName)}</title>
                    <style>
                        body { font-family: 'Calibri', sans-serif; line-height: 1.5; color: #333; }
                        h1, h2, h3 { color: #2E4053; }
                        table { border-collapse: collapse; width: 100%; margin: 20px 0; }
                        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                        th { background-color: #f2f2f2; }
                    </style>
                </head>
                <body>
                    <h1 style="text-align: center; color: #1a237e;">Test Plan</h1>
                    <p style="text-align: center; font-size: 1.2em;"><strong>Client:</strong> ${escapeHtml(clientName)}</p>
                    <p style="text-align: center; font-size: 1.2em;"><strong>Project:</strong> ${escapeHtml(projectName)}</p>
                    <hr/>
                    ${generatedPlan}
                </body>
                </html>
            `;

            const blob = await asBlob(fullHtml);
            const docxBlob = new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
            await downloadBlob(docxBlob, docxFileName);
            notify.success(`Downloaded ${docxFileName}`);
        } catch (err) {
            console.error('Export Error:', err);
            setError('Failed to export document.');
            notify.error('Failed to export document.');
        }
    };

    const handleCopyHtml = async () => {
        if (!generatedPlan) return;
        try {
            await navigator.clipboard.writeText(generatedPlan);
            notify.success('Plan HTML copied to clipboard');
        } catch (err) {
            // Clipboard access needs a secure context and can be denied outright.
            console.error('[Copy Error]', err);
            notify.error('Could not copy to clipboard — copy manually from the preview.');
        }
    };

    // ---------- Steps ----------
    const inputStep = (
        <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Create professional, standard-compliant ISTQB test strategy documents.
            </Typography>

            <Grid container spacing={2} sx={{ mb: 3 }}>
                <Grid size={{ xs: 12, md: 6 }}>
                    <TextField
                        label="Client Name"
                        fullWidth
                        value={clientName}
                        onChange={(e) => setField('clientName', e.target.value)}
                        placeholder="e.g. Acme Corp"
                        disabled={isGenerating}
                    />
                </Grid>
                <Grid size={{ xs: 12, md: 6 }}>
                    <TextField
                        label="Project Name"
                        fullWidth
                        value={projectName}
                        onChange={(e) => setField('projectName', e.target.value)}
                        placeholder="e.g. E-Commerce Revamp"
                        disabled={isGenerating}
                    />
                </Grid>
            </Grid>

            <ToggleButtonGroup
                exclusive
                size="small"
                value={sourceType}
                onChange={(_e, next) => next && setSourceType(next)}
                aria-label="Requirement source"
                sx={{ mb: 2 }}
            >
                <ToggleButton value="manual" aria-label="Manual input">
                    <EditNoteIcon fontSize="small" sx={{ mr: 0.75 }} /> Manual Input
                </ToggleButton>
                <ToggleButton value="jira" aria-label="JIRA story integration">
                    <LinkIcon fontSize="small" sx={{ mr: 0.75 }} /> JIRA Story Integration
                </ToggleButton>
            </ToggleButtonGroup>

            {sourceType === 'jira' && (
                <Paper variant="outlined" sx={{ p: 2, mb: 2, borderStyle: 'dashed' }}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' } }}>
                        <TextField
                            label="JIRA Issue Key"
                            placeholder="e.g. QA-123"
                            fullWidth
                            value={jiraKey}
                            onChange={(e) => setJiraKey(e.target.value)}
                            disabled={isFetchingJira}
                        />
                        <Button
                            variant="outlined"
                            startIcon={<CloudDownloadIcon />}
                            onClick={handleFetchJiraStory}
                            disabled={isFetchingJira || !jiraKey.trim()}
                            sx={{ whiteSpace: 'nowrap' }}
                        >
                            {isFetchingJira ? 'Fetching…' : 'Fetch Story Description'}
                        </Button>
                    </Stack>
                    {jiraError && <Alert severity="error" sx={{ mt: 2 }}>{jiraError}</Alert>}
                </Paper>
            )}

            <TextField
                label="Project Requirements / Scope"
                fullWidth
                multiline
                minRows={6}
                value={requirement}
                onChange={(e) => setField('requirement', e.target.value)}
                placeholder="Describe the project scope, key features, and objectives..."
                disabled={isGenerating}
                helperText={sourceType === 'jira'
                    ? 'Fetched text lands here and stays editable before you generate.'
                    : 'Client name, project name and scope are all required.'}
            />
        </Box>
    );

    const generateStep = (
        <Box>
            <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
                <Button
                    variant="contained"
                    startIcon={<ArticleIcon />}
                    onClick={handleGenerate}
                    disabled={isGenerating || !isFormComplete}
                >
                    {isGenerating
                        ? 'Generating Plan…'
                        : (generatedPlan ? 'Regenerate Test Plan' : 'Generate Test Plan')}
                </Button>
                {isGenerating && (
                    <Button variant="outlined" color="error" onClick={handleCancel}>Cancel</Button>
                )}
            </Stack>

            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Sections generated: {TEST_PLAN_SECTIONS.join(' · ')}
            </Typography>

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
                    Test plan generated in {fmtDuration(genSeconds)}
                </Alert>
            )}
            <GenerationProgress streamText={streamText || null} onRetry={handleGenerate} />
        </Box>
    );

    const reviewStep = (
        <Box>
            <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                <Typography variant="h6" sx={{ mr: 'auto' }}>Plan Preview</Typography>
                {headingCount > 0 && <Chip size="small" label={`${headingCount} headings`} />}
                <Button
                    size="small"
                    variant="outlined"
                    startIcon={<DownloadIcon />}
                    onClick={handleExportDocx}
                    disabled={!generatedPlan}
                >
                    Download as Word Doc
                </Button>
            </Stack>

            {!generatedPlan ? (
                <Alert severity="info">No test plan yet — generate one on the previous step.</Alert>
            ) : (
                <Paper elevation={3} sx={DOCUMENT_SX}>
                    {/* Model-authored HTML — sanitized at render time by SafeHtml. */}
                    <SafeHtml html={generatedPlan} />
                </Paper>
            )}
        </Box>
    );

    const exportStep = (
        <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {generatedPlan
                    ? 'The plan is exported as a Word document with the client/project cover block prepended.'
                    : 'Generate a test plan first — there is nothing to export yet.'}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                <Button
                    variant="contained"
                    startIcon={<DownloadIcon />}
                    onClick={handleExportDocx}
                    disabled={isGenerating || !generatedPlan}
                >
                    Download as Word Doc
                </Button>
                <Button
                    variant="outlined"
                    startIcon={<ContentCopyIcon />}
                    onClick={handleCopyHtml}
                    disabled={isGenerating || !generatedPlan}
                >
                    Copy HTML
                </Button>
                {generatedPlan && (
                    <Typography variant="caption" color="text.secondary">{docxFileName}</Typography>
                )}
            </Stack>
            {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        </Box>
    );

    const stepDefs = {
        input: { label: 'Input', content: inputStep, canAdvance: isFormComplete },
        generate: { label: 'Generate', content: generateStep, canAdvance: !!generatedPlan },
        review: { label: 'Review', content: reviewStep, canAdvance: !!generatedPlan },
        export: { label: 'Export', content: exportStep },
    };
    const steps = STEP_ORDER.map((key) => ({ key, ...stepDefs[key] }));

    return (
        <ToolWorkflow
            title="ISTQB Test Plan Generator"
            steps={steps}
            activeStep={step}
            onStepChange={setStep}
        />
    );
};

export default TestPlanGenerator;
