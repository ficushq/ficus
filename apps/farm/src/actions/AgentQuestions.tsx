import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { isHttpResponseError, queryKeys } from '@ficus/client-core'
import type { AgentQuestion, WorkStreamWait } from '@ficus/shared'
import { useActionsApi } from './ActionsApiProvider'
import { QuestionForm } from './QuestionForm'
import { actionQueries } from './queries'
import { ChevronIcon } from '../icons'
import { VerbButton } from './ui'

function questionSource(question: AgentQuestion) {
  return {
    kind: 'agent-question' as const,
    questionId: question.id,
    agentId: question.agentId,
    squadId: question.squadId,
    answerDelivery: question.answerDelivery,
  }
}

/**
 * One robot's open async questions, answerable in place (mirrors the web's
 * PendingQuestionsBanner). Answered questions hide at once and reappear if the
 * answer fails.
 */
export function AgentPendingQuestions({
  agentId,
  agentName,
  onOpenAgent,
  collapsible = false,
}: {
  agentId: string
  agentName: string
  onOpenAgent?: (agentId: string) => void
  /** Folded to one "N pending questions" row until opened (as in a chat, like the web's banner). */
  collapsible?: boolean
}) {
  const [open, setOpen] = useState(!collapsible)
  const api = useActionsApi()
  const { data: questions = [] } = useQuery(actionQueries.openAgentQuestions(api, agentId))
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const visible = useMemo(() => questions.filter((question) => !hidden.has(question.id)), [questions, hidden])
  if (visible.length === 0) return null
  const setHiddenFor = (id: string, hide: boolean) =>
    setHidden((current) => {
      const next = new Set(current)
      if (hide) next.add(id)
      else next.delete(id)
      return next
    })
  const count = `${visible.length} pending question${visible.length === 1 ? '' : 's'}`
  if (collapsible && !open)
    return (
      <section className="g-action g-questions-folded" aria-label={`Questions from ${agentName}`}>
        <button type="button" className="g-questions-toggle" aria-expanded={false} onClick={() => setOpen(true)}>
          <ChevronIcon className="g-chevron" />
          <span aria-hidden="true">❓</span> {count} from {agentName}
        </button>
      </section>
    )
  return (
    <section className="g-action" aria-label={`Questions from ${agentName}`}>
      {collapsible && (
        <button type="button" className="g-questions-toggle" aria-expanded onClick={() => setOpen(false)}>
          <ChevronIcon className="g-chevron g-open" />
          <span aria-hidden="true">❓</span> {count} from {agentName}
        </button>
      )}
      <p className="g-action-note">
        {/* Folded, the row above already says how many. */}
        {collapsible ? '' : `${visible.length} question${visible.length === 1 ? '' : 's'} from ${agentName}. `}
        Answering each one wakes the robot to continue.
      </p>
      {visible.map((question) => (
        <div key={question.id} className="g-action-sub">
          <QuestionForm
            questionData={question.questionData}
            source={questionSource(question)}
            onAnswering={() => setHiddenFor(question.id, true)}
            onAnswerError={() => setHiddenFor(question.id, false)}
            onOpenAgent={onOpenAgent}
          />
        </div>
      ))}
    </section>
  )
}

/**
 * A work stream's open `question` wait (mirrors the web's WorkStreamQuestionWait):
 * the wait references an agent question, found through the asking agent's
 * open-question list and answered in place.
 */
export function StreamQuestionWait({
  wait,
  onOpenAgent,
  onAnswered,
}: {
  wait: WorkStreamWait
  onOpenAgent?: (agentId: string) => void
  onAnswered?: () => void | Promise<void>
}) {
  const api = useActionsApi()
  const queryClient = useQueryClient()
  const agentId = wait.createdByAgentId
  const questions = useQuery({
    ...actionQueries.openAgentQuestions(api, agentId ?? ''),
    enabled: Boolean(agentId && wait.referenceId),
  })
  if (!agentId || !wait.referenceId) return null

  const visit = onOpenAgent ? (
    <VerbButton verb="Visit robot" help="Open the conversation" tone="quiet" onClick={() => onOpenAgent(agentId)} />
  ) : null

  if (questions.isPending) return <p className="g-action-note">Fetching the question…</p>
  if (questions.isError) {
    const forbidden = isHttpResponseError(questions.error, 403)
    return (
      <div className="g-action">
        <p className="g-action-note">
          {forbidden ? "You can't view this robot's questions." : "Couldn't load this question."}
        </p>
        {visit}
      </div>
    )
  }
  const question = questions.data.find((candidate) => candidate.id === wait.referenceId)
  if (!question) {
    return <p className="g-action-note">Already answered. The wait clears once the robot picks the answer up.</p>
  }
  return (
    <div className="g-action">
      <QuestionForm
        questionData={question.questionData}
        source={questionSource(question)}
        onAnswered={async () => {
          await queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
          await onAnswered?.()
        }}
      />
      {visit}
    </div>
  )
}
