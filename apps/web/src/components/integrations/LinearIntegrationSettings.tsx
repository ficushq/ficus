import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  configureIntegrationOAuthApp,
  createLinearIntegration,
  integrationAction,
  removeIntegration,
  replaceIntegrationCredential,
  configureLinearWebhook,
  startIntegrationAuthorization,
  type IntegrationConnection,
  type OAuthAppSettings,
} from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
import { integrationAuthorizationReturnPath } from '../../lib/integrationReturnPath'
import { rememberOAuthProviderHint } from '../../lib/oauthCallbackBootstrap'
import { integrationErrorMessage } from '../../lib/integrationErrorMessage'
import { ApiError } from '../../api/client'
import { Badge, type BadgeColor } from '../Badge'
import { ConfirmButton } from '../ConfirmButton'
import { OverflowMenu } from '../OverflowMenu'
import { ConnectionSquads } from './ConnectionSquads'

const field =
  'ficus-field w-full rounded-md border border-panel-border bg-surface-secondary px-3 py-2 text-sm text-primary'
const buttonSize = 'rounded-md px-3 py-2 text-sm disabled:opacity-50'
const button = `ficus-button ficus-button-secondary ${buttonSize}`
const primaryButton = `ficus-button ficus-button-primary ${buttonSize}`
const ghostButton = `ficus-button ficus-button-ghost ${buttonSize}`
const danger = 'text-sm text-status-danger-600 dark:text-status-danger-400'

export function LinearIntegrationSettings({ canWrite }: { canWrite: boolean }) {
  const client = useQueryClient()
  const pool = useQuery(integrationQueries.pool('linear'))
  const oauthApp = useQuery(integrationQueries.oauthApp('linear'))
  const refresh = () => client.invalidateQueries({ queryKey: integrationQueryKeys.all })
  const install = useLinearAppInstall()
  const connections = pool.data ?? []
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Ficus works in Linear as an agent app that people can delegate issues to and mention. Connect a workspace, then
        choose which squads use it here. Each squad chooses the Linear teams it handles in its own Integrations tab.
      </p>
      {pool.isPending ? (
        <p className="text-sm text-muted">Loading connections…</p>
      ) : pool.isError ? (
        <p role="alert" className={danger}>
          Unable to load Linear connections.
        </p>
      ) : (
        connections.length > 0 && (
          <section aria-labelledby="linear-connections">
            <h4 id="linear-connections" className="text-sm font-medium text-primary">
              Connections
            </h4>
            <ul className="mt-1 divide-y divide-panel-border border-b border-panel-border">
              {connections.map((connection) => (
                <LinearConnection
                  key={connection.id}
                  connection={connection}
                  connections={connections}
                  canWrite={canWrite}
                  refresh={refresh}
                  reconnect={() => install.mutate(connection.id)}
                  reconnecting={install.isPending}
                />
              ))}
            </ul>
          </section>
        )
      )}
      <LinearConnect
        canWrite={canWrite}
        settings={oauthApp.data}
        settingsError={oauthApp.isError}
        hasConnections={connections.length > 0}
        hasApp={connections.some((connection) => connection.configuration.mode === 'app')}
        install={install}
        refresh={refresh}
      />
      <LinearWebhookDelivery canWrite={canWrite} refresh={refresh} />
    </div>
  )
}

/** Linear-specific text for the codes an install or settings save can fail with. */
const LINEAR_APP_ERRORS: Record<string, string> = {
  broker_unconfigured:
    "Ficus's hosted Linear app isn't set up for this instance yet. Try again later, or connect with a personal API key.",
  oauth_app_unconfigured: 'Save the Linear application settings before installing the app.',
}

function linearAppErrorMessage(error: unknown): string {
  const payload =
    error instanceof ApiError && error.payload && typeof error.payload === 'object'
      ? (error.payload as Record<string, unknown>)
      : {}
  const code = typeof payload.code === 'string' ? payload.code : typeof payload.error === 'string' ? payload.error : ''
  return (
    (Object.hasOwn(LINEAR_APP_ERRORS, code) ? LINEAR_APP_ERRORS[code] : undefined) ??
    integrationErrorMessage(error, 'Linear app operation failed. Please try again.')
  )
}

/** Starts the Linear app install (or reconnects an app connection) and leaves for Linear's consent page. */
function useLinearAppInstall() {
  return useMutation({
    mutationFn: (connectionId?: string) =>
      startIntegrationAuthorization('linear', {
        returnTo: integrationAuthorizationReturnPath(),
        ...(connectionId ? { connectionId } : {}),
      }),
    onSuccess: (result) => {
      if ('authorizationUrl' in result) {
        rememberOAuthProviderHint('linear')
        window.location.assign(result.authorizationUrl)
      }
    },
  })
}

/**
 * Ways to add a connection: install the agent app (the recommended path, primary until a connection
 * exists) or add a personal API key (collapsed until asked for). A self-hosted instance also keeps
 * its own Linear application settings here.
 */
function LinearConnect({
  canWrite,
  settings,
  settingsError,
  hasConnections,
  hasApp,
  install,
  refresh,
}: {
  canWrite: boolean
  settings: OAuthAppSettings | undefined
  settingsError: boolean
  hasConnections: boolean
  hasApp: boolean
  install: ReturnType<typeof useLinearAppInstall>
  refresh: () => Promise<void>
}) {
  const [addingKey, setAddingKey] = useState(false)
  const local = settings?.authority === 'local'
  const canInstall = canWrite && !!settings?.configured
  const installLabel = hasApp ? 'Install in another workspace' : 'Install Ficus in Linear'
  return (
    <section aria-labelledby="linear-agent-app" className="space-y-3">
      <h4 id="linear-agent-app" className="text-sm font-medium text-primary">
        {hasConnections ? 'Add a connection' : 'Connect Linear'}
      </h4>
      {!hasConnections && (
        <p className="text-sm text-muted">
          Installing the agent app adds Ficus to your Linear workspace as its own member. A Linear workspace admin must
          approve it.
        </p>
      )}
      {settingsError ? (
        <p role="alert" className={danger}>
          Unable to load Linear app settings.
        </p>
      ) : !settings ? (
        <p className="text-sm text-muted">Loading Linear app settings…</p>
      ) : null}
      {!canWrite && local && !settings.configured && (
        <p className="text-sm text-muted">
          An administrator must save the Linear application settings before the app can be installed.
        </p>
      )}
      {local && canWrite && <LinearApplicationSettings settings={settings} refresh={refresh} />}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          {canInstall && (
            <button
              className={hasConnections ? button : primaryButton}
              type="button"
              disabled={install.isPending}
              onClick={() => install.mutate(undefined)}
            >
              {installLabel}
            </button>
          )}
          {!addingKey && (
            <button className={ghostButton} type="button" onClick={() => setAddingKey(true)}>
              {canInstall ? 'Use a personal API key instead' : 'Add a personal API key'}
            </button>
          )}
        </div>
      )}
      {install.isError && (
        <p role="alert" className={danger}>
          {linearAppErrorMessage(install.error)}
        </p>
      )}
      {canWrite && addingKey && <LinearApiKeyForm onClose={() => setAddingKey(false)} refresh={refresh} />}
    </section>
  )
}

/** A self-hosted instance's own Linear OAuth application: required before the first install, tucked away after. */
function LinearApplicationSettings({
  settings,
  refresh,
}: {
  settings: OAuthAppSettings
  refresh: () => Promise<void>
}) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [editing, setEditing] = useState(false)
  const configure = useMutation({
    mutationFn: () => {
      if (!acknowledged) throw new Error('Confirm the Linear application settings first.')
      return configureIntegrationOAuthApp('linear', {
        clientId,
        clientSecret,
        webhookSecret,
        capabilitiesAcknowledged: true,
      })
    },
    onSuccess: async () => {
      setClientId('')
      setAcknowledged(false)
      setEditing(false)
      await refresh()
    },
    // Secrets never outlive the request, whatever its outcome.
    onSettled: () => {
      setClientSecret('')
      setWebhookSecret('')
    },
  })
  const showForm = !settings.configured || editing
  const instructions = (
    <div className="space-y-2 text-sm">
      <p className="text-muted">
        Create an OAuth application in Linear’s API settings with this callback URL, turn on webhooks with this URL, and
        select Agent session events, Inbox notifications, Permission changes, Issues and Comments.
      </p>
      <p className="break-all">
        Callback URL: <code data-testid="linear-app-callback-url">{settings.callbackUrl}</code>
      </p>
      <p className="break-all">
        Webhook URL: <code data-testid="linear-app-webhook-url">{settings.webhookUrl ?? 'Unavailable'}</code>
      </p>
      {settings.configured && (
        <p>
          Linear application configured
          {settings.clientId ? (
            <>
              {' '}
              (client ID <code>{settings.clientId}</code>)
            </>
          ) : null}
          .
        </p>
      )}
    </div>
  )
  const form = showForm && (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        configure.mutate()
      }}
    >
      <label className="block text-sm">
        Client ID
        <input className={field} value={clientId} onChange={(event) => setClientId(event.target.value)} />
      </label>
      <label className="block text-sm">
        Client secret
        <input
          className={field}
          type="password"
          autoComplete="off"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Webhook signing secret
        <input
          className={field}
          type="password"
          autoComplete="off"
          value={webhookSecret}
          onChange={(event) => setWebhookSecret(event.target.value)}
        />
      </label>
      <label className="flex items-start gap-2 text-xs text-primary">
        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
        The Linear application uses the callback and webhook URLs above, with the listed webhook categories.
      </label>
      {settings.configured && (
        <p className="text-xs text-muted">
          App connections authorized by the previous application need Reconnect after the client ID changes.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className={primaryButton}
          type="submit"
          disabled={!clientId.trim() || !clientSecret || !webhookSecret || !acknowledged || configure.isPending}
        >
          Save Linear application
        </button>
        {editing && (
          <button className={button} type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </div>
      {configure.isError && (
        <p role="alert" className={danger}>
          {linearAppErrorMessage(configure.error)}
        </p>
      )}
    </form>
  )
  // Before the first save the settings are the next step, so they stay open.
  if (!settings.configured)
    return (
      <div className="space-y-3">
        {instructions}
        {form}
      </div>
    )
  return (
    <details className="text-sm" open={editing || undefined}>
      <summary className="cursor-pointer text-muted">Linear application settings</summary>
      <div className="mt-3 space-y-3">
        {instructions}
        {form ||
          (!editing && (
            <button className={button} type="button" onClick={() => setEditing(true)}>
              Replace application settings
            </button>
          ))}
      </div>
    </details>
  )
}

function LinearApiKeyForm({ onClose, refresh }: { onClose: () => void; refresh: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [credential, setCredential] = useState('')
  const create = useMutation({
    mutationFn: () => createLinearIntegration({ displayName: name, credential }),
    onSuccess: async () => {
      setName('')
      onClose()
      await refresh()
    },
    onSettled: () => setCredential(''),
  })
  return (
    <form
      aria-label="Add a personal API key"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        create.mutate()
      }}
    >
      <p className="pt-2 text-sm font-medium text-primary">Personal API key</p>
      <label className="block text-sm">
        Account name
        <input
          className={field}
          required
          placeholder="My Linear account"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={create.isPending}
        />
      </label>
      <label className="block text-sm">
        API key
        <input
          className={field}
          required
          type="password"
          autoComplete="off"
          placeholder="lin_api_…"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          disabled={create.isPending}
        />
      </label>
      <p className="text-xs text-muted">
        Create a key in Linear’s Security & Access settings. Give it read and write access to the teams you want Ficus
        to use: agents read, create, update and comment on issues with it. A personal key acts as you, so Ficus does not
        appear in Linear as its own member.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={create.isPending}>
          {create.isPending ? 'Connecting…' : 'Create and validate'}
        </button>
        <button className={ghostButton} type="button" disabled={create.isPending} onClick={onClose}>
          Cancel
        </button>
      </div>
      {create.isError && (
        <p role="alert" className={danger}>
          {create.error.message}
        </p>
      )}
    </form>
  )
}

function LinearWebhookDelivery({ canWrite, refresh }: { canWrite: boolean; refresh: () => Promise<void> }) {
  const webhook = useQuery(integrationQueries.linearWebhook())
  const [secret, setSecret] = useState('')
  const saveWebhook = useMutation({
    mutationFn: (value: string | null) => configureLinearWebhook(value),
    onSuccess: async () => {
      setSecret('')
      await refresh()
    },
  })
  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted">Webhook delivery</summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-muted">
          Create a webhook for issue updates in Linear’s API settings. Use the same signing secret here and in Linear.
        </p>
        {webhook.isError ? (
          <p role="alert">Unable to load webhook settings.</p>
        ) : (
          <>
            <p className="break-all">
              Webhook URL: <code>{webhook.data?.webhookUrl ?? 'Loading…'}</code>
            </p>
            <p>
              {webhook.data?.configured ? 'Webhooks enabled.' : 'Webhooks disabled. Save a secret to enable delivery.'}
            </p>
            {canWrite && (
              <>
                <label className="block">
                  Signing secret
                  <input
                    className={field}
                    type="password"
                    autoComplete="off"
                    placeholder={
                      webhook.data?.configured ? 'Enter a new secret to rotate' : 'Enter your Linear webhook secret'
                    }
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={button}
                    disabled={!secret.trim() || saveWebhook.isPending}
                    onClick={() => saveWebhook.mutate(secret)}
                  >
                    {webhook.data?.configured ? 'Save webhook secret' : 'Enable webhooks'}
                  </button>
                  {webhook.data?.configured && (
                    <ConfirmButton
                      label="Disable webhooks"
                      confirmLabel="Confirm disable"
                      disabled={saveWebhook.isPending}
                      onConfirm={() => saveWebhook.mutate(null)}
                      className={buttonSize}
                    />
                  )}
                </div>
              </>
            )}
          </>
        )}
        {saveWebhook.isError && <p role="alert">{saveWebhook.error.message}</p>}
      </div>
    </details>
  )
}

/** One status word for a connection, most urgent first. */
function connectionStatus(
  connection: IntegrationConnection,
  needsPermissions: boolean,
  claimed: boolean
): { label: string; color: BadgeColor } {
  if (!connection.enabled) return { label: 'Disabled', color: 'neutral' }
  if (connection.authState === 'reauthorization_required') return { label: 'Reconnect required', color: 'attention' }
  if (connection.authState === 'invalid') return { label: 'Invalid credentials', color: 'danger' }
  if (connection.authState === 'pending') return { label: 'Pending', color: 'neutral' }
  if (claimed) return { label: 'Not receiving events', color: 'attention' }
  if (needsPermissions) return { label: 'Needs permissions', color: 'attention' }
  if (connection.healthState === 'healthy') return { label: 'Healthy', color: 'success' }
  if (connection.healthState === 'degraded') return { label: 'Degraded', color: 'attention' }
  if (connection.healthState === 'unreachable') return { label: 'Unreachable', color: 'danger' }
  return { label: 'Not checked yet', color: 'neutral' }
}

function LinearConnection({
  connection,
  connections,
  canWrite,
  refresh,
  reconnect,
  reconnecting,
}: {
  connection: IntegrationConnection
  connections: readonly IntegrationConnection[]
  canWrite: boolean
  refresh: () => Promise<void>
  reconnect: () => void
  reconnecting: boolean
}) {
  const [credential, setCredential] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [confirming, setConfirming] = useState<'disable' | 'remove' | null>(null)
  const action = useMutation({
    mutationFn: (kind: 'validate' | 'enable' | 'disable') => integrationAction(connection.id, kind, kind === 'disable'),
    onSuccess: async () => {
      setConfirming(null)
      await refresh()
    },
  })
  const remove = useMutation({ mutationFn: () => removeIntegration(connection.id, true), onSuccess: refresh })
  const replace = useMutation({
    mutationFn: () => replaceIntegrationCredential(connection.id, credential, true),
    onSuccess: async () => {
      setCredential('')
      setReplacing(false)
      await refresh()
    },
  })
  const pending = action.isPending || remove.isPending || replace.isPending
  const app = connection.configuration.mode === 'app'
  const { organizationName, organizationUrlKey } = connection.configuration
  // App connections are named "<workspace> (Ficus app)"; the kind is shown on its own line.
  const title = app
    ? (organizationName ?? connection.displayName.replace(/ \(Ficus app\)$/, ''))
    : connection.displayName
  const claimed = connection.relaySubscribeErrorCode === 'linear_organization_claimed'
  const needsPermissions =
    app &&
    ((connection.configuration.missingScopes?.length ?? 0) > 0 || connection.lastErrorCode === 'insufficient_scope')
  const status = connectionStatus(connection, needsPermissions, claimed)
  const needsReconnect =
    app &&
    (needsPermissions ||
      claimed ||
      connection.authState === 'reauthorization_required' ||
      connection.authState === 'invalid')
  // At most one action stays outside the menu: the one that fixes what the status reports.
  const inline: 'enable' | 'reconnect' | null = !connection.enabled ? 'enable' : needsReconnect ? 'reconnect' : null
  const squadCount = connection.usage.squadCount
  const affected =
    squadCount > 0 ? ` ${squadCount} ${squadCount === 1 ? 'squad loses' : 'squads lose'} Linear access.` : ''
  return (
    <li className="py-4" aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="font-medium text-primary">{title}</p>
          <p className="text-xs text-muted">
            {app ? 'Agent app' : 'Personal API key'}
            {app && organizationUrlKey && <> · linear.app/{organizationUrlKey}</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge color={status.color}>{status.label}</Badge>
          {canWrite && inline === 'enable' && (
            <button className={button} type="button" disabled={pending} onClick={() => action.mutate('enable')}>
              Enable
            </button>
          )}
          {canWrite && inline === 'reconnect' && (
            <button className={button} type="button" disabled={pending || reconnecting} onClick={reconnect}>
              Reconnect
            </button>
          )}
          {canWrite && (
            <OverflowMenu label={`More actions for ${title}`} itemsMarker="data-linear-connection-actions">
              <button type="button" disabled={pending} onClick={() => action.mutate('validate')}>
                Validate
              </button>
              {app ? (
                inline !== 'reconnect' && (
                  <button type="button" disabled={pending || reconnecting} onClick={reconnect}>
                    Reconnect
                  </button>
                )
              ) : (
                <button type="button" disabled={pending} onClick={() => setReplacing(true)}>
                  Replace API key
                </button>
              )}
              {connection.enabled && (
                <button type="button" disabled={pending} onClick={() => setConfirming('disable')}>
                  Disable…
                </button>
              )}
              <button
                type="button"
                disabled={pending}
                className="text-status-danger-600 dark:text-status-danger-400"
                onClick={() => setConfirming('remove')}
              >
                Remove…
              </button>
            </OverflowMenu>
          )}
        </div>
      </div>
      {claimed && (
        <p role="alert" className={`mt-2 ${danger}`}>
          This Linear workspace is already connected to another Ficus Cloud instance. Ficus does not receive its events
          here. Disconnect it from the other instance, then select Reconnect.
        </p>
      )}
      {needsPermissions && (
        <p role="alert" className={`mt-2 ${danger}`}>
          Ficus needs new Linear permissions to acknowledge agent sessions, post progress and attach pull requests. A
          Linear workspace admin should select Reconnect and approve the updated permissions.
        </p>
      )}
      {canWrite && confirming && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-status-danger-surface px-3 py-2 text-sm text-status-danger-fg">
          <p className="min-w-0 flex-1">
            {confirming === 'remove'
              ? `Remove the ${title} connection?${affected}${app ? ' To remove the app from the workspace too, uninstall it in Linear.' : ''}`
              : `Disable the ${title} connection?${affected}`}
          </p>
          <button
            type="button"
            className="ficus-button ficus-button-danger rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={pending}
            onClick={() => (confirming === 'remove' ? remove.mutate() : action.mutate('disable'))}
          >
            {confirming === 'remove' ? 'Remove' : 'Disable'}
          </button>
          <button
            type="button"
            className="ficus-button ficus-button-ghost rounded-md px-3 py-1.5 text-sm"
            onClick={() => setConfirming(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {canWrite && !app && replacing && (
        <div className="mt-3 space-y-2">
          <label className="block text-sm">
            New API key
            <input
              type="password"
              autoComplete="off"
              className={field}
              placeholder="lin_api_…"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted">
            Replacing this key affects all assigned squads. Validate and enable the account afterward.
          </p>
          <div className="flex flex-wrap gap-2">
            <ConfirmButton
              label="Replace key"
              confirmLabel="Confirm replacement"
              disabled={pending || !credential.trim()}
              variant="secondary"
              className={buttonSize}
              onConfirm={() => replace.mutate()}
            />
            <button className={ghostButton} type="button" onClick={() => setReplacing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {(action.error || remove.error || replace.error) && (
        <p role="alert" className={`mt-2 ${danger}`}>
          {(action.error || remove.error || replace.error)?.message}
        </p>
      )}
      <ConnectionSquads
        provider="linear"
        providerLabel="Linear"
        connection={connection}
        connections={connections}
        noun={app ? 'workspace' : 'account'}
        nextStep="Next, open each squad and choose the Linear teams whose issues it handles (Integrations → Linear)."
      />
    </li>
  )
}
