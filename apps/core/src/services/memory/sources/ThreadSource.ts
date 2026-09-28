/**
 * Thread source adapter for memory indexing.
 *
 * Indexes agent conversation threads into the memory system.
 * Each agent's full message history becomes a searchable memory document
 * with metadata about the agent type and work stream context.
 */

import { messageSortAt, type MessageMetadata } from '@ficus/shared'
import { eq, and, arrayContains, asc } from 'drizzle-orm'
import { db } from '../../../db'
import { agents, messages, memoryDocuments, workStreams } from '../../../db/schema'
import { messageSortAtSql, visibleMessageSql } from '../../../entities/message-time'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'
import { BaseMemorySourceAdapter, sourceCapabilities, type DiscoveredItem, type FetchedContent } from './adapter'
import { IndexedDocumentWriter } from './IndexedDocumentWriter'
import { mergePolicyErrors, validateBaseIngestionPolicy, validateStringArrayScope } from './policy'
import type { IndexResult } from './types'

interface ThreadMessage {
  id: string
  role: 'human' | 'assistant'
  content: string
  metadata?: MessageMetadata | null
  createdAt: Date
}

interface MemoryDocument {
  id: string
  squadId: string
  sourceType: string
  sourceId: string
  title: string | null
  path: string | null
  frontmatter: Record<string, unknown>
  sensitivity: 'internal'
  contentHash: string
  createdAt: Date
  updatedAt: Date
}

export class ThreadSource extends BaseMemorySourceAdapter {
  private static _instance: ThreadSource | null = null

  static instance(): ThreadSource {
    if (!ThreadSource._instance) {
      ThreadSource._instance = new ThreadSource()
    }
    return ThreadSource._instance
  }

  /** Reset singleton (for testing) */
  static _reset(): void {
    ThreadSource._instance = null
  }

  readonly sourceType = 'agent_thread'
  readonly capabilities = sourceCapabilities(['searchable', 'readable', 'incremental'])
  readonly defaultSensitivity = 'internal' as const

  async list(squadId: string, opts: { since?: string; agentTypes?: string[] } = {}): Promise<DiscoveredItem[]> {
    const config = await SquadSourceConfig.findBySquadAndType(squadId, 'agent_thread')
    if (config?.enabled === false) return []
    const agentTypes = opts.agentTypes ?? getPolicyStringArray(config?.policy, 'agentTypes')
    const squadAgents = await db
      .select({ id: agents.id, agentTypeId: agents.agentTypeId })
      .from(agents)
      .where(eq(agents.squadId, squadId))
    return squadAgents
      .filter((agent) => !agentTypes || agentTypes.includes(agent.agentTypeId))
      .map((agent) => ({ sourceId: agent.id }))
  }

  validatePolicy(policy: unknown): string[] | null {
    return mergePolicyErrors(validateBaseIngestionPolicy(policy), validateStringArrayScope(policy, 'agentTypes'))
  }

  async fetch(squadId: string, agentId: string): Promise<FetchedContent | null> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
    if (!agent || agent.squadId !== squadId) return null

    const threadMessages = await db
      .select()
      .from(messages)
      .where(and(eq(messages.agentId, agentId), visibleMessageSql))
      .orderBy(asc(messageSortAtSql), asc(messages.id))
    if (threadMessages.length === 0) return null

    const workStreamIds = await this.getWorkStreamIds(agentId)
    const { content, events } = this.buildContentWithEvents(threadMessages as ThreadMessage[], agentId, workStreamIds)
    return {
      content,
      title: `${agent.agentTypeId} Thread (${threadMessages.length} messages)`,
      path: null,
      frontmatter: {
        kind: 'thread',
        agentId,
        agentType: agent.agentTypeId,
        workStreamIds,
        messageCount: threadMessages.length,
      },
      chunkMetadata: { sourceType: 'agent_thread', agentId, agentType: agent.agentTypeId, workStreamIds },
      chunkMetadataForChunk: (chunk) => {
        const event = events.find(
          (candidate) => candidate.endLine >= chunk.startLine && candidate.startLine <= chunk.endLine
        )
        return event ? { event: event.event, parent: event.parent } : {}
      },
      sensitivity: this.defaultSensitivity,
      wikilinks: [],
    }
  }

  async index(squadId: string, agentId: string): Promise<IndexResult> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
    if (!agent) {
      return { success: false, chunksCreated: 0, linksCreated: 0, error: `Agent ${agentId} not found` }
    }
    if (agent.squadId !== squadId) {
      return {
        success: false,
        chunksCreated: 0,
        linksCreated: 0,
        error: `Agent ${agentId} does not belong to squad ${squadId}`,
      }
    }

    const fetched = await this.fetch(squadId, agentId)
    if (!fetched) {
      return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true }
    }

    const config = await SquadSourceConfig.findBySquadAndType(squadId, 'agent_thread')
    if (config?.enabled === false) return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true }

    return IndexedDocumentWriter.instance().writeDocument({
      squadId,
      sourceType: this.sourceType,
      sourceId: agentId,
      fetched,
      adapterDefaultSensitivity: this.defaultSensitivity,
      policy: config?.policy,
      chunker: 'markdown',
    })
  }

  async exists(squadId: string, agentId: string): Promise<boolean> {
    const doc = await this.getDocument(squadId, agentId)
    return doc !== undefined
  }

  async remove(squadId: string, agentId: string): Promise<void> {
    const doc = await this.getDocument(squadId, agentId)
    if (!doc) return
    await db.delete(memoryDocuments).where(eq(memoryDocuments.id, doc.id))
  }

  /**
   * Build markdown content from a list of messages.
   * Formats messages in chronological order with role markers.
   */
  buildContent(threadMessages: ThreadMessage[]): string {
    return this.buildContentWithEvents(threadMessages).content
  }

  private buildContentWithEvents(threadMessages: ThreadMessage[], agentId?: string, workStreamIds: string[] = []) {
    if (threadMessages.length === 0) {
      return { content: '', events: [] }
    }

    const sections: string[] = []
    const events: Array<{
      startLine: number
      endLine: number
      event: { ts: string; actor: string; externalId: string }
      parent: { agentId?: string; workStreamId?: string }
    }> = []
    let nextLine = 1

    for (const msg of threadMessages) {
      const roleLabel = msg.role === 'human' ? 'Human' : 'Assistant'
      const section = `## ${roleLabel}:\n\n${msg.content}`
      const lineCount = section.split('\n').length
      events.push({
        startLine: nextLine,
        endLine: nextLine + lineCount - 1,
        event: {
          ts: new Date(messageSortAt({ ...msg, metadata: msg.metadata ?? null })).toISOString(),
          actor: msg.role,
          externalId: msg.id,
        },
        parent: { agentId, ...(workStreamIds[0] ? { workStreamId: workStreamIds[0] } : {}) },
      })
      sections.push(section)
      nextLine += lineCount + 4
    }

    return { content: sections.join('\n\n---\n\n'), events }
  }

  private async getDocument(squadId: string, agentId: string): Promise<MemoryDocument | undefined> {
    const [doc] = await db
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, 'agent_thread'),
          eq(memoryDocuments.sourceId, agentId)
        )
      )
      .limit(1)

    return doc as MemoryDocument | undefined
  }

  /**
   * Get all work stream IDs for an agent.
   * Returns all work streams where the agent is in the agentIds list.
   * (assignee is always included in agentIds, so no need to query separately)
   */
  private async getWorkStreamIds(agentId: string): Promise<string[]> {
    const workStreamRows = await db
      .select({ id: workStreams.id })
      .from(workStreams)
      .where(arrayContains(workStreams.agentIds, [agentId]))

    return workStreamRows.map((ws) => ws.id)
  }
}

function getPolicyStringArray(policy: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const scope = policy?.scope
  if (!scope || typeof scope !== 'object') return undefined
  const value = (scope as Record<string, unknown>)[key]
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}
