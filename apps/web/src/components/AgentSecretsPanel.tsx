import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { exposeAgentSecrets, setAgentSecrets } from '../api/agents'
import { setSecret } from '../api/secrets'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'
import { FormSkeleton } from './loading/Skeleton'

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

interface Props {
  agentId: string
  squadId?: string
}

/**
 * Per-agent secrets: which Secret Store keys only this agent's own sandbox can
 * read (as env vars in its bash). Names only; values are never fetched or
 * shown. Viewing needs env:read, changing needs env:write; a new value can be
 * saved to the Secret Store from here with secrets:write.
 */
export function AgentSecretsPanel({ agentId, squadId }: Props) {
  const { can, isLoading } = usePermissions(squadId)
  if (isLoading || !can('env:read')) return null
  return (
    <AgentSecretsPanelContent
      agentId={agentId}
      canWrite={can('env:write')}
      canSetSecret={can('env:write') && can('secrets:write')}
    />
  )
}

function AgentSecretsPanelContent({
  agentId,
  canWrite,
  canSetSecret,
}: {
  agentId: string
  canWrite: boolean
  canSetSecret: boolean
}) {
  const queryClient = useQueryClient()
  const { data, isLoading, isError } = useQuery(queries.agents.secrets(agentId))
  const saved = useMemo(() => data?.exposedSecretKeys ?? [], [data?.exposedSecretKeys])
  const [selected, setSelected] = useState<string[]>(saved)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  useEffect(() => setSelected(saved), [saved])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.agents.secrets(agentId) })

  const saveExposure = useMutation({
    mutationFn: (keys: string[]) => setAgentSecrets(agentId, keys),
    onSuccess: invalidate,
  })

  const addSecret = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      await setSecret(key, value)
      return exposeAgentSecrets(agentId, [key])
    },
    onSuccess: () => {
      setNewKey('')
      setNewValue('')
      void invalidate()
    },
    // Never keep a typed value around after a failed save either.
    onError: () => setNewValue(''),
  })

  const dirty = [...selected].sort().join('\n') !== [...saved].sort().join('\n')
  const supported = data ? data.unsupportedReason === null : false
  const editable = canWrite && supported
  const newKeyValid = ENV_NAME.test(newKey.trim())
  const error = saveExposure.error ?? addSecret.error

  return (
    <section className="border-t border-panel-border pt-5" aria-label="Per-agent secrets">
      <div className="pb-3">
        <h3 className="text-sm font-medium text-primary">Per-agent secrets</h3>
        <p className="mt-1 text-xs text-muted">
          Secret Store keys only this agent can read, as environment variables in its own bash commands (subagents it
          dispatches share its sandbox and inherit them). Other agents and the shared squad workspace never see them.
          Values are never shown here.
        </p>
      </div>

      {isLoading ? (
        <FormSkeleton label="Loading per-agent secrets" sections={1} />
      ) : isError || !data ? (
        <p className="text-sm text-status-danger-600 dark:text-status-danger-400">Failed to load per-agent secrets.</p>
      ) : (
        <div className="space-y-4">
          {data.unsupportedReason && <p className="text-sm text-muted">{data.unsupportedReason}</p>}

          {supported && (
            <>
              {data.secrets.length === 0 ? (
                <p className="text-sm italic text-muted">The Secret Store has no keys yet.</p>
              ) : (
                <div className="max-h-64 space-y-2 overflow-auto rounded-lg border border-th-border p-3">
                  {data.secrets.map((secret) => {
                    const checked = selected.includes(secret.key)
                    return (
                      <label key={secret.key} className="flex items-center justify-between gap-3 text-sm">
                        <span className={clsx('font-mono', secret.isSet ? 'text-primary' : 'text-muted')}>
                          {secret.key}
                          {!secret.isSet && (
                            <span className="ml-2 font-sans text-xs text-muted">
                              {checked ? 'not set; uncheck to remove' : 'not set'}
                            </span>
                          )}
                        </span>
                        <input
                          type="checkbox"
                          aria-label={`Expose ${secret.key} to this agent`}
                          checked={checked}
                          disabled={!editable || (!secret.isSet && !checked)}
                          onChange={() =>
                            setSelected((current) =>
                              current.includes(secret.key)
                                ? current.filter((key) => key !== secret.key)
                                : [...current, secret.key]
                            )
                          }
                          className="h-4 w-4 rounded border-th-border text-accent-light focus:ring-accent/50 disabled:opacity-50"
                        />
                      </label>
                    )
                  })}
                </div>
              )}

              {editable && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted">
                    {dirty ? 'Unsaved changes' : saveExposure.isSuccess ? '✓ Saved' : 'Values hidden'}
                  </span>
                  <button
                    type="button"
                    className="ficus-button ficus-button-primary rounded-md px-3 py-1 text-sm font-medium"
                    disabled={!dirty || saveExposure.isPending}
                    onClick={() => saveExposure.mutate(selected)}
                  >
                    {saveExposure.isPending ? 'Saving…' : 'Save exposed secrets'}
                  </button>
                </div>
              )}

              {editable && canSetSecret && (
                <form
                  className="space-y-3 rounded-lg border border-th-border bg-surface-secondary p-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (newKeyValid && newValue) addSecret.mutate({ key: newKey.trim(), value: newValue })
                  }}
                >
                  <div>
                    <h4 className="text-sm font-medium text-primary">Add a secret for this agent</h4>
                    <p className="mt-1 text-xs text-muted">
                      Saves the value in the Secret Store (overwriting a key with the same name) and exposes it to this
                      agent only.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      aria-label="Secret name"
                      placeholder="NAME"
                      value={newKey}
                      onChange={(event) => setNewKey(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      className="ficus-field min-w-0 flex-1 rounded border border-th-border bg-surface px-2 py-1 font-mono text-sm text-primary placeholder:text-placeholder"
                    />
                    <input
                      aria-label="Secret value"
                      placeholder="Value"
                      type="password"
                      value={newValue}
                      onChange={(event) => setNewValue(event.target.value)}
                      autoComplete="new-password"
                      spellCheck={false}
                      className="ficus-field min-w-0 flex-1 rounded border border-th-border bg-surface px-2 py-1 text-sm text-primary placeholder:text-placeholder"
                    />
                    <button
                      type="submit"
                      className="ficus-button ficus-button-secondary rounded-md px-3 py-1 text-sm font-medium"
                      disabled={!newKeyValid || !newValue || addSecret.isPending}
                    >
                      {addSecret.isPending ? 'Saving…' : 'Save and expose'}
                    </button>
                  </div>
                  {newKey.trim() !== '' && !newKeyValid && (
                    <p className="text-xs text-muted">
                      Use letters, digits and underscores; do not start with a digit.
                    </p>
                  )}
                </form>
              )}

              {data.secretsFilePath && saved.length > 0 && (
                <p className="text-xs text-muted">
                  In the agent&apos;s sandbox: <span className="font-mono">{data.secretsFilePath}</span>
                </p>
              )}
            </>
          )}

          {error && (
            <p className="text-sm text-status-danger-600 dark:text-status-danger-400">{(error as Error).message}</p>
          )}
        </div>
      )}
    </section>
  )
}
