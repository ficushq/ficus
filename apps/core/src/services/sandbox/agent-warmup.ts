import { isUserAssistantAgentType } from '@ficus/shared'
import { consultantSandboxSquadId } from './consultant-sandbox'
import { isLiveAgentStatus, WORK_STREAM_ADMITTED_STATUSES } from '@ficus/shared'
import type { Agent } from '../../entities/Agent'
import { findAgentLifecycleState } from '../../entities/agent-queries'
import { maintenanceStore } from '../maintenance/store'
import type { BoxLivenessHintResolver } from './types'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('agent-warmup')

export type EnsureAgentSandboxResult =
  | 'ensured'
  | 'skipped-subagent'
  | 'skipped-squad-inactive'
  | 'skipped-maintenance'
  | 'skipped-work-stream-queued'
  | 'skipped-agent-unavailable'

type WarmupLifecycleOwner = Pick<Agent, 'status' | 'metadata'>
type WarmupLifecycleFence = { generation: string | undefined }

let agentWarmupLifecycleLoader: ((agentId: string) => Promise<WarmupLifecycleOwner | null>) | undefined
export function setAgentWarmupLifecycleLoaderForTest(
  loader: ((agentId: string) => Promise<WarmupLifecycleOwner | null>) | undefined
): void {
  agentWarmupLifecycleLoader = loader
}

async function loadWarmupLifecycleOwner(agentId: string): Promise<WarmupLifecycleOwner | null> {
  if (agentWarmupLifecycleLoader) return agentWarmupLifecycleLoader(agentId)
  return findAgentLifecycleState(agentId)
}

function resourceGeneration(owner: WarmupLifecycleOwner): string | undefined {
  const generation = (owner.metadata as Record<string, unknown> | null)?.resourceGeneration
  return typeof generation === 'string' ? generation : undefined
}

async function captureWarmupLifecycleFence(agentId: string): Promise<WarmupLifecycleFence | null> {
  const owner = await loadWarmupLifecycleOwner(agentId)
  return owner && isLiveAgentStatus(owner.status) ? { generation: resourceGeneration(owner) } : null
}

async function warmupLifecycleFenceIsCurrent(
  agentId: string,
  fence: WarmupLifecycleFence,
  compareGeneration: boolean
): Promise<boolean> {
  const owner = await loadWarmupLifecycleOwner(agentId)
  return Boolean(
    owner && isLiveAgentStatus(owner.status) && (!compareGeneration || resourceGeneration(owner) === fence.generation)
  )
}

async function cleanupLostWarmupGeneration(sandboxId: string, generation: string | undefined): Promise<void> {
  const { getSandboxManager } = await import('./factory')
  const outcome = await getSandboxManager().stopSandbox(sandboxId, { lifecycleGeneration: generation ?? null })
  if (outcome.kind === 'unverified') log.warn(`Lost warmup generation stop remains unverified for ${sandboxId}`)
  // A mismatch is the desired successor-preserving outcome after a concurrent wake.
}

/**
 * Ensure an agent's personal sandbox is up (recreating a halted/idle-killed pod),
 * with the same skills + squad-pod handling the runners use. Single source of
 * truth for "warm this agent's box": used by the resume sweep, the work-stream
 * warmup pass, and the spawn/assignment event handlers.
 *
 * - Subagents share the parent's box → no-op ('skipped-subagent').
 * - Squad agents whose squad isn't active → no-op ('skipped-squad-inactive').
 *
 * Imports are dynamic to avoid an entity ⇆ sandbox import cycle and to keep the
 * existing resume.ts test spies (which patch the ./ensure module) working.
 */
export async function ensureAgentSandbox(
  agent: Agent,
  options: {
    /**
     * vm runtime: resolves this agent's box liveness from what the caller
     * already observed (the lifecycle tick's per-machine `ss -ltnH`). Taken as
     * a RESOLVER rather than a value because the sandboxId is derived here —
     * an agent's box may be its own `agent_<id>` or a shared
     * `system_manager_<user>` one — and only this function knows which.
     */
    resolveBoxLiveness?: BoxLivenessHintResolver
  } = {}
): Promise<EnsureAgentSandboxResult> {
  if (maintenanceStore.isPausedCached()) return 'skipped-maintenance'
  if (agent.parentAgentId != null) return 'skipped-subagent'
  const lifecycleFence = await captureWarmupLifecycleFence(agent.id)
  if (!lifecycleFence) return 'skipped-agent-unavailable'

  // Concurrency-cap sandbox gate: an agent bound to work streams gets a
  // proactively-started/kept-warm box only while at least one of those
  // streams is ADMITTED. All-queued crews stay cold (files stay in place; the
  // execution runner's lazy ensure still cold-starts on a direct turn, which
  // is the documented resume path after re-admission). Agents with no work
  // streams at all (managers, solo agents) are untouched — and under cap null
  // queued streams don't exist, so this is a no-op there.
  // Fail-open: a gate-read failure must never block a legitimate warmup (the
  // idle reaper + keepalive predicate still collect anything mis-warmed).
  try {
    const { WorkStream } = await import('../../entities/WorkStream')
    const streams = await WorkStream.listForAgent(agent.id, [...WORK_STREAM_ADMITTED_STATUSES, 'queued'])
    if (streams.length > 0 && streams.every((ws) => ws.status === 'queued')) {
      return 'skipped-work-stream-queued'
    }
  } catch {
    // tolerate — see fail-open note above
  }

  const sandboxId = await agent.getSandboxId()
  // system_manager_<user> boxes are shared and intentionally unstamped: one
  // agent row's generation must never fence or tear down the shared resource.
  const compareLifecycleGeneration = sandboxId.startsWith('agent_')
  const boxLiveness = options.resolveBoxLiveness?.(sandboxId)
  const { ensureWorkspaceSandbox, ensureSquadSandbox } = await import('./ensure')
  const { materializeSandboxSkills } = await import('../agent/skill-materializer')

  if (agent.squadId) {
    const { getSquadAgentTypeSkills } = await import('../../entities/agent-runners/base')
    const { Squad } = await import('../../entities/Squad')

    const squad = await Squad.find(agent.squadId)
    if (!squad || squad.status !== 'active') return 'skipped-squad-inactive'

    const agentType = await agent.getAgentType()
    const { mergeAgentRefs, resolveAssignedIntegrationRefs } = await import('../integrations/projection/agent-refs')
    const integrationRefs = await resolveAssignedIntegrationRefs(squad.id)
    const uniqueRefs = mergeAgentRefs(
      agentType?.skills,
      getSquadAgentTypeSkills(squad.metadata, agent.agentTypeId),
      integrationRefs.skills
    )
    // Materialize skill content onto the host BEFORE ensure: every runtime
    // delivers the materialized tree per the sandbox asset manifest (docker
    // bind-mounts it; ensure no longer takes per-skill paths).
    await materializeSandboxSkills(sandboxId, uniqueRefs)

    // The squad pod and the agent's own light box have no ordering dependency: the
    // agent box only needs the shared squad workspace *directory*, which
    // ensureWorkspaceSandbox creates itself (via ensureSquadWorkspace) — it does not
    // consume the squad *pod* being Ready. Kick off the squad pod without awaiting it
    // so the first agent in a cold squad doesn't wait out the squad pod's cold start.
    // The squad's OWN box gets its own hint: without it, every work-stream
    // warmup that touches a squad member would HTTP-probe (and so wake) the
    // squad box once a tick, which is exactly the wake-up the hint exists to
    // prevent.
    if (!(await warmupLifecycleFenceIsCurrent(agent.id, lifecycleFence, compareLifecycleGeneration)))
      return 'skipped-agent-unavailable'
    const squadReady = ensureSquadSandbox(squad, {
      boxLiveness: options.resolveBoxLiveness?.(Squad.getSandboxId(squad.id)),
    })
    // Mark the squad promise handled so a squad-pod failure never surfaces as an
    // unhandled rejection when the agent-box chain below throws first (we still
    // re-await squadReady at the end, which re-observes and propagates the error).
    squadReady.catch(() => {})
    // The agent box, and its identity, only depend on each other — never on the
    // squad pod — so run that chain concurrently with the squad pod bring-up.
    // Identity must be generated on the host BEFORE ensureWorkspaceSandbox: its
    // manifest sync (the vm push transport in particular) snapshots /private's
    // current contents, so generating identity.pem after would risk missing
    // the first sync. NOTE: ensureWorkspaceSandbox (services/sandbox/ensure.ts)
    // now generates identity itself unconditionally, before its own manifest
    // work, for every caller — not just this warmup path (that was #788's root
    // cause: identity was only ever generated here, and plain per-turn
    // execution never goes through this module). This explicit call is
    // consequently redundant with that internal generation (both are
    // idempotent, so no harm double-calling), but is kept for defense in depth
    // and because it's the one path this module's own tests can assert
    // ordering against. System-managers share one sandbox + /private per user;
    // skip federation identity (same guard as the non-squad branch below, so
    // the invariant holds regardless of squadId).
    if (!isUserAssistantAgentType(agent.agentTypeId) && !consultantSandboxSquadId(sandboxId)) {
      const { ensureAgentIdentity } = await import('../amtp/agent-identity')
      await ensureAgentIdentity(agent, sandboxId)
    }
    let ensuredGeneration = lifecycleFence.generation
    await ensureWorkspaceSandbox({
      sandboxId,
      workspaceId: sandboxId,
      squadId: squad.id,
      onLifecycleGenerationResolved: (generation) => (ensuredGeneration = generation),
      // vm runtime: honor an explicit machine pin on the agent's own light box
      // (explicit pin wins over squad-per-VM placement). Ignored by k8s/docker.
      machineId: consultantSandboxSquadId(sandboxId) ? undefined : (agent.machineId ?? undefined),
      boxLiveness,
    })
    if (
      !(await warmupLifecycleFenceIsCurrent(agent.id, { generation: ensuredGeneration }, compareLifecycleGeneration))
    ) {
      if (compareLifecycleGeneration) await cleanupLostWarmupGeneration(sandboxId, ensuredGeneration)
      return 'skipped-agent-unavailable'
    }
    // Still surface squad-pod failures and only report 'ensured' once it's actually up.
    await squadReady
    return 'ensured'
  }

  const agentType = await agent.getAgentType()
  const { mergeAgentRefs } = await import('../integrations/projection/agent-refs')
  const uniqueRefs = mergeAgentRefs(agentType?.skills)
  // Materialize skill content onto the host BEFORE ensure (see squad branch).
  await materializeSandboxSkills(sandboxId, uniqueRefs)

  // Identity before the box (see squad branch above for why the order and the
  // redundancy with ensure.ts's own generation are both intentional).
  // System-managers share one sandbox + /private per user, so their identity
  // key is not unique per agent row. Skip federation identity for them.
  if (!isUserAssistantAgentType(agent.agentTypeId) && !consultantSandboxSquadId(sandboxId)) {
    const { ensureAgentIdentity } = await import('../amtp/agent-identity')
    await ensureAgentIdentity(agent, sandboxId)
  }
  if (!(await warmupLifecycleFenceIsCurrent(agent.id, lifecycleFence, compareLifecycleGeneration)))
    return 'skipped-agent-unavailable'
  let ensuredGeneration = lifecycleFence.generation
  await ensureWorkspaceSandbox({
    sandboxId,
    workspaceId: sandboxId,
    onLifecycleGenerationResolved: (generation) => (ensuredGeneration = generation),
    // vm runtime: honor an explicit machine pin on the solo agent's box.
    machineId: consultantSandboxSquadId(sandboxId) ? undefined : (agent.machineId ?? undefined),
    boxLiveness,
  })
  if (!(await warmupLifecycleFenceIsCurrent(agent.id, { generation: ensuredGeneration }, compareLifecycleGeneration))) {
    if (compareLifecycleGeneration) await cleanupLostWarmupGeneration(sandboxId, ensuredGeneration)
    return 'skipped-agent-unavailable'
  }
  return 'ensured'
}
