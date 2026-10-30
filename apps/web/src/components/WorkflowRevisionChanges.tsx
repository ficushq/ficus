import {
  workflowAttemptResults,
  workflowResultChanges,
  workflowResultRevision,
  type WorkflowAttempt,
  type WorkflowAttemptAttachment,
} from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { attemptFiles, DECISION_BRIEF_FIELD_LABELS } from '../lib/workflowReview'
import { MarkdownContent } from './MarkdownContent'

/**
 * What changed in a source attempt between the revision the reviewer last saw and the latest one:
 * each changed brief field as Before and Now, the unchanged fields, whether the internal handoff
 * changed, and the files added, removed or changed. Changed and added files open in their tab.
 */
export function WorkflowRevisionChanges({
  run,
  source,
  seenRevision,
  onOpenFile,
}: {
  run: WorkflowRunDetail
  source: WorkflowAttempt
  seenRevision: number
  onOpenFile?: (attachmentId: string) => void
}) {
  const files = attemptFiles(run, source.id)
  const results = workflowAttemptResults(source, files)
  const before = results.find((result) => result.revision === seenRevision) ?? results[0]!
  const after = results.at(-1)!
  const changes = workflowResultChanges(before, after, Object.fromEntries(files.map((file) => [file.id, file])))
  const label = (field: string) => DECISION_BRIEF_FIELD_LABELS.find(([key]) => key === field)?.[1] ?? field
  const { added, removed, changed } = changes.attachments
  const nothing =
    !changes.briefFields.length && !changes.evidenceChanged && !added.length && !removed.length && !changed.length
  const fileName = (file: WorkflowAttemptAttachment, open: boolean) =>
    open && onOpenFile ? (
      <button
        type="button"
        onClick={() => onOpenFile(file.id)}
        className="ficus-button ficus-button-link text-left text-sm"
        title={file.path}
      >
        {file.filename}
      </button>
    ) : (
      <span title={file.path}>{file.filename}</span>
    )
  const fileList = (title: string, list: WorkflowAttemptAttachment[], open: boolean) =>
    list.length ? (
      <div>
        <h4 className="text-xs font-medium text-muted">{title}</h4>
        <ul className="mt-1 space-y-0.5 text-sm text-secondary">
          {list.map((file) => (
            <li key={file.id}>{fileName(file, open)}</li>
          ))}
        </ul>
      </div>
    ) : null
  return (
    <section
      aria-label="What changed since you last looked"
      data-revision-changes
      className="space-y-4 rounded-xl border border-th-border bg-surface-secondary px-4 py-3.5 sm:px-5"
    >
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium text-primary">What changed since you last looked</h3>
        <p className="text-xs text-muted">
          Revision {before.revision} to revision {workflowResultRevision(source)}
        </p>
      </div>
      {nothing && <p className="text-sm text-secondary">Nothing in the brief, handoff or files changed.</p>}
      {changes.briefFields.map(({ field, before: old, after: now }) => (
        <div key={field} className="space-y-2">
          <h4 className="text-sm font-medium text-secondary">{label(field)}</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ['Before', old],
                ['Now', now],
              ] as const
            ).map(([heading, text]) => (
              <div key={heading} className="min-w-0 [overflow-wrap:anywhere]">
                <p className="mb-0.5 text-xs font-medium text-muted">{heading}</p>
                {text ? (
                  <MarkdownContent variant="document" className="text-sm leading-relaxed text-primary">
                    {text}
                  </MarkdownContent>
                ) : (
                  <p className="text-sm text-muted">Not included</p>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {changes.briefFields.length > 0 && changes.unchangedBriefFields.length > 0 && (
        <p className="text-xs text-muted">
          Unchanged: {changes.unchangedBriefFields.map((field) => label(field)).join(', ')}.
        </p>
      )}
      {changes.evidenceChanged && <p className="text-sm text-secondary">The internal handoff changed.</p>}
      {(added.length > 0 || removed.length > 0 || changed.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-3">
          {fileList('Added', added, true)}
          {fileList('Removed', removed, false)}
          {fileList(
            'Changed',
            changed.map((entry) => entry.after),
            true
          )}
        </div>
      )}
    </section>
  )
}
