import { useState } from 'react'
import { effectiveSquadEventRules, squadEventRulesSchema, type SquadEventRule } from '@ficus/shared'
import { SquadEventRulesEditor } from './SquadEventRulesEditor'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { updateSquad } from '../../api/squads'
import { integrationQueries, queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { usePermissions } from '../../hooks/usePermissions'
import { SquadIntegrationCard } from './SquadIntegrationCard'
import { LinearTeamRoutingPicker } from './LinearTeamPicker'
import { FormSkeleton } from '../loading/Skeleton'
import { GitHubFeedbackSettings } from '../integrations/GitHubFeedbackSettings'
import {
  githubRoutingFromMetadata,
  githubRoutingToMetadata,
  linearRoutingFromMetadata,
  linearRoutingToMetadata,
  linearSettingsFromMetadata,
  linearSettingsToMetadata,
  type GithubRoutingFormEntry,
  type LinearPullRequestLinksForm,
  type LinearRoutingFormEntry,
} from './integrationMetadata'

const LINK_KIND_OPTIONS = [
  { value: 'closes', label: 'Closes the issue' },
  { value: 'contributes', label: 'Contributes to the issue' },
  { value: 'links', label: 'Links to the issue' },
] as const

export function IntegrationSettings({ squadId }: { squadId: string }) {
  const catalog = useQuery(integrationQueries.catalog())
  const permissions = usePermissions(squadId)
  const [search, setSearch] = useState('')
  const entries = (catalog.data?.integrations ?? [])
    .filter((entry) => entry.enabled === true && entry.assignable)
    .sort((a, b) => a.label.localeCompare(b.label))
    .filter((entry) => `${entry.label} ${entry.description}`.toLowerCase().includes(search.trim().toLowerCase()))
  return (
    <div className="space-y-6">
      <header>
        <h3 className="text-lg font-semibold text-primary">Integrations</h3>
        <p className="mt-1 text-sm text-muted">
          Choose the apps and accounts this squad uses. More apps can be enabled in Settings → Integrations.
        </p>
      </header>
      <input
        type="search"
        aria-label="Search squad integrations"
        placeholder="Search integrations…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="ficus-field w-full rounded-lg border border-panel-border bg-surface px-3 py-2.5 text-sm"
      />
      {catalog.isPending || permissions.isLoading ? (
        <FormSkeleton label="Loading integrations" sections={1} />
      ) : catalog.isError || permissions.isError ? (
        <p role="alert" className="text-sm text-status-danger-500">
          Unable to load squad integrations.
        </p>
      ) : !permissions.can('integrations:read') ? (
        <p className="text-sm text-muted">You do not have permission to view this squad’s integrations.</p>
      ) : (
        <div className="grid items-stretch gap-4 md:grid-cols-2">
          {entries.map((entry) => (
            <SquadIntegrationCard
              key={entry.key}
              entry={entry}
              squadId={squadId}
              canWrite={permissions.can('integrations:write')}
            >
              {(entry.key === 'github' || entry.key === 'linear') && (
                <IntegrationRoutingSettings key={`${squadId}:${entry.key}`} squadId={squadId} provider={entry.key} />
              )}
            </SquadIntegrationCard>
          ))}
          {entries.length === 0 && (
            <p role="status" className="text-sm text-muted md:col-span-2">
              No enabled integrations match. Enable apps in Settings → Integrations.
            </p>
          )}
        </div>
      )}
      {/* Separate from the rule form's draft overlay and from integration-credential permissions:
          trust and moderation follow squad permissions and refresh without touching rule drafts. */}
      <GitHubFeedbackSettings squadId={squadId} />
    </div>
  )
}

interface RoutingDraft {
  github: GithubRoutingFormEntry[]
  linear: LinearRoutingFormEntry[]
  pullRequestLinks: LinearPullRequestLinksForm
  rules: SquadEventRule[]
}

function IntegrationRoutingSettings({ squadId, provider }: { squadId: string; provider: 'github' | 'linear' }) {
  const queryClient = useQueryClient()
  const squadPermissions = usePermissions(squadId)
  const { data: squad, isLoading } = useQuery(queries.squads.basic(squadId))
  const linearSelection = useQuery({
    ...integrationQueries.squad(squadId, 'linear'),
    enabled: provider === 'linear',
  })
  const inaccessibleTeamIds = linearSelection.data?.inaccessibleTeamIds ?? []
  // Clean forms follow the query. Once edited, the entire form belongs to the
  // user until saved or closed; unrelated squad refreshes must not reinitialize it.
  const [draft, setDraft] = useState<RoutingDraft | null>(null)
  const existingGithub = githubRoutingFromMetadata(squad?.metadata)
  const existingLinear = linearRoutingFromMetadata(squad?.metadata)
  const config = draft ?? {
    github: existingGithub.length > 0 ? existingGithub : [{ repo: '', labelsText: '' }],
    linear: existingLinear,
    pullRequestLinks: linearSettingsFromMetadata(squad?.metadata),
    rules: effectiveSquadEventRules(squad?.metadata, provider),
  }
  const { github: githubEntries, linear: linearEntries, pullRequestLinks, rules: eventRules } = config
  const hasChanges = draft !== null

  const updateMutation = useMutation({
    mutationFn: async (nextConfig: RoutingDraft) => {
      const currentMetadata = (squad?.metadata as Record<string, unknown> | null | undefined) ?? {}
      const metadata =
        provider === 'github'
          ? githubRoutingToMetadata(currentMetadata, nextConfig.github)
          : linearSettingsToMetadata(
              linearRoutingToMetadata(currentMetadata, nextConfig.linear),
              nextConfig.pullRequestLinks
            )
      return updateSquad(squadId, {
        metadata: {
          ...metadata,
          integrationRules: {
            ...(currentMetadata.integrationRules as Record<string, SquadEventRule[]> | undefined),
            [provider]: nextConfig.rules,
          },
        },
      })
    },
    onSuccess: async (savedSquad, submitted) => {
      // A read started before the save must not replace the acknowledged baseline.
      await queryClient.cancelQueries({ queryKey: queryKeys.squads.basic(squadId) })
      queryClient.setQueryData(queryKeys.squads.basic(squadId), savedSquad)
      // Scope inputs remain editable during saves. Only clear the submitted draft,
      // not a newer edit made while the request was pending.
      setDraft((current) => (current === submitted ? null : current))
      void queryClient.invalidateQueries({ queryKey: queryKeys.squads.basic(squadId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) })
    },
  })

  if (isLoading) return <FormSkeleton label="Loading integrations" sections={4} />

  const updateGithubEntry = (index: number, patch: Partial<GithubRoutingFormEntry>) => {
    setDraft({ ...config, github: githubEntries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)) })
  }

  return (
    <div className="mt-5 space-y-5 border-t border-panel-border pt-5">
      {provider === 'github' && (
        <section className="space-y-3" aria-label="Shared repository scope">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3
                data-setting-target="github-routing"
                data-setting-fallback="repository labels"
                className="text-sm font-medium text-primary"
              >
                Shared repository scope
              </h3>
              <p className="text-xs text-muted mt-1">
                Reusable scope for event rules that enable “Use shared repository scope.” An event must match one
                repository entry. Its optional labels apply to issue assignments and unassignments only; one matching
                label is enough. They do not filter comments or pull requests. This section does not trigger an action
                by itself.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {githubEntries.map((entry, index) => (
              <div key={index} className="rounded-lg border border-panel-border p-3 space-y-3">
                <div>
                  <label data-setting-target="repository" className="block text-sm font-medium text-primary mb-1">
                    Repository
                  </label>
                  <input
                    type="text"
                    value={entry.repo}
                    onChange={(e) => updateGithubEntry(index, { repo: e.target.value })}
                    placeholder="owner/repo or owner/*"
                    className="ficus-field w-full px-3 py-1.5 text-sm rounded border border-th-border bg-surface text-primary  focus:ring-1 focus:ring-accent/50"
                  />
                </div>
                <div>
                  <label data-setting-target="labels" className="block text-sm font-medium text-primary mb-1">
                    Assignment labels (optional)
                  </label>
                  <input
                    type="text"
                    value={entry.labelsText}
                    onChange={(e) => updateGithubEntry(index, { labelsText: e.target.value })}
                    placeholder="backend, api (optional; blank matches all issues)"
                    className="ficus-field w-full px-3 py-1.5 text-sm rounded border border-th-border bg-surface text-primary  focus:ring-1 focus:ring-accent/50"
                  />
                </div>
                {githubEntries.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft({ ...config, github: githubEntries.filter((_, i) => i !== index) })
                    }}
                    className="ficus-button ficus-button-danger px-2 py-1 text-xs"
                  >
                    Remove repository
                  </button>
                )}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              setDraft({ ...config, github: [...githubEntries, { repo: '', labelsText: '' }] })
            }}
            className="ficus-button ficus-button-secondary mt-3 px-3 py-1.5 text-sm rounded-md"
          >
            Add repository
          </button>
        </section>
      )}
      {provider === 'linear' && (
        <>
          <div className="mb-3">
            <h3
              data-setting-target="linear-routing"
              data-setting-fallback="team-id"
              className="text-sm font-medium text-primary"
            >
              Linear Routing
            </h3>
            <p className="text-xs text-muted mt-1">
              Route Linear assigned issues to this squad from these teams, listed from the squad’s Linear connections.
            </p>
          </div>
          {inaccessibleTeamIds.length > 0 && (
            <p role="alert" className="mb-3 text-sm text-status-attention-600 dark:text-status-attention-400">
              The Ficus app in Linear cannot access {inaccessibleTeamIds.length === 1 ? 'team' : 'teams'}{' '}
              {inaccessibleTeamIds.join(', ')}. A Linear admin can grant access in the Ficus app settings in Linear.
            </p>
          )}

          <LinearTeamRoutingPicker
            squadId={squadId}
            value={[
              ...new Set(linearEntries.map((entry) => entry.teamId.trim()).filter((teamId) => teamId.length > 0)),
            ]}
            onChange={(teamIds) => setDraft({ ...config, linear: teamIds.map((teamId) => ({ teamId })) })}
            disabled={!squadPermissions.can('squads:update')}
          />

          <section className="mt-5 space-y-3" aria-label="Pull request links">
            <div>
              <h3
                data-setting-target="linear-pull-request-links"
                data-setting-fallback="pull request links"
                className="text-sm font-medium text-primary"
              >
                Pull request links
              </h3>
              <p className="text-xs text-muted mt-1">
                How Ficus attaches a work stream&rsquo;s pull request to its Linear issues. With Closes, Linear&rsquo;s
                GitHub integration completes the issue when the pull request merges. Ficus never changes issue status
                itself.
              </p>
            </div>
            {(
              [
                ['origin', 'Issue the work started from'],
                ['tracked', 'Other tracked issues'],
              ] as const
            ).map(([field, label]) => (
              <div key={field}>
                <label htmlFor={`linear-pr-link-${field}`} className="block text-sm font-medium text-primary mb-1">
                  {label}
                </label>
                <select
                  id={`linear-pr-link-${field}`}
                  value={pullRequestLinks[field]}
                  disabled={!squadPermissions.can('squads:update')}
                  onChange={(e) =>
                    setDraft({
                      ...config,
                      pullRequestLinks: {
                        ...pullRequestLinks,
                        [field]: e.target.value as LinearPullRequestLinksForm[typeof field],
                      },
                    })
                  }
                  className="ficus-field w-full px-3 py-1.5 text-sm rounded border border-th-border bg-surface text-primary focus:ring-1 focus:ring-accent/50"
                >
                  {LINK_KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </section>
        </>
      )}
      <SquadEventRulesEditor
        squadId={squadId}
        provider={provider}
        value={eventRules}
        metadata={
          provider === 'github'
            ? githubRoutingToMetadata((squad?.metadata as Record<string, unknown>) ?? {}, githubEntries)
            : linearRoutingToMetadata((squad?.metadata as Record<string, unknown>) ?? {}, linearEntries)
        }
        disabled={!squadPermissions.can('squads:update') || updateMutation.isPending}
        onChange={(rules) => {
          setDraft({ ...config, rules })
        }}
      />
      {hasChanges && squadPermissions.can('squads:update') && (
        <button
          type="button"
          onClick={() => updateMutation.mutate(config)}
          disabled={updateMutation.isPending || !squadEventRulesSchema.safeParse({ [provider]: eventRules }).success}
          className="ficus-button ficus-button-primary rounded-md px-3 py-2 text-sm"
        >
          {updateMutation.isPending ? 'Saving…' : 'Save settings'}
        </button>
      )}
      {updateMutation.isError && (
        <p className="text-xs text-status-danger-500 mt-2">Failed to save: {String(updateMutation.error)}</p>
      )}
      {!hasChanges && updateMutation.isSuccess && <p className="text-xs text-status-success-500 mt-2">✓ Saved.</p>}
    </div>
  )
}
