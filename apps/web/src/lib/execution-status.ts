import { EXECUTION_STATUS_ROLE, type ExecutionStatus } from '@ficus/shared'
import type { BadgeColor } from '../components/Badge'
import { webStatus } from './statusPresentation'

/** Badge colors for status pills */
export const executionStatusBadgeColors: Record<ExecutionStatus, BadgeColor> = Object.fromEntries(
  Object.entries(EXECUTION_STATUS_ROLE).map(([status, role]) => [status, webStatus(role).badgeColor])
) as Record<ExecutionStatus, BadgeColor>

/** Text-only colors for inline status indicators */
export const executionStatusTextColors: Record<ExecutionStatus, string> = Object.fromEntries(
  Object.entries(EXECUTION_STATUS_ROLE).map(([status, role]) => [status, webStatus(role).textClass])
) as Record<ExecutionStatus, string>

/** Single-character icons for status */
export const executionStatusIcons: Record<ExecutionStatus, string> = {
  queued: '○',
  'waiting-maintenance': '◌',
  'waiting-sandbox': '◌',
  running: '●',
  completed: '✓',
  stopping: '⊘',
  stopped: '⊘',
  failed: '✗',
}
