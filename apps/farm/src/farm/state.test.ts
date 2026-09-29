import { describe, expect, it } from 'bun:test'
import {
  selectWorkStreamPresentationState,
  workStreamNeedsHumanAttention,
  type WorkStream,
  type WorkStreamPresentationState,
} from '@ficus/shared'
import { WORK_STREAM_PRESENTATION_CASES } from '@ficus/shared/test-fixtures/work-stream-presentation'
import { askingAgentIds, badgeFor, faceFor, haltedAgentIds, isHaltedAgent, isRunning, plantStateFor } from './state'
import type { PlantState } from './types'
import { makeAgent, makeAgentError, makeStream, makeWait } from './testFixtures'

const pause = { id: 'p', pausedAt: '2026-09-21T00:00:00Z', reason: null, parkAt: null, agentIds: [] }
const active: Partial<WorkStream> = { status: 'active', openWaits: [], derivedState: undefined }

/** A stream carrying exactly these presentation facts. */
function facts(overrides: Partial<WorkStream>): WorkStream {
  return makeStream({
    derivedState: undefined,
    openWaits: undefined,
    delivery: undefined,
    pause: undefined,
    ...overrides,
  })
}

const CASES: {
  name: string
  stream: WorkStream
  presentation: WorkStreamPresentationState
  plant: PlantState | null
}[] = [
  { name: 'done', stream: facts({ status: 'done' }), presentation: 'done', plant: null },
  { name: 'canceled', stream: facts({ status: 'canceled' }), presentation: 'canceled', plant: null },
  { name: 'queued', stream: facts({ status: 'queued', openWaits: [] }), presentation: 'queued', plant: 'queued' },
  {
    name: 'queued behind dependencies',
    stream: facts({ status: 'queued', openWaits: [], waitingOnDependencies: true }),
    presentation: 'queued',
    plant: 'waiting',
  },
  {
    name: 'dependency wait',
    stream: facts({ ...active, openWaits: [makeWait('dependency')] }),
    presentation: 'waiting_on_dependency',
    plant: 'waiting',
  },
  { name: 'paused', stream: facts({ ...active, pause }), presentation: 'paused', plant: 'paused' },
  {
    name: 'paused beats a question',
    stream: facts({ ...active, pause, openWaits: [makeWait('question')] }),
    presentation: 'paused',
    plant: 'paused',
  },
  {
    name: 'in progress',
    stream: facts({ ...active, derivedState: 'in_progress' }),
    presentation: 'in_progress',
    plant: 'growing',
  },
  { name: 'legacy active', stream: facts({ status: 'active' }), presentation: 'active', plant: 'growing' },
  {
    name: 'question',
    stream: facts({ ...active, openWaits: [makeWait('question')] }),
    presentation: 'waiting_on_answer',
    plant: 'question',
  },
  {
    name: 'review wait',
    stream: facts({ ...active, openWaits: [makeWait('review')] }),
    presentation: 'in_review',
    plant: 'review',
  },
  {
    name: 'workflow approval gate (manual wait resolved by the workflow)',
    stream: facts({ ...active, openWaits: [makeWait('manual', { resolutionHandler: 'workflow', flowAttemptId: 3 })] }),
    presentation: 'in_review',
    plant: 'review',
  },
  {
    name: 'delivery approval',
    stream: facts({ ...active, delivery: { kind: 'approval' } }),
    presentation: 'delivery_approval',
    plant: 'review',
  },
  {
    name: 'delivery review',
    stream: facts({ ...active, delivery: { kind: 'review' } }),
    presentation: 'delivery_review',
    plant: 'review',
  },
  {
    name: 'delivery merge',
    stream: facts({ ...active, delivery: { kind: 'merge' } }),
    presentation: 'delivery_merge',
    plant: 'review',
  },
  {
    name: 'delivery external (CI / code host)',
    stream: facts({ ...active, delivery: { kind: 'external' } }),
    presentation: 'delivery_external',
    plant: 'delivering',
  },
  {
    name: 'delivery setup',
    stream: facts({ ...active, delivery: { kind: 'setup' } }),
    presentation: 'delivery_setup',
    plant: 'failed',
  },
  {
    name: 'delivery failure',
    stream: facts({ ...active, delivery: { kind: 'failure' } }),
    presentation: 'delivery_failure',
    plant: 'failed',
  },
  {
    name: 'manual blocker',
    stream: facts({ ...active, openWaits: [makeWait('manual')] }),
    presentation: 'blocked',
    plant: 'blocked',
  },
  {
    name: 'manual blocker beats delivery',
    stream: facts({ ...active, openWaits: [makeWait('manual')], delivery: { kind: 'merge' } }),
    presentation: 'blocked',
    plant: 'blocked',
  },
  {
    name: 'dependency beats manual (precedence)',
    stream: facts({ ...active, openWaits: [makeWait('manual'), makeWait('dependency')] }),
    presentation: 'waiting_on_dependency',
    plant: 'waiting',
  },
  {
    name: 'legacy blocked (no wait list)',
    stream: facts({ status: 'active', derivedState: 'blocked' }),
    presentation: 'blocked',
    plant: 'blocked',
  },
  { name: 'idle', stream: facts({ ...active }), presentation: 'idle', plant: 'idle' },
  {
    name: 'stale review collapses to idle',
    stream: facts({ ...active, derivedState: 'in_review' }),
    presentation: 'idle',
    plant: 'idle',
  },
  {
    name: 'execution failed',
    stream: facts({ ...active, derivedState: 'execution_failed' }),
    presentation: 'execution_failed',
    plant: 'failed',
  },
]

describe('plantStateFor', () => {
  for (const { name, stream, presentation, plant } of CASES) {
    it(`${name} → ${plant}`, () => {
      expect(selectWorkStreamPresentationState(stream)).toBe(presentation)
      expect(plantStateFor(stream)).toBe(plant)
    })
  }

  it('covers every presentation state', () => {
    const covered = new Set(CASES.map((c) => c.presentation))
    const all: WorkStreamPresentationState[] = [
      'queued',
      'active',
      'done',
      'canceled',
      'paused',
      'in_progress',
      'in_review',
      'waiting_on_answer',
      'waiting_on_dependency',
      'blocked',
      'idle',
      'execution_failed',
      'delivery_approval',
      'delivery_review',
      'delivery_merge',
      'delivery_external',
      'delivery_setup',
      'delivery_failure',
    ]
    expect(all.filter((state) => !covered.has(state))).toEqual([])
  })

  it('draws an unknown future state as growing', () => {
    const stream = facts({ status: 'active', derivedState: 'something_new' as never })
    expect(plantStateFor(stream)).toBe('growing')
  })
})

describe('badgeFor', () => {
  it('badges question, review and blocked plants only', () => {
    const badges = Object.fromEntries(CASES.map((c) => [c.name, c.plant && badgeFor(c.plant, c.stream)]))
    expect(badges['question']).toBe('question')
    expect(badges['review wait']).toBe('harvest')
    expect(badges['delivery merge']).toBe('harvest')
    // Waiting on the code host asks nothing of you: an hourglass on the plant, no badge.
    expect(badges['delivery external (CI / code host)']).toBeNull()
    expect(badges['manual blocker']).toBe('blocked')
    expect(badges['legacy blocked (no wait list)']).toBe('blocked')
    expect(badges['in progress']).toBeNull()
    expect(badges['idle']).toBeNull()
    expect(badges['execution failed']).toBeNull()
    expect(badges['dependency wait']).toBeNull()
    expect(badges['paused beats a question']).toBeNull()
  })

  it('shows a badge exactly when the shared attention aggregate counts the stream', () => {
    for (const { name, stream, plant } of CASES) {
      if (!plant) {
        expect(workStreamNeedsHumanAttention(stream)).toBe(false)
        continue
      }
      expect({ name, badge: badgeFor(plant, stream) !== null }).toEqual({
        name,
        badge: workStreamNeedsHumanAttention(stream),
      })
    }
  })

  it('agrees with the shared presentation contract cases', () => {
    for (const contract of WORK_STREAM_PRESENTATION_CASES) {
      const stream = facts(contract.facts as Partial<WorkStream>)
      const plant = plantStateFor(stream)
      const badge = plant ? badgeFor(plant, stream) : null
      expect({ name: contract.name, badge: badge !== null }).toEqual({ name: contract.name, badge: contract.attention })
    }
  })
})

describe('faces', () => {
  it('maps agent status to a face', () => {
    expect(faceFor(makeAgent({ status: 'active' }))).toBe('happy')
    expect(faceFor(makeAgent({ status: 'compacting' }))).toBe('happy')
    expect(faceFor(makeAgent({ status: 'resetting' }))).toBe('happy')
    expect(faceFor(makeAgent({ status: 'waiting-input' }))).toBe('question')
    expect(faceFor(makeAgent({ status: 'idle' }))).toBe('normal')
    expect(faceFor(makeAgent({ status: 'dormant' }))).toBe('sleepy')
    expect(faceFor(makeAgent({ status: 'terminated' }))).toBe('sleepy')
  })

  it('shows the error face for a halted agent whatever its status', () => {
    const agent = makeAgent({ id: 'a', status: 'waiting-input' })
    const actions = [makeAgentError('a')]
    expect(isHaltedAgent(agent, actions)).toBe(true)
    expect(faceFor(agent, isHaltedAgent(agent, actions))).toBe('error')
    expect(faceFor(makeAgent({ status: 'idle' }), true)).toBe('error')
  })

  it('detects halted agents only from agent-error actions for that agent', () => {
    const agent = makeAgent({ id: 'a' })
    const question = { ...makeAgentError('a'), type: 'agent-question' as const }
    expect(isHaltedAgent(agent, [question])).toBe(false)
    expect(isHaltedAgent(agent, [makeAgentError('b')])).toBe(false)
    expect([...haltedAgentIds([makeAgentError('a'), makeAgentError('b'), question])]).toEqual(['a', 'b'])
  })

  it('finds agents asking you something, from agent and squad questions only', () => {
    const agentQuestion = { ...makeAgentError('a'), type: 'agent-question' as const }
    const squadQuestion = { ...makeAgentError('m'), type: 'squad-question' as const }
    expect([...askingAgentIds([agentQuestion, squadQuestion, makeAgentError('b')])]).toEqual(['a', 'm'])
  })
})

describe('isRunning', () => {
  it('is true for working statuses and for halted agents', () => {
    for (const status of ['active', 'waiting-input', 'compacting', 'resetting'] as const) {
      expect(isRunning(makeAgent({ status }))).toBe(true)
    }
    for (const status of ['idle', 'dormant', 'terminated'] as const) {
      expect(isRunning(makeAgent({ status }))).toBe(false)
    }
    expect(isRunning(makeAgent({ status: 'idle' }), true)).toBe(true)
  })
})
