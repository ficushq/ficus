/**
 * ChannelInstance Entity
 *
 * Represents an external platform connection (Discord guild, Slack workspace, Telegram bot).
 * Each channel instance routes messages via a default squad and optional channel-specific squad map.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { db, channelInstances } from '../db'
import { getProvider } from '../channels'
import type { ProviderConfig, InboundMessage } from '../channels/provider'
import { createLogger } from '../lib/infra/logger'

const log = createLogger('channel-instance')

export type ChannelInstanceRow = InferSelectModel<typeof channelInstances>

// Re-export ProviderConfig for backwards compatibility
export type { ProviderConfig } from '../channels/provider'
import { Squad } from './Squad'

const CHANNEL_AGENT_TYPE = 'consultant'

export interface CreateChannelInstanceInput {
  id: string
  name: string
  provider: string
  providerConfig: ProviderConfig
  trustedChannelIds?: string[]
  allowedChannelIds?: string[]
  deniedChannelIds?: string[]
  allowPrivateChats?: boolean
  channelSquadMap?: Record<string, string>
  defaultSquadId?: string
}

export interface UpdateChannelInstanceInput {
  name?: string
  providerConfig?: ProviderConfig
  trustedChannelIds?: string[]
  allowedChannelIds?: string[]
  deniedChannelIds?: string[]
  allowPrivateChats?: boolean
  channelSquadMap?: Record<string, string>
  defaultSquadId?: string | null
}

export class ChannelInstance implements ChannelInstanceRow {
  declare id: string
  declare name: string
  declare provider: string
  declare providerConfig: ProviderConfig
  declare trustedChannelIds: string[]
  declare allowedChannelIds: string[]
  declare deniedChannelIds: string[]
  declare allowPrivateChats: boolean
  declare channelSquadMap: Record<string, string>
  declare defaultSquadId: string | null
  declare yamlTemplate: unknown
  declare yamlFieldOverrides: string[]
  declare disabled: boolean
  declare createdAt: Date | null
  declare updatedAt: Date | null

  constructor(data: Omit<ChannelInstanceRow, 'allowPrivateChats'> & { allowPrivateChats?: boolean }) {
    Object.assign(this, data)
    // Normalize arrays and objects from Postgres
    this.trustedChannelIds = data.trustedChannelIds ?? []
    this.allowedChannelIds = data.allowedChannelIds ?? []
    this.deniedChannelIds = data.deniedChannelIds ?? []
    this.allowPrivateChats = data.allowPrivateChats ?? true
    this.providerConfig = (data.providerConfig as ProviderConfig) || {}
    this.channelSquadMap = (data.channelSquadMap as Record<string, string>) || {}
  }

  // ---------------------------------------------------------------------------
  // Static Methods
  // ---------------------------------------------------------------------------

  /**
   * Find a channel instance by ID.
   */
  static async find(id: string): Promise<ChannelInstance | null> {
    const [row] = await db.select().from(channelInstances).where(eq(channelInstances.id, id)).limit(1)
    return row ? new ChannelInstance(row) : null
  }

  /**
   * Find a channel instance by provider and platform identifier.
   * Searches within the providerConfig JSONB using the channel's configKey.
   * @throws Error if provider is not supported
   */
  static async findByProvider(provider: string, identifier: string): Promise<ChannelInstance | null> {
    // Get the config key from the provider
    const channelProvider = getProvider(provider)
    if (!channelProvider) {
      throw new Error(`Unsupported channel provider: ${provider}`)
    }

    const { configKey } = channelProvider

    // Query using JSONB operator, scoped to the provider so identifiers that
    // happen to collide across providers cannot route to the wrong instance.
    const [row] = await db
      .select()
      .from(channelInstances)
      .where(
        and(
          eq(channelInstances.provider, provider),
          sql`${channelInstances.providerConfig}->>${configKey} = ${identifier}`
        )
      )
      .limit(1)

    return row ? new ChannelInstance(row) : null
  }

  /**
   * List all channel instances.
   */
  static async list(): Promise<ChannelInstance[]> {
    const rows = await db.select().from(channelInstances)
    return rows.map((r) => new ChannelInstance(r))
  }

  /**
   * Create a new channel instance.
   */
  static async create(input: CreateChannelInstanceInput): Promise<ChannelInstance> {
    const [row] = await db
      .insert(channelInstances)
      .values({
        id: input.id,
        name: input.name,
        provider: input.provider,
        providerConfig: input.providerConfig,
        trustedChannelIds: input.trustedChannelIds ?? [],
        allowedChannelIds: input.allowedChannelIds ?? [],
        deniedChannelIds: input.deniedChannelIds ?? [],
        allowPrivateChats: input.allowPrivateChats ?? true,
        channelSquadMap: input.channelSquadMap || {},
        defaultSquadId: input.defaultSquadId || null,
      })
      .returning()

    return new ChannelInstance(row)
  }

  /**
   * Upsert a channel instance (create or update).
   */
  static async upsert(input: CreateChannelInstanceInput): Promise<ChannelInstance> {
    const [row] = await db
      .insert(channelInstances)
      .values({
        id: input.id,
        name: input.name,
        provider: input.provider,
        providerConfig: input.providerConfig,
        trustedChannelIds: input.trustedChannelIds ?? [],
        allowedChannelIds: input.allowedChannelIds ?? [],
        deniedChannelIds: input.deniedChannelIds ?? [],
        allowPrivateChats: input.allowPrivateChats ?? true,
        channelSquadMap: input.channelSquadMap || {},
        defaultSquadId: input.defaultSquadId || null,
      })
      .onConflictDoUpdate({
        target: channelInstances.id,
        set: {
          name: input.name,
          providerConfig: input.providerConfig,
          trustedChannelIds: input.trustedChannelIds ?? [],
          allowedChannelIds: input.allowedChannelIds ?? [],
          deniedChannelIds: input.deniedChannelIds ?? [],
          allowPrivateChats: input.allowPrivateChats ?? true,
          channelSquadMap: input.channelSquadMap || {},
          defaultSquadId: input.defaultSquadId || null,
          updatedAt: new Date(),
        },
      })
      .returning()

    return new ChannelInstance(row)
  }

  // ---------------------------------------------------------------------------
  // Instance Methods
  // ---------------------------------------------------------------------------

  /**
   * Update this channel instance.
   */
  async update(updates: UpdateChannelInstanceInput): Promise<void> {
    const updateValues: Record<string, unknown> = { updatedAt: new Date() }

    if (updates.trustedChannelIds !== undefined) updateValues.trustedChannelIds = updates.trustedChannelIds
    if (updates.allowedChannelIds !== undefined) updateValues.allowedChannelIds = updates.allowedChannelIds
    if (updates.deniedChannelIds !== undefined) updateValues.deniedChannelIds = updates.deniedChannelIds
    if (updates.allowPrivateChats !== undefined) updateValues.allowPrivateChats = updates.allowPrivateChats
    if (updates.name !== undefined) updateValues.name = updates.name
    if (updates.providerConfig !== undefined) updateValues.providerConfig = updates.providerConfig
    if (updates.channelSquadMap !== undefined) updateValues.channelSquadMap = updates.channelSquadMap
    if (updates.defaultSquadId !== undefined) updateValues.defaultSquadId = updates.defaultSquadId

    await db.update(channelInstances).set(updateValues).where(eq(channelInstances.id, this.id))

    Object.assign(this, updates)
  }

  /**
   * Get the platform identifier from providerConfig.
   */
  get platformId(): string | null {
    const channelProvider = getProvider(this.provider)
    if (!channelProvider) return null
    return channelProvider.getPlatformIdFromConfig(this.providerConfig)
  }

  /**
   * Determine target squad based on channel context.
   */
  resolveTargetSquad(inbound: InboundMessage): string | null {
    const { responseContext } = inbound
    const channelId = responseContext.routingChannelId ?? responseContext.channelId

    // 1. Channel mapping (e.g., #frontend channel → frontend-squad)
    if (this.channelSquadMap && channelId) {
      const mapped = this.channelSquadMap[channelId]
      if (mapped) return mapped
    }

    // 2. Default squad
    if (this.defaultSquadId) {
      return this.defaultSquadId
    }

    return null
  }

  /**
   * Resolve the target squad, guaranteed non-null.
   * Resolution order: per-channel map override → defaultSquadId.
   */
  resolveTargetSquadOrThrow(inbound: InboundMessage): string {
    const resolved = this.resolveTargetSquad(inbound)
    if (!resolved) {
      throw new Error(
        `Channel instance ${this.id} (${this.provider}) has no resolvable target squad. ` +
          `Set a defaultSquadId or channelSquadMap entry.`
      )
    }
    return resolved
  }

  /** True when this instance can resolve a target squad for any inbound. */
  hasResolvableDefault(): boolean {
    return !!this.defaultSquadId
  }

  /**
   * Queue a message for a new per-conversation consultant agent.
   * Each slash command spawns its own consultant for thread isolation.
   */
  async queueForConsultant(inbound: InboundMessage): Promise<string> {
    const { Agent } = await import('./Agent')
    const { InboxMessage } = await import('./InboxMessage')

    const targetSquad = this.resolveTargetSquadOrThrow(inbound)
    const { canUseChannel } = await import('../services/channel-access')
    if (
      !(await canUseChannel(
        this,
        inbound.responseContext.routingChannelId ?? inbound.responseContext.channelId,
        inbound.user.id,
        targetSquad
      ))
    ) {
      throw new Error('Channel sender is not authorized for this squad')
    }

    // Spawn a NEW consultant agent for this conversation
    const agent = await Agent.create({
      agentTypeId: CHANNEL_AGENT_TYPE,
      squadId: targetSquad,
      persist: true,
      context: {
        scope: { type: 'consultant' },
        channelInstance: {
          id: this.id,
          provider: this.provider,
        },
        thread: null, // Will be set after first response creates thread
      },
    })

    const content = await this.buildChannelInboxMessage(inbound, targetSquad)

    // Genuine channel correspondence explicitly wakes a dormant consultant.
    await InboxMessage.send({
      recipientId: agent.id,
      senderType: 'system',
      wakeEligible: true,
      subject: `Channel: ${inbound.command}`,
      content,
      metadata: {
        type: 'channel_message',
        channelContext: inbound.responseContext,
        channelInstanceId: this.id,
        targetSquadId: targetSquad,
        userId: inbound.user.id,
        userName: inbound.user.name,
        command: inbound.command,
        ...(inbound.imageIds?.length ? { imageIds: inbound.imageIds } : {}),
      },
    })

    log.info(`Spawned consultant ${agent.id} for ${inbound.command} from ${inbound.user.name}`)
    return agent.id
  }

  /**
   * Build inbox message for consultant based on command type.
   */
  private async buildChannelInboxMessage(inbound: InboundMessage, targetSquad: string | null): Promise<string> {
    const { content, user, responseContext } = inbound
    const platform = responseContext.provider.charAt(0).toUpperCase() + responseContext.provider.slice(1)
    let channelContext = ''
    if (responseContext.provider === 'slack') {
      const extras = responseContext.extras ?? {}
      const channelId = (extras.channelId as string | undefined) ?? responseContext.channelId
      const threadTs = responseContext.threadId ?? (extras.threadTs as string | undefined)
      const messageTs =
        responseContext.threadId ??
        (extras.parentMessageTs as string | undefined) ??
        (extras.messageTs as string | undefined) ??
        threadTs
      const teamId = extras.teamId as string | undefined
      const permalink =
        (extras.permalink as string | undefined) ??
        (channelId && messageTs ? `https://slack.com/archives/${channelId}/p${messageTs.replace('.', '')}` : undefined)
      if (channelId && threadTs && permalink) {
        channelContext = `

**Channel context (Slack):**
- channelId: \`${channelId}\`
- thread_ts: \`${threadTs}\`
- permalink: <${permalink}>
${teamId ? `- team: \`${teamId}\`\n` : ''}
When creating work from this request, attach this source with:
\`--from-slack ${permalink}\`

If the user asks to "index this thread" (or similar), ingest with:
\`ficus squad memory ingest ${targetSquad ?? '<your-squad-id>'} ${permalink}\``
      }
    }

    // All freeform commands use the same template - consultant decides how to handle
    // Status and help are handled as sync commands, so they don't reach here
    return `**${platform} from ${user.name}:** "${content}"${channelContext}`
  }

  /**
   * Handle sync commands (immediate response, no consultant needed).
   */
  async handleSyncCommand(inbound: InboundMessage): Promise<string> {
    if (inbound.command === 'status') {
      const targetSquad = this.resolveTargetSquadOrThrow(inbound)
      const squadsToQuery = [await Squad.find(targetSquad)].filter((squad) => squad !== null) as Squad[]

      const { WorkStream } = await import('./WorkStream')
      const { computeDerivedStates } = await import('../services/work-streams/derived-state')
      const { computePriorityAnnotations } = await import('../services/work-streams/priority-annotations')
      const { formatChannelWorkStreamStatus } = await import('../services/work-streams/channel-status')

      const candidates = (
        await Promise.all(
          squadsToQuery.map((squad) =>
            WorkStream.listNonTerminalOrderCandidates({
              squadId: squad.id,
              statuses: ['active', 'queued'],
              createdBefore: new Date(),
            })
          )
        )
      ).flat()

      if (candidates.length === 0) return '✅ No active or queued work streams.'

      const [priorityAnnotations, derivedStates] = await Promise.all([
        computePriorityAnnotations(candidates),
        computeDerivedStates(candidates),
      ])
      const annotated = candidates.map((stream) => ({
        ...stream,
        ...(priorityAnnotations.get(stream.id) ?? {}),
        ...(derivedStates.get(stream.id) ?? {}),
      }))
      const provider = inbound.responseContext.provider === 'discord' ? 'discord' : 'slack'
      return formatChannelWorkStreamStatus(annotated, provider)
    }

    if (inbound.command === 'notify') {
      return this.handleNotifyCommand(inbound, false)
    }

    if (inbound.command === 'unnotify') {
      return this.handleNotifyCommand(inbound, true)
    }

    if (inbound.command === 'help') {
      return (
        `**Commands:**\n` +
        `\`/ficus status\` — Show active and queued work streams\n` +
        `\`/ficus notify <squad>\` — Subscribe this channel to squad notifications\n` +
        `\`/ficus unnotify <squad>\` — Unsubscribe from squad notifications\n` +
        `\`/ficus <message>\` — Ask questions or make requests\n` +
        `\`/ficus help\` — Show this help`
      )
    }

    return `❓ Unknown: \`${inbound.command}\``
  }

  /**
   * Handle notify/unnotify command to subscribe/unsubscribe this channel from squad notifications.
   */
  private async handleNotifyCommand(inbound: InboundMessage, unsubscribe: boolean): Promise<string> {
    const squadQuery = inbound.content.trim()
    if (!squadQuery) {
      return `❌ Please specify a squad name or ID.\nUsage: \`/ficus ${unsubscribe ? 'unnotify' : 'notify'} <squad>\``
    }

    // Find squad by ID. Notification subscriptions are not constrained by channel routing.
    const squad = (await Squad.find(squadQuery)) ?? undefined

    if (!squad) {
      return `❌ Squad not found: \`${squadQuery}\``
    }

    const channelId = inbound.responseContext.channelId
    const providerKey = this.provider as 'discord' | 'slack' | 'telegram'

    if (unsubscribe) {
      // Remove notification config for this provider
      await squad.update({
        metadata: {
          notifications: {
            [providerKey]: null,
          },
        },
      })
      return `🔕 Unsubscribed from **${squad.name}** notifications.`
    } else {
      // Add notification config for this provider
      await squad.update({
        metadata: {
          notifications: {
            [providerKey]: {
              instanceId: this.id,
              channelId,
            },
          },
        },
      })
      return `🔔 This channel will now receive notifications for **${squad.name}**.`
    }
  }
}
