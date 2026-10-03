import type { SquadActivityItem, SquadActivityKind, SquadActivityPage } from '@ficus/shared'
import { FIELD_LOG_FILTERS, fieldLogKinds } from '../farm/cards/FieldLog'

type Entry = [
  minutesAgo: number,
  agentId: string | null,
  kind: SquadActivityKind,
  summary: string,
  ref: SquadActivityItem['ref'],
]

const chat = (agentId: string) => ({ type: 'agent', agentId, view: 'chat' }) as const

/** What each demo squad's field log shows (?demo): a few minutes to a day of robots at work. */
const ENTRIES: Record<string, Entry[]> = {
  'sq-platform': [
    [
      1,
      'w-ada',
      'message',
      'Measured the sidebar: 41 ms per render on the 40-squad fixture, down from 190 ms.',
      chat('w-ada'),
    ],
    [4, 'w-bo', 'execution', 'Started a run: replaying the failed webhook deliveries from last night.', chat('w-bo')],
    [
      9,
      'w-cy',
      'wait',
      'Asked for review: “Squad settings: show the model tier”.',
      { type: 'workstream', workStreamId: 'ws-3' },
    ],
    [
      22,
      'w-dee',
      'pr',
      'Opened pull request #412: rate limit the public search API.',
      { type: 'pr', url: 'https://github.com/ficushq/ficus/pull/412' },
    ],
    [
      47,
      'mgr-platform',
      'handoff',
      'Handed “Retry flaky webhook deliveries” to Bo.',
      { type: 'workstream', workStreamId: 'ws-2' },
    ],
    [95, 'w-ada', 'subagent', 'Sent a helper to profile the slug lookup.', chat('w-ada')],
    [
      260,
      'mgr-platform',
      'workstream',
      'Planted “Upgrade the sandbox base image”.',
      { type: 'workstream', workStreamId: 'ws-4' },
    ],
  ],
  'sq-docs': [
    [3, 'w-fox', 'message', 'Rewrote the quick start around the one-line installer.', chat('w-fox')],
    [
      18,
      'w-eli',
      'wait',
      'Asked for review: “Write the plugin authoring guide”.',
      { type: 'workstream', workStreamId: 'ws-8' },
    ],
    [70, 'mgr-docs', 'workstream', 'Planted “Refresh the quick start”.', { type: 'workstream', workStreamId: 'ws-9' }],
  ],
  'sq-mobile': [
    [2, 'w-gus', 'wait', 'Has a question: should offline drafts sync across devices?', chat('w-gus')],
    [
      12,
      'w-ivy',
      'issue',
      'Linked issue #88: the share sheet crash on iOS 26.',
      { type: 'issue', url: 'https://github.com/ficushq/ficus-mobile/issues/88' },
    ],
    [31, 'w-hal', 'execution', 'Started a run: grouping notifications by work stream.', chat('w-hal')],
  ],
}

function items(squadId: string, now: number): SquadActivityItem[] {
  return (ENTRIES[squadId] ?? []).map(([minutes, agentId, kind, summary, ref], i) => ({
    id: `${squadId}-activity-${i}`,
    at: new Date(now - minutes * 60_000).toISOString(),
    agentId,
    agentTypeId: agentId?.startsWith('mgr-') ? 'manager' : 'engineer',
    kind,
    summary,
    preview: [{ text: summary }],
    ref,
  }))
}

/** Every mix of filters (none on is everything). */
const filterMixes = (): Array<Set<string>> =>
  FIELD_LOG_FILTERS.reduce<Array<Set<string>>>(
    (mixes, { id }) => mixes.flatMap((mix) => [mix, new Set([...mix, id])]),
    [new Set()]
  )

/** Every filter mix's first (and only) page of each squad's demo log, keyed like farmQueries.fieldLog. */
export function sampleFieldLogs(
  now = Date.now()
): Array<{ squadId: string; kinds: SquadActivityKind[]; page: SquadActivityPage }> {
  return Object.keys(ENTRIES).flatMap((squadId) =>
    filterMixes().map((mix) => {
      const kinds = fieldLogKinds(mix)
      return {
        squadId,
        kinds,
        page: {
          items: items(squadId, now).filter((item) => kinds.length === 0 || kinds.includes(item.kind)),
          hasMore: false,
          nextCursor: null,
        },
      }
    })
  )
}
