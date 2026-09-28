import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { AuthApiProvider } from './authApi'

const sendVerificationEmail = mock(async () => ({ ok: true }))
const getRegistrationOptions = mock(async () => ({ options: {} }) as never)
const verifyRegistration = mock(async () => ({ ok: true }) as never)
const authApi = { sendVerificationEmail, getRegistrationOptions, verifyRegistration }

mock.module('@simplewebauthn/browser', () => ({
  startRegistration: mock(async () => ({})),
  startAuthentication: mock(async () => ({})),
}))

let PasskeyRegister: typeof import('./PasskeyRegister').PasskeyRegister

describe('PasskeyRegister', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    Object.assign(dom.window, { SyntaxError })
    ;({ PasskeyRegister } = await import('./PasskeyRegister'))
    ;({ container, root } = dom.createRoot())
    sendVerificationEmail.mockClear()
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  test('shows user display name during bootstrap admin setup', async () => {
    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={authApi}>
          <PasskeyRegister onSuccess={() => {}} isBootstrap />
        </AuthApiProvider>
      )
    })

    await enterEmailAndContinue('admin@example.com', 'Create Admin Account')

    expect(container.textContent).toContain('Check your email for a 6-digit code.')
    // Both fields are present and self-describing via their placeholders; the
    // display-name helper line was removed as redundant.
    expect(findInputByPlaceholder('User display name (optional)')).not.toBeNull()
    expect(findInputByPlaceholder('Passkey name (optional)')).not.toBeNull()
    expect(container.textContent).not.toContain('This names your Ficus user account')
  })

  test('shows user display name during regular account registration', async () => {
    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={authApi}>
          <PasskeyRegister onSuccess={() => {}} />
        </AuthApiProvider>
      )
    })

    await enterEmailAndContinue('user@example.com', 'Send Verification Code')

    expect(findInputByPlaceholder('User display name (optional)')).not.toBeNull()
  })

  // First-time setup genuinely creates the account, so it asks for BOTH: who you
  // are, and what to call the key you are enrolling. Order is specified —
  // identity first, then the passkey label under it.
  test('offers a passkey name below the user display name', async () => {
    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={authApi}>
          <PasskeyRegister onSuccess={() => {}} />
        </AuthApiProvider>
      )
    })

    await enterEmailAndContinue('user@example.com', 'Send Verification Code')

    const displayNameInput = findInputByPlaceholder('User display name (optional)')
    const passkeyNameInput = findInputByPlaceholder('Passkey name (optional)')
    expect(displayNameInput).not.toBeNull()
    expect(passkeyNameInput).not.toBeNull()

    const inputs = Array.from(container.getElementsByTagName('input'))
    expect(inputs.indexOf(displayNameInput!)).toBeLessThan(inputs.indexOf(passkeyNameInput!))
    expect(container.textContent).toContain('Names this passkey')
  })

  test('a blank passkey name is sent as undefined so the server picks the default', async () => {
    verifyRegistration.mockClear()

    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={authApi}>
          <PasskeyRegister onSuccess={() => {}} />
        </AuthApiProvider>
      )
    })
    await enterEmailAndContinue('user@example.com', 'Send Verification Code')

    const codeInput = findInputByPlaceholder('Verification Code')!
    await dom.act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(codeInput, '123456')
      codeInput.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })
    await dom.act(async () => {
      getButton('Register with Passkey').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })

    // 4th argument is credentialName — left blank, it must not be sent as ''.
    expect(verifyRegistration.mock.calls[0][3]).toBeUndefined()
  })

  test('a typed passkey name is forwarded to the server', async () => {
    verifyRegistration.mockClear()

    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={authApi}>
          <PasskeyRegister onSuccess={() => {}} />
        </AuthApiProvider>
      )
    })
    await enterEmailAndContinue('user@example.com', 'Send Verification Code')

    const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
    const codeInput = findInputByPlaceholder('Verification Code')!
    const passkeyNameInput = findInputByPlaceholder('Passkey name (optional)')!
    await dom.act(async () => {
      valueSetter?.call(codeInput, '123456')
      codeInput.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
      valueSetter?.call(passkeyNameInput, 'YubiKey 5C')
      passkeyNameInput.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })
    await dom.act(async () => {
      getButton('Register with Passkey').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })

    expect(verifyRegistration.mock.calls[0][3]).toBe('YubiKey 5C')
  })

  test('first admin without email: the auto-filled code is hidden and still used', async () => {
    getRegistrationOptions.mockClear()
    sendVerificationEmail.mockImplementationOnce(
      async () => ({ ok: true, firstUser: true, emailConfigured: false, code: '123456' }) as never
    )

    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={authApi}>
          <PasskeyRegister onSuccess={() => {}} isBootstrap />
        </AuthApiProvider>
      )
    })
    await enterEmailAndContinue('admin@example.com', 'Create Admin Account')

    // Nothing to type: no code field, no "printed to the server logs" hint.
    expect(findInputByPlaceholder('Verification Code')).toBeNull()
    expect(container.textContent).toContain('no verification code is needed')
    expect(container.textContent).not.toContain('server logs')
    expect(findInputByPlaceholder('User display name (optional)')).not.toBeNull()

    await dom.act(async () => {
      getButton('Register with Passkey').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    // The server-supplied code is what the registration options request carries.
    expect(getRegistrationOptions.mock.calls[0][1]).toBe('123456')
  })

  for (const firstAdmin of [true, false]) {
    test(`passes the server first-admin result (${firstAdmin}) even when the bootstrap screen disagrees`, async () => {
      const onSuccess = mock((_firstAdmin: boolean) => {})
      sendVerificationEmail.mockImplementationOnce(
        async () => ({ ok: true, emailConfigured: false, code: '123456' }) as never
      )
      verifyRegistration.mockImplementationOnce(async () => ({ ok: true, firstAdmin }) as never)
      await dom.act(async () => {
        root.render(
          <AuthApiProvider api={authApi}>
            <PasskeyRegister onSuccess={onSuccess} isBootstrap={!firstAdmin} />
          </AuthApiProvider>
        )
      })
      await enterEmailAndContinue('admin@example.com', firstAdmin ? 'Send Verification Code' : 'Create Admin Account')
      await dom.act(async () => {
        getButton('Register with Passkey').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(onSuccess).toHaveBeenCalledWith(firstAdmin)
    })
  }

  test('invite link: the code is hidden and the invite wording shows', async () => {
    dom.window.history.replaceState(null, '', '/?invite=new%40example.com&code=654321')
    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={authApi}>
          <PasskeyRegister onSuccess={() => {}} />
        </AuthApiProvider>
      )
    })
    expect(findInputByPlaceholder('Verification Code')).toBeNull()
    expect(container.textContent).toContain('Your invite is verified')
    dom.window.history.replaceState(null, '', '/')
  })

  async function enterEmailAndContinue(email: string, buttonLabel: string) {
    const emailInput = findInputByPlaceholder('Email')
    if (!emailInput) throw new Error('Missing email input')

    await dom.act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(emailInput, email)
      emailInput.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
      emailInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })

    await dom.act(async () => {
      getButton(buttonLabel).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }

  function getButton(label: string): HTMLButtonElement {
    const button = Array.from(container.getElementsByTagName('button')).find((button) => button.textContent === label)
    if (!button) throw new Error(`Missing button: ${label}`)
    return button
  }

  function findInputByPlaceholder(placeholder: string): HTMLInputElement | null {
    return (
      Array.from(container.getElementsByTagName('input')).find((input) => input.placeholder === placeholder) ?? null
    )
  }
})
