import { consultantSandboxSquadId, consultantScratchPath } from '../../services/sandbox/consultant-sandbox'
import { resolveWorkspaceLayout } from '../../services/sandbox/workspace-layout'
import { messageTextForModel } from '../../services/chat/message-context'
import { existsSync, readFileSync } from 'fs'
import { markExecutionStartupFailure } from '../../services/execution/startup-retry'
import { join, resolve } from 'path'
import { type SessionUsage, type MessageMetadata, type AgentType, type Message } from '@ficus/shared'
import { Image, type ImageContent } from '../Image'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { StreamBuffer } from '../../services/streaming/buffer'
import { StreamEventCollector } from '../../services/streaming/events'
import { turnHooks, type TurnContext } from '../../services/turn-hooks'
import { createLogger } from '../../lib/infra/logger'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { executionLifecycleRegistry } from '../../services/execution/lifecycle-registry'
import {
  AdmissionLeaseLostError,
  AdmissionReservationStore,
  AdmissionScope,
  attachAdmissionLeaseToError,
  type AdmissionLease,
} from '../../services/maintenance/admission-reservation'
import { admissionLeasePauseEvidence, MaintenanceAdmissionPaused } from '../../services/maintenance/admission-evidence'
import { admissionProcessIncarnation } from '../../services/maintenance/process-liveness'
import {
  classifySettlementFailure,
  classifyTurnFailure,
  MISSING_RESOURCE_FAILURE,
  type ExecutionFailure,
} from '../../services/execution/failure-classification'

import { Execution } from '../Execution'
import { SessionMessagePersistence } from './session-message-persistence'
import { ModelFailoverCoordinator } from './model-failover'
import { providerHealth, type ProviderHealthAttempt } from '../../services/provider-health/registry'
import { PendingInterventionQueue } from './intervention-queue'
import { META_COUNT, META_LAST_AT } from '../../services/sandbox/restart/types'
import {
  createBuffer,
  registerSession,
  isSessionActive,
  isTransitionalOperationInProgress,
  removeSession,
  setSessionCompacting,
  isWorkerShuttingDown,
  markExecutionSettling,
  clearExecutionSettling,
} from '../../services/execution/session-state'
import { EXTENSIONS_DIR } from '../../lib/paths'
import { materializeSandboxSkills, materializeSkills } from '../../services/agent/skill-materializer'
import { Agent } from '../Agent'
import { AgentSession } from '../AgentSession'
import { Skill } from '../Skill'
import { createCodingTools, isHostRuntime } from '../../services/sandbox'
import { createSandboxStatusTool } from '../../tools/sandbox-status'
import { createShortTermMemoryTools, createAgentShortTermMemoryStorage } from '../../tools/short-term-memory'
import { BIGBRAIN_TOOL_NAMES, type BigbrainToolContext } from '../../services/integrations/bigbrain/tools'
import { resolveOAuthAuthority } from '../../services/integrations/authorization/authority'
import { IntegrationRuntimeGate } from '../../services/integrations/runtime-gate'
import {
  integrationAuditRecorder,
  integrationConnectionRepository,
  integrationRegistry,
} from '../../services/integrations/runtime'
import { getSecretStore } from '../../services/secrets'
import { getContentSafetyRegistry } from '../../services/security/content-safety-registry'
import { StoredSecretToolContainment } from '../../services/security/stored-secret-tool-containment'
import {
  recordStoredSecretToolAudit,
  type StoredSecretToolAuditInput,
} from '../../services/security/stored-secret-tool-audit'
import { mergeAgentRefs, resolveAssignedIntegrationRefs } from '../../services/integrations/projection/agent-refs'
import { toolNameMatchesAny } from '../../lib'
import { durableProviderTransportFailureText } from '../../lib/error'
import type { SandboxSetupProgressListener } from '../../services/sandbox/setup-progress'

export function deploymentOAuthAuthorityForProvider(provider: string): 'local' | 'platform_broker' | undefined {
  return integrationRegistry.plugin(provider)?.authorization.kind === 'oauth2' ? resolveOAuthAuthority() : undefined
}

export function allowsBigbrainIntegrationTools(
  toolsAllow: string[] | null | undefined,
  policy: { version: number; allow: Record<string, readonly string[]> } | null | undefined
): boolean {
  return Boolean(
    toolsAllow &&
    BIGBRAIN_TOOL_NAMES.some((name) => toolNameMatchesAny(toolsAllow, name)) &&
    policy?.version === 1 &&
    policy.allow.bigbrain?.includes('agent_tools')
  )
}
import * as rbacPermissions from '../../services/rbac/permissions'
import type { RunnerTiming } from '../../services/execution/runner-timing'
import { logRunnerMilestone } from '../../services/execution/runner-timing'
import { withUsageDelta, withoutDelta, type UsageBaseline } from '../../services/execution/usage-delta'

const log = createLogger('runner')
const STRANDED_PENDING_RETRY_BUDGET = 3

/** Supported agent runners */
export type AgentRunnerType = 'system-manager' | 'squad-manager' | 'squad-worker' | 'artifact-builder' | 'subagent'

export function getSquadAgentTypeSkills(metadata: unknown, agentTypeId: string): string[] {
  if (!metadata || typeof metadata !== 'object') return []
  const agentTypeSkills = (metadata as { agentTypeSkills?: unknown }).agentTypeSkills
  if (!agentTypeSkills || typeof agentTypeSkills !== 'object' || Array.isArray(agentTypeSkills)) return []
  const skills = (agentTypeSkills as Record<string, unknown>)[agentTypeId]
  if (!Array.isArray(skills)) return []
  return skills.filter((skill): skill is string => typeof skill === 'string' && skill.trim().length > 0)
}

/**
 * Base class for all agent runners.
 *
 * Owns the common lifecycle: session creation, event subscription with
 * settled-run handling, prompt dispatch, and error handling.
 *
 * Subclasses implement context-specific setup, prompt building, and completion.
 */
export abstract class AgentRunner {
  protected session!: AgentSession
  /**
   * Delta-accounting state for this execution. `pending` until the session has
   * been opened and its baseline snapshot captured; captures taken while
   * pending deliberately carry no `delta` (legacy fallback) so a resumed
   * session can never be double-counted by early persistence.
   */
  private usageBaseline: UsageBaseline = { kind: 'pending' }
  protected buffer!: StreamBuffer
  protected collector!: StreamEventCollector
  private pendingConfirmed = false
  private initialPromptDelivery: { text: string; messageIds: string[]; confirmed: boolean } | undefined
  protected readonly persistence: SessionMessagePersistence
  private readonly interventionQueue: PendingInterventionQueue
  private admissionStore: AdmissionReservationStore | null = null
  private admissionLease: AdmissionLease | null = null
  protected admissionScope: AdmissionScope | null = null
  /** Settled when the most recent agent-session write phase has closed (see sendPromptInAgentSessionPhase). */
  private agentSessionPhase: Promise<void> | null = null
  private agentSessionPhaseOpen = false
  private activeHealthAttempt: ProviderHealthAttempt | undefined
  /** Conservative execution-local fence for same-prompt provider failover. */
  private transportReplaySafe = true
  _timing?: RunnerTiming

  protected readonly failover: ModelFailoverCoordinator

  /**
   * Per-execution stored-secret containment: denies validated tool calls whose
   * args contain an exact stored value before `tool.execute`, and audits
   * post-execution result matches reported by the inbound redaction boundary.
   * Containment never fails, aborts, or terminates the execution itself.
   */
  protected readonly storedSecretToolContainment: StoredSecretToolContainment

  /** Delay before signaling that reported blocking sandbox setup is still active. */
  protected sandboxWaitDelayMs = 1500
  private sandboxSetupBatch:
    | {
        activeOperationIds: Set<string>
        timer: ReturnType<typeof setTimeout> | null
        waitingEmitted: boolean
        failed: boolean
      }
    | undefined

  /** Receives authoritative setup progress while a concrete runner's setup batch is active. */
  protected readonly sandboxSetupProgress: SandboxSetupProgressListener = (event) => {
    const batch = this.sandboxSetupBatch
    if (!batch) return

    if (event.type === 'started') {
      batch.activeOperationIds.add(event.operationId)
      if (!batch.waitingEmitted && !batch.timer) {
        batch.timer = setTimeout(() => {
          if (this.sandboxSetupBatch !== batch || batch.activeOperationIds.size === 0) return
          batch.timer = null
          batch.waitingEmitted = true
          this.buffer.push({ type: 'execution_phase', phase: 'waiting_sandbox' })
        }, this.sandboxWaitDelayMs)
      }
      return
    }

    batch.activeOperationIds.delete(event.operationId)
    if (event.outcome === 'failed') batch.failed = true
    if (batch.activeOperationIds.size === 0 && batch.timer) {
      clearTimeout(batch.timer)
      batch.timer = null
    }
  }

  /**
   * Groups contiguous physical sandbox/toolchain setup so sequential operations share one
   * debounced waiting phase and successful completion emits at most one ready phase.
   */
  protected async withSandboxSetupBatch<T>(operation: () => Promise<T>): Promise<T> {
    if (this.sandboxSetupBatch) return operation()

    const batch = {
      activeOperationIds: new Set<string>(),
      timer: null as ReturnType<typeof setTimeout> | null,
      waitingEmitted: false,
      failed: false,
    }
    this.sandboxSetupBatch = batch
    try {
      const result = await operation()
      if (batch.waitingEmitted && !batch.failed) {
        this.buffer.push({ type: 'execution_phase', phase: 'sandbox_ready' })
      }
      return result
    } finally {
      if (batch.timer) clearTimeout(batch.timer)
      if (this.sandboxSetupBatch === batch) this.sandboxSetupBatch = undefined
    }
  }

  constructor(
    protected readonly execution: Execution,
    protected readonly agent: Agent,
    protected readonly agentType: AgentType
  ) {
    this.persistence = new SessionMessagePersistence({
      executionId: execution.id,
      agent,
    })
    this.failover = new ModelFailoverCoordinator({
      agentId: agent.id,
      executionId: execution.id,
      getSession: () => this.session,
      getBuffer: () => this.buffer,
      getCollector: () => this.collector,
      resendPrompt: () => this.sendPromptInAgentSessionPhase(),
      isTransportReplaySafe: () => this.transportReplaySafe,
    })
    this.interventionQueue = new PendingInterventionQueue({
      agentId: agent.id,
      agent,
      targetAgent: agent,
      getSession: () => this.session,
      isActive: () => isSessionActive(this.agent.id),
    })
    this.storedSecretToolContainment = new StoredSecretToolContainment({
      agentId: agent.id,
      executionId: execution.id,
      sink: (input) => this.recordStoredSecretToolAudit(input),
    })
  }

  /** Sole audit write site (and the test seam replacing the DB writer). */
  protected recordStoredSecretToolAudit(input: StoredSecretToolAuditInput): Promise<void> {
    return recordStoredSecretToolAudit(input)
  }

  private async revokeAdmissionLease(): Promise<void> {
    const store = this.admissionStore
    const lease = this.admissionLease
    if (!store || !lease) return
    this.admissionScope?.abort(new Error('Admission startup aborted'))
    await this.admissionScope?.close()
    await store.revokeLease(lease)
  }

  /**
   * Run `operation` inside a durable admission write phase.
   *
   * A refusal is classified rather than blanket-treated as a maintenance pause:
   * MaintenanceAdmissionPaused only when the maintenance fence really closed
   * (the caller parks the execution). Any other refusal — the row was settled,
   * taken over, or is in a state this owner cannot repair — throws
   * AdmissionLeaseLostError (tagged with the lease so the terminal write stays
   * fenced). Parking on those used to be a no-op with maintenance inactive,
   * leaving the row `running` and unheld for the abandoned-lease sweep to
   * re-queue as a duplicate run.
   *
   * The agent-session phase spans the whole model turn, so it is heartbeated
   * (like AdmissionScope.runEffect); otherwise the 30s lease lapsed on any turn
   * longer than that, the row was marked `unknown`, and this owner's own finish
   * and settlement were refused.
   */
  private async withAdmissionWritePhase<T>(
    phaseName: 'agent-session' | 'settlement',
    resourceKey: string,
    operation: () => Promise<T>,
    nextState: 'running' | 'settling' = 'running'
  ): Promise<T> {
    if (!this.admissionStore || !this.admissionLease) return operation()
    const store = this.admissionStore
    const lease = this.admissionLease
    const begun = await store.beginWritePhaseDetailed(lease, phaseName, resourceKey)
    if (!begun.phase) {
      if (begun.refusal === 'fence-closed') {
        throw new MaintenanceAdmissionPaused(admissionLeasePauseEvidence(lease, 'write-phase-begin'))
      }
      throw attachAdmissionLeaseToError(
        new AdmissionLeaseLostError(this.execution.id, phaseName, begun.refusal ?? 'phase-conflict'),
        lease
      )
    }
    const phase = begun.phase
    const finishOrThrow = async (reason: 'write-phase-finish-settlement' | 'write-phase-finish-running') => {
      if (await store.finishWritePhase(lease, phase, nextState)) return
      if (!(await store.isFenceOpen(lease))) {
        throw new MaintenanceAdmissionPaused(admissionLeasePauseEvidence(lease, reason))
      }
      // Our own terminal teardown may have settled this exact lease while this
      // finish was in flight (the settlement transition races the finish). A
      // TERMINAL exact lease is our own bookkeeping catching up — not a fence
      // loss, and never a platform-refusal classification or owner notice.
      if (await store.isLeaseTerminal(lease)) return
      throw attachAdmissionLeaseToError(
        new AdmissionLeaseLostError(this.execution.id, phaseName, 'finish-refused'),
        lease
      )
    }
    // Settlement itself terminalizes/releases the reservation, so publish its
    // blocking state before entering that operation. Other phases finish after
    // their external call, allowing a concurrent pause to revoke them safely.
    if (nextState === 'settling') {
      await finishOrThrow('write-phase-finish-settlement')
      return operation()
    }
    const result = this.admissionScope ? await this.admissionScope.heartbeatWhile(phase, operation) : await operation()
    await finishOrThrow('write-phase-finish-running')
    return result
  }

  /**
   * Dispatch the turn's prompt inside the agent-session write phase (heartbeated
   * for the whole turn) and remember that phase so settlement can wait for it to
   * close: Pi emits agent_settled BEFORE prompt() resolves, so without the wait
   * settlement's beginWritePhase could race the agent-session finish and be
   * refused with the fence still open. Failover re-dispatches from inside an
   * open phase (sendPrompt's own catch) simply run in that phase; re-dispatches
   * from handleAgentEnd (after the phase closed) open a fresh one, so a retried
   * turn is heartbeated too instead of lapsing its lease unobserved.
   */
  private async sendPromptInAgentSessionPhase(): Promise<void> {
    if (this.agentSessionPhaseOpen) return this.sendPrompt()
    const previous = this.agentSessionPhase
    const run = (async () => {
      await previous
      this.agentSessionPhaseOpen = true
      try {
        await this.withAdmissionWritePhase('agent-session', `execution:${this.execution.id}:prompt`, () =>
          this.sendPrompt()
        )
      } finally {
        this.agentSessionPhaseOpen = false
      }
    })()
    this.agentSessionPhase = run.then(
      () => undefined,
      () => undefined
    )
    await run
  }

  protected createPiSession(scope: AdmissionScope | null, create: () => Promise<AgentSession>): Promise<AgentSession> {
    if (!scope) return create()
    return scope.runEffect(
      {
        phase: 'session-create',
        resourceKey: `execution:${this.execution.id}:pi-session`,
        successState: 'running',
      },
      create,
      (session) => session.dispose?.()
    )
  }

  /**
   * Cumulative session usage plus this execution's own `delta`. Every write of
   * execution usage goes through here so no consumer can accidentally persist a
   * bare cumulative snapshot and later sum it.
   *
   * While the baseline is still `pending` (session open but baseline not yet
   * captured) the result carries NO delta — the row falls back to legacy
   * `MAX()` semantics rather than double-counting a resumed session.
   */
  protected captureUsage(): SessionUsage {
    if (!this.session) {
      throw new Error('AgentRunner.captureUsage() called before the session was created')
    }
    return withUsageDelta(this.session.captureUsage(), this.usageBaseline)
  }

  /**
   * Capture the baseline for this execution's usage delta. Call exactly once,
   * right after the session is opened.
   */
  protected initializeUsageBaseline(): void {
    this.usageBaseline = { kind: 'captured', snapshot: this.session.captureUsage() }
  }

  /** The turn's model priority list — delegates to the failover coordinator. */
  protected get priorityList(): string | undefined {
    return this.failover.priorityList
  }
  protected set priorityList(value: string | undefined) {
    this.failover.priorityList = value
  }

  /** The currently-active model spec — delegates to the failover coordinator. */
  protected get currentSelectedSpec(): string | undefined {
    return this.failover.currentSelectedSpec
  }
  protected set currentSelectedSpec(value: string | undefined) {
    this.failover.currentSelectedSpec = value
  }

  /** Runtime failover after an exhaustion error — see ModelFailoverCoordinator.attempt. */
  protected async attemptFailover(error: unknown): Promise<boolean> {
    return this.failover.attempt(error)
  }

  /** Resolve agent type skill IDs plus squad-scoped extra skill IDs to SKILL.md directories. */
  protected async resolveSkillPaths(sandboxId?: string): Promise<string[] | undefined> {
    const refs = await this.resolveSkillRefs()
    return sandboxId ? materializeSandboxSkills(sandboxId, refs) : materializeSkills(refs)
  }

  protected async resolveSkillRefs(): Promise<string[] | undefined> {
    const refs = [...(this.agentType.skills ?? [])]
    if (this.agent.squadId) {
      const squad = await this.agent.getSquad()
      const extraSkills = getSquadAgentTypeSkills(squad?.metadata, this.agentType.id)
      refs.push(...extraSkills)
      const integrationRefs = await resolveAssignedIntegrationRefs(this.agent.squadId)
      refs.push(...integrationRefs.skills)
    }
    if (!refs.length) return undefined

    const unique = [...new Set(refs)]
    const skills = await Skill.list({ includeDisabled: true })
    const skillById = new Map(skills.map((skill) => [skill.id, skill]))
    const hasReferencedGatedSkill = unique.some((id) => Boolean(skillById.get(id)?.requiredPermission))
    if (!hasReferencedGatedSkill) return unique

    const held = await rbacPermissions.resolvePermissions(
      { type: 'agent', agentId: this.agent.id, squadId: this.agent.squadId ?? null },
      this.agent.squadId ?? undefined
    )
    const filtered = unique.filter((id) => {
      const required = skillById.get(id)?.requiredPermission
      if (!required) return true
      return held.some((permission) => rbacPermissions.permissionMatches(permission, required))
    })
    return filtered.length ? filtered : undefined
  }

  /** Resolve agent type extension paths relative to config/agent/extensions/ in the monorepo root.
   * If a path is a directory with package.json containing pi.extensions, resolves to those entry points. */
  protected async resolveExtensionPaths(): Promise<string[] | undefined> {
    const integrationRefs = await resolveAssignedIntegrationRefs(this.agent.squadId)
    const refs = mergeAgentRefs(this.agentType.extensions, integrationRefs.extensions)
    if (!refs) return undefined
    const result: string[] = []
    const root = resolve(EXTENSIONS_DIR)
    for (const p of refs) {
      const basePath = resolve(root, p)
      if (basePath !== root && !basePath.startsWith(`${root}/`)) continue
      const entries = resolveExtensionEntries(basePath)
      if (entries?.length) {
        result.push(...entries)
      } else {
        result.push(basePath)
      }
    }
    return result
  }

  /** Create the Pi SDK session with context-specific config */
  protected abstract createSession(scope: AdmissionScope | null): Promise<AgentSession>

  // ---------------------------------------------------------------------------
  // Shared session-setup building blocks
  //
  // Every runner's createSession composes the same foundation: resolve ids and
  // paths, ensure sandbox(es) (runner-specific), build the common tool bundle,
  // then hand AgentSession.create the byte-identical scaffolding. The bespoke
  // parts — prompts, capability tools, core/available split — stay in each
  // runner where they're visible.
  // ---------------------------------------------------------------------------

  /** Ids and paths resolved before sandbox ensure (materializing skills BEFORE
   *  ensure so the sandbox's skills delivery — per the asset manifest — has
   *  content to deliver; skillPaths themselves feed the Pi session). */
  protected async resolveSessionPaths(): Promise<{
    sandboxId: string
    skillPaths: string[] | undefined
    extensionPaths: string[] | undefined
  }> {
    const sandboxId = await this.agent.getSandboxId()
    const skillPaths = await this.resolveSkillPaths(sandboxId)
    const extensionPaths = await this.resolveExtensionPaths()
    return { sandboxId, skillPaths, extensionPaths }
  }

  /** Overridable wrapper around the sandbox coding-tools factory — test seam. */
  protected createCodingTools(
    workspacePath: string,
    sandboxId: string,
    tauToken?: string,
    squadId?: string,
    invocationOwnerId?: string,
    agentId?: string
  ) {
    return createCodingTools(workspacePath, sandboxId, tauToken, squadId, invocationOwnerId, agentId)
  }

  /**
   * The tool bundle every sandboxed runner wires identically: a scoped agent
   * token (so `tau` CLI calls authenticate AS this agent under RBAC), the
   * sandboxed coding tools, live sandbox_status, and short-term memory tools.
   *
   * `sandboxStatusTool` is `null` on the host runtime: there is no sandbox to
   * report on, and agents there must never be given a tool that implies one
   * exists. Every caller must include it conditionally.
   */
  protected async buildSessionToolkit(opts: { workspacePath: string; sandboxId: string; squadId?: string }) {
    if (consultantSandboxSquadId(opts.sandboxId)) {
      const { getSandboxManager } = await import('../../services/sandbox/factory')
      const root = resolveWorkspaceLayout({ sandboxId: opts.sandboxId }).privateMount
      await getSandboxManager().exec(opts.sandboxId, [
        'mkdir',
        '-p',
        '--',
        consultantScratchPath(root, opts.sandboxId, this.agent.id),
      ])
    }
    const tauToken = await this.agent.getOrCreateToken()
    // The agent id is passed explicitly, not derived from the sandbox id: a
    // system-manager's box is `system_manager_<ownerUserId>` and a descendant can
    // share a box, so only the runner knows whose shell this is (host runtime
    // uses it for the per-agent CLI auth store).
    const baseTools = this.createCodingTools(
      opts.workspacePath,
      opts.sandboxId,
      tauToken,
      opts.squadId,
      this.execution.id,
      this.agent.id
    )
    const sandboxStatusTool = isHostRuntime()
      ? null
      : createSandboxStatusTool({
          agentId: this.agent.id,
          sandboxId: opts.sandboxId,
          squadId: opts.squadId,
        })
    const shortTermMemoryTools = createShortTermMemoryTools(createAgentShortTermMemoryStorage(this.agent.id))
    return { tauToken, baseTools, sandboxStatusTool, shortTermMemoryTools }
  }

  /**
   * The AgentSession.create fields shared by every runner. `model` defaults to
   * the agent's effective spec for its type; runners with bespoke resolution
   * (consultant, system-manager) pass their own.
   *
   * Tool policy is split: the runner decides what it CAN offer (`core` +
   * `available`), the agent type's YAML decides what this type GETS — its
   * toolsAllow/toolsDeny narrow `available` uniformly here, for every runner.
   * Runners must not pass their own allow/deny.
   */
  protected async buildBaseSessionOptions(opts: {
    systemPrompt: string
    skillPaths: string[] | undefined
    extensionPaths: string[] | undefined
    sandboxId?: string
    workspacePath?: string
    squadId?: string
    model?: Parameters<typeof AgentSession.create>[0]['model']
    tools: Omit<NonNullable<Parameters<typeof AgentSession.create>[0]['tools']>, 'allow' | 'deny'>
  }): Promise<Parameters<typeof AgentSession.create>[0]> {
    const integrationTools = await this.resolveIntegrationTools()
    return {
      model: opts.model ?? (await this.agent.getEffectiveModelSpec(this.agentType.model)),
      currentSelectedModel: this.agent.selectedModel ?? undefined,
      storage: { agentId: this.agent.id },
      systemPrompt: opts.systemPrompt,
      skillPaths: opts.skillPaths,
      extensionPaths: opts.extensionPaths,
      earlyMarginTokens: this.agentType.earlyMarginTokens,
      inFlightMarginTokens: this.agentType.inFlightMarginTokens,
      tools: {
        ...opts.tools,
        available: [...(opts.tools.available ?? []), ...integrationTools],
        allow: this.agentType.toolsAllow ?? undefined,
        deny: this.agentType.toolsDeny ?? undefined,
      },
      sandbox:
        opts.sandboxId && opts.workspacePath
          ? {
              sandboxId: opts.sandboxId,
              workspacePath: opts.workspacePath,
              squadId: opts.squadId,
            }
          : undefined,
      onStoredToolResult: ({ toolCallId, storedKeys }) =>
        this.storedSecretToolContainment.recordAlreadyExecuted(toolCallId, storedKeys),
    }
  }

  /** Resolve dynamic tools fail-closed. Existing static tools remain unchanged. */
  protected async resolveIntegrationTools() {
    const allow = this.agentType.toolsAllow
    const policy = this.agentType.integrationCapabilities
    if (!this.agent.squadId || !allowsBigbrainIntegrationTools(allow, policy ?? null)) return []
    const gate = new IntegrationRuntimeGate({
      repository: integrationConnectionRepository,
      currentAuthority: deploymentOAuthAuthorityForProvider,
      supportedAdapterVersion: (provider) => integrationRegistry.get(provider)?.adapterVersion,
      supportedConfigVersion: (provider) => (provider === 'bigbrain' ? 1 : undefined),
    })
    const factory = integrationRegistry.plugin('bigbrain')?.runtime.agentTools
    if (!factory) return []
    const context: BigbrainToolContext = {
      agent: { id: this.agent.id, squadId: this.agent.squadId, integrationCapabilities: policy ?? null },
      squadId: this.agent.squadId,
      gate,
      credentials: {
        get: (key) => getSecretStore().get(key),
        set: (key, value, actor) => getSecretStore().set(key, value, actor),
        delete: (key) => getSecretStore().delete(key),
      },
      audit: integrationAuditRecorder,
      connections: integrationConnectionRepository,
    }
    return factory.createTools(context)
  }

  /** Handle successful settled agent run */
  protected abstract onComplete(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<void>

  /** Push an agent event to the buffer before streaming starts.
   *  Subclasses override to include scope info. */
  protected pushAgentEvent(): void {
    this.buffer.push({
      type: 'agent',
      agentId: this.agent.id,
      executionId: this.execution.id,
    })
  }

  /**
   * Handle errors — removes session, marks execution failed, agent idle (or waiting-input for rate limits).
   * `failure` is the structural classification from the failure site; when
   * absent the row stays unclassified (legacy/NULL).
   * Subclasses can call super.onError() and add context-specific cleanup.
   */
  protected onError(error: string, failure?: ExecutionFailure): void {
    log.error(`Execution ${this.execution.id} failed: ${error}`)
    this.interventionQueue.clear()
    // Hold the execution as ours through the terminal transition: the row is
    // still 'running' after the session is gone, and its lease has expired, so
    // the abandoned-lease sweep would otherwise re-queue it mid-failure.
    markExecutionSettling(this.agent.id, this.execution.id)
    removeSession(this.agent.id)
    this.execution
      .fail(error, this.admissionLease ?? undefined, failure)
      .catch(() => {})
      .finally(() => clearExecutionSettling(this.agent.id, this.execution.id))
  }

  /**
   * Handle missing resource during setup — pushes error to stream and marks execution failed.
   */
  protected async handleMissingResource(resourceName: string): Promise<void> {
    const errorMsg = `${resourceName} not found`
    log.error(`Cannot execute execution ${this.execution.id}: ${errorMsg}`)
    if (this.buffer) {
      this.buffer.push({ type: 'error', message: errorMsg })
      this.buffer.fail()
    }
    await this.execution.fail(errorMsg, this.admissionLease ?? undefined, MISSING_RESOURCE_FAILURE)
  }

  /**
   * Template method — sets up session, subscribes to events, sends prompt.
   */
  async run(): Promise<void> {
    const maintenanceLifecycle = executionLifecycleRegistry.get(this.execution.id)
    maintenanceLifecycle?.attachFallbackSettlement(async () => {
      await this.persistence.markActiveToolAborted()
      await this.persistence.waitForAll()
      await this.storedSecretToolContainment.waitForAuditWrites()
      removeSession(this.agent.id)
      maintenanceLifecycle.settle()
    })
    if (maintenanceLifecycle?.interruptRequested) return

    // Create buffer early so errors during session creation can be pushed to the
    // SSE stream instead of being silently swallowed.
    this.buffer = createBuffer(this.execution.id)
    this.collector = new StreamEventCollector(this.buffer, () => this.persistence.currentStreamGroupId)
    this.persistence.attach({
      collector: this.collector,
      buffer: this.buffer,
      captureUsage: () => this.captureUsage(),
      confirmInitialPrompt: (content, identity) => this.tryConfirmInitialPromptMessage(content, identity),
    })

    try {
      const durableExecutionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        this.execution.id
      )
      if (durableExecutionId && this.execution.runnerClaimToken && this.execution.runnerClaimGeneration !== null) {
        const admissionStore = new AdmissionReservationStore('runner', admissionProcessIncarnation)
        const admissionLease = await admissionStore.claimProvisionalLease(
          this.execution.id,
          this.execution.runnerClaimToken,
          this.execution.runnerClaimGeneration
        )
        if (!admissionLease) throw new Error('Execution admission reservation is missing, foreign, or terminal')
        const admissionScope = new AdmissionScope(admissionStore, admissionLease)
        this.admissionStore = admissionStore
        this.admissionLease = admissionLease
        this.admissionScope = admissionScope
        maintenanceLifecycle?.attachQuiesce(async () => {
          admissionScope.abort(
            new MaintenanceAdmissionPaused(admissionLeasePauseEvidence(admissionLease, 'scope-abort-effective-change'))
          )
        })
        this.session = await this.createSession(this.admissionScope)
      } else {
        // Unit-test runners use symbolic execution IDs and have no durable DB claim.
        this.session = await this.createSession(null)
      }
      // Stored-secret containment wraps Pi's existing beforeToolCall (installed
      // once at coding-agent session construction) so a validated call whose
      // args contain an exact stored value is refused before `tool.execute`.
      // Detach rides session teardown. A session without an exposed agent
      // (only exotic test mocks) skips the wrap loudly rather than failing the run.
      const containmentAgent = (this.session.pi as { agent?: unknown }).agent
      if (containmentAgent) {
        const detachStoredSecretHook = this.storedSecretToolContainment.attachBeforeToolCall(
          containmentAgent as Parameters<StoredSecretToolContainment['attachBeforeToolCall']>[0],
          getContentSafetyRegistry()
        )
        const session = this.session
        const priorDispose = session.dispose?.bind(session)
        session.dispose = () => {
          detachStoredSecretHook()
          priorDispose?.()
        }
      } else {
        log.warn(
          `Session for execution ${this.execution.id} exposes no Pi agent; stored-secret pre-call denial inactive`
        )
      }
      if (maintenanceLifecycle?.interruptRequested) {
        if (this.session.pi.isBashRunning) this.session.pi.abortBash()
        await this.session.pi.abort()
        this.session.dispose?.()
        await this.revokeAdmissionLease()
        return
      }
      if (this._timing) logRunnerMilestone(this._timing, 'session-ready')
      // Baseline for this execution's usage delta. pi's session stats are
      // cumulative across the whole reloaded session, so without a per-execution
      // baseline every consumer that sums execution usage overcounts.
      this.initializeUsageBaseline()
      // The exact tool set this session exposes to the model. Pi does not
      // persist it, so without this line a "my session lacks tool X" report is
      // unprovable after the fact.
      const activeToolNames = this.session.pi.getActiveToolNames?.() ?? []
      log.debug(
        `session-tools executionId=${this.execution.id} agent=${this.agent.id} runner=${this._timing?.runnerType ?? 'unknown'} tools=${activeToolNames.join(',')}`
      )

      // createSession has now (re-)ensured this agent's sandbox(es) — including
      // recreating any the user manually stopped. Signal the UI so it refetches
      // sandbox status immediately and shows the box coming up, instead of
      // waiting for the next poll tick (or a poll paused between turns).
      eventEmitter.emit('sandbox.ensured', { agentId: this.agent.id })

      // Capture the effective model priority list and the actually-selected
      // candidate so runtime failover can re-select without re-reading the DB.
      // The session may not carry a selectedSpec (e.g. mock sessions in tests),
      // in which case we fall back to the full priority list.
      // Reset the per-turn failover caps once per user turn (not per sendPrompt).
      const priorityList = await this.agent.getEffectiveModelSpec(this.agentType.model)
      this.transportReplaySafe = true
      await this.failover.beginTurn(priorityList, this.session.selectedSpec ?? priorityList)

      if (maintenanceLifecycle?.interruptRequested) {
        await this.session.pi.abort()
        this.session.dispose?.()
        await this.revokeAdmissionLease()
        return
      }

      registerSession(this.agent.id, {
        session: this.session,
        collector: this.collector,
        buffer: this.buffer,
        agentId: this.agent.id,
        executionId: this.execution.id,
      })
    } catch (err) {
      // createSession threw (e.g. sandbox ensure failed) — fail through the existing path below.
      // No sandbox_ready is emitted: the ensure did not succeed.
      this.interventionQueue.clear()
      removeSession(this.agent.id)
      this.session?.dispose?.()
      try {
        await this.revokeAdmissionLease()
      } catch {
        // Preserve the original startup failure; exact cleanup can only lose its fence.
      }
      throw markExecutionStartupFailure(
        this.admissionLease ? attachAdmissionLeaseToError(err, this.admissionLease) : err
      )
    }

    this.pushAgentEvent()

    if (this.session.switchedBack) {
      const { from, to, reason } = this.session.switchedBack
      log.info(`Agent ${this.agent.id} proactive model switch-back: ${from} → ${to} (${reason})`)
      this.buffer.push({
        type: 'system_message',
        text: `Recovered provider available — switched back to ${to} (from ${from}).`,
      })
    }

    // Subscribe to session events — shared streaming + settled-run logic
    this.session.pi.subscribe((event: AgentSessionEvent) => {
      if (!isSessionActive(this.agent.id)) return

      // A live failover can resend the same prompt only while this execution has
      // produced no assistant or tool output. Mark progress before any normal
      // processing so event-handler failures cannot leave the replay gate open.
      if (this.eventMakesTransportReplayUnsafe(event)) this.transportReplaySafe = false

      // On first assistant output, record the milestone only. Pending human rows
      // are confirmed through the DB-backed claim + SDK persisted-user-message
      // path, so first output must never bulk-confirm unrelated user/inbox rows.
      if (!this.pendingConfirmed && event.type === 'message_update') {
        this.pendingConfirmed = true
        if (this._timing) logRunnerMilestone(this._timing, 'first-output')
      }

      // Persist DB messages only after the Pi SDK confirms the message was
      // written to the session file. Human messages are eagerly saved as
      // pending=true before reaching the runner, so persisted user messages only
      // need confirmation here.
      if (event.type === 'session_message_persisted') {
        this.persistence.enqueuePersistedEvent(event)

        // Mid-turn precompaction: persisted session messages (especially tool
        // results) grow context while an agent is still active. Check the
        // tighter in-flight threshold here; the controller dedupes in-flight or
        // ready bakes, so this remains a cheap no-op until near compaction.
        if (this.session.precompaction && !isTransitionalOperationInProgress(this.agent.id)) {
          this.session.precompaction.onContextGrowth()
        }
      }

      if (event.type === 'auto_retry_start') {
        const retryEvent = event as { type: 'auto_retry_start'; attempt: number; maxAttempts: number }
        log.info('Pi provider retry started', {
          strategy: 'pi-auto-retry',
          executionId: this.execution.id,
          agentId: this.agent.id,
          attempt: retryEvent.attempt,
          maxAttempts: retryEvent.maxAttempts,
        })
      }

      if (event.type === 'auto_retry_end') {
        const retryEvent = event as { type: 'auto_retry_end'; success: boolean }
        log.info('Pi provider retry ended', {
          strategy: 'pi-auto-retry',
          executionId: this.execution.id,
          agentId: this.agent.id,
          success: retryEvent.success,
        })
        if (retryEvent.success) {
          // Retry succeeded — discard the failed attempt's partial response.
          this.collector.reset()
        }
      }

      if (event.type === 'compaction_start') {
        setSessionCompacting(this.agent.id, true)
      }

      if (event.type === 'compaction_end') {
        setSessionCompacting(this.agent.id, false)
        const compactionEvent = event
        if (compactionEvent.willRetry) {
          // The SDK will retry the turn after compaction.
          // Reset the collector so the next turn's response is captured cleanly.
          this.collector.reset()
          // Rotate the streamGroupId so the pre-compaction persisted message and the
          // post-compaction streaming response do not share an id. The frontend
          // reconciles persisted vs streaming per streamGroupId, so a shared id would
          // hide the pre-compaction message while the post-compaction group streams
          // and would misorder the compaction system notice.
          this.persistence.rotateStreamGroup()
          this.persistence.enqueueCompactionNotice()
        } else if (compactionEvent.aborted) {
          // Compaction was aborted (likely by session.abort() from stop).
          // Check if we're in a transitional state and need to finalize.
          setTimeout(() => {
            this.checkTransitionalStateAfterAbort()
          }, 0)
        }

        if (compactionEvent.errorMessage) {
          // Compaction failures (e.g. the summarize request overflowing a
          // smaller-window model, #625) were only visible transiently in the
          // live stream buffer, leaving no server-side trace once the chat
          // session ended. Log it so it survives for post-hoc diagnosis.
          log.warn(`Compaction failed for agent ${this.agent.id}: ${compactionEvent.errorMessage}`)
        }
      }

      this.collector.handleEvent(event)

      if (event.type === 'agent_settled') {
        // Kick the background pre-compaction bake before the turn finalizes and
        // tears the session down. The controller lives in the per-agent registry,
        // so the bake survives removeSession. Skip during reset/compact.
        if (this.session.precompaction && !isTransitionalOperationInProgress(this.agent.id)) {
          this.session.precompaction.onSettled()
        }
        Promise.all([this.persistence.waitForAll(), this.storedSecretToolContainment.waitForAuditWrites()])
          .then(() => this.handleAgentEnd())
          .catch((err) => {
            log.error(`Failed to handle agent end for execution ${this.execution.id}:`, err)
            const errorMsg = err instanceof Error ? err.message : String(err)
            this.buffer.push({ type: 'error', message: errorMsg })
            this.buffer.fail()
            this.onError(errorMsg)
          })
      }
    })

    if (maintenanceLifecycle?.interruptRequested) {
      if (this.session.pi.isBashRunning) this.session.pi.abortBash()
      await this.session.pi.abort()
      removeSession(this.agent.id)
      await this.revokeAdmissionLease()
      return
    }
    await this.sendPromptInAgentSessionPhase()
  }

  private eventMakesTransportReplayUnsafe(event: AgentSessionEvent): boolean {
    if (
      event.type === 'message_update' ||
      event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_update' ||
      event.type === 'tool_execution_end'
    ) {
      return true
    }
    if (event.type !== 'message_end' && event.type !== 'session_message_persisted') return false
    const message = event.message as { role?: string; stopReason?: string } | undefined
    return message?.role !== 'user' && message?.stopReason !== 'error'
  }

  /**
   * Process settled agent run: save usage, check errors, check stop, then onComplete.
   */
  private async handleAgentEnd(): Promise<void> {
    if (!isSessionActive(this.agent.id)) return

    // Pi emits agent_settled before prompt() resolves, i.e. before the
    // agent-session write phase has finished. Settlement (and a failover
    // re-dispatch) needs that phase closed first; otherwise its own
    // beginWritePhase finds phase=agent-session still open and is refused with
    // the fence wide open.
    await this.agentSessionPhase
    // The phase may have closed by failing the run (lease lost); that path
    // already tore the session down and settled the row.
    if (!isSessionActive(this.agent.id)) return

    const maintenanceLifecycle = executionLifecycleRegistry.get(this.execution.id)
    if (maintenanceLifecycle?.interruptRequested) {
      await maintenanceLifecycle.runFallbackSettlement()
      return
    }

    const sessionUsage = this.captureUsage()
    // The agent row is the session-cumulative snapshot; the per-execution delta
    // belongs to the execution row (and the done event), not to the agent.
    this.agent.update({ sessionUsage: withoutDelta(sessionUsage) }).catch((err) => log.error('Error:', err))

    if (this.collector.lastError || this.collector.settledWithAssistantError) {
      const errorMsg = this.collector.lastError ?? 'Provider request settled with an assistant error'
      log.error(`Execution ${this.execution.id} (agent ${this.agent.id}) ended with SDK error: ${errorMsg}`)
      // Attempt runtime failover before surfacing the error. If failover
      // succeeds (switched to a healthy candidate and re-dispatched), there's
      // nothing more to do here. Wrap in try-catch so a failover failure
      // (e.g. setModel rejecting) falls through to the error-surfacing path.
      try {
        if (await this.attemptFailover(errorMsg)) return
      } catch (failoverErr) {
        if (failoverErr instanceof MaintenanceAdmissionPaused) {
          await maintenanceLifecycle?.runFallbackSettlement()
          return
        }
        log.error(`Failover failed for execution ${this.execution.id}:`, failoverErr)
      }
      const terminalError = durableProviderTransportFailureText(errorMsg) ?? errorMsg
      this.buffer.push({ type: 'error', message: terminalError })
      this.buffer.fail()
      // lastAssistant() is the last assistant row written THIS run, so its
      // presence is exactly "the model produced output before this failure".
      this.onError(terminalError, classifyTurnFailure(terminalError, this.persistence.lastAssistant() !== undefined))
      return
    }

    if (this.activeHealthAttempt) {
      try {
        providerHealth.recordSuccess(this.activeHealthAttempt)
      } catch (error) {
        log.error(`Failed to record provider success for execution ${this.execution.id}:`, error)
      }
    }

    const unsaved = this.collector.flush()
    if (unsaved) {
      log.warn(
        `Execution ${this.execution.id} settled with assistant content that was not confirmed persisted to the Pi session file; skipping DB save for unsynced content`
      )
    }
    const response = this.persistence.lastAssistant()?.response ?? ''
    const metadata = this.persistence.lastAssistant()?.metadata

    if (isWorkerShuttingDown()) {
      log.info(`Execution ${this.execution.id} settling during shutdown — skipping finalization, caller will re-queue`)
      return
    }

    // Check for transitional statuses and finalize only while the admission
    // fence still permits external settlement writes.
    try {
      await this.withAdmissionWritePhase(
        'settlement',
        `execution:${this.execution.id}:settlement`,
        async () => {
          if (await this.checkStop(response, metadata, sessionUsage)) return
          await this.onComplete(response, metadata, sessionUsage)
        },
        'settling'
      )
      maintenanceLifecycle?.settle()
    } catch (error) {
      if (error instanceof MaintenanceAdmissionPaused) {
        await maintenanceLifecycle?.runFallbackSettlement()
        return
      }
      // AdmissionLeaseLostError lands here too: the fence is open but this
      // owner's exact lease no longer authorizes settlement. Fail durably
      // (fenced by the lease, under the settling hold) so the row never sits
      // `running` and unheld for the abandoned-lease sweep to re-queue.
      log.error(`Failed to complete execution ${this.execution.id}:`, error)
      this.buffer.push({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
      this.buffer.fail()
      this.onError(error instanceof Error ? error.message : String(error), classifySettlementFailure(error))
    }
  }

  /**
   * Check for transitional stop status and handle it.
   * Returns true if handled (caller should skip onComplete).
   */
  private async checkStop(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<boolean> {
    await this.execution.reload()

    if (this.execution.status === 'stopping') {
      await this.handleStop(response, metadata, sessionUsage)
      return true
    }
    return false
  }

  /**
   * Check if execution is in a transitional state after compaction abort.
   * If so, trigger the appropriate handler to finalize the state.
   * This handles the case where stop was issued during compaction.
   */
  private async checkTransitionalStateAfterAbort(): Promise<void> {
    if (!isSessionActive(this.agent.id)) return

    await this.execution.reload()

    // Only handle transitional states
    if (this.execution.status !== 'stopping') return

    const sessionUsage = await this.persistence.persistSessionUsage('transitional abort')

    await this.persistence.markActiveToolAborted()

    const unsaved = this.collector.flush()
    if (unsaved) {
      log.warn(
        `Execution ${this.execution.id} ${this.execution.status} after abort with assistant content that was not confirmed persisted to the Pi session file; skipping DB save for unsynced content`
      )
    }
    const response = this.persistence.lastAssistant()?.response ?? ''
    const metadata = this.persistence.lastAssistant()?.metadata

    await this.handleStop(response, metadata, sessionUsage)
  }

  /**
   * Handle stop: mark stopped and cleanup. Assistant responses are saved only
   * after the Pi session file confirms persistence.
   *
   * Intentional stop semantics: stop and force-stop make the agent quiet. They
   * leave pending human rows and retry-eligible inbox rows preserved instead of
   * requeueing or retrying immediately. The next user message or inbox event
   * naturally wakes the agent and picks up preserved pending work.
   */
  protected async handleStop(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<void> {
    await this.persistence.markActiveToolAborted()
    response = this.persistence.lastAssistant()?.response ?? response
    metadata = this.persistence.lastAssistant()?.metadata ?? metadata

    this.interventionQueue.clear()
    removeSession(this.agent.id)
    await this.agent.recordMessage({
      role: 'assistant',
      content: '[System] Agent was stopped.',
    })
    this.buffer.push({
      type: 'done',
      response: response || '[System] Agent was stopped.',
      usage: sessionUsage,
      metadata,
      messageId: this.persistence.lastAssistant()?.messageId,
      streamGroupId: this.persistence.currentStreamGroupId,
      messageIds: this.persistence.currentTurnRowIds(),
    })
    this.buffer.close()
    await this.execution.stop(this.admissionLease ?? undefined)
    await this.onStopCleanup()
  }

  /** Override for context-specific cancel cleanup (e.g. close browser, block task) */
  protected async onStopCleanup(): Promise<void> {}

  /**
   * Save assistant message (if content), push `done` event, close buffer.
   * Returns the assistant message ID if one was saved.
   */
  protected async saveAndPushDone(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<string | undefined> {
    let assistantMessageId = this.persistence.lastAssistant()?.messageId
    if (!assistantMessageId && (response || metadata)) {
      const msg = await this.agent.recordMessage({
        role: 'assistant',
        content: response,
        metadata,
      })
      assistantMessageId = msg.id
    }

    if (assistantMessageId) this.persistence.recordTurnRowId(assistantMessageId)
    this.buffer.push({
      type: 'done',
      response,
      usage: sessionUsage,
      metadata,
      messageId: assistantMessageId,
      streamGroupId: this.persistence.currentStreamGroupId,
      messageIds: this.persistence.currentTurnRowIds(),
    })
    this.buffer.close()
    return assistantMessageId
  }

  /**
   * Shared normal completion: remove session, run turn hooks, save message,
   * push done, mark execution completed.
   *
   * If a hook returns 'halt', the agent enters the specified status (e.g. waiting-input)
   * instead of idle. Otherwise, agent becomes idle.
   *
   * Returns the assistant message ID if one was saved.
   */
  protected async completeNormally(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<string | undefined> {
    this.interventionQueue.clear()
    // Hold the execution as this process's work until its row leaves 'running'.
    // The session is torn down NOW, but the terminal transition happens only
    // after the turn hooks, the message save and the pending-message check
    // below (seconds to tens of seconds) — and the admission lease, renewed
    // only inside durable effects, has long expired. Without the hold that
    // window read as "running, unheld, lease expired" to the abandoned-lease
    // sweep, which re-queued live, finishing executions and posted a spurious
    // "[System] Agent recovered after a process restart." (observed live: 8 in
    // 10 minutes on one worker with no restart).
    markExecutionSettling(this.agent.id, this.execution.id)
    removeSession(this.agent.id)
    try {
      return await this.completeNormallyHeld(response, metadata, sessionUsage)
    } finally {
      clearExecutionSettling(this.agent.id, this.execution.id)
    }
  }

  private async completeNormallyHeld(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<string | undefined> {
    // Run turn completion hooks
    const hookCtx: TurnContext = {
      agentId: this.agent.id,
      executionId: this.execution.id,
      response,
      metadata,
      sessionUsage,
    }
    const hookResult = await turnHooks.run(hookCtx)

    // Save assistant message and push done event
    const messageId = await this.saveAndPushDone(response, metadata, sessionUsage)

    if (await this.requeueIfPendingMessagesRemain(sessionUsage)) return messageId

    if (hookResult.action === 'halt') {
      // Hook wants to halt — set agent to specified status instead of idle
      await this.execution.transitionTo(
        {
          kind: 'completed',
          usage: sessionUsage,
          agent: { status: hookResult.status, questionData: hookResult.updates?.questionData },
        },
        { admissionLease: this.admissionLease ?? undefined }
      )
    } else if (hookResult.action === 'restart') {
      // Hook wants to restart — complete this execution and queue a new one.
      // complete() is transitionTo({kind:'completed', usage}), whose default
      // agent disposition ({status:'idle'}) is exactly what this branch needs.
      await this.execution.complete(sessionUsage, this.admissionLease ?? undefined)
      // Queue new execution with the hook's message
      await this.agent.queueExecution({ message: hookResult.message })
    } else {
      // Normal completion — agent becomes idle
      await this.execution.complete(sessionUsage, this.admissionLease ?? undefined)
      await this.retryInboxDelivery('completeNormally')
      // Reset the auto-restart backoff: a successful turn means the agent is no
      // longer cycling on exhausted providers, so clear the persisted counters.
      await this.clearAutoRestartBackoff()
      await this.clearSandboxRestartBackoff()
    }

    return messageId
  }

  private async requeueIfPendingMessagesRemain(sessionUsage: SessionUsage): Promise<boolean> {
    const stranded = await this.agent.listPendingHumanMessages()
    if (stranded.length === 0) return false

    const retryBudgetExhausted = stranded.every(
      (message) => (message.metadata?.strandedPendingRetryCount ?? 0) >= STRANDED_PENDING_RETRY_BUDGET
    )
    if (retryBudgetExhausted) {
      log.error(
        `Execution ${this.execution.id} settled with ${stranded.length} pending human message(s) after ${STRANDED_PENDING_RETRY_BUDGET} retries; not re-queueing again.`
      )
      await this.agent.recordMessage({
        role: 'assistant',
        content:
          '[System] Pending message delivery could not be verified after retries; it will remain pending until the next message.',
        metadata: { isSystem: true },
      })
      return false
    }

    log.warn(`Execution ${this.execution.id} settled with ${stranded.length} pending human message(s); re-queueing.`)
    await this.agent.markPendingHumanMessagesStrandedRetry(stranded.map((message) => message.id))
    // complete() is transitionTo({kind:'completed', usage}); its default agent
    // disposition ({status:'idle'}) is exactly what this path needs.
    await this.execution.complete(sessionUsage, this.admissionLease ?? undefined)
    await this.agent.queueExecution({})
    return true
  }

  private async retryInboxDelivery(source: string): Promise<void> {
    try {
      const { deliverInboxMessagesToAgent } = await import('../../services/inbox/inboxDelivery')
      await deliverInboxMessagesToAgent(this.agent.id)
    } catch (err) {
      log.error(`Failed to retry inbox after ${source}:`, err)
    }
  }

  /**
   * Clear the persisted auto-restart backoff counters (`lastAutoRestartAt` /
   * `autoRestartCount`) from the agent's metadata. A write failure must never
   * break a successful turn. Only patches when the keys are present to avoid
   * needless DB writes on the normal path.
   */
  private async clearAutoRestartBackoff(): Promise<void> {
    const md = this.agent.metadata
    if (!md) return
    if (md.autoRestartCount == null && md.lastAutoRestartAt == null) return
    const { autoRestartCount: _c, lastAutoRestartAt: _t, ...rest } = md
    await this.agent.update({ metadata: rest }).catch(() => {})
  }

  /**
   * Clear sandbox-restart halt counters from metadata after a successful turn.
   * A successful completion means the sandbox is healthy enough for the agent
   * to make progress, so future sandbox deaths should get a fresh retry budget.
   */
  private async clearSandboxRestartBackoff(): Promise<void> {
    const md = this.agent.metadata
    if (!md) return
    if (md[META_COUNT] == null && md[META_LAST_AT] == null) return
    const { [META_COUNT]: _c, [META_LAST_AT]: _t, ...rest } = md
    await this.agent.update({ metadata: rest }).catch(() => {})
  }

  private buildInitialPromptText(messages: Message[]): string {
    return messages
      .map((message) => messageTextForModel(message).trim())
      .filter(Boolean)
      .join('\n\n')
  }

  private async loadPendingMessageImages(
    messages: Message[]
  ): Promise<{ imageIds: string[]; images?: ImageContent[] }> {
    const imageIds = [
      ...new Set(
        messages.flatMap((message) => {
          const ids = message.metadata?.imageIds
          return Array.isArray(ids) ? ids : []
        })
      ),
    ]
    const images = imageIds.length > 0 ? await Image.loadManyForAgent(imageIds, this.agent) : undefined
    return { imageIds, images }
  }

  private async tryConfirmInitialPromptMessage(
    content: string | undefined,
    identity: { executionId: string; streamGroupId: string }
  ): Promise<boolean> {
    const delivery = this.initialPromptDelivery
    if (!delivery || delivery.confirmed) return false

    const matchesPersistedPrompt = content === undefined || content === delivery.text
    if (!matchesPersistedPrompt) return false

    delivery.confirmed = true
    for (const messageId of delivery.messageIds) {
      await this.agent.confirmPendingMessage(messageId, identity)
    }
    await this.persistence.persistSessionUsage('initial prompt persisted')
    return true
  }

  /**
   * Claim pending human rows first, then use the claimed content as the initial
   * SDK prompt. The running-session drain is started only after prompt dispatch
   * begins so later pending rows use steer/follow-up without racing ahead of the
   * first prompt.
   */
  protected async sendPrompt(): Promise<void> {
    const claimed = await this.agent.claimInitialPendingMessagesForSessionDelivery()
    const text =
      claimed.length > 0 ? this.buildInitialPromptText(claimed) : this.execution.message?.trim() || 'Continue.'
    const { imageIds, images } = await this.loadPendingMessageImages(claimed)

    if (claimed.length > 0) {
      this.initialPromptDelivery = {
        text,
        messageIds: claimed.map((message) => message.id),
        confirmed: false,
      }
    }

    try {
      this.activeHealthAttempt = this.failover.captureActiveAttempt()
      const promptPromise = this.session.pi.prompt(text, { images })
      this.interventionQueue.start()
      await promptPromise
      if (imageIds.length > 0) {
        await Image.markManyUsed(imageIds).catch((err) => {
          log.error(`Failed to mark initial prompt images used for agent ${this.agent.id}:`, err)
        })
      }
      if (this._timing) logRunnerMilestone(this._timing, 'prompt-sent')
    } catch (err) {
      this.initialPromptDelivery = undefined
      for (const message of claimed) {
        await this.agent.resetPendingInterventionSessionDelivery(message.id)
      }
      if (imageIds.length > 0) await Image.markManyFailed(imageIds)
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error(`session.prompt() failed for execution ${this.execution.id}:`, err)
      // Attempt runtime failover before surfacing the error. Wrap in try-catch
      // so a failover failure (e.g. setModel rejecting) falls through to the
      // normal error-surfacing path instead of escaping sendPrompt.
      try {
        if (await this.attemptFailover(err)) return
      } catch (failoverErr) {
        log.error(`Failover failed for execution ${this.execution.id}:`, failoverErr)
      }
      const terminalError = durableProviderTransportFailureText(err) ?? errorMsg
      this.buffer.push({ type: 'error', message: terminalError })
      this.buffer.fail()
      // lastAssistant() is the last assistant row written THIS run, so its
      // presence is exactly "the model produced output before this failure".
      this.onError(terminalError, classifyTurnFailure(err, this.persistence.lastAssistant() !== undefined))
    }
  }
}

/** Read pi manifest from package.json. Returns pi.extensions etc. if present. */
function readPiManifest(packageJsonPath: string): { extensions?: string[] } | null {
  try {
    const content = readFileSync(packageJsonPath, 'utf-8')
    const pkg = JSON.parse(content) as { pi?: { extensions?: string[] } }
    return pkg.pi && typeof pkg.pi === 'object' ? pkg.pi : null
  } catch {
    return null
  }
}

/** Resolve extension entry points from a directory (package.json pi.extensions or index.ts/js). */
function resolveExtensionEntries(dirPath: string): string[] | null {
  if (!existsSync(dirPath)) return null
  const packageJsonPath = join(dirPath, 'package.json')
  if (existsSync(packageJsonPath)) {
    const manifest = readPiManifest(packageJsonPath)
    if (manifest?.extensions?.length) {
      const entries: string[] = []
      for (const extPath of manifest.extensions) {
        const resolved = resolve(dirPath, extPath)
        if (existsSync(resolved)) entries.push(resolved)
      }
      if (entries.length > 0) return entries
    }
  }
  const indexTs = join(dirPath, 'index.ts')
  const indexJs = join(dirPath, 'index.js')
  if (existsSync(indexTs)) return [indexTs]
  if (existsSync(indexJs)) return [indexJs]
  return null
}
