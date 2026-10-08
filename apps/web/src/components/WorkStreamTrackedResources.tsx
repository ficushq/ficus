import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TrackedResourcesView } from '@ficus/shared'
import { parseTrackedResourceUrl, trackedResourceLabel, trackedResourceUrl } from '@ficus/shared'
import { addWorkStreamTracked, removeWorkStreamTracked, type AddWorkStreamTrackedBody } from '../api/squads'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { Badge, type BadgeColor } from './Badge'
import { IssueIcon, PullRequestIcon, ShieldIcon } from './icons'

type TrackedRow = TrackedResourcesView['resources'][number]

/**
 * Why links exist but updates may not arrive. The delivery change request and
 * tracked links are followed by the same subscriptions, so one sentence covers
 * the whole section.
 */
const SUBSCRIPTION_HINTS: Record<Exclude<TrackedResourcesView['subscriptions'], 'active'>, string> = {
  'no-flow': 'Attach a workflow to receive updates',
  'not-following': 'This workflow does not follow code-host changes',
  ended: 'Work stream ended',
}

/** An open pull request gets no chip: it is the unremarkable state while work is in flight. */
const MERGE_STATE_COLORS: Partial<Record<NonNullable<TrackedRow['mergeState']>, BadgeColor>> = {
  merged: 'success',
  closed: 'neutral',
}

const resourceIdentity = (resource: TrackedRow) => ({
  integration: resource.integration,
  repository: resource.repository,
  kind: resource.kind,
  number: resource.number,
})

/**
 * Issues and pull requests a work stream follows. Reference material (the
 * stream's `sources`) deliberately stays out — only links that can produce
 * updates belong here.
 */
export function WorkStreamTrackedResources({ workStreamId, canUpdate }: { workStreamId: string; canUpdate: boolean }) {
  const cache = useQueryClient()
  const [url, setUrl] = useState('')
  const [countsTowardDelivery, setCountsTowardDelivery] = useState(false)
  const { data } = useQuery(queries.squads.workStreamTracked(workStreamId))
  const invalidate = () => cache.invalidateQueries({ queryKey: queryKeys.squads.workStreamTracked(workStreamId) })
  const add = useMutation({
    mutationFn: (body: AddWorkStreamTrackedBody) => addWorkStreamTracked(workStreamId, body),
    onSuccess: async () => {
      setUrl('')
      setCountsTowardDelivery(false)
      await invalidate()
    },
  })
  const designate = useMutation({
    mutationFn: (resource: TrackedRow) =>
      addWorkStreamTracked(workStreamId, { resource: resourceIdentity(resource), delivery: true }),
    onSuccess: async () => invalidate(),
  })
  const remove = useMutation({
    mutationFn: (resource: TrackedRow) => removeWorkStreamTracked(workStreamId, resourceIdentity(resource)),
    onSuccess: async () => invalidate(),
  })
  const resources = data?.resources ?? []
  const hint = data && data.subscriptions !== 'active' ? SUBSCRIPTION_HINTS[data.subscriptions] : null
  const error = add.error ?? remove.error ?? designate.error
  const deliveryPullRequests = data?.delivery?.pullRequests ?? []
  const merged = deliveryPullRequests.filter((pullRequest) => pullRequest.state === 'merged').length
  // Only a pull request can count toward delivery, so the flag follows what the typed link resolves to.
  const deliverable = parseTrackedResourceUrl(url.trim())?.kind === 'pull_request'

  return (
    <section aria-label="Tracked issues, PRs and alerts" className="space-y-1.5">
      <h3 className="text-xs font-medium text-secondary">Tracked issues, PRs and alerts</h3>
      {resources.length > 0 && (
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          {resources.map((resource) => {
            const href = trackedResourceUrl(resource)
            const label = trackedResourceLabel(resource)
            const Icon =
              resource.kind === 'dependabot_alert'
                ? ShieldIcon
                : resource.kind === 'issue'
                  ? IssueIcon
                  : PullRequestIcon
            return (
              <li key={resource.key} className="flex items-center gap-1.5">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-accent hover:underline"
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    {label}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    {label}
                  </span>
                )}
                {resource.delivery && <Badge color="accent-1">delivery</Badge>}
                {resource.mergeState && MERGE_STATE_COLORS[resource.mergeState] && (
                  <Badge color={MERGE_STATE_COLORS[resource.mergeState]}>{resource.mergeState}</Badge>
                )}
                {!resource.subscribed && <span className="text-muted">not subscribed</span>}
                {canUpdate && resource.kind === 'pull_request' && !resource.delivery && (
                  <button
                    type="button"
                    aria-label={`Mark ${label} as delivery`}
                    className="ficus-button ficus-button-link"
                    disabled={designate.isPending}
                    onClick={() => designate.mutate(resource)}
                  >
                    Mark as delivery
                  </button>
                )}
                {canUpdate && resource.source !== 'delivery' && (
                  <button
                    type="button"
                    aria-label={`Stop tracking ${label}`}
                    className="ficus-button ficus-button-link"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(resource)}
                  >
                    Remove
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {!resources.length && !canUpdate && <p className="text-xs text-muted">Nothing tracked</p>}
      {deliveryPullRequests.length > 0 && (
        <p className="text-xs text-muted">
          Delivery: {merged} of {deliveryPullRequests.length} pull requests merged
        </p>
      )}
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {canUpdate && (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const value = url.trim()
            if (value)
              add.mutate({ url: value, ...(deliverable && countsTowardDelivery ? { delivery: true as const } : {}) })
          }}
        >
          <input
            type="text"
            className="ficus-field min-w-0 flex-1 px-2 py-1 text-xs"
            placeholder="https://github.com/owner/repo/issues/12 or https://linear.app/team/issue/KEY-123"
            aria-label="Link to track"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <label className="flex items-center gap-1 text-xs text-muted">
            <input
              type="checkbox"
              checked={deliverable && countsTowardDelivery}
              disabled={!deliverable}
              onChange={(event) => setCountsTowardDelivery(event.target.checked)}
            />
            Counts toward delivery
          </label>
          <button
            type="submit"
            className="ficus-button ficus-button-primary px-2.5 py-1 disabled:opacity-50 text-xs"
            disabled={add.isPending || !url.trim()}
          >
            Add
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {error.message}
        </p>
      )}
    </section>
  )
}
