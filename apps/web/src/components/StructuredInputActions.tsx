import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  workStreamWaitActor,
  taskInputLabel,
  type ManualWaitDecision,
  type WorkStreamWait,
  type StructuredManualWait,
} from '@ficus/shared'
import { resolveAgentRecovery } from '../api/agents'
import { resolveStructuredWorkStreamInput } from '../api/squads'
import { actionErrorMessage } from '../lib/actionError'
import { queryKeys } from '../queryKeys'

/** New waits never use the legacy free-text response path. */
export function StructuredInputActions({
  workStreamId,
  wait,
  onComplete,
  disabled = false,
  showSummary = true,
}: {
  workStreamId: string
  wait: WorkStreamWait
  onComplete?: () => void | Promise<void>
  disabled?: boolean
  showSummary?: boolean
}) {
  if (!wait.structured) return null
  return (
    <StructuredDecisionActions
      id={wait.id}
      structured={wait.structured}
      onComplete={onComplete}
      disabled={disabled || workStreamWaitActor(wait) !== 'human'}
      showSummary={showSummary}
      resolve={(decision) => resolveStructuredWorkStreamInput(workStreamId, wait.id, decision)}
    />
  )
}

export function AgentRecoveryActions({
  agentId,
  recovery,
  onComplete,
  disabled,
}: {
  agentId: string
  recovery: { id: string; structured: StructuredManualWait }
  onComplete?: () => void | Promise<void>
  disabled?: boolean
}) {
  return (
    <StructuredDecisionActions
      id={recovery.id}
      structured={recovery.structured}
      onComplete={onComplete}
      disabled={disabled}
      resolve={(decision) => resolveAgentRecovery(agentId, recovery.id, decision)}
    />
  )
}

function StructuredDecisionActions({
  id,
  structured,
  resolve,
  onComplete,
  disabled = false,
  showSummary = true,
}: {
  id: string
  structured: StructuredManualWait
  resolve: (decision: ManualWaitDecision) => Promise<unknown>
  onComplete?: () => void | Promise<void>
  disabled?: boolean
  showSummary?: boolean
}) {
  const [value, setValue] = useState('')
  const client = useQueryClient()
  const mutation = useMutation({
    mutationFn: resolve,
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.actions.pending() }),
        client.invalidateQueries({ queryKey: queryKeys.squads.all }),
      ])
      await onComplete?.()
    },
  })
  const { request, summary, version } = structured
  const locked = disabled || mutation.isPending || structured.stopped
  const buttonClass = 'ficus-button ficus-button-secondary min-h-10 px-3 py-2 text-sm disabled:opacity-50'
  return (
    <div className="space-y-3">
      {showSummary && <p className="text-sm text-secondary whitespace-pre-wrap">{summary.text}</p>}
      {structured.stopped ? (
        <p className="text-sm text-secondary">Recovery stopped. Authorized replanning is required.</p>
      ) : request.kind === 'continue' ? (
        <div className="flex flex-wrap gap-2">
          <button
            className="ficus-button ficus-button-primary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
            disabled={locked}
            onClick={() => mutation.mutate({ action: 'continue', expectedVersion: version })}
          >
            Continue
          </button>
          <button
            className={buttonClass}
            disabled={locked}
            onClick={() => mutation.mutate({ action: 'stop', expectedVersion: version })}
          >
            Stop
          </button>
        </div>
      ) : request.kind === 'decide' ? (
        <div className="flex flex-wrap gap-2">
          {request.options.map((option) => (
            <button
              key={option.id}
              className={buttonClass}
              disabled={locked}
              title={option.consequence}
              onClick={() => mutation.mutate({ action: 'choose', expectedVersion: version, optionId: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!locked && value.trim()) mutation.mutate({ action: 'provide', expectedVersion: version, value })
          }}
        >
          <label className="block text-sm text-secondary break-words" htmlFor={`input-${id}`}>
            {taskInputLabel(request.input)}
          </label>
          {request.input.type === 'config-value' && (
            <p className="text-xs text-muted break-words">
              Declared in <code>{request.input.declaredIn}</code>
            </p>
          )}
          <textarea
            placeholder={
              request.input.type === 'file' ? 'Workspace-relative file path' : 'Configuration value (not credentials)'
            }
            id={`input-${id}`}
            className="ficus-input w-full"
            rows={3}
            maxLength={2000}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={locked}
          />
          <button type="submit" className={buttonClass} disabled={locked || !value.trim()}>
            Provide
          </button>
        </form>
      )}
      {mutation.isError && (
        <p role="alert" className="text-xs text-status-danger-600">
          {actionErrorMessage(mutation.error)}
        </p>
      )}
    </div>
  )
}
