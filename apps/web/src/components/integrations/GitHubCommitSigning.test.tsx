import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, waitFor } from '@testing-library/dom'
import type { GitHubCommitSigningStatus } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueryKeys } from '../../queryKeys'
import { GitHubCommitSigning } from './GitHubCommitSigning'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let client: QueryClient
let originalFetch: typeof fetch
beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings' })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  originalFetch = globalThis.fetch
})
afterEach(async () => {
  await harness.cleanup()
  client.clear()
  globalThis.fetch = originalFetch
})

async function render(
  status: GitHubCommitSigningStatus,
  options: { canWrite?: boolean; onReconnect?: () => void } = {}
) {
  client.setQueryData(integrationQueryKeys.githubCommitSigning('account'), status)
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubCommitSigning
          connectionId="account"
          login="octo"
          canWrite={options.canWrite ?? true}
          onReconnect={options.onReconnect ?? (() => {})}
          reconnectPending={false}
        />
      </QueryClientProvider>
    )
  )
  return container
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`no "${label}" button in: ${container.textContent}`)
  return found
}

test('off: explains what turning it on does and offers one primary action', async () => {
  const container = await render({ state: 'off' })
  expect(container.textContent).toContain('Agents’ commits are not signed')
  expect(container.textContent).toContain('the private key stays on this Tau server')
  expect(button(container, 'Turn on signing').className).toContain('ficus-button-primary')
})

test('on: shows just the key fingerprint and Turn off, with no status sentence', async () => {
  const container = await render({ state: 'on', fingerprint: 'SHA256:abc', registeredOnGitHub: true })
  expect(container.textContent).toContain('SHA256:abc')
  expect(container.textContent).not.toContain('Verified')
  expect(container.querySelectorAll('p[role="status"]')).toHaveLength(0)
  expect(button(container, 'Turn off')).toBeTruthy()
  expect(container.textContent).not.toContain('Turn on signing')
})

test('a key removed on GitHub is called out with a way to set signing up again', async () => {
  const container = await render({ state: 'on', fingerprint: 'SHA256:abc', registeredOnGitHub: false })
  expect(container.textContent).toContain('The signing key was removed from @octo on GitHub')
  expect(button(container, 'Set up again')).toBeTruthy()
})

test('read-only viewers see the state but no controls', async () => {
  const container = await render({ state: 'off' }, { canWrite: false })
  expect(container.textContent).toContain('Agents’ commits are not signed')
  expect(container.querySelectorAll('button')).toHaveLength(0)
})

test('turning on posts to Core and shows the new state', async () => {
  const requests: Array<{ url: string; method?: string; body?: unknown }> = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method, body: init?.body })
    return Response.json({ state: 'on', fingerprint: 'SHA256:new', registeredOnGitHub: true })
  }) as typeof fetch
  const container = await render({ state: 'off' })
  await harness.act(async () => {
    fireEvent.click(button(container, 'Turn on signing'))
  })
  await waitFor(() => expect(container.textContent).toContain('SHA256:new'))
  expect(requests).toHaveLength(1)
  expect(requests[0]!.url).toContain('/integrations/connections/account/github-commit-signing')
  expect(requests[0]!.method).toBe('POST')
  expect(requests[0]!.body).toBe(JSON.stringify({ enabled: true }))
})

test('a missing App permission explains the fix and offers Reconnect', async () => {
  let reconnected = 0
  globalThis.fetch = (async () =>
    Response.json(
      { error: 'Tau’s GitHub App needs the “SSH signing keys” account permission.', code: 'permission_missing' },
      { status: 409 }
    )) as unknown as typeof fetch
  const container = await render({ state: 'off' }, { onReconnect: () => void reconnected++ })
  await harness.act(async () => {
    fireEvent.click(button(container, 'Turn on signing'))
  })
  await waitFor(() => expect(container.textContent).toContain('Tau needs permission to manage SSH signing keys'))
  const reconnect = button(container, 'Reconnect')
  expect(reconnect.className).toContain('ficus-button-primary')
  // Only one filled action at a time: turning on steps back while Reconnect leads.
  expect(button(container, 'Turn on signing').className).not.toContain('ficus-button-primary')
  await harness.act(async () => {
    fireEvent.click(reconnect)
  })
  expect(reconnected).toBe(1)
})
