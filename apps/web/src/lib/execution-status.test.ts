import { describe, expect, test } from 'bun:test'
import type { ExecutionStatus } from '@ficus/shared'
import { executionStatusBadgeColors, executionStatusTextColors } from './execution-status'

const cases: Array<[ExecutionStatus, string, string]> = [
  ['queued', 'queue', 'text-status-queue-fg'],
  ['waiting-maintenance', 'externalWait', 'text-status-external-wait-fg'],
  ['waiting-sandbox', 'externalWait', 'text-status-external-wait-fg'],
  ['running', 'progress', 'text-status-progress-fg'],
  ['stopping', 'attention', 'text-status-attention-fg'],
  ['stopped', 'neutral', 'text-status-neutral-fg'],
  ['completed', 'success', 'text-status-success-fg'],
  ['failed', 'danger', 'text-status-danger-fg'],
]

describe('execution status presentation', () => {
  test('uses the shared semantic role treatment for every execution state', () => {
    for (const [status, badge, textClass] of cases) {
      expect(executionStatusBadgeColors[status]).toBe(badge)
      expect(executionStatusTextColors[status]).toContain(textClass)
    }
    expect(Object.keys(executionStatusBadgeColors).sort()).toEqual(cases.map(([status]) => status).sort())
  })
})
