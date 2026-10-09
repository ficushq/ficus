import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { DecisionAnswer } from '@ficus/shared'
import { decisionFeatures, type DecisionOutcome } from '../services/decisions/service'
import { db } from '../db'
import { agents, agentTypes, executions, messages, squads, workStreams } from '../db/schema'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import {
  COMPOSER_DELIVERY_QUESTIONS,
  toolTarget,
  type ComposerDeliveryState,
  type DecideFn,
} from '../services/composer/delivery-suggestion'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'
import { createAgentDeliverySuggestionRouter } from './agent-delivery-suggestion'

const prefix = `delivery-suggestion-${crypto.randomUUID().slice(0, 8)}`
const typeId = `${prefix}-type`

// The injected decision model: records what it was asked and answers with `outcome`.
let enabled = true
let outcome: DecisionOutcome
const calls: Array<{ purpose: string; input: Parameters<DecideFn>[1]; options: Parameters<DecideFn>[2] }> = []
const decide: DecideFn = async (purpose, input, options) => {
  calls.push({ purpose, input, options })
  return outcome
}
const answered = (related: DecisionAnswer, now?: DecisionAnswer): DecisionOutcome => ({
  ok: true,
  result: {
    answers: { related, ...(now ? { now } : {}) },
    providerId: 'fake',
    model: 'fake-model',
    latencyMs: 3,
  },
})

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/agents', createAgentDeliverySuggestionRouter({ decide, isEnabled: () => enabled }))

let squad: Squad
let runner: TestUser
let reader: TestUser
let outsider: TestUser
let busy: Agent
let idle: Agent
let waiting: Agent
let executionId: string
let workStreamId: string

const DRAFT = 'Also make the login error message friendlier please'

async function ask(agentId: string, draft: unknown, user: TestUser | null = runner): Promise<Response> {
  return app.request(`/api/agents/${agentId}/delivery-suggestion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? authHeaders(user.token) : {}) },
    body: JSON.stringify({ draft }),
  })
}

function toolBlock(id: string, toolName: string, args: Record<string, unknown>) {
  return {
    type: 'tool_use',
    id,
    toolCall: { toolCallId: id, toolName, args: JSON.stringify(args), result: 'SECRET-TOOL-RESULT', isError: false },
  }
}

beforeAll(async () => {
  await AgentType.create({ id: typeId, name: 'Delivery suggestion', model: 'test:model', systemPrompt: 'test' })
  squad = await Squad.create({ name: `${prefix}-squad`, purpose: 'composer suggestions' })
  runner = await createTestUser({ prefix: `${prefix}-runner` })
  reader = await createTestUser({ prefix: `${prefix}-reader` })
  outsider = await createTestUser({ prefix: `${prefix}-outsider` })
  const runRole = await createTestRole({ prefix: `${prefix}-run`, permissions: ['agents:read', 'agents:run'] })
  const readRole = await createTestRole({ prefix: `${prefix}-read`, permissions: ['agents:read'] })
  await assignRole({ userId: runner.id, roleId: runRole.id, scope: 'squad', squadId: squad.id })
  await assignRole({ userId: reader.id, roleId: readRole.id, scope: 'squad', squadId: squad.id })

  busy = await Agent.create({ agentTypeId: typeId, squadId: squad.id })
  idle = await Agent.create({ agentTypeId: typeId, squadId: squad.id })
  waiting = await Agent.create({ agentTypeId: typeId, squadId: squad.id })
  await db.update(agents).set({ status: 'active' }).where(eq(agents.id, busy.id))
  await db.update(agents).set({ status: 'waiting-input' }).where(eq(agents.id, waiting.id))

  const [stream] = await db
    .insert(workStreams)
    .values({ squadId: squad.id, title: 'Login page polish', agentIds: [busy.id] })
    .returning({ id: workStreams.id })
  workStreamId = stream!.id

  const startedAt = new Date(Date.now() - 60_000)
  const [execution] = await db
    .insert(executions)
    .values({
      agentId: busy.id,
      status: 'running',
      message: 'Fix the login bug where the password field clears on error',
      latestText: 'I found the cause in LoginForm.tsx and I am now updating the reset logic.',
      startedAt,
    })
    .returning({ id: executions.id })
  executionId = execution!.id
  // The waiting agent has a live run too: a waiting-input agent is still not interruptible.
  await db.insert(executions).values({ agentId: waiting.id, status: 'running', message: 'Asked a question' })

  const at = (seconds: number) => new Date(startedAt.getTime() + seconds * 1000)
  await db.insert(messages).values([
    {
      agentId: busy.id,
      role: 'assistant',
      content: 'Looking at the form.',
      metadata: {
        executionId,
        content: [toolBlock('t1', 'read', { path: 'apps/web/src/auth/LoginForm.tsx' })],
      },
      createdAt: at(1),
    },
    {
      agentId: busy.id,
      role: 'assistant',
      content: '',
      metadata: {
        executionId,
        content: [
          toolBlock('t2', 'bash', { command: 'bun test apps/web/src/auth\necho done' }),
          toolBlock('t3', 'web_fetch', { url: 'https://example.com/docs/forms' }),
        ],
      },
      createdAt: at(2),
    },
    {
      agentId: busy.id,
      role: 'assistant',
      content: 'Updating the reset logic now.',
      metadata: {
        executionId,
        content: [toolBlock('t4', 'edit', { path: 'apps/web/src/auth/useLoginReset.ts', oldText: 'a', newText: 'b' })],
      },
      createdAt: at(3),
    },
    // Another execution's tool call never leaks into this one's state.
    {
      agentId: busy.id,
      role: 'assistant',
      content: 'Old run',
      metadata: { executionId: crypto.randomUUID(), content: [toolBlock('old', 'bash', { command: 'rm -rf old' })] },
      createdAt: at(4),
    },
  ])
})

afterAll(async () => {
  await db.delete(workStreams).where(eq(workStreams.id, workStreamId))
  await db.delete(agents).where(inArray(agents.id, [busy.id, idle.id, waiting.id]))
  await db.delete(squads).where(eq(squads.id, squad.id))
  await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
  await cleanupTestRbac(prefix)
})

beforeEach(() => {
  enabled = true
  calls.length = 0
  outcome = answered({ type: 'yesno', probability: 0.9 })
})

describe('POST /api/agents/:id/delivery-suggestion', () => {
  test('an idle agent gets no suggestion and no model call', async () => {
    const response = await ask(idle.id, DRAFT)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ suggestion: null })
    expect(calls).toHaveLength(0)
  })

  test('a waiting-input agent gets no suggestion: its next message answers it', async () => {
    expect(await (await ask(waiting.id, DRAFT)).json()).toEqual({ suggestion: null })
    expect(calls).toHaveLength(0)
  })

  test('the feature switched off gets no suggestion and no model call', async () => {
    enabled = false
    expect(await (await ask(busy.id, DRAFT)).json()).toEqual({ suggestion: null })
    expect(calls).toHaveLength(0)
  })

  test('a draft under three words gets no suggestion and no model call', async () => {
    expect(await (await ask(busy.id, '  fix   it ')).json()).toEqual({ suggestion: null })
    expect(calls).toHaveLength(0)
  })

  test('builds a short state from the database; user and agent text stay in the state', async () => {
    await ask(busy.id, DRAFT)
    expect(calls).toHaveLength(1)
    const [{ purpose, input, options }] = calls as [(typeof calls)[number]]
    expect(purpose).toBe('composer-delivery')
    expect(options).toMatchObject({ timeoutMs: 1500, source: { kind: 'composer', agentId: busy.id } })
    const state = input.state as ComposerDeliveryState
    expect(state).toEqual({
      asked: 'Fix the login bug where the password field clears on error',
      workStream: 'Login page polish',
      // The last three tool calls of this execution, oldest first, with short targets.
      recentTools: [
        'bash bun test apps/web/src/auth',
        'web_fetch https://example.com/docs/forms',
        'edit apps/web/src/auth/useLoginReset.ts',
      ],
      lastSaid: 'I found the cause in LoginForm.tsx and I am now updating the reset logic.',
      draft: DRAFT,
    })
    // Tool results and other executions never reach the model.
    expect(JSON.stringify(input)).not.toContain('SECRET-TOOL-RESULT')
    expect(JSON.stringify(input)).not.toContain('rm -rf old')
    // Instructions are fixed text: nothing the user or agent wrote is in them.
    expect(input.questions).toEqual(COMPOSER_DELIVERY_QUESTIONS)
    const instructions = JSON.stringify(input.questions)
    for (const text of [DRAFT, state.asked, state.lastSaid!, 'Login page polish', 'LoginForm']) {
      expect(instructions).not.toContain(text)
    }
    // About 800 tokens at most, at roughly four characters a token.
    expect(JSON.stringify(state).length).toBeLessThan(3400)
  })

  test('long text is truncated to the state budget', async () => {
    const long = `${'word '.repeat(700)}end`
    await ask(busy.id, long)
    const state = calls[0]!.input.state as ComposerDeliveryState
    expect(state.draft.length).toBeLessThanOrEqual(1200)
    expect(state.draft.endsWith('…')).toBe(true)
  })

  const yes = (probability: number): DecisionAnswer => ({ type: 'yesno', probability })

  test('related work suggests Interrupt', async () => {
    outcome = answered(yes(0.82), yes(0.6))
    expect(await (await ask(busy.id, DRAFT)).json()).toEqual({ suggestion: 'steer', related: 0.82, now: 0.6 })
  })

  test('a message that needs the agent now interrupts though it shares no topic with the work', async () => {
    // "how's it going" is not about the task, but it asks for an answer now.
    outcome = answered(yes(0.37), yes(0.83))
    expect(await (await ask(busy.id, "how's it going")).json()).toEqual({
      suggestion: 'steer',
      related: 0.37,
      now: 0.83,
    })
  })

  test('separate work that can wait suggests Follow up', async () => {
    outcome = answered(yes(0.12), yes(0.3))
    expect(await (await ask(busy.id, 'Unrelated: book the team offsite in Lisbon')).json()).toEqual({
      suggestion: 'follow-up',
      related: 0.12,
      now: 0.3,
    })
  })

  test('unsure either way suggests nothing, so the composer keeps its mode', async () => {
    for (const [related, now] of [
      [0.5, 0.5],
      [0.1, 0.6],
      [0.45, 0.2],
    ] as const) {
      outcome = answered(yes(related), yes(now))
      expect(await (await ask(busy.id, DRAFT)).json()).toEqual({ suggestion: null, related, now })
    }
  })

  test('an acknowledgement gets no suggestion and no model call', async () => {
    expect(await (await ask(busy.id, 'ok sounds good thanks')).json()).toEqual({ suggestion: null })
    expect(calls).toHaveLength(0)
  })

  test('asks both questions in one call', () => {
    expect(Object.keys(COMPOSER_DELIVERY_QUESTIONS)).toEqual(['related', 'now'])
  })

  test('no answer, a refusal or a missing question is no suggestion', async () => {
    for (const unanswered of [
      { ok: false, reason: 'unavailable', errors: [{ providerId: 'fake', error: 'timeout' }] },
      { ok: false, reason: 'unconfigured', errors: [] },
      answered({ type: 'refusal' }),
      { ok: true, result: { answers: {}, providerId: 'fake', model: 'm', latencyMs: 1 } },
    ] as DecisionOutcome[]) {
      outcome = unanswered
      expect(await (await ask(busy.id, DRAFT)).json()).toEqual({ suggestion: null })
    }
  })

  test('is authorized like sending the agent a message', async () => {
    expect((await ask(busy.id, DRAFT, null)).status).toBe(401)
    expect((await ask(busy.id, DRAFT, reader)).status).toBe(403)
    expect((await ask(busy.id, DRAFT, outsider)).status).toBe(403)
    expect(calls).toHaveLength(0)
    expect((await ask(busy.id, DRAFT, runner)).status).toBe(200)
  })

  test('rejects a missing or overlong draft', async () => {
    expect((await ask(busy.id, undefined)).status).toBe(400)
    expect((await ask(busy.id, 'x'.repeat(4001))).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

test('appears in Settings → Decision Providers as an instance feature, on by default', () => {
  const feature = decisionFeatures().find((entry) => entry.id === 'composer-delivery')
  expect(feature).toMatchObject({ label: 'Composer interrupt or follow-up', scope: 'instance', switch: 'auto' })
  expect(feature?.offByDefault).toBeUndefined()
})

describe('toolTarget', () => {
  test('reads a path, command head, URL or query from the start of the arguments', () => {
    expect(toolTarget('{"path":"a/b/c.ts","content":"…"}')).toBe('a/b/c.ts')
    expect(toolTarget('{"command":"git status\\ngit diff"}')).toBe('git status')
    expect(toolTarget('{"url":"https://x.dev/a"}')).toBe('https://x.dev/a')
    expect(toolTarget('{"query":"hono middleware order"}')).toBe('hono middleware order')
    expect(toolTarget('{"todos":[1,2]}')).toBeUndefined()
  })

  test('survives arguments cut off mid-value and keeps the end of long paths', () => {
    expect(toolTarget('{"command":"bun run --filter web te')).toBe('bun run --filter web te')
    const path = `${'deep/'.repeat(40)}file.ts`
    const target = toolTarget(JSON.stringify({ path }))!
    expect(target.length).toBeLessThanOrEqual(120)
    expect(target.endsWith('file.ts')).toBe(true)
  })
})
