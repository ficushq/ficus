import type { SandboxToolchainConfig } from '@ficus/shared'
import type { PublicIntegrationDeclaration } from './types'

export interface EffectiveToolchain {
  config: SandboxToolchainConfig
  initHooks: readonly string[]
  readiness: readonly { id: string; command: string; expectedSubstring: string }[]
}

export function resolveEffectiveToolchain(
  squadConfig: SandboxToolchainConfig | undefined,
  integrations: PublicIntegrationDeclaration
): EffectiveToolchain {
  const packages = [...new Set([...(squadConfig?.packages ?? []), ...integrations.packages])].sort()
  const setupParts = [squadConfig?.setupScript, ...integrations.setupSteps.map((step) => step.script)].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
  return {
    config: {
      packages,
      ...(setupParts.length > 0 ? { setupScript: setupParts.join('\n') } : {}),
    },
    initHooks: [...new Set(integrations.initHooks)].sort(),
    readiness: [...integrations.readiness].sort((left, right) => left.id.localeCompare(right.id)),
  }
}
