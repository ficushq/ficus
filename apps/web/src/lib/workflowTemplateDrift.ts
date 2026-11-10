import type { WorkflowCatalogEntry } from '@ficus/client-core'

/** Whether a catalog entry differs from the code template it was synced from. */
export function hasTemplateDrift(entry: Pick<WorkflowCatalogEntry, 'hasTemplate' | 'yamlFieldOverrides'>): boolean {
  return entry.hasTemplate && (entry.yamlFieldOverrides?.length ?? 0) > 0
}
