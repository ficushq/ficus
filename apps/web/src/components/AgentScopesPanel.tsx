import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { grantAgentScope, revokeAgentScope } from '../api/agents'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { useLoadingShapeCount } from '../hooks/useLoadingShapeCount'
import { Can } from './Can'
import { LoadingSurface, SkeletonBlock, SkeletonRows } from './loading/Skeleton'
import { PermissionPicker } from './settings/PermissionPicker'

interface Props {
  agentId: string
}

export function AgentScopesPanel({ agentId }: Props) {
  return (
    <Can permission="agents:scopes:read">
      <AgentScopesPanelContent agentId={agentId} />
    </Can>
  )
}

function AgentScopesPanelContent({ agentId }: Props) {
  const queryClient = useQueryClient()
  const { data: scopes = [], isLoading, isError, isSuccess } = useQuery(queries.agents.scopes(agentId))
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([])
  const scopeSkeletonCount = useLoadingShapeCount(
    `agents:${agentId}:extra-scopes`,
    isSuccess ? scopes.length : undefined,
    { fallbackCount: 3, maxCount: 8 }
  )

  const invalidateAgentScopes = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.scopes(agentId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all })
  }

  const grantMutation = useMutation({
    mutationFn: (permission: string) => grantAgentScope(agentId, permission),
    onSuccess: invalidateAgentScopes,
  })

  const revokeMutation = useMutation({
    mutationFn: (permission: string) => revokeAgentScope(agentId, permission),
    onSuccess: invalidateAgentScopes,
  })

  const grantedPermissions = new Set(scopes.map((scope) => scope.permission))
  const grantableSelections = selectedPermissions.filter((permission) => !grantedPermissions.has(permission))
  const isMutating = grantMutation.isPending || revokeMutation.isPending
  const error = grantMutation.error ?? revokeMutation.error

  async function grantSelected() {
    for (const permission of grantableSelections) {
      await grantMutation.mutateAsync(permission)
    }
    setSelectedPermissions([])
  }

  return (
    <section className="overflow-hidden border-t border-panel-border pt-5">
      <div className="pb-3">
        <h3 className="text-sm font-medium text-primary">Extra Scopes</h3>
        <p className="mt-1 text-xs text-muted">Additive permission grants applied only to this agent.</p>
      </div>
      <div className="space-y-4">
        {isLoading ? (
          <LoadingSurface label="Loading extra scopes" className="flex flex-wrap gap-2">
            <SkeletonRows count={Math.max(1, scopeSkeletonCount)}>
              {(index) => <SkeletonBlock key={index} className={index % 2 ? 'h-6 w-28' : 'h-6 w-36'} />}
            </SkeletonRows>
          </LoadingSurface>
        ) : isError ? (
          <p className="text-sm text-danger">Failed to load extra scopes.</p>
        ) : scopes.length === 0 ? (
          <p className="text-sm italic text-muted">No extra scopes granted</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {scopes.map((scope) => (
              <span
                key={scope.id}
                className="inline-flex items-center gap-1 rounded bg-surface-secondary px-1.5 py-0.5 font-mono text-xs text-secondary"
              >
                {scope.permission}
                <Can permission="agents:scopes:manage">
                  <button
                    type="button"
                    className="ficus-button ficus-button-ghost hover:text-status-danger-600 dark:hover:text-status-danger-400"
                    aria-label={`Revoke ${scope.permission}`}
                    disabled={isMutating}
                    onClick={() => revokeMutation.mutate(scope.permission)}
                  >
                    ×
                  </button>
                </Can>
              </span>
            ))}
          </div>
        )}

        <Can permission="agents:scopes:manage">
          <div className="space-y-3 rounded-lg border border-th-border bg-surface-secondary p-3">
            <div>
              <h4 className="text-sm font-medium text-primary">Grant permissions</h4>
              <p className="mt-1 text-xs text-muted">Select one or more permissions to grant to this agent.</p>
            </div>
            <PermissionPicker value={selectedPermissions} onChange={setSelectedPermissions} />
            {error && <div className="text-sm text-danger">{(error as Error).message}</div>}
            <button
              type="button"
              className={clsx(
                'ficus-button ficus-button-primary',
                'rounded-md px-3 py-1.5 text-sm font-medium',
                grantableSelections.length === 0 || (isMutating && 'cursor-not-allowed opacity-50')
              )}
              disabled={grantableSelections.length === 0 || isMutating}
              onClick={() => void grantSelected()}
            >
              Grant selected
            </button>
          </div>
        </Can>
      </div>
    </section>
  )
}
