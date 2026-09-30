import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { MemoryRouter } from 'react-router-dom'
import { AuthApiProvider } from './authApi'

const getTokenRegistrationOptions = mock(async (_token: string) => ({
  options: { challenge: 'c' },
  email: 'invitee@example.com',
  displayName: null,
  purpose: 'register' as 'register' | 'recovery',
}))
const verifyTokenRegistration = mock(async () => ({ ok: true, token: 't', user: {} }))
const requestPasskeyRecovery = mock(async () => ({ ok: true }))
const startRegistration = mock(async () => ({}))

const authApi = { getTokenRegistrationOptions, verifyTokenRegistration, requestPasskeyRecovery }
mock.module('@simplewebauthn/browser', () => ({
  startRegistration,
  startAuthentication: mock(async () => ({})),
}))

describe('token deep-link registration + passkey recovery UI', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']
  let TokenRegisterPage: typeof import('./TokenRegisterPage').TokenRegisterPage
  let PasskeyRecoveryRequest: typeof import('./PasskeyRecoveryRequest').PasskeyRecoveryRequest

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    Object.assign(dom.window, { SyntaxError })
    ;({ TokenRegisterPage } = await import('./TokenRegisterPage'))
    ;({ PasskeyRecoveryRequest } = await import('./PasskeyRecoveryRequest'))
    ;({ container, root } = dom.createRoot())
    getTokenRegistrationOptions.mockClear()
    verifyTokenRegistration.mockClear()
    requestPasskeyRecovery.mockClear()
    startRegistration.mockClear()
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  async function renderAt(url: string, onSuccess: () => void = () => {}) {
    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={authApi}>
          <MemoryRouter initialEntries={[url]}>
            <TokenRegisterPage onSuccess={onSuccess} />
          </MemoryRouter>
        </AuthApiProvider>
      )
    })
  }

  function buttonWith(text: string) {
    return [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  }

  test('names the account the invite belongs to', async () => {
    await renderAt('/register?token=abc123')
    expect(getTokenRegistrationOptions).toHaveBeenCalledWith('abc123')
    expect(container.textContent).toContain('invitee@example.com')
    expect(container.textContent).toContain('Set up your passkey')
  })

  test('completing the ceremony passes the token, not an email + code', async () => {
    const onSuccess = mock(() => {})
    await renderAt('/register?token=abc123', onSuccess)
    await dom.act(async () => {
      buttonWith('Register with Passkey')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    expect(startRegistration).toHaveBeenCalledTimes(1)
    expect(verifyTokenRegistration.mock.calls[0][0]).toBe('abc123')
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  test('a rejected token shows the dead-link message and no ceremony button', async () => {
    getTokenRegistrationOptions.mockRejectedValueOnce(new Error('This link is invalid or has expired.'))
    await renderAt('/register?token=spent')
    expect(container.textContent).toContain('This link is invalid or has expired.')
    expect(buttonWith('Register with Passkey')).toBeUndefined()
  })

  test('a link with no token at all never calls the server', async () => {
    await renderAt('/register')
    expect(getTokenRegistrationOptions).not.toHaveBeenCalled()
    expect(container.textContent).toContain('missing its token')
  })

  test('a recovery token says plainly that it replaces the existing passkeys', async () => {
    getTokenRegistrationOptions.mockResolvedValueOnce({
      options: { challenge: 'c' },
      email: 'locked-out@example.com',
      displayName: null,
      purpose: 'recovery',
    })
    await renderAt('/register?token=recover-me')
    expect(container.textContent).toContain('Register a new passkey')
    expect(container.textContent).toContain('replaces every passkey currently on the account')
    expect(buttonWith('Replace my passkey')).toBeDefined()
  })

  // An invite genuinely creates the account, so it asks who you are AND what to
  // call the key — identity first, passkey label under it.
  test('an invite asks for the user display name and, below it, the passkey name', async () => {
    await renderAt('/register?token=abc123')
    const inputs = [...container.querySelectorAll('input')]
    const displayName = inputs.find((i) => i.id === 'token-register-display-name')
    const passkeyName = inputs.find((i) => i.id === 'token-register-passkey-name')
    expect(displayName).toBeDefined()
    expect(passkeyName).toBeDefined()
    expect(inputs.indexOf(displayName!)).toBeLessThan(inputs.indexOf(passkeyName!))
    // The display-name field carries NO helper line: its placeholder already
    // says "User display name", and the passkey-name description below is the
    // one that actually needed disambiguating. Removed at the operator's
    // request — PasskeyRegister lost the same line earlier, but an invite deep
    // link renders THIS page, so it survived here until now.
    expect(container.textContent).not.toContain('This names your Ficus user account')
  })

  // Enter must submit. This is the first screen an invited user ever sees, and
  // it was a plain <div> of type="button" — so typing a display name and
  // pressing Enter did nothing at all.
  test('the fields sit in a form with a submit button', async () => {
    await renderAt('/register?token=abc123')
    const form = container.querySelector('form')
    expect(form).not.toBeNull()
    expect(form!.querySelector('button[type="submit"]')).not.toBeNull()
    // Both named fields must be INSIDE that form, or implicit submission from
    // them would do nothing.
    expect(form!.querySelector('#token-register-display-name')).not.toBeNull()
    expect(form!.querySelector('#token-register-passkey-name')).not.toBeNull()
  })

  test('submitting the form starts registration exactly once', async () => {
    await renderAt('/register?token=abc123')
    const form = container.querySelector('form')!
    await dom.act(async () => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(startRegistration).toHaveBeenCalledTimes(1)
    // One lookup on page load, one fresh challenge for the attempt.
    expect(getTokenRegistrationOptions).toHaveBeenCalledTimes(2)
  })

  test('every attempt gets a fresh challenge, so a slow or failed first try can be retried', async () => {
    await renderAt('/register?token=abc123')
    const challenges = ['fresh-1', 'fresh-2']
    for (const challenge of challenges)
      getTokenRegistrationOptions.mockResolvedValueOnce({
        options: { challenge },
        email: 'invitee@example.com',
        displayName: null,
        purpose: 'register',
      })
    verifyTokenRegistration.mockRejectedValueOnce(new Error('Verification failed'))
    const submit = async () =>
      dom.act(async () => {
        container
          .querySelector('form')!
          .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

    await submit()
    expect(container.textContent).toContain('Verification failed')
    await submit()
    expect(
      (startRegistration.mock.calls as unknown as Array<[{ optionsJSON: { challenge: string } }]>).map(
        ([args]) => args.optionsJSON.challenge
      )
    ).toEqual(challenges)
    expect(verifyTokenRegistration).toHaveBeenCalledTimes(2)
  })

  // Recovery re-registers a key on an account that already exists, so re-asking
  // for an identity is noise. The only thing worth naming is the new passkey.
  test('recovery drops the display-name field entirely but still names the passkey', async () => {
    getTokenRegistrationOptions.mockResolvedValueOnce({
      options: { challenge: 'c' },
      email: 'locked-out@example.com',
      displayName: 'Existing Person',
      purpose: 'recovery',
    })
    await renderAt('/register?token=recover-me')
    expect(container.querySelector('#token-register-display-name')).toBeNull()
    expect(container.textContent).not.toContain('User display name')
    expect(container.querySelector('#token-register-passkey-name')).not.toBeNull()
    expect(container.textContent).toContain('Names this passkey')
  })

  test('recovery sends no display name, only the passkey name', async () => {
    getTokenRegistrationOptions.mockResolvedValueOnce({
      options: { challenge: 'c' },
      email: 'locked-out@example.com',
      displayName: 'Existing Person',
      purpose: 'recovery',
    })
    await renderAt('/register?token=recover-me')

    const passkeyName = container.querySelector('#token-register-passkey-name') as HTMLInputElement
    await dom.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(passkeyName, 'Replacement YubiKey')
      passkeyName.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })
    await dom.act(async () => {
      buttonWith('Replace my passkey')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })

    const call = verifyTokenRegistration.mock.calls[0] as unknown as unknown[]
    expect(call[2]).toBeUndefined() // displayName — never re-asked on recovery
    expect(call[3]).toBe('Replacement YubiKey')
  })

  test('a blank passkey name is sent as undefined so the server picks the default', async () => {
    await renderAt('/register?token=abc123')
    await dom.act(async () => {
      buttonWith('Register with Passkey')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    expect((verifyTokenRegistration.mock.calls[0] as unknown as unknown[])[3]).toBeUndefined()
  })

  test('recovery request never confirms whether the address is registered', async () => {
    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={authApi}>
          <PasskeyRecoveryRequest onBack={() => {}} />
        </AuthApiProvider>
      )
    })
    const input = container.querySelector('#recover-email') as HTMLInputElement
    await dom.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'someone@example.com')
      input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })
    await dom.act(async () => {
      buttonWith('Send recovery link')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    expect(requestPasskeyRecovery).toHaveBeenCalledWith('someone@example.com')
    // "If … has an account here" — never "we sent you an email".
    expect(container.textContent).toContain('has an account here')
    expect(container.textContent).toContain('replaces every passkey currently on the account')
  })
})
