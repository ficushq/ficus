import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { describeWorkflowAttemptLimitPause, type WorkflowAttemptLimitPause } from '@ficus/shared'
import { client } from '../api/clientInstance'
import { actionErrorMessage } from '../lib/actionError'
import { queryKeys } from '../queryKeys'

/** The most attempts a step may allow (the workflow limits schema maximum). */
const MAX_STEP_ATTEMPTS = 100

/** A generous next limit: a few more attempts than the step has used, within the schema maximum. */
function suggestedAttemptLimit(pause: Pick<WorkflowAttemptLimitPause, 'attemptsUsed'>): number {
  return Math.min(MAX_STEP_ATTEMPTS, pause.attemptsUsed + 3)
}

/**
 * Unblocks a workflow paused at its attempt limit in one step: raise the limit to a chosen number,
 * or remove it. The server checks who may do this (reviewers, the owner, or the squad manager) and
 * records who did it in the workflow's revision history.
 */
export function AttemptLimitActions({
  workStreamId,
  pause,
  flowVersion,
  disabled = false,
  showSummary = true,
  onComplete,
}: {
  workStreamId: string
  pause: WorkflowAttemptLimitPause
  flowVersion: number
  disabled?: boolean
  showSummary?: boolean
  onComplete?: () => void | Promise<void>
}) {
  const inputId = useId()
  const [limit, setLimit] = useState(String(suggestedAttemptLimit(pause)))
  const queryClient = useQueryClient()
  const raise = useMutation({
    mutationFn: (maxStepAttempts: number | null) =>
      client.workflows.advance(
        workStreamId,
        { action: 'raise-limit', expectedVersion: flowVersion, maxStepAttempts },
        crypto.randomUUID()
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.workflows.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.squads.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() }),
      ])
      await onComplete?.()
    },
  })
  const parsed = Number(limit)
  const valid = Number.isInteger(parsed) && parsed > pause.attemptsUsed && parsed <= MAX_STEP_ATTEMPTS
  const locked = disabled || raise.isPending
  return (
    <div className="space-y-3">
      {showSummary && (
        <p className="text-sm leading-relaxed text-secondary">{describeWorkflowAttemptLimitPause(pause)}</p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={inputId} className="text-xs text-secondary">
          <span className="block mb-1">New attempt limit</span>
          <input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={pause.attemptsUsed + 1}
            max={MAX_STEP_ATTEMPTS}
            value={limit}
            disabled={locked}
            onChange={(event) => setLimit(event.target.value)}
            className="ficus-field w-24 min-h-10 px-2 py-1.5 text-sm border border-th-border rounded-md"
          />
        </label>
        <button
          type="button"
          className="ficus-button ficus-button-primary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
          disabled={locked || !valid}
          onClick={() => raise.mutate(parsed)}
        >
          {raise.isPending ? 'Updating…' : 'Raise limit'}
        </button>
        <button
          type="button"
          className="ficus-button ficus-button-secondary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
          disabled={locked}
          onClick={() => raise.mutate(null)}
        >
          Remove limit
        </button>
      </div>
      {!valid && !locked && (
        <p className="text-xs text-muted">
          {pause.attemptsUsed >= MAX_STEP_ATTEMPTS
            ? 'This step has used the most attempts a limit allows; remove the limit to continue.'
            : `Choose a whole number from ${pause.attemptsUsed + 1} to ${MAX_STEP_ATTEMPTS}, or remove the limit.`}
        </p>
      )}
      {disabled && (
        <p className="text-xs text-muted">
          A reviewer of this work stream, its owner agent, or the squad manager can raise the limit.
        </p>
      )}
      {raise.isError && (
        <p role="alert" className="text-xs text-status-danger-600">
          {actionErrorMessage(raise.error)}
        </p>
      )}
    </div>
  )
}
