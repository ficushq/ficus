import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { WorkflowRunDetail } from '@ficus/client-core'
import {
  workflowAttemptResults,
  workflowResultChanges,
  workflowResultRevision,
  workflowReviewBriefForAttempt,
  workflowHistoricalStep,
  workflowIncomingAttempts,
  type WorkflowAttempt,
  type WorkflowAttemptAttachment,
  type WorkStreamAssetAttachment,
} from '@ficus/shared'
import { useActionsApi } from './ActionsApiProvider'
import { ActionText, ErrorNote } from './ui'

/** Brief first, files as peer documents, and only the internal handoff behind a disclosure. */
/**
 * A document the review can open: a handoff file uploaded with --attach, or a stored chat image or
 * file shared by ID (which can be removed, so it is never cached).
 */
interface BriefDocument {
  id: string
  filename: string
  contentType: string
  stored: boolean
  /** Where it came from, shown under the name; a stored reference has no path and is not given one. */
  detail: string
}

function storedBriefDocument(asset: WorkStreamAssetAttachment, scope: string): BriefDocument {
  return {
    id: asset.id,
    filename: asset.filename,
    contentType: asset.contentType,
    stored: true,
    detail: `${scope}: stored chat ${asset.source.kind === 'image' ? 'image' : 'file'}, shared by ID`,
  }
}

export function WorkflowBriefDocuments({
  run,
  attempt,
  instructions,
  inputs = [],
  children,
  seen,
}: {
  run: WorkflowRunDetail
  attempt: WorkflowAttempt
  instructions: string
  /** The work stream's stored inputs (absent from older servers). */
  inputs?: WorkStreamAssetAttachment[]
  children: ReactNode
  /** The revision of each source the reviewer last saw; newer revisions list what changed. */
  seen?: Record<number, number>
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
  const tabs = [primary, ...attachments.map((a) => ({ id: a.id, label: a.filename }))]
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
                  <p className="g-material-head">
                    Prepared by {workflowHistoricalStep(run.state, source)?.name ?? source.stepId} · Attempt {source.id}
                    {workflowResultRevision(source) > 1 && ` · Revision ${workflowResultRevision(source)}`}
                  </p>
                  {seen && (seen[source.id] ?? workflowResultRevision(source)) < workflowResultRevision(source) && (
                    <RevisionChanges run={run} source={source} seenRevision={seen[source.id]!} />
                  )}
                  {BRIEF_FIELDS.map(([field, label]) =>
                    source.decisionBrief?.value[field] ? (
                      <section key={field}>
                        <h5 className="g-material-head">{label}</h5>
                        <ActionText>{source.decisionBrief.value[field]}</ActionText>
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

const BRIEF_FIELDS = [
  ['decision', 'Decision'],
  ['recommendation', 'Recommendation'],
  ['approvalEffect', 'What approval allows'],
  ['risks', 'Risks and tradeoffs'],
  ['changesSinceLastReview', 'What changed since your last review'],
] as const

/** What changed since the revision the reviewer last saw, in plain Farm text. */
function RevisionChanges({
  run,
  source,
  seenRevision,
}: {
  run: WorkflowRunDetail
  source: WorkflowAttempt
  seenRevision: number
}) {
  const files = [
    ...(run.attachments?.[String(source.id)] ?? []),
    ...(run.earlierAttachments?.[String(source.id)] ?? []),
  ]
  const results = workflowAttemptResults(source, files)
  const before = results.find((result) => result.revision === seenRevision) ?? results[0]!
  const changes = workflowResultChanges(
    before,
    results.at(-1)!,
    Object.fromEntries(files.map((file) => [file.id, file]))
  )
  const label = (field: string) => BRIEF_FIELDS.find(([key]) => key === field)?.[1] ?? field
  const names = (list: WorkflowAttemptAttachment[]) => list.map((file) => file.filename).join(', ')
  const { added, removed, changed } = changes.attachments
  return (
    <section aria-label="What changed since you last looked" className="g-material">
      <p className="g-material-head">What changed since you last looked</p>
      {changes.briefFields.map(({ field, before: old, after: now }) => (
        <section key={field}>
          <h5 className="g-material-head">{label(field)}</h5>
          <p className="g-action-note">Before</p>
          <ActionText>{old ?? 'Not included'}</ActionText>
          <p className="g-action-note">Now</p>
          <ActionText>{now ?? 'Not included'}</ActionText>
        </section>
      ))}
      {changes.evidenceChanged && <p className="g-action-note">The internal handoff changed.</p>}
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
    <section aria-label={attachment.filename} className="g-materials">
      <h4 className="g-materials-title">{attachment.filename}</h4>
      <p className="g-action-note">{attachment.detail}</p>
      {text !== null && <ActionText>{text}</ActionText>}
      {url && RASTER_IMAGE_TYPES.has(attachment.contentType) && (
        <img className="g-attachment-image" src={url} alt={attachment.filename} />
      )}
      {url && (
        <a className="g-link" href={url} download={attachment.filename}>
          Download {attachment.filename}
        </a>
      )}
    </section>
  )
}
