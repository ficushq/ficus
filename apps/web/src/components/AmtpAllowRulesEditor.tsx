import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { addAgentAllowRule, deleteAgentAllowRule } from '../api/amtp'

interface AmtpAllowRulesEditorProps {
  agentId: string
  canWrite: boolean
}

/**
 * Per-agent allow-rule CRUD. Operator-only (amtp:write); renders nothing
 * otherwise. Mirrors the RolesSection add/delete convention.
 */
export function AmtpAllowRulesEditor({ agentId, canWrite }: AmtpAllowRulesEditorProps) {
  const queryClient = useQueryClient()
  const { data: rules = [] } = useQuery(queries.amtp.allowRules(agentId))
  const { data: peers = [] } = useQuery(queries.amtp.peers())
  const [peerInstanceId, setPeerInstanceId] = useState('')
  const [principalKind, setPrincipalKind] = useState<'any' | 'handle'>('any')
  const [principalValue, setPrincipalValue] = useState('')

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.amtp.allowRules(agentId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.amtp.agentStatus(agentId) })
  }

  const addRule = useMutation({
    mutationFn: () =>
      addAgentAllowRule(agentId, {
        peerInstanceId,
        principalKind,
        principalValue: principalKind === 'handle' ? principalValue : undefined,
      }),
    onSuccess: () => {
      invalidate()
      setPeerInstanceId('')
      setPrincipalKind('any')
      setPrincipalValue('')
    },
  })

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) => deleteAgentAllowRule(agentId, ruleId),
    onSuccess: invalidate,
  })

  if (!canWrite) return null

  const canSubmit =
    !!peerInstanceId &&
    (principalKind === 'any' || (principalKind === 'handle' && !!principalValue)) &&
    !addRule.isPending

  return (
    <div className="mt-4 space-y-2 pt-2">
      <dt className="text-xs font-medium text-secondary">Allow rules</dt>
      <dd className="mt-2 space-y-2">
        {rules.length === 0 && (
          <p className="text-xs text-muted">No allow rules. Inbound requires the mailbox open or a matching rule.</p>
        )}
        {rules.map((rule) => (
          <div key={rule.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 break-words text-secondary">
              {peers.find((peer) => peer.instanceId === rule.peerInstanceId)?.localAlias ?? rule.peerInstanceId} ·{' '}
              {rule.principalKind === 'any' ? 'Any sender' : 'Handle'}
              {rule.principalKind === 'handle' && rule.principalValue ? `:${rule.principalValue}` : ''}
            </span>
            <button
              onClick={() => {
                if (confirm('Delete this allow rule?')) deleteRule.mutate(rule.id)
              }}
              disabled={deleteRule.isPending}
              aria-label="Delete allow rule"
              className="ficus-button shrink-0 text-xs font-medium text-status-danger-600 hover:text-status-danger-800 disabled:opacity-50 dark:text-status-danger-400 dark:hover:text-status-danger-300"
            >
              Delete
            </button>
          </div>
        ))}
        <form
          className="flex flex-wrap items-center gap-2 pt-1"
          onSubmit={(e) => {
            e.preventDefault()
            addRule.mutate()
          }}
        >
          <select
            value={peerInstanceId}
            onChange={(e) => setPeerInstanceId(e.target.value)}
            aria-label="Peer instance"
            className="ficus-field rounded border border-th-border bg-surface-secondary px-2 py-1 text-xs text-primary  focus:ring-1 focus:ring-accent"
          >
            <option value="">Select peer…</option>
            {peers.map((p) => (
              <option key={p.id} value={p.instanceId}>
                {p.localAlias}
              </option>
            ))}
          </select>
          <select
            value={principalKind}
            onChange={(e) => setPrincipalKind(e.target.value as 'any' | 'handle')}
            aria-label="Principal kind"
            className="ficus-field rounded border border-th-border bg-surface-secondary px-2 py-1 text-xs text-primary  focus:ring-1 focus:ring-accent"
          >
            <option value="any">Any sender</option>
            <option value="handle">Specific handle</option>
          </select>
          {principalKind === 'handle' && (
            <input
              type="text"
              value={principalValue}
              onChange={(e) => setPrincipalValue(e.target.value)}
              placeholder="handle"
              aria-label="Principal handle"
              className="ficus-field rounded border border-th-border bg-surface-secondary px-2 py-1 text-xs text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
            />
          )}
          <button
            type="submit"
            disabled={!canSubmit}
            className="ficus-button ficus-button-primary rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {addRule.isPending ? 'Adding…' : 'Add rule'}
          </button>
        </form>
        {addRule.isError && (
          <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
            {(addRule.error as Error)?.message || 'Failed to add rule'}
          </p>
        )}
      </dd>
    </div>
  )
}
