import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { ApiError } from '../../api/client'
import type { PasskeyCodeIssue } from '../../api/auth'

const CODE = 'ABCD-EFGH-JKMN-PQRS'
const issue: PasskeyCodeIssue = {
  code: CODE,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  links: [
    { origin: 'https://new.example.com', url: `https://new.example.com/add-passkey#code=${CODE}` },
    { origin: 'http://localhost:61896', url: `http://localhost:61896/add-passkey#code=${CODE}` },
  ],
}

const passkeyCodeOptions = mock(async () => ({ options: { challenge: 'c' } as never, challengeKey: 'auth:k' }))
const issuePasskeyCode = mock(async (_key: string, _response: unknown) => issue)
const startAuthentication = mock(async () => ({ id: 'assertion' }) as never)
const api = { passkeyCodeOptions, issuePasskeyCode, startAuthentication }

describe('Add a passkey for another address', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let root: ReturnType<typeof dom.createRoot>['root']
  let AddPasskeyElsewhere: typeof import('./AddPasskeyElsewhere').AddPasskeyElsewhere

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost:61896/settings' })
    ;({ AddPasskeyElsewhere } = await import('./AddPasskeyElsewhere'))
    ;({ root } = dom.createRoot())
    passkeyCodeOptions.mockClear()
    issuePasskeyCode.mockClear()
    startAuthentication.mockClear()
    await dom.act(async () => {
      root.render(<AddPasskeyElsewhere apiOverride={api} />)
    })
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  const body = () => dom.window.document.body
  const buttonWith = (text: string) =>
    [...body().querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  async function click(text: string) {
    const button = buttonWith(text)
    expect(button).toBeDefined()
    await dom.act(async () => {
      button!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }

  test('confirms with a passkey, then shows the link, the code and the expiry once', async () => {
    await click('Add a passkey for another address')
    expect(body().textContent).toContain('nothing is removed and nobody is signed out')
    await click('Continue with passkey')
    expect(passkeyCodeOptions).toHaveBeenCalledTimes(1)
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } })
    expect(issuePasskeyCode).toHaveBeenCalledWith('auth:k', { id: 'assertion' })
    expect(body().querySelector('[data-testid="add-passkey-link"]')?.textContent).toBe(issue.links[0].url)
    expect(body().querySelector('[data-testid="add-passkey-code"]')?.textContent).toBe(CODE)
    expect(body().textContent).toContain('15 minutes')
    expect(buttonWith('Copy link')).toBeDefined()
    expect(buttonWith('Copy code')).toBeDefined()
  })

  test('the typed-code hint names the page at the chosen address, base path included', async () => {
    issuePasskeyCode.mockResolvedValueOnce({
      ...issue,
      links: [{ origin: 'https://new.example.com', url: `https://new.example.com/ficus/add-passkey#code=${CODE}` }],
    })
    await click('Add a passkey for another address')
    await click('Continue with passkey')
    expect(body().textContent).toContain('Or go to https://new.example.com/ficus/add-passkey and type this code')
  })

  test('with several allowed addresses, choosing one swaps the link', async () => {
    await click('Add a passkey for another address')
    await click('Continue with passkey')
    const select = body().querySelector<HTMLSelectElement>('#add-passkey-elsewhere-origin')!
    expect([...select.options].map((o) => o.textContent)).toEqual(['new.example.com', 'localhost:61896'])
    await dom.act(async () => {
      select.value = 'http://localhost:61896'
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    expect(body().querySelector('[data-testid="add-passkey-link"]')?.textContent).toBe(issue.links[1].url)
    expect(body().textContent).toContain('Or go to http://localhost:61896/add-passkey and type this code')
  })

  test('a step-up the server refuses explains why and shows no code', async () => {
    issuePasskeyCode.mockRejectedValueOnce(new ApiError(401, 'Confirm with one of your passkeys to continue.'))
    await click('Add a passkey for another address')
    await click('Continue with passkey')
    expect(body().textContent).toContain('couldn’t be confirmed at this address')
    expect(body().querySelector('[data-testid="add-passkey-code"]')).toBeNull()
  })

  test('a cancelled prompt and the rate limit have their own messages', async () => {
    startAuthentication.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }) as never)
    await click('Add a passkey for another address')
    await click('Continue with passkey')
    expect(body().textContent).toContain('Confirmation was cancelled.')
    expect(issuePasskeyCode).not.toHaveBeenCalled()

    issuePasskeyCode.mockRejectedValueOnce(new ApiError(429, 'rate_limited'))
    await click('Continue with passkey')
    expect(body().textContent).toContain('Try again in 15 minutes')
  })

  test('closing forgets the code: reopening shows no stale code', async () => {
    await click('Add a passkey for another address')
    await click('Continue with passkey')
    await click('Done')
    await click('Add a passkey for another address')
    expect(body().querySelector('[data-testid="add-passkey-code"]')).toBeNull()
    expect(body().textContent).not.toContain(CODE)
  })
})
