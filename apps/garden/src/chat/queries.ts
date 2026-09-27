import { queryKeys, type TauClient } from '@ficus/client-core'
import { queryOptions } from '@tanstack/react-query'

/**
 * Reads the chat makes beside `useAgentConversation`, keyed by client-core's
 * shared `queryKeys` — the same keys the web uses for the same data, so the
 * farm's live invalidation and the hook's own refreshes reach them. They take
 * the client from the conversation environment rather than the module
 * singleton, so tests can inject a fake.
 */
export const chatQueries = {
  agent: (client: TauClient, agentId: string) =>
    queryOptions({
      queryKey: queryKeys.agents.detail(agentId),
      queryFn: () => client.agents.getAgent(agentId),
      enabled: !!agentId,
    }),
  /** Same key as the garden session query; used to tell your own messages from teammates'. */
  me: (client: TauClient) =>
    queryOptions({
      queryKey: queryKeys.auth.me(),
      queryFn: () => client.auth.getCurrentUser(),
      retry: false,
      staleTime: 60_000,
    }),
  permissions: (client: TauClient, squadId?: string) =>
    queryOptions({
      queryKey: queryKeys.auth.permissions(squadId),
      queryFn: () => client.auth.getMyPermissions(squadId),
      staleTime: 60_000,
    }),
}
