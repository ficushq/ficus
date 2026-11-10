import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  WorkflowCatalogEntry,
  WorkflowRestoreImpact,
  WorkflowTemplateDifference,
  WorkflowTemplateHold,
} from '@ficus/client-core'
import { client } from '../../api/clientInstance'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { hasTemplateDrift } from '../../lib/workflowTemplateDrift'

function show(value: unknown): string {
  if (value === undefined) return 'Not present'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function Difference({
  item,
  selectable,
  checked,
  onToggle,
}: {
  item: WorkflowTemplateDifference
  selectable: boolean
  checked: boolean
  onToggle: () => void
}) {
  return (
    <li className="min-w-0 space-y-1">
      <div className="flex items-start gap-2">
        {selectable && (
          <input
            type="checkbox"
            className="mt-1"
            aria-label={`Restore ${item.label}`}
            checked={checked}
            onChange={onToggle}
          />
        )}
        <details className="min-w-0 flex-1">
          <summary className="cursor-pointer wrap-break-word text-sm text-primary">{item.label}</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(
              [
                ['This preset', item.current],
                ['Code template', item.template],
              ] as const
            ).map(([heading, value]) => (
              <div key={heading} className="min-w-0">
                <p className="text-xs font-medium text-muted">{heading}</p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-surface-secondary p-2 text-xs">
                  {show(value)}
                </pre>
              </div>
            ))}
          </div>
        </details>
      </div>
    </li>
  )
}

function SquadImpact({ impact }: { impact: WorkflowRestoreImpact }) {
  const count = impact.affectedSquads.length + impact.hiddenSquadCount
  return (
    <div role="alert" className="space-y-2 text-sm text-status-warning-700 dark:text-status-warning-400">
      <p>
        This restore would break saved workflow customizations in {count} squad{count === 1 ? '' : 's'}. They refer to
        steps or participants that the code template renamed or removed, so creating work streams with them would fail
        until each squad updates its workflow settings.
      </p>
      {!!impact.affectedSquads.length && (
        <ul className="list-disc space-y-1 pl-5">
          {impact.affectedSquads.map((squad) => (
            <li key={squad.squadId} className="wrap-break-word">
              <span className="font-medium">{squad.squadName}</span>: {squad.problems.join('; ')}
            </li>
          ))}
        </ul>
      )}
      {impact.hiddenSquadCount > 0 && (
        <p>
          {impact.hiddenSquadCount} affected squad{impact.hiddenSquadCount === 1 ? ' is' : 's are'} not visible to you.
        </p>
      )}
    </div>
  )
}

function HeldBack({ hold }: { hold: WorkflowTemplateHold }) {
  const count = hold.affectedSquads.length + hold.hiddenSquadCount
  return (
    <div aria-label="Held-back code update" className="space-y-2 text-sm">
      <p className="font-medium text-primary">A code update to this preset is held back</p>
      {hold.blockedBy === 'squad-customizations' && (
        <p className="text-muted">
          It would break saved workflow customizations in {count} squad{count === 1 ? '' : 's'}, so this preset keeps
          its current definition. Every sync retries it, and it applies automatically once those squads stop referring
          to the old steps or participants.
        </p>
      )}
      {hold.blockedBy === 'invalid-workflow' && (
        <p className="text-muted">
          Merged with this preset’s edits it is not a valid workflow, so this preset keeps its current definition.
          {hold.invalidReason ? ` ${hold.invalidReason}` : ''}
        </p>
      )}
      {hold.blockedBy === null && (
        <p className="text-muted">Nothing blocks it any more; it applies on the next sync.</p>
      )}
      {!!hold.affectedSquads.length && (
        <ul className="list-disc space-y-1 pl-5">
          {hold.affectedSquads.map((squad) => (
            <li key={squad.squadId} className="wrap-break-word">
              <span className="font-medium">{squad.squadName}</span>: {squad.problems.join('; ')}
            </li>
          ))}
        </ul>
      )}
      {hold.hiddenSquadCount > 0 && (
        <p className="text-muted">
          {hold.hiddenSquadCount} affected squad{hold.hiddenSquadCount === 1 ? ' is' : 's are'} not visible to you.
        </p>
      )}
      {!!hold.parts.length && (
        <p className="wrap-break-word text-muted">It changes: {hold.parts.map((part) => part.label).join(', ')}.</p>
      )}
    </div>
  )
}

/**
 * Shows where a shared preset differs from its code template. Code updates still apply to every
 * other part; the parts listed here keep this preset's values. With `canRestore`, people can
 * restore everything or the selected parts, after a warning when that would break squads.
 */
export function WorkflowTemplateDrift({ entry, canRestore }: { entry: WorkflowCatalogEntry; canRestore: boolean }) {
  const cache = useQueryClient()
  const diff = useQuery({ ...queries.workflows.templateDiff(entry.id), enabled: hasTemplateDrift(entry) })
  const [selected, setSelected] = useState<string[]>([])
  const [pending, setPending] = useState<{ paths?: string[]; impact: WorkflowRestoreImpact } | null>(null)
  const preview = useMutation({
    mutationFn: async (paths?: string[]) => ({ paths, impact: await client.workflows.previewRestore(entry.id, paths) }),
    onSuccess: setPending,
  })
  const restore = useMutation({
    mutationFn: async () => {
      if (!pending) return
      const impact = pending.impact
      await client.workflows.restore(entry.id, impact.revision, {
        ...(pending.paths ? { paths: pending.paths } : {}),
        ...(impact.affectedSquads.length || impact.hiddenSquadCount ? { acknowledgeSquadImpact: true } : {}),
      })
    },
    onSuccess: async () => {
      setPending(null)
      setSelected([])
      await cache.invalidateQueries({ queryKey: queryKeys.workflows.all })
    },
  })
  if (!hasTemplateDrift(entry)) return null
  const differences = diff.data?.differences ?? []
  const busy = preview.isPending || restore.isPending
  const breaks = pending && (pending.impact.affectedSquads.length > 0 || pending.impact.hiddenSquadCount > 0)
  const error = preview.error ?? restore.error ?? diff.error
  return (
    <section
      aria-label="Differences from the code template"
      className="min-w-0 space-y-3 rounded-lg border border-panel-border bg-status-warning-100 p-3 dark:bg-status-warning-900/30"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium text-primary">This preset differs from its code template</p>
        <p className="text-sm text-muted">
          Code updates still apply to every other part of this preset. The parts listed here keep this preset’s values,
          so code updates to them are not applied.
          {canRestore ? ' Restore them to take the code version.' : ''}
        </p>
      </div>
      {diff.data?.heldBack && <HeldBack hold={diff.data.heldBack} />}
      {diff.isPending ? (
        <p className="text-sm text-muted">Comparing with the code template…</p>
      ) : (
        <ul className="space-y-2">
          {differences.map((item) => (
            <Difference
              key={item.path}
              item={item}
              selectable={canRestore}
              checked={selected.includes(item.path)}
              onToggle={() =>
                setSelected((paths) =>
                  paths.includes(item.path) ? paths.filter((path) => path !== item.path) : [...paths, item.path]
                )
              }
            />
          ))}
        </ul>
      )}
      {canRestore && !pending && (
        <div className="flex flex-wrap gap-2">
          <button
            className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
            disabled={busy || !selected.length}
            onClick={() => preview.mutate(selected)}
          >
            Restore selected
          </button>
          <button
            className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
            disabled={busy || diff.isPending}
            onClick={() => preview.mutate(undefined)}
          >
            Restore everything
          </button>
        </div>
      )}
      {pending && (
        <div className="space-y-2">
          <p className="text-sm text-primary">
            {pending.paths
              ? `Restore ${pending.paths.length} selected part${pending.paths.length === 1 ? '' : 's'} to the code template?`
              : 'Restore the whole preset to the code template?'}{' '}
            The local values of those parts will be replaced.
          </p>
          {breaks && <SquadImpact impact={pending.impact} />}
          <div className="flex flex-wrap gap-2">
            <button
              className="ficus-button ficus-button-danger px-3 py-1.5 text-sm"
              disabled={busy}
              onClick={() => restore.mutate()}
            >
              {restore.isPending ? 'Restoring…' : breaks ? 'Restore anyway' : 'Restore'}
            </button>
            <button
              className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {error.message}
        </p>
      )}
    </section>
  )
}
