import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ActionItem } from './ActionItem'
import { actionErrorMessage } from '../lib/actionError'
import { ActionCenterContext } from './ActionCenterContext'
import { continueHaltedAgents } from '../api/agents'
import { queryKeys } from '../queryKeys'
import type { PendingAction } from '@ficus/shared'
import { useLoadingShapeCount } from '../hooks/useLoadingShapeCount'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from './loading/Skeleton'

interface ActionCenterContentProps {
  actions: PendingAction[]
  isLoading: boolean
  isError?: boolean
  error?: unknown
  onRetry?: () => void
  onClose?: () => void
  focusActionId?: string
  /** Injectable transport seam for isolated component tests. */
  continueHaltedActions?: typeof continueHaltedAgents
}

export function ActionCenterContent({
  actions,
  isLoading,
  isError = false,
  error,
  onRetry,
  onClose,
  focusActionId,
  continueHaltedActions = continueHaltedAgents,
}: ActionCenterContentProps) {
  const loadingRowCount = useLoadingShapeCount('action-center:list', isLoading ? undefined : actions.length, {
    fallbackCount: 3,
    maxCount: 8,
  })
  const agentErrors = actions.filter((a) => a.type === 'agent-error')
  const questions = actions.filter(
    (action) =>
      action.type === 'agent-question' || action.type === 'squad-question' || action.type === 'assistant-needs-input'
  )
  const workstreamReviews = actions.filter((a) => a.type === 'workstream-review' || a.type === 'workstream-delivery')
  const workstreamBlocked = actions.filter((a) => a.type === 'workstream-blocked')

  const errorMessage = error instanceof Error ? error.message : 'Action Center is unavailable.'
  const permissionError = /(?:^|\b)403(?:\b|:)|forbidden/i.test(errorMessage)
  const content = isLoading ? (
    <LoadingSurface label="Loading actions" className="space-y-2">
      <SkeletonRows count={Math.max(1, loadingRowCount)}>
        {(index) => (
          <div key={index} className="space-y-3 rounded-xl bg-surface p-4">
            <div className="flex items-center gap-2">
              <SkeletonBlock className="h-4 w-4 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <SkeletonLine className={index % 2 ? 'w-2/5' : 'w-3/5'} />
                <SkeletonLine className="w-1/3" />
              </div>
            </div>
            <SkeletonLine className="w-5/6" />
          </div>
        )}
      </SkeletonRows>
    </LoadingSurface>
  ) : isError ? (
    <div className="text-center py-8 space-y-3">
      <p className="text-muted">
        {permissionError ? 'You do not have permission to view these actions.' : errorMessage}
      </p>
      {onRetry && (
        <button
          className="ficus-button ficus-button-primary px-3 py-1.5 rounded bg-accent text-on-accent"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  ) : actions.length === 0 ? (
    <div className="text-center py-12">
      <p className="text-placeholder text-4xl mb-2">&#10003;</p>
      <p className="text-muted font-medium">All caught up!</p>
      <p className="text-placeholder text-sm">No pending actions</p>
    </div>
  ) : (
    <div className="space-y-4">
      {agentErrors.length > 0 && (
        <AgentErrorSection
          actions={agentErrors}
          continueHaltedActions={continueHaltedActions}
          focusActionId={focusActionId}
          showHeading={actions.length > 1}
        />
      )}
      {questions.length > 0 && (
        <ActionSection
          title="Questions"
          count={questions.length}
          actions={questions}
          continueHaltedActions={continueHaltedActions}
          focusActionId={focusActionId}
          showHeading={actions.length > 1}
        />
      )}
      {workstreamReviews.length > 0 && (
        <ActionSection
          title="Work stream reviews"
          count={workstreamReviews.length}
          actions={workstreamReviews}
          continueHaltedActions={continueHaltedActions}
          focusActionId={focusActionId}
          showHeading={actions.length > 1}
        />
      )}
      {workstreamBlocked.length > 0 && (
        <ActionSection
          title="Work stream input"
          count={workstreamBlocked.length}
          actions={workstreamBlocked}
          continueHaltedActions={continueHaltedActions}
          focusActionId={focusActionId}
          showHeading={actions.length > 1}
        />
      )}
    </div>
  )

  if (onClose) {
    return <ActionCenterContext.Provider value={{ closeActionCenter: onClose }}>{content}</ActionCenterContext.Provider>
  }

  return content
}

// Halted agents get a bulk "Continue all" — when a provider recovers, resume everything at once.
function AgentErrorSection({
  actions,
  continueHaltedActions,
  focusActionId,
  showHeading,
}: {
  actions: PendingAction[]
  continueHaltedActions: typeof continueHaltedAgents
  focusActionId?: string
  showHeading: boolean
}) {
  const queryClient = useQueryClient()
  const respondableErrors = actions.filter((action) => action.canRespond)
  const mutation = useMutation({
    mutationFn: () => continueHaltedActions(respondableErrors.map((action) => action.id)),
    onSuccess: async (result) => {
      const removedIds = new Set([...result.resumedActionIds, ...result.staleActionIds])
      queryClient.setQueryData<PendingAction[]>(queryKeys.actions.pending(), (current) =>
        current?.filter((action) => !removedIds.has(action.id))
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.listPrefix() }),
      ])
    },
  })

  return (
    <section>
      {showHeading && (
        <div className="flex items-center justify-between mb-2 gap-2 px-1">
          <h3 className="flex items-center gap-2 text-xs font-medium text-muted">
            Halted agents
            <span className="text-xs font-normal tabular-nums text-muted">{actions.length}</span>
          </h3>
          {respondableErrors.length > 1 && (
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="ficus-button min-h-9 px-3 py-1.5 text-xs text-secondary hover:bg-surface-hover disabled:opacity-50 shrink-0"
            >
              {mutation.isPending ? 'Continuing...' : `Continue all (${respondableErrors.length})`}
            </button>
          )}
        </div>
      )}
      {mutation.isError && (
        <p role="alert" className="mb-2 text-xs text-status-danger-600">
          {actionErrorMessage(mutation.error)}
        </p>
      )}
      <div className="space-y-2">
        {actions.map((action) => (
          <ActionItem
            key={action.id}
            action={action}
            continueHaltedActions={continueHaltedActions}
            focused={focusActionId === action.id}
            defaultExpanded={!showHeading && action.type !== 'agent-question' && action.type !== 'squad-question'}
          />
        ))}
      </div>
    </section>
  )
}

function ActionSection({
  title,
  count,
  actions,
  continueHaltedActions,
  focusActionId,
  showHeading,
}: {
  title: string
  count: number
  actions: PendingAction[]
  continueHaltedActions: typeof continueHaltedAgents
  focusActionId?: string
  showHeading: boolean
}) {
  return (
    <section>
      {showHeading && (
        <h3 className="mb-2 flex items-center gap-2 px-1 text-xs font-medium text-muted">
          {title}
          <span className="text-xs font-normal tabular-nums text-muted">{count}</span>
        </h3>
      )}
      <div className="space-y-2">
        {actions.map((action) => (
          <ActionItem
            key={action.id}
            action={action}
            continueHaltedActions={continueHaltedActions}
            focused={focusActionId === action.id}
            defaultExpanded={!showHeading && action.type !== 'agent-question' && action.type !== 'squad-question'}
          />
        ))}
      </div>
    </section>
  )
}
