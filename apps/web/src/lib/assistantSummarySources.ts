import type { RenderItem } from '@ficus/client-core'

export function assistantSummaryUpdateIds(item: Extract<RenderItem, { kind: 'persisted' }>): string[] {
  return [
    ...new Set((item.mergedFrom ?? [item.message]).flatMap((message) => message.metadata?.assistantUpdateIds ?? [])),
  ]
}
