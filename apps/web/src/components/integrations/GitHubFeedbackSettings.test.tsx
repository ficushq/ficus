import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, waitFor } from '@testing-library/dom'
import { MemoryRouter } from 'react-router-dom'
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
  await dom.act(async () =>
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </MemoryRouter>
    )
  )
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

const handlingGroup = (container: HTMLElement) =>
  container.querySelector('[role="radiogroup"][aria-label="Feedback from untrusted authors"]') as HTMLElement
const radio = (group: HTMLElement, label: string) =>
  [...group.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement

test('untrusted feedback is held by default, and screening is offered with a link to set up a model', async () => {
  const container = await render()
  const group = handlingGroup(container)
  expect(radio(group, 'Hold for review').getAttribute('aria-checked')).toBe('true')
  expect(radio(group, 'Screen with a model').getAttribute('aria-checked')).toBe('false')
  expect(radio(group, 'Screen with a model').title).toBe('Let a decision model screen it')
  expect(container.textContent).toContain('waits here until someone allows it or trusts its author')
  const setup = container.querySelector('a[href="/settings?section=decision-providers"]') as HTMLAnchorElement
  expect(setup.textContent).toContain('Settings → Decision Providers')
  expect(container.textContent).toContain('Screening needs a decision model.')
})

test('choosing screening saves it and explains that anything not clearly safe, or unscreened, stays held', async () => {
  api.other = (method, path, body) => {
    if (method !== 'PUT' || path !== '/untrusted-handling') return undefined
    api.summary = { ...api.summary, untrustedHandling: (body as { handling: 'hold' | 'screen' }).handling }
    return Response.json(body)
  }
  const container = await render()
  await click(radio(handlingGroup(container), 'Screen with a model'))
  await waitFor(() => expect(calls('PUT', '/untrusted-handling')).toHaveLength(1))
  expect(calls('PUT', '/untrusted-handling')[0]!.body).toEqual({ handling: 'screen' })
  await waitFor(() =>
    expect(radio(handlingGroup(container), 'Screen with a model').getAttribute('aria-checked')).toBe('true')
  )
  expect(container.textContent).toContain('delivered once, and its author still isn’t trusted')
  // No model yet: still selectable, because it fails closed, and the card says so.
  expect(container.textContent).toContain('No decision model is set up for the GitHub firewall')
  expect(container.querySelector('a[href="/settings?section=decision-providers"]')).not.toBeNull()
})

test('with a decision model set up there is no setup hint', async () => {
  api.summary = { untrustedHandling: 'screen', decisionModelConfigured: true }
  const container = await render()
  expect(radio(handlingGroup(container), 'Screen with a model').getAttribute('aria-checked')).toBe('true')
  expect(container.querySelector('a[href="/settings?section=decision-providers"]')).toBeNull()
})

test('the choice is read-only without squad update', async () => {
  api.canModerate = false
  const container = await render()
  for (const button of handlingGroup(container).querySelectorAll('[role="radio"]'))
    expect((button as HTMLButtonElement).disabled).toBe(true)
})

test('the choice is hidden while the author filter is off, since nothing is held', async () => {
  api.summary = { authorFilterEnabled: false }
  const container = await render()
  expect(handlingGroup(container)).toBeNull()
})

const maybeButton = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined

test('with screening on, held untrusted feedback can be screened now: Screening…, then the result and a refresh', async () => {
  api.summary = { untrustedHandling: 'screen', decisionModelConfigured: true, screenable: 3 }
  let finish!: (response: Response) => void
  api.other = (method, path) =>
    method === 'POST' && path === '/screen-pending'
      ? (new Promise<Response>((resolve) => (finish = resolve)) as unknown as Response)
      : undefined
  const container = await render()
  const summaries = () => calls('GET', '/summary').length
  const before = summaries()
  await click(buttonNamed(container, 'Screen 3 waiting now'))
  await waitFor(() => expect(buttonNamed(container, 'Screening…').disabled).toBe(true))
  expect(calls('POST', '/screen-pending')).toHaveLength(1)
  api.summary = { ...api.summary, screenable: 0 }
  await dom.act(async () => finish(Response.json({ queued: 3, skipped: 0, more: false }, { status: 202 })))
  await waitFor(() => expect(container.textContent).toContain('3 held events are being screened'))
  await waitFor(() => expect(summaries()).toBeGreaterThan(before))
  await waitFor(() => expect(maybeButton(container, 'Screen 0 waiting now')).toBeUndefined())
  // A second press while it ran was impossible: the button was disabled.
  expect(calls('POST', '/screen-pending')).toHaveLength(1)
})

test('switching to screening offers to screen what is already waiting', async () => {
  api.summary = { untrustedHandling: 'hold', decisionModelConfigured: true, screenable: 2 }
  api.other = (method, path, body) => {
    if (method === 'PUT' && path === '/untrusted-handling') {
      api.summary = { ...api.summary, untrustedHandling: (body as { handling: 'hold' | 'screen' }).handling }
      return Response.json(body)
    }
    if (method === 'POST' && path === '/screen-pending')
      return Response.json({ queued: 2, skipped: 0, more: true }, { status: 202 })
    return undefined
  }
  const container = await render()
  // Holding: nothing to screen from here.
  expect(maybeButton(container, 'Screen 2 waiting now')).toBeUndefined()
  await click(radio(handlingGroup(container), 'Screen with a model'))
  await waitFor(() => expect(container.textContent).toContain('2 held events are waiting. Screen them now?'))
  await click(buttonNamed(container, 'Screen them now'))
  await waitFor(() => expect(container.textContent).toContain('More are waiting; screen again to continue.'))
  expect(container.textContent).not.toContain('Screen them now?')
})

test('the screen-now button is absent with nothing waiting or without permission, and disabled without a model', async () => {
  api.summary = { untrustedHandling: 'screen', decisionModelConfigured: true, screenable: 0 }
  const container = await render()
  expect(maybeButton(container, 'Screen 0 waiting now')).toBeUndefined()
  await dom.act(async () => {
    api.summary = { untrustedHandling: 'screen', decisionModelConfigured: false, screenable: 4 }
    await client.invalidateQueries()
  })
  await waitFor(() => expect(buttonNamed(container, 'Screen 4 waiting now').disabled).toBe(true))
  expect(buttonNamed(container, 'Screen 4 waiting now').title).toBe('Set up a decision model first')
  await dom.act(async () => {
    api.canModerate = false
    await client.invalidateQueries()
  })
  await waitFor(() => expect(maybeButton(container, 'Screen 4 waiting now')).toBeUndefined())
})

test('a refused screen-now shows why', async () => {
  api.summary = { untrustedHandling: 'screen', decisionModelConfigured: true, screenable: 1 }
  api.other = (method, path) =>
    method === 'POST' && path === '/screen-pending'
      ? Response.json({ code: 'screening_not_enabled' }, { status: 409 })
      : undefined
  const container = await render()
  await click(buttonNamed(container, 'Screen 1 waiting now'))
  await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('Screen with a model'))
})
