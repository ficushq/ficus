import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { AuthApiProvider } from './authApi'
import type { DesktopBridge } from '../../lib/desktop'

const authenticate = mock(async () => ({ id: 'assertion' }) as never)
let dom: Awaited<ReturnType<typeof acquireDomHarness>>
let container: HTMLDivElement
let root: ReturnType<typeof dom.createRoot>['root']
let PasskeyLogin: typeof import('./PasskeyLogin').PasskeyLogin
const browserSignIn = mock(async () => {})
const success = mock(() => {})
const getLoginOptions = mock(async () => ({ challengeKey: 'challenge', options: { challenge: 'test' } }) as never)
const verifyLogin = mock(async () => ({ ok: true }) as never)

beforeEach(async () => {
  dom = await acquireDomHarness({ url: 'https://self-hosted.example/ficus' })
  ;({ container, root } = dom.createRoot())
  ;({ PasskeyLogin } = await import('./PasskeyLogin'))
  authenticate.mockReset().mockResolvedValue({ id: 'assertion' } as never)
  browserSignIn.mockReset().mockResolvedValue(undefined)
  success.mockClear()
  getLoginOptions.mockClear()
  verifyLogin.mockClear()
})
afterEach(async () => {
  delete dom.window.ficusDesktopApp
  await dom.cleanup()
})
async function render(withBrowser = true) {
  if (withBrowser)
    dom.window.ficusDesktopApp = {
      version: 1,
      signInWithBrowser: browserSignIn,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
    } satisfies DesktopBridge
  await dom.act(async () =>
    root.render(
      <AuthApiProvider api={{ getLoginOptions, verifyLogin }}>
        <PasskeyLogin onSuccess={success} authenticate={authenticate} />
      </AuthApiProvider>
    )
  )
}
const buttons = () => Array.from(container.querySelectorAll('button'))

const PASSKEY = 'Use a passkey or security key instead'
const BROWSER = 'Sign in with your browser'
const button = (label: string) => buttons().find((candidate) => candidate.textContent === label)!

test('an attached Desktop window leads with browser sign-in; the in-app passkey is the alternative', async () => {
  await render()
  expect(buttons().map((candidate) => candidate.textContent)).toEqual([BROWSER, PASSKEY])
  expect(button(BROWSER).classList.contains('ficus-button-primary')).toBe(true)
  expect(button(PASSKEY).classList.contains('ficus-button-ghost')).toBe(true)
  expect(container.textContent).toContain('passkey or password manager you normally use')
  expect(browserSignIn).not.toHaveBeenCalled()
  expect(authenticate).not.toHaveBeenCalled()

  await dom.act(async () => button(BROWSER).click())
  expect(browserSignIn).toHaveBeenCalledTimes(1)
  expect(authenticate).not.toHaveBeenCalled()
})
test('the in-app passkey still signs in from an attached window', async () => {
  await render()
  await dom.act(async () => button(PASSKEY).click())
  expect(authenticate).toHaveBeenCalledWith({ optionsJSON: { challenge: 'test' } })
  expect(verifyLogin).toHaveBeenCalledWith('challenge', { id: 'assertion' })
  expect(success).toHaveBeenCalledTimes(1)
  expect(browserSignIn).not.toHaveBeenCalled()
})
test('a failed passkey attempt leaves browser sign-in usable and does not start it automatically', async () => {
  authenticate.mockRejectedValueOnce(new Error('Passkey unavailable'))
  await render()
  await dom.act(async () => button(PASSKEY).click())
  expect(container.textContent).toContain('Passkey unavailable')
  expect(browserSignIn).not.toHaveBeenCalled()
  await dom.act(async () => button(BROWSER).click())
  expect(browserSignIn).toHaveBeenCalledTimes(1)
  expect(success).not.toHaveBeenCalled()
})
test('a browser approval error leaves both choices usable', async () => {
  browserSignIn.mockRejectedValueOnce(new Error('Could not open browser'))
  await render()
  await dom.act(async () => button(BROWSER).click())
  expect(container.textContent).toContain('Could not open browser')
  expect(buttons().every((candidate) => !candidate.disabled)).toBe(true)
})
test('ordinary browsers, local and remote Desktop windows keep passkey sign-in alone', async () => {
  await render(false)
  expect(buttons().map((candidate) => candidate.textContent)).toEqual(['Sign in with passkey'])
  expect(buttons()[0]!.classList.contains('ficus-button-primary')).toBe(true)
})

test('both choices are disabled during a pending passkey ceremony', async () => {
  let finish!: (value: never) => void
  authenticate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await render()
  await dom.act(async () => button(PASSKEY).click())
  expect(buttons().every((candidate) => candidate.disabled)).toBe(true)
  expect(browserSignIn).not.toHaveBeenCalled()
  await dom.act(async () => finish({ id: 'assertion' } as never))
  expect(buttons().every((candidate) => !candidate.disabled)).toBe(true)
})
