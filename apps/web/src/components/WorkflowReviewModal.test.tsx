import { expect, spyOn, test } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  advanceWorkflowRun,
  createWorkflowRun,
  workflowPresetSchema,
  type WorkflowTransition,
  type WorkStream,
  type WorkStreamWait,
} from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { acquireDomHarness } from '../test/domHarness'
import { webkitTap } from '../test/webkitTap'
import { client } from '../api/clientInstance'
import { queryKeys } from '../queryKeys'
import { decisionNotesHint, outcomeRequiresNotes } from '../lib/workflowReview'
import { MarkdownContent } from './MarkdownContent'
import { WorkflowReviewCallout } from './WorkflowReviewCallout'
import { WorkflowReviewDeepLink, WorkflowReviewModal, WorkflowReviewRoute } from './WorkflowReviewModal'

const preset = workflowPresetSchema.parse(
  Bun.YAML.parse(await Bun.file(new URL('../../../../config/workflows/solo.yaml', import.meta.url)).text())
)
const stream = {
  id: 'review-stream',
  number: 438,
  title: 'Gate GitHub feedback by trusted authors',
  squadId: 'review-squad',
  status: 'active',
  agentIds: [],
  metadata: { codeHost: { integration: 'github', repository: 'ficushq/ficus', changeRequest: { number: 12 } } },
} as unknown as WorkStream

const proposal = [
  '# 438 — one-page completion proposal',
  '',
  'Read-only assessment of the head commit. Approval here is a design decision only.',
  '',
  '## Scope',
  '',
  '- Gate feedback by trusted authors',
  '- Keep pending events visible',
  '',
  '```ts',
  'const trusted = authors.filter(isTrusted)',
  '```',
].join('\n')

/** design-assessment proposed, the gate sent it back once, then a second proposal waits for review. */
function gateRun(): WorkflowRunDetail {
  const definition = structuredClone(preset.definition)
  const gate = {
    id: 'design-review',
    name: 'Design review',
    kind: 'human-approval' as const,
    approver: 'reviewers' as const,
    instructions: 'Review the architecture and completion proposal before release.',
    output: 'Decision',
    outcomes: { 'changes-requested': { returnTo: 'execute' }, approved: { next: 'finish' } },
  }
  definition.steps[0]!.outcomes.completed = { next: 'design-review' }
  definition.steps.push(gate)
  const state = createWorkflowRun(definition)
  Object.assign(state.attempts[0]!, { status: 'completed', outcome: 'completed', evidence: 'First draft' })
  state.attempts.push(
    {
      id: 2,
      stepId: 'design-review',
      status: 'completed',
      step: gate,
      sourceAttemptIds: [1],
      outcome: 'changes-requested',
      evidence: 'Tighten the scope',
    },
    { id: 3, stepId: 'execute', status: 'completed', outcome: 'proposal-ready', evidence: proposal },
    { id: 4, stepId: 'design-review', status: 'running', step: gate, sourceAttemptIds: [3] }
  )
  return {
    workStreamId: stream.id,
    source: {},
    state,
    version: 7,
    attemptAgents: { '3': 'design-agent' },
    openWaits: [
      {
        id: 'gate-wait',
        type: 'manual',
        flowAttemptId: 4,
        resolutionHandler: 'workflow',
        openedAt: '2026-10-08T10:00:00.000Z',
      } as WorkStreamWait,
    ],
  }
}

async function fixture({
  permissions = ['workstreams:review'],
  width = 1440,
  height = 900,
  url = 'http://localhost/',
}: { permissions?: string[]; width?: number; height?: number; url?: string } = {}) {
  const dom = await acquireDomHarness({ url, windowOptions: { width, height } })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queryKeys.squads.list(), [])
  queryClient.setQueryData(queryKeys.workflows.run(stream.id), gateRun())
  queryClient.setQueryData(queryKeys.squads.workStreamDetail(stream.id), stream)
  queryClient.setQueryData(queryKeys.squads.workStreamDetail('438'), stream)
  queryClient.setQueryData(queryKeys.auth.permissions(stream.squadId), {
    permissions,
    identity: { type: 'user', userId: 'reviewer' },
  })
  const root = dom.createRoot()
  const doc = dom.window.document
  return {
    dom,
    doc,
    queryClient,
    render: (node: ReactNode, initialEntries = ['/']) =>
      dom.act(async () =>
        root.root.render(
          <MemoryRouter initialEntries={initialEntries}>
            <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
          </MemoryRouter>
        )
      ),
    dialog: () => doc.querySelector<HTMLElement>('[role="dialog"][data-state="open"]'),
    decisionButtons: () =>
      [...doc.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].filter((button) =>
        /^(Approved|Changes requested)/.test(button.textContent ?? '')
      ),
    type: async (value: string) => {
      const input = doc.querySelector<HTMLTextAreaElement>('textarea')!
      await dom.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      return input
    },
    settle: () => dom.act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0))),
    cleanup: async () => {
      await dom.cleanup()
      queryClient.clear()
    },
  }
}

test('wide screens read the proposal in one scrolling column beside a decision rail', async () => {
  const f = await fixture()
  try {
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const dialog = f.dialog()!
    expect(dialog.getAttribute('aria-label')).toBe('Review Design review')
    expect(dialog.querySelector('[data-modal-size="workspace"]')).not.toBeNull()
    const layout = dialog.querySelector('[data-review-layout]')!
    expect(layout.getAttribute('data-review-layout')).toBe('columns')
    const documentColumn = layout.querySelector<HTMLElement>('[data-review-document]')!
    expect(documentColumn.className).toContain('overflow-y-auto')
    // The document column is the only scroll area for the document: nothing inside it scrolls or clips.
    for (const node of documentColumn.querySelectorAll<HTMLElement>('*'))
      expect(node.className.toString()).not.toMatch(/overflow-(y-)?(auto|scroll)|max-h-(48|64)/)
    expect(documentColumn.textContent).toContain('Review the architecture and completion proposal')
    expect(documentColumn.textContent).toContain('Read-only assessment of the head commit.')
    expect(documentColumn.querySelector('.max-w-\\[72ch\\]')).not.toBeNull()

    const rail = layout.querySelector<HTMLElement>('[data-review-rail]')!
    expect(rail.getAttribute('aria-label')).toBe('Decision')
    expect(rail.className).toContain('w-[360px]')
    expect(rail.textContent).toContain('#438 · Gate GitHub feedback by trusted authors')
    expect(rail.textContent).toContain('execute · Attempt 3 · Proposal ready')
    expect(rail.querySelector('a[aria-label="Open execute attempt 3 agent chat"]')).not.toBeNull()
    expect(rail.querySelector('a[href="https://github.com/ficushq/ficus/pull/12"]')?.textContent).toBe('PR #12')
    const notes = rail.querySelector<HTMLTextAreaElement>('textarea[aria-label="Decision and evidence"]')!
    expect(notes.getAttribute('rows')).toBe('8')
    expect(f.doc.getElementById(notes.getAttribute('aria-describedby')!)!.textContent).toContain(
      'Optional for Approved; required for Changes requested.'
    )
    expect(f.decisionButtons().every((button) => rail.contains(button) && button.className.includes('w-full'))).toBe(
      true
    )
    // Earlier rounds stay available but collapsed.
    const history = rail.querySelector('details')!
    expect(history.open).toBe(false)
    expect(history.querySelector('summary')!.textContent).toBe('Earlier decisions (1)')
    expect(history.textContent).toContain('Attempt 2 · Changes requested')
    expect(history.textContent).toContain('Tighten the scope')
  } finally {
    await f.cleanup()
  }
})

test('approving needs no notes, sending back does, and each outcome sends the same complete command', async () => {
  const f = await fixture()
  const advance = spyOn(client.workflows, 'advance').mockResolvedValue(undefined as never)
  let closed = 0
  try {
    await f.render(<WorkflowReviewModal stream={stream} attemptId={4} onClose={() => closed++} />)
    const [approve, sendBack] = f.decisionButtons()
    expect(approve!.textContent).toBe('ApprovedFinishes the flow')
    expect(sendBack!.textContent).toBe('Changes requestedSends back to execute')
    expect(approve!.className).toContain('ficus-button-primary')
    expect([approve!.disabled, sendBack!.disabled]).toEqual([false, true])
    await f.type('   ')
    expect([approve!.disabled, sendBack!.disabled]).toEqual([false, true])
    await f.type('Checked the proposal against the brief')
    expect(approve!.disabled || sendBack!.disabled).toBe(false)
    await f.dom.act(async () => sendBack!.click())
    await f.settle()
    expect(advance.mock.calls[0]!.slice(0, 2)).toEqual([
      stream.id,
      {
        action: 'complete',
        expectedVersion: 7,
        attemptId: 4,
        outcome: 'changes-requested',
        evidence: 'Checked the proposal against the brief',
        resume: false,
      },
    ])
    // A recorded decision closes the review and drops the saved draft.
    expect(closed).toBe(1)
    expect(f.dom.window.sessionStorage.getItem('ficus.reviewDraft.gate-wait')).toBeNull()
  } finally {
    advance.mockRestore()
    await f.cleanup()
  }
})

test('drafts persist per wait across closing, and Escape closes only the topmost dialog', async () => {
  const f = await fixture()
  let closed = 0
  try {
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => closed++} />)
    await f.type('Half-written notes')
    expect(f.dom.window.sessionStorage.getItem('ficus.reviewDraft.gate-wait')).toBe('Half-written notes')
    await f.dom.act(async () =>
      f.dom.window.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(closed).toBe(1)
    await f.render(<></>)
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => closed++} />)
    expect(f.doc.querySelector('textarea')!.value).toBe('Half-written notes')
  } finally {
    await f.cleanup()
  }
})

test('read-only viewers see the document and the pending decision without controls', async () => {
  const f = await fixture({ permissions: [] })
  try {
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const dialog = f.dialog()!
    expect(dialog.querySelector('[data-review-document]')!.textContent).toContain('one-page completion proposal')
    expect(dialog.querySelector('textarea')).toBeNull()
    expect(f.decisionButtons()).toEqual([])
    expect(dialog.textContent).toContain('Awaiting review')
    expect(dialog.textContent).toContain('You need review permission in this squad to decide.')
    expect(dialog.querySelector('[data-review-rail]')!.textContent).toContain('Approved · Finishes the flow')
  } finally {
    await f.cleanup()
  }
})

test('the compact callout card opens the review surface', async () => {
  const f = await fixture()
  try {
    await f.render(<WorkflowReviewCallout stream={stream} focusWaitId="gate-wait" />)
    const card = f.doc.querySelector('section[aria-label="Review Design review"]')!
    expect(card.textContent).toContain('Proposal · 438 — one-page completion proposal')
    expect(card.querySelector('p.line-clamp-3')!.textContent).toContain('Review the architecture')
    expect(card.querySelector('[class*="overflow-y-auto"]')).toBeNull()
    expect(card.querySelector('a[aria-label="Open execute attempt 3 agent chat"]')).not.toBeNull()
    expect(f.dialog()).toBeNull()
    const open = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Review and decide')!
    expect(open.className).toContain('ficus-button-secondary')
    await f.dom.act(async () => open.click())
    expect(f.dialog()!.querySelector('[data-review-rail] textarea')).not.toBeNull()
  } finally {
    await f.cleanup()
  }
})

test('deep links open the review over the page, and closing clears the link', async () => {
  const f = await fixture()
  let location = ''
  function Probe() {
    const current = useLocation()
    location = `${current.pathname}${current.search}`
    return null
  }
  try {
    await f.render(
      <>
        <Routes>
          <Route path="/work-streams/:workStreamId/review" element={<WorkflowReviewRoute />} />
          <Route path="*" element={<Probe />} />
        </Routes>
        <WorkflowReviewDeepLink />
      </>,
      ['/work-streams/438/review?wait=gate-wait']
    )
    expect(location).toBe('/?review=438&reviewWait=gate-wait')
    expect(f.dialog()!.getAttribute('aria-label')).toBe('Review Design review')
    expect(f.dialog()!.querySelector('[data-review-rail] textarea')).not.toBeNull()
    await f.dom.act(async () => f.dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    expect(location).toBe('/')
    expect(f.dialog()).toBeNull()
  } finally {
    await f.cleanup()
  }
})

test('phones stack the document over a sticky decision sheet that keeps notes above the keyboard', async () => {
  const f = await fixture({ width: 390, height: 844 })
  const advance = spyOn(client.workflows, 'advance').mockResolvedValue(undefined as never)
  try {
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const dialog = f.dialog()!
    // Full-screen on phones, sized to the visual viewport (which shrinks while the keyboard is open).
    expect(dialog.className).toContain('mobile-chat-modal')
    expect(dialog.style.getPropertyValue('--modal-viewport-height')).toBe('844px')
    const layout = dialog.querySelector<HTMLElement>('[data-review-layout]')!
    expect(layout.getAttribute('data-review-layout')).toBe('stacked')
    expect(layout.className).toContain('flex-col')
    expect(layout.querySelector('[data-review-rail]')).toBeNull()
    // Document first; the sheet is the column's last, non-shrinking child, so it never scrolls away.
    const [documentColumn, sheet] = [...layout.children] as HTMLElement[]
    expect(documentColumn!.hasAttribute('data-review-document')).toBe(true)
    expect(documentColumn!.className).toContain('flex-1')
    expect(sheet!.hasAttribute('data-review-sheet')).toBe(true)
    expect(sheet!.className).toContain('shrink-0')
    expect(sheet!.className).not.toMatch(/\bfixed\b|\babsolute\b/)
    expect(documentColumn!.textContent).toContain('#438 · Gate GitHub feedback by trusted authors')

    // Collapsed: the outcomes and an Add notes control.
    expect(sheet!.querySelector('textarea')).toBeNull()
    const toggle = [...sheet!.querySelectorAll('button')].find((button) => button.textContent === 'Add notes')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(sheet!.textContent).toContain('Notes are required to send back.')
    expect(f.decisionButtons().map((button) => sheet!.contains(button))).toEqual([true, true])

    // Expanded: the notes field, focused in the same tap so iOS raises the keyboard.
    await webkitTap(toggle, { touch: true })
    const notes = sheet!.querySelector<HTMLTextAreaElement>('textarea')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(f.doc.activeElement).toBe(notes)
    expect(notes.className).toContain('text-base')
    await f.type('Scope is right')

    // A WebKit tap on an outcome blurs the field first; the sheet must stay put so the tap lands.
    const approve = f.decisionButtons()[0]!
    expect(await webkitTap(approve, { touch: true })).toBe(true)
    await f.settle()
    expect(advance).toHaveBeenCalledTimes(1)
    expect((advance.mock.calls[0]![1] as { outcome: string; evidence: string }).outcome).toBe('approved')
    expect((advance.mock.calls[0]![1] as { outcome: string; evidence: string }).evidence).toBe('Scope is right')
  } finally {
    advance.mockRestore()
    await f.cleanup()
  }
})

test('embedded documents cap heading sizes; chat markdown keeps the prose scale', async () => {
  const css = await Bun.file(new URL('../design-system.css', import.meta.url)).text()
  const h1 = css.match(/\.prose\.prose-document h1 \{[^}]*font-size:\s*([\d.]+)em/)
  expect(h1).not.toBeNull()
  // At the review document's 16px body this is about 1.2rem: under 1.5rem and under the 1.25rem title.
  expect(Number(h1![1])).toBeLessThanOrEqual(1.25)
  for (const level of [2, 3, 4]) {
    const size = css.match(new RegExp(`\\.prose\\.prose-document h${level} \\{[^}]*font-size:\\s*([\\d.]+)em`))
    expect(Number(size![1])).toBeLessThan(Number(h1![1]))
  }

  const f = await fixture()
  try {
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const heading = f.doc.querySelector('[data-review-document] h1')!
    expect(heading.textContent).toBe('438 — one-page completion proposal')
    expect(heading.closest('.prose')!.classList.contains('prose-document')).toBe(true)
    // The surface title (text-xl, 1.25rem) stays above the document's largest heading.
    expect(f.doc.querySelector('[role="dialog"] h3 > span')!.className).toContain('text-xl')
    await f.render(<MarkdownContent>{'# Chat heading'}</MarkdownContent>)
    expect(f.doc.querySelector('h1')!.closest('.prose')!.classList.contains('prose-document')).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test('notes requiredness follows the Core complete contract from one per-outcome rule', () => {
  // Core accepts empty evidence only for a human approval that moves work forward.
  const step = gateRun().state.definition.steps.find((entry) => entry.id === 'design-review')!
  const state = gateRun().state
  const decide = (outcome: string) => () =>
    advanceWorkflowRun(state, {
      action: 'complete',
      expectedVersion: state.version,
      attemptId: 4,
      outcome,
      evidence: ' ',
    })
  expect(decide('approved')).not.toThrow()
  expect(decide('changes-requested')).toThrow('Decision notes are required')
  const outcomes: Array<[string, WorkflowTransition]> = [
    ['approved', { next: 'finish' }],
    ['changes-requested', { returnTo: 'execute' }],
  ]
  expect(outcomes.map(([, transition]) => outcomeRequiresNotes(step, transition))).toEqual([false, true])
  expect(decisionNotesHint(step, outcomes)).toBe(
    'Optional for Approved; required for Changes requested. Your notes are recorded with the decision and passed to the next step.'
  )
  expect(decisionNotesHint(step, outcomes.slice(0, 1))).toStartWith('Optional.')
  expect(decisionNotesHint(step, outcomes.slice(1))).toStartWith('Required.')
})

const designDoc = {
  id: 'att-design',
  attemptId: 3,
  filename: 'design.md',
  path: 'docs/plans/design.md',
  contentType: 'text/markdown',
  byteSize: 64,
  createdAt: '2026-10-08T09:59:00.000Z',
}
const mockup = { ...designDoc, id: 'att-mockup', filename: 'mock.html', path: 'out/mock.html' }
const bigLog = { ...designDoc, id: 'att-log', filename: 'run.log', path: 'out/run.log', byteSize: 2 * 1024 * 1024 }
/** Attempt 3 is the source under review; attempt 1 is the draft that was sent back. */
function withAttachments(f: Awaited<ReturnType<typeof fixture>>) {
  const stale = { ...designDoc, id: 'att-old', attemptId: 1, filename: 'old-design.md' }
  f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), {
    ...gateRun(),
    attachments: { '1': [stale], '3': [designDoc, mockup, bigLog] },
  })
}
const tabs = (f: Awaited<ReturnType<typeof fixture>>) => [
  ...f.dialog()!.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]'),
]

test('without attachments for the attempts under review the document has no tab row', async () => {
  const f = await fixture()
  try {
    // Only the sent-back draft attached a file; the re-run under review attached none.
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), {
      ...gateRun(),
      attachments: { '1': [{ ...designDoc, attemptId: 1 }] },
    })
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const documentColumn = f.dialog()!.querySelector('[data-review-document]')!
    expect(documentColumn.querySelector('[role="tablist"]')).toBeNull()
    expect(documentColumn.querySelector('[role="tabpanel"]')).toBeNull()
    expect(documentColumn.textContent).toContain('one-page completion proposal')
  } finally {
    await f.cleanup()
  }
})

test('handed-off files open as tabs beside the handoff, loading only when selected', async () => {
  const f = await fixture()
  const download = spyOn(client.workflows, 'downloadAttachment').mockResolvedValue(
    new TextEncoder().encode('# Design doc\n\nUse a queue.')
  )
  try {
    withAttachments(f)
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const documentColumn = f.dialog()!.querySelector<HTMLElement>('[data-review-document]')!
    const tablist = documentColumn.querySelector<HTMLElement>('[role="tablist"]')!
    expect(tablist.getAttribute('aria-label')).toBe('Review documents')
    expect(tablist.className).toContain('overflow-x-auto')
    expect(tabs(f).map((tab) => tab.textContent)).toEqual(['Handoff', 'design.md', 'mock.html', 'run.log'])
    expect(tabs(f).map((tab) => tab.title)).toEqual(['', 'docs/plans/design.md', 'out/mock.html', 'out/run.log'])
    expect(tabs(f).map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false'])
    const panel = documentColumn.querySelector<HTMLElement>('[role="tabpanel"]')!
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs(f)[0]!.id)
    expect(tabs(f)[0]!.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.textContent).toContain('one-page completion proposal')
    expect(download).not.toHaveBeenCalled()

    await f.dom.act(async () => tabs(f)[1]!.click())
    await f.settle()
    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0]!.slice(0, 2)).toEqual([stream.id, 'att-design'])
    expect(tabs(f)[1]!.getAttribute('aria-selected')).toBe('true')
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs(f)[1]!.id)
    const heading = panel.querySelector('h1')!
    expect(heading.textContent).toBe('Design doc')
    expect(heading.closest('.prose')!.classList.contains('prose-document')).toBe(true)
    expect(panel.textContent).toContain('docs/plans/design.md')
    expect(panel.textContent).not.toContain('one-page completion proposal')

    // A file a browser could run is never rendered, only offered for download.
    await f.dom.act(async () => tabs(f)[2]!.click())
    await f.settle()
    expect(panel.textContent).toContain('This file type cannot be previewed here.')
    expect(panel.querySelector('iframe, script')).toBeNull()
    expect(download).toHaveBeenCalledTimes(1)
    const save = [...panel.querySelectorAll('button')].find((button) => button.textContent === 'Download')!
    expect(save.className).toContain('ficus-button-secondary')
    await f.dom.act(async () => save.click())
    await f.settle()
    expect(download.mock.calls.at(-1)!.slice(0, 2)).toEqual([stream.id, 'att-mockup'])

    // Text over the inline cap is not fetched to render.
    const calls = download.mock.calls.length
    await f.dom.act(async () => tabs(f)[3]!.click())
    await f.settle()
    expect(panel.textContent).toContain('This file is too large to preview here.')
    expect(download.mock.calls.length).toBe(calls)

    await f.dom.act(async () => tabs(f)[0]!.click())
    expect(panel.textContent).toContain('one-page completion proposal')
  } finally {
    download.mockRestore()
    await f.cleanup()
  }
})

test('arrow keys, Home and End move the selection between review tabs', async () => {
  const f = await fixture()
  const download = spyOn(client.workflows, 'downloadAttachment').mockResolvedValue(new TextEncoder().encode('# Doc'))
  try {
    withAttachments(f)
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const press = async (key: string) => {
      await f.dom.act(async () =>
        f.doc.activeElement!.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key, bubbles: true }))
      )
    }
    const selected = () => tabs(f).findIndex((tab) => tab.getAttribute('aria-selected') === 'true')
    expect(tabs(f).map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1])
    await f.dom.act(async () => tabs(f)[0]!.focus())
    await press('ArrowRight')
    expect(selected()).toBe(1)
    expect(f.doc.activeElement).toBe(tabs(f)[1]!)
    expect(tabs(f).map((tab) => tab.tabIndex)).toEqual([-1, 0, -1, -1])
    await press('End')
    expect(selected()).toBe(3)
    await press('ArrowRight')
    expect(selected()).toBe(0)
    await press('ArrowLeft')
    expect(selected()).toBe(3)
    await press('Home')
    expect(selected()).toBe(0)
    expect(f.doc.activeElement).toBe(tabs(f)[0]!)
  } finally {
    download.mockRestore()
    await f.cleanup()
  }
})

test('phones keep the tab row inside the document column above the decision sheet', async () => {
  const f = await fixture({ width: 390, height: 844 })
  try {
    withAttachments(f)
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const layout = f.dialog()!.querySelector<HTMLElement>('[data-review-layout]')!
    expect(layout.getAttribute('data-review-layout')).toBe('stacked')
    const [documentColumn, sheet] = [...layout.children] as HTMLElement[]
    expect(documentColumn!.hasAttribute('data-review-document')).toBe(true)
    expect(sheet!.hasAttribute('data-review-sheet')).toBe(true)
    const row = documentColumn!.firstElementChild as HTMLElement
    expect(row.className).toContain('sticky')
    expect(row.querySelector('[role="tablist"]')!.className).toContain('overflow-x-auto')
    expect(tabs(f).every((tab) => tab.className.includes('shrink-0'))).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test('switching tabs starts the new document at the top', async () => {
  const f = await fixture()
  const download = spyOn(client.workflows, 'downloadAttachment').mockResolvedValue(new TextEncoder().encode('# Doc'))
  try {
    withAttachments(f)
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const documentColumn = f.dialog()!.querySelector<HTMLElement>('[data-review-document]')!
    documentColumn.scrollTop = 480
    expect(documentColumn.scrollTop).toBe(480)
    await f.dom.act(async () => tabs(f)[1]!.click())
    expect(documentColumn.scrollTop).toBe(0)
  } finally {
    download.mockRestore()
    await f.cleanup()
  }
})

test('an image attachment renders from a blob URL that is revoked when the tab closes', async () => {
  const f = await fixture()
  const png = { ...designDoc, id: 'att-shot', filename: 'screen.png', path: 'out/screen.png', contentType: 'image/png' }
  const download = spyOn(client.workflows, 'downloadAttachment').mockResolvedValue(new Uint8Array([137, 80, 78, 71]))
  const created: string[] = []
  const create = spyOn(URL, 'createObjectURL').mockImplementation(() => {
    created.push(`blob:review-image-${created.length + 1}`)
    return created.at(-1)!
  })
  const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  try {
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), { ...gateRun(), attachments: { '3': [png] } })
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    await f.dom.act(async () => tabs(f)[1]!.click())
    await f.settle()
    const image = f.dialog()!.querySelector<HTMLImageElement>('[role="tabpanel"] img')!
    expect(created.length).toBeGreaterThan(0)
    expect(image.getAttribute('src')).toBe(created.at(-1)!)
    expect(image.alt).toBe('screen.png')
    expect((create.mock.calls.at(-1)![0] as Blob).type).toBe('image/png')
    // Only superseded URLs (if the bytes were refetched) are gone while the image shows.
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(created.slice(0, -1))
    await f.dom.act(async () => tabs(f)[0]!.click())
    // Closing the tab releases every URL it made.
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(created)
  } finally {
    create.mockRestore()
    revoke.mockRestore()
    download.mockRestore()
    await f.cleanup()
  }
})

test('a PDF that cannot be read falls back to the download offer', async () => {
  const f = await fixture()
  const pdf = {
    ...designDoc,
    id: 'att-pdf',
    filename: 'review.pdf',
    path: 'out/review.pdf',
    contentType: 'application/pdf',
  }
  const download = spyOn(client.workflows, 'downloadAttachment').mockResolvedValue(
    new TextEncoder().encode('not really a PDF')
  )
  try {
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), { ...gateRun(), attachments: { '3': [pdf] } })
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    await f.dom.act(async () => tabs(f)[1]!.click())
    const panel = f.dialog()!.querySelector<HTMLElement>('[role="tabpanel"]')!
    // Readiness boundary: pdf.js loads on demand and then rejects the bytes.
    for (let tries = 0; tries < 200 && !panel.textContent!.includes('cannot be previewed'); tries++) await f.settle()
    expect(panel.textContent).toContain('This PDF cannot be previewed here.')
    expect([...panel.querySelectorAll('button')].some((button) => button.textContent === 'Download')).toBe(true)
    expect(panel.querySelector('canvas')).toBeNull()
  } finally {
    download.mockRestore()
    await f.cleanup()
  }
})
