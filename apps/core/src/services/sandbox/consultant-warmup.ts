import { Squad } from '../../entities/Squad'
import { AgentType } from '../../entities/AgentType'
import { getSquadAgentTypeSkills } from '../../entities/agent-runners/base'
import { mergeAgentRefs, resolveAssignedIntegrationRefs } from '../integrations/projection/agent-refs'
import { materializeSandboxSkills } from '../agent/skill-materializer'
import { ensureWorkspaceSandbox } from './ensure'
import { consultantSandboxId } from './consultant-sandbox'
import { maybePruneConsultantScratch } from './consultant-scratch'
import { maintenanceStore } from '../maintenance/store'
import type { BoxLivenessHintResolver } from './types'

/**
 * Prepare one light consultant runtime before the next conversation exists,
 * then (throttled) archive the scratch of consultants that were finally
 * terminated or deleted while the runtime is known to be up.
 */
export async function ensureConsultantSandbox(
  squad: Squad | string,
  resolveBoxLiveness?: BoxLivenessHintResolver,
  deps: { pruneScratch?: (squadId: string) => Promise<unknown> } = {}
): Promise<void> {
  if (maintenanceStore.isPausedCached()) return
  const owner = typeof squad === 'string' ? await Squad.find(squad) : squad
  if (!owner || owner.status !== 'active') return
  const type = await AgentType.find('consultant')
  if (!type) return
  const sandboxId = consultantSandboxId(owner.id)
  const integrations = await resolveAssignedIntegrationRefs(owner.id)
  await materializeSandboxSkills(
    sandboxId,
    mergeAgentRefs(type.skills, getSquadAgentTypeSkills(owner.metadata, 'consultant'), integrations.skills)
  )
  await ensureWorkspaceSandbox({
    sandboxId,
    workspaceId: sandboxId,
    squadId: owner.id,
    boxLiveness: resolveBoxLiveness?.(sandboxId),
  })
  // Not awaited: warmup and recovery must not wait on archive I/O. It never throws.
  void (deps.pruneScratch ?? maybePruneConsultantScratch)(owner.id)
}
