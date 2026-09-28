import { createHash } from 'crypto'
import type { SandboxToolchainConfig } from '@ficus/shared'

const MANAGED_DEVBOX_SCHEMA = 'https://raw.githubusercontent.com/jetify-com/devbox/0.14.0/.schema/devbox.schema.json'

export interface ManagedToolchainConfig extends SandboxToolchainConfig {
  initHooks?: readonly string[]
  readiness?: readonly { id: string; command: string; expectedSubstring: string }[]
  integrationFingerprint?: string
}

/** Returns the canonical form used for fingerprints and managed Devbox files. */
export function normalizeToolchain(config: ManagedToolchainConfig): ManagedToolchainConfig {
  return {
    packages: [...new Set(config.packages.map((packageSpec) => packageSpec.trim()))].sort(),
    ...(config.setupScript === undefined ? {} : { setupScript: config.setupScript }),
    ...(config.initHooks === undefined ? {} : { initHooks: [...new Set(config.initHooks)].sort() }),
    ...(config.readiness === undefined
      ? {}
      : { readiness: [...config.readiness].sort((left, right) => left.id.localeCompare(right.id)) }),
    ...(config.integrationFingerprint === undefined ? {} : { integrationFingerprint: config.integrationFingerprint }),
  }
}

/** True when no managed environment needs to be present in the sandbox. */
export function isEmptyToolchain(config: ManagedToolchainConfig | undefined): boolean {
  return (
    !config ||
    (config.packages.length === 0 &&
      !config.setupScript &&
      (config.initHooks?.length ?? 0) === 0 &&
      (config.readiness?.length ?? 0) === 0)
  )
}

/** A stable identifier for the complete managed-toolchain declaration. */
export function fingerprintToolchain(config: ManagedToolchainConfig): string {
  const normalized = normalizeToolchain(config)
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 2,
        packages: normalized.packages,
        setupScript: normalized.setupScript ?? null,
        initHooks: normalized.initHooks ?? [],
        readiness: normalized.readiness ?? [],
        integrationFingerprint: normalized.integrationFingerprint ?? null,
      })
    )
    .digest('hex')
}

/** The isolated Devbox configuration Ficus writes without touching project files. */
export function renderManagedDevbox(config: ManagedToolchainConfig): string {
  const normalized = normalizeToolchain(config)
  return `${JSON.stringify(
    {
      $schema: MANAGED_DEVBOX_SCHEMA,
      packages: normalized.packages,
      shell: { init_hook: normalized.initHooks ?? [], scripts: {} },
    },
    null,
    2
  )}\n`
}
