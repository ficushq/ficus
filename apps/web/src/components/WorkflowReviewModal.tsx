import { WorkflowDecisionBrief } from './WorkflowDecisionBrief'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { flushSync } from 'react-dom'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  WORKFLOW_REVIEW_REVISED_MESSAGE,
  workflowDecisionRevisionNote,
  workflowGateRevisions,
  workflowResultRevision,
  workflowReviewBriefForAttempt,
  workStreamWaitActor,
  workStreamRef,
  workStreamTitle,
  type WorkflowAttempt,
  type WorkStream,
} from '@ficus/shared'
import { isHttpResponseError, type WorkflowRunDetail } from '@ficus/client-core'
import { client } from '../api/clientInstance'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { usePermissions } from '../hooks/usePermissions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { useWorkflowRefresh } from '../hooks/useWorkflowRefresh'
import { actionErrorMessage } from '../lib/actionError'
import { reviewDocuments } from '../lib/workflowAttachments'
import {
  attemptSummary,
  decisionNotesHint,
  focusedHumanGate,
  humanGateContext,
  humanGateSubtitle,
  openHumanGates,
  outcomeEffect,
  outcomeLabel,
  outcomeRequiresNotes,
  producingAgents,
  readReviewDraft,
  readSeenRevisions,
  REVIEW_CHAT_COLUMNS_QUERY,
  revisedLabel,
  reviewDraftKey,
  reviewSeenRevisionsKey,
  workflowReviewPath,
  writeReviewDraft,
  writeSeenRevisions,
  type HumanGateContext,
} from '../lib/workflowReview'
import { workStreamPullRequests } from '../lib/workStreamGithub'
import { queries } from '../queryOptions'
import { Badge } from './Badge'
import { ExpandableMarkdown } from './ExpandableMarkdown'
import { MarkdownContent } from './MarkdownContent'
import { Modal } from './Modal'
import { WorkStreamViewModal } from './WorkStreamViewModal'
import { AttachmentView, HANDOFF_TAB, ReviewTabs } from './WorkflowReviewAttachments'
import { WorkflowReviewChat } from './WorkflowReviewChat'
import { WorkflowRevisionChanges } from './WorkflowRevisionChanges'
import { ChatIcon, PullRequestIcon, WorkStreamIcon } from './icons'

/** At this width the review splits into the document and a decision rail; below it, a bottom sheet. */
export const REVIEW_COLUMNS_QUERY = '(min-width: 900px)'

interface ReviewNavigation {
  /** Following an agent-chat link leaves the review (and whatever opened it). */
  onOpenAgent?: () => void
  /** Show the full work stream. Without it the link navigates to the stream's Work tab. */
  onOpenWorkStream?: () => void
}

/**
 * The review surface for a workflow human gate: the handoff under review as a full reading document,
 * with the decision (notes and outcomes) beside it on wide screens and in a bottom sheet on phones.
 *
 * Decision notes are kept as a per-wait draft for the browser session, so closing the review (Escape,
 * the close button, the backdrop) never loses them; the draft clears once the decision is recorded.
 */
export function WorkflowReviewModal({
  stream,
  attemptId,
  focusWaitId,
  onClose,
  onOpenAgent,
  onOpenWorkStream,
}: {
  stream: WorkStream
  /** The gate attempt to review; otherwise the gate `focusWaitId` holds, else the first open gate. */
  attemptId?: number
  focusWaitId?: string
  onClose: () => void
} & ReviewNavigation) {
  const { data: run } = useQuery(queries.workflows.run(stream.id))
  const { can, identity } = usePermissions(stream.squadId)
  const attempt = run
    ? attemptId != null
      ? openHumanGates(stream, run).find((gate) => gate.id === attemptId)
      : focusedHumanGate(stream, run, focusWaitId)
    : undefined
  const gate = run && attempt ? humanGateContext(stream, run, attempt, { can, identity }) : undefined
  const name = gate ? (gate.step.name ?? gate.step.id) : 'Review'
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={gate ? `Review ${name}` : 'Review'}
      titleContent={<span className="text-xl leading-snug">{name}</span>}
      headerExtra={
        gate && (
          <Badge color={gate.blockingWaits.length ? 'neutral' : 'review'}>
            {gate.blockingWaits.length ? 'Review queued' : gate.canDecide ? 'Your review' : 'Awaiting review'}
          </Badge>
        )
      }
      size="workspace"
      mobileFullscreen
      noChildPadding
      closeOnEscape
    >
      {run === undefined ? null : run && attempt && gate ? (
        <ReviewLayout
          key={attempt.id}
          stream={stream}
          run={run}
          attempt={attempt}
          gate={gate}
          onClose={onClose}
          onOpenAgent={onOpenAgent}
          onOpenWorkStream={onOpenWorkStream}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p role="status" className="text-sm text-secondary">
            This review is no longer open.
          </p>
          {onOpenWorkStream && (
            <button
              type="button"
              onClick={onOpenWorkStream}
              className="ficus-button ficus-button-secondary px-3 py-2 text-sm"
            >
              Open work stream
            </button>
          )}
        </div>
      )}
    </Modal>
  )
}

function ReviewLayout({
  stream,
  run,
  attempt,
  gate,
  onClose,
  onOpenAgent,
  onOpenWorkStream,
}: {
  stream: WorkStream
  run: WorkflowRunDetail
  attempt: WorkflowAttempt
  gate: HumanGateContext
  onClose: () => void
} & ReviewNavigation) {
  const wide = useMediaQuery(REVIEW_COLUMNS_QUERY)
  const chatWide = useMediaQuery(REVIEW_CHAT_COLUMNS_QUERY)
  const agents = producingAgents(run, gate.sources)
  // Without a producing agent to chat with, the review keeps its document and decision rail layout.
  const layout: ReviewLayoutKind = agents.length
    ? chatWide
      ? 'chat-columns'
      : 'chat-tabs'
    : wide
      ? 'columns'
      : 'stacked'
  const summaryInDocument = layout === 'stacked' || layout === 'chat-tabs'
  const historyInDocument = layout !== 'columns'
  const [pane, setPane] = useState<'brief' | 'chat'>('brief')
  const revisions = useSeenRevisions(stream, attempt, run)
  const refresh = useWorkflowRefresh(stream)
  const draftKey = reviewDraftKey(stream, attempt, gate.gateWait?.id)
  const [notes, setNotesState] = useState(() => readReviewDraft(draftKey))
  const setNotes = (value: string) => {
    setNotesState(value)
    writeReviewDraft(draftKey, value)
  }
  const advance = useMutation({
    mutationFn: (outcome: string) =>
      client.workflows.advance(
        stream.id,
        {
          action: 'complete',
          expectedVersion: run.version,
          attemptId: attempt.id,
          outcome,
          evidence: notes,
          resume: false,
          // The revisions this person reviewed; Core refuses the decision if any is no longer current.
          reviewedRevisions: revisions.reviewed,
        },
        crypto.randomUUID()
      ),
    onError: (error) => {
      // Revised while open: show the latest revision and keep the notes.
      if (isRevisedError(error)) refresh()
    },
    onSuccess: () => {
      writeReviewDraft(draftKey, '')
      setNotesState('')
      refresh()
      onClose()
    },
  })
  const decision: DecisionState = { gate, run, notes, setNotes, advance, revisions }
  const navigation = { onOpenAgent, onOpenWorkStream }
  const brief = workflowReviewBriefForAttempt(run.state, attempt)
  const reviewSources = [
    ...new Map(
      [...gate.sources, ...brief.sources, ...(brief.carriedSources ?? [])].map((source) => [source.id, source])
    ).values(),
  ].sort((a, b) => a.id - b.id)
  // Each source attempt's own files: a re-run after a send-back shows only what that attempt attached.
  // Stream inputs come with the stream detail; a stream passed from a list fetches it.
  const { data: detail } = useQuery({
    ...queries.squads.workStreamDetail(stream.id),
    enabled: stream.assetAttachments === undefined,
    retry: false,
  })
  const attachments = reviewDocuments(
    run,
    reviewSources.map((source) => source.id),
    stream.assetAttachments ?? detail?.assetAttachments ?? []
  )
  const hasBriefDisplay = brief.kind !== 'legacy'
  const primary = hasBriefDisplay
    ? { id: 'decision-brief', label: 'Decision brief' }
    : { id: HANDOFF_TAB, label: 'Handoff' }
  const [tab, setTab] = useState(primary.id)
  const openFile = attachments.find((attachment) => attachment.id === tab)
  const tabsId = useId()
  const documentColumn = useRef<HTMLDivElement>(null)
  const selectTab = (id: string) => {
    setTab(id)
    // Each tab is its own document: open it at the top, not at the last one's scroll position.
    if (documentColumn.current) documentColumn.current.scrollTop = 0
  }
  const handoff = (
    <div className="mx-auto w-full max-w-[72ch] px-5 pb-16 pt-6 sm:px-8 sm:pt-8">
      {summaryInDocument && !hasBriefDisplay && (
        <div className="mb-6">
          <ReviewSummary stream={stream} run={run} gate={gate} revisions={revisions} {...navigation} />
        </div>
      )}
      {gate.step.instructions.trim() && (
        <section aria-label="Review instructions" className="rounded-xl bg-surface-secondary px-4 py-3.5 sm:px-5">
          <h2 className="mb-1.5 text-xs font-medium text-muted">Instructions</h2>
          <ExpandableMarkdown label="instructions" markdownClassName="text-sm leading-relaxed text-secondary">
            {gate.step.instructions}
          </ExpandableMarkdown>
        </section>
      )}
      {gate.decisionNote && (
        <section
          aria-label="Automatic decision"
          className="mt-4 rounded-xl border border-th-border px-4 py-3.5 sm:px-5"
        >
          <h2 className="mb-1.5 text-xs font-medium text-muted">Automatic decision</h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-secondary">{gate.decisionNote}</p>
        </section>
      )}
      <ReviewDocument run={run} sources={reviewSources} />
      {historyInDocument && gate.history.length > 0 && (
        <div className="mt-10 border-t border-panel-border pt-5">
          <DecisionHistory gate={gate} run={run} />
        </div>
      )}
    </div>
  )
  const primaryContent = hasBriefDisplay ? (
    <>
      <div className="mx-auto w-full max-w-[72ch] space-y-6 px-5 py-6 sm:px-8 sm:py-8">
        {summaryInDocument && (
          <ReviewSummary stream={stream} run={run} gate={gate} revisions={revisions} {...navigation} />
        )}
        <p className="text-sm text-muted">
          {humanGateSubtitle(gate.step.instructions, gate.step.name ?? gate.step.id)}
        </p>
        <WorkflowDecisionBrief
          run={run.state}
          attempt={attempt}
          beforeSource={(source) =>
            revisions.unseen.some((entry) => entry.attemptId === source.id) ? (
              <WorkflowRevisionChanges
                run={run}
                source={source}
                seenRevision={revisions.seen[String(source.id)] ?? 1}
                onOpenFile={selectTab}
              />
            ) : null
          }
        />
        {(brief.kind === 'none' || brief.kind === 'carried-forward') && (
          <MarkdownContent variant="document" className="text-sm text-secondary">
            {gate.step.instructions}
          </MarkdownContent>
        )}
      </div>
      <details className="border-t border-panel-border">
        <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-secondary sm:px-8">
          Internal handoff
        </summary>
        {handoff}
      </details>
    </>
  ) : (
    handoff
  )
  const documentContent =
    !hasBriefDisplay && attachments.length === 0 ? (
      handoff
    ) : (
      <>
        <ReviewTabs
          idPrefix={tabsId}
          attachments={attachments}
          primary={primary}
          selected={openFile?.id ?? primary.id}
          onSelect={selectTab}
        />
        <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-tab-${openFile?.id ?? primary.id}`}>
          {openFile ? (
            <div className="mx-auto w-full max-w-[72ch] px-5 pb-16 pt-6 sm:px-8 sm:pt-8">
              <AttachmentView key={openFile.id} workStreamId={stream.id} attachment={openFile} />
            </div>
          ) : (
            primaryContent
          )}
        </div>
      </>
    )

  const tabsMode = layout === 'chat-tabs'
  const documentPane = (
    <div
      ref={documentColumn}
      data-review-document
      // The column that scrolls: lazy content (PDF pages) measures its look-ahead against it.
      data-scroll-container
      tabIndex={-1}
      {...(tabsMode
        ? { id: `${tabsId}-brief-pane`, role: 'tabpanel', 'aria-labelledby': `${tabsId}-brief-switch` }
        : {})}
      // Both panes stay mounted on phones, so switching keeps scroll, drafts and in-flight sends.
      hidden={tabsMode && pane !== 'brief'}
      className={clsx(
        'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain outline-none',
        tabsMode && pane !== 'brief' && 'hidden'
      )}
    >
      {documentContent}
    </div>
  )
  const chat = (
    <WorkflowReviewChat
      workStreamId={stream.id}
      gateAttemptId={attempt.id}
      run={run}
      agents={agents}
      consult={gate.canDecide}
    />
  )
  if (layout === 'chat-columns')
    return (
      <div data-review-layout={layout} className="flex min-h-0 flex-1 flex-row">
        {documentPane}
        <aside
          aria-label="Agent chat and decision"
          data-review-rail
          className="flex w-[clamp(360px,36vw,480px)] shrink-0 flex-col border-l border-panel-border bg-surface-secondary"
        >
          <div className="max-h-[30%] shrink-0 overflow-y-auto border-b border-panel-border p-4">
            <ReviewSummary stream={stream} run={run} gate={gate} revisions={revisions} {...navigation} />
          </div>
          {chat}
          {/* Pinned: the chat scrolls on its own and never pushes the decision out of reach. */}
          <section
            aria-label="Decision"
            data-review-decision
            className="max-h-[50%] shrink-0 overflow-y-auto border-t border-panel-border p-4"
          >
            {gate.canDecide ? <DecisionForm layout="pinned" {...decision} /> : <ReadOnlyDecision {...decision} />}
          </section>
        </aside>
      </div>
    )
  if (tabsMode)
    return (
      <div data-review-layout={layout} className="flex min-h-0 flex-1 flex-col">
        <ReviewPaneSwitch idPrefix={tabsId} pane={pane} onChange={setPane} revised={revisions.unseen.length > 0} />
        {documentPane}
        <div
          id={`${tabsId}-chat-pane`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-chat-switch`}
          hidden={pane !== 'chat'}
          className={clsx('min-h-0 flex-1 flex-col', pane === 'chat' ? 'flex' : 'hidden')}
        >
          {chat}
        </div>
        <DecisionSheet {...decision} />
      </div>
    )
  return (
    <div data-review-layout={layout} className={clsx('flex min-h-0 flex-1', wide ? 'flex-row' : 'flex-col')}>
      {documentPane}
      {wide ? (
        <aside
          aria-label="Decision"
          data-review-rail
          className="flex w-[360px] shrink-0 flex-col overflow-y-auto border-l border-panel-border bg-surface-secondary"
        >
          <div className="space-y-6 p-5">
            <ReviewSummary stream={stream} run={run} gate={gate} revisions={revisions} {...navigation} />
            <div className="border-t border-panel-border" />
            {gate.canDecide ? <DecisionForm layout="rail" {...decision} /> : <ReadOnlyDecision {...decision} />}
            {gate.history.length > 0 && <DecisionHistory gate={gate} run={run} />}
          </div>
        </aside>
      ) : (
        <DecisionSheet {...decision} />
      )}
    </div>
  )
}

/** The handoff(s) under review, as the one scrolling reading column. */
function ReviewDocument({ run, sources }: { run: WorkflowRunDetail; sources: WorkflowAttempt[] }) {
  return (
    <article aria-label="What to review" className="mt-8 space-y-10">
      {sources.length === 0 && <p className="text-sm text-muted">No handoff was recorded for this review.</p>}
      {sources.map((source) => (
        <section key={source.id} aria-label={attemptSummary(run.state, source)}>
          <h2 className="mb-4 border-b border-panel-border pb-2 text-xs font-medium text-muted">
            {attemptSummary(run.state, source)}
          </h2>
          {source.evidence ? (
            <MarkdownContent variant="document" className="prose-base text-primary">
              {source.evidence}
            </MarkdownContent>
          ) : (
            <p className="text-sm text-muted">This attempt recorded no handoff.</p>
          )}
        </section>
      ))}
    </article>
  )
}

/** Which work stream this is, the attempt under review, and where to look next. */
function ReviewSummary({
  stream,
  run,
  gate,
  revisions,
  onOpenAgent,
  onOpenWorkStream,
}: {
  stream: WorkStream
  run: WorkflowRunDetail
  gate: HumanGateContext
  revisions: ReviewRevisions
} & ReviewNavigation) {
  const { slugFor } = useSquadSlugs()
  const pullRequests = workStreamPullRequests(stream.metadata ?? {})
  const files = stream.files?.length ?? 0
  const linkClass = 'inline-flex items-center gap-1.5 text-sm text-accent-light hover:text-link-hover hover:underline'
  const workStreamLink = (children: ReactNode) =>
    onOpenWorkStream ? (
      <button type="button" onClick={onOpenWorkStream} className={clsx('ficus-button ficus-button-link', linkClass)}>
        {children}
      </button>
    ) : (
      <Link
        to={`/squads/${slugFor(stream.squadId)}/work?ws=${encodeURIComponent(workStreamRef(stream))}`}
        onClick={onOpenAgent}
        className={linkClass}
      >
        {children}
      </Link>
    )
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium leading-snug text-primary">{workStreamTitle(stream)}</p>
        {gate.sources.map((source) => (
          <p key={source.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary">
            <span>
              {attemptSummary(run.state, source)}
              {workflowResultRevision(source) > 1 && ` · Revision ${workflowResultRevision(source)}`}
            </span>
            {revisions.unseen.some((entry) => entry.attemptId === source.id) && (
              <span role="status" data-revised-marker>
                <Badge color="review">{revisedLabel(source.resultRevisedAt, revisions.now)}</Badge>
              </span>
            )}
          </p>
        ))}
        {gate.gateWait && (
          <p className="text-xs text-muted">Waiting since {new Date(gate.gateWait.openedAt).toLocaleString()}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {gate.sources.map((source) => {
          const agentId = run.attemptAgents[source.id]
          if (!agentId) return null
          return (
            <Link
              key={source.id}
              to={`/squads/${slugFor(stream.squadId)}/agents?agent=${encodeURIComponent(agentId)}`}
              onClick={onOpenAgent}
              className={linkClass}
              aria-label={`Open ${source.stepId} attempt ${source.id} agent chat`}
            >
              <ChatIcon className="h-3.5 w-3.5" />
              Open chat
            </Link>
          )
        })}
        {workStreamLink(
          <>
            <WorkStreamIcon className="h-3.5 w-3.5" />
            Work stream
          </>
        )}
        {pullRequests.map((pullRequest) =>
          pullRequest.url ? (
            <a
              key={pullRequest.key}
              href={pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
              title={pullRequest.repository}
            >
              <PullRequestIcon className="h-3.5 w-3.5 shrink-0" />
              PR #{pullRequest.number}
            </a>
          ) : (
            <span key={pullRequest.key} className="inline-flex items-center gap-1.5 text-sm text-secondary">
              <PullRequestIcon className="h-3.5 w-3.5 shrink-0" />
              PR #{pullRequest.number}
            </span>
          )
        )}
      </div>
      {files > 0 && (
        <p className="text-xs text-muted">
          {files === 1 ? '1 attached file is' : `${files} attached files are`} listed on the work stream.
        </p>
      )}
    </div>
  )
}

interface DecisionState {
  gate: HumanGateContext
  run: WorkflowRunDetail
  notes: string
  setNotes: (value: string) => void
  advance: { isPending: boolean; error: Error | null; mutate: (outcome: string) => void }
  revisions: ReviewRevisions
}

type ReviewLayoutKind = 'columns' | 'stacked' | 'chat-columns' | 'chat-tabs'

/** Core's refusal of a decision made on a revision that is no longer the latest. */
function isRevisedError(error: unknown): boolean {
  return isHttpResponseError(error, 409) && error.message.includes(WORKFLOW_REVIEW_REVISED_MESSAGE)
}

/**
 * The source revisions this reviewer has looked at (kept per gate for the session), the ones that
 * arrived since, and the revisions a decision records. Opening the review counts as looking at the
 * revisions shown; a later amendment stays unseen until the reviewer marks it reviewed.
 */
function useSeenRevisions(stream: WorkStream, attempt: WorkflowAttempt, run: WorkflowRunDetail) {
  const current = workflowGateRevisions(run.state, attempt)
  const key = reviewSeenRevisionsKey(stream, attempt)
  const [initial] = useState(() => {
    const opened = Object.fromEntries(current.map((entry) => [String(entry.attemptId), entry.revision]))
    const stored = readSeenRevisions(key)
    return { seen: stored ? { ...opened, ...stored } : opened, store: !stored }
  })
  const [seen, setSeen] = useState<Record<string, number>>(initial.seen)
  useEffect(() => {
    if (initial.store) writeSeenRevisions(key, initial.seen)
  }, [initial, key])
  const unseen = current.filter((entry) => entry.revision > (seen[String(entry.attemptId)] ?? entry.revision))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!unseen.length) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [unseen.length])
  return {
    seen,
    unseen,
    now,
    reviewed: current.map((entry) => ({
      attemptId: entry.attemptId,
      revision: seen[String(entry.attemptId)] ?? entry.revision,
    })),
    acknowledge: () => {
      const next = { ...seen, ...Object.fromEntries(current.map((entry) => [String(entry.attemptId), entry.revision])) }
      setSeen(next)
      writeSeenRevisions(key, next)
    },
  }
}
type ReviewRevisions = ReturnType<typeof useSeenRevisions>

/** Phones and narrow windows: switch between the brief and the agent chat. Both stay mounted. */
function ReviewPaneSwitch({
  idPrefix,
  pane,
  onChange,
  revised,
}: {
  idPrefix: string
  pane: 'brief' | 'chat'
  onChange: (pane: 'brief' | 'chat') => void
  revised: boolean
}) {
  const panes = [
    ['brief', 'Brief'],
    ['chat', 'Chat'],
  ] as const
  return (
    <div
      role="tablist"
      aria-label="Review panes"
      data-review-pane-switch
      className="flex shrink-0 gap-1 border-b border-panel-border px-4 py-2"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const next = pane === 'brief' ? 'chat' : 'brief'
        onChange(next)
        event.currentTarget.ownerDocument.getElementById(`${idPrefix}-${next}-switch`)?.focus()
      }}
    >
      {panes.map(([id, label]) => (
        <button
          key={id}
          id={`${idPrefix}-${id}-switch`}
          type="button"
          role="tab"
          aria-selected={pane === id}
          aria-controls={`${idPrefix}-${id}-pane`}
          tabIndex={pane === id ? 0 : -1}
          onClick={() => onChange(id)}
          className={clsx(
            'ficus-button min-h-8 flex-1 px-3 py-1.5 text-sm',
            pane === id ? 'ficus-button-primary' : 'ficus-button-secondary'
          )}
        >
          {label}
          {id === 'brief' && revised && (
            <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-current align-middle" aria-label="Revised" />
          )}
        </button>
      ))}
    </div>
  )
}

/** A revision arrived after the reviewer opened the review: decide only after looking at it. */
function RevisionNotice({ revisions }: { revisions: ReviewRevisions }) {
  if (!revisions.unseen.length) return null
  return (
    <div className="space-y-2" data-revision-notice>
      <p id="review-revised-notice" role="status" className="text-sm font-medium text-primary">
        {WORKFLOW_REVIEW_REVISED_MESSAGE}
      </p>
      <button
        type="button"
        onClick={revisions.acknowledge}
        className="ficus-button ficus-button-secondary w-full px-3 py-2 text-sm"
      >
        Mark as reviewed
      </button>
    </div>
  )
}

/** Notes, then the outcomes stacked full width with the forward outcome first. */
function DecisionForm({
  layout,
  gate,
  run,
  notes,
  setNotes,
  advance,
  revisions,
}: DecisionState & { layout: 'rail' | 'pinned' }) {
  const id = useId()
  return (
    <div className="space-y-3" data-layout={layout}>
      <label htmlFor={`${id}-notes`} className="block text-sm font-medium text-primary">
        Decision notes
      </label>
      <NotesField
        id={`${id}-notes`}
        hintId={`${id}-hint`}
        rows={layout === 'pinned' ? 3 : 8}
        value={notes}
        onChange={setNotes}
      />
      <p id={`${id}-hint`} className="text-xs text-muted">
        {decisionNotesHint(gate.step, gate.outcomes)}
      </p>
      <ReviewBlockers gate={gate} />
      <RevisionNotice revisions={revisions} />
      <div className={clsx(layout === 'pinned' ? 'grid grid-cols-2 gap-2' : 'space-y-2 pt-2')}>
        <DecisionButtons gate={gate} run={run} notes={notes} advance={advance} revisions={revisions} />
      </div>
      <DecisionStatus gate={gate} advance={advance} revisions={revisions} />
    </div>
  )
}

/**
 * Phones: a bottom sheet under the document. Collapsed it offers the outcomes and an Add notes control;
 * expanded it shows the notes field. The sheet sits in the dialog's flex column, which follows the visual
 * viewport, so the open keyboard pushes it up instead of covering the field. It never collapses on blur:
 * a WebKit tap on an outcome blurs the field first, and moving the buttons then would lose the tap.
 */
function DecisionSheet(state: DecisionState) {
  const { gate, notes, setNotes } = state
  const id = useId()
  const [expanded, setExpanded] = useState(() => !!notes.trim())
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const toggle = () => {
    // Focus inside the tap so iOS raises the keyboard.
    flushSync(() => setExpanded((value) => !value))
    if (!expanded) fieldRef.current?.focus()
  }
  return (
    <section
      aria-label="Decision"
      data-review-sheet
      data-expanded={expanded}
      className="max-h-[70%] shrink-0 space-y-3 overflow-y-auto border-t border-panel-border bg-surface-secondary px-4 py-3"
    >
      {gate.canDecide ? (
        <>
          {expanded && (
            <div id={`${id}-panel`} className="space-y-2">
              <label htmlFor={`${id}-notes`} className="block text-sm font-medium text-primary">
                Decision notes
              </label>
              <NotesField
                ref={fieldRef}
                id={`${id}-notes`}
                hintId={`${id}-hint`}
                rows={4}
                value={notes}
                onChange={setNotes}
              />
              <p id={`${id}-hint`} className="text-xs text-muted">
                {decisionNotesHint(gate.step, gate.outcomes)}
              </p>
            </div>
          )}
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={`${id}-panel`}
              onClick={toggle}
              className="ficus-button ficus-button-link shrink-0 py-1 text-sm font-medium"
            >
              {expanded ? 'Hide notes' : notes.trim() ? 'Edit notes' : 'Add notes'}
            </button>
            {!expanded && (
              <span className="min-w-0 truncate text-xs text-muted">{notes.trim() || collapsedNotesHint(gate)}</span>
            )}
          </div>
          <ReviewBlockers gate={gate} />
          <RevisionNotice revisions={state.revisions} />
          <div className="grid grid-cols-2 gap-2">
            <DecisionButtons {...state} />
          </div>
          <DecisionStatus gate={gate} advance={state.advance} revisions={state.revisions} />
        </>
      ) : (
        <ReadOnlyDecision {...state} />
      )}
    </section>
  )
}

/** The collapsed phone sheet's one-line notes rule, from the same per-outcome rule as the hint. */
function collapsedNotesHint(gate: DecisionState['gate']): string {
  const required = gate.outcomes.filter(([, transition]) => outcomeRequiresNotes(gate.step, transition)).length
  if (!required) return 'Notes are optional.'
  return required === gate.outcomes.length ? 'Notes are required to decide.' : 'Notes are required to send back.'
}

function NotesField({
  ref,
  id,
  hintId,
  rows,
  value,
  onChange,
}: {
  ref?: Ref<HTMLTextAreaElement>
  id: string
  hintId: string
  rows: number
  value: string
  onChange: (value: string) => void
}) {
  const own = useRef<HTMLTextAreaElement | null>(null)
  // Grow with the notes (from the `rows` minimum) up to about half the viewport, then scroll.
  useLayoutEffect(() => {
    const field = own.current
    if (!field) return
    field.style.height = ''
    const max = Math.round(window.innerHeight * 0.5)
    if (field.scrollHeight > field.clientHeight) field.style.height = `${Math.min(field.scrollHeight + 2, max)}px`
  }, [value])
  return (
    <textarea
      ref={(node) => {
        own.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      id={id}
      aria-label="Decision and evidence"
      aria-describedby={hintId}
      placeholder="What you checked and why you decided"
      rows={rows}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="ficus-field block w-full resize-none rounded-md border border-th-border px-3 py-2.5 text-base leading-relaxed sm:text-sm"
    />
  )
}

function DecisionButtons({ gate, run, notes, advance, revisions }: Omit<DecisionState, 'setNotes'>) {
  return (
    <>
      {gate.outcomes.map(([outcome, transition]) => {
        const primary = outcome === gate.primaryOutcome
        const sendsBack = 'returnTo' in transition
        return (
          <button
            key={outcome}
            type="button"
            title={outcomeEffect(run.state, transition, gate.attempt, outcome)}
            className={clsx(
              'ficus-button block w-full px-4 py-2.5 text-sm disabled:opacity-50',
              primary ? 'ficus-button-primary' : sendsBack ? 'ficus-button-danger' : 'ficus-button-secondary'
            )}
            disabled={
              advance.isPending ||
              (outcomeRequiresNotes(gate.step, transition) && !notes.trim()) ||
              gate.blockingWaits.length > 0 ||
              revisions.unseen.length > 0
            }
            aria-describedby={revisions.unseen.length ? 'review-revised-notice' : undefined}
            onClick={() => advance.mutate(outcome)}
          >
            {outcomeLabel(outcome)}
            <span className="block text-xs font-normal opacity-80">
              {outcomeEffect(run.state, transition, gate.attempt, outcome)}
            </span>
          </button>
        )
      })}
    </>
  )
}

function DecisionStatus({ advance, revisions }: Pick<DecisionState, 'gate' | 'advance' | 'revisions'>) {
  // The revision notice already says it when the latest revision is showing.
  const shown = isRevisedError(advance.error) && revisions.unseen.length > 0
  return (
    <>
      {advance.error && !shown && (
        <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {isRevisedError(advance.error) ? WORKFLOW_REVIEW_REVISED_MESSAGE : actionErrorMessage(advance.error)}
        </p>
      )}
    </>
  )
}

/** What a viewer who cannot decide sees: that a decision is pending, why it is not theirs, and its outcomes. */
function ReadOnlyDecision({ gate, run, revisions }: Pick<DecisionState, 'gate' | 'run' | 'revisions'>) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-primary">Awaiting a decision</p>
      <p className="text-xs text-muted">{gate.readOnlyReason}</p>
      <ReviewBlockers gate={gate} />
      <RevisionNotice revisions={revisions} />
      <ul className="space-y-1 pt-1 text-xs text-secondary">
        {gate.outcomes.map(([outcome, transition]) => (
          <li key={outcome}>
            <span className="font-medium">{outcomeLabel(outcome)}</span>
            <span className="text-muted"> · {outcomeEffect(run.state, transition, gate.attempt, outcome)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DecisionHistory({ gate, run }: { gate: HumanGateContext; run: WorkflowRunDetail }) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs font-medium text-secondary hover:text-primary">
        Earlier decisions ({gate.history.length})
      </summary>
      <ol className="mt-3 space-y-4">
        {gate.history.map((entry) => (
          <li key={entry.id} className="text-xs">
            <p className="font-medium text-secondary">
              Attempt {entry.id} · {entry.outcome ? outcomeLabel(entry.outcome) : 'Returned for rework'}
            </p>
            {workflowDecisionRevisionNote(run.state, entry) && (
              <p className="text-muted">{workflowDecisionRevisionNote(run.state, entry)}</p>
            )}
            <WorkflowDecisionBrief run={run.state} attempt={entry} />
            {(entry.evidence || entry.feedback) && (
              <MarkdownContent variant="document" className="mt-1 text-xs text-secondary">
                {entry.evidence ?? entry.feedback!}
              </MarkdownContent>
            )}
          </li>
        ))}
      </ol>
    </details>
  )
}

/**
 * Opens the review for a work stream from outside its detail (a Feed action, a deep link). Streams
 * without an open human gate (or whose focused wait is not one) open the work stream detail instead.
 */
export function WorkflowReviewLauncher({
  workStreamId,
  squadId,
  squadName,
  focusWaitId,
  actionCanRespond,
  onClose,
}: {
  workStreamId: string
  squadId?: string
  squadName?: string
  focusWaitId?: string
  actionCanRespond?: boolean
  onClose: () => void
}) {
  const { data: stream, isError } = useQuery(queries.squads.workStreamDetail(workStreamId))
  const { data: run, isError: runFailed } = useQuery({
    ...queries.workflows.run(stream?.id ?? workStreamId),
    enabled: !!stream,
  })
  const [showWorkStream, setShowWorkStream] = useState(false)
  if (isError)
    return (
      <Modal isOpen title="Review" onClose={onClose}>
        <p role="status">This work stream could not be opened. It may be unavailable or inaccessible.</p>
      </Modal>
    )
  if (!stream || (run === undefined && !runFailed)) return null
  const attempt = run ? focusedHumanGate(stream, run, focusWaitId) : undefined
  if (showWorkStream || !attempt)
    return (
      <WorkStreamViewModal
        workStreamId={stream.id}
        squadId={squadId ?? stream.squadId}
        squadName={squadName}
        focusWaitId={focusWaitId}
        actionCanRespond={actionCanRespond}
        onClose={onClose}
      />
    )
  return (
    <WorkflowReviewModal
      stream={stream}
      attemptId={attempt.id}
      onClose={onClose}
      onOpenAgent={onClose}
      onOpenWorkStream={() => setShowWorkStream(true)}
    />
  )
}

/** `?review=<work stream>&reviewWait=<wait>` on any page opens that review over it (notifications, shared links). */
export function WorkflowReviewDeepLink() {
  const [params, setParams] = useSearchParams()
  const reference = params.get('review')
  if (!reference) return null
  return (
    <WorkflowReviewLauncher
      key={reference}
      workStreamId={reference}
      focusWaitId={params.get('reviewWait') ?? undefined}
      onClose={() =>
        setParams(
          (current) => {
            const next = new URLSearchParams(current)
            next.delete('review')
            next.delete('reviewWait')
            return next
          },
          { replace: true }
        )
      }
    />
  )
}

/** `/work-streams/:workStreamId/review[?wait=…]`: a stable review link that opens over the Feed. */
export function WorkflowReviewRoute() {
  const { workStreamId = '' } = useParams<{ workStreamId: string }>()
  const [params] = useSearchParams()
  return <Navigate to={workflowReviewPath(workStreamId, params.get('wait') ?? undefined)} replace />
}

/** Blockers remain visible to readers as well as designated deciders. */
function ReviewBlockers({ gate }: { gate: HumanGateContext }) {
  if (!gate.blockingWaits.length) return null
  return (
    <section aria-label="Review blockers" className="space-y-2 text-xs text-secondary">
      <p>This review is queued. You can read it now, but you cannot decide until the following blockers are cleared.</p>
      <ul className="space-y-1">
        {gate.blockingWaits.map((wait) => (
          <li key={wait.id}>
            <span className="font-medium">
              {wait.type === 'manual'
                ? workStreamWaitActor(wait) === 'owner'
                  ? 'Waiting on owner:'
                  : workStreamWaitActor(wait) === 'manager'
                    ? 'Waiting on manager:'
                    : 'Waiting on input:'
                : wait.type === 'question'
                  ? 'Waiting for an answer:'
                  : wait.type === 'dependency'
                    ? 'Waiting on a dependency:'
                    : 'Waiting on another review:'}
            </span>{' '}
            {wait.message || 'No details were provided.'}
          </li>
        ))}
      </ul>
    </section>
  )
}
