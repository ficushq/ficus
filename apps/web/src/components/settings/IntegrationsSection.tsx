import { Link } from 'react-router-dom'
import { IntegrationCredentialSettings } from '../integrations/IntegrationCredentialSettings'
import { IntegrationLogo } from '../integrations/IntegrationLogo'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { setIntegrationEnabled, type IntegrationCatalogItem } from '../../api/integrations'
import { usePermissions } from '../../hooks/usePermissions'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys, queryKeys } from '../../queryKeys'
import { SearchIcon, ChevronDownIcon } from '../icons'
import { ChannelIntegrationSettings } from '../integrations/ChannelIntegrationSettings'
import type { ProviderId } from './channelFormHelpers'
import { LinearIntegrationSettings } from '../integrations/LinearIntegrationSettings'
import { BigbrainIntegrationSettings } from '../integrations/BigbrainIntegrationSettings'
import { GitHubIntegrationSettings } from '../integrations/GitHubIntegrationSettings'
import { NotionIntegrationSettings } from '../integrations/NotionIntegrationSettings'

const descriptions: Record<string, string> = {
  github: 'Connect repositories, follow issues and pull requests, and bring GitHub events into your workflows.',
  notion: 'Give your squads access to pages, databases, and knowledge in Notion.',
  bigbrain: 'Connect shared memory and selectively save conversations to Bigbrain.',
}

export function IntegrationDirectoryCard({
  entry,
  canWrite,
  expanded,
  setExpanded,
  onEnabled,
}: {
  onEnabled?: () => void
  entry: IntegrationCatalogItem
  canWrite: boolean
  expanded: boolean
  setExpanded: (expanded: boolean) => void
}) {
  const client = useQueryClient()
  const enabled = entry.enabled === true
  const isPush = entry.key === 'apple-push' || entry.key === 'web-push'
  const pushSettings = useQuery({
    ...integrationQueries.credentialSettings(entry.key, 'service'),
    enabled: isPush,
  })
  const managedPush =
    isPush && !!pushSettings.data?.fields.length && pushSettings.data.fields.every((field) => field.managed)
  const toggle = useMutation({
    mutationFn: (next: boolean) => setIntegrationEnabled(entry.key, next),
    onSuccess: ({ enabled: next }) => {
      client.setQueryData<{ integrations: IntegrationCatalogItem[] }>(
        integrationQueryKeys.catalog(),
        (current) =>
          current && {
            integrations: current.integrations.map((item) =>
              item.key === entry.key ? { ...item, enabled: next } : item
            ),
          }
      )
      setExpanded(next)
      if (next) onEnabled?.()
      return Promise.all([
        client.invalidateQueries({ queryKey: integrationQueryKeys.all }),
        client.invalidateQueries({ queryKey: queryKeys.voice.all }),
      ])
    },
  })
  const showSettings = enabled && expanded && !managedPush
  return (
    <article
      id={`integration-card-${entry.key}`}
      data-setting-target={showSettings ? `integration-${entry.key}` : undefined}
      data-setting-fallback={`integration-${entry.key}`}
      tabIndex={-1}
      className={clsx(
        'flex min-w-0 scroll-mt-6 flex-col rounded-xl border border-panel-border bg-surface',
        showSettings && 'md:col-span-2'
      )}
    >
      <div className="flex flex-1 flex-col p-5">
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
              {enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={`Enable ${entry.label} globally`}
            aria-checked={enabled}
            disabled={!canWrite || toggle.isPending}
            onClick={() => toggle.mutate(!enabled)}
            className={clsx(
              'relative mt-1 h-6 w-10 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-light disabled:cursor-not-allowed disabled:opacity-50',
              enabled ? 'border-accent bg-accent' : 'border-panel-border bg-surface-secondary'
            )}
          >
            <span
              className={clsx(
                'absolute left-[3px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full shadow transition-transform',
                // On the accent track the thumb takes the on-accent ink, like text on an accent button.
                enabled ? 'translate-x-4 bg-on-accent' : 'translate-x-0 bg-chrome-toggle-thumb'
              )}
            />
          </button>
        </div>
        <p className="mt-3 min-h-[4.5rem] text-sm leading-relaxed text-muted">
          {descriptions[entry.key] ?? entry.description}
        </p>
        <div className="mt-auto">
          {managedPush && <p className="mt-3 text-sm text-muted">Managed by the platform.</p>}
          {enabled && entry.setup && entry.setup.state !== 'configured' && (
            <div className="mt-3 text-xs text-status-attention-600 dark:text-status-attention-400">
              <p className="font-medium">
                {entry.setup.state === 'needs_setup' ? 'Setup required' : 'Needs attention'}
              </p>
              {entry.setup.issues
                .filter((issue) => !issue.endsWith(' is required.'))
                .map((issue) => (
                  <p key={issue} className="mt-1">
                    {issue}
                  </p>
                ))}
            </div>
          )}
          {toggle.isError && (
            <p role="alert" className="mt-3 text-sm text-status-danger-500">
              Could not update {entry.label}. Please try again.
            </p>
          )}
          {enabled && !managedPush && (
            <button
              type="button"
              aria-expanded={showSettings}
              data-setting-reveal={`integration-${entry.key}`}
              aria-controls={`integration-settings-${entry.key}`}
              onClick={() => setExpanded(!expanded)}
              className="ficus-button mt-4 flex items-center gap-2 text-sm text-primary"
            >
              Settings
              <ChevronDownIcon className={clsx('h-4 w-4 transition-transform', showSettings && 'rotate-180')} />
            </button>
          )}
        </div>
      </div>
      {showSettings && (
        <div id={`integration-settings-${entry.key}`} className="min-w-0 border-t border-panel-border p-5">
          {['discord', 'slack', 'telegram'].includes(entry.key) && (
            <ChannelIntegrationSettings provider={entry.key as ProviderId} canWrite={canWrite} />
          )}
          {entry.key === 'github' && <GitHubIntegrationSettings canRead canWrite={canWrite} embedded />}
          {(entry.key === 'apple-push' || entry.key === 'web-push') && (
            <div className="space-y-4">
              <IntegrationCredentialSettings
                provider={entry.key}
                kind="service"
                canWrite={canWrite}
                hideManagedFields
              />
              <p className="text-sm text-muted">
                {entry.key === 'apple-push'
                  ? 'For a custom native app build, configure its own Apple push signing key here. The official Ficus app uses Settings → Administration → Mobile & Pro; Ficus Cloud configures delivery automatically.'
                  : 'Ficus generates and stores browser push signing keys automatically. Set an email address or HTTPS contact URL for the push service. Devices subscribe in personal Notifications settings.'}
              </p>
            </div>
          )}
          {entry.key === 'openai-services' && (
            <div className="space-y-4">
              <IntegrationCredentialSettings provider={entry.key} kind="service" canWrite={canWrite} />
              <p className="text-sm text-muted">
                Used for realtime voice, transcription, and memory embeddings. This key does not enable OpenAI agent
                models or add them to fallback. Configure agent model access separately in AI Providers.
              </p>
            </div>
          )}
          {entry.key === 'google-cloud' && (
            <div className="space-y-4">
              <IntegrationCredentialSettings provider={entry.key} kind="service" canWrite={canWrite} />
              <p className="text-sm text-muted">
                Used for reading messages aloud. Enable the Text-to-Speech API in your Google Cloud project, then paste
                its service account JSON key above. Changes apply to new speech requests without restarting Ficus.
              </p>
              <p className="text-xs text-muted">
                Administrators can also configure Application Default Credentials on the server. Transcription uses the
                separate OpenAI API services integration.
              </p>
            </div>
          )}
          {entry.connectionMode === 'deployment' && (
            <div className="space-y-4">
              <IntegrationCredentialSettings provider={entry.key} kind="deployment" canWrite={canWrite} />
              <p className="text-sm text-muted">
                Choose which squads can use this token in each squad’s Environment settings. Existing exposure choices
                are preserved.
              </p>
            </div>
          )}
          {entry.key === 'linear' && <LinearIntegrationSettings canWrite={canWrite} />}
          {entry.key === 'notion' && <NotionIntegrationSettings canRead canWrite={canWrite} embedded />}
          {entry.key === 'bigbrain' && <BigbrainIntegrationSettings canRead canWrite={canWrite} embedded />}
        </div>
      )}
    </article>
  )
}

export function IntegrationsSection() {
  const permissions = usePermissions()
  const catalog = useQuery(integrationQueries.catalog())
  const [search, setSearch] = useState('')
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!scrollTarget || !catalog.data?.integrations.some((entry) => entry.key === scrollTarget && entry.enabled))
      return
    const card = document.getElementById(`integration-card-${scrollTarget}`)
    if (!card) return
    card.focus({ preventScroll: true })
    card.scrollIntoView?.({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      block: 'start',
    })
    setScrollTarget(null)
  }, [scrollTarget, catalog.data])
  const ready = !permissions.isLoading && !permissions.isError
  const visible = (catalog.data?.integrations ?? []).filter(
    (entry) => ready && permissions.can(`integrations:read:${entry.key}`)
  )
  const matches = visible
    .sort((left, right) => left.label.localeCompare(right.label))
    .filter((entry) =>
      `${entry.label} ${descriptions[entry.key] ?? entry.description}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    )
  return (
    <div className="space-y-6">
      <header>
        <h3 className="text-lg font-semibold text-primary">Integrations</h3>
        <p className="mt-1 text-sm text-muted">
          Connect the apps your squads use. Enable or disable them across Ficus without losing their settings.
        </p>
      </header>
      {permissions.identity?.type === 'user' && permissions.can('settings:read') && (
        <p className="text-sm text-muted">
          Taking Ficus with you?{' '}
          <Link to="/settings?section=mobile-pro" className="text-accent-light hover:underline">
            Manage mobile relay and Pro coverage →
          </Link>
        </p>
      )}
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
          <SearchIcon className="h-4 w-4" />
        </span>
        <input
          aria-label="Search integrations"
          placeholder="Search integrations…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="ficus-field w-full rounded-lg border border-panel-border bg-surface py-2.5 pl-10 pr-3 text-sm text-primary"
        />
      </div>
      {permissions.isLoading || catalog.isPending ? (
        <p className="text-sm text-muted">Loading integrations…</p>
      ) : permissions.isError || catalog.isError ? (
        <p role="alert" className="text-sm text-status-danger-500">
          Unable to check integration access. Please try again.
        </p>
      ) : visible.length === 0 ? (
        <p role="status" className="text-sm text-muted">
          You do not have permission to view global integrations.
        </p>
      ) : matches.length === 0 ? (
        <p role="status" className="text-sm text-muted">
          No integrations match “{search}”.
        </p>
      ) : (
        <div className="space-y-6">
          {[true, false].map((enabled) => {
            const group = matches.filter((entry) => (entry.enabled === true) === enabled)
            if (!group.length) return null
            return (
              <section
                key={String(enabled)}
                aria-label={enabled ? 'Enabled integrations' : 'Disabled integrations'}
                className="space-y-3"
              >
                <h4 className="text-sm font-medium text-secondary">
                  {enabled ? 'Enabled' : 'Disabled'} <span className="ml-1 text-muted">{group.length}</span>
                </h4>
                <div className="grid items-stretch gap-4 md:grid-cols-2">
                  {group.map((entry) => (
                    <IntegrationDirectoryCard
                      key={entry.key}
                      entry={entry}
                      onEnabled={() => setScrollTarget(entry.key)}
                      expanded={!!expandedKeys[entry.key]}
                      setExpanded={(expanded) => setExpandedKeys((current) => ({ ...current, [entry.key]: expanded }))}
                      canWrite={permissions.can(`integrations:write:${entry.key}`)}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
