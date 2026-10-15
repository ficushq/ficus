import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import type { AgentQuestion } from '@ficus/shared'
import { AgentQuestionCard } from './AgentQuestionCard'
import { Modal } from './Modal'
import { ChevronRightIcon, QuestionIcon } from './icons'
import clsx from 'clsx'

interface QuestionCardProps {
  question: AgentQuestion
  onAnswering?: (answer: string) => void
  onAnswerError?: () => void
}

interface PendingQuestionsBannerProps {
  /** Undefined until this chat has real query data; an empty array is a loaded baseline. */
  questions: AgentQuestion[] | undefined
  /** Placement classes for the card (width, margins). */
  className?: string
  dependencies?: { QuestionCardComponent?: ComponentType<QuestionCardProps> }
}

/** Keeps one agent's open asynchronous questions visible without putting forms in chat history. */
export function PendingQuestionsBanner({ questions, className, dependencies }: PendingQuestionsBannerProps) {
  const QuestionCardComponent = dependencies?.QuestionCardComponent ?? AgentQuestionCard
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
  const countLabel = `${count} pending question${count === 1 ? '' : 's'}`
  // Agent-written text: shown as plain text only, never as markdown or HTML.
  const questionText = count === 1 ? (visibleQuestions[0].questionData?.questions?.[0]?.question ?? '') : ''
  const preview = previewLine(questionText)
  const fullText = collapseWhitespace(questionText)
  const label = fullText
    ? `${countLabel}: ${fullText}${/[.?!…]$/.test(fullText) ? '' : '.'} Open to answer`
    : `${countLabel}. Open to answer`

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={clsx(
          // An opaque floating card, so chat text scrolling behind it never looks clipped.
          'ficus-button ficus-button-ghost flex w-full min-w-0 items-center gap-1.5 rounded-xl border border-th-border bg-surface px-3 py-2 text-left text-sm shadow-md hover:bg-surface-hover',
          className
        )}
        aria-label={label}
        title={label}
      >
        <QuestionIcon className="h-4 w-4 shrink-0" />
        <span className="shrink-0 whitespace-nowrap font-medium">{countLabel}</span>
        {/* One line: only the preview shrinks, ending in an ellipsis; the full text stays in the title. */}
        <span className="min-w-0 flex-1 truncate text-muted">
          {preview && (
            <>
              <span aria-hidden="true">· </span>
              {preview}
            </>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted">
          <span className="hidden sm:inline">Answer</span>
          <ChevronRightIcon className="h-4 w-4" />
        </span>
      </button>

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

function collapseWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

/** The first non-blank line of the question, whitespace collapsed. */
function previewLine(text: string) {
  return collapseWhitespace(text.split('\n').find((line) => line.trim()) ?? '')
}
