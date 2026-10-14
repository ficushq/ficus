import { messageTextForModel } from '../../services/chat/message-context'
import type { SessionDeliveryOwner } from '../../services/agent/pending-delivery'
import type { Message, MessageMetadata } from '@ficus/shared'
import { Image, type ImageContent } from '../Image'
import type { Agent } from '../Agent'
import type { AgentSession } from '../AgentSession'
import { createLogger } from '../../lib/infra/logger'
import { eventEmitter } from '../../lib/infra/event-emitter'

const log = createLogger('runner')

export interface PendingInterventionQueueDeps {
  deliveryOwner: SessionDeliveryOwner
  agentId: string
  /** The runner's agent entity — spies in tests intercept THESE methods; never bypass them. */
  agent: Pick<
    Agent,
    | 'listPendingInterventionsForSessionDelivery'
    | 'claimPendingInterventionForSessionDelivery'
    | 'resetPendingInterventionSessionDelivery'
  >
  targetAgent?: Agent
  getSession: () => AgentSession
  isActive: () => boolean
  /** Image seams default to the Image entity statics; injectable for unit tests. */
  loadImages?: (imageIds: string[]) => Promise<ImageContent[]>
  markImagesUsed?: (imageIds: string[]) => Promise<unknown>
  /** Adds server-owned context to a claimed message before the model reads it (see AgentRunner). */
  prepare?: (message: Message) => Promise<Message>
}

export class PendingInterventionQueue {
  private unsubscribe: (() => void) | null = null
  private drain: Promise<void> | null = null
  private drainRequested = false
  private closed = false

  constructor(private readonly deps: PendingInterventionQueueDeps) {}

  start(): void {
    this.clear()
    this.closed = false
    this.unsubscribe = eventEmitter.on('message.created', ({ agentId }) => {
      if (agentId === this.deps.agentId) this.schedule()
    })
    this.schedule()
  }

  schedule(): void {
    this.drainQueue().catch((error) => {
      log.error(`Failed to drain pending intervention queue for agent ${this.deps.agentId}:`, error)
    })
  }

  clear(): void {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  async close(): Promise<void> {
    this.clear()
    await this.drain
  }

  private isActive(): boolean {
    return !this.closed && this.deps.isActive()
  }

  private async drainQueue(): Promise<void> {
    if (this.drain) {
      this.drainRequested = true
      await this.drain
      return
    }

    do {
      this.drainRequested = false
      this.drain = this.drainOnce()
      try {
        await this.drain
      } finally {
        this.drain = null
      }
    } while (this.drainRequested)
  }

  private async drainOnce(): Promise<void> {
    if (!this.isActive()) return

    const pending = await this.deps.agent.listPendingInterventionsForSessionDelivery()
    for (const message of pending) {
      if (!this.isActive()) return
      const claimed = await this.deps.agent.claimPendingInterventionForSessionDelivery(
        message.id,
        this.deps.deliveryOwner
      )
      if (!claimed) continue
      try {
        await this.deliverClaimed(this.deps.prepare ? await this.deps.prepare(claimed) : claimed)
      } catch (error) {
        await this.deps.agent.resetPendingInterventionSessionDelivery(claimed.id, claimed.metadata?.sessionDelivery)
        log.error(`Failed to deliver pending intervention ${claimed.id} for agent ${this.deps.agentId}:`, error)
      }
    }
  }

  private async deliverClaimed(message: {
    id: string
    content: string
    metadata?: MessageMetadata | null
  }): Promise<void> {
    const mode = message.metadata?.deliveryMode === 'follow-up' ? 'follow-up' : 'steer'
    const imageIds = message.metadata?.imageIds ?? []
    const images =
      imageIds.length > 0
        ? await (this.deps.loadImages ?? ((ids) => Image.loadManyForAgent(ids, this.deps.targetAgent!)))(imageIds)
        : undefined

    if (!this.isActive()) throw new Error('Session closed before queue admission')
    const options = { deliveryId: message.metadata?.sessionDelivery?.id }
    if (mode === 'follow-up') {
      await this.deps.getSession().pi.followUp(messageTextForModel(message), images, options)
    } else {
      // Pending rows without an explicit deliveryMode are normal user messages,
      // accepted after the initial prompt claim. The initial batch and this
      // live drain use the same identity-fenced persistence acknowledgment.
      await this.deps.getSession().pi.steer(messageTextForModel(message), images, options)
    }

    if (imageIds.length > 0) {
      await (this.deps.markImagesUsed ?? ((ids) => Image.markManyUsed(ids)))(imageIds).catch((err) => {
        log.error(`Failed to mark images used for pending message ${message.id}:`, err)
      })
    }
  }
}
