import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { startLinearIdentityLink, unlinkLinearIdentity } from '../../api/linearIdentity'
import { linearIdentityQueries } from '../../queryOptions'
import { linearIdentityQueryKeys } from '../../queryKeys'
import { linearIdentityAuthorizationReturnPath } from '../../lib/integrationReturnPath'

/**
 * The signed-in person's linked Linear account (personal settings). When Ficus asks a question in a
 * Linear agent session, an exact option reply from a linked account counts as this person's answer,
 * if they may answer it in Ficus. Linking never connects a workspace or keeps a Linear token.
 */
export function LinkedLinearAccount() {
  const client = useQueryClient()
  const query = useQuery(linearIdentityQueries.status())
  const [error, setError] = useState('')
  const start = useMutation({
    mutationFn: () => startLinearIdentityLink(linearIdentityAuthorizationReturnPath()),
    onMutate: () => setError(''),
    onSuccess: (result) => window.location.assign(result.authorizationUrl),
    onError: () => setError("Couldn't start Linear sign-in. Linear may not be set up on this Ficus instance."),
  })
  const unlink = useMutation({
    mutationFn: (organizationId: string) => unlinkLinearIdentity(organizationId),
    onMutate: () => setError(''),
    onSuccess: () => client.invalidateQueries({ queryKey: linearIdentityQueryKeys.all }),
    onError: () => setError("Couldn't unlink the Linear account."),
  })
  const linked = query.data?.linked ?? []
  return (
    <section className="ficus-section py-5 space-y-4" aria-labelledby="linked-linear-account">
      <div>
        <h4
          id="linked-linear-account"
          data-setting-target="linear-account"
          className="text-md font-medium text-primary"
        >
          Linear account
        </h4>
        <p className="text-sm text-muted mt-1">
          Link your Linear account so that choosing an option in reply to a Ficus question in Linear counts as your
          answer, where you may answer it in Ficus. Any other reply reaches the agent as a suggestion. Linking only
          proves which Linear account is yours: Ficus keeps no access to it.
        </p>
      </div>
      {query.isPending && (
        <p role="status" className="text-sm text-muted">
          Loading Linear account…
        </p>
      )}
      {linked.map((entry) => (
        <div key={entry.organizationId} className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-primary">Linked</p>
            <p className="text-xs text-muted break-all">
              Linear user {entry.linearUserId} in workspace {entry.organizationId} · since{' '}
              {new Date(entry.linkedAt).toLocaleDateString()}
            </p>
          </div>
          <button
            type="button"
            className="ficus-button ficus-button-secondary px-3 py-2 text-sm shrink-0"
            disabled={unlink.isPending}
            onClick={() => unlink.mutate(entry.organizationId)}
          >
            Unlink
          </button>
        </div>
      ))}
      {query.data && (
        <button
          type="button"
          className="ficus-button ficus-button-secondary px-3 py-2 text-sm"
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          {linked.length ? 'Link another Linear workspace' : 'Link Linear account'}
        </button>
      )}
      {(error || query.isError) && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {error || "Couldn't load your Linear account."}
        </p>
      )}
    </section>
  )
}
