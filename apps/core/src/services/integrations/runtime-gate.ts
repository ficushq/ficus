import type { AgentTypeIntegrationPolicyV1, IntegrationCapability } from '@ficus/shared'
import type { AssignedConnectionResolver, AssignedIntegrationConnectionRecord } from './connection-repository'
import type { IntegrationProjectionTarget } from './projection/reconciler'
import type { SandboxOptions } from '../sandbox/types'

export type RuntimeGateDenialCode =
  | 'agent_scope_mismatch'
  | 'capability_not_allowed'
  | 'connection_unavailable'
  | 'connection_ambiguous'
  | 'connection_disabled'
  | 'authentication_invalid'
  | 'authority_mismatch'
  | 'health_uncertain'
  | 'validation_stale'
  | 'revision_mismatch'
  | 'scope_missing'
  | 'unsupported_version'

export type RuntimeGateDecision =
  | { allowed: true; connection: AssignedIntegrationConnectionRecord }
  | { allowed: false; code: RuntimeGateDenialCode }

export interface RuntimeGateAgent {
  id: string
  squadId: string | null
  integrationCapabilities: AgentTypeIntegrationPolicyV1 | null
}

export interface RuntimeGateDependencies {
  repository: AssignedConnectionResolver
  now?: () => Date
  currentAuthority(provider: string): 'local' | 'platform_broker' | undefined
  supportedAdapterVersion(provider: string): number | undefined
  supportedConfigVersion(provider: string): number | undefined
}

export function withLazyProjectionManager<T extends object, M>(
  dependencies: T,
  resolve: () => M
): T & { readonly manager: M } {
  return Object.defineProperty(dependencies, 'manager', {
    enumerable: true,
    configurable: false,
    get: resolve,
  }) as T & { readonly manager: M }
}

export async function buildAgentProjectionTargets(input: {
  agents: readonly { id: string; machineId?: string | null; getSandboxId(): Promise<string> }[]
  resolveLifecycleGeneration(sandboxId: string): Promise<string | undefined>
  optionsForAgent(agent: { machineId?: string | null }, sandboxId: string): SandboxOptions
}): Promise<IntegrationProjectionTarget[]> {
  return Promise.all(
    input.agents.map(async (agent) => {
      const sandboxId = await agent.getSandboxId()
      const lifecycleGeneration = await input.resolveLifecycleGeneration(sandboxId)
      return {
        sandboxId,
        lifecycleFence: {
          agentId: agent.id,
          generation: lifecycleGeneration,
          compareGeneration: sandboxId.startsWith('agent_'),
        },
        options: { ...input.optionsForAgent(agent, sandboxId), lifecycleGeneration },
      }
    })
  )
}

export class IntegrationRuntimeGate {
  readonly #dependencies: RuntimeGateDependencies

  constructor(dependencies: RuntimeGateDependencies) {
    this.#dependencies = { ...dependencies, now: dependencies.now ?? (() => new Date()) }
  }

  async check(input: {
    agent: RuntimeGateAgent
    squadId: string
    provider: string
    capability: IntegrationCapability
    requiredScope?: string
  }): Promise<RuntimeGateDecision> {
    if (!input.agent.squadId || input.agent.squadId !== input.squadId) {
      return denied('agent_scope_mismatch')
    }
    const policy = input.agent.integrationCapabilities
    if (policy?.version !== 1 || !policy.allow[input.provider]?.includes(input.capability)) {
      return denied('capability_not_allowed')
    }
    const connection = await this.#dependencies.repository.getAssigned(input.squadId, input.provider)
    if (!connection) return denied('connection_unavailable')
    if (!connection.enabled) return denied('connection_disabled')
    const currentAuthority = this.#dependencies.currentAuthority(input.provider)
    if (currentAuthority && connection.clientAuthority !== currentAuthority) {
      return denied('authority_mismatch')
    }
    if (
      this.#dependencies.supportedAdapterVersion(input.provider) !== connection.adapterVersion ||
      this.#dependencies.supportedConfigVersion(input.provider) !== configVersion(connection.configuration)
    ) {
      return denied('unsupported_version')
    }
    if (connection.authState !== 'authenticated') return denied('authentication_invalid')
    if (connection.healthState !== 'healthy') return denied('health_uncertain')
    if (connection.validatedRevision !== connection.materialRevision) return denied('revision_mismatch')
    if (!connection.validationExpiresAt || connection.validationExpiresAt <= this.#dependencies.now!()) {
      return denied('validation_stale')
    }
    if (input.requiredScope && !connection.grantedScopes.includes(input.requiredScope)) {
      return denied('scope_missing')
    }
    return { allowed: true, connection }
  }
}

function configVersion(configuration: unknown): number | undefined {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return undefined
  const version = (configuration as Record<string, unknown>).version
  return typeof version === 'number' ? version : undefined
}

function denied(code: RuntimeGateDenialCode): RuntimeGateDecision {
  return { allowed: false, code }
}
