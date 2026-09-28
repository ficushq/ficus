import { consultantSandboxId } from '../services/sandbox/consultant-sandbox'
import { and, asc, desc, eq, ilike, inArray, InferSelectModel, isNull, or, sql, type SQL } from 'drizzle-orm'
import {
  db,
  squads,
  agents,
  squadRelationships,
  messages,
  schedules,
  agentTokens,
  channelInstances,
  memoryChunks,
} from '../db'
import { uuidPrefixCondition, AmbiguousPrefixError } from '../db/prefix-match'
import {
  Squad as SquadJson,
  SquadStatus,
  CreateSquadInput,
  UpdateSquadInput,
  SquadRelationship,
  SquadRelationshipType,
  SquadWithRelationships,
  Message,
} from '@ficus/shared'
import { eventEmitter } from '../lib/infra/event-emitter'
import { createLogger } from '../lib/infra/logger'
import { removeCachedAgentToken } from '../services/rbac/token-cache'
import { buildSignedImageUrlPath } from '../services/images/signing'
import { BaseEntity } from './base'
import * as squadWorkspace from '../services/squad/workspace'
import * as squadGraph from '../services/squad/graph'
import * as squadReconciler from '../services/squad/reconciler'
import * as squadSsh from '../services/squad/ssh'

// Forward declaration to avoid circular import at module load time
import type { Agent } from './Agent'
import { mapMessage } from './message-mapper'
import { deepMergeMetadata } from './metadata'
import { setHostWorkspaceOverride } from '../services/sandbox/host/workspace-overrides'

const preparedPresetSchedules = Symbol('preparedPresetSchedules')
type PreparedSquadInput = CreateSquadInput & {
  [preparedPresetSchedules]: import('../services/config-sync').ScheduleTemplateYaml[]
}

export type SquadRow = InferSelectModel<typeof squads>

/**
 * Normalize typeContext: drop empty-string and null values, and keys that
 * are not known agent type IDs (when the agent-types table is populated).
 * Returns null if the result is empty.
 */
function normalizeTypeContextWith(
  raw: Record<string, string | null> | null | undefined,
  knownTypeIds: readonly string[]
): Record<string, string> | null {
  if (!raw) return null
  // Strip empty / whitespace-only / null values
  const cleaned: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.trim().length > 0) cleaned[k] = v
  }
  if (Object.keys(cleaned).length === 0) return null

  // Validate keys against known agent types (best-effort: skip when table empty)
  if (knownTypeIds.length > 0) {
    const knownIds = new Set(knownTypeIds)
    const unknown = Object.keys(cleaned).filter((k) => !knownIds.has(k))
    if (unknown.length > 0) {
      throw new Error(`Unknown agent type ID(s) in typeContext: ${unknown.join(', ')}`)
    }
  }
  return cleaned
}

/** Load the known agent type IDs used to validate typeContext keys. */
async function loadKnownAgentTypeIds(): Promise<string[]> {
  const { AgentType } = await import('./AgentType')
  return (await AgentType.list()).map((t) => t.id)
}

async function normalizeTypeContext(
  raw: Record<string, string | null> | null | undefined
): Promise<Record<string, string> | null> {
  if (!raw) return null
  return normalizeTypeContextWith(raw, await loadKnownAgentTypeIds())
}

// Memory configuration types
export interface SquadMemoryConfig {
  enabled: boolean
  embeddingModel?: string
  workspacePaths?: {
    include: string[]
    exclude?: string[]
  }
  sync?: SquadMemorySyncConfig
}

export interface SquadMemorySyncConfig {
  providers?: Array<GitSyncProvider | S3SyncProvider>
  conflictPolicy?: 'manual' | 'last_write_wins'
  pushDebounceSeconds?: number
  pullIntervalMinutes?: number
}

export interface SquadSandboxConfig {
  /** If true, sandbox pod stays running indefinitely. If false, shuts down after idle timeout. Default: false. */
  alwaysOn?: boolean
  /** Idle timeout in minutes before sandbox is shut down. Only used when alwaysOn is false. Default: 60. */
  idleTimeoutMinutes?: number
  /**
   * Per-squad ephemeral-storage limit for the sandbox pod, in GiB. Raise this
   * for squads with heavy toolchains whose nix install exceeds the global
   * default. Falls back to the global default (FICUS_SANDBOX_EPHEMERAL_STORAGE_LIMIT)
   * when unset.
   */
  ephemeralStorageLimitGi?: number
  toolchain?: import('@ficus/shared').SandboxToolchainConfig | null
}

export interface GitSyncProvider {
  type: 'git'
  repoUrl: string
  branch: string
  pathPrefix?: string
  sshKeyName: string
  autoPull: boolean
  autoPush: boolean
  webhookSecret?: string
}

export interface S3SyncProvider {
  type: 's3'
  bucket: string
  region: string
  endpoint?: string
  pathPrefix?: string
  credentialsRef: string
  autoPull: boolean
  autoPush: boolean
}

export interface ListSquadsFilters {
  status?: SquadStatus
  includeAnonymous?: boolean
  includeArchived?: boolean
}

export interface FlexAgentInfo {
  id: string
  name: string | null
  agentTypeId: string
  squadName: string | null
}

export interface CleanupFlexAgentsResult {
  checked: number
  terminated: number
  agents: FlexAgentInfo[]
}

export interface SearchMessagesOptions {
  limit?: number
  role?: 'human' | 'assistant'
}

export interface SearchMessagesResult extends Message {
  agentTypeId?: string
  agentName?: string
}

const log = createLogger('squad-entity')

export class Squad extends BaseEntity<SquadJson, UpdateSquadInput> implements SquadRow {
  // Row fields
  declare id: string
  declare name: string
  declare purpose: string
  declare status: SquadStatus
  declare squadPresetId: string | null
  declare defaultAgents: string[]
  declare managerAgentId: string | null
  declare context: string | null
  declare typeContext: Record<string, string> | null
  declare isAnonymous: boolean
  declare globalCollaborationEnabled: boolean
  declare order: number
  declare metadata: Record<string, unknown>
  declare maxConcurrentWorkStreams: number | null
  declare blockedGraceMinutes: number | null
  declare sandboxStatus: 'none' | 'initializing' | 'ready' | 'failed'
  declare avatarImageId: string | null
  declare machineId: string | null
  declare hostWorkspacePath: string | null
  declare createdAt: Date
  declare updatedAt: Date
  declare archivedAt: Date | null

  // Relation cache
  private _managerAgent?: Agent | null

  constructor(data: SquadRow) {
    super()
    Object.assign(this, data)

    // Normalize defaultAgents
    if (!this.defaultAgents) {
      this.defaultAgents = []
    }
  }

  get isArchived(): boolean {
    return this.archivedAt != null
  }

  // ---------------------------------------------------------------------------
  // Static Methods
  // ---------------------------------------------------------------------------

  static get selectColumns() {
    return {
      id: squads.id,
      name: squads.name,
      purpose: squads.purpose,
      status: squads.status,
      squadPresetId: squads.squadPresetId,
      defaultAgents: squads.defaultAgents,
      managerAgentId: squads.managerAgentId,
      context: squads.context,
      typeContext: squads.typeContext,
      isAnonymous: squads.isAnonymous,
      globalCollaborationEnabled: squads.globalCollaborationEnabled,
      order: squads.order,
      metadata: squads.metadata,
      maxConcurrentWorkStreams: squads.maxConcurrentWorkStreams,
      blockedGraceMinutes: squads.blockedGraceMinutes,
      sandboxStatus: squads.sandboxStatus,
      avatarImageId: squads.avatarImageId,
      machineId: squads.machineId,
      hostWorkspacePath: squads.hostWorkspacePath,
      createdAt: squads.createdAt,
      updatedAt: squads.updatedAt,
      archivedAt: squads.archivedAt,
    }
  }

  /**
   * Create a new squad.
   */
  static async prepareCreateInput<T extends CreateSquadInput>(input: T): Promise<T & PreparedSquadInput> {
    if (preparedPresetSchedules in input) return input as T & PreparedSquadInput
    const { SquadPreset } = await import('./SquadPreset')
    const preset = input.squadPresetId ? await SquadPreset.find(input.squadPresetId) : null
    if (input.squadPresetId && (!preset || preset.disabled)) {
      const { WorkflowError } = await import('../services/workflows/catalog')
      throw new WorkflowError('Squad preset not found or disabled', 400)
    }
    return {
      ...input,
      defaultAgents: input.defaultAgents ?? structuredClone(preset?.defaultAgents ?? []),
      typeContext: {
        ...(preset?.managerInstructions ? { manager: preset.managerInstructions } : {}),
        ...input.typeContext,
      },
      metadata: {
        ...input.metadata,
        ...(preset?.workflows
          ? {
              workflow: input.metadata?.workflow ?? structuredClone(preset.workflows.default),
              workflowSetup: input.metadata?.workflowSetup ?? {
                guidance: preset.workflows.guidance,
                choices: structuredClone(preset.workflows.choices),
              },
            }
          : {}),
      },
      [preparedPresetSchedules]: structuredClone(preset?.scheduleTemplates ?? []),
    }
  }

  static async create(rawInput: CreateSquadInput): Promise<Squad> {
    const input = await this.prepareCreateInput(rawInput)
    const { validateSquadWorkflows } = await import('../services/workflows/access')
    await validateSquadWorkflows(input.metadata ?? {}, '')
    const typeContext = await normalizeTypeContext(input.typeContext)
    const [row] = await db
      .insert(squads)
      .values({
        name: input.name,
        purpose: input.purpose,
        squadPresetId: input.squadPresetId ?? null,
        defaultAgents: input.defaultAgents ?? [],
        context: input.context ?? null,
        typeContext,
        metadata: input.metadata ?? {},
        globalCollaborationEnabled: input.globalCollaborationEnabled ?? false,
        hostWorkspacePath: input.hostWorkspacePath ?? null,
      })
      .returning()

    if (input.hostWorkspacePath) setHostWorkspaceOverride(row.id, input.hostWorkspacePath)

    try {
      const { reconcileSquadIntegration } = await import('../services/integrations/scope-settings')
      await reconcileSquadIntegration(row.id, 'github')
      // Create manager agent
      const { Agent } = await import('./Agent')
      const agent = await Agent.create({
        agentTypeId: 'manager',
        squadId: row.id,
      })

      // Update squad with manager reference
      await db.update(squads).set({ managerAgentId: agent.id, updatedAt: new Date() }).where(eq(squads.id, row.id))

      // Reconcile squad agents (spawns any missing default agents and managers)
      const squad = await Squad.mustFind(row.id)
      await squad.reconcileAgents()

      // Provision the creation-time snapshot after the manager and persistent members exist.
      // The provenance ID is never used to reapply a preset later.
      const { provisionSquadSchedules } = await import('../services/squad/schedule-provisioning')
      await provisionSquadSchedules(row.id, input[preparedPresetSchedules])

      eventEmitter.emit('squad.created', { squadId: squad.id })

      // Pre-warm sandbox in background (fire-and-forget)
      // This initializes the nix store and container so agents don't have to wait
      const { prewarmSandboxBackground } = await import('../services/sandbox/prewarm')
      prewarmSandboxBackground(squad.id)

      return squad
    } catch (error) {
      if (input.hostWorkspacePath) setHostWorkspaceOverride(row.id, null)
      throw error
    }
  }

  /**
   * Find a squad by ID.
   * @param id - The ID of the squad to find (potentially a prefix).
   * @returns The squad or null if not found.
   * @throws AmbiguousPrefixError if the ID matches multiple squads.
   */
  static async find(id: string): Promise<Squad | null> {
    const rows = await db
      .select(Squad.selectColumns)
      .from(squads)
      .where(id.length < 36 ? uuidPrefixCondition(squads.id, id) : eq(squads.id, id))
      .limit(2)

    if (rows.length === 0) return null
    if (rows.length > 1) throw new AmbiguousPrefixError('squad', id)

    return new Squad(rows[0])
  }

  /**
   * Batch-load squads by exact ids with ONE query. Exists for N+1 elimination
   * in list paths (Agent.list hydration re-fetched the same squad row once per
   * agent — measured on a live tenant, 2026-09-01, as the top DB/CPU load under
   * concurrent agents). Deliberately NOT cached: raw `db.update(squads)`
   * writers (archive/status stamps) exist in production and throughout the
   * tests, and a stale archived/status read is a semantic hazard, not a perf
   * detail. Returns a map keyed by squad id — absent entries were not found.
   */
  static async findManyByIds(ids: string[]): Promise<Map<string, Squad>> {
    const out = new Map<string, Squad>()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return out
    const rows = await db.select(Squad.selectColumns).from(squads).where(inArray(squads.id, unique))
    for (const row of rows) out.set(row.id, new Squad(row))
    return out
  }

  /**
   * Find a squad by ID, throwing if not found.
   * @param id - The ID of the squad to find (potentially a prefix).
   * @returns The squad.
   * @throws Error if the squad is not found.
   */
  static async mustFind(id: string): Promise<Squad> {
    const squad = await this.find(id)
    if (!squad) throw new Error(`Squad ${id} not found`)
    return squad
  }

  /**
   * Find all squads.
   * @returns All squads.
   */
  static async findAll(): Promise<Squad[]> {
    const rows = await db.select(Squad.selectColumns).from(squads).where(isNull(squads.archivedAt))
    return rows.map((row) => new Squad(row))
  }

  /** Shared filter-building for `list()`/`exists()` — same default semantics for both. */
  private static buildListConditions(filters?: ListSquadsFilters) {
    const conditions = []

    if (filters?.status) {
      conditions.push(eq(squads.status, filters.status))
    }

    // By default, exclude anonymous squads from listings
    if (!filters?.includeAnonymous) {
      conditions.push(eq(squads.isAnonymous, false))
    }

    // By default, exclude archived (soft-deleted) squads
    if (!filters?.includeArchived) {
      conditions.push(isNull(squads.archivedAt))
    }

    return conditions
  }

  /**
   * List squads with optional filters.
   */
  static async list(filters?: ListSquadsFilters): Promise<Squad[]> {
    const conditions = Squad.buildListConditions(filters)

    const results = await db
      .select(Squad.selectColumns)
      .from(squads)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(squads.order), desc(squads.createdAt))

    return results.map((row) => new Squad(row))
  }

  /**
   * Cheap existence check — same default filters as `list()` (excludes
   * anonymous + archived unless overridden), but a bounded `LIMIT 1` probe
   * rather than a full row fetch. Use this instead of `(await list()).length
   * > 0` on any hot/cheap-lookup path (e.g. status/banner endpoints).
   */
  static async exists(filters?: ListSquadsFilters): Promise<boolean> {
    const conditions = Squad.buildListConditions(filters)

    const rows = await db
      .select({ id: squads.id })
      .from(squads)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .limit(1)

    return rows.length > 0
  }

  /**
   * Update a squad by ID.
   */
  static async update(id: string, input: UpdateSquadInput): Promise<Squad> {
    // Loaded OUTSIDE the transaction: an AgentType.list pool read inside a
    // row-lock-holding transaction is hold-and-wait on the shared pool.
    const knownTypeIds = input.typeContext ? await loadKnownAgentTypeIds() : []
    const row = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(squads).where(eq(squads.id, id)).for('update')
      if (!current) throw new Error(`Squad ${id} not found`)

      const finalInput = { ...input }
      if (input.typeContext !== undefined) {
        if (input.typeContext === null) {
          finalInput.typeContext = null
        } else {
          const merged: Record<string, string> = {
            ...((current.typeContext as Record<string, string> | null) ?? {}),
          }
          for (const [key, value] of Object.entries(input.typeContext)) {
            if (value === null) delete merged[key]
            else merged[key] = value
          }
          finalInput.typeContext = normalizeTypeContextWith(merged, knownTypeIds)
        }
      }

      if (input.metadata !== undefined) {
        finalInput.metadata = deepMergeMetadata(
          (current.metadata as Record<string, unknown> | null) ?? {},
          input.metadata
        )
        // Flow sources are typed unions, not mergeable metadata bags.
        for (const key of ['workflow', 'workflowSetup'])
          if (Object.hasOwn(input.metadata, key)) finalInput.metadata[key] = input.metadata[key]
        if (Object.hasOwn(input.metadata, 'workflow') || Object.hasOwn(input.metadata, 'workflowSetup')) {
          const { validateSquadWorkflows } = await import('../services/workflows/access')
          await validateSquadWorkflows(finalInput.metadata, id, tx)
        }
      }

      const [updated] = await tx
        .update(squads)
        .set({
          ...finalInput,
          typeContext: finalInput.typeContext as Record<string, string> | null | undefined,
          updatedAt: new Date(),
        })
        .where(eq(squads.id, id))
        .returning()
      return updated
    })

    const squad = new Squad(row)
    eventEmitter.emit('squad.updated', { squadId: squad.id })

    // Cap change trigger: raising (or clearing) maxConcurrentWorkStreams frees
    // slots — admit eligible queued streams now instead of waiting for the
    // reconciler. Lowering never evicts (promotion just finds zero free slots).
    // A grace change runs the full maintenance pass so a lowered grace parks
    // overdue waiting streams promptly.
    if (input.maxConcurrentWorkStreams !== undefined || input.blockedGraceMinutes !== undefined) {
      const { runSquadAdmissionMaintenanceWithRetry } = await import('../services/work-streams/admission')
      const result = await runSquadAdmissionMaintenanceWithRetry(squad.id)
      if (!result.succeeded) {
        // Still never fail the settings update — but a swallowed transient used
        // to mean a raised cap silently admitted nobody until the reconciler.
        log.error(
          `Post-cap-change admission failed after ${result.attempts} attempts for squad ${squad.id}:`,
          result.lastError
        )
      }
    }

    return squad
  }

  /**
   * Reorder squads by updating their order field.
   * @param ids - Array of squad IDs in the desired order.
   * @returns The updated squads.
   */
  static async reorder(ids: string[]): Promise<Squad[]> {
    const updated = await db.transaction(async (tx) => {
      const results: Squad[] = []
      for (let i = 0; i < ids.length; i++) {
        const [row] = await tx
          .update(squads)
          .set({ order: i, updatedAt: new Date() })
          .where(eq(squads.id, ids[i]))
          .returning()
        if (row) {
          results.push(new Squad(row))
        }
      }
      return results
    })

    // Emit events for each updated squad
    for (const squad of updated) {
      eventEmitter.emit('squad.updated', { squadId: squad.id })
    }

    return updated
  }

  /**
   * Clean up all unterminated flex agents by checking termination eligibility.
   * @param dryRun If true, returns agents that would be terminated without actually terminating them.
   */
  static async cleanupFlexAgents(dryRun = false): Promise<CleanupFlexAgentsResult> {
    return squadReconciler.cleanupFlexAgents(dryRun)
  }

  /**
   * Get the sandbox ID for a squad ID.
   */
  static getSandboxId(squadId: string): string {
    return `squad_${squadId}`
  }

  // ---------------------------------------------------------------------------
  // Instance Methods
  // ---------------------------------------------------------------------------

  /**
   * Get the sandbox ID for this squad.
   */
  get sandboxId(): string {
    return Squad.getSandboxId(this.id)
  }

  /**
   * Check if memory is enabled for this squad.
   */
  get isMemoryEnabled(): boolean {
    return this.memoryConfig?.enabled === true
  }

  /**
   * Get the memory configuration for this squad.
   * Returns undefined if no memory config is set.
   */
  get memoryConfig(): SquadMemoryConfig | undefined {
    const memory = this.metadata?.memory
    if (typeof memory !== 'object' || memory === null) return undefined
    return memory as SquadMemoryConfig
  }

  /**
   * Get the memory sync configuration for this squad.
   * Returns undefined if no sync config is set.
   */
  get memorySyncConfig(): SquadMemorySyncConfig | undefined {
    return this.memoryConfig?.sync
  }

  /**
   * Get the sandbox configuration for this squad.
   * Returns undefined if no sandbox config is set (defaults apply: alwaysOn=true).
   */
  get sandboxConfig(): SquadSandboxConfig | undefined {
    const sandbox = this.metadata?.sandbox
    if (typeof sandbox !== 'object' || sandbox === null) return undefined
    return sandbox as SquadSandboxConfig
  }

  /**
   * Whether this squad's sandbox should stay running indefinitely.
   * Defaults to false if not configured.
   */
  get toolchainConfig(): import('@ficus/shared').SandboxToolchainConfig | undefined {
    const toolchain = this.sandboxConfig?.toolchain
    if (!toolchain || typeof toolchain !== 'object') return undefined
    return toolchain as import('@ficus/shared').SandboxToolchainConfig
  }

  get isSandboxAlwaysOn(): boolean {
    return this.sandboxConfig?.alwaysOn === true
  }

  /**
   * Get the type-specific context string for an agent type, or null.
   */
  getTypeContext(agentTypeId: string): string | null {
    return this.typeContext?.[agentTypeId] ?? null
  }

  /**
   * Update this squad in-place.
   */
  override async update(input: UpdateSquadInput): Promise<this> {
    const updated = await Squad.update(this.id, input)
    Object.assign(this, updated)
    return this
  }

  /**
   * Reload this squad from the database.
   */
  override async reload(): Promise<this> {
    const fresh = await Squad.mustFind(this.id)
    Object.assign(this, fresh)
    return this
  }

  /**
   * Archive (soft-delete) this squad: hide it, make it inert, preserve all
   * rows/history. Hard-deletes only memory_chunks; optionally removes the
   * workspace + ssh dirs on disk. Idempotent.
   */
  async archive(options: { deleteWorkspace?: boolean } = {}): Promise<void> {
    if (this.archivedAt) {
      if (options.deleteWorkspace) {
        const { removeSquadWorkspace } = await import('../services/squad/workspace')
        const { removeSquadSsh } = await import('../services/squad/ssh')
        await removeSquadWorkspace(this.id)
        await removeSquadSsh(this.id)
      }
      return
    }

    const { getSandboxManager } = await import('../services/sandbox')
    const { removeSquadWorkspace } = await import('../services/squad/workspace')
    const { removeSquadSsh } = await import('../services/squad/ssh')

    const now = new Date()

    // Perform all DB mutations atomically so a failure leaves the squad fully
    // live (not half-inert). archivedAt is written LAST inside the transaction
    // so the early idempotency guard above never trips on a partial archive.
    const revokedAgentIds = await db.transaction(async (tx) => {
      // Revoke agent tokens (inert), keep rows — collect agentIds for cache eviction
      const revoked = await tx
        .update(agentTokens)
        .set({ revokedAt: now })
        .where(and(eq(agentTokens.squadId, this.id), isNull(agentTokens.revokedAt)))
        .returning({ agentId: agentTokens.agentId })

      // Disable schedules (inert), keep rows
      await tx
        .update(schedules)
        .set({ enabled: false })
        .where(and(eq(schedules.scopeType, 'squad'), eq(schedules.scopeId, this.id)))

      // Clear inbound channel routing pointing at this squad
      await tx
        .update(channelInstances)
        .set({ defaultSquadId: null })
        .where(eq(channelInstances.defaultSquadId, this.id))

      // Reclaim space: hard-delete memory chunks; keep documents/links
      await tx.delete(memoryChunks).where(eq(memoryChunks.squadId, this.id))

      // Retire squad slot coordination state (claims, waiters, pools) so no
      // active pool of an archived squad remains eligible for reconciliation.
      // Idempotent, pool-lock-only, no promotion and no new notifications.
      const { retireSquadSlotStateInTransaction } = await import('../services/slots/store')
      await retireSquadSlotStateInTransaction(tx, this.id, now)

      // LAST: mark archived (authoritative marker = archivedAt; status for display)
      await tx.update(squads).set({ status: 'archived', archivedAt: now, updatedAt: now }).where(eq(squads.id, this.id))

      return revoked.map((r) => r.agentId)
    })

    // --- Post-commit side-effects (non-DB, safe to run after the row is archived) ---

    // Update in-memory fields to reflect the committed state
    this.status = 'archived'
    this.archivedAt = now
    this.updatedAt = now

    // Kill the sandbox (inert) — tolerate already-gone
    await getSandboxManager().removeSandbox(`squad_${this.id}`)
    await getSandboxManager().removeSandbox(consultantSandboxId(this.id))

    // Optional on-disk removal (default: preserve)
    if (options.deleteWorkspace) {
      await removeSquadWorkspace(this.id)
      await removeSquadSsh(this.id)
    }

    // Evict revoked tokens from the in-memory cache
    for (const agentId of revokedAgentIds) removeCachedAgentToken(agentId)

    eventEmitter.emit('squad.archived', { squadId: this.id })
  }

  // ---------------------------------------------------------------------------
  // Relations
  // ---------------------------------------------------------------------------

  /**
   * Load the manager agent, returning null if not set.
   */
  async getManagerAgent(): Promise<Agent | null> {
    if (!this.managerAgentId) return null

    if (this._managerAgent === undefined) {
      // Dynamic import to avoid circular dependency
      const { Agent } = await import('./Agent')
      this._managerAgent = await Agent.find(this.managerAgentId)
    }
    return this._managerAgent
  }

  /**
   * Load the manager agent, throwing if not found.
   */
  async mustGetManagerAgent(): Promise<Agent> {
    const agent = await this.getManagerAgent()
    if (!agent) throw new Error(`Manager agent ${this.managerAgentId} not found for squad ${this.id}`)
    return agent
  }

  /**
   * List all agents in this squad.
   */
  async getAgents(): Promise<Agent[]> {
    const { Agent } = await import('./Agent')
    return Agent.list({ squadId: this.id })
  }

  /**
   * List live top-level agents in this squad.
   */
  async getActiveAgents(): Promise<Agent[]> {
    const { Agent } = await import('./Agent')
    return Agent.list({ squadId: this.id, live: true, topLevelOnly: true })
  }

  /** List wakeable dormant top-level agents in this squad. */
  async getDormantAgents(): Promise<Agent[]> {
    const { Agent } = await import('./Agent')
    return Agent.list({ squadId: this.id, status: 'dormant', topLevelOnly: true })
  }

  /** List live and dormant top-level agents from one authoritative query. */
  async getAddressableAgents(): Promise<Agent[]> {
    const { Agent } = await import('./Agent')
    return Agent.list({ squadId: this.id, addressable: true, topLevelOnly: true })
  }

  /**
   * List recently terminated agents in this squad (within the last N days).
   * @param days - Number of days to look back (default: 7)
   */
  async getRecentlyTerminatedAgents(days = 7, options: { limit?: number; offset?: number } = {}): Promise<Agent[]> {
    const { Agent } = await import('./Agent')
    return Agent.list(
      {
        squadId: this.id,
        terminatedWithinDays: days,
        topLevelOnly: true,
        limit: options.limit,
        offset: options.offset,
      },
      'recentlyTerminated'
    )
  }

  /**
   * Count recently terminated agents in this squad (within the last N days).
   * @param days - Number of days to look back (default: 7)
   */
  async countRecentlyTerminatedAgents(days = 7): Promise<number> {
    const { Agent } = await import('./Agent')
    return Agent.count({
      squadId: this.id,
      terminatedWithinDays: days,
      topLevelOnly: true,
    })
  }

  // ---------------------------------------------------------------------------
  // Agent Management
  // ---------------------------------------------------------------------------

  /**
   * Spawn a new agent in this squad.
   * @param agentTypeId - The type of agent to spawn.
   * @param persist - Whether the agent should persist (default: false).
   * @returns The newly created agent.
   */
  async spawnAgent(agentTypeId: string, options: { persist?: boolean; model?: string } | boolean = {}): Promise<Agent> {
    return squadReconciler.spawnAgent(this, agentTypeId, options)
  }

  /**
   * Reconcile this squad's agents to match its desired defaultAgents.
   * Spawns any missing default agents with persist=true. Never terminates
   * agents — extras just become non-persistent (unspawn-eligible).
   *
   * @returns The number of agents spawned.
   */
  async reconcileAgents(): Promise<number> {
    return squadReconciler.reconcileAgents(this)
  }

  // ---------------------------------------------------------------------------
  // Relationships
  // ---------------------------------------------------------------------------

  /**
   * Get all relationships for this squad.
   * @param relationshipType - Optional filter by relationship type.
   */
  async getRelationships(relationshipType?: SquadRelationshipType): Promise<SquadRelationship[]> {
    let condition = or(eq(squadRelationships.sourceSquadId, this.id), eq(squadRelationships.targetSquadId, this.id))

    if (relationshipType) {
      condition = and(condition, eq(squadRelationships.relationshipType, relationshipType))
    }

    const results = await db.select().from(squadRelationships).where(condition!)

    return results.map(squadGraph.mapRelationship)
  }

  /**
   * Get this squad with all relationships categorized by type and direction.
   */
  async withRelationships(): Promise<SquadWithRelationships> {
    return squadGraph.withRelationships(this)
  }

  /**
   * Check if this squad can communicate with another squad.
   * Squads can communicate if they have any relationship, are the same squad,
   * or either squad has global collaboration enabled.
   */
  async canCommunicateWith(otherSquadId: string): Promise<boolean> {
    return squadGraph.canCommunicateWith(this, otherSquadId)
  }

  /**
   * Get all squads connected to this squad via relationships.
   * Uses BFS traversal to find transitively connected squads.
   */
  async getConnectedSquads(): Promise<Squad[]> {
    return squadGraph.getConnectedSquads(this)
  }

  /**
   * Add a relationship from this squad to another squad.
   * @param targetSquadId - The target squad ID.
   * @param relationshipType - The type of relationship.
   * @param metadata - Optional metadata for the relationship.
   * @throws Error if target squad doesn't exist or is the same as this squad.
   */
  async addRelationship(
    targetSquadId: string,
    relationshipType: SquadRelationshipType,
    metadata?: Record<string, unknown>
  ): Promise<SquadRelationship> {
    return squadGraph.addRelationship(this, targetSquadId, relationshipType, metadata)
  }

  /**
   * Remove relationship(s) between this squad and another squad.
   * @param targetSquadId - The target squad ID.
   * @param relationshipType - Optional filter by relationship type. If omitted, removes all relationships.
   */
  async removeRelationship(targetSquadId: string, relationshipType?: SquadRelationshipType): Promise<void> {
    return squadGraph.removeRelationship(this, targetSquadId, relationshipType)
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /**
   * Search messages across all active agents in this squad.
   * Returns messages matching the search term, annotated with agent info.
   *
   * @param search - The search term to match against message content.
   * @param options - Optional filters (limit, role).
   */
  async searchMessages(search: string, options?: SearchMessagesOptions): Promise<SearchMessagesResult[]> {
    const activeAgents = await this.getActiveAgents()
    const agentIds = activeAgents.map((a) => a.id)

    if (agentIds.length === 0) return []

    const conditions: SQL[] = [inArray(messages.agentId, agentIds), ilike(messages.content, `%${search}%`)]

    if (options?.role) {
      conditions.push(eq(messages.role, options.role))
    }

    const results = await db
      .select({
        id: messages.id,
        agentId: messages.agentId,
        role: messages.role,
        content: messages.content,
        metadata: messages.metadata,
        pending: messages.pending,
        createdAt: messages.createdAt,
        agentTypeId: agents.agentTypeId,
        agentName: sql<string>`${agents.metadata}->>'name'`,
      })
      .from(messages)
      .innerJoin(agents, eq(messages.agentId, agents.id))
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(options?.limit ?? 20)

    return results.map((row) => ({
      ...mapMessage(row as any),
      agentTypeId: row.agentTypeId,
      agentName: row.agentName ?? undefined,
    }))
  }

  // ---------------------------------------------------------------------------
  // Workspace Delegation
  // ---------------------------------------------------------------------------

  /**
   * Get the workspace path for this squad.
   */
  getWorkspacePath(): string {
    return squadWorkspace.getSquadWorkspacePath(this.id)
  }

  /**
   * Ensure the workspace directory exists for this squad.
   */
  ensureWorkspace(): string {
    return squadWorkspace.ensureSquadWorkspace(this.id)
  }

  /**
   * Get the directory tree structure for this squad's workspace.
   */
  getWorkspaceTree(maxDepth?: number): squadWorkspace.TreeNode {
    return squadWorkspace.getWorkspaceTree(this.id, maxDepth)
  }

  /**
   * Read a file from this squad's workspace.
   */
  readWorkspaceFile(filePath: string): string {
    return squadWorkspace.readWorkspaceFile(this.id, filePath)
  }

  /**
   * Search files in this squad's workspace.
   */
  searchWorkspaceFiles(options?: squadWorkspace.SearchWorkspaceOptions): string[] {
    return squadWorkspace.searchWorkspaceFiles(this.id, options)
  }

  // ---------------------------------------------------------------------------
  // SSH Delegation
  // ---------------------------------------------------------------------------

  /**
   * Get the SSH directory path for this squad.
   */
  getSshPath(): string {
    return squadSsh.getSquadSshPath(this.id)
  }

  /**
   * List SSH keys for this squad.
   */
  async listSshKeys(): Promise<squadSsh.SshKeyInfo[]> {
    return squadSsh.listSshKeys(this.id)
  }

  /**
   * Get a public SSH key for this squad.
   */
  getPublicKey(keyName: string): string | null {
    return squadSsh.getPublicKey(this.id, keyName)
  }

  /**
   * Get the SSH config for this squad.
   */
  getSshConfig(): string | null {
    return squadSsh.getSshConfig(this.id)
  }

  /**
   * Add an SSH key for this squad.
   */
  async addSshKey(keyName: string, privateKey: string, publicKey?: string): Promise<void> {
    return squadSsh.addSshKey(this.id, keyName, privateKey, publicKey)
  }

  /**
   * Remove an SSH key from this squad.
   */
  async removeSshKey(keyName: string): Promise<void> {
    return squadSsh.removeSshKey(this.id, keyName)
  }

  /**
   * Set the SSH config for this squad.
   */
  async setSshConfig(config: string): Promise<void> {
    return squadSsh.setSshConfig(this.id, config)
  }

  /**
   * Add a known host entry for this squad.
   */
  async addKnownHost(hostEntry: string): Promise<void> {
    return squadSsh.addKnownHost(this.id, hostEntry)
  }

  /**
   * Get the known hosts for this squad.
   */
  getKnownHosts(): string | null {
    return squadSsh.getKnownHosts(this.id)
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Serialize to JSON.
   */
  toJson(): SquadJson {
    return {
      id: this.id,
      name: this.name,
      purpose: this.purpose,
      status: this.status,
      squadPresetId: this.squadPresetId,
      defaultAgents: this.defaultAgents ?? [],
      managerAgentId: this.managerAgentId,
      context: this.context,
      typeContext: this.typeContext ?? null,
      isAnonymous: this.isAnonymous,
      globalCollaborationEnabled: this.globalCollaborationEnabled,
      order: this.order,
      metadata: this.metadata as Record<string, unknown>,
      maxConcurrentWorkStreams: this.maxConcurrentWorkStreams ?? null,
      blockedGraceMinutes: this.blockedGraceMinutes ?? null,
      sandboxStatus: this.sandboxStatus,
      avatarImageId: this.avatarImageId ?? null,
      avatarUrl: this.avatarImageId ? buildSignedImageUrlPath(this.avatarImageId) : null,
      hostWorkspacePath: this.hostWorkspacePath ?? null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      archivedAt: this.archivedAt ?? null,
    }
  }
}
