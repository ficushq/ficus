import type { GrantRisk } from './grantRisks'
import { WarningIcon } from '../../icons'

interface Props {
  risks: GrantRisk[]
}

const SEVERITY_STYLES: Record<GrantRisk['severity'], string> = {
  low: 'bg-status-progress-100 text-status-progress-800 dark:bg-status-progress-900/40 dark:text-status-progress-200',
  medium:
    'bg-status-attention-100 text-status-attention-900 dark:bg-status-attention-900/40 dark:text-status-attention-200',
  high: 'bg-status-danger-100 text-status-danger-900 dark:bg-status-danger-900/40 dark:text-status-danger-200',
}

export function GrantRiskBadge({ risks }: Props) {
  if (risks.length === 0) return null

  const highest = risks.reduce<GrantRisk['severity']>((acc, risk) => {
    if (risk.severity === 'high') return 'high'
    if (risk.severity === 'medium' && acc !== 'high') return 'medium'
    return acc
  }, 'low')

  return (
    <details className="inline-block">
      <summary
        className={`cursor-pointer inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded ${SEVERITY_STYLES[highest]}`}
      >
        <WarningIcon className="h-3.5 w-3.5" /> {risks.length} warning{risks.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-2 ml-4 space-y-1 text-xs text-secondary list-disc">
        {risks.map((risk) => (
          <li key={risk.code}>{risk.message}</li>
        ))}
      </ul>
    </details>
  )
}
