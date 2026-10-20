import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { connectLocalBigbrain, type BigbrainLocalSetupResult } from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'

const OTHER = '__other__'

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 300) : 'BigBrain setup failed. Try again.'
}

function sourceLabel(source: string): string {
  if (source === 'bigbrain_default') return 'BigBrain’s current vault'
  if (source === 'bigbrain_fallback') return 'BigBrain’s default vault folder'
  if (source === 'existing_binding') return 'Already set up for Ficus'
  return 'Chosen folder'
}

/**
 * One-click local BigBrain setup. Core detects the `bigbrain` command and vaults on its own host;
 * the person picks a vault (or types a Core-host folder), reviews its whole-vault access and
 * confirms. Core then runs BigBrain's own setup command and enables the connection.
 */
export function BigbrainLocalSetupPanel({ hasConnections }: { hasConnections: boolean }) {
  const client = useQueryClient()
  const setup = useQuery(integrationQueries.localSetup())
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState('')
  const [folder, setFolder] = useState('')
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [result, setResult] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const connect = useMutation({
    mutationFn: (input: Parameters<typeof connectLocalBigbrain>[0]) => connectLocalBigbrain(input),
    onMutate: () => setResult(null),
    onSuccess: async (data: BigbrainLocalSetupResult) => {
      setOpen(false)
      setFolder('')
      setReplaceExisting(false)
      setResult(
        data.enabled
          ? {
              kind: 'success',
              text: `${data.connectionOutcome === 'reused' ? 'BigBrain is already connected' : 'BigBrain connected'}: ${data.connection.displayName}. Assign it to a squad in that squad’s integration settings.`,
            }
          : {
              kind: 'error',
              text: `BigBrain was set up but could not be enabled (${data.connection.lastErrorCode ?? 'validation failed'}). Open BigBrain.app, then validate the connection below.`,
            }
      )
      await client.invalidateQueries({ queryKey: integrationQueryKeys.all })
    },
    onError: async (error) => {
      setResult({ kind: 'error', text: message(error) })
      await client.invalidateQueries({ queryKey: integrationQueryKeys.localSetup() })
    },
  })

  if (setup.isLoading)
    return (
      <p role="status" className="mt-4 text-xs text-muted">
        Looking for BigBrain…
      </p>
    )
  if (setup.isError)
    return (
      <p role="alert" className="mt-4 text-sm text-status-danger-600">
        Unable to check BigBrain on the Ficus host. {message(setup.error)}
      </p>
    )
  const state = setup.data
  if (!state) return null
  const where = state.hostPlatform === 'darwin' ? 'this Mac' : 'the Ficus host'
  const title = `${hasConnections ? 'Connect or repair a vault' : 'Connect BigBrain'} on ${where}`
  if (state.state === 'unsupported_host')
    return (
      <p role="alert" className="mt-4 text-sm text-muted">
        {state.reason ?? 'BigBrain is unavailable on this deployment.'}
      </p>
    )

  const vaults = state.vaults
  const selected = choice || vaults[0]?.id || OTHER
  const selectedVault = vaults.find((vault) => vault.id === selected)
  const typed = folder.trim()
  const needsReplace = state.bindingsFile === 'unmanaged' || state.bindingsFile === 'invalid'
  const canConfirm =
    state.state === 'ready' &&
    !connect.isPending &&
    (selected === OTHER ? typed.startsWith('/') : !!selectedVault) &&
    (!needsReplace || replaceExisting)
  const recheck = (
    <button
      type="button"
      className="ficus-button ficus-button-secondary mt-2 rounded-md px-3 py-1.5 text-sm"
      onClick={() => {
        setResult(null)
        void setup.refetch()
      }}
      disabled={setup.isFetching}
    >
      {setup.isFetching ? 'Checking…' : 'Check again'}
    </button>
  )

  return (
    <div className="mt-5 border-t border-th-border pt-4">
      <h4 className="text-sm font-medium text-primary">{title}</h4>
      {state.state !== 'ready' ? (
        <div role="alert" className="mt-2 text-sm text-muted">
          <p>{state.reason}</p>
          {recheck}
        </div>
      ) : !open ? (
        <>
          <p className="mt-1 text-xs text-muted">
            Ficus finds BigBrain on {where}, asks BigBrain for a connection and turns it on. No files to edit.
          </p>
          <button
            type="button"
            className="ficus-button ficus-button-primary mt-3 rounded-md px-3 py-2 text-sm font-medium"
            onClick={() => {
              setResult(null)
              setOpen(true)
            }}
          >
            {title}
          </button>
        </>
      ) : (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canConfirm) return
            connect.mutate({
              ...(selected === OTHER ? { vaultPath: typed } : { vaultId: selected }),
              ...(needsReplace ? { replaceExisting: true } : {}),
            })
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-medium text-primary">Vault</legend>
            {vaults.map((vault) => (
              <label key={vault.id} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="bigbrain-vault"
                  className="mt-1"
                  checked={selected === vault.id}
                  onChange={() => setChoice(vault.id)}
                  disabled={connect.isPending}
                />
                <span className="min-w-0">
                  <span className="text-primary">{vault.label}</span>
                  <span className="block break-all text-xs text-muted">
                    {vault.vaultPath} · {sourceLabel(vault.source)}
                  </span>
                </span>
              </label>
            ))}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="bigbrain-vault"
                className="mt-1"
                checked={selected === OTHER}
                onChange={() => setChoice(OTHER)}
                disabled={connect.isPending}
              />
              <span className="text-primary">
                {vaults.length ? 'Another vault folder' : 'Vault folder'} on {where}
              </span>
            </label>
            {selected === OTHER && (
              <input
                aria-label="BigBrain vault folder"
                className="ficus-field ml-6 rounded-md border border-th-border bg-surface px-3 py-2 text-sm"
                placeholder={state.hostPlatform === 'darwin' ? '/Users/you/vault' : '/home/you/vault'}
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                disabled={connect.isPending}
                spellCheck={false}
                autoComplete="off"
              />
            )}
            {selected === OTHER && (
              <p className="ml-6 text-xs text-muted">
                {vaults.length ? '' : 'Ficus did not find a BigBrain vault automatically. '}Enter the full path of a
                folder containing vault.yaml. Open BigBrain.app to create a vault first.
              </p>
            )}
          </fieldset>
          <div
            role="note"
            className="rounded-md border border-status-attention-500/50 bg-status-attention-500/10 p-3 text-xs"
          >
            <p className="font-medium text-primary">This connection can read the whole vault and send notes to it.</p>
            <p className="mt-1 text-muted">
              Ficus runs BigBrain’s own setup on {where}. It creates or reuses BigBrain’s “{state.connectionName}”
              connection, which can read everything in{' '}
              <span className="break-all">
                {selected === OTHER ? typed || 'the chosen vault' : selectedVault?.vaultPath}
              </span>{' '}
              and drop notes into its inbox. Agents only get it in squads you assign it to, through allowed BigBrain
              tools. Agents on the local runtime can also reach your files directly.
            </p>
          </div>
          {needsReplace && (
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={replaceExisting}
                onChange={(event) => setReplaceExisting(event.target.checked)}
                disabled={connect.isPending}
              />
              <span>
                {state.bindingsFile === 'unmanaged'
                  ? 'Ficus found a BigBrain settings file it did not create. Let Ficus manage it from now on (its existing vaults are kept).'
                  : 'Ficus found an unreadable BigBrain settings file. Replace it.'}
              </span>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="ficus-button ficus-button-primary rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
              disabled={!canConfirm}
            >
              {connect.isPending ? 'Connecting…' : 'Confirm and connect'}
            </button>
            <button
              type="button"
              className="ficus-button ficus-button-secondary rounded-md px-3 py-2 text-sm"
              onClick={() => setOpen(false)}
              disabled={connect.isPending}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {result && (
        <p
          role={result.kind === 'error' ? 'alert' : 'status'}
          className={clsx(
            'mt-3 text-sm',
            result.kind === 'error' ? 'text-status-danger-600' : 'text-status-success-700'
          )}
        >
          {result.text}
        </p>
      )}
    </div>
  )
}
