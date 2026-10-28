import { createHash } from 'node:crypto'
import type { IntegrationProjection, IntegrationProjectionInput, PublicIntegrationDeclaration } from './types'

export function projectIntegrationAssignments(inputs: readonly IntegrationProjectionInput[]): IntegrationProjection {
  const sorted = [...inputs].sort(
    (left, right) =>
      left.plugin.key.localeCompare(right.plugin.key) || left.connection.id.localeCompare(right.connection.id)
  )
  const packages = new Set<string>()
  const setupSteps = new Map<string, string>()
  const initHooks = new Set<string>()
  const readiness = new Map<string, { id: string; command: string; expectedSubstring: string }>()
  const skills = new Set<string>()
  const extensions = new Set<string>()
  const bindingSources = new Map<string, string>()
  const bindings = new Map<string, () => Promise<string>>()

  for (const { plugin, connection } of sorted) {
    for (const packageSpec of plugin.sandbox.packages) packages.add(packageSpec)
    for (const step of plugin.sandbox.setupSteps) {
      const existing = setupSteps.get(step.id)
      if (existing !== undefined && existing !== step.script) throw new Error('setup_step_conflict')
      setupSteps.set(step.id, step.script)
    }
    for (const hook of plugin.sandbox.initHooks) initHooks.add(hook)
    for (const check of plugin.sandbox.readiness) {
      const existing = readiness.get(check.id)
      if (existing && JSON.stringify(existing) !== JSON.stringify(check)) throw new Error('readiness_conflict')
      readiness.set(check.id, { ...check })
    }
    for (const skill of plugin.sandbox.skills) skills.add(skill)
    for (const extension of plugin.sandbox.extensions) extensions.add(extension)
    for (const binding of plugin.sandbox.protectedBindings) {
      const sourceIdentity = JSON.stringify(binding.source)
      const existing = bindingSources.get(binding.name)
      if (existing !== undefined) throw new Error('protected_binding_conflict')
      bindingSources.set(binding.name, sourceIdentity)
      bindings.set(binding.name, createBindingResolver(binding.source, plugin, connection))
    }
  }

  const publicDeclaration: PublicIntegrationDeclaration = {
    packages: sortedValues(packages),
    setupSteps: [...setupSteps]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, script]) => ({ id, script })),
    initHooks: sortedValues(initHooks),
    readiness: [...readiness.values()].sort((left, right) => left.id.localeCompare(right.id)),
    skills: sortedValues(skills),
    extensions: sortedValues(extensions),
    protectedBindingNames: [...bindingSources.keys()].sort(),
  }
  const versions = sorted.map(({ plugin }) => ({
    key: plugin.key,
    manifestVersion: plugin.manifestVersion,
    adapterVersion: plugin.adapterVersion,
  }))
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ version: 1, plugins: versions, declaration: publicDeclaration }))
    .digest('hex')
  return { publicDeclaration, privateMaterial: { bindings }, fingerprint }
}

function createBindingResolver(
  source: { kind: 'configuration'; field: string },
  plugin: IntegrationProjectionInput['plugin'],
  connection: IntegrationProjectionInput['connection']
): () => Promise<string> {
  return async () => {
    const configuration = plugin.connection.parseConfiguration(connection.configuration) as Record<string, unknown>
    const value = configuration[source.field]
    if (typeof value !== 'string') throw new Error('protected_binding_unavailable')
    return value
  }
}

function sortedValues(values: ReadonlySet<string>): string[] {
  return [...values].sort()
}
