import type { Agent, Squad } from '@ficus/shared'
import type { RobotRole } from './types'

/** FNV-1a, 32-bit, over UTF-16 code units. Stable across sessions and machines. */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    h ^= text.charCodeAt(index)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** A stable choice from a non-empty list. */
export function pick<T>(list: readonly T[], seed: number): T {
  return list[(seed >>> 0) % list.length]!
}

/** Squad role of an agent. Assistants are identified by the caller, not here. */
export function roleFor(agent: Agent, squad?: Squad): RobotRole {
  if (agent.agentTypeId === 'manager' || (squad?.managerAgentId != null && squad.managerAgentId === agent.id))
    return 'manager'
  if (agent.agentTypeId === 'consultant') return 'consultant'
  return 'worker'
}
