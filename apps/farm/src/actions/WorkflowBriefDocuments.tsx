import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { WorkflowRunDetail } from '@ficus/client-core'
import {
  workflowChangesSinceSeen,
  workflowResultRevision,
  workflowReviewBriefForAttempt,
  workflowHistoricalStep,
  workflowIncomingAttempts,
  workStreamAssetDisplayName,
  type WorkflowAttempt,
  type WorkflowAttemptAttachment,
  type WorkflowUnseenRevision,
  type WorkStreamAssetAttachment,
} from '@ficus/shared'
import { useActionsApi } from './ActionsApiProvider'
import { ActionText, ErrorNote } from './ui'

/** Brief first, files as peer documents, and only the internal handoff behind a disclosure. */
/**
 * A document the review can open: a handoff file uploaded with --attach, or a stored chat image,
 * chat file or inbox attachment shared by ID (which can be removed, so it is never cached).
 */
interface BriefDocument {
  id: string
  filename: string
  /** What it is called on screen: a stored share's label when it has one, else its filename. */
  title: string
  contentType: string
  stored: boolean
  /** Where it came from, shown under the name; a stored reference has no path and is not given one. */
  detail: string
}

function storedBriefDocument(asset: WorkStreamAssetAttachment, scope: string): BriefDocument {
  // An inbox attachment's source line is "From inbox", the wording web and mobile use.
  const origin =
    asset.source.kind === 'inbox-attachment'
      ? 'From inbox'
      : `stored chat ${asset.source.kind === 'image' ? 'image' : 'file'}, shared by ID`
  const named = asset.label ? `${asset.filename} · ${origin}` : origin
  return {
    id: asset.id,
    filename: asset.filename,
    title: workStreamAssetDisplayName(asset),
    contentType: asset.contentType,
    stored: true,
    // A labelled share keeps its filename in view.
    detail: asset.source.kind === 'inbox-attachment' ? `${scope} · ${named}` : `${scope}: ${named}`,
  }
}

export function WorkflowBriefDocuments({
  run,
  attempt,
  instructions,
  inputs = [],
  children,
  unseen = [],
  preparedBy,
  approvalShownWithDecision,
}: {
  run: WorkflowRunDetail
  attempt: WorkflowAttempt
  instructions: string
  /** The work stream's stored inputs (absent from older servers). */
  inputs?: WorkStreamAssetAttachment[]
  children: ReactNode
  /** Sources revised or added since the reviewer last looked; each lists what changed. */
  unseen?: WorkflowUnseenRevision[]
  /** Who prepared a source ("Engineer (Payments)"); without one the brief names the step that did. */
  preparedBy?: (source: WorkflowAttempt) => string | undefined
  /**
   * What approval allows, when the decision below shows it whole beside the outcomes. The card is one
   * column, so the brief points there instead of repeating the same text right above it.
   */
  approvalShownWithDecision?: string
}) {
  const brief = workflowReviewBriefForAttempt(run.state, attempt)
  const sources = [...brief.sources, ...(brief.carriedSources ?? [])]
  const ids = new Set([
    ...workflowIncomingAttempts(run.state, attempt).map((source) => source.id),
    ...sources.map((source) => source.id),
  ])
  const attachments: BriefDocument[] = [
    ...[...ids].flatMap((id) => [
      ...(run.attachments?.[String(id)] ?? []).map((file) => ({
        id: file.id,
        filename: file.filename,
        title: file.filename,
        contentType: file.contentType,
        stored: false,
        detail: file.path,
      })),
      ...(run.assetAttachments?.[String(id)] ?? []).map((asset) => storedBriefDocument(asset, `Attempt ${id}`)),
    ]),
    ...inputs.map((asset) => storedBriefDocument(asset, 'Work stream input')),
  ]
  const primary =
    brief.kind === 'legacy' ? { id: 'handoff', label: 'Handoff' } : { id: 'decision-brief', label: 'Decision brief' }
  const [selected, setSelected] = useState(primary.id)
  const prefix = useId()
  const list = useRef<HTMLDivElement>(null)
  const tabs = [primary, ...attachments.map((a) => ({ id: a.id, label: a.title }))]
  const file = attachments.find((attachment) => attachment.id === selected)
  if (brief.kind === 'legacy' && !attachments.length) return <>{children}</>
  return (
    <>
      <div
        ref={list}
        role="tablist"
        aria-label="Review documents"
        className="g-review-tabs"
        onKeyDown={(event) => {
          const index = tabs.findIndex((tab) => tab.id === selected)
          const next =
            event.key === 'ArrowRight'
              ? (index + 1) % tabs.length
              : event.key === 'ArrowLeft'
                ? (index - 1 + tabs.length) % tabs.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : -1
          if (next < 0) return
          event.preventDefault()
          setSelected(tabs[next]!.id)
          list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${prefix}-${tab.id}`}
            aria-controls={`${prefix}-panel`}
            aria-selected={tab.id === selected}
            tabIndex={tab.id === selected ? 0 : -1}
            className={tab.id === selected ? 'g-button g-button-primary' : 'g-button g-button-quiet'}
            onClick={() => setSelected(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${prefix}-panel`} aria-labelledby={`${prefix}-${file?.id ?? primary.id}`}>
        {file ? (
          <BriefAttachment workStreamId={run.workStreamId} attachment={file} />
        ) : brief.kind === 'legacy' ? (
          children
        ) : (
          <>
            <article aria-label="Decision brief" className="g-materials">
              <h4 className="g-materials-title">Decision brief</h4>
              {brief.kind === 'none' && <p className="g-action-note">No decision brief for this gate</p>}
              {sources.map((source) => (
                <section key={source.id} className="g-material">
                  {(brief.kind === 'carried-forward' || brief.carriedSources?.some((a) => a.id === source.id)) && (
                    <>
                      <p className="g-material-head">Carried forward from an earlier step</p>
                      <p className="g-action-note">
                        Prepared for an earlier step; this is not a new decision brief for this gate.
                      </p>
                    </>
                  )}
                  <PreparedBy run={run} source={source} author={preparedBy?.(source)} />
                  {unseen
                    .filter((entry) => entry.attemptId === source.id)
                    .map((entry) => (
                      <RevisionChanges
                        key={entry.attemptId}
                        run={run}
                        source={source}
                        seenRevision={entry.seenRevision}
                      />
                    ))}
                  {BRIEF_FIELDS.map(([field, label]) =>
                    source.decisionBrief?.value[field] ? (
                      <section key={field}>
                        <h5 className="g-material-head">{label}</h5>
                        {field === 'approvalEffect' &&
                        approvalShownWithDecision &&
                        source.decisionBrief.value[field].trim() === approvalShownWithDecision ? (
                          <p className="g-action-note">Shown in full with the decision below.</p>
                        ) : (
                          <ActionText>{source.decisionBrief.value[field]}</ActionText>
                        )}
                      </section>
                    ) : null
                  )}
                </section>
              ))}
            </article>
            {(brief.kind === 'none' || brief.kind === 'carried-forward') && <ActionText>{instructions}</ActionText>}
            <details>
              <summary className="g-link-button">Internal handoff</summary>
              {children}
            </details>
          </>
        )}
      </div>
    </>
  )
}

/** "Prepared by Engineer (Payments)", then the step, attempt and revision as secondary text (as on web). */
function PreparedBy({ run, source, author }: { run: WorkflowRunDetail; source: WorkflowAttempt; author?: string }) {
  const step = workflowHistoricalStep(run.state, source)?.name ?? source.stepId
  const detail = [
    ...(author ? [step] : []),
    `Attempt ${source.id}`,
    ...(workflowResultRevision(source) > 1 ? [`Revision ${workflowResultRevision(source)}`] : []),
  ].join(' · ')
  return (
    <p className="g-material-head">
      <span>
        Prepared by <span className="g-byline-author">{author ?? step}</span>
        <span className="g-byline-detail"> · {detail}</span>
      </span>
    </p>
  )
}

const BRIEF_FIELDS = [
  ['decision', 'Decision'],
  ['recommendation', 'Recommendation'],
  ['approvalEffect', 'What approval allows'],
  ['risks', 'Risks and tradeoffs'],
  ['changesSinceLastReview', 'What changed since your last review'],
] as const

/**
 * What changed since the revision the reviewer last saw, in plain Farm text. Without `seenRevision`
 * the source appeared after the review opened: all of it is new, and its files are listed as added.
 */
function RevisionChanges({
  run,
  source,
  seenRevision,
}: {
  run: WorkflowRunDetail
  source: WorkflowAttempt
  seenRevision?: number
}) {
  const files = [
    ...(run.attachments?.[String(source.id)] ?? []),
    ...(run.earlierAttachments?.[String(source.id)] ?? []),
  ]
  const { before, changes } = workflowChangesSinceSeen(source, files, seenRevision)
  const label = (field: string) => BRIEF_FIELDS.find(([key]) => key === field)?.[1] ?? field
  const names = (list: WorkflowAttemptAttachment[]) => list.map((file) => file.filename).join(', ')
  const { added, removed, changed } = changes.attachments
  return (
    <section aria-label="What changed since you last looked" className="g-material">
      <p className="g-material-head">What changed since you last looked</p>
      {!before && (
        <p className="g-action-note">
          New since you opened this review. You have not seen this work yet; its brief, handoff and files are new.
        </p>
      )}
      {before &&
        changes.briefFields.map(({ field, before: old, after: now }) => (
          <section key={field}>
            <h5 className="g-material-head">{label(field)}</h5>
            <p className="g-action-note">Before</p>
            <ActionText>{old ?? 'Not included'}</ActionText>
            <p className="g-action-note">Now</p>
            <ActionText>{now ?? 'Not included'}</ActionText>
          </section>
        ))}
      {before && changes.evidenceChanged && <p className="g-action-note">The internal handoff changed.</p>}
      {added.length > 0 && <p className="g-action-note">Added: {names(added)}</p>}
      {removed.length > 0 && <p className="g-action-note">Removed: {names(removed)}</p>}
      {changed.length > 0 && <p className="g-action-note">Changed: {names(changed.map((entry) => entry.after))}</p>}
    </section>
  )
}
/** Images a browser only decodes (never SVG, which can run script). */
const RASTER_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Never execute attached HTML or scripts. Text is escaped; other formats remain downloadable. */
function BriefAttachment({ workStreamId, attachment }: { workStreamId: string; attachment: BriefDocument }) {
  const api = useActionsApi()
  const query = useQuery(
    attachment.stored
      ? {
          // A share can be removed or access revoked: fetch afresh, keep nothing.
          queryKey: ['work-stream-asset', workStreamId, attachment.id],
          queryFn: ({ signal }) => api.downloadWorkStreamAsset(workStreamId, attachment.id, signal),
          staleTime: 0,
          gcTime: 0,
          retry: false,
        }
      : {
          queryKey: ['workflow-review-attachment', workStreamId, attachment.id],
          queryFn: ({ signal }) => api.downloadWorkflowAttachment(workStreamId, attachment.id, signal),
          staleTime: Infinity,
        }
  )
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!query.data) return
    const next = URL.createObjectURL(new Blob([query.data as BlobPart], { type: attachment.contentType }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [query.data, attachment.contentType])
  if (query.isError) return <ErrorNote error={query.error} />
  if (!query.data) return <p className="g-action-note">Loading attachment…</p>
  const text =
    /^(text\/|application\/(json|xml))/.test(attachment.contentType) && query.data.byteLength <= 1024 * 1024
      ? new TextDecoder().decode(query.data)
      : null
  return (
    <section aria-label={attachment.title} className="g-materials">
      <h4 className="g-materials-title">{attachment.title}</h4>
      <p className="g-action-note">{attachment.detail}</p>
      {text !== null && <ActionText>{text}</ActionText>}
      {url && RASTER_IMAGE_TYPES.has(attachment.contentType) && (
        <img className="g-attachment-image" src={url} alt={attachment.title} />
      )}
      {url && (
        <a className="g-link" href={url} download={attachment.filename}>
          Download {attachment.filename}
        </a>
      )}
    </section>
  )
}
