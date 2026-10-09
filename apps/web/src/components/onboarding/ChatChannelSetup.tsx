import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { integrationQueries } from '../../queryOptions'
import { usePermissions } from '../../hooks/usePermissions'
import { IntegrationDirectoryCard } from '../settings/IntegrationsSection'

const CHANNELS = ['discord', 'slack', 'telegram']

/** Reuse the directory's credentials and channel routing forms without leaving setup. */
export function ChatChannelSetup() {
  const { can } = usePermissions()
  const allowed = CHANNELS.filter((provider) => can(`integrations:read:${provider}`))
  const catalog = useQuery({ ...integrationQueries.catalog(), enabled: allowed.length > 0 })
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  return (
    <div className="min-w-0 space-y-4">
      <p className="text-sm text-muted">Enable the chat apps your team uses. You can connect more than one.</p>
      {allowed.length === 0 ? (
        <p className="text-sm text-muted">Channel setup requires permission to manage integrations.</p>
      ) : catalog.isPending ? (
        <p className="text-sm text-muted">Loading chat integrations…</p>
      ) : catalog.isError ? (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          Unable to load chat integrations.
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
          {catalog.data.integrations
            .filter((item) => allowed.includes(item.key))
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((entry) => (
              <IntegrationDirectoryCard
                key={entry.key}
                entry={entry}
                canWrite={can(`integrations:write:${entry.key}`)}
                expanded={expanded[entry.key] ?? false}
                setExpanded={(value) => setExpanded((current) => ({ ...current, [entry.key]: value }))}
              />
            ))}
        </div>
      )}
    </div>
  )
}
