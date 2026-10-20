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

test('passkey remains first and primary; browser approval is an explicit secondary action', async () => {
  await render()
  expect(buttons().map((button) => button.textContent)).toEqual(['Sign in with Passkey', 'Sign in with browser'])
  expect(buttons()[0]!.classList.contains('ficus-button-primary')).toBe(true)
  expect(buttons()[1]!.classList.contains('ficus-button-secondary')).toBe(true)
  expect(browserSignIn).not.toHaveBeenCalled()
  await dom.act(async () => buttons()[0]!.click())
  expect(authenticate).toHaveBeenCalledWith({ optionsJSON: { challenge: 'test' } })
  expect(verifyLogin).toHaveBeenCalledWith('challenge', { id: 'assertion' })
  expect(success).toHaveBeenCalledTimes(1)
  expect(browserSignIn).not.toHaveBeenCalled()
})
test('a failed passkey attempt leaves browser sign-in usable and does not start it automatically', async () => {
  authenticate.mockRejectedValueOnce(new Error('Passkey unavailable'))
  await render()
  await dom.act(async () => buttons()[0]!.click())
  expect(container.textContent).toContain('Passkey unavailable')
  expect(browserSignIn).not.toHaveBeenCalled()
  await dom.act(async () => buttons()[1]!.click())
  expect(browserSignIn).toHaveBeenCalledTimes(1)
  expect(success).not.toHaveBeenCalled()
})
test('a browser approval error leaves both choices usable', async () => {
  browserSignIn.mockRejectedValueOnce(new Error('Could not open browser'))
  await render()
  await dom.act(async () => buttons()[1]!.click())
  expect(container.textContent).toContain('Could not open browser')
  expect(buttons().every((button) => !button.disabled)).toBe(true)
})
test('ordinary browsers and older Desktop builds retain the existing passkey login', async () => {
  await render(false)
  expect(buttons().map((button) => button.textContent)).toEqual(['Sign in with Passkey'])
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
  await dom.act(async () => buttons()[0]!.click())
  expect(buttons().every((button) => button.disabled)).toBe(true)
  expect(browserSignIn).not.toHaveBeenCalled()
  await dom.act(async () => finish({ id: 'assertion' } as never))
  expect(buttons().every((button) => !button.disabled)).toBe(true)
})
