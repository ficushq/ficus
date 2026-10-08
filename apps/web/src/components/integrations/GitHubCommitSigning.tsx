import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GitHubCommitSigningErrorCode } from '@ficus/shared'
import { setGitHubCommitSigning } from '../../api/integrations'
import { ApiError } from '../../api/client'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'

function failureCode(error: unknown): GitHubCommitSigningErrorCode | undefined {
  if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== 'object') return undefined
  const code = (error.payload as { code?: unknown }).code
  return typeof code === 'string' ? (code as GitHubCommitSigningErrorCode) : undefined
}

/**
 * Commit signing for one GitHub account: agents' commits and tags are signed
 * with a key Ficus registers on the account, so GitHub marks them Verified.
 * One button turns it on; the private key never leaves this Ficus server.
 */
export function GitHubCommitSigning({
  connectionId,
  login,
  canWrite,
  onReconnect,
  reconnectPending,
}: {
  connectionId: string
  login: string
  canWrite: boolean
  onReconnect: () => void
  reconnectPending: boolean
}) {
  const queryClient = useQueryClient()
  const signing = useQuery(integrationQueries.githubCommitSigning(connectionId))
  const change = useMutation({
    mutationFn: (enabled: boolean) => setGitHubCommitSigning(connectionId, enabled),
    onSuccess: (status) => queryClient.setQueryData(integrationQueryKeys.githubCommitSigning(connectionId), status),
  })
  const status = signing.data
  const on = status?.state === 'on'
  const keyMissing = on && status.registeredOnGitHub === false
  const code = change.isError ? failureCode(change.error) : undefined

  return (
    <div className="mt-3 space-y-2 text-xs" aria-label={`Commit signing for ${login}`}>
      <h4 className="font-medium text-primary">Commit signing</h4>
      {signing.isPending ? (
        <p role="status" className="text-muted">
          Checking commit signing…
        </p>
      ) : signing.isError ? (
        <p role="status" className="text-muted">
          Could not check commit signing.
        </p>
      ) : on ? (
        // On is self-evident from the fingerprint and Turn off; only a broken key needs words.
        keyMissing && (
          <p role="status" className="text-status-attention-600 dark:text-status-attention-400">
            The signing key was removed from @{login} on GitHub, so new commits will show as Unverified. Set signing up
            again to add a new key.
          </p>
        )
      ) : (
        <p className="text-muted">
          Off. Agents’ commits are not signed. Turning it on adds a signing key to @{login} on GitHub; the private key
          stays on this Ficus server and agents never see it.
        </p>
      )}
      {on && status.fingerprint && <p className="font-mono text-muted">{status.fingerprint}</p>}
      {on && status.registeredOnGitHub === null && (
        <p className="text-muted">Could not confirm the key on GitHub right now.</p>
      )}

      {change.isError &&
        (code === 'permission_missing' ? (
          <p role="alert" className="text-status-attention-600 dark:text-status-attention-400">
            Ficus needs permission to manage SSH signing keys on @{login}. Reconnect the account and approve the updated
            permissions on GitHub, then turn signing on.
          </p>
        ) : (
          <p role="alert" className="text-status-danger-500">
            {change.error instanceof Error ? change.error.message : 'Could not change commit signing.'}
          </p>
        ))}

      {canWrite && !signing.isPending && !signing.isError && (
        <div className="flex flex-wrap items-center gap-2">
          {code === 'permission_missing' && (
            <button
              type="button"
              className="ficus-button ficus-button-primary px-3 py-1.5"
              disabled={reconnectPending}
              onClick={onReconnect}
            >
              Reconnect
            </button>
          )}
          {(!on || keyMissing) && (
            <button
              type="button"
              className={
                code === 'permission_missing'
                  ? 'ficus-button ficus-button-secondary px-2.5 py-1 text-xs disabled:opacity-50'
                  : 'ficus-button ficus-button-primary px-3 py-1.5'
              }
              disabled={change.isPending}
              onClick={() => change.mutate(true)}
            >
              {change.isPending && change.variables ? 'Setting up…' : keyMissing ? 'Set up again' : 'Turn on signing'}
            </button>
          )}
          {on && (
            <button
              type="button"
              className="ficus-button ficus-button-secondary px-2.5 py-1 disabled:opacity-50 text-xs"
              disabled={change.isPending}
              onClick={() => change.mutate(false)}
            >
              {change.isPending && !change.variables ? 'Turning off…' : 'Turn off'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
