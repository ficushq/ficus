import { linearOutputAdapter } from '../linear/outputs'
import { integrationValueAt, type IntegrationSubscription, type IntegrationOutputFact } from '@ficus/shared'
import type { IntegrationOutputAdapter } from './types'
import { githubOutputAdapter } from './github'

export class IntegrationOutputRegistry {
  private readonly registered = new Map<string, IntegrationOutputAdapter>()
  constructor(adapters: readonly IntegrationOutputAdapter[]) {
    for (const adapter of adapters) this.register(adapter)
  }
  register(adapter: IntegrationOutputAdapter) {
    const existing = this.registered.get(adapter.integration)
    if (existing && existing !== adapter) throw new Error('Duplicate output adapter')
    if (adapter.catalog.some((output) => output.integration !== adapter.integration))
      throw new Error('Output adapter identity mismatch')
    this.registered.set(adapter.integration, adapter)
  }
  get adapters() {
    return [...this.registered.values()]
  }
  catalog() {
    return this.adapters.flatMap((adapter) => adapter.catalog)
  }
  adapter(integration: string) {
    return this.adapters.find((adapter) => adapter.integration === integration)
  }
  descriptor(source: IntegrationSubscription['source']) {
    return this.catalog().find(
      (item) =>
        item.integration === source.integration && item.output === source.output && item.version === source.version
    )
  }
  validate(subscription: IntegrationSubscription) {
    const descriptor = this.descriptor(subscription.source)
    if (!descriptor)
      throw new Error(
        `Unknown integration output ${subscription.source.integration}:${subscription.source.output}@${subscription.source.version}`
      )
    for (const [path, binding] of Object.entries(subscription.match)) {
      const field = descriptor.fields[path]
      if (!field) throw new Error(`Unknown output field '${path}'`)
      if ('value' in binding && typeof binding.value !== field.type)
        throw new Error(`Output field '${path}' requires ${field.type}`)
    }
  }
  validateFact(integration: string, fact: IntegrationOutputFact) {
    const descriptor = this.descriptor({ integration, output: fact.output, version: fact.version })
    if (
      !descriptor ||
      !fact.eventKey ||
      fact.eventKey.length > 200 ||
      !fact.resourceKey ||
      fact.resourceKey.length > 1000 ||
      !Number.isFinite(Date.parse(fact.occurredAt))
    )
      throw new Error('Invalid integration output identity')
    if (
      !fact.subject ||
      fact.subject.length > 1000 ||
      fact.body.length > 32000 ||
      JSON.stringify(fact.data).length > 64000
    )
      throw new Error('Invalid integration output content')
    for (const [path, field] of Object.entries(descriptor.fields)) {
      const value = integrationValueAt(fact.data, path)
      if (
        value !== undefined &&
        (typeof value !== field.type || (typeof value === 'number' && !Number.isFinite(value)))
      )
        throw new Error(`Invalid output field '${path}'`)
    }
    if (
      fact.ordering &&
      (!fact.ordering.key ||
        fact.ordering.position.length === 0 ||
        fact.ordering.position.length > 8 ||
        fact.ordering.position.some((value) => !Number.isSafeInteger(value) || value < 0))
    )
      throw new Error('Invalid event ordering')
  }
}
// Composition only; new providers add an adapter, not branches in the subscription runtime.
export const integrationOutputRegistry = new IntegrationOutputRegistry([githubOutputAdapter, linearOutputAdapter])
