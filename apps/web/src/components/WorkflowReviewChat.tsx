import { useContext, useState } from 'react'
import clsx from 'clsx'
import type { WorkflowRunDetail } from '@ficus/client-core'
import type { WorkflowAttempt } from '@ficus/shared'
import { attemptSummary } from '../lib/workflowReview'
import { ReviewConversationContext, type ReviewConversationProps } from '../lib/reviewConversation'
import { AgentConversation } from './AgentConversation'

/** The agent's own conversation: the same agent and session as its full chat page. */
function AgentReviewConversation({ agentId, sendOptions, placeholder }: ReviewConversationProps) {
  return (
    <AgentConversation
      agentId={agentId}
      embedded
      enableFullscreen={false}
      sendOptions={sendOptions}
      placeholder={placeholder}
    />
  )
}

/**
 * The review screen's chat with the agent whose completed attempt feeds the gate. Messages from a
 * person who may decide carry the review consultation, so the agent knows the gate and attempt under
 * review and may refine its result with `amend`. Several producing agents (a join) get a picker.
 */
export function WorkflowReviewChat({
  workStreamId,
  gateAttemptId,
  run,
  agents,
  consult,
}: {
  workStreamId: string
  gateAttemptId: number
  run: WorkflowRunDetail
  agents: Array<{ agentId: string; sources: WorkflowAttempt[] }>
  /** Whether the viewer may decide this gate, and so consults the agent as its reviewer. */
  consult: boolean
}) {
  const Conversation = useContext(ReviewConversationContext) ?? AgentReviewConversation
  const [selected, setSelected] = useState(agents[0]?.agentId)
  const current = agents.find((entry) => entry.agentId === selected) ?? agents[0]
  if (!current) return null
  const label = (entry: (typeof agents)[number]) =>
    entry.sources.map((source) => attemptSummary(run.state, source)).join(', ')
  return (
    <section aria-label="Agent chat" data-review-chat className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-panel-border px-4 py-2">
        <p className="text-xs text-muted">
          {consult
            ? 'The agent can refine this proposal while the review stays open.'
            : 'Chat with the agent that produced this work.'}
        </p>
        {agents.length > 1 && (
          <div role="group" aria-label="Agent" className="flex flex-wrap gap-1.5">
            {agents.map((entry) => (
              <button
                key={entry.agentId}
                type="button"
                aria-pressed={entry.agentId === current.agentId}
                onClick={() => setSelected(entry.agentId)}
                className={clsx(
                  'ficus-button min-h-6 px-2.5 py-1 text-xs',
                  entry.agentId === current.agentId ? 'ficus-button-primary' : 'ficus-button-secondary'
                )}
              >
                {label(entry)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <Conversation
          key={current.agentId}
          agentId={current.agentId}
          placeholder={consult ? 'Ask about this proposal or request a refinement' : 'Message the agent'}
          sendOptions={() => (consult ? { reviewConsultation: { workStreamId, gateAttemptId } } : undefined)}
        />
      </div>
    </section>
  )
}
