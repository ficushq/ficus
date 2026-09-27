import { useEffect, useState } from 'react'
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
  useEffect(() => {
    if (!canWrite) {
      setClientSecret('')
      setCapabilitiesAcknowledged(false)
    }
  }, [canWrite])
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
          <span data-testid="notion-callback-url" className="break-all [overflow-wrap:anywhere]">
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
            className="ficus-button"
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
      <div className="mt-3 space-y-2">
        {(pool.data ?? []).map((connection) => {
          const reconnect = connection.authState === 'reauthorization_required'
          const runLifecycle = (action: 'enable' | 'disable' | 'refresh' | 'remove') => {
            const destructive = action === 'disable' || action === 'remove'
            if (
              destructive &&
              connection.usage.squadCount > 0 &&
              (confirmation?.id !== connection.id || confirmation.action !== action)
            ) {
              setConfirmation({ id: connection.id, action })
              return
            }
            lifecycle.mutate({ id: connection.id, action, assigned: destructive && connection.usage.squadCount > 0 })
          }
          return (
            <div key={connection.id} className="border-b border-panel-border py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {connection.configuration.workspaceIcon && (
                    <img
                      src={connection.configuration.workspaceIcon}
                      alt=""
                      className="h-6 w-6 rounded"
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <div>
                    <div className="text-sm font-medium">
                      {connection.configuration.workspaceName ?? connection.displayName}
                    </div>
                    <div className="text-xs text-muted">
                      {reconnect
                        ? 'Reconnect required'
                        : `${connection.enabled ? 'Enabled' : 'Disabled'} · ${connection.healthState}`}
                    </div>
                    <div className="text-xs text-muted">Used by {connection.usage.squadCount} squads</div>
                  </div>
                </div>
                {canWrite && (
                  <div className="flex flex-wrap gap-1">
                    <button className="ficus-button" type="button" onClick={() => authorize.mutate(connection.id)}>
                      Reconnect
                    </button>
                    {!reconnect && connection.enabled && connection.refreshAvailable && (
                      <button className="ficus-button" type="button" onClick={() => runLifecycle('refresh')}>
                        Refresh
                      </button>
                    )}
                    <button
                      className="ficus-button"
                      type="button"
                      onClick={() => runLifecycle(connection.enabled ? 'disable' : 'enable')}
                    >
                      {confirmation?.id === connection.id && confirmation.action === 'disable'
                        ? `Confirm disable for ${connection.usage.squadCount} squads`
                        : connection.enabled
                          ? 'Disable'
                          : 'Enable'}
                    </button>
                    <button className="ficus-button" type="button" onClick={() => runLifecycle('remove')}>
                      {confirmation?.id === connection.id && confirmation.action === 'remove'
                        ? `Confirm remove from ${connection.usage.squadCount} squads`
                        : 'Remove'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {canWrite && settings?.configured && (
        <button
          type="button"
          className="ficus-button ficus-button-primary mt-3 rounded bg-accent px-3 py-2 text-sm text-on-accent"
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
