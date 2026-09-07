import { Box, Button, Paper, Step, StepLabel, Stepper, Typography, useMediaQuery } from '@mui/material'
import { useTheme } from '@mui/material/styles'

export default function ToolWorkflow({ title, steps, activeStep, onStepChange }) {
  const mui = useTheme()
  const isMobile = useMediaQuery(mui.breakpoints.down('sm'))
  const current = steps[activeStep]
  const isLast = activeStep === steps.length - 1

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Typography variant="h1" component="h1" sx={{ mb: 2 }}>{title}</Typography>
      <Stepper
        activeStep={activeStep}
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
        <Button disabled={activeStep === 0} onClick={() => onStepChange(activeStep - 1)}>Back</Button>
        {!isLast && (
          <Button
            variant="contained"
            disabled={current.canAdvance === false}
            onClick={() => onStepChange(activeStep + 1)}
          >
            Next
          </Button>
        )}
      </Box>
    </Box>
  )
}
