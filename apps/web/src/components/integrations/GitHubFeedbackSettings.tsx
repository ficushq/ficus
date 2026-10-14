import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GitHubUntrustedHandling } from '@ficus/shared'
import { ApiError } from '../../api/client'
import {
  githubFeedbackErrorMessage,
  screenPendingGitHubFeedback,
  setGitHubAuthorFilter,
  setGitHubUntrustedHandling,
} from '../../api/githubFeedback'
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl'
import { githubFeedbackQueries } from '../../queryOptions'
import { githubFeedbackQueryKeys } from '../../queryKeys'
import { GitHubFeedbackReviewProvider, useGitHubFeedbackReview } from './GitHubFeedbackReviewProvider'
import { GitHubTrustedAuthors } from './GitHubTrustedAuthors'

/**
 * Squad settings for GitHub author filtering. Composed beside (never inside) the integration rule
 * form so moderation refreshes cannot touch unsaved rule drafts, and shown independently of the
 * integration-credential permissions: squad-update humans manage trust without integration admin.
 */
export function GitHubFeedbackSettings({ squadId }: { squadId: string }) {
  const review = useGitHubFeedbackReview(squadId)
  if (review) return <GitHubFeedbackSettingsBody squadId={squadId} />
  // Rendered outside the squad page (no shared modal): own a provider so the action still works.
  return (
    <GitHubFeedbackReviewProvider squadId={squadId}>
      <GitHubFeedbackSettingsBody squadId={squadId} />
    </GitHubFeedbackReviewProvider>
  )
}

const HANDLING_OPTIONS: readonly SegmentedControlOption<GitHubUntrustedHandling>[] = [
  { value: 'hold', label: 'Hold for review', title: 'Hold for review until trusted' },
  { value: 'screen', label: 'Screen with a model', title: 'Let a decision model screen it' },
]

const HANDLING_HELP: Record<GitHubUntrustedHandling, string> = {
  hold: 'Feedback from people this squad doesn’t trust waits here until someone allows it or trusts its author.',
  screen:
    'A decision model checks feedback from people this squad doesn’t trust for instructions aimed at agents. If it’s confident the feedback is safe, it’s delivered once, and its author still isn’t trusted. Anything else, including when no model answers, is held here with the model’s verdict.',
}

function GitHubFeedbackSettingsBody({ squadId }: { squadId: string }) {
  const client = useQueryClient()
  const review = useGitHubFeedbackReview(squadId)
  const summary = useQuery(githubFeedbackQueries.summary(squadId))
  const [confirmOff, setConfirmOff] = useState(false)
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const handlingChange = useMutation({
    mutationFn: (handling: GitHubUntrustedHandling) => setGitHubUntrustedHandling(squadId, handling),
    onMutate: () => {
      setMessage(null)
      setOfferScreen(false)
    },
    onSuccess: async (result) => {
      // Right after switching to screening is when held feedback is worth screening.
      setOfferScreen(result.handling === 'screen')
      await client.invalidateQueries({ queryKey: githubFeedbackQueryKeys.squad(squadId) })
    },
    onError: (error) => {
      setMessage({
        tone: 'error',
        text: githubFeedbackErrorMessage(error, "Couldn't change how untrusted feedback is handled."),
      })
    },
  })
  const [offerScreen, setOfferScreen] = useState(false)
  const screenPending = useMutation({
    mutationFn: () => screenPendingGitHubFeedback(squadId),
    onMutate: () => setMessage(null),
    onSuccess: async (result) => {
      setOfferScreen(false)
      setMessage({
        tone: 'info',
        text:
          result.queued > 0
            ? `${result.queued} held ${result.queued === 1 ? 'event is' : 'events are'} being screened. Anything not clearly safe stays held here.${result.more ? ' More are waiting; screen again to continue.' : ''}`
            : 'Nothing new to screen. Held events already have a screen or a verdict.',
      })
      await client.invalidateQueries({ queryKey: githubFeedbackQueryKeys.squad(squadId) })
    },
    onError: (error) => {
      setMessage({ tone: 'error', text: githubFeedbackErrorMessage(error, "Couldn't screen held events.") })
    },
  })
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setGitHubAuthorFilter(squadId, enabled),
    onMutate: () => setMessage(null),
    onSuccess: async (result) => {
      setConfirmOff(false)
      setMessage({
        tone: 'info',
        text: result.enabled
          ? 'Author filtering is on. New feedback that isn’t from a trusted author will be held for review.'
          : result.released > 0
            ? `Author filtering is off. ${result.released} held ${result.released === 1 ? 'event was' : 'events were'} allowed and queued for release.`
            : 'Author filtering is off.',
      })
      await client.invalidateQueries({ queryKey: githubFeedbackQueryKeys.squad(squadId) })
    },
    onError: (error) => {
      setConfirmOff(false)
      setMessage({ tone: 'error', text: githubFeedbackErrorMessage(error, "Couldn't change author filtering.") })
    },
  })

  // Agents, signed-out sessions and users without squad access get no moderation surface at all.
  if (summary.isError) {
    if (summary.error instanceof ApiError && summary.error.status >= 400 && summary.error.status < 500) return null
    return (
      <div role="alert" className="space-y-2 text-sm text-status-danger-600 dark:text-status-danger-400">
        <p>Couldn’t load GitHub feedback review settings.</p>
        <button
          type="button"
          className="ficus-button ficus-button-secondary px-3 py-1.5"
          onClick={() => summary.refetch()}
        >
          Try again
        </button>
      </div>
    )
  }
  if (!summary.data)
    return (
      <p role="status" className="text-sm text-muted">
        Loading GitHub feedback settings…
      </p>
    )
  const { authorFilterEnabled: enabled, pending, releasing, failing, canModerate } = summary.data
  const handling: GitHubUntrustedHandling =
    (handlingChange.isPending ? handlingChange.variables : summary.data.untrustedHandling) === 'screen'
      ? 'screen'
      : 'hold'
  const modelConfigured = summary.data.decisionModelConfigured === true
  const screenable = summary.data.screenable ?? 0
  const screenLabel = screenPending.isPending
    ? 'Screening…'
    : offerScreen
      ? 'Screen them now'
      : `Screen ${screenable} waiting now`
  return (
    <section
      aria-labelledby={`github-feedback-${squadId}`}
      data-setting-target="github-feedback"
      className="space-y-4 rounded-lg border border-panel-border p-4"
    >
      <div>
        <h4 id={`github-feedback-${squadId}`} className="text-md font-medium text-primary">
          GitHub feedback review
        </h4>
        <p className="mt-1 text-sm text-muted">
          Comments and reviews on GitHub can come from anyone who can comment on a repository. With author filtering on,
          feedback is held here until a person allows it unless Ficus can confirm it came from someone this squad
          trusts. A few events, such as title or description edits and events found by polling, can be held even from
          trusted people because GitHub doesn’t confirm who made them.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-primary">
          <input
            type="checkbox"
            role="switch"
            aria-checked={enabled}
            checked={enabled}
            disabled={!canModerate || toggle.isPending}
            onChange={() => (enabled ? setConfirmOff(true) : toggle.mutate(true))}
          />
          Filter GitHub feedback by author
        </label>
        <span className="text-xs text-muted">{enabled ? 'On' : 'Off'}</span>
      </div>
      {enabled && (
        <div className="space-y-2">
          <p id={`github-untrusted-${squadId}`} className="text-sm text-primary">
            Feedback from untrusted authors
          </p>
          <SegmentedControl
            ariaLabel="Feedback from untrusted authors"
            options={HANDLING_OPTIONS}
            value={handling}
            onChange={(next) => next !== handling && handlingChange.mutate(next)}
            disabled={!canModerate || handlingChange.isPending}
          />
          <p className="text-xs text-muted">{HANDLING_HELP[handling]}</p>
          {handling === 'screen' && canModerate && (screenable > 0 || screenPending.isPending) && (
            <div className="flex flex-wrap items-center gap-3">
              {offerScreen && (
                <p className="text-sm text-primary">
                  {screenable} held {screenable === 1 ? 'event is' : 'events are'} waiting. Screen{' '}
                  {screenable === 1 ? 'it' : 'them'} now?
                </p>
              )}
              <button
                type="button"
                className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
                disabled={screenPending.isPending || !modelConfigured}
                title={modelConfigured ? undefined : 'Set up a decision model first'}
                onClick={() => screenPending.mutate()}
              >
                {screenLabel}
              </button>
            </div>
          )}
          {!modelConfigured && (
            <p
              className={clsx(
                'text-xs',
                handling === 'screen' ? 'text-status-warning-600 dark:text-status-warning-400' : 'text-muted'
              )}
            >
              {handling === 'screen'
                ? 'No decision model is set up for the GitHub firewall, so this feedback is still held for review. '
                : 'Screening needs a decision model. '}
              <Link to="/settings?section=decision-providers" className="text-accent-light hover:underline">
                Set one up in Settings → Decision Providers
              </Link>
              .
            </p>
          )}
        </div>
      )}
      {!enabled && (
        <p className="text-xs text-muted">
          Off: GitHub feedback that matches this squad’s rules reaches agents from any author, as it did before author
          filtering. Use this only if every repository this squad watches is private to people you trust.
        </p>
      )}
      {confirmOff && (
        <div role="group" aria-label="Confirm turning off author filtering" className="ficus-inset space-y-2 p-3">
          <p className="text-sm text-primary">
            Feedback from any GitHub author will reach agents without review.
            {pending > 0 &&
              ` The ${pending} held ${pending === 1 ? 'event' : 'events'} will be allowed and released to ${pending === 1 ? 'its' : 'their'} current recipients; any whose content can’t be read stay held for a decision.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(false)}
            >
              Turn off author filtering
            </button>
            <button
              type="button"
              className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
              onClick={() => setConfirmOff(false)}
            >
              Keep on
            </button>
          </div>
        </div>
      )}
      {!canModerate && (
        <p className="text-xs text-muted">You need permission to update this squad to change these settings.</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-primary">
          {pending} waiting for review · {releasing} being released
          {failing > 0 && ` (${failing} retrying)`}
        </p>
        <button
          type="button"
          className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
          disabled={!review}
          onClick={() => review?.open(pending > 0 || releasing === 0 ? 'pending' : 'releasing')}
        >
          Review events
        </button>
      </div>
      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`text-sm ${message.tone === 'error' ? 'text-status-danger-600 dark:text-status-danger-400' : 'text-muted'}`}
        >
          {message.text}
        </p>
      )}
      <GitHubTrustedAuthors squadId={squadId} />
    </section>
  )
}
