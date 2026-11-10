import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AuthStatus } from '../api/auth'
import { acquireDomHarness } from '../test/domHarness'

// The completed registration result, rather than a stale user-count snapshot,
// determines whether this login opens onboarding.
let authStatus: AuthStatus
let loginWithTokenCalls: unknown[][] = []
let capturedRegistrationSuccess: ((firstAdmin: boolean) => void) | undefined
let capturedRegistrationFailure: (() => void) | undefined

function PasskeyRegisterFixture({
  onSuccess,
  onFailure,
}: {
  onSuccess: (firstAdmin: boolean) => void
  onFailure?: () => void
}) {
  useEffect(() => {
    capturedRegistrationSuccess = onSuccess
    capturedRegistrationFailure = onFailure
  })
  return <div>Passkey registration fixture</div>
}

mock.module('@simplewebauthn/browser', () => ({
  startRegistration: async () => ({}),
  // PasskeyLogin imports this from the same module — unused here but
  // required for the module graph to link.
  startAuthentication: async () => ({}),
}))

import { LoginPage } from './LoginPage'

describe('LoginPage first-registration wiring', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: import('react-dom/client').Root

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      configureWindow: (window) => Object.assign(window, { SyntaxError }),
    })
    loginWithTokenCalls = []
    capturedRegistrationSuccess = undefined
    capturedRegistrationFailure = undefined
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/auth/register/email')) {
        return Response.json({ ok: true, code: '123456' })
      }
      if (url.includes('/auth/register/options')) {
        return Response.json({ options: {} })
      }
      if (url.includes('/auth/register/verify')) {
        return Response.json({ ok: true })
      }
      return Response.json({})
    }) as typeof fetch
    ;({ container, root } = dom.createRoot())
  })
  afterEach(async () => {
    await dom.cleanup()
  })

  test('bootstrap first-admin registration calls loginWithToken(true)', async () => {
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: false, hasAdminUser: false }
    await dom.act(async () => {
      root.render(
        <LoginPage
          dependencies={{ PasskeyRegisterComponent: PasskeyRegisterFixture }}
          auth={{
            authStatus,
            isAuthenticated: false,
            login: async () => {},
            loginWithToken: async (...args) => {
              loginWithTokenCalls.push(args)
            },
          }}
        />
      )
    })

    expect(capturedRegistrationSuccess).toBeFunction()
    await dom.act(async () => capturedRegistrationSuccess!(true))

    expect(loginWithTokenCalls.length).toBe(1)
    expect(loginWithTokenCalls[0]).toEqual([true])
  })

  test('ordinary self-registration ("Create account") calls loginWithToken(false)', async () => {
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: true, hasAdminUser: true, canSelfRegister: true }
    await dom.act(async () => {
      root.render(
        <LoginPage
          dependencies={{ PasskeyRegisterComponent: PasskeyRegisterFixture }}
          auth={{
            authStatus,
            isAuthenticated: false,
            login: async () => {},
            loginWithToken: async (...args) => {
              loginWithTokenCalls.push(args)
            },
          }}
        />
      )
    })

    await dom.act(async () => {
      getButton('Create account').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(capturedRegistrationSuccess).toBeFunction()
    await dom.act(async () => capturedRegistrationSuccess!(false))

    expect(loginWithTokenCalls.length).toBe(1)
    expect(loginWithTokenCalls[0]).toEqual([false])
  })

  test('a failed bootstrap passkey step re-reads the session so the finish-setup screen can take over', async () => {
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: false, hasAdminUser: false, canSelfRegister: true }
    const refreshSession = mock(async () => {})
    await dom.act(async () => {
      root.render(
        <LoginPage
          dependencies={{ PasskeyRegisterComponent: PasskeyRegisterFixture }}
          auth={{
            authStatus,
            isAuthenticated: false,
            login: async () => {},
            loginWithToken: async () => {},
            refreshSession,
          }}
        />
      )
    })

    expect(capturedRegistrationFailure).toBeFunction()
    await dom.act(async () => capturedRegistrationFailure!())

    expect(refreshSession).toHaveBeenCalledTimes(1)
  })

  function getButton(label: string): HTMLButtonElement {
    const button = Array.from(container.getElementsByTagName('button')).find((button) => button.textContent === label)
    if (!button) throw new Error(`Missing button: ${label}`)
    return button
  }
})
