import { queryKeys } from '@ficus/client-core'
import { queryOptions } from '@tanstack/react-query'
import type { Agent, WorkStreamStatus } from '@ficus/shared'
import { client } from './client'
import { assistantApi } from './assistant'

/**
 * The garden's query layer: thin options over client-core request functions,
 * keyed by client-core's shared `queryKeys` so invalidation reads the same as
 * the web app's. (The web app's own queryOptions.ts lives in apps/web and is
 * not imported here.)
 */
const LIVE_STATUSES: WorkStreamStatus[] = ['queued', 'active']

export const gardenQueries = {
  session: () =>
    queryOptions({
      queryKey: queryKeys.auth.me(),
      queryFn: () => client.auth.getCurrentUser(),
      retry: false,
      staleTime: 60_000,
    }),
  squads: () =>
    queryOptions({
      queryKey: queryKeys.squads.list('active'),
      queryFn: () => client.squads.listSquads('active'),
    }),
  liveWorkStreams: () =>
    queryOptions({
      queryKey: queryKeys.squads.activeWorkStreams(),
      queryFn: () => client.squads.listAllWorkStreams(LIVE_STATUSES),
    }),
  squadAgents: (squadId: string) =>
    queryOptions({
      queryKey: queryKeys.squads.agents(squadId),
      queryFn: () => client.squads.listSquadAgents(squadId),
    }),
  /** Totals only: finished streams become harvest crates, canceled ones compost. */
  finishedCount: (status: 'done' | 'canceled') =>
    queryOptions({
      queryKey: [...queryKeys.squads.all, 'garden', 'finishedCount', status],
      queryFn: async () => (await client.squads.listDoneWorkStreamsPage({ statuses: [status], limit: 1 })).totalCount,
      staleTime: 60_000,
    }),
  assistants: () =>
    queryOptions({
      queryKey: ['garden', 'assistant', 'conversations'],
      queryFn: async () => (await assistantApi.list()).conversations,
      staleTime: 60_000,
    }),
  assistantActivity: () =>
    queryOptions({
      queryKey: ['garden', 'assistant', 'activity'],
      queryFn: () => assistantApi.activity(6),
      staleTime: 30_000,
    }),
  agent: (agentId: string) =>
    queryOptions({
      queryKey: queryKeys.agents.detail(agentId),
      queryFn: () => client.agents.getAgent(agentId),
    }),
  /** The squad's agents plus recently finished ones, for the roster (mirrors the web's agentsWithRecent). */
  squadRoster: (squadId: string) =>
    queryOptions({
      queryKey: queryKeys.squads.agentsWithRecent(squadId),
      queryFn: () =>
        client.transport.request<{ agents: Agent[]; recentlyTerminated?: Agent[] }>(
          `/squads/${encodeURIComponent(squadId)}/agents?includeRecentlyTerminated=true`
        ),
    }),
  workStream: (id: string) =>
    queryOptions({
      queryKey: queryKeys.squads.workStreamDetail(id),
      queryFn: () => client.squads.getWorkStream(id),
    }),
  pendingActions: () =>
    queryOptions({
      queryKey: queryKeys.actions.pending(),
      queryFn: () => client.actions.listPendingActions(),
      // The live socket is the primary refresh; this is the fallback.
      refetchInterval: 30_000,
    }),
}
