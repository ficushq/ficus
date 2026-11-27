import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { WorkflowRunDetail } from '@ficus/client-core'
import {
  workflowAttemptAuthor,
  workflowAttemptSummary,
  workflowWaitingLabel,
  type WorkflowAgentTypeName,
  type WorkflowAttempt,
} from '@ficus/shared'
import { useActionsApi } from './ActionsApiProvider'
import { actionQueries } from './queries'

/** Who prepared an attempt ("Engineer (Payments)"), or undefined when no agent did. */
export type AttemptAuthorOf = (attempt: WorkflowAttempt) => string | undefined

export interface ReviewPeople {
  /** The squad's name for an agent type, when the type list loaded. */
  typeName: WorkflowAgentTypeName
  authorOf: AttemptAuthorOf
}

/**
 * Names a review's people the way the web review does: agent types by the squad's names for them, and
 * each attempt by the agent that prepared it. Either list may be unavailable (no permission, offline);
 * the participant type the attempt ran as still names it.
 */
export function useReviewPeople(squadId: string, run: WorkflowRunDetail): ReviewPeople {
  const api = useActionsApi()
  const { data: agents } = useQuery(actionQueries.squadAgents(api, squadId))
  const { data: agentTypes } = useQuery(actionQueries.agentTypes(api))
  return useMemo(() => {
    const names = new Map((agentTypes ?? []).map((type) => [type.id, type.name?.trim()]))
    const byId = new Map((agents ?? []).map((agent) => [agent.id, agent]))
    const typeName: WorkflowAgentTypeName = (id) => names.get(id) || undefined
    const authorOf: AttemptAuthorOf = (attempt) => workflowAttemptAuthor(run, attempt, { agents: byId, typeName })
    return { typeName, authorOf }
  }, [agents, agentTypes, run])
}

/** "Engineer (Payments) · Build · Attempt 1 · Done": who prepared it leads, the step and attempt follow. */
export function AttemptByline({
  run,
  source,
  authorOf,
}: {
  run: WorkflowRunDetail
  source: WorkflowAttempt
  authorOf: AttemptAuthorOf
}) {
  const author = authorOf(source)
  const summary = workflowAttemptSummary(run.state, source)
  if (!author) return <span>{summary}</span>
  return (
    <span>
      <span className="g-byline-author">{author}</span>
      <span className="g-byline-detail"> · {summary}</span>
    </span>
  )
}

/** "Waiting 7 days", kept current, with the exact time on hover. */
export function WaitingTime({ openedAt }: { openedAt: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <p className="g-action-note">
      <time dateTime={openedAt} title={`Waiting since ${new Date(openedAt).toLocaleString()}`}>
        {workflowWaitingLabel(openedAt, now)}
      </time>
    </p>
  )
}
