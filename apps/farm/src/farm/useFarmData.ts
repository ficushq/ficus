import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { Agent } from '@ficus/shared'
import { farmQueries } from '../api/queries'
import type { FarmInput } from './layout'

/** Everything the farm draws, gathered from the farm query layer. */
export function useFarmData(): { input: FarmInput | null; error: unknown } {
  const squads = useQuery(farmQueries.squads())
  const streams = useQuery(farmQueries.liveWorkStreams())
  const pending = useQuery(farmQueries.pendingActions())
  const done = useQuery(farmQueries.finishedCount('done'))
  const canceled = useQuery(farmQueries.finishedCount('canceled'))
  const assistant = useQuery(farmQueries.assistantActivity())

  const squadAgents = useQueries({
    queries: (squads.data ?? []).map((squad) => farmQueries.squadAgents(squad.id)),
  })
  const agentsReady = squadAgents.every((q) => !q.isPending)
  const agentsKey = squadAgents.map((q) => q.dataUpdatedAt).join(',')

  const input = useMemo<FarmInput | null>(() => {
    if (!squads.data || !streams.data || !agentsReady) return null
    return {
      squads: squads.data,
      streams: streams.data,
      doneCount: done.data ?? 0,
      canceledCount: canceled.data ?? 0,
      agents: squadAgents.flatMap((q) => q.data ?? []),
      // One assistant on the porch however many conversations there are; its card lists the recent ones.
      assistants: [porchAssistant((assistant.data?.totals.needsInputTasks ?? 0) > 0)],
      assistantActivity: assistant.data,
      pendingActions: pending.data ?? [],
    }
    // squadAgents is a new array every render; its update stamps are the real dep.
  }, [squads.data, streams.data, pending.data, done.data, canceled.data, assistant.data, agentsReady, agentsKey])

  return { input, error: squads.error ?? streams.error ?? null }
}

/**
 * The porch assistant: one robot standing for the Assistant as a whole (not a
 * particular conversation's agent), so it's there even before any exists.
 */
export const PORCH_ASSISTANT_ID = 'farm:assistant'

function porchAssistant(waiting: boolean): Agent {
  const now = new Date(0)
  return {
    id: PORCH_ASSISTANT_ID,
    agentTypeId: 'assistant',
    squadId: null,
    parentAgentId: null,
    // A task waiting on you shows as the robot's "?" face.
    status: waiting ? 'waiting-input' : 'idle',
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
  }
}
