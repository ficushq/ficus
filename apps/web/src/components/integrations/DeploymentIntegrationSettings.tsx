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
import { ConnectionSquads } from './ConnectionSquads'
import { ConnectionList, ConnectionRow } from './ConnectionRow'
import { connectionConfirmQuestion, connectionStatus } from './connectionStatus'

const field =
  'ficus-field w-full rounded-md border border-panel-border bg-surface-secondary px-3 py-2 text-sm text-primary'
const buttonSize = 'rounded-md px-3 py-2 text-sm disabled:opacity-50'
const button = `ficus-button ficus-button-secondary ${buttonSize}`
const ghostButton = `ficus-button ficus-button-ghost ${buttonSize}`
const danger = 'text-sm text-status-danger-600 dark:text-status-danger-400'

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
        Connect a {label} account, then add it to the squads that deploy with it, here or in each squad’s Integrations
        tab. A squad can hold several accounts and uses its default one unless a flow picks another. Imported accounts
        are unassigned until you choose squads.
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
        pool.data.length > 0 && (
          <ConnectionList>
            {pool.data.map((connection) => (
              <DeploymentAccount
                key={connection.id}
                {...{ provider, label, connection, canWrite, refresh }}
                connections={pool.data}
              />
            ))}
          </ConnectionList>
        )
      )}
      {canWrite && (
        <form
          className="space-y-3"
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
  label,
  connection,
  connections,
  canWrite,
  refresh,
}: {
  provider: string
  label: string
  connection: IntegrationConnection
  connections: readonly IntegrationConnection[]
  canWrite: boolean
  refresh: () => Promise<void>
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
  const title = connection.displayName
  const accountId = connection.configuration.accountId
  const meta = [accountId && `${label} account ${accountId}`, connection.isGlobalDefault && 'Global default'].filter(
    Boolean
  )
  return (
    <ConnectionRow
      title={title}
      meta={meta.length > 0 && <p className="break-all">{meta.join(' · ')}</p>}
      status={connectionStatus(connection)}
      // A token has no reconnect: an invalid one is replaced from the menu.
      inline={
        canWrite && !connection.enabled
          ? { label: 'Enable', disabled: pending, onClick: () => action.mutate('enable') }
          : null
      }
      menu={
        canWrite
          ? [
              { label: 'Validate', disabled: pending, onSelect: () => action.mutate('validate') },
              // Only an enabled, signed-in account can become the default.
              !connection.isGlobalDefault &&
                connection.enabled &&
                connection.authState === 'authenticated' && {
                  label: 'Make global default',
                  disabled: pending,
                  onSelect: () => setDefault.mutate(),
                },
              { label: 'Replace token', disabled: pending, onSelect: () => setReplacing(true) },
              connection.enabled && {
                label: 'Disable…',
                disabled: pending,
                onSelect: () => setConfirming('disable'),
              },
              { label: 'Remove…', danger: true, disabled: pending, onSelect: () => setConfirming('remove') },
            ]
          : []
      }
      confirmation={
        canWrite && confirming
          ? {
              message: connectionConfirmQuestion(confirming, title, connection.usage.squadCount, label),
              confirmLabel: confirming === 'remove' ? 'Remove' : 'Disable',
              disabled: pending,
              onConfirm: () => (confirming === 'remove' ? remove.mutate() : action.mutate('disable')),
              onCancel: () => setConfirming(null),
            }
          : null
      }
    >
      {canWrite && replacing && (
        <div className="mt-3 space-y-2">
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
          <div className="flex flex-wrap gap-2">
            <ConfirmButton
              label="Replace token"
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
      {(action.error || remove.error || replace.error || setDefault.error) && (
        <p role="alert" className={`mt-2 ${danger}`}>
          {(action.error || remove.error || replace.error || setDefault.error)?.message}
        </p>
      )}
      <ConnectionSquads provider={provider} providerLabel={label} connection={connection} connections={connections} />
    </ConnectionRow>
  )
}
