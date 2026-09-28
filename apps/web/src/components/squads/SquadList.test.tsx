import { describe, expect, test } from 'bun:test'
import type { AgentStatus } from '@ficus/shared'
import { hasWorkingAgent } from './SquadList'

function agents(...statuses: AgentStatus[]) {
  return statuses.map((status, index) => ({ id: String(index), status }))
}

describe('hasWorkingAgent', () => {
  test('only exact active agents claim activity in progress', () => {
    expect(hasWorkingAgent(agents('active'))).toBe(true)
    expect(hasWorkingAgent(agents('idle'))).toBe(false)
    expect(hasWorkingAgent(agents('waiting-input'))).toBe(false)
    expect(hasWorkingAgent(agents('compacting'))).toBe(false)
    expect(hasWorkingAgent(agents('resetting'))).toBe(false)
    expect(hasWorkingAgent(agents('idle', 'active'))).toBe(true)
  })
})
