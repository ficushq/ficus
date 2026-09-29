import clsx from 'clsx'
import { useEffect, useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { isHttpResponseError } from '@ficus/client-core'
import type { AgentQuestionAnswerDelivery, QuestionData, QuestionItem } from '@ficus/shared'
import { Markdown } from '../chat/Markdown'
import { useStableRef } from '../hooks/useStableRef'
import { useActionsApi } from './ActionsApiProvider'
import {
  OTHER_OPTION,
  formatAnswer,
  initialAnswers,
  isAnswerComplete,
  toggleChoice,
  type AnswerValue,
  type Answers,
  type OtherTexts,
} from './answerFormat'
import {
  actionIds,
  reconcileAgentQuestions,
  settleAgentAction,
  settleAgentQuestion,
  settleSquadQuestion,
} from './cache'
import { ErrorNote, VerbButton } from './ui'

/** Where an answer goes. Each source makes the same call the web app makes for it. */
export type QuestionSource =
  /** An async agent question (Action Center "agent-question", pending-questions banner, question waits). */
  | {
      kind: 'agent-question'
      questionId: string
      agentId: string
      squadId: string | null
      answerDelivery?: AgentQuestionAnswerDelivery
    }
  /** A squad agent blocked in waiting-input: the answer is sent as a chat message. */
  | { kind: 'squad-question'; agentId: string; squadId: string }
  /** The blocking question in an agent's chat (`agent.questionData`); the chat sends the answer. */
  | { kind: 'in-chat'; onAnswer: (answer: string) => void | Promise<void> }

export interface QuestionFormProps {
  questionData: QuestionData
  source: QuestionSource
  /** After a successful answer (or delivery retry). */
  onAnswered?: () => void | Promise<void>
  /** Just before an agent-question answer is sent, for optimistic hiding. */
  onAnswering?: (answer: string) => void
  /** An optimistic agent-question answer failed. */
  onAnswerError?: () => void
  /** Offers "Answer & visit robot" (agent questions) or "Visit robot" (squad questions). */
  onOpenAgent?: (agentId: string) => void
}

export function QuestionForm(props: QuestionFormProps) {
  switch (props.source.kind) {
    case 'agent-question':
      return <AgentQuestionForm {...props} source={props.source} />
    case 'squad-question':
      return <SquadQuestionForm {...props} source={props.source} />
    case 'in-chat':
      return <InChatQuestionForm questionData={props.questionData} onAnswer={props.source.onAnswer} />
  }
}

function AgentQuestionForm({
  questionData,
  source,
  onAnswered,
  onAnswering,
  onAnswerError,
  onOpenAgent,
}: QuestionFormProps & { source: Extract<QuestionSource, { kind: 'agent-question' }> }) {
  const api = useActionsApi()
  const queryClient = useQueryClient()
  const { questionId, agentId, squadId } = source
  // Mutations keep the options from mutate time; read the latest callbacks instead.
  const callbacks = useStableRef({ onAnswered, onAnswerError, onOpenAgent })
  const settleAnswered = () =>
    settleAgentAction(queryClient, { actionId: actionIds.agentQuestion(questionId), agentId, squadId, question: true })

  const answer = useMutation({
    mutationFn: ({ answer }: { answer: string; visit: boolean }) => api.answerAgentQuestion(questionId, answer),
    onSuccess: async (_result, { visit }) => {
      await settleAnswered()
      await callbacks.current.onAnswered?.()
      if (visit) callbacks.current.onOpenAgent?.(agentId)
    },
    onError: () => callbacks.current.onAnswerError?.(),
  })
  const dismiss = useMutation({
    mutationFn: () => api.dismissAgentQuestion(questionId),
    onSuccess: () => settleAgentQuestion(queryClient, questionId),
    onError: async (error) => {
      if (isHttpResponseError(error, 404) || isHttpResponseError(error, 409)) await reconcileAgentQuestions(queryClient)
    },
  })
  const retry = useMutation({
    mutationFn: () => api.retryAgentQuestionAnswerDelivery(questionId),
    onSuccess: async () => {
      await settleAnswered()
      await callbacks.current.onAnswered?.()
    },
  })

  if (source.answerDelivery?.status === 'failed') {
    return (
      <div className="g-action">
        <p className="g-action-note">Your answer was saved, but it didn't reach the robot.</p>
        <ErrorNote error={retry.error} />
        {source.answerDelivery.canRetry && (
          <VerbButton
            verb="Send again"
            busyVerb="Sending again…"
            help="Retry delivering your answer"
            tone="primary"
            busy={retry.isPending}
            onClick={() => retry.mutate()}
          />
        )}
      </div>
    )
  }

  const noLongerPending = isHttpResponseError(dismiss.error, 404) || isHttpResponseError(dismiss.error, 409)
  return (
    <div className="g-action">
      <ErrorNote
        error={dismiss.error ?? answer.error}
        message={noLongerPending ? 'This question is no longer waiting for you.' : undefined}
      />
      <QuestionFields
        questionData={questionData}
        disabled={answer.isPending || dismiss.isPending}
        busy={answer.isPending}
        onSubmit={(value) => {
          onAnswering?.(value)
          answer.mutate({ answer: value, visit: false })
        }}
        secondary={
          onOpenAgent
            ? {
                verb: 'Answer & visit',
                help: "Send, then open the robot's chat",
                onSubmit: (value) => {
                  onAnswering?.(value)
                  answer.mutate({ answer: value, visit: true })
                },
              }
            : undefined
        }
        onDismiss={() => dismiss.mutate()}
        dismissBusy={dismiss.isPending}
      />
    </div>
  )
}

function SquadQuestionForm({
  questionData,
  source,
  onAnswered,
  onOpenAgent,
}: QuestionFormProps & { source: Extract<QuestionSource, { kind: 'squad-question' }> }) {
  const api = useActionsApi()
  const queryClient = useQueryClient()
  const onAnsweredRef = useStableRef(onAnswered)
  const send = useMutation({
    // Same call as the web's sendAgentMessage(agentId, answer) in ActionItem.
    mutationFn: (answer: string) =>
      api.sendAgentMessage(source.agentId, answer, { imageIds: undefined, deliveryMode: undefined }),
    onSuccess: async () => {
      await settleSquadQuestion(queryClient, source.agentId)
      await onAnsweredRef.current?.()
    },
  })
  return (
    <div className="g-action">
      <ErrorNote error={send.error} />
      <QuestionFields
        questionData={questionData}
        disabled={send.isPending}
        busy={send.isPending}
        onSubmit={(answer) => send.mutate(answer)}
      />
      {onOpenAgent && (
        <VerbButton
          verb="Visit robot"
          help="Open the conversation"
          tone="quiet"
          onClick={() => onOpenAgent(source.agentId)}
        />
      )}
    </div>
  )
}

function InChatQuestionForm({
  questionData,
  onAnswer,
}: {
  questionData: QuestionData
  onAnswer: (answer: string) => void | Promise<void>
}) {
  const onAnswerRef = useStableRef(onAnswer)
  const send = useMutation({ mutationFn: async (answer: string) => onAnswerRef.current(answer) })
  if (send.isPending || send.isSuccess) {
    return (
      <p className="g-action-note" role="status">
        {send.isPending ? 'Sending your answer…' : 'Answer sent. The robot is back at work.'}
      </p>
    )
  }
  return (
    <div className="g-action">
      <p className="g-action-note">This robot is waiting for your answer before it can continue.</p>
      <ErrorNote error={send.error} />
      <QuestionFields questionData={questionData} onSubmit={(answer) => send.mutate(answer)} />
    </div>
  )
}

interface QuestionFieldsProps {
  questionData: QuestionData
  onSubmit: (answer: string) => void
  disabled?: boolean
  busy?: boolean
  secondary?: { verb: string; help: string; onSubmit: (answer: string) => void }
  onDismiss?: () => void
  dismissBusy?: boolean
}

/** The question inputs plus submit buttons; submits the web-identical answer string. */
export function QuestionFields({
  questionData,
  onSubmit,
  disabled = false,
  busy = false,
  secondary,
  onDismiss,
  dismissBusy = false,
}: QuestionFieldsProps) {
  const [answers, setAnswers] = useState<Answers>(() => initialAnswers(questionData))
  // Dismissing throws the question away, so it takes a second click (within a few seconds).
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  useEffect(() => {
    if (!confirmDismiss) return
    const timer = window.setTimeout(() => setConfirmDismiss(false), DISMISS_CONFIRM_MS)
    return () => window.clearTimeout(timer)
  }, [confirmDismiss])
  const [otherTexts, setOtherTexts] = useState<OtherTexts>({})
  const complete = isAnswerComplete(questionData, answers, otherTexts)
  const canSubmit = !disabled && complete
  const submit = (to: (answer: string) => void = onSubmit) => {
    if (canSubmit) to(formatAnswer(questionData, answers, otherTexts))
  }
  const many = questionData.questions.length > 1

  return (
    <form
      className="g-question-form"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {questionData.questions.map((question) => (
        <QuestionField
          key={question.id}
          question={question}
          value={answers[question.id]}
          otherText={otherTexts[question.id] ?? ''}
          disabled={disabled}
          onChange={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))}
          onOtherTextChange={(text) => setOtherTexts((current) => ({ ...current, [question.id]: text }))}
          onSubmitShortcut={() => submit()}
        />
      ))}
      <div className="g-action-row">
        <VerbButton
          type="submit"
          verb="Answer"
          busyVerb="Answering…"
          help={many ? 'Send your answers' : 'Send your answer'}
          tone="primary"
          busy={busy}
          disabled={!canSubmit}
        />
        {secondary && (
          <VerbButton
            verb={secondary.verb}
            help={secondary.help}
            disabled={!canSubmit || busy}
            onClick={() => submit(secondary.onSubmit)}
          />
        )}
        {onDismiss && (
          <VerbButton
            verb={confirmDismiss ? 'Really dismiss?' : 'Dismiss'}
            busyVerb="Dismissing…"
            help={confirmDismiss ? 'Click again to close it unanswered' : 'Close without answering'}
            tone={confirmDismiss ? 'prune' : 'quiet'}
            busy={dismissBusy}
            disabled={disabled}
            onClick={() => {
              if (!confirmDismiss) return setConfirmDismiss(true)
              setConfirmDismiss(false)
              onDismiss()
            }}
          />
        )}
      </div>
    </form>
  )
}

/** How long Dismiss waits for its confirming second click, ms. */
const DISMISS_CONFIRM_MS = 4000

function QuestionField({
  question,
  value,
  otherText,
  disabled,
  onChange,
  onOtherTextChange,
  onSubmitShortcut,
}: {
  question: QuestionItem
  value: AnswerValue | undefined
  otherText: string
  disabled: boolean
  onChange: (value: AnswerValue) => void
  onOtherTextChange: (text: string) => void
  onSubmitShortcut: () => void
}) {
  const id = useId()
  const textValue = typeof value === 'string' ? value : ''
  const listValue = Array.isArray(value) ? value : []
  const heading = (
    <>
      {question.question}
      {question.optional && <span className="g-question-optional"> (optional)</span>}
    </>
  )
  // Agents write context in markdown, with links to work streams and agents (farm chips).
  const context = question.context ? (
    <div id={`${id}-context`}>
      <Markdown className="g-question-context">{question.context}</Markdown>
    </div>
  ) : null
  const describedBy = question.context ? `${id}-context` : undefined
  const otherInput = (
    <input
      className="g-input g-question-other"
      aria-label={`Your own answer to: ${question.question}`}
      placeholder="Type your own answer…"
      value={otherText}
      disabled={disabled}
      onChange={(event) => onOtherTextChange(event.target.value)}
    />
  )

  if (question.type === 'text') {
    const suggestions = question.options ?? []
    return (
      <div className="g-question">
        <label className="g-question-title" htmlFor={`${id}-text`}>
          {heading}
        </label>
        {context}
        {suggestions.length > 0 && (
          <div className="g-chips" role="group" aria-label="Suggested answers">
            {suggestions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={clsx('g-chip', textValue === option.value && 'g-chip-on')}
                aria-pressed={textValue === option.value}
                disabled={disabled}
                onClick={() => onChange(option.value)}
              >
                {option.label ?? option.value}
              </button>
            ))}
          </div>
        )}
        <textarea
          id={`${id}-text`}
          className="g-textarea"
          rows={4}
          placeholder="Type your answer…"
          aria-describedby={describedBy}
          value={textValue}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              onSubmitShortcut()
            }
          }}
        />
      </div>
    )
  }

  const multi = question.type === 'multi-select'
  const isOn = (option: string) => (multi ? listValue.includes(option) : textValue === option)
  const pick = (option: string) => onChange(multi ? toggleChoice(value, option) : option)
  const choices = [
    ...(question.options ?? []).map((option) => ({ value: option.value, label: option.label ?? option.value })),
    { value: OTHER_OPTION, label: 'Something else' },
  ]
  return (
    <fieldset className="g-question" aria-describedby={describedBy}>
      <legend className="g-question-title">{heading}</legend>
      {context}
      {multi && <p className="g-question-hint">Pick all that apply.</p>}
      <div className="g-options">
        {choices.map((choice) => (
          <label key={choice.value} className={clsx('g-option', isOn(choice.value) && 'g-option-on')}>
            <input
              type={multi ? 'checkbox' : 'radio'}
              name={`${id}-choice`}
              value={choice.value}
              checked={isOn(choice.value)}
              disabled={disabled}
              onChange={() => pick(choice.value)}
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </div>
      {isOn(OTHER_OPTION) && otherInput}
    </fieldset>
  )
}
