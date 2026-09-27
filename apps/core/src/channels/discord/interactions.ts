import { discordProvider, editInteractionResponse, InteractionResponseType } from './provider'
import { handleChannelEvent } from '../handler'
import type { ChannelEvent } from '../provider'
import { getChannelIntegrationValue } from '../../services/integrations/channels/settings'

async function nativeChannel(channelId: string): Promise<{ parentId?: string } | null> {
  const token = getChannelIntegrationValue('DISCORD_BOT_TOKEN')
  if (!token) return null
  const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(2500),
  })
  if (!response.ok) return null
  const channel = (await response.json()) as { type: number; parent_id?: string }
  return { parentId: [10, 11, 12].includes(channel.type) ? channel.parent_id : undefined }
}

/** Both verified HTTP ingress and the gateway ACK before any routing/database work.
 * HTTP callers return 202 with no body because the callback is sent separately. */
export async function handleDiscordInteraction(
  payload: unknown,
  event: ChannelEvent,
  resolveChannel: (id: string) => Promise<{ parentId?: string } | null> = nativeChannel
): Promise<void> {
  const applicationId = event.raw?.applicationId as string | undefined
  const token = event.raw?.interactionToken as string | undefined
  if (!applicationId || !token || !event.messageId) return

  // Acknowledge before database lookups, authorization or agent startup. A failed
  // callback (including duplicate delivery) must not execute the command again.
  const ack = await fetch(
    `https://discord.com/api/v10/interactions/${encodeURIComponent(event.messageId)}/${encodeURIComponent(token)}/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE,
        ...(event.command === 'link' ? { data: { flags: 64 } } : {}),
      }),
      signal: AbortSignal.timeout(2500),
    }
  )
  if (!ack.ok) throw new Error('Discord interaction acknowledgement failed')

  try {
    const platformId = discordProvider.extractPlatformId(payload)
    if (!platformId) {
      await editInteractionResponse(
        applicationId,
        token,
        'Configure this bot connection and its default squad in Ficus’s integration settings.'
      )
      return
    }
    if (event.isInThread && !event.routingChannelId) {
      const routing = await resolveChannel(event.channelId)
      if (!routing?.parentId) throw new Error('Cannot verify Discord thread parent')
      event.routingChannelId = routing.parentId
    }
    const result = await handleChannelEvent(discordProvider, event, platformId)
    const response = result.response as { type?: number; data?: { content?: string } }
    if (response.type === InteractionResponseType.CHANNEL_MESSAGE && response.data?.content) {
      await editInteractionResponse(applicationId, token, response.data.content)
    } else if (response.type !== InteractionResponseType.DEFERRED_CHANNEL_MESSAGE) {
      // Policy exclusions intentionally have no response; remove the acknowledgement.
      const removed = await fetch(
        `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}/messages/@original`,
        { method: 'DELETE', signal: AbortSignal.timeout(10_000) }
      )
      if (!removed.ok) throw new Error('Discord interaction cleanup failed')
    }
  } catch {
    await editInteractionResponse(applicationId, token, 'Ficus could not complete this command. Please try again.')
    throw new Error('Discord interaction processing failed')
  }
}
