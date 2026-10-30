import type { ReactNode } from 'react'
import {
  workflowHistoricalStep,
  workflowResultRevision,
  workflowReviewBriefForAttempt,
  type WorkflowAttempt,
  type WorkflowDecisionBrief as Brief,
  type WorkflowRun,
} from '@ficus/shared'
import { MarkdownContent } from './MarkdownContent'

/** The brief's fields in reading order, with their reviewer-facing labels. */
export const DECISION_BRIEF_FIELD_LABELS: ReadonlyArray<readonly [keyof Brief, string]> = [
  ['decision', 'Decision'],
  ['recommendation', 'Recommendation'],
  ['approvalEffect', 'What approval allows'],
  ['risks', 'Risks and tradeoffs'],
  ['changesSinceLastReview', 'What changed since your last review'],
]

/**
 * Read-only source provenance: a carried brief is never fresh authorization for this gate. An
 * amended source shows its revision; `beforeSource` adds content (such as what changed) above it.
 */
export function WorkflowDecisionBrief({
  run,
  attempt,
  beforeSource,
}: {
  run: WorkflowRun
  attempt: WorkflowAttempt
  beforeSource?: (source: WorkflowAttempt) => ReactNode
}) {
  const brief = workflowReviewBriefForAttempt(run, attempt)
  if (brief.kind === 'legacy') return null
  return (
    <article aria-label="Decision brief" className="space-y-5 [overflow-wrap:anywhere]">
      <h2 className="text-lg font-semibold text-primary">Decision brief</h2>
      {brief.kind === 'none' && <p className="text-sm text-secondary">No decision brief for this gate</p>}
      {[...brief.sources, ...(brief.carriedSources ?? [])].map((source) => (
        <section key={source.id} className="space-y-4">
          {(brief.kind === 'carried-forward' || brief.carriedSources?.some((a) => a.id === source.id)) && (
            <div className="space-y-1 text-sm text-secondary">
              <p className="font-medium">Carried forward from an earlier step</p>
              <p>Prepared for an earlier step; this is not a new decision brief for this gate.</p>
            </div>
          )}
          <p className="text-xs text-muted">
            Prepared by {workflowHistoricalStep(run, source)?.name ?? source.stepId} · Attempt {source.id}
            {workflowResultRevision(source) > 1 && ` · Revision ${workflowResultRevision(source)}`}
          </p>
          {beforeSource?.(source)}
          {DECISION_BRIEF_FIELD_LABELS.map(([field, label]) =>
            source.decisionBrief?.value[field] ? (
              <section key={field}>
                <h3 className="mb-1 text-sm font-medium text-secondary">{label}</h3>
                <MarkdownContent variant="document" className="text-base leading-relaxed text-primary">
                  {source.decisionBrief.value[field]!}
                </MarkdownContent>
              </section>
            ) : null
          )}
        </section>
      ))}
    </article>
  )
}
