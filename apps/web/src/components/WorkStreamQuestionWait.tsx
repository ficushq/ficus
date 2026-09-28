import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { isHttpResponseError } from '@ficus/client-core'
import type { WorkStreamWait } from '@ficus/shared'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { AgentQuestionCard } from './AgentQuestionCard'

/**
 * A work stream's open `question` wait, answerable in place. The wait itself
 * is read-only (the answer lifecycle clears it), so this resolves the wait's
 * question through the asking agent's own question list — visible to anyone
 * with read access to that agent, whether or not Action Center attention was
 * routed to them — and renders the same answer form the agent thread uses.
 */
export function WorkStreamQuestionWait({
  wait,
  agentThreadHref,
  onAnswered,
}: {
  wait: WorkStreamWait
  /** Where to send the reader for the full conversation, when the asking agent is known. */
  agentThreadHref?: string
  onAnswered?: () => void
}) {
  const queryClient = useQueryClient()
  const agentId = wait.createdByAgentId
  const questionsQuery = useQuery({
    ...queries.agentQuestions.byAgent(agentId ?? '', 'open'),
    enabled: Boolean(agentId && wait.referenceId),
  })

  if (!agentId || !wait.referenceId) return null

  const threadLink = agentThreadHref ? (
    <Link to={agentThreadHref} className="text-xs text-accent-light hover:text-accent-hover hover:underline">
      Open agent thread
    </Link>
  ) : null

  if (questionsQuery.isPending) return <p className="text-xs text-muted">Loading question…</p>
  if (questionsQuery.isError) {
    const forbidden = isHttpResponseError(questionsQuery.error) && questionsQuery.error.status === 403
    return (
      <p className="text-xs text-muted">
        {forbidden ? "You can't view this agent's questions." : 'Unable to load this question.'} {threadLink}
      </p>
    )
  }
  const question = questionsQuery.data.find((candidate) => candidate.id === wait.referenceId)
  if (!question) {
    return (
      <p className="text-xs text-muted">This question has been answered; the wait clears once the agent resumes.</p>
    )
  }
  return (
    <div className="mt-2 space-y-2">
      <AgentQuestionCard
        question={question}
        embedded
        onAnswered={async () => {
          await queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
          await onAnswered?.()
        }}
      />
      {threadLink}
    </div>
  )
}
