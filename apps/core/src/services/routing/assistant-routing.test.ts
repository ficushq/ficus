import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import type { DecisionRequest, Message, MessageMetadata } from '@ficus/shared'
import { agents, db, messages } from '../../db'
import { Agent } from '../../entities/Agent'
import type { DecideOptions, DecisionOutcome } from '../decisions/service'
import { messageTextForModel } from '../chat/message-context'
import {
  ASSISTANT_ROUTING_TIMEOUT_MS,
  MAX_ROUTING_SQUADS,
  annotateAssistantMessage,
  buildRoutingRequest,
  decideAssistantRouting,
  findInheritedRouting,
  interpretRoutingAnswer,
  isAcknowledgement,
  loadRoutingContext,
  routingSkipReason,
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

  test("the user's words go only in state, with truncated recent entries", () => {
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
    expect(state.recent.map((entry) => entry.text.slice(0, 6))).toEqual(['first', 'second', 'third', 'xxxxxx'])
    expect(state.recent[3]!.text.length).toBe(300)
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

  test("the pick's own probability wins over a provider's confidence; refusals and unknown options are no answer", () => {
    // Jev reports confidence as how concentrated the probabilities are: 0.28 for a 52/41 split.
    expect(
      interpretRoutingAnswer(
        { type: 'choice', choice: 'instance', probabilities: { instance: 0.5 }, confidence: 0.8 },
        keys
      )?.hint
    ).toEqual({ scope: 'instance', confidence: 0.5 })
    expect(
      interpretRoutingAnswer({ type: 'choice', choice: 'instance', probabilities: {}, confidence: 0.8 }, keys)?.hint
    ).toEqual({
      scope: 'instance',
      confidence: 0.8,
    })
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

describe('skipping the decision', () => {
  test('only short acknowledgements are not asked about', () => {
    for (const text of ['ok', 'Thanks!', 'sounds good', 'yes please', 'Thank you so much', '👍', 'go ahead, do it'])
      expect(routingSkipReason(text)).toBe('acknowledgement')
    for (const text of ['ok fix the Chlea login', 'thanks, now refund 42', 'Chlea', 'The second one'])
      expect(routingSkipReason(text)).toBeNull()
    expect(isAcknowledgement('do it for Chlea instead')).toBe(false)
  })
})

describe('annotating a user message', () => {
  const both = (kind: string, kindP: number, scope: string, scopeP: number): DecisionOutcome => ({
    ok: true,
    result: {
      answers: {
        kind: { type: 'choice', choice: kind, probabilities: { [kind]: kindP } },
        scope: { type: 'choice', choice: scope, probabilities: { [scope]: scopeP } },
      },
      providerId: 'p1',
      model: 'clef',
      latencyMs: 12,
    },
  })
  const context = {
    recent: [
      { role: 'user' as const, text: 'Look at the Billing exports' },
      { role: 'assistant' as const, text: 'Billing is on it.' },
    ],
  }
  const inheritedFrom = {
    messageId: randomUUID(),
    hint: { scope: 'squad' as const, squadId: chlea.id, squadName: 'Chlea', confidence: 0.9 },
  }
  const deps = (
    decide: AssistantRoutingDeps['decide'],
    overrides: Partial<AssistantRoutingDeps> = {}
  ): AssistantRoutingDeps => ({
    decide,
    enabled: () => true,
    listSquads: async () => [chlea, billing],
    loadContext: async () => context,
    findInherited: async () => inheritedFrom,
    ...overrides,
  })

  test('one call asks the kind and the scope, with the context window only in state', async () => {
    const { decide, calls } = recordingDecide(() => both('new_request', 0.9, 'squad_a1b2c3d4', 0.91))
    await annotateAssistantMessage(user, message('Fix the crash'), deps(decide))
    expect(calls).toHaveLength(1)
    expect(Object.keys(calls[0]!.request.questions)).toEqual(['kind', 'scope'])
    const kind = calls[0]!.request.questions.kind
    if (kind?.type !== 'choice') throw new Error('expected a choice')
    expect(Object.keys(kind.options)).toEqual(['new_request', 'follow_up', 'conversation'])
    expect(calls[0]!.request.state).toEqual({ message: 'Fix the crash', recent: context.recent })
    expect(JSON.stringify(calls[0]!.request.questions)).not.toContain('Billing exports')
  })

  test('a confident new request gets the hint on the message and into the model text', async () => {
    const { decide } = recordingDecide(() => both('new_request', 0.8, 'squad_a1b2c3d4', 0.91))
    const original = message('Fix the crash')
    const result = await annotateAssistantMessage(user, original, deps(decide))
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

  test('a target below the threshold gets nothing, whatever the kind', async () => {
    for (const outcome of [
      both('new_request', 0.9, 'squad_a1b2c3d4', 0.55),
      both('conversation', 0.9, 'general', 0.5),
    ]) {
      const original = message('Fix the crash')
      const result = await annotateAssistantMessage(user, original, deps(recordingDecide(() => outcome).decide))
      expect(result).toBe(original)
      expect(messageTextForModel(result)).toBe('Fix the crash')
    }
  })

  test('the target decides, not the kind: an unsure kind with a confident squad gets the hint', async () => {
    // "what's up with the tau squad": new_request 0.52 vs conversation 0.41, squad 0.94.
    const { decide } = recordingDecide(() => both('new_request', 0.52, 'squad_a1b2c3d4', 0.94))
    const result = await annotateAssistantMessage(user, message("What's up with the Chlea squad?"), deps(decide))
    expect(result.metadata?.assistantRouting).toMatchObject({ scope: 'squad', squadId: chlea.id, confidence: 0.94 })
  })

  test('instance and general new requests tell the Assistant to use no squad', async () => {
    const { decide } = recordingDecide(() => both('new_request', 0.9, 'instance', 0.88))
    const result = await annotateAssistantMessage(user, message('Add a user named Edith'), deps(decide))
    expect(messageTextForModel(result)).toContain('about Ficus itself')
    expect(messageTextForModel(result)).toContain('Use no squad for delegate_task')
  })

  test('conversation about a squad is still for that squad; general conversation is a general hint', async () => {
    const about = recordingDecide(() => both('conversation', 0.95, 'squad_a1b2c3d4', 0.9))
    const squadResult = await annotateAssistantMessage(
      user,
      message('What do you think about splitting Chlea in two?'),
      deps(about.decide)
    )
    expect(squadResult.metadata?.assistantRouting).toMatchObject({ scope: 'squad', squadId: chlea.id })
    // General is saved for the model; the web shows no chip for it.
    const general = recordingDecide(() => both('conversation', 0.95, 'general', 0.9))
    const generalResult = await annotateAssistantMessage(
      user,
      message('What do you think about AI?'),
      deps(general.decide)
    )
    expect(generalResult.metadata?.assistantRouting).toMatchObject({ scope: 'general' })
  })

  test('a follow-up inherits the latest routing for the model only, with no chip', async () => {
    const { decide } = recordingDecide(() => both('follow_up', 0.9, 'squad_b2c3d4e5', 0.95))
    const result = await annotateAssistantMessage(user, message('Any progress on that?'), deps(decide))
    expect(result.metadata?.assistantRouting).toBeUndefined()
    expect(result.metadata?.assistantRoutingInherited).toEqual({
      scope: 'squad',
      squadId: chlea.id,
      squadName: 'Chlea',
      fromMessageId: inheritedFrom.messageId,
    })
    expect(messageTextForModel(result)).toContain(
      `Routing (follows this conversation's earlier routing): squad "Chlea" (squadId ${chlea.id})`
    )
  })

  test("a follow-up inherits the user's correction over the model's pick", async () => {
    const { decide } = recordingDecide(() => both('follow_up', 0.9, 'general', 0.9))
    const corrected = {
      messageId: inheritedFrom.messageId,
      hint: { ...inheritedFrom.hint, correction: { scope: 'none' as const, at: '2026-10-08T00:00:00.000Z' } },
    }
    const result = await annotateAssistantMessage(
      user,
      message('Also do the same for Android'),
      deps(decide, { findInherited: async () => corrected })
    )
    expect(result.metadata?.assistantRoutingInherited).toEqual({
      scope: 'none',
      fromMessageId: inheritedFrom.messageId,
    })
    expect(messageTextForModel(result)).toContain('not for a squad. Keep using no squad for delegate_task')
  })

  test('a follow-up with no earlier routing falls back to its own target', async () => {
    const { decide } = recordingDecide(() => both('follow_up', 0.9, 'squad_a1b2c3d4', 0.9))
    const result = await annotateAssistantMessage(
      user,
      message('Any progress on the Chlea crash?'),
      deps(decide, { findInherited: async () => null })
    )
    expect(result.metadata?.assistantRoutingInherited).toBeUndefined()
    expect(result.metadata?.assistantRouting).toMatchObject({ scope: 'squad', squadId: chlea.id })
  })

  test('acknowledgements make no decision call', async () => {
    const { decide, calls } = recordingDecide(() => both('new_request', 0.9, 'general', 0.9))
    const ack = message('Thanks, sounds good!')
    expect(await annotateAssistantMessage(user, ack, deps(decide))).toBe(ack)
    expect(calls).toHaveLength(0)
  })

  describe('a reply after the Assistant asks a question is asked, and routed by kind', () => {
    const asked = {
      recent: [
        { role: 'user' as const, text: 'The export is broken' },
        { role: 'assistant' as const, text: 'Which app, Chlea or the web app?' },
      ],
    }

    test('a new ask in the reply gets the hint and chip', async () => {
      const { decide, calls } = recordingDecide(() => both('new_request', 0.85, 'squad_a1b2c3d4', 0.9))
      const result = await annotateAssistantMessage(
        user,
        message('Chlea, and please fix the login crash there too'),
        deps(decide, { loadContext: async () => asked })
      )
      expect(calls).toHaveLength(1)
      expect((calls[0]!.request.state as { recent: unknown[] }).recent).toEqual(asked.recent)
      expect(result.metadata?.assistantRouting).toMatchObject({ scope: 'squad', squadName: 'Chlea' })
    })

    test('answering in the reply is routed by its target too', async () => {
      const { decide, calls } = recordingDecide(() => both('conversation', 0.9, 'squad_a1b2c3d4', 0.9))
      const result = await annotateAssistantMessage(
        user,
        message('Probably the Chlea one, but let me think about it'),
        deps(decide, { loadContext: async () => asked })
      )
      expect(calls).toHaveLength(1)
      expect(result.metadata?.assistantRouting).toMatchObject({ scope: 'squad', squadId: chlea.id })
    })
  })

  test('only user chat messages are routed, once', async () => {
    const { decide, calls } = recordingDecide(() => both('new_request', 0.9, 'general', 0.9))
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

describe('conversation context from saved messages', () => {
  const agentIds: string[] = []
  afterEach(async () => {
    if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds.splice(0)))
  })

  async function conversation(
    rows: Array<{ role: 'human' | 'assistant'; content: string; metadata?: MessageMetadata }>
  ) {
    const agent = await Agent.create({ agentTypeId: 'system-manager', context: {} })
    agentIds.push(agent.id)
    const start = Date.now() - 60_000
    const saved = await db
      .insert(messages)
      .values(
        rows.map((row, index) => ({
          agentId: agent.id,
          role: row.role,
          content: row.content,
          pending: false,
          metadata: row.metadata ?? (row.role === 'human' ? { source: 'user_chat' } : {}),
          createdAt: new Date(start + index * 1000),
        }))
      )
      .returning()
    // The message being routed comes after every saved row.
    return { saved, next: { id: randomUUID(), agentId: agent.id, createdAt: new Date() } }
  }

  test('the window is the user’s last four messages and the Assistant’s latest reply, truncated', async () => {
    const { next } = await conversation([
      { role: 'human', content: 'one' },
      { role: 'assistant', content: 'old reply' },
      { role: 'human', content: 'two' },
      { role: 'human', content: 'update', metadata: { source: 'inbox' } },
      { role: 'human', content: '[System] Context compacted successfully.' },
      { role: 'human', content: 'three' },
      { role: 'assistant', content: 'r'.repeat(500) },
      { role: 'human', content: 'four' },
      { role: 'human', content: 'five' },
    ])
    const context = await loadRoutingContext(next)
    expect(context.recent.map((entry) => `${entry.role}:${entry.text.slice(0, 5)}`)).toEqual([
      'user:two',
      'user:three',
      'assistant:rrrrr',
      'user:four',
      'user:five',
    ])
    expect(context.recent[2]!.text.length).toBe(300)
  })

  test("the Assistant's question is the latest reply in the window, for the kind question to judge", async () => {
    const { next } = await conversation([
      { role: 'human', content: 'Fix the export' },
      { role: 'assistant', content: 'Which platform, **iOS or Android?**' },
    ])
    expect((await loadRoutingContext(next)).recent).toEqual([
      { role: 'user', text: 'Fix the export' },
      { role: 'assistant', text: 'Which platform, **iOS or Android?**' },
    ])
  })

  test('the inherited routing is the latest hinted or corrected user message', async () => {
    const hint = { scope: 'squad' as const, squadId: chlea.id, squadName: 'Chlea', confidence: 0.9 }
    const corrected = { ...hint, correction: { scope: 'none' as const, at: '2026-10-08T00:00:00.000Z' } }
    const { saved, next } = await conversation([
      { role: 'human', content: 'Fix Chlea', metadata: { source: 'user_chat', assistantRouting: hint } },
      { role: 'human', content: 'Refund 42', metadata: { source: 'user_chat', assistantRouting: corrected } },
      { role: 'human', content: 'How is it going?' },
    ])
    expect(await findInheritedRouting(next)).toEqual({ messageId: saved[1]!.id, hint: corrected })
    const none = await conversation([{ role: 'human', content: 'Hello' }])
    expect(await findInheritedRouting(none.next)).toBeNull()
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
