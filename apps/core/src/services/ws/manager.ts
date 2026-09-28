import type { ServerWebSocket } from 'bun'
import {
  parseWorkspaceVoiceUserId,
  parseAssistantInboxConversationId,
  SYSTEM_RECIPIENT_ID,
  type SquadActivityProjectionEventData,
  type Topic,
} from '@ficus/shared'
import type { Identity } from '../rbac'
import { getAccessibleSquadIds, hasPermission } from '../rbac'
import { assistantInboxOwner } from '../assistant-inbox'
import type { ClientMessage, ServerMessage } from './types'
import { isValidTopic } from './types'
import { agentTopicScope, eventSquadId, topicScope, type TopicScope } from './topic-scope'
import {
  activityAccessSignature,
  activityEventVisible,
  redactActivityEvent,
  resolveSquadActivityAccess,
} from '../squad-activity/access'

interface Client {
  id: string
  ws: ServerWebSocket<unknown>
  identity: Identity
  subscriptions: Set<string>
  activityAccessSignatures: Map<string, string>
  activityTopicGenerations: Map<string, symbol>
  activityAccessEpoch: symbol
  accessCache?: { value: string[] | 'all'; expires: number }
}

const ACCESS_CACHE_TTL_MS = 60_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_PENDING_ACTIVITY_SUBSCRIPTIONS = 64

export class WebSocketManager {
  private clients: Map<string, Client> = new Map()
  private clientIdCounter = 0

  constructor(private readonly resolveActivityAccess: typeof resolveSquadActivityAccess = resolveSquadActivityAccess) {}

  addClient(ws: ServerWebSocket<unknown>, identity: Identity): string {
    const id = `client-${++this.clientIdCounter}`
    this.clients.set(id, {
      id,
      ws,
      identity,
      subscriptions: new Set(),
      activityAccessSignatures: new Map(),
      activityTopicGenerations: new Map(),
      activityAccessEpoch: Symbol(),
    })
    return id
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId)
  }

  removeByWs(ws: ServerWebSocket<unknown>): void {
    const client = this.getClientByWs(ws)
    if (client) this.clients.delete(client.id)
  }

  getClientByWs(ws: ServerWebSocket<unknown>): Client | undefined {
    for (const client of this.clients.values()) {
      if (client.ws === ws) return client
    }
    return undefined
  }

  getDiagnostics(): {
    clients: number
    subscriptions: number
    activityAccessSignatures: number
    activityTopicGenerations: number
  } {
    let subscriptions = 0
    let activityAccessSignatures = 0
    let activityTopicGenerations = 0
    for (const client of this.clients.values()) {
      subscriptions += client.subscriptions.size
      activityAccessSignatures += client.activityAccessSignatures.size
      activityTopicGenerations += client.activityTopicGenerations.size
    }
    return { clients: this.clients.size, subscriptions, activityAccessSignatures, activityTopicGenerations }
  }

  async subscribe(clientId: string, topic: string): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) return

    if (!isValidTopic(topic)) {
      this.send(client.ws, { type: 'error', message: `Invalid topic: ${topic}` })
      return
    }

    if (topic === 'actions') {
      if (client.identity.type !== 'user') {
        this.send(client.ws, { type: 'error', code: 'FORBIDDEN_TOPIC', topic, message: 'Forbidden topic' })
        return
      }
      client.subscriptions.add(topic)
      this.send(client.ws, { type: 'subscribed', topic })
      this.send(client.ws, { type: 'event', topic, event: 'actions.invalidated', data: {} })
      return
    }

    if (topic.startsWith('squadActivity:')) {
      const squadId = topic.slice('squadActivity:'.length)
      if (!UUID_PATTERN.test(squadId)) {
        this.send(client.ws, { type: 'error', message: 'Invalid Activity topic' })
        return
      }
      if (client.subscriptions.has(topic)) {
        this.send(client.ws, { type: 'subscribed', topic })
        return
      }
      if (client.activityTopicGenerations.has(topic)) return
      const pending = [...client.activityTopicGenerations.keys()].filter(
        (pendingTopic) => !client.subscriptions.has(pendingTopic)
      ).length
      if (!client.activityTopicGenerations.has(topic) && pending >= MAX_PENDING_ACTIVITY_SUBSCRIPTIONS) {
        this.send(client.ws, { type: 'error', message: 'Too many pending Activity subscriptions' })
        return
      }
      const generation = Symbol()
      const epoch = client.activityAccessEpoch
      client.activityTopicGenerations.set(topic, generation)
      let access
      try {
        access = await this.resolveActivityAccess(client.identity, squadId)
      } catch (error) {
        if (client.activityTopicGenerations.get(topic) === generation) client.activityTopicGenerations.delete(topic)
        throw error
      }
      if (!this.isCurrentActivityGeneration(client, topic, generation, epoch)) return
      if (!access) {
        client.activityTopicGenerations.delete(topic)
        this.send(client.ws, { type: 'error', code: 'FORBIDDEN_TOPIC', topic, message: 'Forbidden topic' })
        return
      }
      client.activityAccessSignatures.set(topic, activityAccessSignature(client.identity, squadId, access))
    } else if (!(await this.canSubscribe(client, topic))) {
      this.send(client.ws, { type: 'error', code: 'FORBIDDEN_TOPIC', topic, message: 'Forbidden topic' })
      return
    }

    client.subscriptions.add(topic)
    this.send(client.ws, { type: 'subscribed', topic })
  }

  unsubscribe(clientId: string, topic: string): void {
    const client = this.clients.get(clientId)
    if (!client) return
    if (!isValidTopic(topic)) return

    client.subscriptions.delete(topic)
    client.activityAccessSignatures.delete(topic)
    if (topic.startsWith('squadActivity:')) client.activityTopicGenerations.delete(topic)
    this.send(client.ws, { type: 'unsubscribed', topic })
  }

  private isCurrentActivityGeneration(client: Client, topic: string, generation: symbol, epoch: symbol): boolean {
    return (
      this.clients.get(client.id) === client &&
      client.activityTopicGenerations.get(topic) === generation &&
      client.activityAccessEpoch === epoch
    )
  }

  private isActiveSubscriber(client: Client, topic: Topic): boolean {
    return (
      this.clients.get(client.id) === client &&
      client.subscriptions.has(topic) &&
      (client.ws.readyState === undefined || client.ws.readyState === WebSocket.OPEN)
    )
  }

  private resolveTopicScope(topic: Topic): Promise<TopicScope> {
    return topicScope(topic)
  }

  private async resolveAgentBroadcastScope(topic: Topic, event: string, data: unknown): Promise<TopicScope | null> {
    if (!data || typeof data !== 'object') return topic.startsWith('agents:') ? this.resolveTopicScope(topic) : null

    const payload = data as Record<string, unknown>
    let scope: TopicScope | null = null
    if (topic.startsWith('agents:')) scope = await this.resolveTopicScope(topic)
    else if (topic === 'agents' && typeof payload.agentId === 'string') scope = await agentTopicScope(payload.agentId)
    else if (topic === 'agents' && event === 'sandbox.status' && typeof payload.sandboxId === 'string') {
      if (payload.sandboxId.startsWith('agent_')) {
        scope = await agentTopicScope(payload.sandboxId.slice('agent_'.length))
      } else if (payload.sandboxId.startsWith('consultants_')) {
        scope = { kind: 'squad', squadId: payload.sandboxId.slice('consultants_'.length) }
      } else if (payload.sandboxId.startsWith('system_manager_')) {
        scope = { kind: 'owner', ownerUserId: payload.sandboxId.slice('system_manager_'.length) }
      }
    }

    if (scope?.kind !== 'unavailable' || event !== 'agent.deleted') return scope
    if (topic.startsWith('agents:') && payload.agentId !== topic.slice('agents:'.length)) return scope
    if (typeof payload.squadId === 'string') return { kind: 'squad', squadId: payload.squadId }
    if (typeof payload.ownerUserId === 'string') return { kind: 'owner', ownerUserId: payload.ownerUserId }
    return { kind: 'permission', permission: 'agents:read' }
  }

  broadcastActionCenterInvalidation(userIds: Iterable<string>): void {
    const audience = new Set(userIds)
    const json = JSON.stringify({
      type: 'event',
      topic: 'actions',
      event: 'actions.invalidated',
      data: {},
    } satisfies ServerMessage)

    for (const client of this.clients.values()) {
      if (client.identity.type !== 'user' || !audience.has(client.identity.userId)) continue
      if (!this.isActiveSubscriber(client, 'actions')) continue
      try {
        client.ws.send(json)
      } catch {
        if (this.clients.get(client.id) === client) this.clients.delete(client.id)
      }
    }
  }

  async broadcast(topic: Topic, event: string, data: unknown): Promise<void> {
    if (topic === 'actions') return

    const message: ServerMessage = { type: 'event', topic, event, data }
    const json = JSON.stringify(message)
    const scope = eventSquadId(event, data)
    const clients = [...this.clients.values()]
    const candidates = clients.filter((client) => {
      if (client.ws.readyState !== undefined && client.ws.readyState !== WebSocket.OPEN) {
        if (this.clients.get(client.id) === client) this.clients.delete(client.id)
        return false
      }
      return client.subscriptions.has(topic)
    })
    const currentTopicScope =
      candidates.length > 0 && !parseInboxRecipient(topic)
        ? await this.resolveAgentBroadcastScope(topic, event, data)
        : null
    // Saved Assistant mailboxes are private to their owner even on the collection topic: full
    // squad access (administrators included) never widens delivery of another user's activity.
    const privateRecipient = privateAssistantRecipient(event, data)

    // Keep Promise.all so the first send rejection still rejects broadcast, matching its existing contract.
    await Promise.all(
      candidates.map(async (client) => {
        if (!this.isActiveSubscriber(client, topic)) return

        const authorized = privateRecipient
          ? await this.canAccessInboxRecipient(privateRecipient, client)
          : await this.canReceive(client, topic, scope, currentTopicScope)
        if (!authorized || !this.isActiveSubscriber(client, topic)) return

        client.ws.send(json)
      })
    )
  }

  async revalidateActivitySubscriptions(squadId?: string): Promise<void> {
    const targetedTopic = squadId ? `squadActivity:${squadId}` : null
    for (const client of this.clients.values()) {
      if (targetedTopic) {
        if (client.subscriptions.has(targetedTopic)) client.activityTopicGenerations.set(targetedTopic, Symbol())
        else client.activityTopicGenerations.delete(targetedTopic)
      } else {
        client.activityAccessEpoch = Symbol()
        for (const topic of client.activityTopicGenerations.keys())
          if (!client.subscriptions.has(topic)) client.activityTopicGenerations.delete(topic)
      }
    }
    await Promise.all(
      [...this.clients.values()].flatMap((client) =>
        [...client.subscriptions]
          .filter((topic) => topic.startsWith('squadActivity:') && (!squadId || topic === `squadActivity:${squadId}`))
          .map(async (topic) => {
            const subscribedSquadId = topic.slice('squadActivity:'.length)
            const generation = client.activityTopicGenerations.get(topic)!
            const epoch = client.activityAccessEpoch
            const access = await this.resolveActivityAccess(client.identity, subscribedSquadId)
            if (!this.isCurrentActivityGeneration(client, topic, generation, epoch) || !client.subscriptions.has(topic))
              return
            const previous = client.activityAccessSignatures.get(topic)
            if (!access) {
              client.subscriptions.delete(topic)
              client.activityAccessSignatures.delete(topic)
              client.activityTopicGenerations.delete(topic)
            } else {
              const next = activityAccessSignature(client.identity, subscribedSquadId, access)
              if (previous === next) return
              client.activityAccessSignatures.set(topic, next)
            }
            this.send(client.ws, {
              type: 'event',
              topic: topic as Topic,
              event: 'squadActivity.accessRevoked',
              data: { squadId: subscribedSquadId },
            })
          })
      )
    )
  }

  async purgeActivitySubscriptions(squadId: string): Promise<void> {
    const topic = `squadActivity:${squadId}` as Topic
    for (const client of this.clients.values())
      if (this.isActiveSubscriber(client, topic)) {
        client.activityTopicGenerations.set(topic, Symbol())
        this.send(client.ws, {
          type: 'event',
          topic,
          event: 'squadActivity.accessRevoked',
          data: { squadId },
        })
      }
  }

  async broadcastActivity(data: SquadActivityProjectionEventData): Promise<void> {
    const topic = `squadActivity:${data.squadId}` as Topic
    await Promise.all(
      [...this.clients.values()].map(async (client) => {
        if (!this.isActiveSubscriber(client, topic)) return
        const generation = client.activityTopicGenerations.get(topic)!
        const epoch = client.activityAccessEpoch
        const access = await this.resolveActivityAccess(client.identity, data.squadId)
        if (
          !this.isActiveSubscriber(client, topic) ||
          !this.isCurrentActivityGeneration(client, topic, generation, epoch)
        )
          return
        if (!access) {
          client.subscriptions.delete(topic)
          client.activityAccessSignatures.delete(topic)
          client.activityTopicGenerations.delete(topic)
          this.send(client.ws, {
            type: 'event',
            topic,
            event: 'squadActivity.accessRevoked',
            data: { squadId: data.squadId },
          })
          return
        }
        const signature = activityAccessSignature(client.identity, data.squadId, access)
        if (client.activityAccessSignatures.get(topic) !== signature) {
          client.activityAccessSignatures.set(topic, signature)
          this.send(client.ws, {
            type: 'event',
            topic,
            event: 'squadActivity.accessRevoked',
            data: { squadId: data.squadId },
          })
          if (data.operation === 'delete') return
        }
        if (!activityEventVisible(access, data) || !this.isActiveSubscriber(client, topic)) return
        this.send(client.ws, {
          type: 'event',
          topic,
          event: 'squadActivity.projected',
          data: redactActivityEvent(access, data),
        })
      })
    )
  }

  handleMessage(ws: ServerWebSocket<unknown>, rawData: string): void {
    const client = this.getClientByWs(ws)
    if (!client) return

    try {
      const message: ClientMessage = JSON.parse(rawData)
      switch (message.type) {
        case 'subscribe':
          void this.subscribe(client.id, message.topic).catch((error) => {
            console.error('[ws] subscription failed:', error)
            if (this.clients.get(client.id) === client) this.send(ws, { type: 'error', message: 'Subscription failed' })
          })
          break
        case 'unsubscribe':
          this.unsubscribe(client.id, message.topic)
          break
        default:
          this.send(ws, { type: 'error', message: 'Unknown message type' })
      }
    } catch {
      this.send(ws, { type: 'error', message: 'Invalid JSON' })
    }
  }

  invalidateAccessCache(): void {
    for (const client of this.clients.values()) client.accessCache = undefined
    void this.revalidateActivitySubscriptions().catch((error) =>
      console.error('[ws] Activity subscription revalidation failed:', error)
    )
  }

  private async getAccessible(client: Client): Promise<string[] | 'all'> {
    const now = Date.now()
    if (client.accessCache && client.accessCache.expires > now) return client.accessCache.value
    const value = await getAccessibleSquadIds(client.identity)
    client.accessCache = { value, expires: now + ACCESS_CACHE_TTL_MS }
    return value
  }

  // Inbox recipient access for WS topics: own personal/voice inbox, or the shared system inbox
  // when the client holds inbox:system. Falls back to identity matching for agent/user/voice.
  private async canAccessInboxRecipient(recipientId: string, client: Client): Promise<boolean> {
    if (parseAssistantInboxConversationId(recipientId))
      return (
        (await assistantInboxOwner(recipientId)) === identityUserId(client.identity) &&
        identityUserId(client.identity) !== null
      )
    if (recipientMatchesIdentity(recipientId, client.identity)) return true
    if (recipientId === SYSTEM_RECIPIENT_ID) return hasPermission(client.identity, 'inbox:system')
    return false
  }

  private async canAccessTopicScope(client: Client, scope: TopicScope): Promise<boolean> {
    if (scope.kind === 'owner') return identityUserId(client.identity) === scope.ownerUserId
    if (scope.kind === 'permission') {
      if (client.identity.type === 'agent' && !client.identity.userId) return false
      return hasPermission(client.identity, scope.permission)
    }
    if (scope.kind === 'unavailable') return false

    const accessible = await this.getAccessible(client)
    if (accessible === 'all') return true
    if (scope.kind === 'squad') return accessible.includes(scope.squadId)
    if (scope.kind === 'recipient') return this.canAccessInboxRecipient(scope.recipientId, client)
    return false
  }

  private async canSubscribe(client: Client, topic: Topic): Promise<boolean> {
    if (topic.startsWith('squadActivity:'))
      return (await resolveSquadActivityAccess(client.identity, topic.slice('squadActivity:'.length))) !== null
    const scope = await topicScope(topic)
    if (scope.kind === 'collection') return true
    return this.canAccessTopicScope(client, scope)
  }

  private async canReceive(
    client: Client,
    topic: Topic,
    scope: string | 'global' | null,
    currentTopicScope: TopicScope | null
  ): Promise<boolean> {
    if (currentTopicScope && currentTopicScope.kind !== 'collection' && currentTopicScope.kind !== 'unresolved') {
      return this.canAccessTopicScope(client, currentTopicScope)
    }

    const accessible = await this.getAccessible(client)
    if (accessible === 'all') return true
    if (scope === 'global') return true
    if (typeof scope === 'string') return accessible.includes(scope)

    const topicRecipient = parseInboxRecipient(topic)
    if (topicRecipient) return this.canAccessInboxRecipient(topicRecipient, client)

    // Null-scope agent resources were authorized against their current DB scope above.
    // Unrelated null-scope collections and unresolved instance resources remain fail-closed.
    return false
  }

  private send(ws: ServerWebSocket<unknown>, message: ServerMessage): void {
    if (ws.readyState !== undefined && ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(message))
  }
}

function parseInboxRecipient(topic: string): string | null {
  return topic.startsWith('inbox:') ? topic.slice('inbox:'.length) : null
}

/** Recipient of an inbox-family event addressed to a saved Assistant conversation, else null. */
function privateAssistantRecipient(event: string, data: unknown): string | null {
  if (event !== 'assistant.activityChanged' && !event.startsWith('inbox.')) return null
  const recipientId = (data as { recipientId?: unknown } | null)?.recipientId
  return typeof recipientId === 'string' && parseAssistantInboxConversationId(recipientId) ? recipientId : null
}

function identityUserId(identity: Identity): string | null {
  if (identity.type === 'user') return identity.userId
  if (identity.type === 'agent') return identity.userId ?? null
  return null
}

function recipientMatchesIdentity(recipientId: string, identity: Identity): boolean {
  if (identity.type === 'user') {
    // A user matches only their own personal inbox id or their per-user voice
    // (workspace:<userId>) inbox. The shared system inbox topic is permission-gated
    // separately (see canReceive); it is never matched here.
    if (recipientId === identity.userId) return true
    return parseWorkspaceVoiceUserId(recipientId) === identity.userId
  }
  if (identity.type === 'agent') return identity.agentId === recipientId
  return false
}

export const wsManager = new WebSocketManager()
