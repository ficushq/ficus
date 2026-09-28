import { sortCanonicalWorkStreams } from '@ficus/shared'
import type { CanonicalWorkStreamOrderInput, WorkStreamDerivedState } from '@ficus/shared'

const DISPLAY_LIMIT = 10
const PROVIDER_LIMIT = { slack: 3000, discord: 2000 } as const

interface ChannelStatusStream extends CanonicalWorkStreamOrderInput {
  title: string
  derivedState?: WorkStreamDerivedState
}

const ICONS: Partial<Record<WorkStreamDerivedState, string>> = {
  in_progress: '🔄',
  in_review: '👀',
  waiting_on_answer: '❓',
  waiting_on_dependency: '⏳',
  blocked: '🚫',
  idle: '💤',
  execution_failed: '🛑',
}

/** Format an already-canonically-ordered snapshot without provider-side silent loss. */
export function formatChannelWorkStreamStatus(
  streams: readonly ChannelStatusStream[],
  provider: 'slack' | 'discord'
): string {
  const budget = PROVIDER_LIMIT[provider]
  const header = `**Active and queued (${streams.length}):**`
  const candidates = sortCanonicalWorkStreams(streams).slice(0, DISPLAY_LIMIT)
  const lines: string[] = []

  for (const stream of candidates) {
    const line = `${ICONS[stream.derivedState ?? 'idle'] ?? '📋'} **${stream.title}**`
    const shownAfterAdd = lines.length + 1
    const omitted = streams.length - shownAfterAdd
    const suffix = omitted > 0 ? `\n_...${omitted} more not shown. Use \`ficus workstream list\` to view all._` : ''
    if (`${header}\n${[...lines, line].join('\n')}${suffix}`.length > budget) break
    lines.push(line)
  }

  const omitted = streams.length - lines.length
  const suffix = omitted > 0 ? `_...${omitted} more not shown. Use \`ficus workstream list\` to view all._` : undefined
  return [header, ...lines, suffix].filter((part): part is string => part !== undefined).join('\n')
}
