import type { PlantState, RobotRole } from './types'

export type Selection =
  | { kind: 'plot'; streamId: string }
  | { kind: 'robot'; agentId: string }
  | { kind: 'yard'; squadId: string }
  | { kind: 'mailbox' }
  | { kind: 'farmhouse' }
  | { kind: 'seedShed' }
  | { kind: 'crates' }
  | { kind: 'compost' }

export function selectionKey(s: Selection | null): string | null {
  if (!s) return null
  switch (s.kind) {
    case 'plot':
      return `plot:${s.streamId}`
    case 'robot':
      return `robot:${s.agentId}`
    case 'yard':
      return `yard:${s.squadId}`
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
  paused: 'Paused under a cloche',
  waiting: 'Waiting on another plant',
  idle: 'Wilting, nobody is tending it',
  failed: 'Withered, a run failed',
}

export function plantStateLabel(state: PlantState): string {
  return PLANT_LABELS[state]
}

const ROLE_LABELS: Record<RobotRole, string> = {
  manager: 'Farmer (squad manager)',
  consultant: 'Consultant',
  assistant: 'Assistant',
  worker: 'Gardener',
}

export function roleLabel(role: RobotRole): string {
  return ROLE_LABELS[role]
}
