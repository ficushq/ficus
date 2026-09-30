import { describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AuthUser } from '@ficus/client-core'
import { acquireDomHarness } from '../../test/domHarness'
import { AccountEmailForm } from './AccountEmailForm'

const saved = { id: 'u1', email: 'me@example.com', displayName: null } as unknown as AuthUser

async function setup(api: Parameters<typeof AccountEmailForm>[0]['api'], hasEmail = false) {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  const onAdded = mock((_user: AuthUser) => {})
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AccountEmailForm hasEmail={hasEmail} onSaved={onAdded} api={api} />
      </QueryClientProvider>
    )
  )
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === label) as HTMLButtonElement
  const type = async (selector: string, value: string) => {
    const input = container.querySelector(selector) as HTMLInputElement
    await dom.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })
  }
  const click = (label: string) => dom.act(async () => button(label).click())
  return { dom, container, onAdded, button, type, click }
}

describe('AccountEmailForm', () => {
  test('without a mail provider the address is saved directly', async () => {
    const addEmail = mock(async () => ({ verificationRequired: false, user: saved }))
    const verifyAddedEmail = mock(async () => ({ user: saved }))
    const { dom, container, onAdded, type, click } = await setup({ addEmail, verifyAddedEmail })
    try {
      expect(container.textContent).toContain('Add an email for account recovery')
      await click('Add email')
      await type('#account-add-email', ' me@example.com ')
      await click('Save email')
      expect(addEmail).toHaveBeenCalledWith('me@example.com')
      expect(verifyAddedEmail).not.toHaveBeenCalled()
      expect(onAdded).toHaveBeenCalledWith(saved)
      // Closed again, back to the prompt.
      expect(container.querySelector('#account-add-email')).toBeNull()
    } finally {
      await dom.cleanup()
    }
  })

  test('with a mail provider it asks for the code, then saves', async () => {
    const addEmail = mock(async () => ({ verificationRequired: true }))
    const verifyAddedEmail = mock(async () => ({ user: saved }))
    const { dom, container, onAdded, type, click } = await setup({ addEmail, verifyAddedEmail })
    try {
      await click('Add email')
      await type('#account-add-email', 'me@example.com')
      await click('Save email')
      expect(container.textContent).toContain('Check your email for a 6-digit code.')
      expect(onAdded).not.toHaveBeenCalled()
      await type('#account-add-email-code', '123456')
      await click('Verify and save')
      expect(verifyAddedEmail).toHaveBeenCalledWith('me@example.com', '123456')
      expect(onAdded).toHaveBeenCalledWith(saved)
    } finally {
      await dom.cleanup()
    }
  })

  test('an account with an email offers to change it, through the same steps', async () => {
    const addEmail = mock(async () => ({ verificationRequired: true }))
    const verifyAddedEmail = mock(async () => ({ user: saved }))
    const { dom, container, onAdded, type, click, button } = await setup({ addEmail, verifyAddedEmail }, true)
    try {
      expect(button('Add email')).toBeUndefined()
      expect(container.textContent).toContain('Used for account recovery and email notifications.')
      await click('Change email')
      expect(container.querySelector('label[for="account-add-email"]')?.textContent).toBe('New email')
      await type('#account-add-email', 'new@example.com')
      await click('Save email')
      await type('#account-add-email-code', '654321')
      await click('Verify and save')
      expect(verifyAddedEmail).toHaveBeenCalledWith('new@example.com', '654321')
      expect(onAdded).toHaveBeenCalledWith(saved)
    } finally {
      await dom.cleanup()
    }
  })

  test('a server refusal is shown and the form stays open', async () => {
    const addEmail = mock(async () => {
      throw new Error('Another account already uses this email')
    })
    const { dom, container, onAdded, type, click } = await setup({ addEmail, verifyAddedEmail: mock() as never })
    try {
      await click('Add email')
      await type('#account-add-email', 'taken@example.com')
      await click('Save email')
      expect(container.querySelector('[role="alert"]')?.textContent).toBe('Another account already uses this email')
      expect(container.querySelector('#account-add-email')).not.toBeNull()
      expect(onAdded).not.toHaveBeenCalled()
    } finally {
      await dom.cleanup()
    }
  })
})
