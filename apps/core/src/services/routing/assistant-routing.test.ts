import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { DecisionRequest, Message } from '@ficus/shared'
import type { DecideOptions, DecisionOutcome } from '../decisions/service'
import { messageTextForModel } from '../chat/message-context'
import {
  ASSISTANT_ROUTING_TIMEOUT_MS,
  MAX_ROUTING_SQUADS,
  annotateAssistantMessage,
  buildRoutingRequest,
  decideAssistantRouting,
  interpretRoutingAnswer,
  squadOptionKeys,
  suggestAssistantSquad,
  type AssistantRoutingDeps,
  type RoutingSquad,
} from './assistant-routing'

const chlea: RoutingSquad = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  name: 'Chlea',
  purpose: 'Builds the Chlea mobile app',
}
const billing: RoutingSquad = {
  id: 'b2c3d4e5-0000-4000-8000-000000000002',
  name: 'Billing',
  purpose: 'Invoices, refunds and payment flows',
}
const user = { type: 'user' as const, userId: randomUUID() }

/** A decide double that records each call and answers with what the test says. */
function recordingDecide(answer: (request: DecisionRequest) => DecisionOutcome | Promise<DecisionOutcome>) {
  const calls: Array<{ request: DecisionRequest; options: DecideOptions }> = []
  const decide: NonNullable<AssistantRoutingDeps['decide']> = async (_purpose, request, options) => {
    calls.push({ request, options })
    return answer(request)
  }
  return { decide, calls }
}

const answered = (choice: string, probabilities: Record<string, number>): DecisionOutcome => ({
  ok: true,
  result: {
    answers: { scope: { type: 'choice', choice, probabilities } },
    providerId: 'p1',
    model: 'clef',
    latencyMs: 12,
  },
})

function message(content: string, metadata: Message['metadata'] = { source: 'user_chat' }): Message {
  return {
    id: randomUUID(),
    agentId: randomUUID(),
    role: 'human',
    content,
    metadata,
    pending: true,
    createdAt: new Date(),
  }
}

describe('routing question', () => {
  test('offers instance, general and one squad_<short id> option per squad, described by name and purpose', () => {
    const { request, keys } = buildRoutingRequest({
      text: 'The login button crashes',
      recent: [],
      squads: [chlea, billing],
    })
    const question = request.questions.scope
    expect(question?.type).toBe('choice')
    if (question?.type !== 'choice') throw new Error('expected a choice')
    expect(Object.keys(question.options)).toEqual(['instance', 'general', 'squad_a1b2c3d4', 'squad_b2c3d4e5'])
    expect(question.options.squad_a1b2c3d4).toContain('"Chlea"')
    expect(question.options.squad_a1b2c3d4).toContain('Builds the Chlea mobile app')
    expect(keys.get('squad_b2c3d4e5')).toBe(billing)
  })

  test('short IDs grow only when two squads share a prefix', () => {
    const twin = { ...billing, id: 'a1b2c3d4-9999-4000-8000-000000000003' }
    expect([...squadOptionKeys([chlea, twin, billing]).keys()]).toEqual([
      'squad_a1b2c3d40000',
      'squad_a1b2c3d49999',
      'squad_b2c3d4e5',
    ])
  })

  test('caps the squads, keeping the ones whose purpose matches the message', () => {
    const many: RoutingSquad[] = Array.from({ length: 40 }, (_, index) => ({
      id: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      name: `Squad ${index}`,
      purpose: 'General engineering',
    }))
    many.push({ ...billing, id: 'ffffffff-0000-4000-8000-000000000000' })
    const { request, keys } = buildRoutingRequest({ text: 'Refund this invoice twice', recent: [], squads: many })
    expect(keys.size).toBe(MAX_ROUTING_SQUADS)
    const question = request.questions.scope
    if (question?.type !== 'choice') throw new Error('expected a choice')
    expect(Object.keys(question.options).length).toBe(MAX_ROUTING_SQUADS + 2)
    // Billing was last by name order, but the heuristic pre-filter keeps it.
    expect([...keys.values()]).toContain(many.at(-1)!)
    expect(keys.has('squad_ffffffff')).toBe(true)
  })

  test("the user's words go only in state, with a few truncated recent entries", () => {
    const text = 'Please fix the crash when I tap Export in Chlea'
    const recent = [
      { role: 'user' as const, text: 'first' },
      { role: 'assistant' as const, text: 'second' },
      { role: 'user' as const, text: 'third' },
      { role: 'assistant' as const, text: 'x'.repeat(1000) },
    ]
    const { request } = buildRoutingRequest({ text, recent, squads: [chlea] })
    expect(JSON.stringify(request.questions)).not.toContain('Export')
    const state = request.state as { message: string; recent: Array<{ role: string; text: string }> }
    expect(state.message).toBe(text)
    expect(state.recent.map((entry) => entry.text.slice(0, 6))).toEqual(['second', 'third', 'xxxxxx'])
    expect(state.recent[2]!.text.length).toBe(300)
  })
})

describe('reading the answer', () => {
  const keys = squadOptionKeys([chlea, billing])

  test('a squad pick carries its ID, name and confidence; the ranking follows the probabilities', () => {
    const outcome = interpretRoutingAnswer(
      {
        type: 'choice',
        choice: 'squad_a1b2c3d4',
        probabilities: { squad_a1b2c3d4: 0.91, general: 0.06, instance: 0.03 },
      },
      keys
    )
    expect(outcome?.hint).toEqual({ scope: 'squad', squadId: chlea.id, squadName: 'Chlea', confidence: 0.91 })
    expect(outcome?.ranked.map((entry) => entry.scope)).toEqual(['squad', 'general', 'instance'])
  })

  test('the reported confidence wins over the probability; refusals and unknown options are no answer', () => {
    expect(
      interpretRoutingAnswer(
        { type: 'choice', choice: 'instance', probabilities: { instance: 0.5 }, confidence: 0.8 },
        keys
      )?.hint
    ).toEqual({ scope: 'instance', confidence: 0.8 })
    expect(interpretRoutingAnswer({ type: 'refusal' }, keys)).toBeNull()
    expect(interpretRoutingAnswer({ type: 'choice', choice: 'squad_deadbeef', probabilities: {} }, keys)).toBeNull()
  })
})

describe('deciding', () => {
  const input = { text: 'Fix the Chlea crash', recent: [], squads: [chlea, billing] }

  test('asks nothing when the feature is off or there are no squads', async () => {
    const { decide, calls } = recordingDecide(() => answered('general', { general: 1 }))
    expect((await decideAssistantRouting(input, { decide, enabled: () => false })).reason).toBe('disabled')
    expect((await decideAssistantRouting({ ...input, squads: [] }, { decide, enabled: () => true })).reason).toBe(
      'no-squads'
    )
    expect(calls).toHaveLength(0)
  })

  test('asks for the assistant-routing purpose within the routing timeout', async () => {
    const { decide, calls } = recordingDecide(() => answered('squad_a1b2c3d4', { squad_a1b2c3d4: 0.9 }))
    const decision = await decideAssistantRouting(input, { decide, enabled: () => true })
    expect(decision.hint?.squadName).toBe('Chlea')
    expect(calls[0]!.options.timeoutMs).toBe(ASSISTANT_ROUTING_TIMEOUT_MS)
    expect(calls[0]!.options.signal?.aborted).toBe(false)
  })

  test('an unavailable provider means no hint', async () => {
    const { decide } = recordingDecide(() => ({ ok: false, reason: 'unavailable', errors: [] }))
    expect(await decideAssistantRouting(input, { decide, enabled: () => true })).toEqual({
      hint: null,
      ranked: [],
      reason: 'unavailable',
    })
  })

  test('a provider that never answers is abandoned at the deadline, not waited for', async () => {
    const { decide, calls } = recordingDecide(() => new Promise<DecisionOutcome>(() => {}))
    let deadline: { fire: () => void; ms: number } | undefined
    let cancelled = 0
    const pending = decideAssistantRouting(input, {
      decide,
      enabled: () => true,
      setTimer: (fire, ms) => {
        deadline = { fire, ms }
        return () => cancelled++
      },
    })
    await Promise.resolve()
    expect(deadline?.ms).toBe(ASSISTANT_ROUTING_TIMEOUT_MS)
    deadline!.fire()
    expect(await pending).toEqual({ hint: null, ranked: [], reason: 'timeout' })
    expect(calls[0]!.options.signal?.aborted).toBe(true)
    expect(cancelled).toBe(1)
  })
})

describe('annotating a user message', () => {
  const deps = (decide: AssistantRoutingDeps['decide']): AssistantRoutingDeps => ({
    decide,
    enabled: () => true,
    listSquads: async () => [chlea, billing],
    loadRecent: async () => [{ role: 'assistant', text: 'Which project?' }],
  })

  test('below the threshold the message is unchanged and the model reads no hint', async () => {
    const { decide, calls } = recordingDecide(() => answered('squad_a1b2c3d4', { squad_a1b2c3d4: 0.55, general: 0.45 }))
    const original = message('Fix the crash')
    const result = await annotateAssistantMessage(user, original, deps(decide))
    expect(calls).toHaveLength(1)
    expect(result).toBe(original)
    expect(messageTextForModel(result)).toBe('Fix the crash')
  })

  test('at or above the threshold the hint goes on the message and into the model text', async () => {
    const { decide, calls } = recordingDecide(() => answered('squad_a1b2c3d4', { squad_a1b2c3d4: 0.91, general: 0.09 }))
    const original = message('Fix the crash')
    const result = await annotateAssistantMessage(user, original, deps(decide))
    expect((calls[0]!.request.state as { recent: unknown[] }).recent).toEqual([
      { role: 'assistant', text: 'Which project?' },
    ])
    expect(result.metadata?.assistantRouting).toEqual({
      scope: 'squad',
      squadId: chlea.id,
      squadName: 'Chlea',
      confidence: 0.91,
    })
    expect(result.content).toBe('Fix the crash')
    const text = messageTextForModel(result)
    expect(text).toStartWith('Fix the crash')
    expect(text).toContain('Routing hint (decision model): likely squad "Chlea" (91%')
    expect(text).toContain(`squadId ${chlea.id}`)
    expect(text).toContain('Use this squad for delegate_task unless the request says otherwise.')
  })

  test('instance and general hints tell the Assistant to use no squad', async () => {
    const { decide } = recordingDecide(() => answered('instance', { instance: 0.88 }))
    const result = await annotateAssistantMessage(user, message('Add a user named Edith'), deps(decide))
    expect(messageTextForModel(result)).toContain('about Ficus itself')
    expect(messageTextForModel(result)).toContain('Use no squad for delegate_task')
  })

  test('only user chat messages are routed, once', async () => {
    const { decide, calls } = recordingDecide(() => answered('general', { general: 0.9 }))
    for (const skipped of [
      message('Task update', { source: 'inbox' }),
      message('[System] You said this is for Chlea.', { source: 'assistant_routing_correction' }),
      message('Again', { source: 'user_chat', assistantRouting: { scope: 'general', confidence: 0.9 } }),
      message('   '),
    ])
      expect(await annotateAssistantMessage(user, skipped, deps(decide))).toBe(skipped)
    expect(calls).toHaveLength(0)
  })

  test('an unavailable or disabled decision leaves the message as it was', async () => {
    const { decide } = recordingDecide(() => ({ ok: false, reason: 'unconfigured', errors: [] }))
    const original = message('Fix the crash')
    expect(await annotateAssistantMessage(user, original, deps(decide))).toBe(original)
    expect(await annotateAssistantMessage(user, original, { ...deps(decide), enabled: () => false })).toBe(original)
  })
})

describe('suggest_squad', () => {
  test('uses the decision model when it answers', async () => {
    const { decide, calls } = recordingDecide(() =>
      answered('squad_b2c3d4e5', { squad_b2c3d4e5: 0.7, squad_a1b2c3d4: 0.2, general: 0.1 })
    )
    const result = await suggestAssistantSquad(user, 'Refund invoice 42', {
      decide,
      enabled: () => true,
      listSquads: async () => [chlea, billing],
    })
    expect(calls[0]!.request.state).toEqual({ message: 'Refund invoice 42', recent: [] })
    expect(result).toMatchObject({
      source: 'decision-model',
      pick: { scope: 'squad', squadName: 'Billing', confidence: 0.7 },
      confident: true,
    })
    if (result.source !== 'decision-model') throw new Error('expected the decision model')
    expect(result.alternatives.map((entry) => entry.squadName ?? entry.scope)).toEqual(['Billing', 'Chlea', 'general'])
  })

  test('falls back to the purpose heuristic when no decision model answers', async () => {
    for (const deps of [
      { enabled: () => false },
      { enabled: () => true, decide: recordingDecide(() => ({ ok: false, reason: 'unavailable', errors: [] })).decide },
    ] satisfies AssistantRoutingDeps[]) {
      const result = await suggestAssistantSquad(user, 'Billing refunds', {
        ...deps,
        listSquads: async () => [chlea, billing],
      })
      expect(result.source).toBe('heuristic')
      if (result.source !== 'heuristic') throw new Error('expected the heuristic')
      expect(result.suggestions.map((entry) => entry.squadName)).toEqual(['Billing'])
      expect(result.recommendation).toBe('route')
    }
  })
})
