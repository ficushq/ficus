import { useQueries } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { AssistantActivityUpdate, AssistantTaskSummary } from '@ficus/shared'
import { queries } from '../queryOptions'
import { MarkdownContent } from './MarkdownContent'
import { PendingQuestionsBanner } from './PendingQuestionsBanner'
import { QuestionInput } from './QuestionInput'
import { actionErrorMessage } from '../lib/actionError'

/** Ordinary ask_human questions use the same answer/delivery path as every other agent chat. */
export function AssistantAgentQuestions({ agentIds }: { agentIds: string[] }) {
  const results = useQueries({ queries: agentIds.map((id) => queries.agentQuestions.byAgent(id, 'open')) })
  return results.map((result, index) =>
    result.data?.length ? (
      <PendingQuestionsBanner key={agentIds[index]} questions={result.data} agentName="Assistant task" />
    ) : null
  )
}

export interface AssistantTaskQuestionsProps {
  tasks: AssistantTaskSummary[]
  updates: AssistantActivityUpdate[]
  focusTaskId?: string
  onReply: (task: AssistantTaskSummary, update: AssistantActivityUpdate, answer: string) => Promise<void>
}

/** Read/processed are presentation receipts, never answers. Only a task state change settles a question. */
export function AssistantTaskQuestions({ tasks, updates, focusTaskId, onReply }: AssistantTaskQuestionsProps) {
  const questions = tasks.flatMap((task) => {
    if (task.status !== 'needs-input') return []
    const update = updates
      .filter(
        (row) =>
          row.taskId === task.id && row.requestId === task.currentRequestId && row.reportedStatus === 'needs-input'
      )
      .sort((a, b) => b.sequence - a.sequence)[0]
    return update ? [{ task, update }] : []
  })
  return questions.map(({ task, update }) => (
    <TaskQuestion
      key={`${task.id}:${update.messageId}`}
      task={task}
      update={update}
      focused={focusTaskId === task.id}
      onReply={onReply}
    />
  ))
}

function TaskQuestion({
  task,
  update,
  focused,
  onReply,
}: {
  task: AssistantTaskSummary
  update: AssistantActivityUpdate
  focused: boolean
  onReply: AssistantTaskQuestionsProps['onReply']
}) {
  const details = useRef<HTMLDetailsElement>(null)
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!focused || !details.current) return
    details.current.open = true
    details.current.querySelector('textarea')?.focus({ preventScroll: true })
    const region = details.current.closest<HTMLElement>('[data-assistant-questions]')
    if (region) region.scrollTop += details.current.getBoundingClientRect().top - region.getBoundingClientRect().top
  }, [focused])
  if (sent)
    return (
      <p role="status" className="py-2 text-sm text-muted">
        Answer sent to {task.label}.
      </p>
    )
  return (
    <details ref={details} open className="min-w-0 rounded-xl bg-surface p-3 [overflow-wrap:anywhere]">
      <summary className="cursor-pointer text-sm font-medium text-accent-light">
        {task.label} · Needs your answer
      </summary>
      <MarkdownContent className="my-3 text-sm">{update.content}</MarkdownContent>
      {task.unavailable || !task.agentId ? (
        <p role="status" className="text-sm text-muted">
          This task’s agent is unavailable. Start a new task to continue.
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="mb-2 text-sm text-danger">
              {error}
            </p>
          )}
          <QuestionInput
            questionData={{ questions: [{ id: 'answer', type: 'text', question: 'Your answer' }] }}
            disabled={busy}
            onSubmit={async (answer) => {
              if (submitting.current) return
              submitting.current = true
              setBusy(true)
              setError(undefined)
              try {
                await onReply(task, update, answer)
                setSent(true)
              } catch (cause) {
                setError(actionErrorMessage(cause))
              } finally {
                submitting.current = false
                setBusy(false)
              }
            }}
          />
        </>
      )}
    </details>
  )
}
