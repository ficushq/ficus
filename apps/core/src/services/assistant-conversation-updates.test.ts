import { Agent } from '../entities/Agent'
import { InboxMessage, formatInboxMessages } from '../entities/InboxMessage'
import { AgentSession } from '../entities/AgentSession'
import { SystemManagerRunner } from '../entities/agent-runners/system-manager-runner'
import { afterEach, expect, test, spyOn } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import {
  agents,
  agentQuestions,
  assistantConversations,
  assistantTasks,
  assistantUpdates,
  db,
  inbox,
  messages,
  users,
} from '../db'
import { assignRole, createTestRole, createTestUser, cleanupTestRbac } from '../test-utils'
import { ensureAssistantConversationAgent } from './assistant-conversation-agent'
import { forwardAssistantUpdates, linkAssistantSummaries } from './assistant-conversation-updates'
import { createAssistantTools, assistantToolClientId } from '../tools/assistant'

const prefix = `assistant-durable-${randomUUID()}`
const conversations: string[] = [],
  agentIds: string[] = [],
  inboxIds: string[] = []
afterEach(async () => {
  if (conversations.length)
    await db.delete(assistantConversations).where(inArray(assistantConversations.id, conversations.splice(0)))
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds.splice(0)))
  if (inboxIds.length) await db.delete(inbox).where(inArray(inbox.id, inboxIds.splice(0)))
  await cleanupTestRbac(prefix)
})
async function fixture() {
  const user = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['chat:send'] })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
  const [conversation] = await db.insert(assistantConversations).values({ ownerUserId: user.id }).returning()
  conversations.push(conversation!.id)
  const { agentId } = await ensureAssistantConversationAgent({ type: 'user', userId: user.id }, conversation!.id)
  agentIds.push(agentId)
  const [original] = await db
    .insert(inbox)
    .values({
      recipientType: 'voice_assistant',
      recipientId: `assistant:${conversation!.id}`,
      senderType: 'system',
      content: 'A durable report',
      metadata: {},
    })
    .returning()
  inboxIds.push(original!.id)
  await db.insert(assistantUpdates).values({ messageId: original!.id, conversationId: conversation!.id, sequence: 1 })
  return { user, conversation: conversation!, agentId, original: original! }
}
const noDelivery = async () => {}

test('concurrent forwarding persists one inbox row and does not acknowledge human visibility', async () => {
  const f = await fixture()
  await Promise.all([forwardAssistantUpdates(50, noDelivery), forwardAssistantUpdates(50, noDelivery)])
  const [update] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, f.original.id))
  expect(update!.forwardedMessageId).toBeTruthy()
  inboxIds.push(update!.forwardedMessageId!)
  expect(update!.processedAt).toBeNull()
  expect(update!.seenAt).toBeNull()
  const forwarded = await db
    .select()
    .from(inbox)
    .where(and(eq(inbox.recipientId, f.agentId), eq(inbox.idempotencyKey, `assistant-forward:${f.original.id}`)))
  expect(forwarded).toHaveLength(1)
  expect(forwarded[0]!.metadata).toMatchObject({ assistantUpdateId: f.original.id, wakeEligible: true })
})

test('disabled owners never receive an automatic wake', async () => {
  const f = await fixture()
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, f.user.id))
  let delivered = false
  await forwardAssistantUpdates(50, async () => {
    delivered = true
  })
  expect(delivered).toBe(false)
  expect(
    (await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, f.original.id)))[0]!
      .forwardedMessageId
  ).toBeNull()
})

test('summary links require confirmed consumption in the exact execution and response group', async () => {
  const f = await fixture()
  await forwardAssistantUpdates(50, noDelivery)
  const [update] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, f.original.id))
  inboxIds.push(update!.forwardedMessageId!)
  const executionId = randomUUID(),
    group = `${executionId}:one`
  const [human] = await db
    .insert(messages)
    .values({
      agentId: f.agentId,
      role: 'human',
      content: 'report',
      pending: true,
      metadata: { source: 'inbox', executionId, streamGroupId: group, inboxMessageIds: [update!.forwardedMessageId] },
    })
    .returning()
  const [response] = await db
    .insert(messages)
    .values({
      agentId: f.agentId,
      role: 'assistant',
      content: 'summary',
      metadata: { executionId, streamGroupId: group, content: [{ type: 'text', text: 'summary' }] },
    })
    .returning()
  await linkAssistantSummaries(f.agentId, executionId)
  expect(
    (await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, f.original.id)))[0]!
      .summarizedMessageId
  ).toBeNull()
  await db
    .update(messages)
    .set({
      pending: false,
      metadata: {
        ...(human!.metadata as object),
        consumedAt: new Date().toISOString(),
        streamGroupId: `${executionId}:other`,
      },
    })
    .where(eq(messages.id, human!.id))
  await linkAssistantSummaries(f.agentId, executionId)
  expect(
    (await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, f.original.id)))[0]!
      .summarizedMessageId
  ).toBeNull()
  await db
    .update(messages)
    .set({ metadata: { ...(human!.metadata as object), consumedAt: new Date().toISOString() } })
    .where(eq(messages.id, human!.id))
  await linkAssistantSummaries(f.agentId, executionId)
  await linkAssistantSummaries(f.agentId, executionId)
  const [linked] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, f.original.id))
  expect(linked!.summarizedMessageId).toBe(response!.id)
  expect(linked!.seenAt).toBeNull()
  expect((await db.select().from(messages).where(eq(messages.id, response!.id)))[0]!.metadata).toMatchObject({
    content: [{ type: 'text', text: 'summary' }],
    assistantUpdateIds: [f.original.id],
  })
  // Summarizing is the forwarded prompt's read state: the Assistant never needs a mark_read call.
  expect((await db.select().from(inbox).where(eq(inbox.id, update!.forwardedMessageId!)))[0]!.readAt).toBeInstanceOf(
    Date
  )
})

test('routine progress never wakes the Assistant; the next summary-worthy update names it', async () => {
  const f = await fixture()
  const taskId = randomUUID(),
    otherTaskId = randomUUID(),
    requestId = randomUUID()
  await db.insert(assistantTasks).values(
    [taskId, otherTaskId].map((id, index) => ({
      id,
      conversationId: f.conversation.id,
      currentRequestId: requestId,
      kind: 'background' as const,
      label: `Task ${index}`,
      status: 'working' as const,
    }))
  )
  const base = Date.now() + 60_000
  const report = async (
    sequence: number,
    task: string | null,
    reportedStatus: 'working' | 'waiting' | 'needs-input' | 'completed' | null,
    content: string
  ) => {
    const createdAt = new Date(base + sequence * 1000)
    const [row] = await db
      .insert(inbox)
      .values({
        recipientType: 'voice_assistant',
        recipientId: `assistant:${f.conversation.id}`,
        senderType: 'system',
        content,
        metadata: {},
        createdAt,
      })
      .returning()
    inboxIds.push(row!.id)
    const routine = task !== null && (reportedStatus === 'working' || reportedStatus === 'waiting')
    await db.insert(assistantUpdates).values({
      messageId: row!.id,
      conversationId: f.conversation.id,
      taskId: task,
      requestId: task ? requestId : null,
      sequence,
      reportedStatus,
      // Arrival marks routine progress processed (assistant-activity/project.ts).
      processedAt: routine ? createdAt : null,
      createdAt,
    })
    return row!.id
  }
  const working = await report(2, taskId, 'working', 'Reproduced the clipped outline.')
  const waiting = await report(3, taskId, 'waiting', 'Waiting on CI for the fix.')
  const untrackedWorking = await report(4, null, 'working', 'An untracked progress note.')
  const otherWorking = await report(5, otherTaskId, 'working', 'Other task progress.')
  const question = await report(6, otherTaskId, 'needs-input', 'Which browser?')
  const completed = await report(7, taskId, 'completed', 'Merged the outline fix.')

  await forwardAssistantUpdates(50, noDelivery)
  const rows = await db.select().from(assistantUpdates).where(eq(assistantUpdates.conversationId, f.conversation.id))
  const forwardedFor = (id: string) => rows.find((row) => row.messageId === id)!.forwardedMessageId
  for (const row of rows) if (row.forwardedMessageId) inboxIds.push(row.forwardedMessageId)
  expect([working, waiting, otherWorking].map(forwardedFor)).toEqual([null, null, null])
  for (const id of [f.original.id, untrackedWorking, question, completed]) expect(forwardedFor(id)).toBeTruthy()

  // The completion names the progress shown since this task's last forwarded update, newest first.
  const completion = (await InboxMessage.find(forwardedFor(completed)!))!
  expect(completion.content).toContain('Merged the outline fix.')
  expect(completion.content).toContain('Earlier progress on this task (2 updates)')
  expect(completion.content).toContain('Latest: "Waiting on CI for the fix."')
  expect(completion.content).toContain(`read_task_update: ${waiting}, ${working}.`)
  expect(completion.content).not.toContain(otherWorking)
  // The needs-input report's earlier progress ends at nothing forwarded before it for its task.
  const asked = (await InboxMessage.find(forwardedFor(question)!))!
  expect(asked.content).toContain(`read_task_update: ${otherWorking}.`)
  expect((await InboxMessage.find(forwardedFor(untrackedWorking)!))!.content).not.toContain('Earlier progress')
  // Forwarded updates' prompts do not ask for a mark-read call.
  expect(formatInboxMessages([completion, asked])).not.toContain('ficus inbox read')

  // Routine progress is not pending for the outbox to retry.
  await forwardAssistantUpdates(50, noDelivery)
  const after = await db
    .select()
    .from(assistantUpdates)
    .where(inArray(assistantUpdates.messageId, [working, waiting, otherWorking]))
  expect(after.map((row) => row.forwardedMessageId)).toEqual([null, null, null])

  // The Assistant can still find routine progress when asked.
  const listUpdates = createAssistantTools(f.agentId, randomUUID(), f.conversation.id).find(
    (tool) => tool.name === 'list_task_updates'
  )!
  const listed = await listUpdates.execute('call', { taskId } as never, undefined, undefined, {} as never)
  expect(listed.details).toEqual([
    expect.objectContaining({ messageId: completed, reportedStatus: 'completed', preview: 'Merged the outline fix.' }),
    expect.objectContaining({ messageId: waiting, reportedStatus: 'waiting', summarized: false }),
    expect.objectContaining({
      messageId: working,
      reportedStatus: 'working',
      preview: 'Reproduced the clipped outline.',
    }),
  ])
})

test('every in-process tool rejects another owner’s conversation and revoked users', async () => {
  const f = await fixture(),
    other = await fixture()
  const tools = createAssistantTools(f.agentId, randomUUID(), other.conversation.id)
  for (const tool of tools) {
    const result = await tool.execute('call', {} as never, undefined, undefined, {} as never)
    expect(result.details).toEqual({ error: true })
    expect(JSON.stringify(result)).not.toContain('A durable report')
  }
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, f.user.id))
  for (const tool of createAssistantTools(f.agentId, randomUUID(), f.conversation.id)) {
    expect((await tool.execute('call', {} as never, undefined, undefined, {} as never)).details).toEqual({
      error: true,
    })
  }
})

test('tool call idempotency is stable but fenced by execution and agent', () => {
  const agent = randomUUID(),
    execution = randomUUID()
  expect(assistantToolClientId(agent, execution, 'call')).toBe(assistantToolClientId(agent, execution, 'call'))
  expect(assistantToolClientId(agent, execution, 'call')).not.toBe(assistantToolClientId(agent, randomUUID(), 'call'))
  expect(assistantToolClientId(agent, execution, 'call')).not.toBe(
    assistantToolClientId(randomUUID(), execution, 'call')
  )
})

test('quick tools enforce private resource ownership even from an authorized conversation', async () => {
  const own = await fixture(),
    other = await fixture()
  const [hidden] = await db
    .insert(messages)
    .values({ agentId: other.agentId, role: 'human', content: 'Private other thread' })
    .returning()
  const [visible] = await db
    .insert(messages)
    .values({ agentId: own.agentId, role: 'human', content: 'My thread' })
    .returning()
  const [question] = await db
    .insert(agentQuestions)
    .values({ agentId: other.agentId, ownerUserId: other.user.id, questionData: { question: 'Private approval' } })
    .returning()
  const tools = createAssistantTools(own.agentId, randomUUID(), own.conversation.id)
  const call = async (name: string, args: object) =>
    tools.find((tool) => tool.name === name)!.execute('call', args as never, undefined, undefined, {} as never)
  for (const [name, args] of [
    ['read_thread', { agentId: other.agentId }],
    ['read_thread', { agentId: own.agentId, beforeId: hidden!.id }],
    ['message_agent', { agentId: other.agentId, request: 'Must not send' }],
    ['read_task_update', { messageId: other.original.id }],
    ['mark_read', { messageId: other.original.id }],
    ['answer_question', { questionId: question!.id, answer: 'Must not approve' }],
  ] as const) {
    const result = await call(name, args)
    expect(result.details).toEqual({ error: true })
    expect(JSON.stringify(result)).not.toContain('Private other thread')
    expect(JSON.stringify(result)).not.toContain('A durable report')
  }
  const result = await call('read_thread', { agentId: own.agentId })
  expect(JSON.stringify(result)).toContain(visible!.id)
  expect(JSON.stringify(result)).not.toContain(hidden!.id)
  expect((await db.select().from(inbox).where(eq(inbox.id, other.original.id)))[0]!.readAt).toBeNull()
})

test('mark_read marks a task-update notification by the ID the Assistant was shown', async () => {
  const f = await fixture()
  await forwardAssistantUpdates(50, noDelivery)
  const [update] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, f.original.id))
  const forwardedId = update!.forwardedMessageId!
  inboxIds.push(forwardedId)
  // The delivered prompt identifies the notification by its row in the Assistant agent's inbox.
  const prompt = formatInboxMessages([(await InboxMessage.find(forwardedId))!])
  expect(prompt).toContain(`### Message ${forwardedId}`)
  expect(prompt).toContain('Assistant task update')

  const [own] = await db
    .insert(inbox)
    .values({ recipientType: 'user', recipientId: f.user.id, senderType: 'system', content: 'Mine', metadata: {} })
    .returning()
  inboxIds.push(own!.id)

  const tools = createAssistantTools(f.agentId, randomUUID(), f.conversation.id)
  const markRead = tools.find((tool) => tool.name === 'mark_read')!
  for (const messageId of [forwardedId, own!.id]) {
    const result = await markRead.execute('call', { messageId } as never, undefined, undefined, {} as never)
    expect(result.details).toEqual({ marked: true })
    expect((await db.select().from(inbox).where(eq(inbox.id, messageId)))[0]!.readAt).toBeInstanceOf(Date)
  }
  // Read state is not human visibility: the original report stays unseen and unread.
  expect((await db.select().from(inbox).where(eq(inbox.id, f.original.id)))[0]!.readAt).toBeNull()
  expect(
    (await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, f.original.id)))[0]!.seenAt
  ).toBeNull()
})

test('mark_read reports another recipient’s message exactly like a missing one', async () => {
  const own = await fixture(),
    other = await fixture()
  await forwardAssistantUpdates(50, noDelivery)
  const [otherUpdate] = await db
    .select()
    .from(assistantUpdates)
    .where(eq(assistantUpdates.messageId, other.original.id))
  const [ownUpdate] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, own.original.id))
  inboxIds.push(otherUpdate!.forwardedMessageId!, ownUpdate!.forwardedMessageId!)
  const [otherUserMessage] = await db
    .insert(inbox)
    .values({
      recipientType: 'user',
      recipientId: other.user.id,
      senderType: 'system',
      content: 'Theirs',
      metadata: {},
    })
    .returning()
  // An agent row whose recipient ID is the caller's own user ID is not the caller's inbox either.
  const [crossTyped] = await db
    .insert(inbox)
    .values({ recipientType: 'agent', recipientId: own.user.id, senderType: 'system', content: 'Typed', metadata: {} })
    .returning()
  inboxIds.push(otherUserMessage!.id, crossTyped!.id)

  const markRead = createAssistantTools(own.agentId, randomUUID(), own.conversation.id).find(
    (tool) => tool.name === 'mark_read'
  )!
  const missing = await markRead.execute(
    'call',
    { messageId: randomUUID() } as never,
    undefined,
    undefined,
    {} as never
  )
  expect(missing.details).toEqual({ error: true })
  for (const messageId of [otherUpdate!.forwardedMessageId!, otherUserMessage!.id, other.original.id, crossTyped!.id]) {
    const result = await markRead.execute('call', { messageId } as never, undefined, undefined, {} as never)
    expect(result.details).toEqual({ error: true })
    expect(result.content).toEqual(missing.content)
    expect((await db.select().from(inbox).where(eq(inbox.id, messageId)))[0]!.readAt).toBeNull()
  }
})

test('durable Assistant sessions persist on the agent without allocating a sandbox or exposing shell tools', async () => {
  const f = await fixture()
  const agent = (await Agent.find(f.agentId))!
  class Runner extends SystemManagerRunner {
    open() {
      return this.createSession(null)
    }
    protected override async ensureWorkspaceSandbox(): Promise<string> {
      throw new Error('Assistant must not allocate a sandbox')
    }
    protected override async resolveSessionPaths(): Promise<never> {
      throw new Error('Assistant must not materialize sandbox paths')
    }
  }
  const configured = spyOn(SystemManagerRunner, 'buildManagerPrompt').mockResolvedValue({
    systemPrompt: 'Assistant',
    model: 'anthropic:claude-sonnet-4-5',
  })
  const model = spyOn(agent, 'getEffectiveModelSpec').mockImplementation(async (fallback) => fallback!)
  const create = spyOn(AgentSession, 'create').mockResolvedValue({} as AgentSession)
  try {
    const runner = new Runner({ id: randomUUID() } as never, agent, { toolsAllow: null, toolsDeny: null } as never)
    await runner.open()
    const options = create.mock.calls[0]![0]
    expect(configured.mock.calls[0]![1]).toBe('assistant')
    expect(await agent.getExecutionSandboxIds()).toEqual([])
    expect(options.sandbox).toBeUndefined()
    expect(options.storage).toEqual({ agentId: f.agentId })
    const names = options.tools!.core!.map((tool) => tool.name)
    expect(names).toContain('ask_human')
    expect(names).toContain('delegate_task')
    expect(names).toContain('read_thread')
    expect(names).not.toContain('bash')
    expect(names).not.toContain('dispatch')
    expect(options.tools!.available).toEqual([])
  } finally {
    create.mockRestore()
    model.mockRestore()
    configured.mockRestore()
  }
})
