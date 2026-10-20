import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { MemoryRouter } from 'react-router-dom'
import { AuthApiProvider } from './authApi'
import { ApiError } from '../../api/client'

const getAddPasskeyOptions = mock(async (_code: string) => ({
  options: { challenge: 'c' } as never,
  email: 'me@example.com',
  displayName: null,
  origin: 'http://localhost',
}))
const verifyAddPasskey = mock(async (_code: string, _response: unknown, _name?: string) => ({
  ok: true,
  token: 't',
  user: {} as never,
}))
const startRegistration = mock(async () => ({ id: 'new-passkey' }))

mock.module('@simplewebauthn/browser', () => ({
  startRegistration,
  startAuthentication: mock(async () => ({})),
}))

describe('/add-passkey redemption page', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']
  let AddPasskeyPage: typeof import('./AddPasskeyPage').AddPasskeyPage

  async function setup(url: string) {
    dom = await acquireDomHarness({ url })
    Object.assign(dom.window, { SyntaxError })
    ;({ AddPasskeyPage } = await import('./AddPasskeyPage'))
    ;({ container, root } = dom.createRoot())
  }

  beforeEach(() => {
    getAddPasskeyOptions.mockClear()
    verifyAddPasskey.mockClear()
    startRegistration.mockClear()
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  async function render(onSuccess: () => void = () => {}) {
    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={{ getAddPasskeyOptions, verifyAddPasskey }}>
          <MemoryRouter initialEntries={['/add-passkey']}>
            <AddPasskeyPage onSuccess={onSuccess} />
          </MemoryRouter>
        </AuthApiProvider>
      )
    })
  }

  const buttonWith = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))

  async function click(text: string) {
    await dom.act(async () => {
      buttonWith(text)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }

  async function type(input: HTMLInputElement, value: string) {
    await dom.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }

  test('reads the code from the link fragment, strips it from the URL and names the account', async () => {
    await setup('http://localhost/add-passkey#code=ABCD-EFGH-JKMN-PQRS')
    await render()
    expect(getAddPasskeyOptions).toHaveBeenCalledWith('ABCD-EFGH-JKMN-PQRS')
    expect(dom.window.location.hash).toBe('')
    expect(dom.window.location.href).not.toContain('ABCD')
    expect(container.textContent).toContain('me@example.com')
    expect(container.textContent).toContain('Your other passkeys and sessions stay as they are.')
  })

  test('Add passkey fetches fresh options, registers, verifies with the code and name, and signs in', async () => {
    await setup('http://localhost/add-passkey#code=ABCD-EFGH-JKMN-PQRS')
    const onSuccess = mock(() => {})
    await render(onSuccess)
    await type(container.querySelector<HTMLInputElement>('#add-passkey-name')!, 'Laptop')
    await click('Add passkey')
    expect(getAddPasskeyOptions).toHaveBeenCalledTimes(2)
    expect(startRegistration).toHaveBeenCalledTimes(1)
    expect(verifyAddPasskey).toHaveBeenCalledWith('ABCD-EFGH-JKMN-PQRS', { id: 'new-passkey' }, 'Laptop')
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  test('without a fragment it asks for the code and submits what was typed', async () => {
    await setup('http://localhost/add-passkey')
    await render()
    expect(getAddPasskeyOptions).not.toHaveBeenCalled()
    await type(container.querySelector<HTMLInputElement>('#add-passkey-code')!, ' abcd-efgh-jkmn-pqrs ')
    await click('Continue')
    expect(getAddPasskeyOptions).toHaveBeenCalledWith('abcd-efgh-jkmn-pqrs')
    expect(container.textContent).toContain('me@example.com')
  })

  test('an invalid or expired code explains what to do and asks for another', async () => {
    await setup('http://localhost/add-passkey#code=ABCD-EFGH-JKMN-PQRS')
    getAddPasskeyOptions.mockRejectedValueOnce(new ApiError(401, 'This code is invalid, expired or already used.'))
    await render()
    expect(container.textContent).toContain('Create a new one from Settings → Account → Passkeys')
    expect(container.querySelector('#add-passkey-code')).not.toBeNull()
  })

  test('a disallowed address says so', async () => {
    await setup('http://localhost/add-passkey#code=ABCD-EFGH-JKMN-PQRS')
    getAddPasskeyOptions.mockRejectedValueOnce(
      new ApiError(403, 'This address is not an allowed address of this server.')
    )
    await render()
    expect(container.textContent).toContain('isn’t an allowed address of this server')
  })

  test('a cancelled prompt keeps the form and does not sign in', async () => {
    await setup('http://localhost/add-passkey#code=ABCD-EFGH-JKMN-PQRS')
    const onSuccess = mock(() => {})
    await render(onSuccess)
    startRegistration.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }))
    await click('Add passkey')
    expect(container.textContent).toContain('Registration was cancelled.')
    expect(buttonWith('Add passkey')).toBeDefined()
    expect(verifyAddPasskey).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
  })
})
