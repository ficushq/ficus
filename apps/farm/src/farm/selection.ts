import type { PlantState, RobotRole } from './types'

export type Selection =
  | { kind: 'plot'; streamId: string }
  | { kind: 'robot'; agentId: string }
  | { kind: 'yard'; squadId: string }
  | { kind: 'hut'; squadId: string }
  | { kind: 'stand'; squadId: string }
  | { kind: 'assistant' }
  | { kind: 'mailbox' }
  | { kind: 'farmhouse' }
  | { kind: 'seedShed' }
  | { kind: 'crates' }
  | { kind: 'compost' }
  /** Another person on the farm (multiplayer), or you. */
  | { kind: 'person'; userId: string }

export function selectionKey(s: Selection | null): string | null {
  if (!s) return null
  switch (s.kind) {
    case 'plot':
      return `plot:${s.streamId}`
    case 'robot':
      return `robot:${s.agentId}`
    case 'yard':
      return `yard:${s.squadId}`
    case 'hut':
      return `hut:${s.squadId}`
    case 'stand':
      return `stand:${s.squadId}`
    case 'person':
      return `person:${s.userId}`
    default:
      return s.kind
  }
}

const PLANT_LABELS: Record<PlantState, string> = {
  queued: 'Planted, waiting its turn',
  growing: 'Growing',
  question: 'Has a question for you',
  review: 'Ready to harvest (needs your review)',
  blocked: 'Blocked, needs you to clear it',
  paused: 'Paused',
  waiting: 'Waiting on another plant',
  idle: 'Wilting, nobody is tending it',
  failed: 'Withered, a run failed',
}

export function plantStateLabel(state: PlantState): string {
  return PLANT_LABELS[state]
}

const ROLE_LABELS: Record<RobotRole, string> = {
  manager: 'Farmer',
  consultant: 'Consultant',
  assistant: 'Assistant',
  worker: 'Planter',
}

export function roleLabel(role: RobotRole): string {
  return ROLE_LABELS[role]
}
