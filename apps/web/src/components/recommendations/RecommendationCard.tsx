import type { OperationsRecommendationSummary } from '@ficus/shared'
import { Badge, type BadgeColor } from '../Badge'

const CONFIDENCE_COLORS: Record<string, BadgeColor> = {
  high: 'danger',
  medium: 'attention',
  low: 'neutral',
}

export function RecommendationCard({ item, onOpen }: { item: OperationsRecommendationSummary; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="ficus-button w-full rounded-lg px-3 py-4 text-left transition-colors hover:bg-surface-hover  focus:ring-2 focus:ring-accent"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-medium text-primary">{item.title}</h3>
        <Badge color={CONFIDENCE_COLORS[item.confidence] ?? 'neutral'} className="shrink-0 capitalize">
          {item.confidence}
        </Badge>
      </div>
      <p className="mt-1.5 text-sm text-secondary">{item.summary}</p>
      <p className="mt-2.5 text-xs text-muted">
        {item.recurrence.executions} execution{item.recurrence.executions === 1 ? '' : 's'} ·{' '}
        {item.baseline.estimatedAvoidableRetries} estimated tool retr
        {item.baseline.estimatedAvoidableRetries === 1 ? 'y' : 'ies'}
      </p>
    </button>
  )
}
