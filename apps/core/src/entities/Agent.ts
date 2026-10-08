import { isUserAssistantAgentType } from '@ficus/shared'
import { consultantSandboxId } from '../services/sandbox/consultant-sandbox'
import { lockFlowInboxDelivery, assertCurrentIntegrationInbox } from '../services/work-streams/wait-scope'
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm'

import {
  agents,
  agentFileAttachments,
  agentTokens,
  chatSendReceipts,
  db,
  executionAdmissionReservations,
  executions,
  messageAgentFileAttachments,
  messages,
} from '../db'

import {
  Agent as AgentJson,
  AgentContext,
  AgentMetadata,
  AgentStatus,
  AmtpSignedAgentCard,
  ExecutionStatus,
  QuestionData,
  SessionUsage,
  Message,
  CreateMessageInput,
  MessageMetadata,
  extractAgentAttachmentReferences,
  isLiveAgentStatus,
  LIVE_AGENT_STATUSES,
} from '@ficus/shared'
import { AgentRunnerType } from './agent-runners/base'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID, ARTIFACT_BUILDER_RUNNER_TYPE } from './agent-runners/constants'
import { generateAgentName } from '../lib/utils/agent-names'
import { eventEmitter } from '../lib/infra/event-emitter'
import { AgentType } from './AgentType'
import { resolveAgentTypeChain } from '../services/model-selection/model-tier-resolution'
import { SUBAGENT_RUNNER_TYPE } from './Subagent'

// Forward declaration to avoid circular import at module load time
import type { Squad } from './Squad'
import { Execution } from './Execution'
import { Image } from './Image'
import {
  assertAttachmentInScope,
  InvalidAttachmentError,
  resolveAttachmentScope,
  type AttachmentScope,
} from '../services/attachments/agent-scope'
import { BaseEntity } from './base'
import { splitModelPriorityList, supportsImageInput, validateModelSpecList } from '../lib/utils/model-spec'
import { randomUUID, createHash } from 'crypto'
import { chatSendRequestHashes } from '../services/agents/chat-send-request-hash'
import { cacheAgentToken, getCachedAgentToken, removeCachedAgentToken } from '../services/rbac/token-cache'
import { AGENT_TOKEN_PREFIX } from '../services/auth/token-prefixes'
import * as pendingDelivery from '../services/agent/pending-delivery'
import { maintenanceStore } from '../services/maintenance/store'
import { decodeMessageCursor, encodeMessageCursor, InvalidMessageCursorError } from '../services/agent/message-cursor'
import * as lifecycle from '../services/agent/lifecycle'
import { withoutDelta } from '../services/execution/usage-delta'
import { mapMessage } from './message-mapper'
import { databaseClockNow } from '../db/clock'
import { messageEventData } from './message-event'
import { ACTIVE_EXECUTION_STATUSES } from '../services/execution/status'
import { refreshAgentActivity } from '../services/agents/activity-summary'
import { ChatIdempotencyConflictError } from '../services/chat/consultant-idempotency'
import {
  acquireAgentQueueLock,
  createQueuedAdmission,
  loadCurrentAdmission,
  releaseExactAdmission,
} from '../services/execution/agent-admission'

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type AfterCommitCallback = () => void | Promise<void>

export class AgentTargetUnavailableError extends Error {
  readonly code: string = 'AGENT_TARGET_UNAVAILABLE'

  constructor(agentId: string, message = `Agent ${agentId} is terminating or unavailable`) {
    super(message)
    this.name = 'AgentTargetUnavailableError'
  }
}

export class AgentTerminatedError extends AgentTargetUnavailableError {
  override readonly code = 'AGENT_TERMINATED'

  constructor(agentId: string) {
    super(agentId)
    this.message = `Agent ${agentId} is terminated and cannot be woken`
    this.name = 'AgentTerminatedError'
  }
}

type SendMessageLockedHook = (tx: DbTransaction, agentId: string) => Promise<void>
let agentUpdatePrewriteHook: ((agentId: string) => Promise<void>) | undefined
export function setAgentUpdatePrewriteHookForTest(hook: ((agentId: string) => Promise<void>) | undefined): void {
  agentUpdatePrewriteHook = hook
}
let sendMessageLockedHook: SendMessageLockedHook | undefined

export function setSendMessageLockedHookForTests(hook?: SendMessageLockedHook): void {
  sendMessageLockedHook = hook
}

function assertReadyAttachmentReference(
  row: typeof agentFileAttachments.$inferSelect | undefined,
  reference: { path: string },
  scope: Awaited<ReturnType<typeof resolveAttachmentScope>>
): asserts row is typeof agentFileAttachments.$inferSelect {
  if (!row || row.status === 'uploading' || row.privatePath !== reference.path) throw new InvalidAttachmentError()
  assertAttachmentInScope(row, scope)
}
import {
  agentSelectColumns,
  countAgents,
  findAgentRow,
  findAgentRowByFederationHandle,
  findAgentRowByThreadId,
  findMessageById,
  insertAgent,
  listAgentRows,
  listFederationHandles,
  listFederationHandleRecords,
  takenNamesInSquad,
  validateAgentIds,
  validateModelOverrides,
  type AgentRow,
  type ListAgentsFilters,
} from './agent-queries'

export type { AgentRow }

export interface CreateAgentInput {
  id?: string
  agentTypeId: string
  name?: string
  squadId?: string | null
  ownerUserId?: string | null
  parentAgentId?: string
  context?: AgentContext
  metadata?: Record<string, unknown>
  persist?: boolean
  modelOverride?: string | null
}

export interface UpdateAgentInput {
  name?: string
  purpose?: string | null
  status?: AgentStatus
  context?: AgentContext
  questionData?: QuestionData | null
  sessionUsage?: SessionUsage | null
  persist?: boolean
  modelOverride?: string | null
  dormantAt?: Date | null
  terminatedAt?: Date | null
  pendingDormancyAt?: Date | null
  metadata?: Record<string, unknown>
  amtpHandle?: string | null
  identityPublicKey?: string | null
  inboundOpen?: boolean
  cardJson?: AmtpSignedAgentCard | null
  /**
   * vm runtime: pin the agent's box to a specific machine (`null` unpins →
   * placement default). Written straight through to the row; validated
   * (must reference a ready machine) at the route layer via assertMachinePinReady.
   */
  machineId?: string | null
}

export type { ListAgentsFilters }

export interface ListMessagesOptions {
  /** Max messages to return */
  limit?: number
  /** Offset for pagination */
  offset?: number
  /** Only messages before this ISO timestamp */
  before?: string
  /** Opaque compound pagination cursor. */
  cursor?: string
  /** @deprecated Use cursor. */
  beforeId?: string
  /** Only messages after this ISO timestamp */
  after?: string
  /** Fuzzy search on message content (case-insensitive) */
  search?: string
  /** Filter by role */
  role?: 'human' | 'assistant'
}

export interface ListMessagesResult {
  messages: Message[]
  pagination: {
    hasMore: boolean
    totalCount: number
    oldestId?: string
    newestId?: string
    nextCursor?: string
  }
}

export interface CreateExecutionInput {
  message?: string
  imageIds?: string[]
  metadata?: MessageMetadata
  /** Authenticated actor allowed to claim staged image IDs for this send. */
  attachmentActorUserId?: string
  /**
   * Attachment scope pre-resolved OUTSIDE the caller's transaction. Required
   * whenever imageIds is non-empty and queueExecutionInTransaction runs
   * inside an already-open transaction — resolving it in-transaction issues
   * pool reads while a connection is held (hold-and-wait; db/connection.ts).
   */
  attachmentScope?: AttachmentScope
  /** Runs only after an accepted idempotent replay has been ruled out. */
  validateNewAcceptance?: () => void
  /** Internal lifecycle snapshot captured before any async admission work. */
  lifecycleDormancyEpisodeAtAcceptance?: string | null
}

/**
 * The sandbox id for an agent's own light container. The agent id is already
 * unique, so the id alone identifies the box — defined here once so every
 * caller (the entity method and the artifact-builder fallbacks) agrees.
 */
export function agentWorkspaceSandboxId(agentId: string): string {
  return `agent_${agentId}`
}

/**
 * The shared sandbox id for a user's system-manager(s). A system-manager is the
 * user's account-level agent (owner-scoped, runs with the owner's permissions),
 * so all of a user's system-managers share one light sandbox + /private. Scoped
 * per owning user so files never cross accounts now that multiple users exist.
 */
export function systemManagerSandboxId(ownerUserId: string): string {
  return `system_manager_${ownerUserId}`
}

export class Agent extends BaseEntity<AgentJson, UpdateAgentInput> implements AgentRow {
  // Row fields, always present
  declare id: string
  declare agentTypeId: string
  declare squadId: string | null
  declare ownerUserId: string | null
  declare parentAgentId: string | null
  declare status: AgentStatus
  declare persist: boolean
  declare modelOverride: string | null
  declare selectedModel: string | null
  declare metadata: AgentMetadata | null
  declare context: AgentContext
  declare questionData: QuestionData | null
  declare sessionUsage: SessionUsage | null
  declare dormantAt: Date | null
  declare terminatedAt: Date | null
  declare pendingDormancyAt: Date | null
  declare amtpHandle: string | null
  declare identityPublicKey: string | null
  declare inboundOpen: boolean
  declare cardJson: AmtpSignedAgentCard | null
  declare machineId: string | null
  declare createdAt: Date
  declare updatedAt: Date

  // Other fields, occasionally present
  lastMessageAt: Date | null = null
  lastHumanMessageAt: Date | null = null
  lastMessagePreview: string | null = null

  // Relation cache (use getters to load and cache)
  private _agentType?: AgentType | null
  private _squad?: Squad | null

  constructor(data: AgentRow) {
    super()

    Object.assign(this, data)

    // Defensive defaults for legacy/projection rows constructed outside the
    // canonical selector; persisted rows always provide both fields.
    if (this.status === undefined) this.status = 'idle'
    if (this.dormantAt === undefined) this.dormantAt = null

    if (this.lastMessageAt === undefined) {
      this.lastMessageAt = null
    } else if (typeof this.lastMessageAt === 'string') {
      this.lastMessageAt = new Date(this.lastMessageAt)
    }

    if (this.lastHumanMessageAt === undefined) {
      this.lastHumanMessageAt = null
    } else if (typeof this.lastHumanMessageAt === 'string') {
      this.lastHumanMessageAt = new Date(this.lastHumanMessageAt)
    }

    if (this.lastMessagePreview === undefined) {
      this.lastMessagePreview = null
    }
  }

  toJSON() {
    return {
      id: this.id,
      agentTypeId: this.agentTypeId,
      squadId: this.squadId,
      parentAgentId: this.parentAgentId,
      status: this.status,
      persist: this.persist,
      metadata: this.metadata,
      context: this.context,
      questionData: this.questionData,
      sessionUsage: this.sessionUsage ? withoutDelta(this.sessionUsage) : this.sessionUsage,
      dormantAt: this.dormantAt,
      terminatedAt: this.terminatedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastMessageAt: this.lastMessageAt,
      lastHumanMessageAt: this.lastHumanMessageAt,
      lastMessagePreview: this.lastMessagePreview,
    }
  }

  static get selectColumns() {
    return agentSelectColumns
  }

  /**
   * Create a new agent.
   */
  /**
   * Names already assigned to agents in a squad — used to keep auto-generated names unique per squad.
   * Includes terminated agents on purpose: they persist in inbox/message history and are referred to
   * by name, so reusing a dead agent's name would reintroduce temporal ambiguity. Only once the whole
   * pool is exhausted does generateAgentName fall back to reuse.
   */
  static async takenNamesInSquad(squadId: string): Promise<string[]> {
    return takenNamesInSquad(squadId)
  }

  static async create(input: CreateAgentInput, authorizeInsert?: (tx: DbTransaction) => Promise<void>): Promise<Agent> {
    const id = input.id ?? crypto.randomUUID()
    // Auto-generated names are unique within a squad (best-effort: concurrent creates can still
    // collide, but squad agents are created serially by the manager). Explicit names pass through.
    let name = input.name
    if (name == null) {
      const taken = input.squadId ? await Agent.takenNamesInSquad(input.squadId) : undefined
      name = generateAgentName(taken)
    }
    const metadata: AgentMetadata = { name, ...input.metadata, resourceGeneration: crypto.randomUUID() }

    await Agent.validateModelOverrides(input)

    // Manager agents are always persistent
    const persist = input.agentTypeId === 'manager' ? true : (input.persist ?? false)

    const values = {
      id,
      agentTypeId: input.agentTypeId,
      squadId: input.squadId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      parentAgentId: input.parentAgentId ?? null,
      metadata,
      context: input.context ?? {},
      persist,
      modelOverride: input.modelOverride ?? null,
    }
    // Internal ingress gate: the guard and insert share one transaction. Provider I/O must
    // finish before this callback; ordinary creation keeps its existing behavior.
    if (authorizeInsert)
      await db.transaction(async (tx) => {
        await authorizeInsert(tx)
        await insertAgent(values, tx)
      })
    else await insertAgent(values)

    const agent = await Agent.mustFind(id)
    eventEmitter.emit('agent.created', { agentId: agent.id, squadId: agent.squadId })

    return agent
  }

  static async validateModelOverrides(input: { agentTypeId: string; modelOverride?: string | null }): Promise<void> {
    return validateModelOverrides(input)
  }

  /**
   * Find an agent by ID.
   * @param id - The ID of the agent to find (potentially a prefix).
   * @param options.eager - Eager-load the squad + agent type (default `true`).
   *   Pass `false` from background sweeps that only read row fields: the
   *   relations stay reachable through the lazy `getSquad()`/`getAgentType()`
   *   getters, they are just not prefetched. Request paths must keep the
   *   default — the eager load is what makes their serialization cheap.
   * @returns The agent or null if not found.
   * @throws An error if the agent ID is ambiguous (prefix with multiple matches).
   */
  static async find(id: string, options: { eager?: boolean } = {}): Promise<Agent | null> {
    const row = await findAgentRow(id)
    if (!row) return null

    const agent = new Agent(row)
    if (options.eager !== false) await agent.eagerLoadRelations()
    return agent
  }

  /**
   * Must find an agent, throwing an error if not found.
   * @param id - The ID of the agent to find (potentially a prefix).
   * @returns The agent.
   * @throws An error if the agent is not found.
   */
  static async mustFind(id: string, options: { eager?: boolean } = {}): Promise<Agent> {
    const agent = await this.find(id, options)
    if (!agent) throw new Error(`Agent ${id} not found`)
    return agent
  }

  /**
   * Find a message by ID.
   * @param messageId - The ID of the message to find.
   * @returns The message or null if not found.
   */
  static async findMessage(messageId: string): Promise<Message | null> {
    return findMessageById(messageId)
  }

  /**
   * Find a consultant agent by thread ID and provider.
   * Used for routing reply messages to the correct agent handling a thread.
   * @param provider - The channel provider (e.g. 'discord', 'slack')
   * @param threadId - The thread ID to search for
   * @returns The agent or null if not found
   */
  static async findByThreadId(
    provider: string,
    threadId: string,
    instanceId?: string,
    channelId?: string
  ): Promise<Agent | null> {
    const row = await findAgentRowByThreadId(provider, threadId, instanceId, channelId)
    return row ? new Agent(row) : null
  }

  /**
   * Find a published agent by its federation handle. Only resolves live agents —
   * a terminated agent keeps its handle in history (so inbox rows still attribute a
   * name) but must not receive new remote mail.
   * @param handle - The `<handle>` segment of an amtp://<instanceId>/<handle> address.
   * @returns The agent, or null if no live agent publishes that handle.
   */
  static async findByFederationHandle(handle: string): Promise<Agent | null> {
    const row = await findAgentRowByFederationHandle(handle)
    if (!row) return null

    const agent = new Agent(row)
    await agent.eagerLoadRelations()
    return agent
  }

  /**
   * All handles this instance currently publishes: live (non-terminated) agents
   * with a registered amtpHandle, sorted for stable discovery output.
   * Peer-facing via GET /api/amtp/handles — never expose more than the handle.
   */
  static async listFederationHandles(): Promise<string[]> {
    return listFederationHandles()
  }

  /** §11 discovery listing with unsigned hints from each handle's published card. */
  static async listFederationHandleRecords(): Promise<Array<{ handle: string; name?: string; description?: string }>> {
    return listFederationHandleRecords()
  }

  /**
   * Count agents by filters.
   */
  static async count(filters?: ListAgentsFilters): Promise<number> {
    return countAgents(filters)
  }

  /**
   * List agents by filters.
   */
  static async list(
    filters?: ListAgentsFilters,
    order: 'latestMessage' | 'recentlyCreated' | 'earliestCreated' | 'recentlyTerminated' = 'earliestCreated'
  ): Promise<Agent[]> {
    const results = await listAgentRows(filters, order)

    const agentList = results.map((result) => new Agent(result))
    // Batch the relation hydration. The old per-agent eagerLoadRelations was a
    // DOUBLE N+1: a 24-agent roster ran up to 24 AgentType.find + 24 Squad.find
    // DB round-trips per call, re-fetching the SAME squad row 24 times —
    // measured on a live tenant (2026-09-01) as the dominant DB and CPU load
    // under concurrent agents (Squad.find at 45-175/s). Distinct types and
    // squads are now loaded with one query each; a failed batch leaves the
    // relation unset so the lazy per-agent getters self-heal exactly as the old
    // allSettled path did.
    try {
      const { AgentType } = await import('./AgentType')
      const { Squad } = await import('./Squad')
      const typeIds = [...new Set(agentList.map((agent) => agent.agentTypeId))]
      const squadIds = [...new Set(agentList.map((agent) => agent.squadId).filter((id): id is string => !!id))]
      const [typesById, squadsById] = await Promise.all([AgentType.findMany(typeIds), Squad.findManyByIds(squadIds)])
      for (const agent of agentList) {
        agent._agentType = typesById.get(agent.agentTypeId) ?? null
        agent._squad = agent.squadId ? (squadsById.get(agent.squadId) ?? null) : null
      }
    } catch {
      // Hydration is an optimization; the lazy getters remain correct.
    }

    return agentList
  }

  /**
   * Update an agent by ID.
   * @param id - The ID of the agent to update.
   * @param updates - The updates to apply to the agent.
   * @returns The updated agent.
   * @throws An error if the agent is not found.
   */
  static async update(id: string, updates: UpdateAgentInput): Promise<Agent> {
    if (updates.metadata) {
      updates = { ...updates, metadata: lifecycle.sanitizeLifecycleMetadataPatch(updates.metadata) }
    }
    const requestedStatus = updates.status ?? (updates.terminatedAt ? 'terminated' : undefined)
    const requestedTerminatedAt = updates.terminatedAt
    const { dormantAt: _callerDormantAt, terminatedAt: _callerTerminatedAt, ...authoritativeUpdates } = updates
    updates = authoritativeUpdates

    const existingAgent = await Agent.mustFind(id)
    if (
      existingAgent.status === 'terminated' &&
      ((requestedStatus !== undefined && requestedStatus !== 'terminated') || requestedTerminatedAt === null)
    ) {
      throw new Error('Final agent termination is irreversible')
    }

    if (requestedStatus === 'dormant' && isLiveAgentStatus(existingAgent.status)) {
      await lifecycle.requestAgentLifecycle(existingAgent, {
        target: 'dormant',
        metadata: updates.metadata,
        reason: 'Agent.update lifecycle transition',
        stopActive: true,
      })
      const transitioned = await Agent.mustFind(id)
      if (transitioned.status !== 'dormant') return transitioned
      return Agent.update(id, { ...updates, status: 'dormant' })
    }
    if (requestedStatus === 'terminated' && existingAgent.status !== 'terminated') {
      await lifecycle.requestAgentLifecycle(existingAgent, {
        target: 'terminated',
        metadata: updates.metadata,
        reason: 'Agent.update lifecycle transition',
        stopActive: true,
      })
      const transitioned = await Agent.mustFind(id)
      if (transitioned.status !== 'terminated') return transitioned
      return Agent.update(id, { ...updates, status: 'terminated' })
    }
    if (existingAgent.status === 'dormant' && requestedStatus && isLiveAgentStatus(requestedStatus)) {
      throw new Error('Dormant agents require an explicit wake source')
    }

    await Agent.validateModelOverrides({ ...existingAgent, ...updates })

    const { name, purpose, metadata, ...rest } = updates

    const metadataPatch: Record<string, unknown> = { ...(metadata ?? {}) }
    if (name !== undefined) metadataPatch.name = name
    const trimmedPurpose = typeof purpose === 'string' ? purpose.trim() : undefined
    if (trimmedPurpose) metadataPatch.purpose = trimmedPurpose

    const hasMetadataPatch = metadata !== undefined || name !== undefined || purpose !== undefined
    const metadataUpdate = hasMetadataPatch
      ? purpose === null || trimmedPurpose === ''
        ? {
            metadata: sql`(COALESCE(${agents.metadata}, '{}'::jsonb) || ${JSON.stringify(metadataPatch)}::jsonb) - 'purpose'`,
          }
        : { metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) || ${JSON.stringify(metadataPatch)}::jsonb` }
      : {}

    // If persist is being updated, verify that the agent is not a manager
    if (updates.persist !== undefined && existingAgent.agentTypeId === 'manager') {
      throw new Error('Cannot update persist flag for manager agents')
    }

    const updateSet = { ...rest, ...metadataUpdate, updatedAt: new Date() }
    await agentUpdatePrewriteHook?.(existingAgent.id)
    const statusFence =
      updates.status !== undefined
        ? eq(agents.status, existingAgent.status)
        : inArray(agents.status, [...LIVE_AGENT_STATUSES])
    const [updated] = await db
      .update(agents)
      .set(updateSet)
      .where(and(eq(agents.id, existingAgent.id), statusFence))
      .returning({ id: agents.id })
    if (!updated) throw new Error(`Agent ${existingAgent.id} lifecycle changed during update`)

    return finishAgentWrite(existingAgent.id, existingAgent, updates)
  }

  /**
   * Validate agentIds and resolve full UUIDs.
   */
  static async validateAgentIds(agentIds: string[]): Promise<string[]> {
    return validateAgentIds(agentIds)
  }

  /**
   * Update this agent.
   * @param updates - The updates to apply to the agent.
   * @returns The updated agent.
   * @throws An error if the agent is not found or the updates fail.
   */
  override async update(updates: UpdateAgentInput): Promise<this> {
    const updatedAgent = await Agent.update(this.id, updates)
    Object.assign(this, updatedAgent)
    return this
  }

  /**
   * Reload the agent from the database.
   * @returns The reloaded agent.
   */
  override async reload(): Promise<this> {
    const agent = await Agent.mustFind(this.id)
    Object.assign(this, agent)
    return this
  }

  async getEffectiveModelSpec(agentTypeModel?: string): Promise<string> {
    if (agentTypeModel?.trim()) return composeAgentModelSpec(agentTypeModel, this.modelOverride)
    return resolveAgentTypeChain(await this.mustGetAgentType(), this.modelOverride)
  }

  getSelectedOrConfiguredModelSpec(agentTypeModel?: string): string | undefined {
    if (this.selectedModel) return this.selectedModel
    const configured = this.modelOverride?.trim() || agentTypeModel?.trim() || this._agentType?.model?.trim()
    if (!configured) return undefined
    return splitModelPriorityList(configured)[0]
  }

  supportsSelectedModelImages(agentTypeModel?: string): boolean | undefined {
    const modelSpec = this.getSelectedOrConfiguredModelSpec(agentTypeModel)
    return modelSpec ? supportsImageInput(modelSpec) : undefined
  }

  /**
   * Get the agent runner type for the agent.
   * @returns The agent runner type.
   * @throws An error if the agent type is unexpected.
   */
  get runnerType(): AgentRunnerType {
    if (this.parentAgentId != null) {
      return SUBAGENT_RUNNER_TYPE
    }
    if (isUserAssistantAgentType(this.agentTypeId)) {
      return 'system-manager'
    }
    if (this.agentTypeId === ARTIFACT_BUILDER_AGENT_TYPE_ID) {
      return ARTIFACT_BUILDER_RUNNER_TYPE
    }
    if (this.squadId) {
      return this.agentTypeId === 'manager' || this.agentTypeId === 'consultant' ? 'squad-manager' : 'squad-worker'
    }
    throw new Error(`Unexpected agent type: ${this.agentTypeId}`)
  }

  /**
   * Load the agent type, returning null if not found.
   * @returns The agent type or null if not found.
   */
  async getAgentType(): Promise<AgentType | null> {
    if (!this._agentType) {
      this._agentType = await AgentType.find(this.agentTypeId)
    }
    return this._agentType
  }

  /**
   * Load the agent type, throwing an error if not found.
   * @returns The agent type.
   * @throws An error if the agent type is not found.
   */
  async mustGetAgentType(): Promise<AgentType> {
    const agentType = await this.getAgentType()
    if (!agentType) {
      throw new Error(`Agent type ${this.agentTypeId} not found`)
    }
    return agentType
  }

  /**
   * Load the squad for the agent.
   * @returns The squad or null if not found.
   */
  async getSquad(): Promise<Squad | null> {
    if (!this.squadId) {
      throw new Error(`Agent ${this.id} has no squad`)
    }
    if (!this._squad) {
      // Dynamic import to avoid circular dependency
      const { Squad } = await import('./Squad')
      this._squad = await Squad.find(this.squadId)
    }
    return this._squad
  }

  /**
   * Load the squad, throwing an error if not found.
   * @returns The squad.
   * @throws An error if the squad is not found.
   */
  async mustGetSquad(): Promise<Squad> {
    const squad = await this.getSquad()
    if (!squad) {
      throw new Error(`Squad ${this.squadId} not found`)
    }
    return squad
  }

  /**
   * Get the agent-specific workspace sandbox ID.
   * Used by runner types whose files must not be shared with squad workspaces.
   */
  getAgentWorkspaceSandboxId(): string {
    return agentWorkspaceSandboxId(this.id)
  }

  /**
   * Resolve the live root whose private sandbox this agent inherits.
   * Missing, terminated, cyclic, or cross-squad ancestry fails closed before
   * callers can touch an inherited filesystem.
   */
  async resolveLiveSandboxOwner(): Promise<Agent> {
    const expectedSquadId = this.squadId
    const seen = new Set<string>()
    // Descendant inheritance must use an authoritative subject row so a stale
    // pre-termination runner cannot touch its former parent's sandbox.
    const authoritativeSubject = this.parentAgentId ? await Agent.find(this.id) : this
    if (!authoritativeSubject) throw new Error(`Invalid sandbox ancestry for agent ${this.id}`)
    let current: Agent = authoritativeSubject

    while (true) {
      if (seen.has(current.id) || !isLiveAgentStatus(current.status)) {
        throw new Error(`Invalid sandbox ancestry for agent ${this.id}`)
      }
      seen.add(current.id)
      if (current.squadId !== expectedSquadId) {
        throw new Error(`Invalid sandbox ancestry for agent ${this.id}`)
      }
      if (!current.parentAgentId) return current
      const parent = await Agent.find(current.parentAgentId)
      if (!parent) throw new Error(`Invalid sandbox ancestry for agent ${this.id}`)
      current = parent
    }
  }

  /**
   * Get the agent's runtime sandbox ID. Subagents inherit the fully validated
   * live root owner's sandbox.
   */
  async getSandboxId(): Promise<string> {
    const owner = await this.resolveLiveSandboxOwner()
    // Consultant conversations share one light runtime per squad.
    if (owner.agentTypeId === 'consultant' && owner.squadId) return consultantSandboxId(owner.squadId)
    // A user's system-managers share one light sandbox + /private, scoped per
    // owning user (fall back to the per-agent box if owner is somehow unset).
    if (isUserAssistantAgentType(owner.agentTypeId) && owner.ownerUserId) {
      return systemManagerSandboxId(owner.ownerUserId)
    }
    return owner.getAgentWorkspaceSandboxId()
  }

  /**
   * Resolve only a sandbox personally owned by this subject for terminal
   * cleanup. This deliberately does not traverse parent ancestry: descendants
   * share a parent's box and must never reclaim it. A terminated top-level
   * subject remains the owner of its own box.
   */
  getPersonalSandboxIdForCleanup(): string | null {
    if (this.parentAgentId) return null
    if (isUserAssistantAgentType(this.agentTypeId) && this.ownerUserId) return null
    // Consultants may still have an old personal sandbox to collect; this
    // never returns their squad's shared consultant runtime.
    return this.getAgentWorkspaceSandboxId()
  }

  /** Whether this runner can access its squad's shared sandbox during a turn. */
  hasSquadSandboxAccessForExecution(): boolean {
    if (!this.squadId) return false
    return ['squad-manager', 'squad-worker', 'subagent'].includes(this.runnerType)
  }

  /** Every sandbox whose migration fence must serialize with execution pickup. */
  async getExecutionSandboxIds(): Promise<string[]> {
    if (this.agentTypeId === 'assistant') return []
    const sandboxIds = [await this.getSandboxId()]
    if (this.hasSquadSandboxAccessForExecution()) sandboxIds.push(`squad_${this.squadId}`)
    return [...new Set(sandboxIds)].sort()
  }

  /**
   * Eager-load the relations, if they exist.
   */
  protected async eagerLoadRelations(): Promise<void> {
    await Promise.allSettled([this.getAgentType(), this.getSquad()])
  }

  /**
   * Load the active execution for the agent, if any.
   * The returned execution has the agent relation pre-set.
   * @returns The active execution or null if not found.
   */
  async getActiveExecutionState(): Promise<{
    execution: Execution | null
    activeRowCount: number
    invariantViolation: boolean
  }> {
    const [admission] = await db
      .select({ executionId: executionAdmissionReservations.executionId })
      .from(executionAdmissionReservations)
      .where(
        and(
          eq(executionAdmissionReservations.agentId, this.id),
          sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
        )
      )
      .limit(1)
    const rows = await db
      .select()
      .from(executions)
      .where(and(eq(executions.agentId, this.id), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
      .orderBy(asc(executions.startedAt), asc(executions.id))
    const owner = rows.find(({ id }) => id === admission?.executionId)
    const row = owner ?? rows[0]
    return {
      execution: row ? new Execution(row).setAgent(this) : null,
      activeRowCount: rows.length,
      invariantViolation:
        rows.length > 1 ||
        (rows.length === 1 && admission?.executionId !== rows[0]?.id) ||
        (rows.length === 0 && !!admission),
    }
  }

  async getActiveExecution(): Promise<Execution | null> {
    return (await this.getActiveExecutionState()).execution
  }

  /**
   * Load the most recent execution for the agent regardless of status.
   * @returns The latest execution or null if none exists.
   */
  async getLatestExecution(): Promise<Execution | null> {
    const [row] = await db
      .select()
      .from(executions)
      .where(eq(executions.agentId, this.id))
      .orderBy(desc(executions.startedAt))
      .limit(1)

    if (!row) return null
    return new Execution(row).setAgent(this)
  }

  /**
   * List messages for the agent with filters and pagination.
   * @param options - The filters and pagination options.
   * @returns The messages with pagination metadata.
   */
  async listMessages(options?: ListMessagesOptions): Promise<ListMessagesResult> {
    const conditions: SQL[] = [eq(messages.agentId, this.id)]

    if (options?.role) {
      conditions.push(eq(messages.role, options.role))
    }
    if (options?.before) {
      conditions.push(lt(messages.createdAt, new Date(options.before)))
    }
    if (options?.after) {
      conditions.push(gt(messages.createdAt, new Date(options.after)))
    }
    if (options?.search) {
      conditions.push(ilike(messages.content, `%${options.search}%`))
    }

    const cursorContext = {
      agentId: this.id,
      role: options?.role,
      search: options?.search,
      before: options?.before,
      after: options?.after,
    }
    let cursorKeyset: { createdAt: Date; enqueueOrder: bigint } | undefined
    if (options?.cursor) {
      cursorKeyset = decodeMessageCursor(options.cursor, cursorContext)
    } else if (options?.beforeId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.beforeId))
        throw new InvalidMessageCursorError('invalid-cursor')
      const [cursorMsg] = await db
        .select({ createdAt: messages.createdAt, enqueueOrder: messages.enqueueOrder })
        .from(messages)
        .where(and(eq(messages.id, options.beforeId), eq(messages.agentId, this.id)))
        .limit(1)
      if (!cursorMsg?.enqueueOrder) throw new InvalidMessageCursorError('invalid-cursor')
      cursorKeyset = { createdAt: cursorMsg.createdAt, enqueueOrder: cursorMsg.enqueueOrder }
    }
    if (cursorKeyset)
      conditions.push(
        or(
          lt(messages.createdAt, cursorKeyset.createdAt),
          and(eq(messages.createdAt, cursorKeyset.createdAt), lt(messages.enqueueOrder, cursorKeyset.enqueueOrder))
        )!
      )

    // Build query
    let query = db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt), desc(messages.enqueueOrder))
      .$dynamic()

    // Apply limit+1 to detect hasMore, or fetch all if no limit
    const limit = options?.limit
    if (limit !== undefined) {
      query = query.limit(limit + 1)
    }
    if (options?.offset) {
      query = query.offset(options.offset)
    }

    const results = await query

    const hasMore = limit !== undefined && results.length > limit
    const pageMessages = hasMore ? results.slice(0, limit) : results

    // Get total count only on first page (no beforeId/offset) to avoid expensive query on every page
    let totalCount = 0
    if (!options?.cursor && !options?.beforeId && !options?.offset) {
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(eq(messages.agentId, this.id))
      totalCount = countResult?.count ?? 0
    }

    // Map and reverse to chronological order
    const mappedMessages = pageMessages.map(mapMessage).reverse()

    return {
      messages: mappedMessages,
      pagination: {
        hasMore,
        totalCount,
        oldestId: mappedMessages[0]?.id,
        newestId: mappedMessages[mappedMessages.length - 1]?.id,
        nextCursor:
          hasMore && pageMessages.at(-1)?.enqueueOrder != null
            ? encodeMessageCursor(
                { createdAt: pageMessages.at(-1)!.createdAt, enqueueOrder: pageMessages.at(-1)!.enqueueOrder! },
                cursorContext
              )
            : undefined,
      },
    }
  }

  /**
   * Record a new message for the agent. This does NOT send it to the session or
   * create an execution—it's just for persisting the message in the DB.
   * @param input - The message to add.
   * @returns The added message.
   */
  async recordMessage(input: CreateMessageInput): Promise<Message> {
    const values = messageInsertValues(this.id, input)
    const references = input.role === 'human' ? extractAgentAttachmentReferences(input.content) : []
    const uniqueIds = [...new Set(references.map(({ id }) => id))]
    let messageRow
    if (uniqueIds.length) {
      const scope = await resolveAttachmentScope(this)
      messageRow = await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(agentFileAttachments)
          .where(inArray(agentFileAttachments.id, uniqueIds))
          .for('update')
        if (rows.length !== uniqueIds.length) throw new InvalidAttachmentError()
        const byId = new Map(rows.map((row) => [row.id, row]))
        for (const reference of references) {
          const row = byId.get(reference.id)
          assertReadyAttachmentReference(row, reference, scope)
        }
        const [inserted] = await tx.insert(messages).values(values).returning()
        await tx
          .insert(messageAgentFileAttachments)
          .values(uniqueIds.map((attachmentId) => ({ messageId: inserted.id, attachmentId })))
        const updated = await tx
          .update(agentFileAttachments)
          .set({ status: 'used', usedAt: new Date() })
          .where(and(inArray(agentFileAttachments.id, uniqueIds), eq(agentFileAttachments.status, 'pending')))
          .returning({ id: agentFileAttachments.id })
        const alreadyUsed = rows.filter(({ status }) => status === 'used').length
        if (updated.length + alreadyUsed !== uniqueIds.length) throw new InvalidAttachmentError()
        return inserted
      })
    } else {
      ;[messageRow] = await db.insert(messages).values(values).returning()
    }
    await this.update({})

    const message = mapMessage(messageRow)
    // Awaited, not fired-and-forgotten: callers do read-after-write here
    // (write a message, then read the agent), and an async refresh returns
    // the previous summary. The debounced event subscriber cannot serve
    // this — by the time it runs the caller has already read.
    await refreshAgentActivity(this.id)
    eventEmitter.emit('message.created', messageEventData(message))
    return message
  }

  /** Persist a message as part of a caller-owned transaction. The caller emits only after commit. */
  async recordMessageInTransaction(tx: DbTransaction, input: CreateMessageInput): Promise<Message> {
    const references = input.role === 'human' ? extractAgentAttachmentReferences(input.content) : []
    const attachmentIds = [...new Set(references.map(({ id }) => id))]
    let attachmentRows: (typeof agentFileAttachments.$inferSelect)[] = []
    if (attachmentIds.length) {
      const scope = await resolveAttachmentScope(this)
      attachmentRows = await tx
        .select()
        .from(agentFileAttachments)
        .where(inArray(agentFileAttachments.id, attachmentIds))
        .for('update')
      if (attachmentRows.length !== attachmentIds.length) throw new InvalidAttachmentError()
      const byId = new Map(attachmentRows.map((row) => [row.id, row]))
      for (const reference of references) {
        assertReadyAttachmentReference(byId.get(reference.id), reference, scope)
      }
    }
    const [messageRow] = await tx.insert(messages).values(messageInsertValues(this.id, input)).returning()
    if (attachmentIds.length) {
      await tx
        .insert(messageAgentFileAttachments)
        .values(attachmentIds.map((attachmentId) => ({ messageId: messageRow.id, attachmentId })))
      const updated = await tx
        .update(agentFileAttachments)
        .set({ status: 'used', usedAt: new Date() })
        .where(and(inArray(agentFileAttachments.id, attachmentIds), eq(agentFileAttachments.status, 'pending')))
        .returning({ id: agentFileAttachments.id })
      const alreadyUsed = attachmentRows.filter(({ status }) => status === 'used').length
      if (updated.length + alreadyUsed !== attachmentIds.length) throw new InvalidAttachmentError()
    }
    return mapMessage(messageRow)
  }

  private async validateFileAttachmentReferences(content: string): Promise<void> {
    const references = extractAgentAttachmentReferences(content)
    const uniqueIds = [...new Set(references.map(({ id }) => id))]
    if (!uniqueIds.length) return
    const scope = await resolveAttachmentScope(this)
    const rows = await db.select().from(agentFileAttachments).where(inArray(agentFileAttachments.id, uniqueIds))
    if (rows.length !== uniqueIds.length) throw new InvalidAttachmentError()
    const byId = new Map(rows.map((row) => [row.id, row]))
    for (const reference of references) {
      const row = byId.get(reference.id)
      assertReadyAttachmentReference(row, reference, scope)
    }
  }

  /** Find a human message previously persisted with this optimistic-send clientId. */
  async findHumanMessageByClientId(clientId: string): Promise<Message | null> {
    const [row] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.agentId, this.id),
          eq(messages.role, 'human'),
          sql`${messages.metadata}->>'clientId' = ${clientId}`
        )
      )
      .limit(1)
    return row ? mapMessage(row) : null
  }

  async findRecoveryMessage(identity: {
    sandboxId: string
    recoveryEpisodeId: string
    recoveryNotificationKind: 'recovered' | 'still_unavailable'
  }): Promise<Message | null> {
    const [row] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.agentId, this.id),
          eq(messages.role, 'human'),
          sql`${messages.metadata}->>'source' = 'sandbox-recovery'`,
          sql`${messages.metadata}->>'sandboxId' = ${identity.sandboxId}`,
          sql`${messages.metadata}->>'recoveryEpisodeId' = ${identity.recoveryEpisodeId}`,
          sql`${messages.metadata}->>'recoveryNotificationKind' = ${identity.recoveryNotificationKind}`
        )
      )
      .limit(1)
    return row ? mapMessage(row) : null
  }

  /** Persist and wake at most once for a stable sandbox recovery episode tuple. */
  async sendRecoveryMessageOnce(
    content: string,
    identity: {
      sandboxId: string
      recoveryEpisodeId: string
      recoveryNotificationKind: 'recovered' | 'still_unavailable'
    },
    options: { recordOnly?: boolean } = {}
  ): Promise<Message | null> {
    const metadata: MessageMetadata = {
      isSystem: true,
      source: 'sandbox-recovery',
      clientId: `sandbox-recovery:${this.id}:${identity.recoveryEpisodeId}:${identity.recoveryNotificationKind}`,
      ...identity,
    }
    if (options.recordOnly) {
      const [inserted] = await db
        .insert(messages)
        .values(messageInsertValues(this.id, { role: 'human', content, metadata }))
        .onConflictDoNothing()
        .returning()
      if (inserted) {
        const message = mapMessage(inserted)
        // Awaited before the emit: this path returns the message to a caller
        // that reads the agent straight back, so a debounced refresh would
        // hand it the previous summary.
        await refreshAgentActivity(this.id)
        eventEmitter.emit('message.created', messageEventData(message))
        await this.update({})
        return message
      }
      return this.findRecoveryMessage(identity)
    }

    let message: Message | null
    try {
      await this.sendMessage(content, { deliveryMode: 'steer', metadata })
      message = await this.findRecoveryMessage(identity)
    } catch (error) {
      message = await this.findRecoveryMessage(identity)
      if (!message) throw error
    }
    if (!message) return null

    // sendMessage has multi-step delivery paths. If persistence committed but a later wake step
    // failed, a tuple retry must repair the durable wake before the outbox is marked delivered.
    await this.ensureRecoveryWake(message)
    return message
  }

  private async ensureRecoveryWake(message: Message): Promise<void> {
    if (!message.pending || (await this.getActiveExecution())) return
    try {
      await this.queueExecution({})
    } catch (error) {
      // A concurrent lease owner may have won the queue advisory lock after our read.
      // Treat that race as success only after the durable active-execution guard confirms the wake.
      if (!(await this.getActiveExecution())) throw error
    }
  }

  /**
   * queueExecution, but a no-op if a human row with the same clientId already
   * exists (safe retry after an ambiguous network failure). Returns the existing
   * active execution when deduped, else the newly-queued one.
   */
  async queueExecutionIdempotent(input: CreateExecutionInput): Promise<Execution> {
    // queueExecutionInTransaction owns the durable receipt claim, payload
    // conflict check, and exact execution adoption under the DB lock.
    return this.queueExecution(input)
  }

  /** Legacy content-only confirmation is deliberately a no-op; use a trusted SDK claim. */
  async tryConfirmPendingMessage(
    content?: string,
    identity?: pendingDelivery.ResponseGroupIdentity
  ): Promise<Message | null> {
    return pendingDelivery.tryConfirmPendingMessage(this.id, content, identity)
  }

  async confirmSessionDelivery(
    deliveryId: string,
    owner: pendingDelivery.SessionDeliveryOwner,
    entryId: string,
    identity: pendingDelivery.ResponseGroupIdentity
  ): Promise<Message[]> {
    return pendingDelivery.confirmSessionDelivery(this.id, deliveryId, owner, entryId, identity)
  }

  async reconcileSessionDeliveries(
    entries: pendingDelivery.SessionDeliveryReceipts,
    generation?: string
  ): Promise<void> {
    return pendingDelivery.reconcileSessionDeliveries(this.id, entries, generation)
  }

  /**
   * Confirm a specific pending human message for this agent.
   * Explicit non-SDK consumption only; SDK events use confirmSessionDelivery.
   * Returns the confirmed message, or null if the message is not pending for this agent.
   * @param messageId - The pending message id to confirm.
   * @returns The confirmed message, or null if none was confirmed.
   */
  async confirmPendingMessage(
    messageId: string,
    identity?: pendingDelivery.ResponseGroupIdentity
  ): Promise<Message | null> {
    return pendingDelivery.confirmPendingMessage(this.id, messageId, db, identity)
  }

  /**
   * Confirm all pending human messages for the agent.
   * @deprecated Explicit legacy bulk consumption only; never call from SDK delivery.
   * @returns The number of messages confirmed.
   */
  async confirmAllPendingMessages(): Promise<number> {
    return pendingDelivery.confirmAllPendingMessages(this.id)
  }

  /**
   * List pending human messages for the agent.
   * Used as a defensive guard when a running turn settles without consuming a
   * steer/follow-up that was persisted in the DB.
   */
  async listPendingHumanMessages(): Promise<Message[]> {
    return pendingDelivery.listPendingHumanMessages(this.id)
  }

  /**
   * Atomically claim the pending human rows that should start a fresh SDK turn.
   *
   * Selection follows the SDK queue semantics: claim every immediate/steer row
   * first (including normal user rows without an explicit deliveryMode). If no
   * such rows are available, claim exactly the first follow-up row. The CTE uses
   * row locks plus the injectedAt CAS marker so two workers cannot deliver the
   * same pending row.
   */
  async claimInitialPendingMessagesForSessionDelivery(
    owner?: pendingDelivery.SessionDeliveryOwner
  ): Promise<Message[]> {
    return pendingDelivery.claimInitialPendingMessagesForSessionDelivery(this.id, owner)
  }

  /**
   * List pending human rows that have not yet been accepted by a live SDK
   * session. These rows are the durable queue for the runner-local
   * pending-message drain instead of treating the control signal as source of truth.
   */
  async listPendingInterventionsForSessionDelivery(): Promise<Message[]> {
    return pendingDelivery.listPendingInterventionsForSessionDelivery(this.id)
  }

  /**
   * Atomically claim a pending human message for delivery to a live SDK session.
   * Returns null if another consumer already claimed/confirmed it.
   */
  async claimPendingInterventionForSessionDelivery(
    messageId: string,
    owner?: pendingDelivery.SessionDeliveryOwner
  ): Promise<Message | null> {
    return pendingDelivery.claimPendingInterventionForSessionDelivery(this.id, messageId, owner)
  }

  /**
   * Reset a claimed pending message so a future queue drain can retry it.
   * Used when the SDK rejects delivery after the injectedAt CAS claim.
   */
  async resetPendingInterventionSessionDelivery(
    messageId: string,
    claim?: MessageMetadata['sessionDelivery']
  ): Promise<void> {
    return pendingDelivery.resetPendingInterventionSessionDelivery(this.id, messageId, claim)
  }

  /**
   * Mark pending human messages as having received a stranded-pending retry.
   * This provides explicit loop-guard provenance for runner-created retries and
   * clears injectedAt so the retry is visible to the DB-backed delivery queue.
   */
  async markPendingHumanMessagesStrandedRetry(messageIds: string[]): Promise<void> {
    return pendingDelivery.markPendingHumanMessagesStrandedRetry(this.id, messageIds)
  }

  /**
   * Delete all pending human messages for the agent.
   * Called when clearing the steer/follow-up queue.
   * @returns The number of messages deleted.
   */
  async deletePendingMessages(): Promise<number> {
    return pendingDelivery.deletePendingMessages(this.id)
  }

  // ---------------------------------------------------------------------------
  // Agent token lifecycle
  // ---------------------------------------------------------------------------

  private async persistAgentTokenUnderLifecycleLock(input: {
    tokenHash?: string
    cachedTokenHash?: string
    userId?: string
    expectedResourceGeneration?: string
  }): Promise<{ id: string | null; reusedCached: boolean } | null> {
    return db.transaction(async (tx) => {
      await acquireAgentQueueLock(tx, this.id)
      const { assertAgentWorkStreamNotPaused } = await import('../services/work-streams/pause')
      await assertAgentWorkStreamNotPaused(this.id, tx)
      const [current] = await tx
        .select({
          status: agents.status,
          squadId: agents.squadId,
          ownerUserId: agents.ownerUserId,
          metadata: agents.metadata,
        })
        .from(agents)
        .where(eq(agents.id, this.id))
        .for('update')
      const metadata = current?.metadata as Record<string, unknown> | null
      if (
        !current ||
        !isLiveAgentStatus(current.status) ||
        (input.expectedResourceGeneration !== undefined &&
          metadata?.resourceGeneration !== input.expectedResourceGeneration)
      ) {
        return null
      }
      const userId = input.userId ?? current.ownerUserId ?? null
      if (!current.squadId && !userId) {
        throw new Error(`Agent ${this.id} has no squad and no owner — cannot create agent token.`)
      }
      if (input.cachedTokenHash) {
        const [activeCached] = await tx
          .select({ id: agentTokens.id })
          .from(agentTokens)
          .where(
            and(
              eq(agentTokens.agentId, this.id),
              eq(agentTokens.tokenHash, input.cachedTokenHash),
              isNull(agentTokens.revokedAt)
            )
          )
          .limit(1)
        if (activeCached) return { id: activeCached.id, reusedCached: true }
      }
      if (!input.tokenHash) return { id: null, reusedCached: false }
      const [row] = await tx
        .insert(agentTokens)
        .values({ agentId: this.id, squadId: current.squadId, tokenHash: input.tokenHash, userId })
        .returning({ id: agentTokens.id })
      return { id: row.id, reusedCached: false }
    })
  }

  /**
   * Create a new agent token for this agent. Generates a `ficus_agent_<uuid>` token,
   * stores only its SHA-256 hash in the database, caches the plaintext, and returns
   * the plaintext token (only returned to the caller; never persisted).
   */
  async createAgentToken({ userId }: { userId?: string } = {}): Promise<{ id: string; token: string }> {
    const token = `${AGENT_TOKEN_PREFIX}${randomUUID()}`
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const accepted = await this.persistAgentTokenUnderLifecycleLock({ tokenHash, userId })
    if (!accepted?.id) throw new Error(`Agent ${this.id} cannot issue an agent token in its current lifecycle state.`)
    cacheAgentToken(this.id, token)
    return { id: accepted.id, token }
  }

  /**
   * Return a usable plaintext agent token for sandbox CLI auth (injected as
   * FICUS_TOKEN into each bash command). Reuses the cached plaintext when present
   * and mints + caches a fresh one on a cache miss (e.g. after a server restart,
   * where only the hash survives in the DB). Squad agents are scoped by their
   * squad; squad-less agents (system-managers) are scoped by their owning user so
   * the token inherits that user's permissions. Returns undefined for agents with
   * neither a squad nor an owner.
   */
  async getOrCreateToken(options: { expectedResourceGeneration?: string } = {}): Promise<string | undefined> {
    if (!this.squadId && !this.ownerUserId) return undefined
    const cached = getCachedAgentToken(this.id)
    const replacement = `${AGENT_TOKEN_PREFIX}${randomUUID()}`
    const accepted = await this.persistAgentTokenUnderLifecycleLock({
      tokenHash: createHash('sha256').update(replacement).digest('hex'),
      cachedTokenHash: cached ? createHash('sha256').update(cached).digest('hex') : undefined,
      expectedResourceGeneration: options.expectedResourceGeneration,
    })
    if (!accepted) return undefined
    if (cached && accepted.reusedCached) return cached
    cacheAgentToken(this.id, replacement)
    return replacement
  }

  /**
   * Revoke all active tokens for this agent and clear the token cache.
   * @returns The number of tokens revoked.
   */
  async revokeTokensForAgent(
    options: {
      createdBefore?: Date
      tokenIds?: string[]
      lifecycleFence?: {
        status: 'dormant' | 'terminated'
        claimKey: string
        claimId: string
        episodeKey?: string
        episodeId?: string
      }
    } = {}
  ): Promise<number> {
    const outcome = await db.transaction(async (tx) => {
      if (options.lifecycleFence) {
        const [current] = await tx
          .select({ status: agents.status, metadata: agents.metadata })
          .from(agents)
          .where(eq(agents.id, this.id))
          .for('update')
        const metadata = current?.metadata as Record<string, unknown> | null
        if (
          current?.status !== options.lifecycleFence.status ||
          metadata?.[options.lifecycleFence.claimKey] !== options.lifecycleFence.claimId ||
          (options.lifecycleFence.episodeKey &&
            metadata?.[options.lifecycleFence.episodeKey] !== options.lifecycleFence.episodeId)
        ) {
          return { applied: false, count: 0 }
        }
      }
      const predicates = [eq(agentTokens.agentId, this.id), isNull(agentTokens.revokedAt)]
      if (options.tokenIds) {
        if (options.tokenIds.length === 0) return { applied: true, count: 0 }
        predicates.push(inArray(agentTokens.id, options.tokenIds))
      } else if (options.createdBefore) {
        predicates.push(lte(agentTokens.createdAt, options.createdBefore))
      }
      const result = await tx
        .update(agentTokens)
        .set({ revokedAt: new Date() })
        .where(and(...predicates))
        .returning()
      return { applied: true, count: result.length }
    })
    if (outcome.applied) removeCachedAgentToken(this.id)
    return outcome.count
  }

  /**
   * Revoke a specific agent token by its id.
   */
  static async revokeAgentToken(tokenId: string): Promise<void> {
    await db.update(agentTokens).set({ revokedAt: new Date() }).where(eq(agentTokens.id, tokenId))
  }

  /**
   * Check if the agent can be safely terminated.
   * @returns True if the agent can be safely deleted, false otherwise.
   */
  async canTerminate(): Promise<{ canTerminate: false; reason: string } | { canTerminate: true }> {
    return lifecycle.canTerminate(this)
  }

  /**
   * Try to terminate the agent, throwing an error if it cannot be terminated.
   * @throws An error if the agent cannot be terminated.
   */
  async tryTerminate(): Promise<void> {
    return lifecycle.tryTerminate(this)
  }

  /** Wake this agent if dormant. Final termination is irreversible. */
  async wake(): Promise<boolean> {
    return lifecycle.wake(this)
  }

  /**
   * Clear the agent's queue.
   * @returns True if the queue was cleared, false otherwise.
   */
  async clearQueue(options: { ackTimeoutMs?: number } = {}): Promise<lifecycle.ClearQueueResult> {
    return lifecycle.clearQueue(this, options)
  }

  /**
   * Check if the agent can be safely deleted.
   * @returns True if the agent can be safely deleted, false otherwise.
   */
  async canDelete(): Promise<{ canDelete: false; reason: string } | { canDelete: true }> {
    return lifecycle.canDelete(this)
  }

  /**
   * Delete the agent.
   * @throws An error if the agent is not found or the deletion fails.
   */
  async delete(): Promise<void> {
    return lifecycle.deleteAgent(this)
  }

  // ---------------------------------------------------------------------------
  // Status Transitions
  // ---------------------------------------------------------------------------

  /**
   * Start compaction for this agent. Sets status to 'compacting' and sends
   * a control signal to the worker.
   * @param instructions - Optional instructions for the compaction.
   * @throws If agent is not idle or has an active execution.
   */
  async startCompaction(instructions?: string): Promise<void> {
    return lifecycle.startCompaction(this, instructions)
  }

  /**
   * Finish compaction for this agent. Called by the worker after compaction completes.
   * Sets status back to 'idle'.
   */
  async finishCompaction(): Promise<void> {
    return lifecycle.finishCompaction(this)
  }

  /**
   * Start a session reset for this agent. Only allowed when idle with no active execution.
   * Sets status to 'resetting' and sends control signal to worker.
   */
  async startReset(): Promise<void> {
    return lifecycle.startReset(this)
  }

  /**
   * Finish reset for this agent. Called by the worker after reset completes.
   * Sets status back to 'idle'.
   */
  async finishReset(): Promise<void> {
    return lifecycle.finishReset(this)
  }

  /**
   * Clear waiting-input state. Sets questionData to null and status to idle.
   */
  async clearWaitingInput(): Promise<void> {
    return lifecycle.clearWaitingInput(this)
  }

  // ---------------------------------------------------------------------------
  // Execution Management
  // ---------------------------------------------------------------------------

  /**
   * Queue a new execution for the agent. This is the main entry point for
   * spinning up an agent turn. It will get processed into a session in the
   * worker and executed via the appropriate agent runner.
   */

  async queueExecution(input: CreateExecutionInput): Promise<Execution> {
    if (this.status === 'dormant') {
      await lifecycle.completeDormancyIfPending(this.id, { timeoutMs: 1_000 })
      await this.reload()
    }
    const lifecycleDormancyEpisodeAtAcceptance =
      this.status === 'dormant'
        ? (((this.metadata as Record<string, unknown> | null)?.dormancyEpisodeId as string | undefined) ?? null)
        : null
    const afterCommit: AfterCommitCallback[] = []
    const attachmentScope =
      input.imageIds?.length && !input.attachmentScope ? await resolveAttachmentScope(this) : input.attachmentScope
    const execution = await db.transaction((tx) =>
      this.queueExecutionInTransaction(
        tx,
        { ...input, attachmentScope, lifecycleDormancyEpisodeAtAcceptance },
        afterCommit
      )
    )
    for (const emit of afterCommit) await emit()
    if (this.status === 'dormant') {
      this.status = 'idle'
      this.dormantAt = null
    }
    return execution
  }

  /**
   * Queue while holding the per-agent transaction lock used by every execution
   * producer. The lock is `pg_advisory_xact_lock`, so it is held until the
   * CALLER's transaction commits or rolls back — this method cannot release it.
   *
   * LOCK ORDERING CONTRACT — callers must acquire locks in this order:
   *
   *   work_streams (FOR UPDATE) → work_stream_continuations → advisory(agent) →
   *   sorted advisory(image) → images (FOR UPDATE) → inserts into messages/executions
   *
   * i.e. take every OTHER lock you need BEFORE calling this, never pre-lock an
   * image before the agent lock, and take no row lock on `agents` or
   * `work_streams` afterwards. Image rows are the sole permitted resource lock
   * after the agent lock and are always acquired in sorted-ID order.
   *
   * Why: work-stream continuation dispatch (services/work-streams/continuation.ts)
   * locks the work_streams row first and then calls this. A caller that inverted
   * the order — advisory lock first, then a row lock on `agents`/`work_streams` —
   * would hold what dispatch wants while waiting for what dispatch holds. That is
   * not theoretical: the inverted pair was built against a real Postgres and
   * Postgres killed one side with `40P01` (deadlock detected). The victim's
   * transaction is aborted, so the user-visible symptom is a queue attempt that
   * fails with a deadlock error, intermittently and only under concurrency.
   */
  async queueExecutionInTransaction(
    tx: DbTransaction,
    {
      message,
      imageIds,
      metadata,
      attachmentActorUserId,
      attachmentScope,
      validateNewAcceptance,
      lifecycleDormancyEpisodeAtAcceptance,
    }: CreateExecutionInput,
    afterCommit: AfterCommitCallback[]
  ): Promise<Execution> {
    if (imageIds?.length && !attachmentScope) {
      throw new Error('queueExecutionInTransaction requires a pre-resolved attachmentScope when imageIds are present')
    }
    // Maintenance must be locked before any execution/agent queue lock so pause
    // acquisition and turn acceptance serialize to one durable outcome.
    const { state: maintenance, databaseNow } = await maintenanceStore.readLocked(tx)
    await lockFlowInboxDelivery(tx, this.id, metadata?.inboxMessageIds)

    // Two-arg form on purpose: it occupies a lock space disjoint from the
    // single-arg constants, so an agent id whose hashtext collides with one of
    // them cannot serialize this queue behind a migration or a CLI-bundle build.
    await acquireAgentQueueLock(tx, this.id)
    await assertCurrentIntegrationInbox(tx, this.id, metadata?.inboxMessageIds)
    const { assertAgentWorkStreamNotPaused } = await import('../services/work-streams/pause')
    await assertAgentWorkStreamNotPaused(this.id, tx)

    const [lifecycleRow] = await tx
      .select({
        status: agents.status,
        dormantAt: agents.dormantAt,
        pendingDormancyAt: agents.pendingDormancyAt,
        metadata: agents.metadata,
      })
      .from(agents)
      .where(eq(agents.id, this.id))
      .for('update')
    if (!lifecycleRow) throw new Error(`Agent ${this.id} not found`)
    if (lifecycleRow.status === 'terminated') throw new AgentTerminatedError(this.id)
    if (lifecycleRow.pendingDormancyAt) throw new AgentTargetUnavailableError(this.id)
    const wakeEligible = metadata?.wakeEligible !== false
    if (lifecycleRow.status === 'dormant') {
      // A producer that began before this dormancy transition must lose the
      // race; only correspondence accepted after dormantAt may wake it.
      const currentEpisode = (lifecycleRow.metadata as Record<string, unknown> | null)?.dormancyEpisodeId
      if (
        typeof lifecycleDormancyEpisodeAtAcceptance !== 'string' ||
        lifecycleDormancyEpisodeAtAcceptance !== currentEpisode
      )
        throw new AgentTargetUnavailableError(this.id)
      if (!wakeEligible) throw new AgentTargetUnavailableError(this.id)
      const wakeCompletionId = await lifecycle.wakeInTransaction(tx, this.id)
      if (!wakeCompletionId)
        throw new AgentTargetUnavailableError(
          this.id,
          `Agent ${this.id} is dormant while teardown completes; retry shortly`
        )
      if (wakeCompletionId) {
        afterCommit.push(async () => {
          await lifecycle.completeWakeAfterCommit(this.id, this, wakeCompletionId)
        })
      }
    }

    const clientId = metadata?.clientId
    const hashes = clientId
      ? chatSendRequestHashes({
          agentId: this.id,
          clientId,
          content: message ?? '',
          imageIds,
          deliveryMode: metadata?.deliveryMode ?? 'steer',
        })
      : null
    const requestHash = hashes?.current
    const legacyRequestHash = hashes?.legacy
    if (clientId && requestHash) {
      const [insertedReceipt] = await tx
        .insert(chatSendReceipts)
        .values({ agentId: this.id, clientId, requestHash })
        .onConflictDoNothing()
        .returning()
      const receipt =
        insertedReceipt ??
        (
          await tx
            .select()
            .from(chatSendReceipts)
            .where(and(eq(chatSendReceipts.agentId, this.id), eq(chatSendReceipts.clientId, clientId)))
            .for('update')
        )[0]
      if (!receipt) throw new Error('Idempotency receipt claim failed')
      if (receipt.requestHash !== requestHash && receipt.requestHash !== legacyRequestHash) {
        throw new ChatIdempotencyConflictError()
      }
      if (receipt.state === 'accepted') {
        if (!receipt.executionId) throw new Error('Idempotency receipt is missing its execution identity')
        const [existingExecution] = await tx
          .select()
          .from(executions)
          .where(and(eq(executions.id, receipt.executionId), eq(executions.agentId, this.id)))
          .limit(1)
        if (!existingExecution) throw new Error('Idempotency execution no longer exists')
        return new Execution(existingExecution).setAgent(this)
      }
      const [duplicate] = await tx
        .select({ content: messages.content, metadata: messages.metadata })
        .from(messages)
        .where(
          and(
            eq(messages.agentId, this.id),
            eq(messages.role, 'human'),
            sql`${messages.metadata}->>'clientId' = ${clientId}`
          )
        )
        .limit(1)
      if (duplicate) {
        const duplicateMetadata = duplicate.metadata as MessageMetadata | null
        const duplicateImages = duplicateMetadata?.imageIds ?? []
        if (
          duplicate.content !== (message ?? '') ||
          JSON.stringify(duplicateImages) !== JSON.stringify(imageIds ?? [])
        ) {
          throw new ChatIdempotencyConflictError()
        }
        const executionId = duplicateMetadata?.executionId
        if (!executionId) throw new Error('Idempotency record is missing its execution identity')
        const [existingExecution] = await tx
          .select()
          .from(executions)
          .where(and(eq(executions.id, executionId), eq(executions.agentId, this.id)))
          .limit(1)
        if (!existingExecution) throw new Error('Idempotency execution no longer exists')
        return new Execution(existingExecution).setAgent(this)
      }
    }

    validateNewAcceptance?.()
    await assertCurrentIntegrationInbox(tx, this.id, metadata?.inboxMessageIds)

    if (imageIds?.length) {
      await Image.claimForTargetInTransaction(tx, imageIds, this, attachmentActorUserId ?? '', attachmentScope!)
    }

    const [active] = await tx
      .select()
      .from(executions)
      .where(and(eq(executions.agentId, this.id), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
      .orderBy(desc(executions.startedAt))
      .limit(1)

    if (active) {
      throw new Error(`Agent already has an active execution (${active.id}, status: ${active.status})`)
    }

    // Generate the execution identity before its human row so trusted routes can
    // bind provenance atomically. Client metadata can never choose this value.
    const executionId = randomUUID()
    const safeExecutionMessage = message ?? null
    const status = maintenance.effective ? ('waiting-maintenance' as const) : ('queued' as const)
    const { executionFlowContext } = await import('../services/workflows/usage')
    const flowContext = await executionFlowContext(this.id, tx)
    const [executionRow] = await tx
      .insert(executions)
      .values({
        id: executionId,
        agentId: this.id,
        message: safeExecutionMessage,
        flowContext,
        imageIds: imageIds ?? null,
        wakeEligible,
        status,
        maintenanceGeneration: maintenance.effective ? maintenance.generation : null,
        maintenanceQueuedAt: maintenance.effective ? databaseNow : null,
      })
      .returning()
    const execution = new Execution(executionRow).setAgent(this)
    await createQueuedAdmission(tx, { agentId: this.id, executionId: execution.id, state: status })

    let persistedMessage: Message | undefined
    if (message || imageIds?.length) {
      const persisted = await this.recordMessageInTransaction(tx, {
        role: 'human',
        content: safeExecutionMessage ?? '',
        metadata:
          metadata || imageIds?.length
            ? { ...metadata, executionId, ...(imageIds?.length ? { imageIds } : {}) }
            : { executionId },
        pending: true,
      })
      persistedMessage = persisted
    }
    await assertCurrentIntegrationInbox(tx, this.id, metadata?.inboxMessageIds)
    if (clientId && requestHash && persistedMessage) {
      await tx
        .update(chatSendReceipts)
        .set({
          state: 'accepted',
          messageId: persistedMessage.id,
          executionId: execution.id,
          disposition: 'turn',
          acceptedAt: databaseClockNow(),
        })
        .where(and(eq(chatSendReceipts.agentId, this.id), eq(chatSendReceipts.clientId, clientId)))
    }

    afterCommit.push(() => {
      // The squad agent list renders lastMessageAt/lastMessagePreview, so it
      // does need to refresh when a message is queued. This used to emit
      // `agent.updated` to achieve that, which made every message refetch the
      // agent's entire query family (detail, context, active execution, sandbox
      // status, artifacts, Action Center) — none of which a message changes.
      // `agent.new-message` says exactly what happened, so clients refresh only
      // the roster. Emitted here rather than inside the transaction so it, like
      // every other event on this path, cannot be observed before the rows
      // commit; the agents row itself is deliberately not touched, because a row
      // lock on `agents` after the advisory lock would violate the ordering
      // contract above.
      if (persistedMessage) {
        eventEmitter.emit('agent.new-message', { agentId: this.id, squadId: this.squadId })
        eventEmitter.emit('message.created', messageEventData(persistedMessage))
        // Fire-and-forget here, unlike the recordMessage paths: this runs in a
        // post-commit hook with no caller reading the agent back, and awaiting
        // would make AfterCommitCallback async — which changes the emit's
        // timing relative to commit, the exact thing this hook exists to pin.
        void refreshAgentActivity(this.id)
      }
      const payload = { executionId: execution.id, agentId: execution.agentId, status: execution.status }
      eventEmitter.emit('execution.created', payload)
      if (execution.status === 'queued') eventEmitter.emit('execution.queued', payload)
    })
    return execution
  }

  /**
   * Send a message to this agent. Handles different agent states:
   * - idle: starts a new execution
   * - waiting-input: answers questions, creates new execution
   * - running: persists a pending intervention for the runner's DB-backed drain
   */
  async sendMessage(
    content: string,
    options: {
      imageIds?: string[]
      deliveryMode?: 'steer' | 'follow-up'
      metadata?: MessageMetadata
      /** Authenticated actor allowed to claim staged image IDs for this send. */
      attachmentActorUserId?: string
      /** Runs only after an accepted idempotent replay has been ruled out. */
      validateNewAcceptance?: () => void
    } = {}
  ): Promise<{ success: boolean; status: ExecutionStatus; queued?: boolean }> {
    if (this.status === 'dormant') {
      await lifecycle.completeDormancyIfPending(this.id, { timeoutMs: 1_000 })
      await this.reload()
    }
    const lifecycleDormancyEpisodeAtAcceptance =
      this.status === 'dormant'
        ? (((this.metadata as Record<string, unknown> | null)?.dormancyEpisodeId as string | undefined) ?? null)
        : null
    await this.validateFileAttachmentReferences(content)
    return this.sendMessageWithValidatedAttachments(content, { ...options, lifecycleDormancyEpisodeAtAcceptance })
  }

  private async sendMessageWithValidatedAttachments(
    content: string,
    options: {
      imageIds?: string[]
      deliveryMode?: 'steer' | 'follow-up'
      metadata?: MessageMetadata
      attachmentActorUserId?: string
      validateNewAcceptance?: () => void
      lifecycleDormancyEpisodeAtAcceptance?: string | null
    } = {}
  ): Promise<{ success: boolean; status: ExecutionStatus; queued?: boolean }> {
    const {
      imageIds,
      deliveryMode = 'steer',
      metadata,
      attachmentActorUserId,
      validateNewAcceptance,
      lifecycleDormancyEpisodeAtAcceptance,
    } = options
    const interventionPayloadMatches = (message: { content: string; metadata: unknown }) => {
      const existing = message.metadata as MessageMetadata | null
      return (
        message.content === content &&
        JSON.stringify(existing?.imageIds ?? []) === JSON.stringify(imageIds ?? []) &&
        (existing?.deliveryMode ?? 'steer') === deliveryMode
      )
    }
    const clientId = metadata?.clientId
    const hashes = clientId
      ? chatSendRequestHashes({ agentId: this.id, clientId, content, imageIds, deliveryMode })
      : null
    const requestHash = hashes?.current
    const legacyRequestHash = hashes?.legacy
    const afterCommit: AfterCommitCallback[] = []
    // Pool reads (agent ancestry) — must happen before the transaction opens.
    const attachmentScope = imageIds?.length ? await resolveAttachmentScope(this) : undefined

    const result = await db.transaction(async (tx) => {
      await maintenanceStore.readLocked(tx)
      await lockFlowInboxDelivery(tx, this.id, metadata?.inboxMessageIds)
      await acquireAgentQueueLock(tx, this.id)
      const { assertAgentWorkStreamNotPaused } = await import('../services/work-streams/pause')
      await assertAgentWorkStreamNotPaused(this.id, tx)
      await sendMessageLockedHook?.(tx, this.id)
      await assertCurrentIntegrationInbox(tx, this.id, metadata?.inboxMessageIds)
      const [authoritativeAgent] = await tx
        .select({
          status: agents.status,
          questionData: agents.questionData,
          pendingDormancyAt: agents.pendingDormancyAt,
        })
        .from(agents)
        .where(eq(agents.id, this.id))
        .for('update')
      if (!authoritativeAgent) throw new Error(`Agent ${this.id} not found`)
      if (authoritativeAgent.status === 'terminated') throw new AgentTerminatedError(this.id)
      if (authoritativeAgent.pendingDormancyAt) throw new AgentTargetUnavailableError(this.id)
      if (authoritativeAgent.status === 'dormant' && metadata?.wakeEligible === false) {
        throw new AgentTargetUnavailableError(this.id)
      }
      if (metadata?.inboxMessageIds?.length) {
        const { assertObserverInboxAcceptance } = await import('../services/work-streams/observers')
        await assertObserverInboxAcceptance(tx, this.id, metadata.inboxMessageIds)
      }
      let admission: Awaited<ReturnType<typeof loadCurrentAdmission>> = await loadCurrentAdmission(tx, this.id)
      const activeRows = await tx
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, this.id), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
        .orderBy(asc(executions.startedAt), asc(executions.id))
      if (activeRows.length > 1) throw new Error('Agent execution admission invariant is violated')
      const active = activeRows[0] ?? null
      if (!active && admission) {
        await tx
          .update(executionAdmissionReservations)
          .set({ state: 'revoked', updatedAt: new Date() })
          .where(eq(executionAdmissionReservations.executionId, admission.executionId))
      } else if (active && admission?.executionId !== active.id) {
        if (admission) {
          await tx
            .update(executionAdmissionReservations)
            .set({ state: 'revoked', updatedAt: new Date() })
            .where(eq(executionAdmissionReservations.executionId, admission.executionId))
        }
        const [legacyReservation] = await tx
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, active.id))
          .for('update')
        if (legacyReservation) {
          await tx
            .update(executionAdmissionReservations)
            .set({
              agentId: this.id,
              ...(legacyReservation.state === 'released' || legacyReservation.state === 'revoked'
                ? { state: active.status === 'waiting-maintenance' ? 'waiting-maintenance' : 'queued' }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(executionAdmissionReservations.executionId, active.id))
        } else {
          await createQueuedAdmission(tx, {
            agentId: this.id,
            executionId: active.id,
            state: active.status === 'waiting-maintenance' ? 'waiting-maintenance' : 'queued',
          })
        }
        admission = await loadCurrentAdmission(tx, this.id)
      }
      if (active && admission?.executionId !== active.id) {
        throw new Error('Agent execution admission could not be repaired')
      }

      if (clientId && requestHash) {
        const [insertedReceipt] = await tx
          .insert(chatSendReceipts)
          .values({ agentId: this.id, clientId, requestHash })
          .onConflictDoNothing()
          .returning()
        const receipt =
          insertedReceipt ??
          (
            await tx
              .select()
              .from(chatSendReceipts)
              .where(and(eq(chatSendReceipts.agentId, this.id), eq(chatSendReceipts.clientId, clientId)))
              .for('update')
          )[0]
        if (!receipt || (receipt.requestHash !== requestHash && receipt.requestHash !== legacyRequestHash)) {
          throw new ChatIdempotencyConflictError()
        }
        if (receipt.state === 'accepted') {
          if (!receipt.executionId || !receipt.messageId)
            throw new Error('Idempotency receipt is missing its bound identity')
          const [boundMessage] = await tx
            .select()
            .from(messages)
            .where(and(eq(messages.id, receipt.messageId), eq(messages.agentId, this.id)))
            .limit(1)
          const [boundExecution] = await tx
            .select()
            .from(executions)
            .where(and(eq(executions.id, receipt.executionId), eq(executions.agentId, this.id)))
            .limit(1)
          if (!boundMessage || !boundExecution) throw new Error('Idempotency receipt bound identity no longer exists')
          if (!interventionPayloadMatches(boundMessage)) throw new ChatIdempotencyConflictError()
          return {
            success: true as const,
            status: boundExecution.status,
            queued: receipt.disposition === 'intervention' && boundMessage.pending,
          }
        }
      }

      if (!active) {
        const execution = await this.queueExecutionInTransaction(
          tx,
          {
            message: content,
            imageIds,
            metadata: { ...metadata, deliveryMode },
            attachmentActorUserId,
            attachmentScope,
            validateNewAcceptance,
            lifecycleDormancyEpisodeAtAcceptance,
          },
          afterCommit
        )
        return { success: true as const, status: execution.status, queued: false }
      }

      if (authoritativeAgent.status === 'waiting-input') {
        const [superseded] = await tx
          .update(executions)
          .set({ status: 'completed', endedAt: databaseClockNow() })
          .where(
            and(
              eq(executions.id, active.id),
              eq(executions.agentId, this.id),
              inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])
            )
          )
          .returning({ id: executions.id })
        if (!superseded || !(await releaseExactAdmission(tx, this.id, active.id))) {
          throw new Error('Waiting-input execution admission changed before supersede')
        }
        await tx
          .update(agents)
          .set({ questionData: null, status: 'idle', updatedAt: new Date() })
          .where(eq(agents.id, this.id))
        const execution = await this.queueExecutionInTransaction(
          tx,
          {
            message: content,
            imageIds,
            metadata: { ...metadata, deliveryMode },
            attachmentActorUserId,
            attachmentScope,
            validateNewAcceptance,
            lifecycleDormancyEpisodeAtAcceptance,
          },
          afterCommit
        )
        afterCommit.push(() => {
          this.status = 'idle'
          this.questionData = null
          eventEmitter.emit('execution.completed', { executionId: active.id, agentId: this.id, status: 'completed' })
        })
        return { success: true as const, status: execution.status, queued: false }
      }

      validateNewAcceptance?.()

      if (imageIds?.length) {
        await Image.claimForTargetInTransaction(tx, imageIds, this, attachmentActorUserId ?? '', attachmentScope!)
      }

      const persisted = await this.recordMessageInTransaction(tx, {
        role: 'human',
        content,
        metadata: {
          ...metadata,
          executionId: active.id,
          ...(imageIds?.length ? { imageIds } : {}),
          deliveryMode,
        },
        pending: true,
      })
      await assertCurrentIntegrationInbox(tx, this.id, metadata?.inboxMessageIds)
      if (clientId) {
        await tx
          .update(chatSendReceipts)
          .set({
            state: 'accepted',
            messageId: persisted.id,
            executionId: active.id,
            disposition: 'intervention',
            acceptedAt: databaseClockNow(),
          })
          .where(and(eq(chatSendReceipts.agentId, this.id), eq(chatSendReceipts.clientId, clientId)))
      }
      if (imageIds?.length) {
        const mergedImageIds = this.mergeImageIds(active.imageIds, imageIds)
        await tx.update(executions).set({ imageIds: mergedImageIds }).where(eq(executions.id, active.id))
      }
      afterCommit.push(() => {
        // Same as the send path above: a persisted intervention message leaves
        // the agents row untouched, so this is a roster refresh, not an agent
        // change.
        eventEmitter.emit('agent.new-message', { agentId: this.id, squadId: this.squadId })
        eventEmitter.emit('message.created', messageEventData(persisted))
        // Fire-and-forget here, unlike the recordMessage paths: this runs in a
        // post-commit hook with no caller reading the agent back, and awaiting
        // would make AfterCommitCallback async — which changes the emit's
        // timing relative to commit, the exact thing this hook exists to pin.
        void refreshAgentActivity(this.id)
        if (active.status === 'queued') {
          eventEmitter.emit('execution.queued', { executionId: active.id, agentId: this.id, status: 'queued' })
        }
      })
      return { success: true as const, status: active.status, queued: true }
    })
    for (const emit of afterCommit) await emit()
    if (this.status === 'dormant' && metadata?.wakeEligible !== false) {
      this.status = 'idle'
      this.dormantAt = null
    }
    return result
  }

  /** Merge existing and new image ID arrays, deduplicating. */
  private mergeImageIds(
    existing: string[] | null | undefined,
    incoming: string[] | undefined
  ): string[] | null | undefined {
    if (!incoming?.length) return existing
    if (!existing?.length) return incoming
    return [...new Set([...existing, ...incoming])]
  }

  /**
   * Get the agent as a JSON object.
   * @returns The agent as a JSON object.
   */
  toJson(): AgentJson {
    return {
      id: this.id,
      agentTypeId: this.agentTypeId,
      squadId: this.squadId,
      parentAgentId: this.parentAgentId,
      status: this.status,
      persist: this.persist,
      modelOverride: this.modelOverride,
      configuredModel: this.modelOverride?.trim() || this._agentType?.model?.trim() || undefined,
      selectedModel: this.selectedModel ?? undefined,
      selectedModelSupportsImages: this.supportsSelectedModelImages(),
      metadata: this.metadata,
      context: this.context,
      questionData: this.questionData,
      sessionUsage: this.sessionUsage ? withoutDelta(this.sessionUsage) : this.sessionUsage,
      dormantAt: this.dormantAt,
      terminatedAt: this.terminatedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastMessageAt: this.lastMessageAt,
      lastHumanMessageAt: this.lastHumanMessageAt,
      lastMessagePreview: this.lastMessagePreview,
      amtpHandle: this.amtpHandle,
      identityPublicKey: this.identityPublicKey,
      inboundOpen: this.inboundOpen,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function composeAgentModelSpec(agentTypeModel: string, modelOverride?: string | null): string {
  const spec = modelOverride ?? agentTypeModel
  validateModelSpecList(spec)
  return spec
}

/**
 * Persist the selected/effective model spec for an agent into the
 * `selected_model` column (best-effort, non-blocking). Used by
 * AgentSession.create to record which candidate of a priority list was
 * actually selected, for display, and by runtime failover when switching.
 */
export async function setAgentSelectedModel(agentId: string, spec: string): Promise<void> {
  await db
    .update(agents)
    .set({
      selectedModel: spec,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId))
}

/** Column values for a message row, shared by the pooled and in-transaction inserts. */
function messageInsertValues(agentId: string, input: CreateMessageInput) {
  const safe = {
    content: input.content,
    metadata: input.metadata ?? null,
  }
  return {
    agentId,
    role: input.role,
    content: safe.content,
    metadata: safe.metadata,
    pending: input.pending ?? false,
  }
}

/** Post-write refetch + events for an agent row change. before = pre-write snapshot. */
export async function finishAgentWrite(
  agentId: string,
  before: { status: AgentStatus },
  updates: { status?: AgentStatus }
): Promise<Agent> {
  const agent = await Agent.mustFind(agentId)
  eventEmitter.emit('agent.updated', { agentId: agent.id, squadId: agent.squadId })

  if (before.status !== 'waiting-input' && updates.status === 'waiting-input') {
    eventEmitter.emit('agent.waiting-input', { agentId: agent.id, squadId: agent.squadId })
  }
  return agent
}

export { mapMessage }
