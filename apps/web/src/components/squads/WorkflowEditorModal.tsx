import { useState } from 'react'
import {
  createBlankWorkflow,
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowSource,
} from '@ficus/shared'
import { Modal } from '../Modal'
import { WorkflowEditor } from './WorkflowEditor'

/**
 * The workflow editor as a dialog, for forms that embed a picker rather than
 * the editor itself (schedules that create work streams). It owns a draft
 * copy: nothing reaches the caller until "Use this flow", and the result is
 * always a detached inline definition, never a reference to a preset.
 *
 * Remount it (change its `key`) to start a fresh draft; it does not follow
 * `initialDefinition` after the first render, so an operator's in-progress
 * edits are never replaced from outside.
 */
export function WorkflowEditorModal({
  isOpen,
  onClose,
  onSave,
  squadId,
  initialDefinition,
}: {
  isOpen: boolean
  onClose: () => void
  onSave: (definition: WorkflowDefinition) => void
  squadId?: string
  initialDefinition?: WorkflowDefinition
}) {
  const [draft, setDraft] = useState<WorkflowSource>(() => ({
    kind: 'inline',
    definition: initialDefinition ? structuredClone(initialDefinition) : createBlankWorkflow(),
  }))
  const [error, setError] = useState<string | null>(null)

  const save = () => {
    if (draft.kind !== 'inline') return
    const parsed = workflowDefinitionSchema.safeParse(draft.definition)
    if (!parsed.success) {
      setError(
        parsed.error.issues.map((issue) => `${issue.path.join('.') || 'definition'}: ${issue.message}`).join('; ')
      )
      return
    }
    setError(null)
    onSave(parsed.data)
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Custom workflow" maxWidth="wide">
      {/* This dialog stacks over the form that opened it; Escape must close only this one. */}
      <div
        className="space-y-4"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }}
      >
        <WorkflowEditor squadId={squadId} value={draft} onChange={(next) => next && setDraft(next)} />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="ficus-button ficus-button-secondary rounded-lg px-4 py-2 text-sm font-medium"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md"
            onClick={save}
          >
            Use this flow
          </button>
        </div>
      </div>
    </Modal>
  )
}
