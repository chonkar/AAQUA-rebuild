import { Box, Button, Paper, Step, StepLabel, Stepper, Typography, useMediaQuery } from '@mui/material'
import { useTheme } from '@mui/material/styles'

/**
 * ToolWorkflow — shared wizard frame every tool page adopts
 * (Input -> Configure -> Generate -> Review -> Export).
 *
 * Contract (locked — do not add props, this is consumed by every pilot page):
 * - Controlled component: `activeStep` and `onStepChange` are owned by the
 *   parent. This component never holds its own step state.
 * - Each step's `content` unmounts when the step changes (only the current
 *   step's content is rendered) — any state that must survive navigating
 *   away and back (form input, generated results, etc.) must live in the
 *   parent, not inside the step's `content` element.
 * - `canAdvance` disables the Next button only when it is strictly `false`.
 *   Omitting it (undefined) or any other value means "advance is allowed".
 * - `key` must be unique per step (used as the React list key and stepper
 *   identity) — duplicate keys produce undefined stepper behavior.
 * - `autoAdvanceWhen` is a reserved field in the step shape for future use.
 *   This frame does NOT read or act on it. A page that wants
 *   auto-advance-on-condition behavior implements it itself (e.g. a
 *   `useEffect` watching its own generation state that calls
 *   `onStepChange(next)` when ready) — the frame stays a dumb, controlled
 *   shell.
 * - Out-of-range `activeStep` (negative or >= steps.length) is clamped to
 *   the nearest valid index rather than crashing; an empty `steps` array
 *   renders nothing.
 */
export default function ToolWorkflow({ title, steps, activeStep, onStepChange }) {
  const mui = useTheme()
  const isMobile = useMediaQuery(mui.breakpoints.down('sm'))

  if (!steps?.length) return null

  const idx = Math.min(Math.max(activeStep, 0), steps.length - 1)
  if (process.env.NODE_ENV !== 'production' && activeStep !== idx) {
    console.warn(`ToolWorkflow: activeStep (${activeStep}) out of range, clamped to ${idx}`)
  }

  const current = steps[idx]
  const isLast = idx === steps.length - 1

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Typography variant="h1" component="h1" sx={{ mb: 2 }}>{title}</Typography>
      <Stepper
        activeStep={idx}
        alternativeLabel={!isMobile}
        orientation={isMobile ? 'vertical' : 'horizontal'}
        sx={{ mb: 3 }}
      >
        {steps.map((s) => (
          <Step key={s.key}>
            <StepLabel>{s.label}</StepLabel>
          </Step>
        ))}
      </Stepper>
      <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, mb: 2 }}>
        {current.content}
      </Paper>
      <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
        <Button disabled={idx === 0} onClick={() => onStepChange(idx - 1)}>Back</Button>
        {!isLast && (
          <Button
            variant="contained"
            disabled={current.canAdvance === false}
            onClick={() => onStepChange(idx + 1)}
          >
            Next
          </Button>
        )}
      </Box>
    </Box>
  )
}
