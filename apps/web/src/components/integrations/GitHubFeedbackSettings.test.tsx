import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, waitFor } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import {
  SQUAD,
  fakeModerationApi,
  item,
  moderationFetch,
  type FakeModerationApi,
} from '../../test/fixtures/githubFeedbackServer'
import { GitHubFeedbackSettings } from './GitHubFeedbackSettings'
import { GitHubFeedbackReviewProvider } from './GitHubFeedbackReviewProvider'
import { PendingGitHubEventsSection } from './PendingGitHubEventsSection'

let dom: Awaited<ReturnType<typeof acquireDomHarness>>
let client: QueryClient
let api: FakeModerationApi
let oldFetch: typeof fetch

beforeEach(async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/squads/s/settings' })
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  api = fakeModerationApi({
    pending: [item(1)],
    trusted: {
      canManage: true,
      authors: [
        {
          accountId: '42',
          login: 'maintainer',
          accountType: 'User',
          origins: [
            { kind: 'linked_user', userId: 'u1' },
            { kind: 'manual', addedByUserId: 'u2' },
          ],
        },
        { accountId: '43', login: 'teammate', accountType: 'User', origins: [{ kind: 'linked_user', userId: 'u3' }] },
        { accountId: '44', login: 'ci-helper', accountType: 'Bot', origins: [{ kind: 'manual', addedByUserId: 'u2' }] },
      ],
    },
  })
  oldFetch = globalThis.fetch
  globalThis.fetch = moderationFetch(api)
})
afterEach(async () => {
  client.clear()
  globalThis.fetch = oldFetch
  await dom.cleanup()
})

async function render(node = <GitHubFeedbackSettings squadId={SQUAD} />) {
  const { root, container } = dom.createRoot()
  await dom.act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>))
  await waitFor(() => expect(container.textContent).toContain('@maintainer'))
  return container
}
const buttonNamed = (scope: ParentNode, text: string) => {
  const found = [...scope.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text
  )
  if (!found) throw new Error(`no "${text}" button`)
  return found as HTMLButtonElement
}
const click = (element: HTMLElement) => dom.act(async () => fireEvent.click(element))
const calls = (method: string, path: string) => api.requests.filter((r) => r.method === method && r.path === path)

test('lists every trust origin; only manual entries are removable', async () => {
  const container = await render()
  expect(container.textContent).toContain('@ci-helper (bot)')
  expect(container.textContent).toContain('Linked Ficus user who can update this squad')
  expect(container.textContent).toContain('Added to this squad’s trusted authors')
  expect(container.querySelector('[aria-label="Remove @teammate from trusted authors"]')).toBeNull()
  expect(container.querySelector('[aria-label="Remove @maintainer from trusted authors"]')).not.toBeNull()
})

test('removing a manual entry reports trust that remains from an independent linked origin', async () => {
  api.other = (method, path) =>
    method === 'DELETE' && path === '/trusted-authors/42'
      ? Response.json({ removed: true, remainingOrigins: [{ kind: 'linked_user', userId: 'u1' }] })
      : undefined
  const container = await render()
  await click(buttonNamed(container, 'Remove @maintainer from trusted authors'))
  await waitFor(() => expect(container.textContent).toContain('They are still trusted'))
  expect(container.textContent).not.toContain('@maintainer is no longer trusted')
})

test('adding requires a provider-verified preview and submits the confirmed account ID', async () => {
  api.other = (method, path, body) => {
    if (method === 'POST' && path === '/trusted-authors/resolve')
      return Response.json({ accountId: '99', login: (body as { login: string }).login, accountType: 'Bot' })
    if (method === 'POST' && path === '/trusted-authors')
      return Response.json({ accountId: '99', login: 'deploy-bot', accountType: 'Bot' }, { status: 201 })
    return undefined
  }
  const container = await render()
  const field = container.querySelector('input[aria-label="GitHub username to trust"]') as HTMLInputElement
  await dom.act(async () => fireEvent.input(field, { target: { value: 'deploy-bot' } }))
  await click(buttonNamed(container, 'Look up'))
  const confirm = await waitFor(() => {
    const group = container.querySelector('[role="group"][aria-label="Confirm trusted author"]')
    expect(group?.textContent).toContain('ID 99')
    return group as HTMLElement
  })
  expect(calls('POST', '/trusted-authors')).toHaveLength(0)
  await click(buttonNamed(confirm, 'Trust @deploy-bot (bot)'))
  await waitFor(() => expect(calls('POST', '/trusted-authors')).toHaveLength(1))
  expect(calls('POST', '/trusted-authors')[0]!.body).toEqual({ login: 'deploy-bot', accountId: '99' })
  await waitFor(() => expect(container.textContent).toContain('not released automatically'))
})

test('a username that moved to another account is refused and the stale preview is discarded', async () => {
  api.other = (method, path) => {
    if (method === 'POST' && path === '/trusted-authors/resolve')
      return Response.json({ accountId: '99', login: 'renamed', accountType: 'User' })
    if (method === 'POST' && path === '/trusted-authors')
      return Response.json({ code: 'account_changed' }, { status: 409 })
    return undefined
  }
  const container = await render()
  const field = container.querySelector('input[aria-label="GitHub username to trust"]') as HTMLInputElement
  await dom.act(async () => fireEvent.input(field, { target: { value: 'renamed' } }))
  await click(buttonNamed(container, 'Look up'))
  await waitFor(() => expect(container.textContent).toContain('ID 99'))
  await click(buttonNamed(container, 'Trust @renamed'))
  await waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('different GitHub account')
  )
  expect(container.querySelector('[aria-label="Confirm trusted author"]')).toBeNull()
})

test('turning author filtering off is confirmed, explains release of held events and reports the result', async () => {
  api.other = (method, path) =>
    method === 'PUT' && path === '/author-filter' ? Response.json({ enabled: false, released: 1 }) : undefined
  const container = await render()
  const toggle = container.querySelector('input[role="switch"]') as HTMLInputElement
  expect(toggle.checked).toBe(true)
  await click(toggle)
  expect(calls('PUT', '/author-filter')).toHaveLength(0)
  const confirm = container.querySelector('[aria-label="Confirm turning off author filtering"]') as HTMLElement
  expect(confirm.textContent).toContain('released to its current recipients')
  await click(buttonNamed(confirm, 'Turn off author filtering'))
  await waitFor(() => expect(container.textContent).toContain('1 held event was allowed and queued for release'))
  expect(calls('PUT', '/author-filter')[0]!.body).toEqual({ enabled: false })
})

test('read-only humans see state but cannot toggle the filter or edit trusted authors', async () => {
  api.canModerate = false
  api.trusted = { ...api.trusted, canManage: false }
  const container = await render()
  expect((container.querySelector('input[role="switch"]') as HTMLInputElement).disabled).toBe(true)
  expect(container.querySelector('input[aria-label="GitHub username to trust"]')).toBeNull()
  expect(container.querySelectorAll('[aria-label^="Remove "]')).toHaveLength(0)
  expect(container.textContent).toContain('permission to update this squad')
})

test('a failing release alone keeps the compact section visible and opens the releasing queue', async () => {
  api.pending = []
  api.releasing = [item(9, { decision: 'allow_once', releaseState: 'retry', attempts: 2 })]
  const { root, container } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubFeedbackReviewProvider squadId={SQUAD}>
          <PendingGitHubEventsSection squadId={SQUAD} />
        </GitHubFeedbackReviewProvider>
      </QueryClientProvider>
    )
  )
  await waitFor(() => expect(container.textContent).toContain('1 approved event has not been delivered yet'))
  await click(buttonNamed(container, 'View releases'))
  await waitFor(() => expect(api.requests.some((r) => r.path.startsWith('/revisions?queue=releasing'))).toBe(true))
})

test('closing the review dialog with Escape returns focus to the control that opened it', async () => {
  const { root, container } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubFeedbackReviewProvider squadId={SQUAD}>
          <PendingGitHubEventsSection squadId={SQUAD} />
        </GitHubFeedbackReviewProvider>
      </QueryClientProvider>
    )
  )
  const opener = await waitFor(() => buttonNamed(container, 'Review'))
  opener.focus()
  await click(opener)
  const dialog = await waitFor(() => {
    const found = document.querySelector('[role="dialog"][aria-label="Review GitHub events"]') as HTMLElement
    expect(found?.textContent).toContain('@outsider1')
    return found
  })
  expect(dialog.contains(document.activeElement)).toBe(true)
  await dom.act(async () => fireEvent.keyDown(dialog, { key: 'Escape' }))
  await waitFor(() => expect(document.activeElement).toBe(opener))
})
