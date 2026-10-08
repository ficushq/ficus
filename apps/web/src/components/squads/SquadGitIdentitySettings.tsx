import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { updateSquad } from '../../api/squads'
import { integrationQueries, queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { usePermissions } from '../../hooks/usePermissions'
import { FormSkeleton } from '../loading/Skeleton'
import { githubIdentityFromMetadata, githubIdentityToMetadata, type GithubIdentityForm } from './integrationMetadata'

export function SquadGitIdentitySettings({ squadId }: { squadId: string }) {
  const queryClient = useQueryClient()
  const permissions = usePermissions(squadId)
  const canEdit = permissions.can('squads:update')
  const { data: squad, isPending, isError } = useQuery(queries.squads.basic(squadId))
  const { data: authorDefaults } = useQuery({
    ...integrationQueries.squadGitAuthorDefaults(squadId),
    enabled: permissions.can('integrations:read'),
  })
  const [githubIdentity, setGithubIdentity] = useState<GithubIdentityForm>({ gitUserName: '', gitUserEmail: '' })
  const [hasChanges, setHasChanges] = useState(false)
  useEffect(() => {
    if (!squad || hasChanges) return
    setGithubIdentity(githubIdentityFromMetadata(squad.metadata))
  }, [squad, hasChanges])
  const updateMutation = useMutation({
    mutationFn: () =>
      updateSquad(squadId, { metadata: githubIdentityToMetadata(squad?.metadata ?? {}, githubIdentity) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.squads.basic(squadId), updated)
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.basic(squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) })
      setHasChanges(false)
    },
  })
  const updateGithubIdentity = (patch: Partial<GithubIdentityForm>) => {
    setGithubIdentity((previous) => ({ ...previous, ...patch }))
    setHasChanges(true)
  }
  if (isPending) return <FormSkeleton label="Loading Git commit identity" sections={1} />
  if (isError) return <p role="alert">Unable to load Git commit identity.</p>
  return (
    <section className="space-y-4" aria-label="Git commit identity">
      <div className="space-y-3">
        <h4 data-setting-target="sandbox-github-identity" className="text-sm font-medium text-primary">
          Git commit identity
        </h4>
        <p className="text-xs text-muted">
          Author details for commits made in this squad’s workspace, regardless of Git provider. Leave blank to use the
          configured defaults.
        </p>
        {authorDefaults?.github && (
          <p className="text-xs text-muted">
            GitHub defaults (@{authorDefaults.github.login}): {authorDefaults.github.gitUserName} ·{' '}
            {authorDefaults.github.gitUserEmail}
          </p>
        )}
        {authorDefaults && (
          <p className="text-xs text-secondary">
            Leave blank to use {authorDefaults.defaults.gitUserName ?? 'the default name'} ·{' '}
            {authorDefaults.defaults.gitUserEmail ?? 'the default email'}. Global author overrides take precedence over
            GitHub defaults.
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="squad-git-author-name"
              data-setting-target="git-author-name"
              className="block text-sm font-medium text-primary mb-1"
            >
              Git Author Name
            </label>
            <input
              id="squad-git-author-name"
              disabled={!canEdit || updateMutation.isPending}
              type="text"
              value={githubIdentity.gitUserName}
              onChange={(e) => updateGithubIdentity({ gitUserName: e.target.value })}
              placeholder={authorDefaults?.defaults.gitUserName ?? 'Optional'}
              className="ficus-field w-full px-3 py-1.5 text-sm rounded border border-th-border bg-surface text-primary  focus:ring-1 focus:ring-accent/50"
            />
          </div>
          <div>
            <label
              htmlFor="squad-git-author-email"
              data-setting-target="git-author-email"
              className="block text-sm font-medium text-primary mb-1"
            >
              Git Author Email
            </label>
            <input
              id="squad-git-author-email"
              disabled={!canEdit || updateMutation.isPending}
              type="email"
              value={githubIdentity.gitUserEmail}
              onChange={(e) => updateGithubIdentity({ gitUserEmail: e.target.value })}
              placeholder={authorDefaults?.defaults.gitUserEmail ?? 'Optional'}
              className="ficus-field w-full px-3 py-1.5 text-sm rounded border border-th-border bg-surface text-primary  focus:ring-1 focus:ring-accent/50"
            />
          </div>
        </div>
      </div>
      {hasChanges && canEdit && (
        <button
          type="button"
          onClick={() => updateMutation.mutate()}
          disabled={updateMutation.isPending}
          className="ficus-button ficus-button-primary rounded-md px-3 py-2 text-sm"
        >
          {updateMutation.isPending ? 'Saving…' : 'Save identity'}
        </button>
      )}
      {updateMutation.isError && (
        <p role="alert" className="text-sm text-status-danger-500">
          Failed to save: {String(updateMutation.error)}
        </p>
      )}
      {!hasChanges && updateMutation.isSuccess && (
        <p role="status" className="text-sm text-muted">
          Saved.
        </p>
      )}
    </section>
  )
}
