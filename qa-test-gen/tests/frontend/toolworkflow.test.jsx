import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import ToolWorkflow from '../../src/components/workflow/ToolWorkflow'

function Harness({ canAdvance = true }) {
  const [step, setStep] = useState(0)
  return (
    <ToolWorkflow
      title="Demo Tool"
      activeStep={step}
      onStepChange={setStep}
      steps={[
        { key: 'input', label: 'Input', content: <div>step-input</div>, canAdvance },
        { key: 'review', label: 'Review', content: <div>step-review</div> },
      ]}
    />
  )
}

test('renders title, stepper labels and active step content', () => {
  render(<Harness />)
  expect(screen.getByRole('heading', { name: 'Demo Tool' })).toBeInTheDocument()
  expect(screen.getByText('Input')).toBeInTheDocument()
  expect(screen.getByText('step-input')).toBeInTheDocument()
  expect(screen.queryByText('step-review')).not.toBeInTheDocument()
})

test('Next advances when canAdvance, Back returns', async () => {
  render(<Harness />)
  await userEvent.click(screen.getByRole('button', { name: /next/i }))
  expect(screen.getByText('step-review')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /back/i }))
  expect(screen.getByText('step-input')).toBeInTheDocument()
})

test('Next is disabled when canAdvance is false', () => {
  render(<Harness canAdvance={false} />)
  expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
})

test('Next button is absent on the last step', () => {
  render(
    <ToolWorkflow
      title="Demo Tool"
      activeStep={1}
      onStepChange={() => {}}
      steps={[
        { key: 'input', label: 'Input', content: <div>step-input</div> },
        { key: 'review', label: 'Review', content: <div>step-review</div> },
      ]}
    />
  )
  expect(screen.getByText('step-review')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument()
})

test('Back button is disabled at step 0', () => {
  render(<Harness />)
  expect(screen.getByRole('button', { name: /back/i })).toBeDisabled()
})

test('out-of-range activeStep clamps to the last step without crashing', () => {
  render(
    <ToolWorkflow
      title="Demo Tool"
      activeStep={99}
      onStepChange={() => {}}
      steps={[
        { key: 'input', label: 'Input', content: <div>step-input</div> },
        { key: 'review', label: 'Review', content: <div>step-review</div> },
      ]}
    />
  )
  expect(screen.getByText('step-review')).toBeInTheDocument()
  expect(screen.queryByText('step-input')).not.toBeInTheDocument()
})

test('empty steps renders null without crashing', () => {
  const { container } = render(
    <ToolWorkflow title="Demo Tool" activeStep={0} onStepChange={() => {}} steps={[]} />
  )
  expect(container).toBeEmptyDOMElement()
})
