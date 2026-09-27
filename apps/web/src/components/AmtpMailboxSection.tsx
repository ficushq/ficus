import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'
import { closeAgentMailbox, openAgentMailbox, registerAgentFederation, unregisterAgentFederation } from '../api/amtp'
import { AmtpAllowRulesEditor } from './AmtpAllowRulesEditor'

interface AmtpMailboxSectionProps {
  agentId: string
  squadId?: string
}

/**
 * Per-agent federation mailbox card. Self-fetches GET …/:id/status and shows
 * read rows for everyone; operator controls (register/revoke, open/close, allow
 * rules) are gated behind amtp:write — mirrors AgentSandboxControls.
 */
export function AmtpMailboxSection({ agentId, squadId }: AmtpMailboxSectionProps) {
  const queryClient = useQueryClient()
  const { can } = usePermissions(squadId)
  const canWrite = can('amtp:write')
  // The status endpoint requires amtp:read (or write); without it the fetch 403s.
  // Gate the query so a plain viewer doesn't trigger retry storms / refetch-on-focus 403s.
  const canRead = can('amtp:read') || canWrite
  const { data: status } = useQuery({ ...queries.amtp.agentStatus(agentId), enabled: canRead })
  const [handle, setHandle] = useState('')

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.amtp.agentStatus(agentId) })
  }

  const register = useMutation({
    mutationFn: () => registerAgentFederation(agentId, handle),
    onSuccess: () => {
      invalidate()
      setHandle('')
    },
  })
  const revoke = useMutation({ mutationFn: () => unregisterAgentFederation(agentId), onSuccess: invalidate })
  const open = useMutation({ mutationFn: () => openAgentMailbox(agentId), onSuccess: invalidate })
  const close = useMutation({ mutationFn: () => closeAgentMailbox(agentId), onSuccess: invalidate })

  if (!status) return null

  const signingReady = status.signingIdentity.status === 'ready'
  const isBusy = register.isPending || revoke.isPending || open.isPending || close.isPending

  return (
    <dl className="border-t border-panel-border pt-5">
      <dt className="text-sm font-semibold text-primary">Federation mailbox</dt>
      <dd className="mt-3 space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-primary">
            {status.registered ? <span className="break-all font-mono">{status.handle}</span> : 'Not registered'}
          </span>
          <span className="text-muted">·</span>
          <span className="text-primary">{status.inboundOpen ? 'Inbound open' : 'Inbound closed'}</span>
          {status.allowsInbound && (
            <span className="rounded bg-status-success-100 px-1.5 py-0.5 text-xs text-status-success-700 dark:bg-status-success-900/30 dark:text-status-success-400">
              Allows inbound
            </span>
          )}
        </div>

        {status.signingIdentity.status !== 'ready' && (
          <div className="rounded border border-status-review-500/30 bg-status-review-500/10 p-2 text-xs text-status-review-700 dark:text-status-review-300">
            <strong>
              {status.signingIdentity.status === 'unsupported'
                ? 'Federation unsupported'
                : 'Registered, but signing identity unavailable'}
            </strong>
            {status.signingIdentity.message && <p>{status.signingIdentity.message}</p>}
          </div>
        )}

        {status.card ? (
          <div>
            {status.card.card.name && <p className="font-medium text-primary">{status.card.card.name}</p>}
            {status.card.card.description && (
              <p className="whitespace-pre-line text-xs text-muted">{status.card.card.description}</p>
            )}
          </div>
        ) : (
          status.registered &&
          signingReady &&
          canWrite && (
            <p className="text-xs text-muted">
              Agents publish their card in-sandbox:{' '}
              <code className="rounded bg-surface-secondary px-1 py-0.5 font-mono">
                ficus remote card set --name … --description …
              </code>
            </p>
          )
        )}

        {canWrite ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {status.registered ? (
                <button
                  onClick={() => revoke.mutate()}
                  disabled={isBusy}
                  className="ficus-button rounded bg-status-danger-600/15 px-2 py-0.5 text-xs font-medium text-status-danger-600 hover:bg-status-danger-600/25 disabled:opacity-50 dark:text-status-danger-400"
                >
                  Revoke
                </button>
              ) : signingReady ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    register.mutate()
                  }}
                >
                  <input
                    type="text"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    placeholder="handle"
                    aria-label="Federation handle"
                    className="ficus-field rounded border border-th-border bg-surface-secondary px-2 py-1 text-xs text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
                  />
                  <button
                    type="submit"
                    disabled={!handle || isBusy}
                    className="ficus-button ficus-button-primary rounded bg-accent px-2 py-0.5 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
                  >
                    Register
                  </button>
                </form>
              ) : null}
              {status.registered &&
                signingReady &&
                (status.inboundOpen ? (
                  <button
                    onClick={() => close.mutate()}
                    disabled={isBusy}
                    className="ficus-button rounded bg-surface-secondary px-2 py-0.5 text-xs font-medium text-secondary hover:text-primary disabled:opacity-50"
                  >
                    Close
                  </button>
                ) : (
                  <button
                    onClick={() => open.mutate()}
                    disabled={isBusy}
                    className="ficus-button rounded bg-status-progress-600/15 px-2 py-0.5 text-xs font-medium text-status-progress-600 hover:bg-status-progress-600/25 disabled:opacity-50 dark:text-status-progress-400"
                  >
                    Open
                  </button>
                ))}
            </div>
            <AmtpAllowRulesEditor agentId={agentId} canWrite={canWrite} />
          </>
        ) : (
          <p className="text-xs text-muted">Operator controls require amtp:write.</p>
        )}
      </dd>
    </dl>
  )
}
