import { IntegrationLogo } from '../integrations/IntegrationLogo'
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { configureSquadIntegration, type IntegrationCatalogItem } from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
import { ChevronDownIcon } from '../icons'
import { ConnectionAssignmentPicker } from '../integrations/ConnectionAssignmentPicker'

export function SquadIntegrationCard({
  entry,
  squadId,
  canWrite,
  children,
}: {
  entry: IntegrationCatalogItem
  squadId: string
  canWrite: boolean
  children?: ReactNode
}) {
  const client = useQueryClient()
  const selection = useQuery(integrationQueries.squad(squadId, entry.key))
  const [expanded, setExpanded] = useState(false)
  const enabled = selection.data?.scope?.enabled ?? !!selection.data?.assignment
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => configureSquadIntegration(squadId, entry.key, { enabled }),
    onSuccess: async (_, enabled) => {
      setExpanded(enabled)
      await client.invalidateQueries({ queryKey: integrationQueryKeys.squad(squadId, entry.key) })
    },
  })
  return (
    <article
      className={clsx(
        'min-w-0 rounded-xl border border-panel-border bg-surface',
        expanded && enabled && 'md:col-span-2'
      )}
    >
      <div className="p-5">
        <div className="flex items-start gap-3">
          <div
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-panel-border bg-surface-secondary text-lg font-semibold text-primary"
          >
            <IntegrationLogo provider={entry.key} label={entry.label} />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="font-semibold text-primary">{entry.label}</h4>
            <span className={clsx('text-xs', enabled ? 'text-accent-light' : 'text-muted')}>
              {selection.isPending ? 'Loading…' : enabled ? 'Enabled for this squad' : 'Disabled for this squad'}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={`Enable ${entry.label} for this squad`}
            aria-checked={enabled}
            disabled={!canWrite || selection.isPending || selection.isError || toggle.isPending}
            onClick={() => toggle.mutate(!enabled)}
            className={clsx(
              'relative mt-1 h-6 w-10 shrink-0 rounded-full border transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent-light',
              enabled ? 'border-accent bg-accent' : 'border-panel-border bg-surface-secondary'
            )}
          >
            <span
              className={clsx(
                'absolute left-[3px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-chrome-paper shadow transition-transform',
                enabled ? 'translate-x-4' : 'translate-x-0'
              )}
            />
          </button>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted">{entry.description}</p>
        {(toggle.isError || selection.isError) && (
          <p role="alert" className="mt-3 text-sm text-status-danger-500">
            Unable to load or update this squad’s integration.
          </p>
        )}
        {enabled && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="ficus-button ficus-button-link mt-4 flex items-center gap-2 text-sm text-primary"
          >
            Settings
            <ChevronDownIcon className={clsx('h-4 w-4', expanded && 'rotate-180')} />
          </button>
        )}
      </div>
      {enabled && expanded && (
        <div className="min-w-0 border-t border-panel-border p-5">
          <ConnectionAssignmentPicker
            embedded
            squadId={squadId}
            provider={entry.key}
            presentation={{ label: entry.label }}
            canRead
            canWrite={canWrite}
          />
          {children}
        </div>
      )}
    </article>
  )
}
