import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { WorkflowRunDetail } from '@ficus/client-core'
import {
  workflowReviewBriefForAttempt,
  workflowHistoricalStep,
  workflowIncomingAttempts,
  type WorkflowAttempt,
  type WorkflowAttemptAttachment,
} from '@ficus/shared'
import { useActionsApi } from './ActionsApiProvider'
import { ActionText, ErrorNote } from './ui'

/** Brief first, files as peer documents, and only the internal handoff behind a disclosure. */
export function WorkflowBriefDocuments({
  run,
  attempt,
  instructions,
  children,
}: {
  run: WorkflowRunDetail
  attempt: WorkflowAttempt
  instructions: string
  children: ReactNode
}) {
  const brief = workflowReviewBriefForAttempt(run.state, attempt)
  const sources = [...brief.sources, ...(brief.carriedSources ?? [])]
  const ids = new Set([
    ...workflowIncomingAttempts(run.state, attempt).map((source) => source.id),
    ...sources.map((source) => source.id),
  ])
  const attachments = [...ids].flatMap((id) => run.attachments?.[String(id)] ?? [])
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
                  </p>
                  {(
                    [
                      ['decision', 'Decision'],
                      ['recommendation', 'Recommendation'],
                      ['approvalEffect', 'What approval allows'],
                      ['risks', 'Risks and tradeoffs'],
                      ['changesSinceLastReview', 'What changed since your last review'],
                    ] as const
                  ).map(([field, label]) =>
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

/** Never execute attached HTML or scripts. Text is escaped; other formats remain downloadable. */
function BriefAttachment({
  workStreamId,
  attachment,
}: {
  workStreamId: string
  attachment: WorkflowAttemptAttachment
}) {
  const api = useActionsApi()
  const query = useQuery({
    queryKey: ['workflow-review-attachment', workStreamId, attachment.id],
    queryFn: ({ signal }) => api.downloadWorkflowAttachment(workStreamId, attachment.id, signal),
    staleTime: Infinity,
  })
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
      {text !== null && <ActionText>{text}</ActionText>}
      {url && (
        <a className="g-link" href={url} download={attachment.filename}>
          Download {attachment.filename}
        </a>
      )}
    </section>
  )
}
