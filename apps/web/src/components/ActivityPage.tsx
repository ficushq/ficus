import { useCallback, useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type {
  Agent,
  GlobalActivityPresence,
  GlobalSquadActivityItem,
  NormalizedSquadActivityFilters,
  SquadActivityKind,
} from '@ficus/shared'
import { queries } from '../queryOptions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { ActivityFeedView } from './squads/ActivityFeedView'
import { AgentViewModal } from './squads/AgentViewModal'
import { activityAgentLabel, globalActivityItemHref } from './squads/squadActivityView'
import { WorkStreamViewModal } from './WorkStreamViewModal'
import { Modal } from './Modal'
import { AgentConversation } from './AgentConversation'

const EMPTY_PRESENCE: GlobalActivityPresence = {
  workingAgentIds: [],
  workingCount: 0,
  needsYouCount: 0,
  streamCount: 0,
}

type OpenActivityItem =
  | { type: 'workstream'; workStreamId: string; squadId: string }
  | {
      type: 'agent'
      agentId: string
      squadId: string | null
      label: string
      view: 'chat' | 'inbox'
      messageId?: string
      resolvedAgent?: Agent
    }

export interface ActivityPageProps {
  /** Test seams: replace the heavy modal internals (conversation/provider stacks) — mirrors SquadActivityTab. */
  dependencies?: {
    AgentConversationComponent?: typeof AgentConversation
    WorkStreamViewModalComponent?: typeof WorkStreamViewModal
    AgentViewModalComponent?: typeof AgentViewModal
  }
}

/**
 * Cross-squad activity feed at /activity: every non-archived squad's Activity
 * tab merged into one newest-first timeline, each row tagged with a squad
 * chip. Reuses SquadActivityTab's shared feed body (ActivityFeedView) and row
 * helpers (squadActivityView.ts) — the only NEW logic here is sourcing rows
 * from the global endpoint and resolving click-through targets per-row
 * (each row carries its own squadId, unlike the per-squad wire shape).
 *
 * The feed has no live WebSocket overlay yet — a modest 30s poll
 * (queries.activity.global) keeps it reasonably fresh. A global
 * `squadActivity` WS topic would let this match the per-squad tab's live feel.
 */
export function ActivityPage({ dependencies }: ActivityPageProps = {}) {
  const AgentConversationBody = dependencies?.AgentConversationComponent ?? AgentConversation
  const WorkStreamModal = dependencies?.WorkStreamViewModalComponent ?? WorkStreamViewModal
  const AgentViewModalBody = dependencies?.AgentViewModalComponent ?? AgentViewModal
  const [kinds, setKinds] = useState<SquadActivityKind[]>([])
  const filters = useMemo<NormalizedSquadActivityFilters>(
    () => ({ verbose: false, agentIds: [], kinds: [...kinds].sort() }),
    [kinds]
  )
  const query = useInfiniteQuery(queries.activity.global(filters))
  const { data: presence = EMPTY_PRESENCE, isPending: presenceLoading } = useQuery(queries.activity.presence())
  const { slugFor } = useSquadSlugs()
  const workingAgentIds = useMemo(() => new Set(presence.workingAgentIds), [presence.workingAgentIds])

  const pages = useMemo(() => query.data?.pages ?? [], [query.data])
  const items = useMemo<GlobalSquadActivityItem[]>(() => pages.flatMap((page) => page.items), [pages])
  // Later pages win on a name collision (there shouldn't be one — squad names are stable within a session).
  const squadNames = useMemo(() => Object.assign({}, ...pages.map((page) => page.squads)), [pages]) as Record<
    string,
    { name: string }
  >

  const [openItem, setOpenItem] = useState<OpenActivityItem | null>(null)
  const openActivityItem = useCallback((item: GlobalSquadActivityItem) => {
    if (item.ref.type === 'workstream')
      setOpenItem({ type: 'workstream', workStreamId: item.ref.workStreamId, squadId: item.squadId })
    else if (item.ref.type === 'agent')
      setOpenItem({
        type: 'agent',
        agentId: item.ref.agentId,
        squadId: item.squadId,
        label: activityAgentLabel(item.agentTypeId, item.kind),
        view: item.ref.view,
        messageId: item.ref.messageId,
      })
  }, [])

  const openAgentReference = useCallback((agent: Agent) => {
    setOpenItem({
      type: 'agent',
      agentId: agent.id,
      squadId: agent.squadId,
      label: activityAgentLabel(agent.agentTypeId),
      view: 'chat',
      resolvedAgent: agent,
    })
  }, [])

  const hrefFor = useCallback((item: GlobalSquadActivityItem) => globalActivityItemHref(item, slugFor), [slugFor])
  const squadChipFor = useCallback(
    (item: GlobalSquadActivityItem) => ({
      label: squadNames[item.squadId]?.name ?? item.squadId,
      href: `/squads/${slugFor(item.squadId)}/activity`,
    }),
    [squadNames, slugFor]
  )
  // No roster to source a purpose/name tooltip from without an N-query per squad — omitted (see module doc).
  const agentDetailFor = useCallback(() => undefined, [])

  // Source rows have no preloaded roster, so fetch their agent directly with a
  // plain-conversation modal while loading. Inline references already resolved
  // an authorized agent and must not fetch again or borrow the source row's squad.
  const { data: fetchedAgent } = useQuery({
    ...queries.agents.detail(openItem?.type === 'agent' ? openItem.agentId : ''),
    enabled: openItem?.type === 'agent' && !openItem.resolvedAgent,
  })

  const openAgent = openItem?.type === 'agent' ? (openItem.resolvedAgent ?? fetchedAgent) : undefined

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Activity">
      <h1 className="ficus-page-title mb-4 shrink-0">Activity</h1>
      <ActivityFeedView
        kinds={kinds}
        onKindsChange={setKinds}
        presence={presence}
        presenceLoading={presenceLoading}
        isLoading={query.isLoading}
        filtersPending={query.isPlaceholderData && query.isFetching}
        isError={query.isError}
        items={items}
        loadingShapeKey="activity:global"
        workingAgentIds={workingAgentIds}
        agentDetailFor={agentDetailFor}
        hrefFor={hrefFor}
        squadChipFor={squadChipFor}
        onOpen={openActivityItem}
        onOpenAgentReference={openAgentReference}
        hasNextPage={query.hasNextPage}
        isFetchingNextPage={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
      />
      {openItem?.type === 'workstream' && (
        <WorkStreamModal
          workStreamId={openItem.workStreamId}
          squadId={openItem.squadId}
          onClose={() => setOpenItem(null)}
        />
      )}
      {openItem?.type === 'agent' &&
        (openAgent && openItem.squadId ? (
          <AgentViewModalBody
            agent={openAgent}
            squadId={openItem.squadId}
            onClose={() => setOpenItem(null)}
            initialTab="chat"
            focusMessageId={openItem.view === 'chat' ? openItem.messageId : undefined}
            focusInboxMessageId={openItem.view === 'inbox' ? openItem.messageId : undefined}
          />
        ) : (
          <Modal isOpen onClose={() => setOpenItem(null)} title={openItem.label} size="viewport" noChildPadding>
            <AgentConversationBody agentId={openItem.agentId} embedded enableFullscreen={false} />
          </Modal>
        ))}
    </section>
  )
}
