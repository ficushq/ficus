import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { agentQuestions, agentTypes, agents, assistantConversations, db, squads, workStreams } from '../db'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import { ensureAssistantConversationAgent } from '../services/assistant-conversation-agent'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'
import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'
import { createAssistantTools } from './assistant'

const prefix = `assistant-tools-${randomUUID()}`
const agentIds: string[] = []
const conversationIds: string[] = []
let squad: Squad
let member: TestUser
let outsider: TestUser
let asker: Agent
let blockedId: string
let questionId: string

async function toolsFor(user: TestUser) {
  const [conversation] = await db.insert(assistantConversations).values({ ownerUserId: user.id }).returning()
  conversationIds.push(conversation!.id)
  const { agentId } = await ensureAssistantConversationAgent({ type: 'user', userId: user.id }, conversation!.id)
  agentIds.push(agentId)
  const tools = createAssistantTools(agentId, randomUUID(), conversation!.id)
  return async (name: string, args: object) => {
    const tool = tools.find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`Missing tool ${name}`)
    const result = await tool.execute('call', args as never, undefined, undefined, {} as never)
    return { ...result, value: result.details as any }
  }
}

beforeAll(async () => {
  await AgentType.create({ id: `${prefix}-type`, name: 'Assistant tools', model: 'test:model', systemPrompt: 'test' })
  squad = await Squad.create({ name: prefix, purpose: 'assistant attention tools' })
  member = await createTestUser({ prefix: `${prefix}-member` })
  outsider = await createTestUser({ prefix: `${prefix}-outsider` })
  const chat = await createTestRole({ prefix: `${prefix}-chat`, permissions: ['chat:send'] })
  const squadRole = await createTestRole({
    prefix: `${prefix}-squad`,
    permissions: [
      'actions:read',
      'agents:read',
      'agents:run',
      'squads:read',
      'workstreams:read',
      'workstreams:respond',
    ],
  })
  await assignRole({ userId: member.id, roleId: chat.id, scope: 'system' })
  await assignRole({ userId: outsider.id, roleId: chat.id, scope: 'system' })
  await assignRole({ userId: member.id, roleId: squadRole.id, scope: 'squad', squadId: squad.id })

  asker = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: squad.id, ownerUserId: member.id })
  agentIds.push(asker.id)
  const [question] = await db
    .insert(agentQuestions)
    .values({
      agentId: asker.id,
      squadId: squad.id,
      ownerUserId: member.id,
      questionData: { questions: [{ id: 'deploy', type: 'text', question: 'Deploy now?' }] },
    })
    .returning()
  questionId = question!.id
  const blocked = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} blocked` })
  await blocked.block({ message: 'Need a decision' })
  blockedId = blocked.id
  await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} running` })
})

afterAll(async () => {
  await db.delete(agentQuestions).where(inArray(agentQuestions.agentId, agentIds))
  await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
  if (conversationIds.length)
    await db.delete(assistantConversations).where(inArray(assistantConversations.id, conversationIds))
  await db.delete(agents).where(inArray(agents.id, agentIds))
  await db.delete(squads).where(eq(squads.id, squad.id))
  await db.delete(agentTypes).where(eq(agentTypes.id, `${prefix}-type`))
  await cleanupTestRbac(prefix)
})

test('"what needs me" reaches the Needs you list even when own tasks and notifications are empty', async () => {
  const call = await toolsFor(member)
  expect((await call('list_tasks', {})).value).toEqual([])
  expect((await call('read_inbox', { view: 'notifications' })).value).toEqual([])

  const { value: needs } = await call('read_inbox', { view: 'actions' })
  const types = needs.actions.map((action: { type: string }) => action.type)
  expect(types).toContain('agent-question')
  expect(types).toContain('workstream-blocked')
  expect(JSON.stringify(needs)).toContain(questionId)

  const { value: work } = await call('get_work', {})
  const ours = work.workStreams.filter((stream: { squadId: string }) => stream.squadId === squad.id)
  expect(ours).toHaveLength(2)
  expect(ours[0]).toMatchObject({ workStreamId: blockedId, state: 'blocked', needsHuman: true, squadName: prefix })
  expect(ours[0].openWaits[0]).toMatchObject({ type: 'manual', message: 'Need a decision' })
  expect(ours[1].needsHuman).toBe(false)
})

test('get_work scopes to one squad or one stream and read_thread reports agent status', async () => {
  const call = await toolsFor(member)
  const { value: squadWork } = await call('get_work', { squadId: squad.id })
  expect(squadWork.squad).toEqual({ id: squad.id, name: prefix })
  expect(squadWork.agents.map((agent: { id: string }) => agent.id)).toContain(asker.id)
  expect(squadWork.workStreams).toHaveLength(2)
  // The running stream is newer; truncation must still keep the blocked one.
  const { value: first } = await call('get_work', { squadId: squad.id, limit: 1 })
  expect(first.workStreams.map((stream: { workStreamId: string }) => stream.workStreamId)).toEqual([blockedId])
  expect(first.omitted).toBe(1)

  const { value: stream } = await call('get_work', { workStreamId: blockedId })
  expect(stream).toMatchObject({ id: blockedId, state: 'blocked', needsHuman: true })
  expect((await call('get_work', { squadId: squad.id, workStreamId: blockedId })).value).toEqual({ error: true })

  const { value: thread } = await call('read_thread', { agentId: asker.id })
  expect(thread.agent).toMatchObject({ id: asker.id, type: `${prefix}-type`, execution: null })
  expect((await call('read_activity', { squadId: squad.id })).value.error).toBeUndefined()
})

test('squad reads stay within the user’s access', async () => {
  const call = await toolsFor(outsider)
  const { value: needs } = await call('read_inbox', { view: 'actions' })
  expect(JSON.stringify(needs)).not.toContain(questionId)
  expect(JSON.stringify(needs)).not.toContain(blockedId)
  const { value: work } = await call('get_work', {})
  expect(work.workStreams.some((stream: { squadId: string }) => stream.squadId === squad.id)).toBe(false)
  for (const [name, args] of [
    ['get_work', { squadId: squad.id }],
    ['get_work', { workStreamId: blockedId }],
    ['read_activity', { squadId: squad.id }],
    ['answer_question', { questionId, dismiss: true }],
  ] as const) {
    const result = await call(name, args)
    expect(result.value).toEqual({ error: true })
    expect(JSON.stringify(result)).not.toContain(prefix)
  }
})

test('answer_question dismisses only on request and never with an answer', async () => {
  const call = await toolsFor(member)
  expect((await call('answer_question', { questionId })).value).toEqual({ error: true })
  expect((await call('answer_question', { questionId, answer: 'yes', dismiss: true })).value).toEqual({ error: true })
  const { value: dismissed } = await call('answer_question', { questionId, dismiss: true, reason: 'Not needed' })
  expect(dismissed).toMatchObject({ id: questionId, status: 'dismissed' })
  expect((await call('answer_question', { questionId, dismiss: true })).value).toEqual({ error: true })
})

test('the Assistant keeps every read the pre-durable web Assistant had', async () => {
  const names = createAssistantTools(randomUUID(), randomUUID(), randomUUID()).map((tool) => tool.name)
  // #139 kept these names but narrowed read_inbox and get_work, hiding the Needs you list.
  for (const name of ['read_inbox', 'get_work', 'read_activity', 'read_thread', 'answer_question', 'list_tasks'])
    expect(names).toContain(name)
})

test('the entity search tool is search_ficus', () => {
  const names = createAssistantTools(randomUUID(), randomUUID(), randomUUID()).map((tool) => tool.name)
  expect(names).toContain('search_ficus')
  expect(names.filter((name) => name.startsWith('search_'))).toEqual(['search_ficus'])
})

test('read_squad_files gates memory on memory:read and the workspace on workspace:read', async () => {
  const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text
  const reader = async (permission: string) => {
    const user = await createTestUser({ prefix: `${prefix}-${permission.replace(':', '-')}` })
    const role = await createTestRole({
      prefix: `${prefix}-${permission.replace(':', '-')}-role`,
      permissions: [permission],
    })
    const chat = await createTestRole({
      prefix: `${prefix}-${permission.replace(':', '-')}-chat`,
      permissions: ['chat:send'],
    })
    await assignRole({ userId: user.id, roleId: chat.id, scope: 'system' })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad.id })
    return toolsFor(user)
  }
  const memoryPath = { squadId: squad.id, path: '/memory/missing-note.md' }
  const workspacePath = { squadId: squad.id, path: 'README.md' }

  const workspaceOnly = await reader('workspace:read')
  expect(text(await workspaceOnly('read_squad_files', memoryPath))).toBe('Squad not found')

  // Past the permission gate, a missing memory file is reported as such rather than as a hidden squad.
  const memoryOnly = await reader('memory:read')
  expect(text(await memoryOnly('read_squad_files', memoryPath))).toBe('File not found')
  expect(text(await memoryOnly('read_squad_files', workspacePath))).toBe('Squad not found')
})
