import type { ModelCatalogEntry } from '@ficus/shared'
import { apiFetch } from './client'

export async function getModelCatalog(agentId?: string): Promise<ModelCatalogEntry[]> {
  const models = await apiFetch<ModelCatalogEntry[]>(
    agentId ? `/agents/${encodeURIComponent(agentId)}/model-catalog` : '/model-tiers/catalog'
  )
  if (!Array.isArray(models)) throw new Error('Model catalog unavailable')
  return models
}
