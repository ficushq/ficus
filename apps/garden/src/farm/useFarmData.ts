import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { Agent } from '@ficus/shared'
import { gardenQueries } from '../api/queries'
import type { FarmInput } from './layout'

const MAX_PORCH_ASSISTANTS = 3

/** Everything the farm draws, gathered from the garden query layer. */
export function useFarmData(): { input: FarmInput | null; error: unknown } {
  const squads = useQuery(gardenQueries.squads())
  const streams = useQuery(gardenQueries.liveWorkStreams())
  const pending = useQuery(gardenQueries.pendingActions())
  const done = useQuery(gardenQueries.finishedCount('done'))
  const canceled = useQuery(gardenQueries.finishedCount('canceled'))
  const conversations = useQuery(gardenQueries.assistants())

  const squadAgents = useQueries({
    queries: (squads.data ?? []).map((squad) => gardenQueries.squadAgents(squad.id)),
  })
  const assistantAgentIds = (conversations.data ?? [])
    .map((c) => c.agentId)
    .filter((id): id is string => !!id)
    .slice(0, MAX_PORCH_ASSISTANTS + 1)
  const assistantAgents = useQueries({ queries: assistantAgentIds.map((id) => gardenQueries.agent(id)) })

  const agentsReady = squadAgents.every((q) => !q.isPending)
  const agentsKey = squadAgents.map((q) => q.dataUpdatedAt).join(',')
  const assistantsKey = assistantAgents.map((q) => q.dataUpdatedAt).join(',')

  const input = useMemo<FarmInput | null>(() => {
    if (!squads.data || !streams.data || !agentsReady) return null
    return {
      squads: squads.data,
      streams: streams.data,
      doneCount: done.data ?? 0,
      canceledCount: canceled.data ?? 0,
      agents: squadAgents.flatMap((q) => q.data ?? []),
      assistants: withPorchAssistant(assistantAgents.map((q) => q.data).filter((a): a is Agent => !!a)),
      pendingActions: pending.data ?? [],
    }
    // squadAgents/assistantAgents are new arrays every render; their update stamps are the real deps.
  }, [squads.data, streams.data, pending.data, done.data, canceled.data, agentsReady, agentsKey, assistantsKey])

  return { input, error: squads.error ?? streams.error ?? null }
}

/**
 * The assistant is always on the porch, even before its conversation has an
 * agent: talking to it opens (or starts) the assistant conversation.
 */
export const PORCH_ASSISTANT_ID = 'garden:assistant'

function withPorchAssistant(agents: Agent[]): Agent[] {
  if (agents.length) return agents
  const now = new Date()
  return [
    {
      id: PORCH_ASSISTANT_ID,
      agentTypeId: 'assistant',
      squadId: null,
      parentAgentId: null,
      status: 'idle',
      persist: true,
      modelOverride: null,
      metadata: { name: 'Assistant' },
      context: {},
      questionData: null,
      sessionUsage: null,
      dormantAt: null,
      terminatedAt: null,
      lastMessageAt: null,
      lastHumanMessageAt: null,
      lastMessagePreview: null,
      createdAt: now,
      updatedAt: now,
      amtpHandle: null,
      identityPublicKey: null,
      inboundOpen: false,
    },
  ]
}
