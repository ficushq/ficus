import { firstPartyIntegrationPlugin } from '../first-party-plugins'
import { regenerateEnvFileForSquad } from '../../squad/env'
import { getSecretStore } from '../../secrets'
import { fingerprintToolchain } from '../../sandbox/toolchain/config'
import { readToolchainReconcileSnapshot } from '../../sandbox/toolchain/state'
import type { IntegrationAssignmentRepository, IntegrationConnectionRepository } from '../connection-repository'
import { parseOAuthCredential } from '../authorization/credential-bundle'
import type { ClaimedIntegrationProjection } from './state-repository'
import type { ISandboxManager, SandboxOptions } from '../../sandbox/types'
import { ensureSandboxToolchain } from '../../sandbox/toolchain/provision'
import { isLiveAgentStatus } from '@ficus/shared'
import { findAgentLifecycleState } from '../../../entities/agent-queries'
import { createLogger } from '../../../lib/infra/logger'

export type AgentProjectionLifecycleFence = {
  agentId: string
  generation: string | undefined
  compareGeneration: boolean
}

export type IntegrationProjectionTarget = {
  sandboxId: string
  options: SandboxOptions
  lifecycleFence?: AgentProjectionLifecycleFence
}

async function agentProjectionLifecycleIsCurrent(fence: AgentProjectionLifecycleFence): Promise<boolean> {
  const agent = await findAgentLifecycleState(fence.agentId)
  if (!agent || !isLiveAgentStatus(agent.status)) return false
  if (!fence.compareGeneration) return true
  const generation = (agent.metadata as Record<string, unknown> | null)?.resourceGeneration
  return (typeof generation === 'string' ? generation : undefined) === fence.generation
}

const log = createLogger('integration-projection')

async function cleanupLostAgentProjection(
  manager: ISandboxManager,
  sandboxId: string,
  fence: AgentProjectionLifecycleFence
): Promise<void> {
  if (!fence.compareGeneration) return
  const outcome = await manager.stopSandbox(sandboxId, { lifecycleGeneration: fence.generation ?? null })
  if (outcome.kind === 'unverified') {
    log.warn(`Projection cleanup stop remains unverified for ${sandboxId}`)
  }
  // generation-mismatch intentionally preserves the successor lifecycle; the
  // manager already logs the requested/actual fence pair.
}

export class IntegrationProjectionFailure extends Error {
  constructor(readonly code: 'protected_env_write_failed' | 'toolchain_readiness_failed' | 'agent_lifecycle_changed') {
    super(code)
    this.name = 'IntegrationProjectionFailure'
  }
}

export interface IntegrationProjectionReconcilerDependencies {
  connections: Pick<IntegrationConnectionRepository, 'get'> & Pick<IntegrationAssignmentRepository, 'getAssigned'>
  regenerateEnv?(squadId: string): Promise<void>
  manager?: ISandboxManager
  targets?(squadId: string): Promise<readonly IntegrationProjectionTarget[]>
  targetLifecycleIsCurrent?(fence: AgentProjectionLifecycleFence): Promise<boolean>
  cleanupLostTarget?(manager: ISandboxManager, sandboxId: string, fence: AgentProjectionLifecycleFence): Promise<void>
  refreshAttached?(manager: ISandboxManager, sandboxId: string, options: SandboxOptions): Promise<void>
  desiredFingerprint?(squadId: string): Promise<string>
  reconcileToolchain?(
    manager: ISandboxManager,
    sandboxId: string,
    options: SandboxOptions,
    squadId: string
  ): Promise<unknown>
}

export class IntegrationProjectionReconciler {
  readonly #dependencies: IntegrationProjectionReconcilerDependencies

  constructor(dependencies: IntegrationProjectionReconcilerDependencies) {
    this.#dependencies = dependencies
  }

  async reconcile(claim: ClaimedIntegrationProjection): Promise<{
    fingerprint: string
    credentialRevision: bigint | null
  }> {
    try {
      await (this.#dependencies.regenerateEnv ?? regenerateEnvFileForSquad)(claim.squadId)
    } catch {
      throw new IntegrationProjectionFailure('protected_env_write_failed')
    }
    if (this.#dependencies.manager && this.#dependencies.targets) {
      const seen = new Set<string>()
      for (const target of await this.#dependencies.targets(claim.squadId)) {
        if (seen.has(target.sandboxId)) continue
        seen.add(target.sandboxId)
        const lifecycleIsCurrent = this.#dependencies.targetLifecycleIsCurrent ?? agentProjectionLifecycleIsCurrent
        if (target.lifecycleFence && !(await lifecycleIsCurrent(target.lifecycleFence))) {
          throw new IntegrationProjectionFailure('agent_lifecycle_changed')
        }
        let attached = false
        let effectFailed = false
        try {
          attached =
            (await this.#dependencies.manager.attachExistingSandbox?.(target.sandboxId, target.options)) ?? false
          if (attached) {
            await this.#dependencies.refreshAttached?.(this.#dependencies.manager, target.sandboxId, target.options)
            await (this.#dependencies.reconcileToolchain ?? ensureSandboxToolchain)(
              this.#dependencies.manager,
              target.sandboxId,
              target.options,
              claim.squadId
            )
          }
        } catch {
          effectFailed = true
        }
        if (target.lifecycleFence && !(await lifecycleIsCurrent(target.lifecycleFence))) {
          await (this.#dependencies.cleanupLostTarget ?? cleanupLostAgentProjection)(
            this.#dependencies.manager,
            target.sandboxId,
            target.lifecycleFence
          )
          throw new IntegrationProjectionFailure('agent_lifecycle_changed')
        }
        if (effectFailed) throw new IntegrationProjectionFailure('toolchain_readiness_failed')
        if (!attached) continue
      }
    }
    const fingerprint = this.#dependencies.desiredFingerprint
      ? await this.#dependencies.desiredFingerprint(claim.squadId)
      : await desiredFingerprint(claim.squadId)
    const assigned = await this.#dependencies.connections.getAssigned(claim.squadId, claim.providerKey)
    if (!assigned) return { fingerprint, credentialRevision: null }
    const raw = getSecretStore().get(assigned.credentialRef)
    if (!raw || firstPartyIntegrationPlugin(claim.providerKey)?.authorization.kind !== 'oauth2')
      return { fingerprint, credentialRevision: null }
    try {
      return { fingerprint, credentialRevision: BigInt(parseOAuthCredential(raw).tokenRevision) }
    } catch {
      throw new Error('projection_credential_unavailable')
    }
  }
}

async function desiredFingerprint(squadId: string): Promise<string> {
  const snapshot = await readToolchainReconcileSnapshot(squadId, `squad_${squadId}`)
  return snapshot.config ? fingerprintToolchain(snapshot.config) : '0'.repeat(64)
}
