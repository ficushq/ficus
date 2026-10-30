import { brief as workflowReviewBriefFixture } from '@ficus/shared/test-fixtures/workflow-review'
import { expect, spyOn, test } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  advanceWorkflowRun,
  createBlankWorkflow,
  workflowStepSchema,
  routeWorkflowDecision,
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
import { ReviewConversationContext, type ReviewConversationProps } from '../lib/reviewConversation'

/** Stands in for the agent's conversation: shows which agent it is and what a send would carry. */
function StubConversation({ agentId, sendOptions, placeholder }: ReviewConversationProps) {
  return (
    <div
      data-stub-conversation={agentId}
      data-send-options={JSON.stringify(sendOptions() ?? null)}
      data-placeholder={placeholder}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      {Array.from({ length: 60 }, (_, index) => (
        <p key={index}>Transcript line {index}</p>
      ))}
    </div>
  )
}

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
            <QueryClientProvider client={queryClient}>
              <ReviewConversationContext.Provider value={StubConversation}>{node}</ReviewConversationContext.Provider>
            </QueryClientProvider>
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

test('wide screens read the proposal beside the agent chat with the decision pinned below it', async () => {
  const f = await fixture()
  try {
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const dialog = f.dialog()!
    expect(dialog.getAttribute('aria-label')).toBe('Review Design review')
    expect(dialog.querySelector('[data-modal-size="workspace"]')).not.toBeNull()
    const layout = dialog.querySelector('[data-review-layout]')!
    expect(layout.getAttribute('data-review-layout')).toBe('chat-columns')
    const documentColumn = layout.querySelector<HTMLElement>('[data-review-document]')!
    expect(documentColumn.className).toContain('overflow-y-auto')
    expect(documentColumn.hasAttribute('data-scroll-container')).toBe(true)
    // The document column is the only scroll area for the document: nothing inside it scrolls or clips.
    for (const node of documentColumn.querySelectorAll<HTMLElement>('*'))
      expect(node.className.toString()).not.toMatch(/overflow-(y-)?(auto|scroll)|max-h-(48|64)/)
    expect(documentColumn.textContent).toContain('Review the architecture and completion proposal')
    expect(documentColumn.textContent).toContain('Read-only assessment of the head commit.')
    expect(documentColumn.querySelector('.max-w-\\[72ch\\]')).not.toBeNull()

    const rail = layout.querySelector<HTMLElement>('[data-review-rail]')!
    expect(rail.getAttribute('aria-label')).toBe('Agent chat and decision')
    expect(rail.className).toContain('w-[clamp(360px,36vw,480px)]')
    expect(rail.textContent).toContain('#438 · Gate GitHub feedback by trusted authors')
    expect(rail.textContent).toContain('execute · Attempt 3 · Proposal ready')
    expect(rail.querySelector('a[aria-label="Open execute attempt 3 agent chat"]')).not.toBeNull()
    expect(rail.querySelector('a[href="https://github.com/ficushq/ficus/pull/12"]')?.textContent).toBe('PR #12')
    // The same agent as Open chat, consulted as the reviewer of this gate.
    const [summary, chat, decision] = [...rail.children] as HTMLElement[]
    expect(chat!.hasAttribute('data-review-chat')).toBe(true)
    expect(chat!.className).toContain('flex-1')
    expect(chat!.className).toContain('min-h-0')
    const conversation = chat!.querySelector<HTMLElement>('[data-stub-conversation]')!
    expect(conversation.getAttribute('data-stub-conversation')).toBe('design-agent')
    expect(JSON.parse(conversation.getAttribute('data-send-options')!)).toEqual({
      reviewConsultation: { workStreamId: stream.id, gateAttemptId: 4 },
    })
    // The decision is pinned below the chat: never pushed out by a long transcript.
    expect(summary!.className).toContain('shrink-0')
    expect(decision!.hasAttribute('data-review-decision')).toBe(true)
    expect(decision!.className).toContain('shrink-0')
    expect(decision!.className).toContain('max-h-[50%]')
    expect(decision!.className).toContain('overflow-y-auto')
    expect(rail.lastElementChild).toBe(decision!)
    const notes = decision!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Decision and evidence"]')!
    expect(notes.getAttribute('rows')).toBe('3')
    expect(f.doc.getElementById(notes.getAttribute('aria-describedby')!)!.textContent).toContain(
      'Optional for Approved; required for Changes requested.'
    )
    expect(f.decisionButtons().map((button) => decision!.contains(button))).toEqual([true, true])
    // Earlier rounds stay available but collapsed, at the end of the document.
    const history = documentColumn.querySelector('details')!
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
        reviewedRevisions: [{ attemptId: 3, revision: 1 }],
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
    expect(layout.getAttribute('data-review-layout')).toBe('chat-tabs')
    expect(layout.className).toContain('flex-col')
    expect(layout.querySelector('[data-review-rail]')).toBeNull()
    // Brief and Chat panes; the sheet is the column's last, non-shrinking child, so it never scrolls away.
    const [paneSwitch, documentColumn, chatPane, sheet] = [...layout.children] as HTMLElement[]
    expect(paneSwitch!.getAttribute('role')).toBe('tablist')
    expect(chatPane!.hidden).toBe(true)
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
  ...f.dialog()!.querySelectorAll<HTMLButtonElement>('[data-review-document] [role="tablist"] [role="tab"]'),
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
    expect(layout.getAttribute('data-review-layout')).toBe('chat-tabs')
    const [, documentColumn, , sheet] = [...layout.children] as HTMLElement[]
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

test('authored brief leads with repeat-round context and collapses independent evidence', async () => {
  const f = await fixture()
  const download = spyOn(client.workflows, 'downloadAttachment').mockResolvedValue(
    new TextEncoder().encode('# Staging attachment\n\nKeep the fallback.')
  )
  try {
    const run = gateRun()
    run.state.attempts[2]!.decisionBrief = {
      submittedVersion: 7,
      contexts: [],
      value: {
        decision: 'Approve the staging migration design.',
        recommendation: 'Approve because fallback reads are tested.',
        approvalEffect: 'Approval permits staging implementation only, not deployment.',
        risks: 'Parallel paths increase maintenance work.',
        changesSinceLastReview:
          'The earlier review requested a smaller scope. This design removes the unrelated rollout.',
      },
    }
    run.state.attempts[3]!.reviewBrief = { kind: 'authored', sourceAttemptIds: [3] }
    run.attachments = { '3': [designDoc] }
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), run)
    await f.render(<WorkflowReviewModal stream={stream} attemptId={4} onClose={() => {}} />)
    const article = f.doc.querySelector('[aria-label="Decision brief"]')!
    expect(article).not.toBeNull()
    expect(tabs(f)[0]?.textContent).toBe('Decision brief')
    expect(tabs(f)[0]?.getAttribute('aria-selected')).toBe('true')
    expect(article.textContent).toContain('What changed since your last review')
    const disclosure = [...f.doc.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === 'Internal handoff'
    )!
    expect(disclosure.open).toBe(false)
    expect(article.compareDocumentPosition(disclosure) & 4).toBeTruthy()
    expect(disclosure.textContent).toContain('Read-only assessment of the head commit.')
    expect(f.doc.body.textContent).toContain('Human approval · Review the architecture')
    expect(tabs(f).map((tab) => tab.textContent)).toEqual(['Decision brief', 'design.md'])
    expect(download).not.toHaveBeenCalled()
    await f.dom.act(async () => tabs(f)[1]!.click())
    await f.settle()
    expect(f.doc.querySelector('[role="tabpanel"]')!.textContent).toContain('Staging attachment')
    expect(download).toHaveBeenCalledTimes(1)
    await f.dom.act(async () => tabs(f)[0]!.click())
    expect(f.doc.querySelector('[aria-label="Decision brief"]')).not.toBeNull()
    expect(f.doc.querySelector('details')!.open).toBe(false)
  } finally {
    download.mockRestore()
    await f.cleanup()
  }
})
test('non-agent no-brief notice and carried-forward label preserve the current gate message', async () => {
  for (const carry of [false, true]) {
    const f = await fixture()
    try {
      const run = gateRun()
      run.state.attempts[3]!.reviewBrief = carry ? { kind: 'carried-forward', sourceAttemptId: 3 } : { kind: 'none' }
      if (carry) {
        run.state.attempts[2]!.decisionBrief = {
          submittedVersion: 6,
          contexts: [],
          value: {
            decision: 'Approve the staging design.',
            recommendation: 'Approve because it is tested.',
            approvalEffect: 'Approval permits staging only, not production.',
            risks: 'Maintenance effort temporarily increases.',
          },
        }
        // A completed non-agent source carries the nearest agent submission.
        run.state.attempts.push({ id: 5, stepId: 'design-review', status: 'completed', sourceAttemptIds: [3] })
        run.state.attempts[3]!.sourceAttemptIds = [5]
      }
      f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), run)
      await f.render(<WorkflowReviewModal stream={stream} attemptId={4} onClose={() => {}} />)
      expect(f.doc.body.textContent).toContain(
        carry ? 'Carried forward from an earlier step' : 'No decision brief for this gate'
      )
      expect(f.doc.body.textContent).toContain('Review the architecture and completion proposal before release.')
    } finally {
      await f.cleanup()
    }
  }
})

test('queued review remains readable with every blocker, disabled controls and automatic clearance', async () => {
  const f = await fixture()
  const mutate = spyOn(client.workflows, 'advance').mockResolvedValue(undefined as never)
  try {
    const run = gateRun()
    run.openWaits!.push(
      ...['owner-a', 'owner-b'].map((id) => ({
        ...run.openWaits![0]!,
        id,
        resolutionHandler: undefined,
        flowAttemptId: null,
        actor: 'owner' as const,
        message: `Waiting for ${id}.`,
      }))
    )
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), run)
    await f.render(<WorkflowReviewModal stream={stream} attemptId={4} onClose={() => {}} />)
    expect(f.doc.body.textContent).toContain('Review queued')
    expect(f.doc.body.textContent).toContain('Waiting for owner-a.')
    expect(f.doc.body.textContent).toContain('Waiting for owner-b.')
    expect(f.decisionButtons().every((b) => b.disabled)).toBe(true)
    await f.dom.act(async () => f.decisionButtons()[0]!.click())
    expect(mutate).not.toHaveBeenCalled()
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), { ...run, openWaits: run.openWaits!.slice(0, 1) })
    await f.settle()
    expect(f.doc.body.textContent).not.toContain('Review queued')
    expect(f.decisionButtons()[0]!.disabled).toBe(false)
  } finally {
    mutate.mockRestore()
    await f.cleanup()
  }
})

test('an actual restarted human gate shows its new own message and the exact no-brief notice', async () => {
  const f = await fixture()
  try {
    const detail = gateRun()
    let state = createWorkflowRun(detail.state.definition)
    state = advanceWorkflowRun(state, {
      action: 'complete',
      expectedVersion: 0,
      attemptId: 1,
      outcome: 'completed',
      evidence: 'Original audit handoff.',
      decisionBrief: {
        decision: 'Approve the original staging scope.',
        recommendation: 'Approve because tests passed.',
        approvalEffect: 'Approval permits the original staging work only.',
        risks: 'Maintenance work temporarily increases.',
      },
    })
    const gate = state.attempts.at(-1)!
    state = advanceWorkflowRun(state, {
      action: 'revise',
      expectedVersion: state.version,
      attemptId: gate.id,
      active: 'restart',
      reason: 'Start a fresh review for replacement scope.',
      operations: [
        { op: 'put-step', step: { ...gate.step!, instructions: 'Review only the replacement staging scope.' } },
      ],
    })
    const current = state.attempts.at(-1)!
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), {
      ...detail,
      state,
      version: state.version,
      openWaits: [{ ...detail.openWaits[0]!, flowAttemptId: current.id }],
    })
    await f.render(<WorkflowReviewModal stream={stream} attemptId={current.id} onClose={() => {}} />)
    const article = f.doc.querySelector('[aria-label="Decision brief"]')!
    expect(article.textContent).toContain('No decision brief for this gate')
    expect(f.doc.querySelector('[data-review-document]')!.textContent).toContain(
      'Review only the replacement staging scope.'
    )
    expect(article.textContent).not.toContain('Approve the original staging scope.')
    expect(article.textContent).not.toContain('Carried forward')
  } finally {
    await f.cleanup()
  }
})

test('a restarted decision fallback excludes the old brief and shows its replacement own message', async () => {
  const f = await fixture()
  try {
    const definition = createBlankWorkflow()
    definition.steps[0]!.outcomes.completed = { next: 'choice' }
    definition.steps.push(
      workflowStepSchema.parse({
        id: 'choice',
        kind: 'decision',
        instructions: 'Choose the original staging scope.',
        questions: { ready: { type: 'yesno', instructions: 'Is staging ready?' } },
        outcomes: { yes: { next: 'finish' } },
      })
    )
    let state = advanceWorkflowRun(createWorkflowRun(definition), {
      action: 'complete',
      expectedVersion: 0,
      attemptId: 1,
      outcome: 'completed',
      evidence: 'Original internal handoff.',
      decisionBrief: workflowReviewBriefFixture,
    })
    state = advanceWorkflowRun(state, {
      action: 'revise',
      expectedVersion: state.version,
      attemptId: 2,
      active: 'restart',
      reason: 'Replace the staging choice session.',
      operations: [
        {
          op: 'put-step',
          step: { ...state.attempts[1]!.step!, instructions: 'Choose only the replacement staging scope.' },
        },
      ],
    })
    const current = state.attempts.at(-1)!
    const decisionStep = current.step
    if (decisionStep?.kind !== 'decision') throw new Error('Expected a decision fixture')
    current.decision = routeWorkflowDecision(decisionStep, { ok: false, reason: 'unavailable', errors: [] })
    const detail = gateRun()
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), {
      ...detail,
      state,
      version: state.version,
      attemptAgents: {},
      openWaits: [{ ...detail.openWaits[0]!, flowAttemptId: current.id }],
    })
    await f.render(<WorkflowReviewModal stream={stream} attemptId={current.id} onClose={() => {}} />)
    const panel = f.doc.querySelector('[role="tabpanel"]')!
    expect(panel.textContent).toContain('No decision brief for this gate')
    expect(panel.textContent).toContain('Choose only the replacement staging scope.')
    expect(panel.textContent).not.toContain(workflowReviewBriefFixture.decision)
    expect(panel.textContent).not.toContain('Carried forward from an earlier step')
  } finally {
    await f.cleanup()
  }
})

/** Attempt 3 authored a brief for the open gate, with three files. */
function briefRun(): WorkflowRunDetail {
  const run = gateRun()
  Object.assign(run.state.attempts[2]!, {
    settledVersion: 6,
    decisionBrief: { value: workflowReviewBriefFixture, submittedVersion: 6, contexts: [] },
  })
  run.state.attempts[3]!.reviewBrief = { kind: 'authored', sourceAttemptIds: [3] }
  const file = (id: string, path: string, revision = 1) => ({
    id,
    attemptId: 3,
    filename: path.split('/').pop()!,
    path,
    contentType: 'text/markdown',
    byteSize: 10,
    createdAt: '2026-10-08T09:00:00.000Z',
    revision,
  })
  run.attachments = { '3': [file('a', 'docs/design.md'), file('b', 'docs/plan.md'), file('r', 'docs/old.md')] }
  ;(run as { files?: unknown }).files = { file }
  return run
}

/** The agent amended attempt 3 while the gate stayed open: revision 2. */
function amendedRun(): WorkflowRunDetail {
  const run = briefRun()
  const [a, b, r] = run.attachments!['3']!
  const a2 = { ...a!, id: 'a2', revision: 2 }
  const c = { ...a!, id: 'c', filename: 'rollback.md', path: 'docs/rollback.md', revision: 2 }
  const source = run.state.attempts[2]!
  Object.assign(source, {
    earlierResults: [
      {
        revision: 1,
        version: 6,
        evidence: source.evidence,
        decisionBrief: source.decisionBrief,
        attachmentIds: ['a', 'b', 'r'],
      },
    ],
    resultRevision: 2,
    resultRevisedVersion: 8,
    resultRevisedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    evidence: 'Revised proposal, commit def5678.',
    attachmentIds: ['a2', 'b', 'c'],
    decisionBrief: {
      value: { ...workflowReviewBriefFixture, risks: 'A rollback note now covers the temporary second read path.' },
      submittedVersion: 8,
      contexts: [],
    },
  })
  run.version = 8
  run.attachments = { '3': [a2, b!, c] }
  run.earlierAttachments = { '3': [a!, r!] }
  return run
}

test('without a producing agent the review keeps the decision rail and the stacked phone layout', async () => {
  for (const [width, height, expected] of [
    [1440, 900, 'columns'],
    [390, 844, 'stacked'],
  ] as const) {
    const f = await fixture({ width, height })
    try {
      f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), { ...gateRun(), attemptAgents: {} })
      await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
      const layout = f.dialog()!.querySelector<HTMLElement>('[data-review-layout]')!
      expect(layout.getAttribute('data-review-layout')).toBe(expected)
      expect(layout.querySelector('[data-review-chat]')).toBeNull()
      if (expected === 'columns') expect(layout.querySelector('[data-review-rail]')!.className).toContain('w-[360px]')
      expect(f.decisionButtons()).toHaveLength(2)
    } finally {
      await f.cleanup()
    }
  }
})

test('a viewer who cannot decide can chat, but does not consult the agent as the reviewer', async () => {
  const f = await fixture({ permissions: [] })
  try {
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const conversation = f.dialog()!.querySelector<HTMLElement>('[data-stub-conversation]')!
    expect(conversation.getAttribute('data-send-options')).toBe('null')
    expect(conversation.getAttribute('data-placeholder')).toBe('Message the agent')
  } finally {
    await f.cleanup()
  }
})

test('phones switch between the brief and the chat, keeping both mounted and the decision reachable', async () => {
  const f = await fixture({ width: 390, height: 844 })
  try {
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const layout = f.dialog()!.querySelector<HTMLElement>('[data-review-layout]')!
    const [briefTab, chatTab] = [
      ...layout.querySelectorAll<HTMLButtonElement>('[data-review-pane-switch] [role="tab"]'),
    ]
    expect([briefTab!.textContent, chatTab!.textContent]).toEqual(['Brief', 'Chat'])
    expect(briefTab!.getAttribute('aria-selected')).toBe('true')
    const documentColumn = layout.querySelector<HTMLElement>('[data-review-document]')!
    const chatPane = layout.querySelector<HTMLElement>('[data-review-chat]')!.parentElement!
    expect([documentColumn.hidden, chatPane.hidden]).toEqual([false, true])

    await f.dom.act(async () => chatTab!.click())
    expect(chatTab!.getAttribute('aria-selected')).toBe('true')
    expect([documentColumn.hidden, chatPane.hidden]).toEqual([true, false])
    expect(documentColumn.className).toContain('hidden')
    // Still mounted, and the decision sheet stays below both panes.
    expect(documentColumn.textContent).toContain('one-page completion proposal')
    expect(layout.lastElementChild!.hasAttribute('data-review-sheet')).toBe(true)
    expect(f.decisionButtons()).toHaveLength(2)

    await f.dom.act(async () =>
      chatTab!.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    )
    expect(briefTab!.getAttribute('aria-selected')).toBe('true')
    expect(f.doc.activeElement).toBe(briefTab!)
  } finally {
    await f.cleanup()
  }
})

test('a revision that arrives while the review is open is marked, explained, and must be reviewed first', async () => {
  const f = await fixture()
  const advance = spyOn(client.workflows, 'advance').mockResolvedValue(undefined as never)
  try {
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), briefRun())
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const dialog = f.dialog()!
    expect(dialog.querySelector('[data-revised-marker]')).toBeNull()
    expect(f.decisionButtons()[0]!.disabled).toBe(false)

    await f.dom.act(async () => f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), amendedRun()))
    await f.settle()
    const marker = dialog.querySelector('[data-revised-marker]')!
    expect(marker.getAttribute('role')).toBe('status')
    expect(marker.textContent).toBe('Revised 2 min ago')
    expect(dialog.querySelector('[data-review-rail]')!.textContent).toContain('Attempt 3 · Proposal ready · Revision 2')

    const changes = dialog.querySelector<HTMLElement>('[data-revision-changes]')!
    expect(changes.textContent).toContain('What changed since you last looked')
    expect(changes.textContent).toContain('Revision 1 to revision 2')
    expect(changes.textContent).toContain('Risks and tradeoffs')
    expect(changes.textContent).toContain(workflowReviewBriefFixture.risks)
    expect(changes.textContent).toContain('A rollback note now covers the temporary second read path.')
    expect(changes.textContent).toContain('Unchanged: Decision, Recommendation, What approval allows.')
    expect(changes.textContent).toContain('The internal handoff changed.')
    const list = (title: string) =>
      [...changes.querySelectorAll('h4')].find((heading) => heading.textContent === title)!.nextElementSibling!
        .textContent
    expect(list('Added')).toBe('rollback.md')
    expect(list('Removed')).toBe('old.md')
    expect(list('Changed')).toBe('design.md')

    // Decisions wait until the person has looked at the new revision.
    const notice = dialog.querySelector('[data-revision-notice]')!
    expect(notice.textContent).toContain('This was revised since you opened it. Review the latest revision.')
    expect(f.decisionButtons().every((button) => button.disabled)).toBe(true)
    const acknowledge = [...notice.querySelectorAll('button')].find((b) => b.textContent === 'Mark as reviewed')!
    await f.dom.act(async () => acknowledge.click())
    expect(dialog.querySelector('[data-revision-changes]')).toBeNull()
    expect(dialog.querySelector('[data-revised-marker]')).toBeNull()
    expect(f.decisionButtons()[0]!.disabled).toBe(false)
    await f.dom.act(async () => f.decisionButtons()[0]!.click())
    await f.settle()
    expect(advance.mock.calls[0]![1]).toMatchObject({
      outcome: 'approved',
      expectedVersion: 8,
      reviewedRevisions: [{ attemptId: 3, revision: 2 }],
    })
  } finally {
    advance.mockRestore()
    await f.cleanup()
  }
})

test('a decision refused because of a newer revision keeps the notes and shows the plain message', async () => {
  const { HttpResponseError } = await import('@ficus/client-core')
  const f = await fixture()
  const advance = spyOn(client.workflows, 'advance').mockRejectedValue(
    new HttpResponseError(409, 'API error: 409: This was revised since you opened it. Review the latest revision.')
  )
  let closed = 0
  try {
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => closed++} />)
    await f.type('Checked the scope')
    await f.dom.act(async () => f.decisionButtons()[0]!.click())
    await f.settle()
    expect(closed).toBe(0)
    expect(f.doc.querySelector('textarea')!.value).toBe('Checked the scope')
    expect(f.dialog()!.querySelector('[role="alert"]')!.textContent).toBe(
      'This was revised since you opened it. Review the latest revision.'
    )
  } finally {
    advance.mockRestore()
    await f.cleanup()
  }
})

test('a gate fed by two agents offers a picker between their conversations', async () => {
  const f = await fixture()
  try {
    const run = gateRun()
    run.state.attempts.splice(3, 0, {
      id: 5,
      stepId: 'execute',
      status: 'completed',
      outcome: 'proposal-ready',
      evidence: 'Second branch',
    })
    run.state.attempts.find((attempt) => attempt.id === 4)!.sourceAttemptIds = [3, 5]
    run.attemptAgents = { '3': 'design-agent', '5': 'branch-agent' }
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), run)
    await f.render(<WorkflowReviewModal stream={stream} focusWaitId="gate-wait" onClose={() => {}} />)
    const picker = f.dialog()!.querySelector('[role="group"][aria-label="Agent"]')!
    const buttons = [...picker.querySelectorAll('button')]
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    await f.dom.act(async () => buttons[1]!.click())
    expect(f.dialog()!.querySelector('[data-stub-conversation]')!.getAttribute('data-stub-conversation')).toBe(
      'branch-agent'
    )
  } finally {
    await f.cleanup()
  }
})
