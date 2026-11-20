import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  configureIntegrationOAuthApp,
  integrationAction,
  refreshIntegration,
  removeIntegration,
  startIntegrationAuthorization,
} from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationAuthorizationReturnPath } from '../../lib/integrationReturnPath'
import { rememberOAuthProviderHint } from '../../lib/oauthCallbackBootstrap'
import { integrationQueryKeys } from '../../queryKeys'
import { useAdjustOnChange } from '../../hooks/useAdjustOnChange'
import { ConnectionSquads } from './ConnectionSquads'
import { ConnectionList, ConnectionRow } from './ConnectionRow'
import { connectionConfirmQuestion, connectionStatus } from './connectionStatus'

export function NotionIntegrationSettings({
  canRead,
  canWrite,
  embedded = false,
}: {
  canRead: boolean
  canWrite: boolean
  embedded?: boolean
}) {
  const client = useQueryClient()
  const pool = useQuery({ ...integrationQueries.pool('notion'), enabled: canRead })
  const oauthApp = useQuery({ ...integrationQueries.oauthApp('notion'), enabled: canRead })
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [capabilitiesAcknowledged, setCapabilitiesAcknowledged] = useState(false)
  const [confirmation, setConfirmation] = useState<{ id: string; action: 'disable' | 'remove' } | null>(null)
  const refresh = () => client.invalidateQueries({ queryKey: integrationQueryKeys.all })
  const configure = useMutation({
    mutationFn: () => {
      if (!capabilitiesAcknowledged) throw new Error('Capability acknowledgement required')
      return configureIntegrationOAuthApp('notion', { clientId, clientSecret, capabilitiesAcknowledged })
    },
    onSuccess: async () => {
      setCapabilitiesAcknowledged(false)
      await refresh()
    },
    onSettled: () => setClientSecret(''),
  })
  // Losing write access clears the secret and the acknowledgement, while rendering.
  useAdjustOnChange([canWrite], () => {
    if (!canWrite) {
      setClientSecret('')
      setCapabilitiesAcknowledged(false)
    }
  })
  const authorize = useMutation({
    mutationFn: (connectionId?: string) =>
      startIntegrationAuthorization('notion', {
        returnTo: integrationAuthorizationReturnPath(),
        ...(connectionId ? { connectionId } : {}),
      }),
    onSuccess: (result) => {
      if ('authorizationUrl' in result) {
        rememberOAuthProviderHint('notion')
        window.location.assign(result.authorizationUrl)
      }
    },
  })
  const lifecycle = useMutation({
    mutationFn: async (input: {
      id: string
      action: 'enable' | 'disable' | 'refresh' | 'remove'
      assigned: boolean
    }) => {
      if (input.action === 'refresh') return refreshIntegration(input.id)
      if (input.action === 'remove') return removeIntegration(input.id, input.assigned)
      return integrationAction(input.id, input.action, input.assigned)
    },
    onSuccess: async () => {
      setConfirmation(null)
      await refresh()
    },
  })
  if (!canRead) return null
  const settings = oauthApp.data
  return (
    <section className={embedded ? undefined : 'border-b border-panel-border py-5'}>
      {!embedded && <h3 className="text-sm font-medium text-primary">Notion</h3>}
      {oauthApp.isError ? (
        <div className="mt-1 text-xs text-status-danger-600">
          <p role="alert">Notion integration settings could not be loaded.</p>
          <button
            type="button"
            className="mt-2 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            onClick={() => void oauthApp.refetch()}
          >
            Try again
          </button>
        </div>
      ) : !settings ? (
        <p className="mt-1 text-xs text-muted">Loading Notion integration settings…</p>
      ) : settings.authority === 'platform_broker' ? (
        <p className="mt-1 text-xs text-muted">Connect a workspace securely with Notion OAuth.</p>
      ) : (
        <p className="mt-1 text-xs text-muted">
          Connect a workspace with OAuth. In the Notion Developer Portal enable Read content, Insert content, and Update
          content, then use this callback URL:{' '}
          <span data-testid="notion-callback-url" className="break-all wrap-anywhere">
            {settings?.callbackUrl ?? 'Loading…'}
          </span>
        </p>
      )}
      {settings?.authority === 'local' && !settings.configured && canWrite && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            configure.mutate()
          }}
        >
          <input
            className="ficus-field"
            aria-label="Notion OAuth client ID"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <input
            className="ficus-field"
            aria-label="Notion OAuth client secret"
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
          <label className="flex items-start gap-2 text-xs text-primary">
            <input
              type="checkbox"
              checked={capabilitiesAcknowledged}
              onChange={(event) => setCapabilitiesAcknowledged(event.target.checked)}
            />
            I configured Read content, Insert content, and Update content in the Notion Developer Portal.
          </label>
          <button
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm disabled:opacity-50"
            type="submit"
            disabled={!clientId || !clientSecret || !capabilitiesAcknowledged || configure.isPending}
          >
            Save OAuth application and acknowledge capabilities
          </button>
        </form>
      )}
      {settings?.authority === 'local' && settings.configured && (
        <p className="mt-2 text-xs text-muted">OAuth application configured.</p>
      )}
      {pool.isError && <p role="alert">Unable to load Notion connections.</p>}
      {(pool.data?.length ?? 0) > 0 && (
        <ConnectionList className="mt-3">
          {(pool.data ?? []).map((connection) => {
            const title = connection.configuration.workspaceName ?? connection.displayName
            const reconnect = connection.authState === 'reauthorization_required'
            // At most one action stays outside the menu: the one that fixes what the status reports.
            const inline = !connection.enabled ? 'enable' : reconnect ? 'reconnect' : null
            const squadCount = connection.usage.squadCount
            const confirming = confirmation?.id === connection.id ? confirmation.action : null
            const run = (action: 'enable' | 'disable' | 'refresh' | 'remove') =>
              lifecycle.mutate({
                id: connection.id,
                action,
                assigned: (action === 'disable' || action === 'remove') && squadCount > 0,
              })
            return (
              <ConnectionRow
                key={connection.id}
                title={title}
                leading={
                  connection.configuration.workspaceIcon && (
                    <img
                      src={connection.configuration.workspaceIcon}
                      alt=""
                      className="mt-0.5 h-6 w-6 shrink-0 rounded"
                      referrerPolicy="no-referrer"
                    />
                  )
                }
                status={connectionStatus(connection)}
                inline={
                  !canWrite || !inline
                    ? null
                    : inline === 'enable'
                      ? { label: 'Enable', disabled: lifecycle.isPending, onClick: () => run('enable') }
                      : {
                          label: 'Reconnect',
                          disabled: authorize.isPending,
                          onClick: () => authorize.mutate(connection.id),
                        }
                }
                menu={
                  canWrite
                    ? [
                        inline !== 'reconnect' && {
                          label: 'Reconnect',
                          disabled: authorize.isPending,
                          onSelect: () => authorize.mutate(connection.id),
                        },
                        !reconnect &&
                          connection.enabled &&
                          connection.refreshAvailable && {
                            label: 'Refresh',
                            disabled: lifecycle.isPending,
                            onSelect: () => run('refresh'),
                          },
                        connection.enabled && {
                          label: 'Disable…',
                          disabled: lifecycle.isPending,
                          onSelect: () => setConfirmation({ id: connection.id, action: 'disable' }),
                        },
                        {
                          label: 'Remove…',
                          danger: true,
                          disabled: lifecycle.isPending,
                          onSelect: () => setConfirmation({ id: connection.id, action: 'remove' }),
                        },
                      ]
                    : []
                }
                confirmation={
                  canWrite && confirming
                    ? {
                        message: connectionConfirmQuestion(confirming, title, squadCount, 'Notion'),
                        confirmLabel: confirming === 'remove' ? 'Remove' : 'Disable',
                        disabled: lifecycle.isPending,
                        onConfirm: () => run(confirming),
                        onCancel: () => setConfirmation(null),
                      }
                    : null
                }
              >
                <ConnectionSquads
                  provider="notion"
                  providerLabel="Notion"
                  connection={connection}
                  connections={pool.data ?? []}
                  noun="workspace"
                />
              </ConnectionRow>
            )
          })}
        </ConnectionList>
      )}
      {canWrite && settings?.configured && (
        <button
          type="button"
          className="ficus-button ficus-button-primary mt-3 rounded px-3 py-2 text-sm"
          disabled={authorize.isPending}
          onClick={() => authorize.mutate(undefined)}
        >
          Connect Notion
        </button>
      )}
      {(authorize.isError || lifecycle.isError || configure.isError) && (
        <p role="alert" className="mt-2 text-sm text-status-danger-600">
          Notion operation failed. Please try again.
        </p>
      )}
    </section>
  )
}
