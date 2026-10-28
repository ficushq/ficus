import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DeploymentIntegrationKey } from '@ficus/shared'
import {
  createDeploymentIntegration,
  integrationAction,
  removeIntegration,
  replaceIntegrationCredential,
  setIntegrationDefault,
  type IntegrationConnection,
} from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
import { ConfirmButton } from '../ConfirmButton'

const field =
  'ficus-field w-full rounded-md border border-panel-border bg-surface-secondary px-3 py-2 text-sm text-primary'
const button = 'ficus-button ficus-button-secondary rounded-md px-3 py-2 text-sm disabled:opacity-50'

export function DeploymentIntegrationSettings({
  provider,
  label,
  canWrite,
}: {
  provider: DeploymentIntegrationKey
  label: string
  canWrite: boolean
}) {
  const client = useQueryClient()
  const pool = useQuery(integrationQueries.pool(provider))
  const [name, setName] = useState('')
  const [credential, setCredential] = useState('')
  const [accountId, setAccountId] = useState('')
  const refresh = () => client.invalidateQueries({ queryKey: integrationQueryKeys.all })
  const create = useMutation({
    mutationFn: () =>
      createDeploymentIntegration(provider, {
        displayName: name,
        credential,
        configuration: {
          version: 1,
          ...(provider === 'cloudflare' && accountId.trim() ? { accountId: accountId.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      setName('')
      setAccountId('')
      await refresh()
    },
    onSettled: () => setCredential(''),
  })
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Connect a {label} account, validate and enable it, then assign it in each squad’s Integrations tab. You can
        attach multiple accounts and choose a default. Imported accounts are unassigned until you choose squads.
      </p>
      {provider === 'railway' && (
        <p className="text-sm text-muted">Use an account or workspace API token, not a project token.</p>
      )}
      {provider === 'digitalocean' && (
        <p className="text-sm text-muted">
          Include account read access for validation, plus the permissions your deployments need.
        </p>
      )}
      {pool.isPending ? (
        <p>Loading connections…</p>
      ) : pool.isError ? (
        <p role="alert">Unable to load {label} connections.</p>
      ) : (
        pool.data?.map((connection) => (
          <DeploymentAccount key={connection.id} {...{ provider, connection, canWrite, refresh }} />
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
          <h4 className="font-medium">Add account</h4>
          <label className="block text-sm">
            Account name
            <input
              name="displayName"
              className={field}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={create.isPending}
            />
          </label>
          <label className="block text-sm">
            API token
            <input
              className={field}
              type="password"
              autoComplete="off"
              required
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              disabled={create.isPending}
            />
          </label>
          {provider === 'cloudflare' && (
            <label className="block text-sm">
              Cloudflare account ID (optional, nonsecret)
              <input
                name="accountId"
                className={field}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                disabled={create.isPending}
              />
            </label>
          )}
          <button className={button} disabled={create.isPending}>
            {create.isPending ? 'Connecting…' : 'Create and validate'}
          </button>
          {create.isError && <p role="alert">{create.error.message}</p>}
        </form>
      )}
    </div>
  )
}

function DeploymentAccount({
  provider,
  connection,
  canWrite,
  refresh,
}: {
  provider: string
  connection: IntegrationConnection
  canWrite: boolean
  refresh: () => Promise<void>
}) {
  const [credential, setCredential] = useState('')
  const [replacing, setReplacing] = useState(false)
  const action = useMutation({
    mutationFn: (kind: 'validate' | 'enable' | 'disable') => integrationAction(connection.id, kind, kind === 'disable'),
    onSuccess: refresh,
  })
  const remove = useMutation({ mutationFn: () => removeIntegration(connection.id, true), onSuccess: refresh })
  const setDefault = useMutation({
    mutationFn: () => setIntegrationDefault(provider, connection.id),
    onSuccess: refresh,
  })
  const replace = useMutation({
    mutationFn: () => replaceIntegrationCredential(connection.id, credential, true),
    onSuccess: async () => {
      setReplacing(false)
      await refresh()
    },
    onSettled: () => setCredential(''),
  })
  const pending = action.isPending || remove.isPending || replace.isPending || setDefault.isPending
  return (
    <article className="space-y-3 rounded-lg border border-panel-border p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <span className="font-medium">{connection.displayName}</span>
        <span className="text-xs text-muted">
          {connection.enabled ? 'Enabled' : 'Disabled'} ·{' '}
          {connection.authState === 'authenticated' ? connection.healthState : connection.authState}
          {connection.isGlobalDefault && ' · Global default'}
        </span>
      </div>
      {connection.configuration.accountId && (
        <p className="text-xs text-muted">Cloudflare account: {connection.configuration.accountId}</p>
      )}
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={pending} onClick={() => action.mutate('validate')}>
            Validate
          </button>
          {connection.enabled ? (
            <ConfirmButton
              label="Disable account"
              confirmLabel="Disable for all squads"
              disabled={pending}
              onConfirm={() => action.mutate('disable')}
            />
          ) : (
            <button className={button} disabled={pending} onClick={() => action.mutate('enable')}>
              Enable account
            </button>
          )}
          {!connection.isGlobalDefault && (
            <button
              className={button}
              disabled={pending || !connection.enabled || connection.authState !== 'authenticated'}
              onClick={() => setDefault.mutate()}
            >
              Make global default
            </button>
          )}
          <button className={button} disabled={pending} onClick={() => setReplacing(!replacing)}>
            Replace token
          </button>
          <ConfirmButton
            label="Remove"
            confirmLabel="Remove from all squads"
            disabled={pending}
            onConfirm={() => remove.mutate()}
          />
        </div>
      )}
      {canWrite && replacing && (
        <div className="space-y-2">
          <label className="block text-sm">
            Replacement token
            <input
              className={field}
              type="password"
              autoComplete="off"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted">
            Replacing this token affects all assigned squads. Validate and enable the account afterward.
          </p>
          <ConfirmButton
            label="Replace token"
            confirmLabel="Confirm replacement"
            disabled={pending || !credential.trim()}
            onConfirm={() => replace.mutate()}
          />
        </div>
      )}
      {(action.error || remove.error || replace.error || setDefault.error) && (
        <p role="alert">{(action.error || remove.error || replace.error || setDefault.error)?.message}</p>
      )}
    </article>
  )
}
