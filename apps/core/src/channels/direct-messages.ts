import { squadSlugMap } from '@ficus/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { agents, channelDirectAgents, channelDirectChats, channelIdentityLinks, db, squads, users } from '../db'
import { Agent } from '../entities/Agent'
import { ChannelInstance } from '../entities/ChannelInstance'
import { InboxMessage } from '../entities/InboxMessage'
import { findLinkedChannelUser } from '../services/channel-access'
import { getAccessibleSquadIds, hasUserPermissionWithExecutor } from '../services/rbac/permissions'
import { generateAgentName } from '../lib/utils/agent-names'
import { eventEmitter } from '../lib/infra/event-emitter'
import type { ChannelEvent, ChannelProvider, InboundMessage } from './provider'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
const linkRequired =
  'Link your account in Ficus → Settings → Account → Linked chat accounts, then send /ficus squad. Private squad switching requires a linked account with chat access.'

/** The chat lock serializes selection and first-agent creation across all API replicas.
 * Never use global-pool entity helpers under it; publish created events only after commit. */
type DirectChatResult =
  | { reply: string; agent?: undefined; squadName?: undefined; squadId?: undefined }
  | { reply?: undefined; agent?: Agent; squadName: string; squadId: string }
export async function resolveDirectChat(instance: ChannelInstance, event: ChannelEvent): Promise<DirectChatResult> {
  if (instance.allowPrivateChats === false) return { reply: 'Private chats are disabled for this integration.' }
  if (!event.isDirectMessage) return { reply: 'Squad switching requires a private bot conversation.' }
  const link = await findLinkedChannelUser(instance, event.user.id)
  if (!link) return { reply: linkRequired }
  const visibleSquadIds = await getAccessibleSquadIds({ type: 'user', userId: link.userId })
  const threadId = instance.provider === 'slack' ? (event.threadId ?? event.messageId) : ''
  const afterCommit: Array<() => void> = []
  const result = await db.transaction(async (tx) => {
    // Recheck linkage and account state inside the transaction (unlink cascades chat state).
    const [identity] = await tx
      .select()
      .from(channelIdentityLinks)
      .innerJoin(users, eq(users.id, channelIdentityLinks.userId))
      .where(and(eq(channelIdentityLinks.id, link.id), isNull(users.disabledAt)))
    if (!identity) return { reply: linkRequired }
    await tx
      .insert(channelDirectChats)
      .values({
        linkId: link.id,
        channelId: event.channelId,
        threadId,
        squadId: instance.resolveTargetSquad({
          responseContext: { provider: instance.provider, channelId: event.channelId },
        } as InboundMessage),
      })
      .onConflictDoNothing()
    const [chat] = await tx
      .select()
      .from(channelDirectChats)
      .where(
        and(
          eq(channelDirectChats.linkId, link.id),
          eq(channelDirectChats.channelId, event.channelId),
          eq(channelDirectChats.threadId, threadId)
        )
      )
      .for('update')
    const choices = await tx
      .select({ id: squads.id, name: squads.name, createdAt: squads.createdAt })
      .from(squads)
      .where(and(eq(squads.isAnonymous, false), isNull(squads.archivedAt)))
      .orderBy(squads.name, squads.id)
    const visible = choices.filter((s) => visibleSquadIds === 'all' || visibleSquadIds.includes(s.id))
    const { idToSlug, slugToId } = squadSlugMap(visible)
    const accessible: typeof choices = []
    for (const choice of visible) {
      if (await hasUserPermissionWithExecutor(tx, link.userId, 'chat:send', choice.id)) accessible.push(choice)
    }
    const picker = () =>
      accessible.length
        ? `Choose a squad with ${instance.provider === 'slack' ? '@Ficus squad' : '/ficus squad'} <slug, name or ID>:\n${accessible
            .slice(0, 10)
            .map((s) => `${s.name} — ${idToSlug[s.id]}`)
            .join(
              '\n'
            )}${accessible.length > 10 ? '\nShowing the first 10. You can also enter another squad’s full slug, name or ID.' : ''}`
        : 'Your Ficus account has no accessible active squads. Ask an administrator for chat access.'
    if (event.command === 'squad') {
      const query = event.text.trim().toLowerCase()
      if (!query) {
        const current = accessible.find((s) => s.id === chat.squadId)
        return { reply: `${current ? `Currently talking to ${current.name}.\n\n` : ''}${picker()}` }
      }
      const slugMatch = accessible.find((s) => s.id === slugToId[query] || s.id === query)
      const matches = slugMatch ? [slugMatch] : accessible.filter((s) => s.name.toLowerCase() === query)
      if (matches.length !== 1)
        return { reply: `No unique accessible squad matches that slug, name or ID.\n\n${picker()}` }
      const selected = matches[0]!
      await tx.update(channelDirectChats).set({ squadId: selected.id }).where(eq(channelDirectChats.id, chat.id))
      return {
        reply: `Now talking to ${selected.name}. Messages go to this squad until you switch again${instance.provider === 'slack' ? ' in this thread with @Ficus squad <slug>' : ' with /ficus squad'}. Earlier work may still reply here.`,
      }
    }
    const target = chat.squadId
    const selected = accessible.find((s) => s.id === target)
    if (!selected) return { reply: picker() }
    if (event.command === 'status') return { squadName: selected.name, squadId: selected.id }
    const agent = await resolveDirectAgent(tx, chat.id, selected.id, instance, event, afterCommit)
    return { agent, squadName: selected.name, squadId: selected.id }
  })
  afterCommit.forEach((callback) => callback())
  return result
}

async function resolveDirectAgent(
  tx: Tx,
  chatId: string,
  squadId: string,
  instance: ChannelInstance,
  event: ChannelEvent,
  afterCommit: Array<() => void>
) {
  const [binding] = await tx
    .select()
    .from(channelDirectAgents)
    .innerJoin(agents, eq(agents.id, channelDirectAgents.agentId))
    .where(and(eq(channelDirectAgents.chatId, chatId), eq(channelDirectAgents.squadId, squadId)))
  if (binding && binding.agents.status !== 'terminated') return new Agent(binding.agents)
  const [row] = await tx
    .insert(agents)
    .values({
      agentTypeId: 'consultant',
      squadId,
      persist: true,
      context: {
        scope: { type: 'consultant' },
        origin: 'channel',
        channelInstance: { id: instance.id, provider: instance.provider },
        directMessage: true,
        thread: {
          id: instance.provider === 'slack' ? (event.threadId ?? event.messageId) : event.channelId,
          channelId: event.channelId,
          originalMessageId: event.messageId,
          tauCreated: true,
        },
      },
      metadata: { name: generateAgentName(), resourceGeneration: crypto.randomUUID() },
    })
    .returning()
  await tx
    .insert(channelDirectAgents)
    .values({ chatId, squadId, agentId: row.id })
    .onConflictDoUpdate({ target: [channelDirectAgents.chatId, channelDirectAgents.squadId], set: { agentId: row.id } })
  afterCommit.push(() => eventEmitter.emit('agent.created', { agentId: row.id, squadId }))
  return new Agent(row)
}

export async function handleDirectMessage(provider: ChannelProvider, event: ChannelEvent, instance: ChannelInstance) {
  if (instance.allowPrivateChats === false) return { response: { ok: true }, emptyResponse: true }
  // Slack slash commands have no message timestamp; establish a real parent first.
  let commandParent: string | undefined
  if (provider.name === 'slack' && event.type === 'slash_command') {
    const posted = await provider.postMessage({ channelId: event.channelId, text: 'Choosing a squad…' })
    commandParent = posted.messageId
    event = { ...event, threadId: posted.messageId }
  }
  const threadId = provider.name === 'slack' ? (event.threadId ?? event.messageId) : undefined
  const reply = async (text: string) => {
    if (commandParent) {
      await provider.editMessage({ channelId: event.channelId, messageId: commandParent, text })
      return { response: { ok: true }, emptyResponse: true }
    }
    if (event.type === 'slash_command' && !provider.sendsResponseViaApi)
      return { response: provider.formatSyncResponse(text) }
    await provider.postMessage({
      channelId: event.channelId,
      threadId,
      text,
      replyToMessageId: provider.name === 'telegram' ? event.messageId : undefined,
    })
    return { response: { ok: true }, emptyResponse: true }
  }
  if (event.command === 'help')
    return reply(
      [
        'Commands:',
        '/ficus help — Show this menu',
        '/ficus link <code> — Link your Ficus account',
        '/ficus squad — List available squads and the current selection',
        '/ficus squad <slug, name or ID> — Switch squads',
        '/ficus status — Show the selected squad’s active and queued work',
        '/ficus ask <message> — Send a request to the selected squad',
        '',
        'You can also send ordinary messages. Help and linking do not require a selected squad. Set up account linking in Ficus → Settings → Account → Linked chat accounts.',
      ].join('\n')
    )
  if (event.command === 'notify' || event.command === 'unnotify')
    return reply(
      'Configure notification destinations in Ficus Settings. Squad switching here only changes this conversation.'
    )
  const result = await resolveDirectChat(instance, event)
  if (result.reply !== undefined) return reply(result.reply)
  if (event.command === 'status') {
    const routed = new ChannelInstance({
      ...instance,
      channelSquadMap: { ...instance.channelSquadMap, [event.channelId]: result.squadId! },
    })
    return reply(
      await routed.handleSyncCommand({
        command: 'status',
        content: '',
        user: event.user,
        responseContext: { provider: provider.name, channelId: event.channelId },
      })
    )
  }
  // No provider history import: the shared DM contains messages for different squads.
  const interaction = event.type === 'slash_command' && provider.name === 'discord'
  const thinking = interaction
    ? undefined
    : await provider.postMessage({ channelId: event.channelId, threadId, text: 'Thinking…' })
  if (commandParent)
    await provider.editMessage({
      channelId: event.channelId,
      messageId: commandParent,
      text: `Talking to ${result.squadName}`,
    })
  await InboxMessage.send({
    recipientId: result.agent!.id,
    senderType: 'system',
    wakeEligible: true,
    subject: `Channel: ${event.command ?? 'message'}`,
    content: `**${provider.name} from ${event.user.name}:** "${event.text}"`,
    metadata: {
      type: 'channel_message',
      channelInstanceId: instance.id,
      targetSquadId: result.squadId,
      userId: event.user.id,
      userName: event.user.name,
      command: event.command ?? 'message',
      channelContext: {
        provider: provider.name,
        channelId: event.channelId,
        threadId,
        messageToEdit: thinking?.messageId,
        extras: { ...event.raw, directMessage: true },
      },
    },
  })
  return interaction ? { response: provider.formatDeferredResponse() } : { response: { ok: true }, emptyResponse: true }
}
