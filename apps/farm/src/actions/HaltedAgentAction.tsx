import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentErrorActionData, PendingAction } from '@ficus/shared'
import { useStableRef } from '../hooks/useStableRef'
import { useActionsApi } from './ActionsApiProvider'
import { settleAgentAction, settleContinueAll } from './cache'
import { ActionText, ErrorNote, VerbButton } from './ui'

/** Halted-robot actions (type `agent-error`) the caller may resume. */
export function respondableHaltedActions(actions: PendingAction[]): PendingAction[] {
  return actions.filter((action) => action.type === 'agent-error' && action.canRespond)
}

/**
 * "Wake up" one robot halted by a provider or rate-limit error:
 * `agents.continueHaltedActions([action.id])`.
 */
export function HaltedAgentAction({
  action,
  onOpenAgent,
  onResolved,
}: {
  action: PendingAction
  onOpenAgent?: (agentId: string) => void
  onResolved?: () => void
}) {
  const api = useActionsApi()
  const queryClient = useQueryClient()
  const onResolvedRef = useStableRef(onResolved)
  const data = action.data as AgentErrorActionData
  const wake = useMutation({
    mutationFn: () => api.continueHaltedActions([action.id]),
    onSuccess: async () => {
      await settleAgentAction(queryClient, {
        actionId: action.id,
        agentId: data.agentId,
        squadId: data.squadId,
        question: false,
      })
      onResolvedRef.current?.()
    },
  })
  return (
    <div className="g-action">
      {data.reason && <ActionText>{data.reason}</ActionText>}
      <ErrorNote error={wake.error} />
      <div className="g-action-row">
        <VerbButton
          verb="Wake up"
          busyVerb="Waking…"
          help="Continue the halted agent"
          tone="primary"
          busy={wake.isPending}
          onClick={() => wake.mutate()}
        />
        {onOpenAgent && (
          <VerbButton
            verb="Visit robot"
            help="Open its conversation"
            tone="quiet"
            onClick={() => onOpenAgent(data.agentId)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Bulk "Continue all" for halted robots (shown when two or more can be resumed):
 * `agents.continueHaltedActions(ids)` with exactly the listed, respondable ids.
 */
export function ContinueAllButton({ actions }: { actions: PendingAction[] }) {
  const api = useActionsApi()
  const queryClient = useQueryClient()
  const respondable = respondableHaltedActions(actions)
  const wakeAll = useMutation({
    mutationFn: (ids: string[]) => api.continueHaltedActions(ids),
    onSuccess: (result) => settleContinueAll(queryClient, result),
  })
  if (respondable.length < 2) return null
  return (
    <div className="g-continue-all">
      <VerbButton
        verb={`Wake them all (${respondable.length})`}
        busyVerb="Waking them all…"
        help="Continue every halted agent"
        tone="primary"
        busy={wakeAll.isPending}
        onClick={() => wakeAll.mutate(respondable.map((action) => action.id))}
      />
      <ErrorNote error={wakeAll.error} />
    </div>
  )
}
