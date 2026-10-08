import {
  OPERATIONS_RECOMMENDATION_TRANSITIONS,
  type OperationsRecommendationDetail,
  type OperationsRecommendationStatus,
} from '@ficus/shared'
import { Badge, type BadgeColor } from '../Badge'

const CONFIDENCE_COLORS: Record<string, BadgeColor> = {
  high: 'danger',
  medium: 'attention',
  low: 'neutral',
}

/** Detail body — rendered inside the shared Modal, which owns the title bar. */
export function RecommendationDetail({
  item,
  canUpdate,
  onStatus,
}: {
  item: OperationsRecommendationDetail
  canUpdate: boolean
  onStatus: (s: OperationsRecommendationStatus) => void
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge color={CONFIDENCE_COLORS[item.confidence] ?? 'neutral'} className="capitalize">
          {item.confidence} confidence
        </Badge>
        <Badge className="capitalize">{item.status}</Badge>
        <span className="text-xs text-muted">
          {item.recurrence.executions} execution{item.recurrence.executions === 1 ? '' : 's'} ·{' '}
          {item.baseline.estimatedAvoidableRetries} estimated tool retr
          {item.baseline.estimatedAvoidableRetries === 1 ? 'y' : 'ies'}
        </span>
      </div>
      <p className="text-sm text-secondary">{item.summary}</p>

      <div>
        <h3 className="text-sm font-semibold text-primary">Evidence</h3>
        {item.evidence.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">No evidence recorded.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {item.evidence.map((e) => (
              <li key={e.id} className="rounded-lg bg-surface-secondary p-2.5 text-sm text-secondary">
                {e.summary}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-primary">Audit trail</h3>
        {item.events.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">No activity yet.</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {item.events.map((e) => (
              <li key={e.id} className="text-sm text-secondary">
                <span className="capitalize">{e.action}</span> <span className="text-muted">· {e.actor}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {canUpdate && (
        <div className="flex flex-wrap gap-2 border-t border-th-border pt-4">
          {OPERATIONS_RECOMMENDATION_TRANSITIONS[item.status].map((s) => (
            <button
              key={s}
              onClick={() => onStatus(s)}
              className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-sm capitalize transition-colors"
            >
              {s === 'open' ? 'Reopen' : s}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
