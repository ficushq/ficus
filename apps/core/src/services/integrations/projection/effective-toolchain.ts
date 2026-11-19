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
  const setupParts = [squadConfig?.setupScript, integrationSetupScript(integrations.setupSteps)].filter(
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

const FAILED = 'ficus_integration_setup_failed'

/**
 * Append integration setup steps to setup.sh so each one fails closed on its own without
 * skipping the others, and any failure fails the whole script.
 *
 * setup.sh runs as plain `bash setup.sh`, and the squad-owned script before these steps
 * decides its own shell options, so nothing here may rely on `set -e` at the top level.
 * Each step therefore runs in its own `set -eu` subshell: a failed integrity check stops
 * that step before it installs anything, whatever the step itself does. The subshell's
 * status is read on the next line rather than with `||` or `if`, because bash ignores
 * `set -e` inside any command whose status is being tested, which would let a step
 * continue past a failed check. Later steps still run, so one broken integration does
 * not leave the others uninstalled, and the script ends with a non-zero status naming
 * the failed steps, which the toolchain adapters report as `setup_failed` before
 * readiness and before the sandbox is marked ready.
 *
 * If the squad script enables `set -e` itself, the first failed step ends setup.sh
 * immediately instead; that still fails closed.
 */
function integrationSetupScript(steps: PublicIntegrationDeclaration['setupSteps']): string | undefined {
  if (steps.length === 0) return undefined
  const lines = [`${FAILED}=0`]
  for (const step of steps) {
    lines.push(
      '(',
      'set -eu',
      step.script,
      ')',
      'if [ "$?" -ne 0 ]; then',
      `  echo ${shellQuote(`Integration setup step ${step.id} failed`)} >&2`,
      `  ${FAILED}=1`,
      'fi'
    )
  }
  lines.push(`if [ "$${FAILED}" -ne 0 ]; then exit 1; fi`)
  return lines.join('\n')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
