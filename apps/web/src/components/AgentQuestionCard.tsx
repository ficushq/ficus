import clsx from 'clsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { isHttpResponseError } from '@ficus/client-core'
import type { AgentQuestion } from '@ficus/shared'
import { answerAgentQuestion, dismissAgentQuestion } from '../api/agentQuestions'
import { queryKeys } from '../queryKeys'
import { QuestionInput } from './QuestionInput'
import { actionErrorMessage } from '../lib/actionError'

interface Props {
  question: AgentQuestion
  /** The surrounding action already supplies a surface and padding. */
  embedded?: boolean
  /** Called immediately before an answer request, for optimistic UI updates. */
  onAnswering?: (answer: string) => void
  /** Called after a successful answer via the primary "Confirm" button. */
  onAnswered?: () => void | Promise<void>
  /** Called if an optimistic answer request fails. */
  onAnswerError?: () => void
  /** Optional second button (e.g. Action Center "Confirm + go to agent"). */
  secondaryAction?: { label: string; onAnswered: () => void | Promise<void> }
}

/**
 * Renders an agent question. Open questions show the answer form (QuestionInput); answered questions
 * render read-only (used in the context tab history).
 */
export function AgentQuestionCard({
  question,
  onAnswering,
  onAnswered,
  onAnswerError,
  secondaryAction,
  embedded = false,
}: Props) {
  const queryClient = useQueryClient()
  const reconcileQuestion = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.agentQuestions.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() }),
    ])
  const settleQuestion = async () => {
    const actionId = `agent-question:${question.id}`
    queryClient.setQueryData<import('@ficus/shared').PendingAction[]>(queryKeys.actions.pending(), (current) =>
      current?.filter((action) => action.id !== actionId)
    )
    await reconcileQuestion()
  }
  const answerMutation = useMutation({
    mutationFn: ({ answer }: { answer: string; intent: 'primary' | 'secondary' }) =>
      answerAgentQuestion(question.id, answer),
    onSuccess: async (_result, { intent }) => {
      await settleQuestion()
      if (intent === 'secondary') await secondaryAction?.onAnswered()
      else await onAnswered?.()
    },
    onError: () => onAnswerError?.(),
  })
  const dismissMutation = useMutation({
    mutationFn: () => dismissAgentQuestion(question.id),
    onSuccess: settleQuestion,
    onError: async (error) => {
      if (isHttpResponseError(error, 404) || isHttpResponseError(error, 409)) await reconcileQuestion()
    },
  })
  const dismissalNoLongerPending =
    isHttpResponseError(dismissMutation.error, 404) || isHttpResponseError(dismissMutation.error, 409)

  if (question.status === 'dismissed') {
    return (
      <div className={clsx('space-y-1 text-sm', !embedded && 'rounded-xl bg-surface p-4')}>
        <div className="text-xs text-muted mb-1">Dismissed question</div>
        {question.questionData.questions.map((q) => (
          <p key={q.id} className="font-medium text-primary">
            {q.question}
          </p>
        ))}
        {question.dismissalReason && <p className="mt-1 text-xs text-muted">{question.dismissalReason}</p>}
      </div>
    )
  }

  if (question.status === 'answered') {
    return (
      <div className={clsx('space-y-1 text-sm', !embedded && 'rounded-xl bg-surface p-4')}>
        <div className="text-xs text-muted mb-1">Answered question</div>
        {question.questionData.questions.map((q) => (
          <p key={q.id} className="font-medium text-primary">
            {q.question}
          </p>
        ))}
        {question.answer && <p className="mt-1 text-secondary whitespace-pre-wrap">{question.answer}</p>}
      </div>
    )
  }

  return (
    <div className={clsx(!embedded && 'rounded-xl bg-surface p-4')}>
      {(answerMutation.isError || dismissMutation.isError) && (
        <p role="alert" className="mb-2 text-xs text-status-danger-600">
          {dismissalNoLongerPending
            ? 'This action is no longer pending.'
            : actionErrorMessage(dismissMutation.error ?? answerMutation.error)}
        </p>
      )}
      <QuestionInput
        questionData={question.questionData}
        disabled={answerMutation.isPending || dismissMutation.isPending}
        onSubmit={(answer) => {
          onAnswering?.(answer)
          answerMutation.mutate({ answer, intent: 'primary' })
        }}
        onDismiss={() => dismissMutation.mutate()}
        secondaryAction={
          secondaryAction
            ? {
                label: secondaryAction.label,
                onSubmit: (answer) => answerMutation.mutate({ answer, intent: 'secondary' }),
              }
            : undefined
        }
      />
    </div>
  )
}
