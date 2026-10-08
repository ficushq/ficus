import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createLinearIntegration,
  integrationAction,
  removeIntegration,
  replaceIntegrationCredential,
  configureLinearWebhook,
} from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
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
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Connect a Linear account using a personal API key, then choose which squads can use it. Team routing is
        configured in each squad’s Integrations tab.
      </p>
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
            enabled={connection.enabled}
            health={connection.authState === 'authenticated' ? connection.healthState : connection.authState}
            canWrite={canWrite}
            refresh={refresh}
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
          <h4 className="font-medium text-primary">Add account</h4>
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
            Create a key in Linear’s Security & Access settings. Give it read access to the teams you want Ficus to use.
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

function LinearAccount({
  id,
  name,
  enabled,
  health,
  canWrite,
  refresh,
}: {
  id: string
  name: string
  enabled: boolean
  health: string
  canWrite: boolean
  refresh: () => Promise<void>
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
        <span className="font-medium">{name}</span>
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
          <button className={button} disabled={pending} onClick={() => setReplacing(!replacing)}>
            Replace API key
          </button>
          <ConfirmButton
            label="Remove"
            confirmLabel="Remove from all squads"
            disabled={pending}
            className={buttonSize}
            onConfirm={() => remove.mutate()}
          />
        </div>
      )}
      {canWrite && replacing && (
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
