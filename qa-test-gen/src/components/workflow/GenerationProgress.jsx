import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, LinearProgress, Paper, Typography } from '@mui/material'
import { subscribeToJob } from '../../utils/sseClient.js'

/**
 * GenerationProgress — Generate-step body for a ToolWorkflow page.
 *
 * Two (combinable) modes:
 * - job mode: pass `jobId` to subscribe to backend progress over SSE
 *   (phase label + determinate progress bar).
 * - LLM-stream mode: pass `streamText` (the caller's own accumulated
 *   streamed text) to render a live monospace output pane.
 */
export default function GenerationProgress({ jobId, streamText, onDone, onRetry }) {
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState('Starting…')
  const [error, setError] = useState(null)
  const streamRef = useRef(null)

  // Reset per-job state when jobId changes using React's documented
  // "adjusting state during render" pattern (a conditional setState call
  // during render, not inside an effect) — this avoids a visible frame of
  // stale progress/phase/error between subscriptions.
  const [trackedJobId, setTrackedJobId] = useState(jobId)
  if (jobId !== trackedJobId) {
    setTrackedJobId(jobId)
    setProgress(0)
    setPhase('Starting…')
    setError(null)
  }

  // onDone is read via a ref so a parent passing a fresh closure each render
  // doesn't force the effect below to resubscribe (which would drop and
  // re-open the SSE connection every render). The ref is synced in its own
  // effect (runs after render) rather than mutated during render.
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  })

  useEffect(() => {
    if (!jobId) return undefined
    return subscribeToJob(jobId, {
      onUpdate: (e) => {
        setProgress((p) => Math.max(p, e.progress ?? 0))
        if (e.phase) setPhase(e.phase)
      },
      onDone: (result) => {
        setProgress(100)
        onDoneRef.current?.(result)
      },
      onError: (msg) => setError(msg || 'Generation failed'),
    })
  }, [jobId])

  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [streamText])

  if (error) {
    return (
      <Alert
        severity="error"
        role="alert"
        action={onRetry && (
          <Button color="inherit" size="small" onClick={onRetry}>Retry</Button>
        )}
      >
        {error}
      </Alert>
    )
  }

  return (
    <Box>
      {jobId && (
        <>
          <Typography variant="body2" sx={{ mb: 1 }}>{phase}</Typography>
          <LinearProgress
            variant="determinate"
            value={progress}
            sx={{ mb: 2, height: 8, borderRadius: 4 }}
          />
        </>
      )}
      {streamText != null && (
        <Paper
          ref={streamRef}
          variant="outlined"
          sx={{
            p: 2,
            maxHeight: 320,
            overflow: 'auto',
            fontFamily: 'monospace',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
          }}
        >
          {streamText}
          <Box
            component="span"
            sx={{ animation: 'blink 1s step-end infinite', '@keyframes blink': { '50%': { opacity: 0 } } }}
          >
            ▌
          </Box>
        </Paper>
      )}
    </Box>
  )
}
