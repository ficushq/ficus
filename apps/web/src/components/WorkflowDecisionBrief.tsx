import { workflowReviewBriefForAttempt, type WorkflowAttempt, type WorkflowRun } from '@ficus/shared'
import { MarkdownContent } from './MarkdownContent'

/** Read-only source provenance: a carried brief is never fresh authorization for this gate. */
export function WorkflowDecisionBrief({ run, attempt }: { run: WorkflowRun; attempt: WorkflowAttempt }) {
  const brief = workflowReviewBriefForAttempt(run, attempt)
  if (brief.kind === 'legacy') return null
  return (
    <article aria-label="Decision brief" className="space-y-5 [overflow-wrap:anywhere]">
      <h2 className="text-lg font-semibold text-primary">Decision brief</h2>
      {brief.kind === 'none' && <p className="text-sm text-secondary">No decision brief for this gate</p>}
      {brief.kind === 'carried-forward' && (
        <div className="space-y-1 text-sm text-secondary">
          <p className="font-medium">Carried forward from an earlier step</p>
          <p>Prepared for an earlier step; this is not a new decision brief for this gate.</p>
        </div>
      )}
      {brief.sources.map((source) => (
        <section key={source.id} className="space-y-4">
          <p className="text-xs text-muted">
            Prepared by {source.step?.name ?? source.stepId} · Attempt {source.id}
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
