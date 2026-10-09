import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  configureChannelIntegration,
  removeIntegration,
  slackAppManifestUrl,
  startIntegrationAuthorization,
  type ChannelIntegrationSettings as View,
} from '../../api/integrations'
import { usePermissions } from '../../hooks/usePermissions'
import { integrationQueries, queries } from '../../queryOptions'
import { integrationQueryKeys, queryKeys } from '../../queryKeys'
import { ProviderChannelRouting } from './ProviderChannelRouting'
import type { ProviderId } from '../settings/channelFormHelpers'
import { useSquadsApi } from '../settings/squadsApi'
import { IntegrationCredentialSettings } from './IntegrationCredentialSettings'
import { integrationAuthorizationReturnPath } from '../../lib/integrationReturnPath'
import { rememberOAuthProviderHint } from '../../lib/oauthCallbackBootstrap'
import { integrationErrorMessage } from '../../lib/integrationErrorMessage'

const identityLabels: Record<string, string> = {
  botId: 'Bot ID',
  username: 'Bot username',
  teamId: 'Workspace ID',
  teamName: 'Workspace',
  botUserId: 'Bot user ID',
  applicationId: 'Application ID',
  publicKey: 'Public key',
  guildId: 'Server ID',
}

const providerHints: Record<ProviderId, { where: string; what: string }> = {
  telegram: {
    where: 'Message @BotFather, send /newbot, and paste the token it gives you.',
    what: 'Ficus registers the webhook with Telegram itself — no secrets to generate, no URLs to paste.',
  },
  slack: {
    where:
      'Create the app from the manifest below, install it to your workspace, then paste the bot token and signing secret from its settings.',
    what: 'The manifest already carries this instance’s URLs; commands and events reach Ficus as soon as the app is installed.',
  },
  discord: {
    where: 'In the Discord Developer Portal create an application, reset its bot token, and paste it here.',
    what: 'Ficus discovers the application and its public key, registers the /ficus commands, and connects the gateway. Slash commands work through the gateway. Optionally set the Interactions Endpoint URL below for HTTP delivery.',
  },
}

export function ChannelIntegrationSettings({ provider, canWrite }: { provider: ProviderId; canWrite: boolean }) {
  const permissions = usePermissions()
  const client = useQueryClient()
  const view = useQuery(integrationQueries.credentialSettings(provider, 'channel'))
  const { listSquads } = useSquadsApi()
  const { data: squads = [] } = useQuery({ ...queries.squads.list(), queryFn: () => listSquads() })
  const data = view.data as View | undefined
  const [guildId, setGuildId] = useState('')
  useEffect(() => setGuildId(data?.identity?.guildId ?? ''), [data?.identity?.guildId])
  const [authError, setAuthError] = useState('')
  const [disconnectArmed, setDisconnectArmed] = useState(false)

  const invalidate = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: integrationQueryKeys.all }),
      client.invalidateQueries({ queryKey: queryKeys.channelInstances.all }),
    ])
  const setRouting = useMutation({
    mutationFn: (input: Record<string, string | null>) => configureChannelIntegration(provider, input),
    onSuccess: () => invalidate(),
  })

  const managedApp = provider === 'slack' ? data?.managedApp : undefined
  const managedAvailable = !!managedApp?.available
  const managedConnection = managedApp?.connection ?? null
  const managedActive = !!managedApp?.active
  const managedReconnectNeeded =
    !!managedConnection &&
    (managedConnection.authState === 'reauthorization_required' || managedConnection.authState === 'invalid')
  const authorizeManaged = useMutation({
    mutationFn: (connectionId?: string) =>
      startIntegrationAuthorization('slack', {
        returnTo: integrationAuthorizationReturnPath(),
        ...(connectionId ? { connectionId } : {}),
      }),
    onMutate: () => setAuthError(''),
    onSuccess: (result) => {
      if ('authorizationUrl' in result) {
        rememberOAuthProviderHint('slack')
        window.location.assign(result.authorizationUrl)
      }
    },
    onError: (failure) => setAuthError(integrationErrorMessage(failure, "Couldn't start Slack login.")),
  })
  const disconnectManaged = useMutation({
    mutationFn: (connectionId: string) => removeIntegration(connectionId),
    onMutate: () => setDisconnectArmed(false),
    onSuccess: () => invalidate(),
  })

  const hint = providerHints[provider]
  const connected = data?.connection?.source === 'connection' && data.connection.authState === 'authenticated'
  // `routable` follows whichever connection is active (a usable managed Slack
  // connection wins over the manual one). Choosing a squad is what creates the
  // channel instance, so the picker must show before `routing` exists.
  const routingReady = !!data?.routing || !!data?.routable

  const manualSetupSection = (
    <>
      <div className="space-y-1 text-sm">
        <p className="text-muted">{hint.where}</p>
        <p className="text-muted">{hint.what}</p>
        {provider === 'slack' && (
          <a className="text-accent underline" href={slackAppManifestUrl} download="ficus-slack-app-manifest.yaml">
            Download the Slack app manifest for this instance
          </a>
        )}
      </div>

      {managedActive && (
        <p className="text-sm text-muted">
          Ficus's Slack app is connected and handling messages. Your own app's credentials are kept but unused while
          it's connected. Turn off your own app's event subscriptions and slash command while Ficus's app is connected —
          Slack will still send it signed requests, and they'll be rejected.
        </p>
      )}

      <IntegrationCredentialSettings provider={provider} canWrite={canWrite} />

      {data && (
        <section className="space-y-3 text-sm" aria-label="Connection status">
          <h4 className="font-medium text-primary">Connection</h4>
          {data.setup?.state === 'needs_attention' ? (
            <p role="alert" className="text-status-danger-600 dark:text-status-danger-400">
              {data.setup.issues.join(' ')}
            </p>
          ) : data.setup?.state === 'needs_setup' ? (
            <p className="text-muted">Save the credential above to connect.</p>
          ) : (
            <p className="text-muted">
              {connected ? 'Connected and validated.' : 'Configured from environment secrets.'}
              {data.enabled === false && ' The provider is switched off; credentials are kept.'}
            </p>
          )}
          {data.identity && Object.keys(data.identity).length > 0 && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              {Object.entries(data.identity)
                .filter(([key]) => key !== 'publicKey')
                .map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-muted">{identityLabels[key] ?? key}</dt>
                    <dd className="font-mono text-primary break-all">{value}</dd>
                  </div>
                ))}
            </dl>
          )}
          {data.webhook && provider !== 'telegram' && (
            <div>
              <div className="text-muted">
                {provider === 'discord' ? 'Interactions Endpoint URL' : 'Request URL (slash commands and events)'}
              </div>
              {data.webhook.delivery === 'relay' ? (
                <p className="text-muted">Events arrive through Ficus Cloud while the Ficus Slack app is connected.</p>
              ) : (
                <code className="block font-mono text-xs text-primary break-all select-all">{data.webhook.url}</code>
              )}
            </div>
          )}
        </section>
      )}
    </>
  )

  return (
    <div className="space-y-6">
      {provider === 'slack' && managedAvailable && (
        <section className="space-y-3 text-sm" aria-label="Ficus Slack app">
          <h4 className="font-medium text-primary">Ficus Slack app</h4>
          {!managedConnection ? (
            <>
              <p className="text-muted">
                Connect Ficus's Slack app to your workspace — no app to create, no secrets to paste.
              </p>
              {canWrite && (
                <button
                  type="button"
                  className="ficus-button ficus-button-primary px-3 py-2 text-sm"
                  disabled={authorizeManaged.isPending}
                  onClick={() => authorizeManaged.mutate(undefined)}
                >
                  Add to Slack
                </button>
              )}
            </>
          ) : (
            <>
              <div>
                <p className="text-sm font-medium text-primary">
                  {managedConnection.teamName ?? managedConnection.teamId ?? 'Slack workspace'}
                </p>
                <p className="text-xs text-muted">
                  {managedConnection.teamId && `${managedConnection.teamId} · `}
                  {managedConnection.authState === 'authenticated'
                    ? managedConnection.healthState
                    : 'Reconnect required'}
                  {managedConnection.lastErrorCode && ` (${managedConnection.lastErrorCode})`}
                </p>
              </div>
              {canWrite && (
                <div className="flex flex-wrap gap-2">
                  {managedReconnectNeeded && (
                    <button
                      type="button"
                      className="ficus-button ficus-button-secondary px-2.5 py-1 disabled:opacity-50 text-xs"
                      disabled={authorizeManaged.isPending}
                      onClick={() => authorizeManaged.mutate(managedConnection.id)}
                    >
                      Reconnect
                    </button>
                  )}
                  <button
                    type="button"
                    className="ficus-button ficus-button-danger px-2.5 py-1 disabled:opacity-50 text-xs"
                    disabled={disconnectManaged.isPending}
                    onClick={() => {
                      if (!disconnectArmed) {
                        setDisconnectArmed(true)
                        return
                      }
                      disconnectManaged.mutate(managedConnection.id)
                    }}
                  >
                    {disconnectArmed ? 'Confirm disconnect' : 'Disconnect'}
                  </button>
                </div>
              )}
            </>
          )}
          {authError && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p role="alert" className="text-status-danger-600 dark:text-status-danger-400">
                {authError}
              </p>
              {canWrite && (
                <button
                  type="button"
                  className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs"
                  disabled={authorizeManaged.isPending}
                  onClick={() => authorizeManaged.mutate(authorizeManaged.variables)}
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {disconnectManaged.isError && (
            <p role="alert" className="text-status-danger-600 dark:text-status-danger-400">
              {disconnectManaged.error.message}
            </p>
          )}
        </section>
      )}

      {provider === 'slack' && managedAvailable ? (
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm font-medium text-primary">Use your own Slack app</summary>
          <div className="mt-3 space-y-6">{manualSetupSection}</div>
        </details>
      ) : (
        manualSetupSection
      )}

      {data && (
        <section className="space-y-3 text-sm" aria-label="Default squad">
          <h4 className="font-medium text-primary">Default squad</h4>
          {provider === 'discord' && data.guilds && data.guilds.length > 1 && (
            <div className="space-y-1">
              <label htmlFor={`${provider}-guild`} className="block text-muted">
                Server the bot answers in
              </label>
              <select
                id={`${provider}-guild`}
                className="ficus-field w-full text-sm bg-surface-secondary border border-th-border rounded px-2 py-1 text-primary"
                value={guildId}
                disabled={!canWrite || setRouting.isPending}
                onChange={(event) => {
                  setGuildId(event.target.value)
                  setRouting.mutate({ guildId: event.target.value || null })
                }}
              >
                <option value="">Choose a server…</option>
                {data.guilds.map((guild) => (
                  <option key={guild.id} value={guild.id}>
                    {guild.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {provider === 'discord' && data.guilds && data.guilds.length === 0 && (
            <p className="text-muted">Invite the bot to a server first; it will appear here.</p>
          )}
          {routingReady ? (
            <div className="space-y-1">
              <label htmlFor={`${provider}-default-squad`} className="block text-muted">
                Messages go to this squad unless a routing override below matches
              </label>
              <select
                id={`${provider}-default-squad`}
                className="ficus-field w-full text-sm bg-surface-secondary border border-th-border rounded px-2 py-1 text-primary"
                value={data.routing?.defaultSquadId ?? ''}
                disabled={!canWrite || setRouting.isPending}
                onChange={(event) => setRouting.mutate({ defaultSquadId: event.target.value || null })}
              >
                <option value="">None</option>
                {squads.map((squad) => (
                  <option key={squad.id} value={squad.id}>
                    {squad.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            data.setup?.state === 'configured' &&
            provider === 'discord' && <p className="text-muted">Choose the server above to pick a default squad.</p>
          )}
          {setRouting.isError && (
            <p role="alert" className="text-status-danger-600 dark:text-status-danger-400">
              {setRouting.error.message}
            </p>
          )}
        </section>
      )}

      {!permissions.isLoading && !permissions.isError && permissions.can('channels:read') && data?.routing && (
        <ProviderChannelRouting
          provider={provider}
          instanceId={data.routing.instanceId}
          canWrite={permissions.can('channels:update')}
        />
      )}
    </div>
  )
}
