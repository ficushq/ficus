import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, waitFor } from '@testing-library/dom'
import type { GitHubPersonalIdentityStatus } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { githubIdentityQueryKeys } from '../../queryKeys'
import { LinkedGitHubAccount } from './LinkedGitHubAccount'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let oldFetch: typeof globalThis.fetch
let client: QueryClient
let requests: Array<{ method: string; url: string; body: string }>

const configured = { configured: true, authority: 'local', mode: 'browser' } as const
const status = (patch: Partial<GitHubPersonalIdentityStatus> = {}): GitHubPersonalIdentityStatus => ({
  linked: null,
  confirmation: null,
  authorization: configured,
  ...patch,
})

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings' })
  oldFetch = globalThis.fetch
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  requests = []
})
afterEach(async () => {
  await harness.cleanup()
  client.clear()
  globalThis.fetch = oldFetch
})

function serve(routes: Record<string, (body: string) => Response>) {
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = String(init?.body ?? '')
    requests.push({ method, url: url.pathname, body })
    const handler = routes[`${method} ${url.pathname}`]
    if (!handler) return Response.json({ error: 'unexpected' }, { status: 500 })
    return handler(body)
  }) as typeof fetch
}

async function render(initial?: GitHubPersonalIdentityStatus) {
  if (initial) client.setQueryData(githubIdentityQueryKeys.all, initial)
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LinkedGitHubAccount />
      </QueryClientProvider>
    )
  )
  return container
}

const button = (container: HTMLElement, text: string) => {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === text)
  if (!found) throw new Error(`no "${text}" button in: ${container.textContent}`)
  return found as HTMLButtonElement
}
const flush = () => harness.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

test('explains purpose and that linking grants no repository access or squad trust by itself', async () => {
  const container = await render(status())
  expect(container.querySelector('#linked-github-account')?.textContent).toBe('GitHub account')
  expect(container.textContent).toContain('does not connect repositories')
  expect(container.textContent).toContain('update settings')
  expect(button(container, 'Link GitHub account').disabled).toBe(false)
})

test('browser link starts OAuth with a path-only return target and never stores tokens', async () => {
  serve({
    'POST /api/github-identity/authorization/start': () =>
      Response.json({ authorizationUrl: 'https://github.com/login/oauth/authorize?state=s' }),
  })
  const assigned: string[] = []
  const original = window.location.assign
  Object.defineProperty(window.location, 'assign', { configurable: true, value: (url: string) => assigned.push(url) })
  try {
    const container = await render(status())
    await harness.act(async () => fireEvent.click(button(container, 'Link GitHub account')))
    await flush()
    expect(JSON.parse(requests[0]!.body)).toEqual({ returnTo: '/settings/github-identity' })
    expect(assigned).toEqual(['https://github.com/login/oauth/authorize?state=s'])
    expect(Object.keys(localStorage).filter((key) => /github|token/i.test(key))).toEqual([])
  } finally {
    Object.defineProperty(window.location, 'assign', { configurable: true, value: original })
  }
})

test('device link shows the public code, polls, then asks for explicit confirmation of the verified account', async () => {
  let identity = status({ authorization: { configured: true, authority: 'local', mode: 'device' } })
  serve({
    'GET /api/github-identity': () => Response.json(identity),
    'POST /api/github-identity/authorization/start': () =>
      Response.json({
        kind: 'device',
        id: '11111111-1111-4111-8111-111111111111',
        userCode: 'WXYZ-1234',
        verificationUri: 'https://github.com/login/device',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        intervalSeconds: 1,
      }),
    'POST /api/github-identity/authorization/device/11111111-1111-4111-8111-111111111111/poll': () => {
      identity = status({
        authorization: identity.authorization,
        confirmation: {
          id: '22222222-2222-4222-8222-222222222222',
          accountId: '583231',
          login: 'octocat',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      })
      return Response.json({ status: 'complete', returnTo: '/settings/github-identity' })
    },
    'POST /api/github-identity/22222222-2222-4222-8222-222222222222/confirm': () => {
      identity = status({
        authorization: identity.authorization,
        linked: { accountId: '583231', login: 'octocat', linkedAt: '2026-10-08T10:00:00.000Z' },
      })
      return Response.json({ linked: true })
    },
  })
  const container = await render(identity)
  await harness.act(async () => fireEvent.click(button(container, 'Link GitHub account')))
  await waitFor(() => expect(container.textContent).toContain('WXYZ-1234'))
  expect(requests.some((request) => request.url.endsWith('/poll'))).toBe(false)
  await waitFor(() => expect(container.textContent).toContain('GitHub verified this account'), { timeout: 3000 })
  expect(container.textContent).toContain('@octocat')
  expect(container.textContent).toContain('583231')
  expect(container.textContent).not.toContain('WXYZ-1234')
  await harness.act(async () => fireEvent.click(button(container, 'Link this account')))
  await waitFor(() => expect(container.textContent).toContain('Linked'))
  expect(container.textContent).toContain('@octocat')
  expect(requests.filter((request) => request.url.endsWith('/confirm'))).toHaveLength(1)
})

test('unlink requires confirmation and says manual squad trust remains', async () => {
  let identity = status({ linked: { accountId: '583231', login: 'octocat', linkedAt: '2026-10-08T10:00:00.000Z' } })
  serve({
    'GET /api/github-identity': () => Response.json(identity),
    'DELETE /api/github-identity': () => {
      identity = status()
      return Response.json({ unlinked: true })
    },
  })
  const container = await render(identity)
  await harness.act(async () => fireEvent.click(button(container, 'Unlink')))
  expect(requests).toHaveLength(0)
  expect(container.textContent).toContain('trusted-author list stay trusted')
  await harness.act(async () => fireEvent.click(button(container, 'Unlink GitHub account')))
  await waitFor(() => expect(button(container, 'Link GitHub account')).toBeTruthy())
  expect(requests.map((request) => `${request.method} ${request.url}`)).toContain('DELETE /api/github-identity')
})

test('a duplicate link stays visible as an error and the confirmation remains actionable', async () => {
  serve({
    'POST /api/github-identity/22222222-2222-4222-8222-222222222222/confirm': () =>
      Response.json({ error: 'refused', code: 'github_account_already_linked' }, { status: 409 }),
  })
  const container = await render(
    status({
      confirmation: {
        id: '22222222-2222-4222-8222-222222222222',
        accountId: '583231',
        login: 'octocat',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
  )
  await harness.act(async () => fireEvent.click(button(container, 'Link this account')))
  await waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already linked to another Ficus user')
  )
  expect(button(container, 'Link this account')).toBeTruthy()
})

test('unconfigured instances explain why linking is unavailable', async () => {
  const container = await render(status({ authorization: { configured: false, authority: 'local', mode: 'browser' } }))
  expect(container.textContent).toContain('not configured')
  expect(button(container, 'Link GitHub account').disabled).toBe(true)
})
