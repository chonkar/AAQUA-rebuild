import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotificationProvider, useNotify } from '../../src/components/common/NotificationProvider'

function Demo() {
  const notify = useNotify()
  return <button onClick={() => notify.success('Saved!')}>go</button>
}

test('notify.success shows a snackbar', async () => {
  render(<NotificationProvider><Demo /></NotificationProvider>)
  await userEvent.click(screen.getByText('go'))
  expect(await screen.findByText('Saved!')).toBeInTheDocument()
})
