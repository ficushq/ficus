import { useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { flushSync } from 'react-dom'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { workStreamRef, workStreamTitle, type WorkflowAttempt, type WorkStream } from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { client } from '../api/clientInstance'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { usePermissions } from '../hooks/usePermissions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { useWorkflowRefresh } from '../hooks/useWorkflowRefresh'
import { actionErrorMessage } from '../lib/actionError'
import {
  attemptSummary,
  decisionNotesHint,
  focusedHumanGate,
  humanGateContext,
  openHumanGates,
  outcomeEffect,
  outcomeLabel,
  outcomeRequiresNotes,
  readReviewDraft,
  reviewDraftKey,
  workflowReviewPath,
  writeReviewDraft,
  type HumanGateContext,
} from '../lib/workflowReview'
import { workStreamPullRequests } from '../lib/workStreamGithub'
import { queries } from '../queryOptions'
import { Badge } from './Badge'
import { ExpandableMarkdown } from './ExpandableMarkdown'
import { MarkdownContent } from './MarkdownContent'
import { Modal } from './Modal'
import { WorkStreamViewModal } from './WorkStreamViewModal'
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
      headerExtra={gate && <Badge color="review">{gate.canDecide ? 'Your review' : 'Awaiting review'}</Badge>}
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
        },
        crypto.randomUUID()
      ),
    onSuccess: () => {
      writeReviewDraft(draftKey, '')
      setNotesState('')
      refresh()
      onClose()
    },
  })
  const decision: DecisionState = { gate, run, notes, setNotes, advance }
  const navigation = { onOpenAgent, onOpenWorkStream }
  return (
    <div
      data-review-layout={wide ? 'columns' : 'stacked'}
      className={clsx('flex min-h-0 flex-1', wide ? 'flex-row' : 'flex-col')}
    >
      <div
        data-review-document
        tabIndex={-1}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain outline-none"
      >
        <div className="mx-auto w-full max-w-[72ch] px-5 pb-16 pt-6 sm:px-8 sm:pt-8">
          {!wide && (
            <div className="mb-6">
              <ReviewSummary stream={stream} run={run} gate={gate} {...navigation} />
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
          <ReviewDocument run={run} sources={gate.sources} />
          {!wide && gate.history.length > 0 && (
            <div className="mt-10 border-t border-panel-border pt-5">
              <DecisionHistory gate={gate} />
            </div>
          )}
        </div>
      </div>
      {wide ? (
        <aside
          aria-label="Decision"
          data-review-rail
          className="flex w-[360px] shrink-0 flex-col overflow-y-auto border-l border-panel-border bg-surface-secondary"
        >
          <div className="space-y-6 p-5">
            <ReviewSummary stream={stream} run={run} gate={gate} {...navigation} />
            <div className="border-t border-panel-border" />
            {gate.canDecide ? <DecisionForm layout="rail" {...decision} /> : <ReadOnlyDecision {...decision} />}
            {gate.history.length > 0 && <DecisionHistory gate={gate} />}
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
  onOpenAgent,
  onOpenWorkStream,
}: { stream: WorkStream; run: WorkflowRunDetail; gate: HumanGateContext } & ReviewNavigation) {
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
          <p key={source.id} className="text-xs text-secondary">
            {attemptSummary(run.state, source)}
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
}

/** Notes, then the outcomes stacked full width with the forward outcome first. */
function DecisionForm({ layout, gate, run, notes, setNotes, advance }: DecisionState & { layout: 'rail' }) {
  const id = useId()
  return (
    <div className="space-y-3" data-layout={layout}>
      <label htmlFor={`${id}-notes`} className="block text-sm font-medium text-primary">
        Decision notes
      </label>
      <NotesField id={`${id}-notes`} hintId={`${id}-hint`} rows={8} value={notes} onChange={setNotes} />
      <p id={`${id}-hint`} className="text-xs text-muted">
        {decisionNotesHint(gate.step, gate.outcomes)}
      </p>
      <div className="space-y-2 pt-2">
        <DecisionButtons gate={gate} run={run} notes={notes} advance={advance} />
      </div>
      <DecisionStatus gate={gate} advance={advance} />
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
          <div className="grid grid-cols-2 gap-2">
            <DecisionButtons {...state} />
          </div>
          <DecisionStatus gate={gate} advance={state.advance} />
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

function DecisionButtons({ gate, run, notes, advance }: Omit<DecisionState, 'setNotes'>) {
  return (
    <>
      {gate.outcomes.map(([outcome, transition]) => {
        const primary = outcome === gate.primaryOutcome
        const sendsBack = 'returnTo' in transition
        return (
          <button
            key={outcome}
            type="button"
            title={outcomeEffect(run.state, transition)}
            className={clsx(
              'ficus-button block w-full px-4 py-2.5 text-sm disabled:opacity-50',
              primary ? 'ficus-button-primary' : sendsBack ? 'ficus-button-danger' : 'ficus-button-secondary'
            )}
            disabled={
              advance.isPending ||
              (outcomeRequiresNotes(gate.step, transition) && !notes.trim()) ||
              gate.blockingWaits.length > 0
            }
            onClick={() => advance.mutate(outcome)}
          >
            {outcomeLabel(outcome)}
            <span className="block text-xs font-normal opacity-80">{outcomeEffect(run.state, transition)}</span>
          </button>
        )
      })}
    </>
  )
}

function DecisionStatus({ gate, advance }: Pick<DecisionState, 'gate' | 'advance'>) {
  return (
    <>
      {gate.blockingWaits.length > 0 && (
        <p className="text-xs text-muted">Resolve the other open waits on this step before deciding.</p>
      )}
      {advance.error && (
        <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {actionErrorMessage(advance.error)}
        </p>
      )}
    </>
  )
}

/** What a viewer who cannot decide sees: that a decision is pending, why it is not theirs, and its outcomes. */
function ReadOnlyDecision({ gate, run }: Pick<DecisionState, 'gate' | 'run'>) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-primary">Awaiting a decision</p>
      <p className="text-xs text-muted">{gate.readOnlyReason}</p>
      <ul className="space-y-1 pt-1 text-xs text-secondary">
        {gate.outcomes.map(([outcome, transition]) => (
          <li key={outcome}>
            <span className="font-medium">{outcomeLabel(outcome)}</span>
            <span className="text-muted"> · {outcomeEffect(run.state, transition)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DecisionHistory({ gate }: { gate: HumanGateContext }) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs font-medium text-secondary hover:text-primary">
        Earlier decisions ({gate.history.length})
      </summary>
      <ol className="mt-3 space-y-4">
        {gate.history.map((entry) => (
          <li key={entry.id} className="text-xs">
            <p className="font-medium text-secondary">
              Attempt {entry.id} · {outcomeLabel(entry.outcome ?? '')}
            </p>
            {entry.evidence && (
              <MarkdownContent variant="document" className="mt-1 text-xs text-secondary">
                {entry.evidence}
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
