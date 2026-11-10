import { pendingActionsPresentation, usePendingActions } from '../hooks/usePendingActions'
import { ActionCenterContent } from './ActionCenterContent'
import { useParams } from 'react-router'

export function ActionsPage() {
  const { actionId } = useParams<{ actionId: string }>()
  const pendingQuery = usePendingActions()
  const { actions, status } = pendingActionsPresentation(pendingQuery)
  const { error, refetch } = pendingQuery

  return (
    <div className="flex-1">
      <h1 className="text-lg font-semibold text-primary mb-4">Action Center</h1>
      <ActionCenterContent
        actions={actions}
        isLoading={status === 'loading'}
        isError={status === 'error'}
        error={error}
        onRetry={() => void refetch()}
        focusActionId={actionId}
      />
    </div>
  )
}
