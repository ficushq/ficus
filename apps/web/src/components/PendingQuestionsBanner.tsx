import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import type { AgentQuestion } from '@ficus/shared'
import { AgentQuestionCard } from './AgentQuestionCard'
import { Modal } from './Modal'
import { ChevronRightIcon } from './icons'

interface QuestionCardProps {
  question: AgentQuestion
  onAnswering?: (answer: string) => void
  onAnswerError?: () => void
}

interface PendingQuestionsBannerProps {
  /** Undefined until this chat has real query data; an empty array is a loaded baseline. */
  questions: AgentQuestion[] | undefined
  agentName: string
  dependencies?: { QuestionCardComponent?: ComponentType<QuestionCardProps> }
}

/** Keeps one agent's open asynchronous questions visible without putting forms in chat history. */
export function PendingQuestionsBanner({ questions, agentName, dependencies }: PendingQuestionsBannerProps) {
  const QuestionCardComponent = dependencies?.QuestionCardComponent ?? AgentQuestionCard
  const [collapsed, setCollapsed] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const seenQuestionIds = useRef<Set<string> | null>(null)
  const [optimisticallyAnswered, setOptimisticallyAnswered] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!questions) return
    const ids = questions.map((question) => question.id)
    const seen = seenQuestionIds.current
    if (seen === null) {
      // Initial history is not a live arrival. Keep the manual-open behavior on hydration.
      seenQuestionIds.current = new Set(ids)
    } else {
      if (ids.some((id) => !seen.has(id))) setIsOpen(true)
      // Retain IDs across removals/optimistic answers so stale refetches cannot reopen them.
      for (const id of ids) seen.add(id)
    }
  }, [questions])

  useEffect(() => {
    if (!questions) return
    setOptimisticallyAnswered((current) => {
      const currentQuestionIds = new Set(questions.map((question) => question.id))
      const next = new Set([...current].filter((id) => currentQuestionIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [questions])

  const visibleQuestions = useMemo(
    () => questions?.filter((question) => !optimisticallyAnswered.has(question.id)) ?? [],
    [optimisticallyAnswered, questions]
  )

  useEffect(() => {
    if (visibleQuestions.length === 0) setIsOpen(false)
  }, [visibleQuestions.length])

  if (visibleQuestions.length === 0) return null

  const count = visibleQuestions.length
  const label = `${count} pending question${count === 1 ? '' : 's'} from ${agentName}`

  return (
    <>
      <div className="rounded-xl bg-surface text-secondary">
        {collapsed ? (
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            className="ficus-button ficus-button-ghost flex w-full items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold"
            aria-label={`${label}; open details`}
          >
            <span aria-hidden="true">?</span>
            <span>{count}</span>
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setIsOpen(true)}
              className="ficus-button ficus-button-ghost min-w-0 flex-1 rounded-l-lg px-3 py-2 text-left text-sm font-medium"
            >
              {label}
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="ficus-button ficus-button-ghost m-1 rounded-md p-1.5"
              aria-label="Collapse pending questions"
              title="Collapse pending questions"
            >
              <ChevronRightIcon className="h-4 w-4 rotate-90" />
            </button>
          </div>
        )}
      </div>

      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Pending questions" maxWidth="readable">
        <p className="mb-3 text-sm text-muted">Answering each question wakes the agent to continue.</p>
        <div className="space-y-3">
          {visibleQuestions.map((question) => (
            <QuestionCardComponent
              key={question.id}
              question={question}
              onAnswering={() => setOptimisticallyAnswered((current) => new Set(current).add(question.id))}
              onAnswerError={() =>
                setOptimisticallyAnswered((current) => {
                  const next = new Set(current)
                  next.delete(question.id)
                  return next
                })
              }
            />
          ))}
        </div>
      </Modal>
    </>
  )
}
