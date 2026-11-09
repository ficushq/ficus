import * as yaml from 'js-yaml'
import { agentTypes, db, modelTiers } from '../../db'
import { MODEL_TIERS_DIR } from '../../lib/paths'
import { type DynamicModelCatalog, validateModelSpecList } from '../../lib/utils/model-spec'
import { inspectOpenRouterFallbacks, invalidOpenRouterFallbackWarning } from '../model-selection/openrouter-expansion'
import { ConfigSync, type SyncResult } from './ConfigSync'

export interface ModelTierYaml {
  slug: string
  label: string
  description?: string
  chain: string
  sortOrder: number
}
export class ModelTierSync extends ConfigSync<ModelTierYaml> {
  constructor(private readonly dynamicCatalog?: DynamicModelCatalog) {
    super()
  }
  readonly name = 'model-tiers'
  readonly directory = MODEL_TIERS_DIR
  readonly table = modelTiers
  readonly idColumn = modelTiers.slug
  readonly yamlTemplateColumn = modelTiers.yamlTemplate
  readonly yamlFieldOverridesColumn = modelTiers.yamlFieldOverrides
  readonly updatedAtColumn = modelTiers.updatedAt
  readonly disabledColumn = modelTiers.disabled
  parse(content: string): ModelTierYaml {
    const value = yaml.load(content) as Partial<ModelTierYaml>
    if (!value || !value.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug))
      throw new Error('ModelTier: slug must be kebab-case')
    if (!value.label || !value.chain || !Number.isInteger(value.sortOrder))
      throw new Error('ModelTier: label, chain, and integer sortOrder are required')
    validateModelSpecList(value.chain, this.dynamicCatalog)
    return value as ModelTierYaml
  }
  async sync(): Promise<SyncResult> {
    const loaded = await this.loadFromDir()
    const yamlSlugs = new Set(loaded.map((tier) => tier.slug))
    const referenced = await db.select({ id: agentTypes.id, tier: agentTypes.tier }).from(agentTypes)
    const existing = new Map(
      (
        await db
          .select({
            slug: modelTiers.slug,
            chain: modelTiers.chain,
            yamlTemplate: modelTiers.yamlTemplate,
            yamlFieldOverrides: modelTiers.yamlFieldOverrides,
          })
          .from(modelTiers)
      ).map((tier) => [tier.slug, tier])
    )
    for (const tier of loaded) {
      const persisted = existing.get(tier.slug)
      const overrides = persisted?.yamlFieldOverrides as string[] | null | undefined
      const effectiveChain = overrides?.includes('chain') ? persisted!.chain : tier.chain
      this.warnInvalidOpenRouterFallbacks(effectiveChain)
    }
    for (const tier of existing.values()) {
      if (!yamlSlugs.has(tier.slug)) this.warnInvalidOpenRouterFallbacks(tier.chain)
    }
    const dangling = referenced.find(
      (type) => type.tier && !yamlSlugs.has(type.tier) && existing.get(type.tier)?.yamlTemplate != null
    )
    if (dangling)
      throw new Error(`Cannot remove model tier '${dangling.tier}'; referenced by agent type '${dangling.id}'`)
    return super.sync()
  }
  private warnInvalidOpenRouterFallbacks(chain: string): void {
    const { invalid } = inspectOpenRouterFallbacks(chain, this.dynamicCatalog)
    for (const entry of invalid)
      this.log.warn(
        `Skipping derived OpenRouter fallback for '${entry.source}': ${invalidOpenRouterFallbackWarning(entry)}`
      )
  }

  getId(value: ModelTierYaml) {
    return value.slug
  }
  toRecord(value: ModelTierYaml): Record<string, unknown> {
    return { ...value, description: value.description ?? null }
  }
  toComparable(row: Record<string, unknown>): Record<string, unknown> {
    return {
      slug: row.slug,
      label: row.label,
      description: row.description ?? null,
      chain: row.chain,
      sortOrder: row.sortOrder,
    }
  }
  toYaml(row: Record<string, unknown>): string {
    return yaml.dump(this.toComparable(row), { lineWidth: 120, noRefs: true })
  }
}
