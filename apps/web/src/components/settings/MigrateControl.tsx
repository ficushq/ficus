import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queryKeys } from '../../queryKeys'
import { migrateBox, type Machine, type MigrateResult } from '../../api/machines'

/**
 * Inline note for a refused migrate. A refusal is a 200 with `{ moved: false,
 * reason }`, not an error, so the reason token (`squad-box`, `active-turn`, …)
 * is shown verbatim next to the box — the message itself teaches why the move
 * was declined. Renders nothing for a successful (or absent) result.
 */
export function MigrateReasonNote({ result }: { result: MigrateResult | undefined }) {
  if (!result || result.moved) return null
  const count = result.activeExecutionCount
  return (
    <span className="text-xs text-status-danger-600 dark:text-status-danger-400">
      refused: {result.reason ?? 'failed'}
      {count === undefined ? '' : ` (${count} active executions)`}
    </span>
  )
}

/**
 * Per-box migrate control (machines:write) for the machine detail panel: a
 * compact target picker (other ready, shared-scope machines) plus a Migrate
 * button that moves this box onto the chosen target. A refusal surfaces its
 * reason verbatim; a success invalidates the fleet queries so the detail
 * refetches (live box.status events also arrive).
 *
 * A SQUAD box now migrates by default, and that is a much heavier action than
 * the agent-box case this control was built for: it carries a multi-GB
 * ~/workspace and stops the squad's local deployments for the duration. The
 * migration fence DOES see squad activity — a running or stopping execution of
 * any squad-capable member refuses the move (`active-turn`), and execution
 * pickup takes the same box row lock, so a turn cannot start under a move
 * either (box-migrate.ts). What the fence still cannot see is a write not tied
 * to an execution row: a detached build or a file-sync into ~/workspace. That
 * residual, plus the sheer size of the action, is why this asks for
 * confirmation — the CLI's equivalent is a deliberate typed command with live
 * phase output, and a single unconfirmed click here is not.
 *
 * There is deliberately no force/override here: `--force` (which migrates
 * despite live executions and can lose their in-flight writes) is CLI-only, so
 * it stays a typed, considered action rather than a checkbox next to a
 * one-click button.
 */
export function MigrateControl({
  sandboxId,
  machines,
  currentMachineId,
}: {
  sandboxId: string
  machines: Machine[]
  currentMachineId: string
}) {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState('')

  const targets = machines.filter((m) => m.id !== currentMachineId && m.status === 'ready' && m.scope === 'shared')

  const isSquad = sandboxId.startsWith('squad_')

  const mutation = useMutation({
    mutationFn: () => migrateBox(target, sandboxId),
    onSuccess: (result) => {
      if (result.moved) queryClient.invalidateQueries({ queryKey: queryKeys.machines.all })
    },
  })

  const selectClass =
    'text-xs bg-surface-secondary border border-th-border rounded px-1.5 py-0.5 text-primary  focus:ring-1 focus:ring-accent disabled:opacity-50'

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        disabled={targets.length === 0 || mutation.isPending}
        className={clsx('ficus-field', selectClass, 'w-auto')}
      >
        <option value="">{targets.length === 0 ? 'No target machines' : 'Migrate to…'}</option>
        {targets.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <button
        onClick={() => {
          // Squad-only gate. Live squad EXECUTIONS are fenced (the move is
          // refused with `active-turn`), so this is not the last line of
          // defence it once was — but a squad move is still much bigger than an
          // agent-box move, and background writes not tied to an execution row
          // are outside the fence. Agent boxes keep the one-click path.
          if (isSquad) {
            const name = machines.find((m) => m.id === target)?.name ?? target
            const ok = window.confirm(
              `Migrate this SQUAD box to ${name}?\n\n` +
                `Its entire ~/workspace moves and its local deployments stop for the duration. ` +
                `A live squad turn refuses the move, but background work that isn't an execution ` +
                `(a detached build, a file-sync) is not detected.`
            )
            if (!ok) return
          }
          mutation.mutate()
        }}
        disabled={!target || mutation.isPending}
        className="ficus-button text-xs text-accent-light hover:text-accent-hover font-medium disabled:opacity-50"
      >
        {mutation.isPending ? 'Migrating…' : 'Migrate'}
      </button>
      {mutation.data && <MigrateReasonNote result={mutation.data} />}
      {mutation.error && (
        <span className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {(mutation.error as Error).message}
        </span>
      )}
    </span>
  )
}
