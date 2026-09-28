import type { Agent } from '@ficus/shared'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStableRef } from '../hooks/useStableRef'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { agentChatPath, type EntityReference } from '../lib/entityReference'
import { Modal } from './Modal'
import { WorkStreamViewModal } from './WorkStreamViewModal'
/** Warm only visible/hovered references; use the same cache as the destination UI. */
export async function preloadEntityReference(client: QueryClient, reference: EntityReference) {
  const staleTime = 30_000
  if (reference.kind === 'agent') {
    const agent = await client.fetchQuery({ ...queries.agents.detail(reference.id), staleTime })
    client.setQueryData(queries.agents.detail(agent.id).queryKey, agent)
    return
  }
  const stream = await client.fetchQuery({ ...queries.squads.workStreamDetail(reference.id), staleTime })
  client.setQueryData(queries.squads.workStreamDetail(stream.id).queryKey, stream)
  await Promise.all([
    client.prefetchQuery({ ...queries.squads.basic(stream.squadId), staleTime }),
    client.prefetchQuery({ ...queries.squads.agents(stream.squadId), staleTime }),
    client.prefetchQuery({ ...queries.squads.workStreamMetrics(stream.id), staleTime }),
    client.prefetchQuery({ ...queries.workStreamSubscription.detail(stream.id), staleTime }),
    client.prefetchQuery({ ...queries.workflows.run(stream.id), staleTime }),
  ])
}

type ResolutionProps = { onClose: () => void; onResolved?: () => void; onOpenAgent?: (agent: Agent) => void }

export function EntityReferenceModal({ reference, ...props }: { reference: EntityReference } & ResolutionProps) {
  if (reference.kind === 'ws') return <WorkStreamReference id={reference.id} {...props} />
  return <AgentReference id={reference.id} {...props} />
}

function useResolutionComplete(complete: boolean, onResolved?: () => void) {
  const onResolvedRef = useStableRef(onResolved)
  useEffect(() => {
    if (complete) onResolvedRef.current?.()
  }, [complete, onResolvedRef])
}

function AgentReference({ id, onClose, onResolved, onOpenAgent }: { id: string } & ResolutionProps) {
  const { data, isError } = useQuery(queries.agents.detail(id))
  useResolutionComplete(!!data || isError, onResolved)
  const navigate = useNavigate()
  const onCloseRef = useStableRef(onClose)
  const onOpenAgentRef = useStableRef(onOpenAgent)
  useEffect(() => {
    if (!data) return
    onCloseRef.current()
    if (onOpenAgentRef.current) onOpenAgentRef.current(data)
    else navigate(agentChatPath(data))
  }, [data, navigate, onCloseRef, onOpenAgentRef])
  if (!isError) return null
  return (
    <Modal isOpen title="Agent chat" onClose={onClose}>
      <p role="status">
        This agent could not be opened. The ID may be ambiguous, unavailable, or inaccessible. Try its full UUID.
      </p>
    </Modal>
  )
}

function WorkStreamReference({ id, onClose, onResolved }: { id: string } & ResolutionProps) {
  const { data, isError } = useQuery(queries.squads.workStreamDetail(id))
  useResolutionComplete(!!data || isError, onResolved)
  // Reuse the resolving query even when the link used a prefix and was clicked before preloading finished.
  if (data) return <WorkStreamViewModal workStreamId={id} squadId={data.squadId} onClose={onClose} />
  if (!isError) return null
  return (
    <Modal isOpen title="Work stream" onClose={onClose}>
      <p role="status">
        This work stream could not be opened. The ID may be ambiguous, unavailable, or inaccessible. Try its full UUID.
      </p>
    </Modal>
  )
}
