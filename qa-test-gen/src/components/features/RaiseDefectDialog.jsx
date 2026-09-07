import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    TextField,
    Typography,
} from '@mui/material';

/**
 * Raise-a-JIRA-defect dialog for a single test case.
 *
 * Presentational only — the hosting page owns `target`, the actual-result draft
 * and the submit call, so the dialog can be dropped into any tool page that
 * has a per-row "Log Bug" action without dragging state along with it.
 *
 * @param {Object} props
 * @param {Object|null} props.target - The test case being reported; also acts as the open trigger.
 * @param {boolean} [props.open] - Defaults to `!!target`.
 * @param {string} props.projectName - Project context shown to the reporter and sent with the defect.
 * @param {string} props.actualResult - Current draft of the failure description.
 * @param {(value: string) => void} props.onChange
 * @param {() => void} props.onSubmit
 * @param {() => void} props.onClose
 */
export default function RaiseDefectDialog({
    target,
    open,
    projectName,
    actualResult,
    onChange,
    onSubmit,
    onClose,
}) {
    return (
        <Dialog open={open ?? !!target} onClose={onClose} fullWidth maxWidth="sm">
            <DialogTitle>Raise JIRA Defect ticket for {target?.id}</DialogTitle>
            <DialogContent>
                <Typography variant="caption" color="text.secondary">Test Case Scenario</Typography>
                <Typography variant="body2" sx={{ fontWeight: 600, mb: 2 }}>{target?.scenario}</Typography>
                <Typography variant="caption" color="text.secondary">Target Project Context</Typography>
                <Typography variant="body2" color="primary" sx={{ fontWeight: 600, mb: 2 }}>
                    {projectName}
                </Typography>
                <TextField
                    label="Execution Failure Reason / Actual Result"
                    placeholder="Describe what went wrong in detail..."
                    multiline
                    minRows={4}
                    fullWidth
                    value={actualResult}
                    onChange={(e) => onChange(e.target.value)}
                />
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="contained" onClick={onSubmit}>Raise Defect</Button>
            </DialogActions>
        </Dialog>
    );
}
