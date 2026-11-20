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
} from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
import { integrationAuthorizationReturnPath } from '../../lib/integrationReturnPath'
import { rememberOAuthProviderHint } from '../../lib/oauthCallbackBootstrap'
import { ConfirmButton } from '../ConfirmButton'

const field =
  'ficus-field w-full rounded-md border border-panel-border bg-surface-secondary px-3 py-2 text-sm text-primary'
const buttonSize = 'rounded-md px-3 py-2 text-sm disabled:opacity-50'
const button = `ficus-button ficus-button-secondary ${buttonSize}`
const primaryButton = `ficus-button ficus-button-primary ${buttonSize}`
export function LinearIntegrationSettings({ canWrite }: { canWrite: boolean }) {
  const client = useQueryClient()
  const pool = useQuery(integrationQueries.pool('linear'))
  const webhook = useQuery(integrationQueries.linearWebhook())
  const [name, setName] = useState('')
  const [credential, setCredential] = useState('')
  const [secret, setSecret] = useState('')
  const refresh = () => client.invalidateQueries({ queryKey: integrationQueryKeys.all })
  const create = useMutation({
    mutationFn: () => createLinearIntegration({ displayName: name, credential }),
    onSuccess: async () => {
      setCredential('')
      setName('')
      await refresh()
    },
  })
  const saveWebhook = useMutation({
    mutationFn: (value: string | null) => configureLinearWebhook(value),
    onSuccess: async () => {
      setSecret('')
      await refresh()
    },
  })
  const install = useLinearAppInstall()
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Install Ficus in Linear as an agent app, or connect an account with a personal API key, then choose which squads
        can use it. Team routing is configured in each squad’s Integrations tab.
      </p>
      <LinearAgentApp canWrite={canWrite} install={install} refresh={refresh} />
      {pool.isPending ? (
        <p>Loading connections…</p>
      ) : pool.isError ? (
        <p role="alert">Unable to load Linear connections.</p>
      ) : (
        pool.data?.map((connection) => (
          <LinearAccount
            key={connection.id}
            id={connection.id}
            name={connection.displayName}
            app={connection.configuration.mode === 'app'}
            enabled={connection.enabled}
            health={connection.authState === 'authenticated' ? connection.healthState : connection.authState}
            canWrite={canWrite}
            refresh={refresh}
            reconnect={() => install.mutate(connection.id)}
          />
        ))
      )}
      {canWrite && (
        <form
          className="space-y-3 border-t border-panel-border pt-4"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <h4 className="font-medium text-primary">Add an API-key account</h4>
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
            Create a key in Linear’s Security & Access settings. Give it read and write access to the teams you want
            Ficus to use: agents read, create, update and comment on issues with it.
          </p>
          <button className={primaryButton} disabled={create.isPending}>
            {create.isPending ? 'Connecting…' : 'Create and validate'}
          </button>
          {create.isError && (
            <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
              {create.error.message}
            </p>
          )}
        </form>
      )}
      <details className="border-t border-panel-border pt-4">
        <summary className="cursor-pointer text-sm font-medium">Webhook delivery</summary>
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
                {webhook.data?.configured
                  ? 'Webhooks enabled.'
                  : 'Webhooks disabled. Save a secret to enable delivery.'}
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
                      className={primaryButton}
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
    </div>
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

function LinearAgentApp({
  canWrite,
  install,
  refresh,
}: {
  canWrite: boolean
  install: ReturnType<typeof useLinearAppInstall>
  refresh: () => Promise<void>
}) {
  const oauthApp = useQuery(integrationQueries.oauthApp('linear'))
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
  const settings = oauthApp.data
  const showForm = canWrite && settings?.authority === 'local' && (!settings.configured || editing)
  return (
    <section aria-labelledby="linear-agent-app" className="space-y-3 rounded-lg border border-panel-border p-4">
      <h4 id="linear-agent-app" className="font-medium text-primary">
        Agent app
      </h4>
      <p className="text-sm text-muted">
        The agent app appears in Linear as its own member, so people can delegate issues to Ficus and mention it.
        Installing it needs a Linear workspace admin.
      </p>
      {oauthApp.isError ? (
        <p role="alert">Unable to load Linear app settings.</p>
      ) : !settings ? (
        <p className="text-sm text-muted">Loading Linear app settings…</p>
      ) : settings.authority === 'local' ? (
        <div className="space-y-2 text-sm">
          <p className="text-muted">
            Create an OAuth application in Linear’s API settings with this callback URL, turn on webhooks with this URL,
            and select Agent session events, Inbox notifications, Permission changes, Issues and Comments.
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
      ) : null}
      {showForm && (
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
          {settings?.configured && (
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
        </form>
      )}
      {canWrite && settings?.configured && (
        <div className="flex flex-wrap gap-2">
          <button
            className={primaryButton}
            type="button"
            disabled={install.isPending}
            onClick={() => install.mutate(undefined)}
          >
            Install Ficus in Linear
          </button>
          {settings.authority === 'local' && !editing && (
            <button className={button} type="button" onClick={() => setEditing(true)}>
              Replace application settings
            </button>
          )}
        </div>
      )}
      {(configure.isError || install.isError) && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          Linear app operation failed. Please try again.
        </p>
      )}
    </section>
  )
}

function LinearAccount({
  id,
  name,
  app,
  enabled,
  health,
  canWrite,
  refresh,
  reconnect,
}: {
  id: string
  name: string
  /** An agent app connection: reconnect through Linear instead of replacing a key. */
  app: boolean
  enabled: boolean
  health: string
  canWrite: boolean
  refresh: () => Promise<void>
  reconnect: () => void
}) {
  const [credential, setCredential] = useState('')
  const [replacing, setReplacing] = useState(false)
  const action = useMutation({
    mutationFn: (kind: 'validate' | 'enable' | 'disable') => integrationAction(id, kind, kind === 'disable'),
    onSuccess: refresh,
  })
  const remove = useMutation({ mutationFn: () => removeIntegration(id, true), onSuccess: refresh })
  const replace = useMutation({
    mutationFn: () => replaceIntegrationCredential(id, credential, true),
    onSuccess: async () => {
      setCredential('')
      setReplacing(false)
      await refresh()
    },
  })
  const pending = action.isPending || remove.isPending || replace.isPending
  return (
    <article className="space-y-3 rounded-lg border border-panel-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {name}
          {app && <span className="ml-2 text-xs font-normal text-muted">Agent app</span>}
        </span>
        <span className="text-xs text-muted">
          {enabled ? 'Enabled' : 'Disabled'} · {health}
        </span>
      </div>
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={pending} onClick={() => action.mutate('validate')}>
            Validate
          </button>
          {enabled ? (
            <ConfirmButton
              label="Disable account"
              confirmLabel="Disable for all squads"
              disabled={pending}
              className={buttonSize}
              onConfirm={() => action.mutate('disable')}
            />
          ) : (
            <button className={button} disabled={pending} onClick={() => action.mutate('enable')}>
              Enable account
            </button>
          )}
          {app ? (
            <button className={button} disabled={pending} onClick={reconnect}>
              Reconnect
            </button>
          ) : (
            <button className={button} disabled={pending} onClick={() => setReplacing(!replacing)}>
              Replace API key
            </button>
          )}
          <ConfirmButton
            label="Remove"
            confirmLabel="Remove from all squads"
            disabled={pending}
            className={buttonSize}
            onConfirm={() => remove.mutate()}
          />
        </div>
      )}
      {canWrite && !app && replacing && (
        <div className="space-y-2">
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
          <ConfirmButton
            label="Replace key"
            confirmLabel="Confirm replacement"
            disabled={pending || !credential.trim()}
            variant="secondary"
            className={buttonSize}
            onConfirm={() => replace.mutate()}
          />
        </div>
      )}
      {(action.error || remove.error || replace.error) && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {(action.error || remove.error || replace.error)?.message}
        </p>
      )}
    </article>
  )
}
