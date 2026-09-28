import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { createSystemToken, revokeSystemToken, type CreatedSystemToken } from '../../api/systemTokens'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

import { PermissionPicker } from './PermissionPicker'

export function SystemTokensSection() {
  const queryClient = useQueryClient()
  const [includeWebhook, setIncludeWebhook] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [customScope, setCustomScope] = useState('')
  const [created, setCreated] = useState<CreatedSystemToken | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: tokens = [], isLoading, isSuccess } = useQuery(queries.systemTokens.list(includeWebhook))
  const tokenSkeletonCount = useLoadingShapeCount(
    `settings:system-tokens:${includeWebhook ? 'with-webhooks' : 'standard'}`,
    isSuccess ? tokens.length : undefined,
    { fallbackCount: 3, maxCount: 8 }
  )

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.systemTokens.all })

  const createMutation = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error('Name is required')
      if (scopes.length === 0) throw new Error('At least one scope is required')
      return createSystemToken({ name: name.trim(), scopes })
    },
    onSuccess: (token) => {
      setCreated(token)
      setName('')
      setScopes([])
      setCustomScope('')
      setError(null)
      invalidate()
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Failed to create token'),
  })

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeSystemToken(id),
    onSuccess: invalidate,
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-primary">System Tokens</h2>
        <p className="text-sm text-muted mt-1">
          User-less API tokens with explicit permission scopes, for automation. The token value is shown only once when
          created.
        </p>
      </div>

      {/* Create */}
      <div className="border-b border-panel-border last:border-b-0 p-4 space-y-3">
        <h3 className="text-sm font-medium text-primary">Create a token</h3>
        <input
          type="text"
          aria-label="Token name"
          disabled={createMutation.isPending}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. CI deploy notifier)"
          className="ficus-field w-full px-3 py-2 text-sm border border-th-border bg-surface-secondary rounded-md"
        />
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-primary">Permissions</h4>
          <p className="text-xs text-muted">
            Choose what this token can do. These grants apply across the instance; resource and ownership checks still
            apply.
          </p>
          <PermissionPicker value={scopes} onChange={setScopes} disabled={createMutation.isPending} />
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Advanced: custom scope</summary>
          <p className="my-2 text-xs text-muted">
            For provider-specific permissions such as integrations:read:github, or an explicit resource wildcard such as
            workstreams:*. Wildcards also grant future permissions in that resource.
          </p>
          <div className="flex gap-2">
            <input
              aria-label="Custom permission scope"
              value={customScope}
              onChange={(event) => setCustomScope(event.target.value)}
              placeholder="integrations:read:github"
              disabled={createMutation.isPending}
              className="ficus-field min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-xs"
            />
            <button
              type="button"
              disabled={createMutation.isPending || !customScope.trim()}
              onClick={() => {
                setScopes([
                  ...new Set([
                    ...scopes,
                    ...customScope
                      .trim()
                      .split(/[\s,]+/)
                      .filter(Boolean),
                  ]),
                ])
                setCustomScope('')
              }}
              className="ficus-button text-sm text-accent-light disabled:opacity-50"
            >
              Add scope
            </button>
          </div>
        </details>
        {error && <p className="text-sm text-status-danger-600 dark:text-status-danger-400">{error}</p>}
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="ficus-button ficus-button-primary px-3 py-1.5 text-sm font-medium text-on-accent bg-accent rounded-md hover:bg-accent-hover disabled:opacity-50"
        >
          {createMutation.isPending ? 'Creating…' : 'Create token'}
        </button>
      </div>

      {/* One-time token reveal */}
      {created && (
        <div className="rounded-lg border-2 border-status-success-300 dark:border-status-success-700 bg-status-success-50 dark:bg-status-success-900/20 p-4 space-y-2">
          <p className="text-sm font-medium text-status-success-800 dark:text-status-success-200">
            Token “{created.name}” created — copy it now, it won’t be shown again:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-2 py-1.5 text-xs bg-surface rounded border border-th-border break-all">
              {created.token}
            </code>
            <button
              onClick={() => navigator.clipboard?.writeText(created.token)}
              className="ficus-button px-2 py-1.5 text-xs font-medium text-secondary bg-surface-secondary rounded hover:bg-surface-hover shrink-0"
            >
              Copy
            </button>
          </div>
          <button onClick={() => setCreated(null)} className="ficus-button text-xs text-muted hover:text-secondary">
            Dismiss
          </button>
        </div>
      )}

      {/* List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 data-setting-target="active-tokens" className="text-sm font-medium text-primary">
            Active tokens
          </h3>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={includeWebhook} onChange={(e) => setIncludeWebhook(e.target.checked)} />
            Show webhook tokens
          </label>
        </div>
        {isLoading ? (
          <CollectionSkeleton label="Loading active tokens" count={tokenSkeletonCount} />
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted italic">No tokens.</p>
        ) : (
          <div className="space-y-1.5">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="border-b border-panel-border last:border-b-0 flex items-start justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-primary">
                    {t.name}
                    {t.kind === 'webhook' && <span className="ml-2 text-xs font-normal text-muted">(webhook)</span>}
                  </p>
                  <p className="text-xs text-muted font-mono break-all mt-0.5">{t.scopes.join(', ')}</p>
                  <p className="text-xs text-placeholder mt-0.5">
                    Created {new Date(t.createdAt).toLocaleDateString()}
                    {t.lastUsedAt ? ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : ' · never used'}
                  </p>
                </div>
                <button
                  onClick={() => revokeMutation.mutate(t.id)}
                  disabled={revokeMutation.isPending}
                  className="ficus-button px-2 py-1 text-xs font-medium text-status-danger-600 dark:text-status-danger-400 border border-th-border rounded hover:bg-surface-hover disabled:opacity-50 shrink-0"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
