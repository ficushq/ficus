import { queryKeys } from '@ficus/client-core'
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { Agent, LocalDeployment, SquadActivityKind, WorkStreamStatus } from '@ficus/shared'
import { squadApps as squadAppsOf, type RemoteDeployment } from '../farm/apps'
import { client } from './client'
import { assistantApi } from './assistant'
import { fieldLogKey } from '../live/invalidation'
import { isDemo } from '../app/demo'

/**
 * The farm's query layer: thin options over client-core request functions,
 * keyed by client-core's shared `queryKeys` so invalidation reads the same as
 * the web app's. (The web app's own queryOptions.ts lives in apps/web and is
 * not imported here.)
 */
const LIVE_STATUSES: WorkStreamStatus[] = ['queued', 'active']

/** How many field log entries a page brings. */
export const FIELD_LOG_PAGE = 30

export const farmQueries = {
  /** A squad's activity, newest first, a page at a time (the web's squad Activity tab). */
  fieldLog: (squadId: string, kinds: readonly SquadActivityKind[]) =>
    infiniteQueryOptions({
      queryKey: [...fieldLogKey(squadId), [...kinds].sort()],
      queryFn: ({ pageParam }) =>
        client.squads.listSquadActivity(squadId, { kinds: [...kinds], limit: FIELD_LOG_PAGE, cursor: pageParam }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => (page.hasMore ? (page.nextCursor ?? undefined) : undefined),
      // Live events do the work; this is the fallback when the socket is away. The demo has no server.
      refetchInterval: isDemo ? false : 30_000,
      staleTime: isDemo ? Infinity : 0,
    }),
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
  /**
   * A squad's openable apps (remote deployments and live local apps), for its
   * server rack. Neither list has live events, so it refreshes every 30s (and
   * with squad events, being under the squads key). Someone who may not list
   * them (a 403) simply sees no rack.
   */
  squadApps: (squadId: string) =>
    queryOptions({
      queryKey: [...queryKeys.squads.all, 'farm', 'apps', squadId],
      queryFn: async () => {
        const quietly = <T>(request: Promise<T[]>) => request.catch((): T[] => [])
        const [remote, local] = await Promise.all([
          quietly(client.transport.request<RemoteDeployment[]>(`/squads/${encodeURIComponent(squadId)}/deployments`)),
          quietly(
            client.transport.request<LocalDeployment[]>(`/squads/${encodeURIComponent(squadId)}/local-deployments`)
          ),
        ])
        return squadAppsOf(remote, local)
      },
      refetchInterval: 30_000,
    }),
  /** Totals only: finished streams become harvest crates, canceled ones compost. */
  finishedCount: (status: 'done' | 'canceled') =>
    queryOptions({
      queryKey: [...queryKeys.squads.all, 'farm', 'finishedCount', status],
      queryFn: async () => (await client.squads.listDoneWorkStreamsPage({ statuses: [status], limit: 1 })).totalCount,
      staleTime: 60_000,
    }),
  assistants: () =>
    queryOptions({
      queryKey: ['farm', 'assistant', 'conversations'],
      queryFn: async () => (await assistantApi.list()).conversations,
      staleTime: 60_000,
    }),
  assistantActivity: () =>
    queryOptions({
      queryKey: ['farm', 'assistant', 'activity'],
      queryFn: () => assistantApi.activity(6),
      staleTime: 30_000,
    }),
  /** The account's farm settings, e.g. its style (see skins/useAccountStyle.ts). */
  farmPreference: () =>
    queryOptions({
      queryKey: ['farm', 'farmPreference'],
      queryFn: () => client.farmPreferences.getMine(),
      staleTime: 5 * 60_000,
      retry: false,
    }),
  /** The account's web-app theme choice (the Futurist style follows its colours). */
  themePreference: () =>
    queryOptions({
      queryKey: ['farm', 'themePreference'],
      queryFn: () => client.userPreferences.getMine(),
      staleTime: 5 * 60_000,
      retry: false,
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
