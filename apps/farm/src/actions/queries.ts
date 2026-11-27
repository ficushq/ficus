import { queryKeys } from '@ficus/client-core'
import { queryOptions } from '@tanstack/react-query'
import type { ActionsApi } from './api'

/**
 * Reads the action forms need beyond the pending-actions list. Keyed by
 * client-core `queryKeys` (the same keys the web app uses), so the web's
 * invalidation families (squads.all, workflows.all, agentQuestions.all, ...)
 * refresh them too.
 */
export const actionQueries = {
  permissions: (api: ActionsApi, squadId?: string) =>
    queryOptions({
      queryKey: queryKeys.auth.permissions(squadId),
      queryFn: () => api.getMyPermissions(squadId),
      staleTime: 60_000,
    }),
  workStream: (api: ActionsApi, workStreamId: string) =>
    queryOptions({
      queryKey: queryKeys.squads.workStreamDetail(workStreamId),
      queryFn: () => api.getWorkStream(workStreamId),
    }),
  workflowRun: (api: ActionsApi, workStreamId: string) =>
    queryOptions({
      queryKey: queryKeys.workflows.run(workStreamId),
      queryFn: () => api.workflowRun(workStreamId),
    }),
  /** Optional context for naming people: a 403 or an outage leaves the participant type to name them. */
  squadAgents: (api: ActionsApi, squadId: string) =>
    queryOptions({
      queryKey: queryKeys.squads.agents(squadId),
      queryFn: () => api.listSquadAgents(squadId),
      retry: false,
    }),
  agentTypes: (api: ActionsApi) =>
    queryOptions({
      queryKey: queryKeys.agentTypes.list(),
      queryFn: () => api.listAgentTypes(),
      retry: false,
      // Type names change rarely; settings edits invalidate the list themselves.
      staleTime: 5 * 60_000,
    }),
  openAgentQuestions: (api: ActionsApi, agentId: string) =>
    queryOptions({
      queryKey: queryKeys.agentQuestions.byAgent(agentId, 'open'),
      queryFn: () => api.getAgentQuestions(agentId, 'open'),
    }),
}
