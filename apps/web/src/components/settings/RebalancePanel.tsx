import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import { rebalanceFleet, type Machine, type RebalancePlan } from '../../api/machines'

/**
 * Map a rebalance failure to an inline message. A concurrent execute 409s with
 * an untyped body (apiFetch throws a generic `Error` whose message carries the
 * status), so detect it by the message text and give the operator a retryable
 * hint instead of the raw `API error: 409` string.
 */
export function rebalanceErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('409')) return 'A rebalance is already running.'
  return message
}

/** A move's machine id resolves to its name from the loaded list; a synthetic
 *  `provision:<n>` target (no fitting VM) has no row, so fall back to the id. */
function resolveMachineName(id: string, machines: Machine[]): string {
  return machines.find((m) => m.id === id)?.name ?? id
}

/**
 * Pure presentation of a rebalance plan (the dry-run preview). Renders the moves
 * with resolved machine names plus non-zero skipped/unplaceable/unresolvable
 * counts, or "Fleet is balanced." when there is nothing to move.
 */
export function RebalancePlanView({ plan, machines }: { plan: RebalancePlan; machines: Machine[] }) {
  if (plan.moves.length === 0) {
    return <p className="text-xs text-muted">Fleet is balanced.</p>
  }

  const counts: string[] = []
  if (plan.skippedActive.length > 0) counts.push(`${plan.skippedActive.length} skipped (active turn)`)
  if (plan.unplaceable.length > 0) counts.push(`${plan.unplaceable.length} unplaceable`)
  if (plan.unresolvable.length > 0) counts.push(`${plan.unresolvable.length} unresolvable`)

  return (
    <div className="space-y-2 text-xs">
      <p className="font-medium text-secondary">
        {plan.moves.length} {plan.moves.length === 1 ? 'move' : 'moves'} planned
      </p>
      <div className="space-y-1">
        {plan.moves.map((move) => (
          <div key={move.sandboxId} className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-primary">{move.sandboxId}</span>
            <span className="text-muted">{resolveMachineName(move.fromMachineId, machines)}</span>
            <span className="text-muted">→</span>
            <span className="text-primary">{resolveMachineName(move.toMachineId, machines)}</span>
          </div>
        ))}
      </div>
      {counts.length > 0 && <p className="text-muted">{counts.join(' · ')}</p>}
    </div>
  )
}

/** Pure presentation of an executed rebalance's per-move outcomes. */
function AppliedResultsView({ plan }: { plan: RebalancePlan }) {
  const moved = plan.results.filter((r) => r.result.moved).length
  const failed = plan.results.filter((r) => !r.result.moved)
  return (
    <div className="space-y-1 text-xs">
      <p className="font-medium text-secondary">
        Rebalance applied — {moved} moved{failed.length > 0 ? `, ${failed.length} unchanged` : ''}.
      </p>
      {failed.map((r) => (
        <div key={r.sandboxId} className="flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-primary">{r.sandboxId}</span>
          <span className="text-status-danger-600 dark:text-status-danger-400">{r.result.reason ?? 'failed'}</span>
        </div>
      ))}
      {plan.results.length === 0 && <p className="text-muted">No moves were necessary.</p>}
    </div>
  )
}

/**
 * Fleet-level rebalance control (machines:write): a preview-then-confirm flow.
 * "Rebalance" runs a dry run and shows the plan; Confirm executes it (dryRun:
 * false) and surfaces the applied result; Cancel dismisses the preview. A 409
 * (already running) and any other failure surface inline — never silently. The
 * button is disabled while a dry run or apply is in flight.
 */
export function RebalancePanel({ machines }: { machines: Machine[] }) {
  const queryClient = useQueryClient()
  const [plan, setPlan] = useState<RebalancePlan | null>(null)
  const [applied, setApplied] = useState<RebalancePlan | null>(null)

  const dryRun = useMutation({
    mutationFn: () => rebalanceFleet({ dryRun: true }),
    onSuccess: (p) => {
      setApplied(null)
      setPlan(p)
    },
  })

  const apply = useMutation({
    mutationFn: () => rebalanceFleet({ dryRun: false }),
    onSuccess: (p) => {
      setPlan(null)
      setApplied(p)
      // Live box.status events also flow in, but refetch now so the fleet view
      // reflects the moves without waiting.
      queryClient.invalidateQueries({ queryKey: queryKeys.machines.all })
    },
  })

  const busy = dryRun.isPending || apply.isPending
  const error = dryRun.error ?? apply.error

  return (
    <div className="ficus-section overflow-hidden">
      <div className="px-4 py-3 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-secondary">Fleet rebalance</h4>
          <p className="text-xs text-muted mt-0.5">
            Re-pack shared boxes across ready machines. Preview the plan first, then confirm to apply.
          </p>
        </div>
        <button
          onClick={() => dryRun.mutate()}
          disabled={busy}
          className="ficus-button ficus-button-primary shrink-0 text-xs px-3 py-1.5 rounded font-medium disabled:opacity-50"
        >
          {dryRun.isPending ? 'Planning…' : 'Rebalance'}
        </button>
      </div>

      {error && (
        <div className="px-4 pb-3">
          <p className="text-xs text-status-danger-600 dark:text-status-danger-400">{rebalanceErrorMessage(error)}</p>
        </div>
      )}

      {plan && (
        <div className="px-4 pb-4 pt-3 space-y-3 border-t border-th-border">
          <RebalancePlanView plan={plan} machines={machines} />
          <div className="flex items-center gap-3">
            {plan.moves.length > 0 && (
              <button
                onClick={() => apply.mutate()}
                disabled={busy}
                className="ficus-button ficus-button-primary text-xs px-3 py-1.5 rounded font-medium disabled:opacity-50"
              >
                {apply.isPending ? 'Applying…' : 'Confirm'}
              </button>
            )}
            <button
              onClick={() => setPlan(null)}
              disabled={busy}
              className="ficus-button ficus-button-link text-xs text-muted hover:text-primary font-medium disabled:opacity-50"
            >
              {plan.moves.length > 0 ? 'Cancel' : 'Dismiss'}
            </button>
          </div>
        </div>
      )}

      {applied && (
        <div className="px-4 pb-4 pt-3 space-y-2 border-t border-th-border">
          <AppliedResultsView plan={applied} />
          <button
            onClick={() => setApplied(null)}
            className="ficus-button ficus-button-link text-xs text-muted hover:text-primary font-medium"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}
