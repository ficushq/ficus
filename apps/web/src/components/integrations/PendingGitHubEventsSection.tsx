import { useQuery } from '@tanstack/react-query'
import { githubFeedbackQueries } from '../../queryOptions'
import { useGitHubFeedbackReview } from './GitHubFeedbackReviewProvider'

/**
 * Compact squad Home/Work notice. Renders only after the server confirms held events (or failing
 * releases) for a human who can see them; hidden at a confirmed zero, while loading and on refusal.
 */
export function PendingGitHubEventsSection({ squadId, className = '' }: { squadId: string; className?: string }) {
  const review = useGitHubFeedbackReview(squadId)
  const summary = useQuery({ ...githubFeedbackQueries.summary(squadId), enabled: !!review && !!squadId })
  const data = summary.data
  if (!review || !data || (data.pending === 0 && data.failing === 0)) return null
  return (
    <section
      aria-label="Pending GitHub events"
      className={`ficus-inset flex flex-wrap items-center justify-between gap-3 px-3 py-3 ${className}`}
    >
      <div className="min-w-0">
        {data.pending > 0 && (
          <p className="text-sm text-primary">
            <strong>{data.pending}</strong> GitHub {data.pending === 1 ? 'event is' : 'events are'} waiting for review
          </p>
        )}
        {data.failing > 0 && (
          <p className="text-sm text-status-warning-600 dark:text-status-warning-400">
            {data.failing} approved {data.failing === 1 ? 'event has' : 'events have'} not been delivered yet
          </p>
        )}
        <p className="text-xs text-muted">
          Feedback from GitHub authors this squad doesn’t trust is held until someone allows it.
        </p>
      </div>
      <button
        type="button"
        className="ficus-button ficus-button-secondary shrink-0 px-3 py-2 text-sm"
        onClick={() => review.open(data.pending > 0 ? 'pending' : 'releasing')}
      >
        {data.pending > 0 ? 'Review' : 'View releases'}
      </button>
    </section>
  )
}
