import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, waitFor } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { githubFeedbackQueryKeys } from '../../queryKeys'
import {
  SQUAD,
  detailOf,
  fakeModerationApi,
  hash,
  item,
  moderationFetch,
  rid,
  type FakeModerationApi,
} from '../../test/fixtures/githubFeedbackServer'
import { GitHubFeedbackReviewModal } from './GitHubFeedbackReviewModal'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let oldFetch: typeof globalThis.fetch
let client: QueryClient
let api: FakeModerationApi

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/squads/s' })
  oldFetch = globalThis.fetch
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  api = fakeModerationApi({ pending: [item(1), item(2)] })
  globalThis.fetch = moderationFetch(api)
})
afterEach(async () => {
  await harness.cleanup()
  client.clear()
  globalThis.fetch = oldFetch
})

async function render(props: { onClose?: () => void } = {}) {
  const { root } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubFeedbackReviewModal squadId={SQUAD} isOpen onClose={props.onClose ?? (() => {})} />
      </QueryClientProvider>
    )
  )
  const dialog = () => document.querySelector('[role="dialog"][aria-label="Review GitHub events"]') as HTMLElement
  await waitFor(() => expect(dialog()?.textContent).toContain('@outsider1'))
  return dialog
}

const buttonIn = (scope: HTMLElement, text: string) => {
  const found = [...scope.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text
  )
  if (!found) throw new Error(`no "${text}" button in: ${scope.textContent}`)
  return found as HTMLButtonElement
}
const checkbox = (scope: HTMLElement, n: number) =>
  scope.querySelector(`input[type="checkbox"][data-revision-id="${rid(n)}"]`) as HTMLInputElement
/** Opens a row's detail. The row button's accessible name is its own visible text, not a fixed
 * "Review X" label, so tests target it by the same `data-revision-id` the checkbox uses. */
const openRow = (scope: HTMLElement, n: number) =>
  scope.querySelector(`button[data-revision-id="${rid(n)}"]`) as HTMLButtonElement
const decisionBodies = () =>
  api.requests.filter((r) => r.method === 'POST' && r.path === '/decisions').map((r) => r.body as Record<string, any>)
const refetch = () => harness.act(() => client.invalidateQueries({ queryKey: githubFeedbackQueryKeys.squad(SQUAD) }))

test('selection stays bound to the reviewed version across refresh; new events are never auto-selected', async () => {
  const dialog = await render()
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 1)))
  expect(dialog().textContent).toContain('1 selected')

  // An edit lands (new hash, new version) and a new event arrives while the human is reviewing.
  api.pending = [item(1, { contentHash: hash('edited'), decisionVersion: 1 }), item(2), item(3)]
  await refetch()
  await waitFor(() => expect(dialog().textContent).toContain('@outsider3'))
  expect(checkbox(dialog(), 3).checked).toBe(false)
  expect(checkbox(dialog(), 1).checked).toBe(true)
  expect(dialog().textContent).toContain('Changed since you selected it')

  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Allow once')))
  await waitFor(() => expect(decisionBodies()).toHaveLength(1))
  // The ORIGINAL reviewed hash/version is submitted, never the newer unseen one.
  expect(decisionBodies()[0]!.selections).toEqual([{ revisionId: rid(1), contentHash: hash('a1'), decisionVersion: 0 }])
})

test('a 409 conflict keeps the selection and asks for review instead of retrying silently', async () => {
  api.decide = () => Response.json({ code: 'moderation_selection_conflict' }, { status: 409 })
  const dialog = await render()
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 2)))
  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Deny')))
  await waitFor(() =>
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('changed or were already decided')
  )
  expect(checkbox(dialog(), 2).checked).toBe(true)
  expect(decisionBodies()).toHaveLength(1)
})

test('a conflict drops selections someone else already decided; clear selection empties the rest', async () => {
  const dialog = await render()
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 1)))
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 2)))
  // Another moderator denies event 1 first; it leaves the pending queue and could no longer be unchecked.
  api.decide = () => {
    api.pending = api.pending.filter((row) => row.id !== rid(1))
    return Response.json({ code: 'moderation_selection_conflict' }, { status: 409 })
  }
  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Allow once')))
  await waitFor(() => expect(dialog().textContent).toContain('1 selected'))
  expect(checkbox(dialog(), 2).checked).toBe(true)
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('changed or were already decided')
  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Clear selection')))
  expect(dialog().textContent).toContain('0 selected')
  expect(checkbox(dialog(), 2).checked).toBe(false)
})

test('success announces a queued release, not delivery, and clears only the decided selection', async () => {
  const dialog = await render()
  await harness.act(async () => fireEvent.click(openRow(dialog(), 1)))
  await waitFor(() => expect(dialog().textContent).toContain(`Body of ${rid(1)}`))
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 1)))
  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Allow once')))
  await waitFor(() => expect(dialog().textContent).toContain('Release is queued'))
  expect(dialog().textContent).not.toMatch(/\bdelivered\b/i)
  await waitFor(() => expect(dialog().textContent).not.toContain('@outsider1'))
  expect(dialog().textContent).toContain('@outsider2')
  expect(dialog().textContent).toContain('0 selected')
  // The decided event's detail is no longer presented as held.
  expect(dialog().textContent).not.toContain(`Body of ${rid(1)}`)
  expect(decisionBodies()[0]!.action).toBe('allow_once')
})

test('an ambiguous network failure retries with the SAME request ID so it cannot apply twice', async () => {
  let calls = 0
  api.decide = () => {
    calls += 1
    if (calls === 1) throw new TypeError('network down')
    return Response.json({ decisions: [] }, { status: 202 })
  }
  const dialog = await render()
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 1)))
  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Deny')))
  await waitFor(() => expect(dialog().textContent).toContain("couldn't confirm"))
  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Deny')))
  await waitFor(() => expect(decisionBodies()).toHaveLength(2))
  expect(decisionBodies()[1]!.requestId).toBe(decisionBodies()[0]!.requestId)
})

test('allow and trust requires an explicit confirmation naming each author and stating history is not released', async () => {
  const dialog = await render()
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 1)))
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 2)))
  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Allow and trust author')))
  expect(decisionBodies()).toHaveLength(0)
  const confirm = dialog().querySelector('[role="group"][aria-label="Confirm trusting authors"]') as HTMLElement
  expect(confirm.textContent).toContain('@outsider1')
  expect(confirm.textContent).toContain('@outsider2')
  expect(confirm.textContent).toContain('not released')
  await harness.act(async () => fireEvent.click(buttonIn(confirm, 'Allow and trust 2 authors')))
  await waitFor(() => expect(decisionBodies()).toHaveLength(1))
  expect(decisionBodies()[0]!.action).toBe('allow_trust')
  expect(decisionBodies()[0]!.selections).toHaveLength(2)
})

test('a selection that turns out to be withheld disables confirm-trust even after it is already open', async () => {
  api.details.set(rid(1), detailOf(item(1), { content: null, contentWithheld: 'source_access_unavailable' }))
  const dialog = await render()
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 1)))
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 2)))
  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Allow and trust author')))
  const confirmButton = () => buttonIn(dialog(), 'Allow and trust 2 authors')
  expect(confirmButton().disabled).toBe(false)
  // The confirmation panel stays open while the list/detail panes underneath are still live; opening
  // event 1's detail here reveals its content is withheld after all.
  await harness.act(async () => fireEvent.click(openRow(dialog(), 1)))
  await waitFor(() => expect(dialog().textContent).toContain('no longer has access'))
  await waitFor(() => expect(confirmButton().disabled).toBe(true))
  await harness.act(async () => fireEvent.click(confirmButton()))
  expect(decisionBodies()).toHaveLength(0)
})

test('read-only reviewers can inspect but have no selection or decision controls', async () => {
  api.canModerate = false
  const dialog = await render()
  expect(checkbox(dialog(), 1)).toBeNull()
  expect(dialog().textContent).toContain('permission to update this squad')
  expect([...dialog().querySelectorAll('button')].some((b) => b.textContent === 'Allow once')).toBe(false)
  await harness.act(async () => fireEvent.click(openRow(dialog(), 1)))
  await waitFor(() => expect(dialog().textContent).toContain(`Body of ${rid(1)}`))
})

test('a row names itself by its own visible text, and checkbox labels stay unique for same-author, same-kind events', async () => {
  const author = { accountId: '9001', login: 'dupe', accountType: 'User' } as const
  api.pending = [item(1), item(2, { author }), item(3, { author })]
  const dialog = await render()
  await waitFor(() => expect(dialog().textContent).toContain('@dupe'))
  const row = openRow(dialog(), 2)
  // The visible text (author, kind, target, time) IS the accessible name; nothing overrides it.
  expect(row.getAttribute('aria-label')).toBeNull()
  expect(row.textContent).toContain('@dupe')
  const labels = [checkbox(dialog(), 2), checkbox(dialog(), 3)].map((input) => input.getAttribute('aria-label'))
  expect(new Set(labels).size).toBe(2)
})

test('detail shows author, trust, source, recipients and why held; external content stays inert text', async () => {
  api.details.set(
    rid(1),
    detailOf(item(1), {
      content: {
        title: 'Title <b>bold</b>',
        body: '![x](https://evil.example/pixel.png) <script>alert(1)</script> [link](javascript:alert(1))',
        reviewState: '',
        deliveryText: 'agent-facing text',
        deliveryTruncated: false,
      },
      url: 'https://evil.example/not-github',
      authorTrust: [],
    })
  )
  api.details.set(rid(2), detailOf(item(2), { authorTrust: [{ kind: 'manual', addedByUserId: 'u1' }] }))
  const dialog = await render()
  await harness.act(async () => fireEvent.click(openRow(dialog(), 1)))
  const panel = () => dialog().querySelector('[aria-label="Event details"]') as HTMLElement
  await waitFor(() => expect(panel()?.textContent).toContain('<script>alert(1)</script>'))
  expect(panel().querySelector('img, script, b')).toBeNull()
  expect(panel().querySelector('a[href^="javascript:"], a[href*="evil.example"]')).toBeNull()
  expect(panel().textContent).toContain('Not trusted in this squad')
  expect(panel().textContent).toContain('Author is not trusted')
  expect(panel().textContent).toContain('acme/widgets')
  expect(panel().textContent).toContain('ws-1')
  // Hold-time routing is history only: release re-routes, so the copy must not promise this recipient.
  expect(panel().textContent).toContain('Matched when held')
  expect(panel().textContent).toContain('whoever should receive it at that time')
  expect(panel().textContent).not.toContain('Would go to')

  await harness.act(async () => fireEvent.click(openRow(dialog(), 2)))
  await waitFor(() => expect(panel().textContent).toContain('Added to this squad’s trusted authors'))
  const source = panel().querySelector('a[href^="https://github.com/"]') as HTMLAnchorElement
  expect(source.rel).toContain('noopener')
})

test('withheld content explains why and can still be denied but not allowed', async () => {
  // The server only reports `content_unavailable` when the list item's own `contentAvailable` is
  // false. `source_access_unavailable` means the content WAS captured; it just can't be shown or
  // released right now because the squad lost access to the GitHub connection it came from — so
  // the list item correctly reports `contentAvailable: true` here.
  api.pending = [item(1, { contentAvailable: true })]
  api.details.set(
    rid(1),
    detailOf(item(1, { contentAvailable: true }), { content: null, contentWithheld: 'source_access_unavailable' })
  )
  const dialog = await render()
  await harness.act(async () => fireEvent.click(openRow(dialog(), 1)))
  await waitFor(() => expect(dialog().textContent).toContain('no longer has access'))
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 1)))
  expect(buttonIn(dialog(), 'Allow once').disabled).toBe(true)
  expect(buttonIn(dialog(), 'Allow and trust author').disabled).toBe(true)
  expect(buttonIn(dialog(), 'Deny').disabled).toBe(false)
})

test('releasing tab shows retry state and retries a failed release', async () => {
  api.releasing = [item(5, { decision: 'allow_once', releaseState: 'retry', attempts: 3, reason: 'transient' })]
  const dialog = await render()
  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Releasing (1)')))
  await waitFor(() => expect(dialog().textContent).toContain('@outsider5'))
  expect(dialog().textContent).toContain('Retrying')
  await harness.act(async () => fireEvent.click(openRow(dialog(), 5)))
  await waitFor(() => expect(buttonIn(dialog(), 'Retry now')).toBeTruthy())
  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Retry now')))
  await waitFor(() =>
    expect(api.requests.some((r) => r.method === 'POST' && r.path === `/revisions/${rid(5)}/retry`)).toBe(true)
  )
})

test('pagination loads more without dropping selections', async () => {
  api.pending = Array.from({ length: 30 }, (_, i) => item(i + 1))
  const dialog = await render()
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 1)))
  await harness.act(async () => fireEvent.click(buttonIn(dialog(), 'Load more')))
  await waitFor(() => expect(dialog().textContent).toContain('@outsider30'))
  expect(checkbox(dialog(), 1).checked).toBe(true)
})

test('reopening prunes selections no longer pending, so they stop counting toward the 50 cap', async () => {
  const { root } = harness.createRoot()
  const dialog = () => document.querySelector('[role="dialog"][aria-label="Review GitHub events"]') as HTMLElement
  const renderWith = (isOpen: boolean) =>
    harness.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <GitHubFeedbackReviewModal squadId={SQUAD} isOpen={isOpen} onClose={() => {}} />
        </QueryClientProvider>
      )
    )
  await renderWith(true)
  await waitFor(() => expect(dialog()?.textContent).toContain('@outsider1'))
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 1)))
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 2)))
  await waitFor(() => expect(dialog().textContent).toContain('2 selected'))

  await renderWith(false)
  // Someone else decides event 1 while this dialog is closed; no 409 ever surfaces here.
  api.pending = [item(2)]
  await renderWith(true)
  await waitFor(() => expect(dialog().textContent).toContain('1 selected'))
  expect(checkbox(dialog(), 2).checked).toBe(true)
})

test('Tab wraps correctly whether focus is resting on the dialog itself or has drifted outside it', async () => {
  const dialog = await render()
  const focusable = () => [
    ...dialog().querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled])'),
  ]
  const first = () => focusable()[0]!
  const last = () => focusable()[focusable().length - 1]!

  // Resting state right after open: Modal focuses the dialog root itself, not a child control.
  dialog().focus()
  expect(document.activeElement).toBe(dialog())
  await harness.act(async () => fireEvent.keyDown(dialog(), { key: 'Tab' }))
  expect(document.activeElement).toBe(first())

  dialog().focus()
  await harness.act(async () => fireEvent.keyDown(dialog(), { key: 'Tab', shiftKey: true }))
  expect(document.activeElement).toBe(last())

  // Focus drifted outside the dialog entirely (e.g. a removed/hidden control reverted it to body).
  document.body.focus()
  await harness.act(async () => fireEvent.keyDown(document.body, { key: 'Tab' }))
  expect(document.activeElement).toBe(first())

  document.body.focus()
  await harness.act(async () => fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true }))
  expect(document.activeElement).toBe(last())
})

test('Escape closes; Enter in the content pane never submits a decision', async () => {
  let closed = 0
  const dialog = await render({ onClose: () => (closed += 1) })
  await harness.act(async () => fireEvent.click(checkbox(dialog(), 1)))
  await harness.act(async () => fireEvent.click(openRow(dialog(), 1)))
  const panel = dialog().querySelector('[aria-label="Event details"]') as HTMLElement
  await harness.act(async () => fireEvent.keyDown(panel, { key: 'Enter' }))
  expect(decisionBodies()).toHaveLength(0)
  await harness.act(async () => fireEvent.keyDown(panel, { key: 'Escape' }))
  expect(closed).toBe(1)
})
