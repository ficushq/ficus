import type { ModelCatalogEntry } from '@ficus/shared'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getModelRuntime } from '../agent/auth-backend'

// Deliberately omit runtime connection configuration (headers, URLs, credentials).
export function projectModelCatalog(models: readonly Model<Api>[]): ModelCatalogEntry[] {
  return models
    .map(({ provider, id, name, reasoning, input, contextWindow, maxTokens }) => ({
      provider,
      id,
      name,
      reasoning,
      input: [...input],
      contextWindow,
      maxTokens,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
}

export async function getModelCatalog(): Promise<ModelCatalogEntry[]> {
  return projectModelCatalog((await getModelRuntime()).getModels())
}
