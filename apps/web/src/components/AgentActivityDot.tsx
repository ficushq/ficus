import clsx from 'clsx'
import { AGENT_STATUS_ROLE, type AgentStatus } from '@ficus/shared'
import { AGENT_STATUS_LABELS } from '../lib/agentDisplay'
import { webStatus } from '../lib/statusPresentation'

export function AgentActivityDot({ status, className }: { status: AgentStatus; className?: string }) {
  const description = `Agent activity: ${AGENT_STATUS_LABELS[status]}`
  const treatment = webStatus(AGENT_STATUS_ROLE[status])

  return (
    <span
      role="img"
      aria-label={description}
      title={description}
      className={clsx('inline-block h-2 w-2 shrink-0 rounded-full', treatment.markerClass, className)}
    />
  )
}
