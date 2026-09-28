import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PendingAction } from '@ficus/shared'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import {
  agentQuestionRecipients,
  agentQuestions,
  agentQuestionWorkStreamOrigins,
  agents,
  agentTypes,
  squads,
  workStreams,
} from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../../test-utils'
import { EMPTY_USER_ATTENTION, buildUserAttention, type UserAttention } from '../attention/resolver'
import { canReceiveAgentQuestionAttention, evaluatePendingAction } from './pending-action-policy'

const prefix = `pending-action-policy-${crypto.randomUUID()}`
let staleSquad: Squad
let currentSquad: Squad
let target: Agent
let responder: TestUser
/** Squadless agents created inside tests; no squad cascade reaches them. */
const personalAgentIds: string[] = []

beforeAll(async () => {
  await AgentType.create({
    id: `${prefix}-type`,
    name: 'Pending action policy',
    model: 'test:model',
    systemPrompt: 'test',
  })
  staleSquad = await Squad.create({ name: `${prefix}-stale`, purpose: 'stale serialized squad' })
  currentSquad = await Squad.create({ name: `${prefix}-current`, purpose: 'authoritative agent squad' })
  target = await Agent.create({
    agentTypeId: `${prefix}-type`,
    squadId: currentSquad.id,
    context: { squadId: staleSquad.id },
  })
  responder = await createTestUser({ prefix: `${prefix}-responder` })
  const role = await createTestRole({
    prefix: `${prefix}-role`,
    permissions: ['actions:read', 'agents:run'],
  })
  await assignRole({ userId: responder.id, roleId: role.id, scope: 'squad', squadId: currentSquad.id })
})

afterAll(async () => {
  await db.delete(agents).where(inArray(agents.id, [target.id, ...personalAgentIds]))
  await db.delete(squads).where(eq(squads.id, staleSquad.id))
  await db.delete(squads).where(eq(squads.id, currentSquad.id))
  await db.delete(agentTypes).where(eq(agentTypes.id, `${prefix}-type`))
  await cleanupTestRbac(prefix)
})

describe('pending action response capability', () => {
  test('does not turn historical question visibility into response authority', async () => {
    const recipient = { type: 'user' as const, userId: '00000000-0000-0000-0000-000000000001' }

    // Read-only attention visibility never implies the ability to respond; response
    // authority lives in question-authorization (see question-authorization.test.ts).
    expect(
      await canReceiveAgentQuestionAttention(
        recipient,
        { id: '00000000-0000-0000-0000-000000000000', ownerUserId: null, squadId: target.squadId },
        { attention: EMPTY_USER_ATTENTION }
      )
    ).toBe(false)
  })

  test('permission alone shows a squad item, and muting decisions hides it without touching capability', async () => {
    const action: PendingAction = {
      id: `squad-question:${target.id}`,
      type: 'squad-question',
      priority: 1,
      createdAt: new Date().toISOString(),
      canRespond: false,
      squadId: currentSquad.id,
      squadName: currentSquad.name,
      data: {
        agentId: target.id,
        agentName: null,
        agentTypeId: target.agentTypeId,
        squadId: currentSquad.id,
        squadName: currentSquad.name,
        questionData: { questions: [{ id: 'input', type: 'text', question: 'Input?' }] },
      },
    }
    const identity = { type: 'user' as const, userId: responder.id }

    // No subscription row at all: DEFAULT_ATTENTION shows it. Watching is no longer required.
    expect(await evaluatePendingAction(identity, action, { attention: EMPTY_USER_ATTENTION })).toEqual({
      visible: true,
      canRespond: true,
    })

    const muted = {
      attention: buildUserAttention(
        new Map([[currentSquad.id, { decisions: 'mute', progress: 'show' } as const]]),
        new Map()
      ),
    }
    expect(await evaluatePendingAction(identity, action, muted)).toEqual({ visible: false, canRespond: true })

    // Muting PROGRESS never hides a decision item.
    const progressMuted = {
      attention: buildUserAttention(
        new Map([[currentSquad.id, { decisions: 'notify', progress: 'mute' } as const]]),
        new Map()
      ),
    }
    expect(await evaluatePendingAction(identity, action, progressMuted)).toEqual({ visible: true, canRespond: true })
  })

  test('a question with work-stream origins follows its origins, and the squad row alone cannot show it', async () => {
    const [stream] = await db
      .insert(workStreams)
      .values({ squadId: currentSquad.id, title: `${prefix}-origin-stream` })
      .returning()
    const questionData = { questions: [{ id: 'input', type: 'text', question: 'Input?' }] }
    const [originQuestion, plainQuestion] = await db
      .insert(agentQuestions)
      .values([
        { agentId: target.id, squadId: currentSquad.id, questionData },
        { agentId: target.id, squadId: currentSquad.id, questionData },
      ])
      .returning()
    await db.insert(agentQuestionWorkStreamOrigins).values({ questionId: originQuestion.id, workStreamId: stream.id })

    const identity = { type: 'user' as const, userId: responder.id }
    const receives = (question: { id: string }, attention: UserAttention) =>
      canReceiveAgentQuestionAttention(
        identity,
        { id: question.id, ownerUserId: null, squadId: currentSquad.id },
        { attention }
      )

    // No squad row at all (default `show`), but the origin stream is muted: the origin decides.
    const mutedStream = buildUserAttention(
      new Map(),
      new Map([[stream.id, { decisions: 'mute', progress: 'mute' } as const]])
    )
    expect(await receives(originQuestion, mutedStream)).toBe(false)

    // Muted squad, un-muted origin stream: following one stream of a muted squad still surfaces it.
    const mutedSquadLoudStream = buildUserAttention(
      new Map([[currentSquad.id, { decisions: 'mute', progress: 'mute' } as const]]),
      new Map([[stream.id, { decisions: 'show', progress: 'show' } as const]])
    )
    expect(await receives(originQuestion, mutedSquadLoudStream)).toBe(true)

    // With no origins the squad row decides, and it is muted.
    expect(await receives(plainQuestion, mutedSquadLoudStream)).toBe(false)
  })

  test('a squadless personal item stays owner-and-recipient only, even for instance-wide actions:read', async () => {
    const personalOwner = await createTestUser({ prefix: `${prefix}-personal-owner` })
    const directRecipient = await createTestUser({ prefix: `${prefix}-personal-recipient` })
    const instanceReader = await createTestUser({ prefix: `${prefix}-instance-reader` })
    const systemRole = await createTestRole({
      prefix: `${prefix}-system-role`,
      permissions: ['actions:read', 'agents:run'],
    })
    await assignRole({ userId: instanceReader.id, roleId: systemRole.id, scope: 'system' })

    const personalAgent = await Agent.create({ agentTypeId: `${prefix}-type`, ownerUserId: personalOwner.id })
    personalAgentIds.push(personalAgent.id)
    const [question] = await db
      .insert(agentQuestions)
      .values({
        agentId: personalAgent.id,
        ownerUserId: personalOwner.id,
        questionData: { questions: [{ id: 'input', type: 'text', question: 'Personal input?' }] },
      })
      .returning()
    await db
      .insert(agentQuestionRecipients)
      .values({ questionId: question.id, userId: directRecipient.id, reason: 'execution-participant' })

    const receives = (user: TestUser) =>
      canReceiveAgentQuestionAttention(
        { type: 'user', userId: user.id },
        { id: question.id, ownerUserId: personalOwner.id, squadId: null },
        { attention: EMPTY_USER_ATTENTION }
      )

    expect(await receives(personalOwner)).toBe(true)
    expect(await receives(directRecipient)).toBe(true)
    // A squadless agent has no attention surface at all — nobody can mute or follow a personal
    // agent — so instance-wide actions:read must never route someone else's personal question.
    expect(await receives(instanceReader)).toBe(false)

    const halted: PendingAction = {
      id: `agent-error:${personalAgent.id}`,
      type: 'agent-error',
      priority: 0,
      createdAt: new Date().toISOString(),
      canRespond: false,
      data: {
        agentId: personalAgent.id,
        agentName: null,
        agentTypeId: personalAgent.agentTypeId,
        squadId: null,
        squadName: null,
        ownerUserId: personalOwner.id,
        reason: 'Provider unavailable',
      },
    }
    const attention = { attention: EMPTY_USER_ATTENTION }
    expect(await evaluatePendingAction({ type: 'user', userId: personalOwner.id }, halted, attention)).toEqual({
      visible: true,
      canRespond: true,
    })
    expect(await evaluatePendingAction({ type: 'user', userId: instanceReader.id }, halted, attention)).toEqual({
      visible: false,
      canRespond: false,
    })
  })

  test('uses the live nonterminated agent squad for legacy squad questions', async () => {
    const action: PendingAction = {
      id: `squad-question:${target.id}`,
      type: 'squad-question',
      priority: 1,
      createdAt: new Date().toISOString(),
      canRespond: false,
      squadId: staleSquad.id,
      squadName: staleSquad.name,
      data: {
        agentId: target.id,
        agentName: null,
        agentTypeId: target.agentTypeId,
        squadId: staleSquad.id,
        squadName: staleSquad.name,
        questionData: { questions: [{ id: 'input', type: 'text', question: 'Input?' }] },
      },
    }
    const identity = { type: 'user' as const, userId: responder.id }
    const context = { attention: EMPTY_USER_ATTENTION }

    expect(await evaluatePendingAction(identity, action, context)).toEqual({ visible: true, canRespond: true })

    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, target.id))
    expect(await evaluatePendingAction(identity, action, context)).toEqual({ visible: false, canRespond: false })
  })
})
