import { afterAll, beforeAll, describe, expect, test, spyOn } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { squadSlugMap } from '@ficus/shared'
import {
  agents,
  channelDirectAgents,
  channelDirectChats,
  channelIdentityLinks,
  channelInstances,
  db,
  roleAssignments,
  squads,
  users,
  setDatabaseQueryObserverForTest,
} from '../db'
import { ChannelInstance } from '../entities/ChannelInstance'
import { InboxMessage } from '../entities/InboxMessage'
import { createTestUser, createTestRole, assignRole, cleanupTestRbac, type TestUser } from '../test-utils'
import { startChannelLink, claimChannelLink, confirmChannelLink } from '../services/channel-access'
import { requireAllowedChannelReply } from '../services/channel-policy'
import { parseDirectCommand } from '../lib/channels'
import { handleChannelEvent } from './handler'
import { handleDirectMessage, resolveDirectChat } from './direct-messages'
import type { ChannelEvent, ChannelProvider } from './provider'

const prefix = `dm-${crypto.randomUUID()}`
let user: TestUser
let instance: ChannelInstance
let scope: Array<{ id: string; name: string; createdAt: Date }>
let slugs: ReturnType<typeof squadSlugMap>
const assignments: string[] = []
const agentIds = new Set<string>()
const event = (patch: Partial<ChannelEvent> = {}): ChannelEvent => ({
  type: 'message',
  text: 'hello',
  channelId: 'DM',
  messageId: '1',
  user: { id: 'U1', name: 'Person' },
  isDirectMessage: true,
  isInThread: false,
  raw: {},
  ...patch,
})
const resolve = async (patch: Partial<ChannelEvent> = {}, connection = instance) => {
  const result = await resolveDirectChat(connection, event(patch))
  if (result.agent) agentIds.add(result.agent.id)
  return result
}
beforeAll(async () => {
  user = await createTestUser({ prefix })
  scope = await db
    .insert(squads)
    .values([
      { name: `${prefix} Team`, purpose: 'one' },
      { name: `${prefix} Team`, purpose: 'two' },
      { name: `${prefix} Hidden`, purpose: 'hidden' },
    ])
    .returning({ id: squads.id, name: squads.name, createdAt: squads.createdAt })
  instance = await ChannelInstance.create({
    id: prefix,
    name: prefix,
    provider: 'telegram',
    providerConfig: { botId: prefix },
    defaultSquadId: scope[0]!.id,
  })
  const role = await createTestRole({ prefix, permissions: ['chat:send'] })
  for (const squad of scope.slice(0, 2))
    assignments.push(await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad.id }))
  slugs = squadSlugMap(scope.slice(0, 2))
  const code = await startChannelLink(user.id)
  await claimChannelLink(instance.id, 'U1', 'Person', code.code)
  await confirmChannelLink(user.id, code.id)
})
afterAll(async () => {
  await db.delete(channelInstances).where(eq(channelInstances.id, prefix))
  if (agentIds.size) await db.delete(agents).where(inArray(agents.id, [...agentIds]))
  if (scope)
    await db.delete(squads).where(
      inArray(
        squads.id,
        scope.map((s) => s.id)
      )
    )
  await cleanupTestRbac(prefix)
})

describe('private squad conversations', () => {
  test('parses native commands and Slack thread mentions without treating ordinary prose as a switch', () => {
    for (const text of [
      '/squad team-2',
      '/ficus squad team-2',
      '/ficus@FicusBot squad team-2',
      '@Ficus squad team-2',
      'ficus squad team-2',
      // Typed before the rename: still understood.
      '/tau squad team-2',
      'tau squad team-2',
    ])
      expect(parseDirectCommand(text)).toEqual({ command: 'squad', text: 'team-2' })
    expect(parseDirectCommand('please switch squad team-2')).toBeNull()
  })
  test('lists only authorized squads using exactly the URL slug collision rules', async () => {
    const result = await resolve({ command: 'squad', text: '' })
    expect(result.reply).toContain(slugs.idToSlug[scope[0]!.id]!)
    expect(result.reply).toContain(slugs.idToSlug[scope[1]!.id]!)
    expect(result.reply).not.toContain('Hidden')
    expect(result.agent).toBeUndefined()
    const denied = await resolve({ command: 'squad', text: scope[2]!.id })
    expect(denied.reply).toContain('No unique accessible squad')
  })
  test('switches by slug and resumes the same per-squad history, including dormant agents', async () => {
    await resolve({ command: 'squad', text: slugs.idToSlug[scope[0]!.id]! })
    const first = await resolve()
    expect(first.agent?.squadId).toBe(scope[0]!.id)
    await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, first.agent!.id))
    await resolve({ command: 'squad', text: slugs.idToSlug[scope[1]!.id]! })
    const second = await resolve()
    expect(second.agent?.id).not.toBe(first.agent?.id)
    await resolve({ command: 'squad', text: scope[0]!.id })
    expect((await resolve()).agent?.id).toBe(first.agent!.id)
  })
  test('concurrent first messages create one binding and one agent', async () => {
    const results = await Promise.all([resolve({ channelId: 'race' }), resolve({ channelId: 'race' })])
    expect(results[0].agent!.id).toBe(results[1].agent!.id)
    const rows = await db
      .select()
      .from(channelDirectAgents)
      .innerJoin(channelDirectChats, eq(channelDirectChats.id, channelDirectAgents.chatId))
      .where(eq(channelDirectChats.channelId, 'race'))
    expect(rows).toHaveLength(1)
  })
  test('failed binding creation rolls back the new agent and chat together', async () => {
    const before = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        inArray(
          agents.squadId,
          scope.map((s) => s.id)
        )
      )
    setDatabaseQueryObserverForTest((query) => {
      if (query.startsWith('insert into "channel_direct_agents"')) throw new Error('binding failure')
    })
    try {
      await expect(resolve({ channelId: 'rollback' })).rejects.toThrow('binding failure')
    } finally {
      setDatabaseQueryObserverForTest(undefined)
    }
    expect(
      await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          inArray(
            agents.squadId,
            scope.map((s) => s.id)
          )
        )
    ).toEqual(before)
    expect(await db.select().from(channelDirectChats).where(eq(channelDirectChats.channelId, 'rollback'))).toHaveLength(
      0
    )
  })
  test('a terminated consultant is replaced without destroying the old conversation', async () => {
    const original = await resolve({ channelId: 'terminated' })
    await db.update(agents).set({ status: 'terminated' }).where(eq(agents.id, original.agent!.id))
    const replacement = await resolve({ channelId: 'terminated' })
    expect(replacement.agent!.id).not.toBe(original.agent!.id)
    expect(await db.select().from(agents).where(eq(agents.id, original.agent!.id))).toHaveLength(1)
  })
  test('Slack DM threads have independent selections and histories; switching back resumes only that thread', async () => {
    const slack = new ChannelInstance({ ...instance, provider: 'slack', providerConfig: { teamId: prefix } })
    // Fixture keeps the provider identity scope synchronized, as a real Slack link would be.
    await db
      .update(channelIdentityLinks)
      .set({ identityScope: JSON.stringify(['slack', prefix]) })
      .where(eq(channelIdentityLinks.instanceId, prefix))
    try {
      await resolve({ command: 'squad', text: scope[1]!.id, threadId: 'thread-a' }, slack)
      const a = await resolve({ threadId: 'thread-a' }, slack)
      const b = await resolve({ threadId: 'thread-b' }, slack)
      expect(a.agent!.squadId).toBe(scope[1]!.id)
      expect(b.agent!.squadId).toBe(scope[0]!.id)
      expect(a.agent!.id).not.toBe(b.agent!.id)
      expect((await resolve({ threadId: 'thread-a', messageId: 'next' }, slack)).agent!.id).toBe(a.agent!.id)
      const posted: unknown[] = []
      const provider = {
        name: 'slack',
        postMessage: async (input: unknown) => {
          posted.push(input)
          return { messageId: 'placeholder' }
        },
      } as unknown as ChannelProvider
      const inbox = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)
      try {
        await handleDirectMessage(provider, event({ threadId: 'thread-a', text: 'Continue' }), slack)
        expect(posted).toEqual([expect.objectContaining({ channelId: 'DM', threadId: 'thread-a' })])
        expect(inbox.mock.calls[0]![0].recipientId).toBe(a.agent!.id)
      } finally {
        inbox.mockRestore()
      }
    } finally {
      await db
        .update(channelIdentityLinks)
        .set({ identityScope: JSON.stringify(['telegram', prefix]) })
        .where(eq(channelIdentityLinks.instanceId, prefix))
    }
  })
  test('private delivery never imports mixed provider history', async () => {
    const sent: unknown[] = []
    const provider = {
      name: 'telegram',
      postMessage: async (input: unknown) => {
        sent.push(input)
        return { messageId: 'thinking' }
      },
      getThreadHistory: async () => {
        throw new Error('Must not fetch shared DM history')
      },
    } as unknown as ChannelProvider
    const inbox = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)
    try {
      await handleDirectMessage(provider, event({ text: 'Only this request' }), instance)
      expect(inbox).toHaveBeenCalledTimes(1)
      expect(inbox.mock.calls[0]![0].content).toContain('Only this request')
      expect(inbox.mock.calls[0]![0].content).not.toContain('Thread history')
      expect(sent).toEqual([expect.objectContaining({ channelId: 'DM', threadId: undefined })])
    } finally {
      inbox.mockRestore()
    }
  })
  test('public squad commands cannot change routes, and unlinked trusted senders cannot switch', async () => {
    const find = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(instance)
    const replies: string[] = []
    const provider = {
      name: 'telegram',
      sendsResponseViaApi: true,
      postMessage: async (input: { text: string }) => {
        replies.push(input.text)
        return { messageId: 'reply' }
      },
    } as unknown as ChannelProvider
    try {
      await handleChannelEvent(
        provider,
        event({ type: 'slash_command', isDirectMessage: false, command: 'squad', text: scope[1]!.id }),
        prefix
      )
      expect(replies[0]).toContain('administrator-defined')
    } finally {
      find.mockRestore()
    }
    const trusted = new ChannelInstance({ ...instance, trustedChannelIds: ['DM'] })
    expect((await resolve({ user: { id: 'unlinked', name: 'Person' } }, trusted)).reply).toContain('Link your account')
  })
  test('direct response and follow-up tools keep messages in the DM without adding a squad prefix', async () => {
    const { createChannelSendTool } = await import('../tools/channel-send')
    const { createChannelRespondTool } = await import('../tools/channel-respond')
    const { telegramProvider } = await import('./telegram/provider')
    const { registerProvider } = await import('./provider')
    const current = await resolve()
    // Real inbox delivery wakes a dormant consultant before its tools run.
    await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, current.agent!.id))
    const posted: Array<Record<string, unknown>> = []
    const edited: Array<Record<string, unknown>> = []
    registerProvider({
      ...telegramProvider,
      postMessage: async (args) => {
        posted.push(args)
        return { messageId: 'sent' }
      },
      editMessage: async (args) => {
        edited.push(args)
      },
    })
    const find = spyOn(InboxMessage, 'find').mockResolvedValue({
      recipientId: current.agent!.id,
      content: 'Question',
      metadata: { channelContext: { provider: 'telegram', channelId: 'DM', messageToEdit: 'thinking' } },
      markAsRead: async () => {},
    } as unknown as InboxMessage)
    try {
      const response = await createChannelRespondTool().execute(
        'test',
        { messageId: 'inbox', content: 'Answer' },
        undefined,
        undefined,
        {} as any
      )
      expect(response.details).toMatchObject({ success: true })
      expect(edited).toEqual([{ channelId: 'DM', messageId: 'thinking', text: 'Answer' }])
      const sent = await createChannelSendTool(current.agent!.id).execute(
        'test',
        { content: 'Update' },
        undefined,
        undefined,
        {} as any
      )
      expect(sent.details).toMatchObject({ success: true })
      expect(posted).toEqual([{ channelId: 'DM', threadId: undefined, text: 'Update' }])
    } finally {
      find.mockRestore()
      registerProvider(telegramProvider)
    }
  })
  test('disabling private chats blocks existing replies and re-enabling preserves the consultant', async () => {
    const active = await resolve()
    expect(instance.allowPrivateChats).toBe(true)
    await instance.update({ allowPrivateChats: false })
    try {
      expect((await resolve()).agent).toBeUndefined()
      await expect(requireAllowedChannelReply(instance.id, 'DM', active.agent!.id)).rejects.toThrow(
        'Private chats are disabled'
      )
    } finally {
      await instance.update({ allowPrivateChats: true })
    }
    expect((await resolve()).agent!.id).toBe(active.agent!.id)
    await requireAllowedChannelReply(instance.id, 'DM', active.agent!.id)
  })
  test('permission revocation blocks new messages and delayed responses, without falling back to another squad', async () => {
    await resolve({ command: 'squad', text: scope[1]!.id })
    const active = await resolve()
    await requireAllowedChannelReply(instance.id, 'DM', active.agent!.id)
    await db.delete(roleAssignments).where(eq(roleAssignments.id, assignments[1]!))
    expect((await resolve()).agent).toBeUndefined()
    await expect(requireAllowedChannelReply(instance.id, 'DM', active.agent!.id)).rejects.toThrow('revoked')
  })
  test('disabled accounts and unlinking remove access; unlink cascades selections and bindings', async () => {
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id))
    expect((await resolve()).reply).toContain('Link your account')
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, user.id))
    const [link] = await db.select().from(channelIdentityLinks).where(eq(channelIdentityLinks.instanceId, prefix))
    await db.delete(channelIdentityLinks).where(eq(channelIdentityLinks.id, link!.id))
    expect(await db.select().from(channelDirectChats).where(eq(channelDirectChats.linkId, link!.id))).toHaveLength(0)
    expect((await resolve()).reply).toContain('Link your account')
  })
})
