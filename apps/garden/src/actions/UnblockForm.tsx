import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { WorkStreamPrompt, WorkStreamWait } from '@ficus/shared'
import { useStableRef } from '../hooks/useStableRef'
import { useActionsApi } from './ActionsApiProvider'
import { settleStreamWait } from './cache'
import { usePermissions } from './permissions'
import { WorkflowDecision } from './WorkflowDecision'
import { ActionText, ErrorNote, VerbButton } from './ui'

export interface UnblockFormProps {
  workStreamId: string
  squadId: string
  /** The open manual (blocked) wait. */
  wait: WorkStreamWait
  /** The action's prompt: a `select` prompt offers its options as one-tap answers. */
  prompt?: WorkStreamPrompt
  /** Shown above the form; defaults to the wait's message, then the prompt's. */
  message?: string | null
  /** Authoritative capability (PendingAction.canRespond); otherwise checked from squad permissions. */
  canRespond?: boolean
  onOpenAgent?: (agentId: string) => void
  onResolved?: () => void
}

/**
 * "Clear the weeds": answer a blocked (manual) wait with a note,
 * `squads.resolveWorkStreamWait(ws, wait, { resolution: 'cleared', note })`.
 * A workflow-owned wait skips the generic unblock (as the web does) and is
 * decided through the flow instead.
 */
export function UnblockForm(props: UnblockFormProps) {
  if (props.wait.resolutionHandler === 'workflow') {
    return (
      <div className="g-action">
        {(props.message ?? props.wait.message) && <ActionText>{props.message ?? props.wait.message}</ActionText>}
        <WorkflowDecision
          workStreamId={props.workStreamId}
          focusWaitId={props.wait.id}
          explainWhenIdle
          onOpenAgent={props.onOpenAgent}
          onDecided={props.onResolved}
        />
      </div>
    )
  }
  return <ManualUnblock {...props} />
}

function ManualUnblock({
  workStreamId,
  squadId,
  wait,
  prompt,
  message,
  canRespond: actionCanRespond,
  onResolved,
}: UnblockFormProps) {
  const api = useActionsApi()
  const queryClient = useQueryClient()
  const onResolvedRef = useStableRef(onResolved)
  const { can, isLoading } = usePermissions(squadId)
  const canRespond = actionCanRespond ?? (!isLoading && (can('workstreams:respond') || can('workstreams:update')))
  const [note, setNote] = useState('')
  const noteId = useId()
  const clear = useMutation({
    mutationFn: (value: string) =>
      api.resolveWorkStreamWait(workStreamId, wait.id, { resolution: 'cleared', note: value }),
    onSuccess: async () => {
      setNote('')
      await settleStreamWait(queryClient, { workStreamId, squadId, waitId: wait.id, kind: 'blocked' })
      onResolvedRef.current?.()
    },
  })
  const text = message ?? wait.message ?? prompt?.message
  const options = prompt?.type === 'select' ? (prompt.options ?? []) : []

  return (
    <div className="g-action">
      {text && <ActionText>{text}</ActionText>}
      {!canRespond ? (
        <p className="g-action-note">You can see this but don't have permission to unblock it.</p>
      ) : options.length > 0 ? (
        <div className="g-action-row" role="group" aria-label="Pick an answer">
          {options.map((option) => (
            <VerbButton
              key={option}
              verb={option}
              busyVerb={`${option}…`}
              help="Unblock with this answer"
              busy={clear.isPending && clear.variables === option}
              disabled={clear.isPending}
              onClick={() => clear.mutate(option)}
            />
          ))}
        </div>
      ) : (
        <form
          className="g-action"
          onSubmit={(event) => {
            event.preventDefault()
            if (note.trim()) clear.mutate(note)
          }}
        >
          <label className="g-field" htmlFor={`${noteId}-note`}>
            Your note to the robot
          </label>
          <textarea
            id={`${noteId}-note`}
            className="g-textarea"
            rows={3}
            placeholder="What it needs to get going again…"
            value={note}
            disabled={clear.isPending}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="g-action-row">
            <VerbButton
              type="submit"
              verb="Clear the weeds"
              busyVerb="Clearing…"
              help="Unblock with this note"
              tone="primary"
              busy={clear.isPending}
              disabled={!note.trim()}
            />
          </div>
        </form>
      )}
      <ErrorNote error={clear.error} />
    </div>
  )
}
