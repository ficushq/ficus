import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentStatus } from '@ficus/shared'
import { AgentActivityDot } from './AgentActivityDot'

const cases: Array<[AgentStatus, string, string]> = [
  ['active', 'Working', 'bg-status-progress-solid'],
  ['idle', 'Idle', 'bg-status-neutral-solid'],
  ['waiting-input', 'Waiting for input', 'bg-status-human-wait-solid'],
  ['compacting', 'Compacting', 'bg-status-attention-solid'],
  ['resetting', 'Resetting', 'bg-status-attention-solid'],
  ['dormant', 'Dormant', 'bg-status-neutral-solid'],
  ['terminated', 'Terminated', 'bg-status-neutral-solid'],
]

describe('AgentActivityDot', () => {
  for (const [status, label, colorClass] of cases) {
    test(`renders ${status} accessibly`, () => {
      const html = renderToStaticMarkup(<AgentActivityDot status={status} />)

      expect(html).toContain(`aria-label="Agent activity: ${label}"`)
      expect(html).toContain(`title="Agent activity: ${label}"`)
      expect(html).toContain(colorClass)
    })
  }
})
