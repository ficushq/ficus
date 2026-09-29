import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { AuthApiProvider } from './authApi'
import type { FinishAdminSetupDependencies } from './FinishAdminSetupPage'

const getTokenRegistrationOptions = mock(async (_token: string) => ({
  options: { challenge: 'c' } as never,
  email: 'owner@example.com',
  displayName: null,
  purpose: 'register' as const,
}))
const verifyTokenRegistration = mock(
  async (_token: string, _response: unknown, _displayName?: string, _credentialName?: string) => ({
    ok: true,
    token: 'session',
    user: { id: 'u1', email: 'owner@example.com' },
    firstAdmin: true,
  })
)
const createInviteLink = mock(async (_userId: string) => ({
  inviteUrl: 'https://ficus.example/register?token=link-token',
}))
const startRegistration = mock(async () => ({}) as never)
const authApi = { getTokenRegistrationOptions, verifyTokenRegistration }
const dependencies = {
  createInviteLink,
  startRegistration: startRegistration as unknown as FinishAdminSetupDependencies['startRegistration'],
}

const owner = { id: 'u1', email: 'owner@example.com', displayName: 'Owner' }

describe('FinishAdminSetupPage', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']
  let FinishAdminSetupPage: typeof import('./FinishAdminSetupPage').FinishAdminSetupPage

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    ;({ FinishAdminSetupPage } = await import('./FinishAdminSetupPage'))
    ;({ container, root } = dom.createRoot())
    for (const fn of [getTokenRegistrationOptions, verifyTokenRegistration, createInviteLink, startRegistration]) {
      fn.mockClear()
    }
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  async function render(onSuccess: (firstAdmin: boolean) => void = () => {}, accounts = [owner]) {
    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={authApi}>
          <FinishAdminSetupPage
            accounts={accounts}
            onSuccess={onSuccess}
            onSignOut={() => {}}
            dependencies={dependencies}
          />
        </AuthApiProvider>
      )
    })
  }

  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!

  async function submit() {
    await dom.act(async () => {
      submitButton().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }

  test('names the waiting account and registers its passkey through a one-time link in this window', async () => {
    const onSuccess = mock((_firstAdmin: boolean) => {})
    await render(onSuccess)
    expect(container.textContent).toContain('Finish creating your admin account')
    expect(container.textContent).toContain('owner@example.com')

    await submit()

    expect(createInviteLink).toHaveBeenCalledWith('u1')
    expect(getTokenRegistrationOptions).toHaveBeenCalledWith('link-token')
    expect(startRegistration).toHaveBeenCalledTimes(1)
    expect(verifyTokenRegistration.mock.calls[0]?.slice(0, 3)).toEqual(['link-token', {}, 'Owner'])
    expect(onSuccess).toHaveBeenCalledWith(true)
  })

  test('a failed passkey ceremony explains itself and Retry reuses the same link', async () => {
    const cancelled = Object.assign(new Error('The operation either timed out or was not allowed.'), {
      name: 'NotAllowedError',
    })
    startRegistration.mockRejectedValueOnce(cancelled)
    const onSuccess = mock((_firstAdmin: boolean) => {})
    await render(onSuccess)

    await submit()

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Passkey creation was cancelled or timed out.')
    expect(submitButton().textContent).toBe('Retry')
    expect(onSuccess).not.toHaveBeenCalled()

    await submit()

    expect(createInviteLink).toHaveBeenCalledTimes(1)
    expect(getTokenRegistrationOptions).toHaveBeenCalledTimes(2)
    expect(startRegistration).toHaveBeenCalledTimes(2)
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  test('a dead link is replaced on the next attempt', async () => {
    verifyTokenRegistration.mockRejectedValueOnce(new Error('This link is invalid or has expired.'))
    await render()

    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This link is invalid or has expired.')

    await submit()
    expect(createInviteLink).toHaveBeenCalledTimes(2)
  })

  test('with several waiting accounts, the chosen one gets the link', async () => {
    const second = { id: 'u2', email: 'second@example.com', displayName: null }
    await render(() => {}, [owner, second])
    const radio = container.querySelector<HTMLInputElement>('input[type="radio"][value="u2"]')!
    await dom.act(async () => {
      radio.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })

    await submit()

    expect(createInviteLink).toHaveBeenCalledWith('u2')
  })
})
