import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, inArray, like, or, sql } from 'drizzle-orm'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import { db } from '../db'
import { agents, agentTypes, inbox, squads, workStreams } from '../db/schema'
import { createNotifyContactTool } from './notify-contact'

// notify_contact is agent→agent coordination only: it routes to the work stream OWNER, else the
// squad manager, else the system inbox. It never targets a human directly (humans follow work via
// work-stream status changes they subscribe to).
describe('notify_contact tool', () => {
  let testPrefix: string
  let agentTypeId: string
  let squad: Squad
  let createdAgentIds: string[]

  beforeEach(async () => {
    testPrefix = `notify-contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    agentTypeId = `${testPrefix}-agent-type`
    createdAgentIds = []

    await AgentType.create({
      id: agentTypeId,
      name: 'Notify Contact Test Agent',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'You are a test agent.',
    })

    squad = await Squad.create({
      name: `${testPrefix} Squad`,
      purpose: 'Testing notify_contact routing',
    })
  })

  afterEach(async () => {
    const fixtureAgentIds = createdAgentIds.length ? createdAgentIds : ['__none__']
    // System-sent messages (e.g. work-stream assignment handoffs) have no sender agent, so clean up
    // by recipient as well or they outlive the test. Scoped to recipientType 'agent' because
    // inbox.recipientId has no FK — an unscoped match could delete a user or voice-assistant row
    // that happens to share an id.
    const fixtureMessageCondition = or(
      inArray(inbox.senderId, fixtureAgentIds),
      and(eq(inbox.recipientType, 'agent'), inArray(inbox.recipientId, fixtureAgentIds))
    )
    await db.delete(inbox).where(fixtureMessageCondition)

    const fixtureMessages = await db.select({ id: inbox.id }).from(inbox).where(fixtureMessageCondition)
    expect(fixtureMessages).toHaveLength(0)
    if (createdAgentIds.length > 0) await db.delete(agents).where(inArray(agents.id, createdAgentIds))
    await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  async function createAgent(): Promise<Agent> {
    const agent = await Agent.create({ agentTypeId, squadId: squad.id })
    createdAgentIds.push(agent.id)
    return agent
  }

  it('routes owned work stream notifications to the work stream owner', async () => {
    const worker = await createAgent()
    const owner = await createAgent()
    const workStream = await storedLegacyWorkStream({
      squadId: squad.id,
      title: `${testPrefix} Owned`,
      ownerAgentId: owner.id,
      assigneeAgentId: worker.id,
      agentIds: [worker.id],
    })
    // An active (in_progress) work stream must have an assignee — the worker is the one doing the
    // work here, while `owner` owns the stream. Routing keys off ownership, not assignment.
    await workStream.update({ status: 'active', assigneeAgentId: worker.id })

    const result = await createNotifyContactTool({ agentId: worker.id }).execute(
      'tool-call-1',
      { title: 'Build failed', message: 'The build is failing and needs attention.' },
      undefined,
      undefined,
      {} as any
    )

    const messages = await db
      .select()
      .from(inbox)
      .where(and(eq(inbox.senderId, worker.id), eq(inbox.subject, 'Build failed')))
    expect(messages).toHaveLength(1)
    expect(messages[0].recipientType).toBe('agent')
    expect(messages[0].recipientId).toBe(owner.id)
    expect((messages[0].metadata as Record<string, unknown>).routedTo).toBe('work_stream_owner')
    expect(result.details as Record<string, unknown>).toMatchObject({ success: true, routedTo: 'work_stream_owner' })
  })

  it('falls back to the squad manager when there is no owned active work stream', async () => {
    const worker = await createAgent()

    await createNotifyContactTool({ agentId: worker.id }).execute(
      'tool-call-1',
      { title: 'Needs attention', message: 'This needs attention.' },
      undefined,
      undefined,
      {} as any
    )

    const messages = await db
      .select()
      .from(inbox)
      .where(sql`${inbox.senderId} = ${worker.id} AND ${inbox.subject} = ${'Needs attention'}`)
    expect(messages).toHaveLength(1)
    // Squad.create provisions a manager agent, so the fallback is the squad manager (never a user).
    expect(squad.managerAgentId).toBeTruthy()
    expect(messages[0].recipientType).toBe('agent')
    expect(messages[0].recipientId).toBe(squad.managerAgentId!)
    expect((messages[0].metadata as Record<string, unknown>).routedTo).toBe('squad_manager')
  })

  it('sends once per tool call: the same call again returns the first notification', async () => {
    const worker = await createAgent()
    const tool = createNotifyContactTool({ agentId: worker.id, executionId: crypto.randomUUID() })
    const notify = (toolCallId: string, title: string) =>
      tool.execute(toolCallId, { title, message: 'Ready for review.' }, undefined, undefined, {} as any)

    const first = await notify('tool-call-1', 'PR ready')
    const replay = await notify('tool-call-1', 'PR ready')
    const other = await notify('tool-call-2', 'PR ready again')

    const messages = await db.select().from(inbox).where(eq(inbox.senderId, worker.id))
    expect(messages.map((message) => message.subject).sort()).toEqual(['PR ready', 'PR ready again'])
    const firstId = (first.details as { messageId: string }).messageId
    expect(replay.details).toMatchObject({ success: true, routedTo: 'squad_manager', messageId: firstId, reused: true })
    expect(replay.content[0]).toMatchObject({ text: expect.stringContaining('nothing was sent again') })
    expect((other.details as { messageId: string }).messageId).not.toBe(firstId)
  })
})
