import { useQuery } from '@tanstack/react-query'
import { integrationQueries } from '../../queryOptions'

export function GitHubRepositoryAccess({
  connectionId,
  login,
  usesTauApp,
}: {
  connectionId: string
  login: string
  usesTauApp: boolean
}) {
  const access = useQuery(integrationQueries.githubRepositoryAccess(connectionId))
  const result = access.isError ? undefined : access.data
  const uncertain = access.isError || result?.status === 'unknown'
  const needsAccess = result?.status === 'missing' || result?.personalAccountInstalled === false
  const installationUrl = usesTauApp
    ? 'https://github.com/apps/tau-integration/installations/new'
    : 'https://github.com/settings/installations'
  return (
    <div className="mt-2 space-y-2 text-xs" aria-label={`Repository access for ${login}`}>
      <p className="text-muted">Account connected. Repository access is checked separately.</p>
      {access.isFetching ? (
        <p role="status" className="text-muted">
          Checking repository access…
        </p>
      ) : (
        <>
          {uncertain && (
            <p role="status" className="text-muted">
              Could not fully verify repository access. Try checking again.
            </p>
          )}
          {result?.status === 'missing' && (
            <p role="status" className="text-status-attention-600 dark:text-status-attention-400">
              Setup needs repository access. Install the App and choose the repositories Tau can use.
            </p>
          )}
          {result?.personalAccountInstalled === false && (
            <p className="text-status-attention-600 dark:text-status-attention-400">
              The App is not installed on {login}. Repositories and forks owned by this account are not available
              through the App.
            </p>
          )}
          {result?.installations.map((installation) => (
            <p key={installation.account} className="text-muted">
              {installation.account}:{' '}
              {installation.suspended
                ? 'installation suspended'
                : installation.repositoryCount === null
                  ? 'access not verified'
                  : `${installation.repositoryCount} accessible ${installation.repositoryCount === 1 ? 'repository' : 'repositories'}`}
              {!installation.suspended && installation.repositoryCount !== 0 && (
                <>
                  {!installation.contentsWrite && ' · Contents: write permission missing'}
                  {!installation.workflowsWrite && ' · Workflows: write permission missing'}
                </>
              )}
            </p>
          ))}
          {result?.status === 'verified' && (
            <p className="text-muted">
              Repository access verified for the installations above. Access to a particular repository still depends on
              its selection and your account’s permissions.
            </p>
          )}
          {result && !result.complete && result.status !== 'unknown' && (
            <p className="text-muted">Some installations could not be checked. The list may be incomplete.</p>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <a
          className={needsAccess ? 'ficus-button ficus-button-primary px-3 py-1.5' : 'text-accent-light hover:underline'}
          href={installationUrl}
          target="_blank"
          rel="noreferrer"
        >
          Grant repository access
        </a>
        <button
          type="button"
          className="ficus-button text-accent-light"
          disabled={access.isFetching}
          onClick={() => void access.refetch()}
        >
          Check again
        </button>
      </div>
      {needsAccess && (
        <p className="text-muted">
          Sign in to the intended GitHub account, grant access, then return here. Reconnecting the account alone does
          not install the App.
        </p>
      )}
    </div>
  )
}
