import type { QuestionAnswerCardData, ResolvedQuestionAnswer } from '@ficus/shared'
import { fullTimestamp, messageTimeLabel, toMessageDate } from '../lib/chatTimestamps'
import { QuestionIcon } from './icons'

/**
 * Each question with the answer the human gave, as option labels (not stored values). All text is
 * rendered as plain text: questions and labels are agent-authored, never markdown or HTML.
 */
export function QuestionAnswerList({ questions }: { questions: ResolvedQuestionAnswer[] }) {
  return (
    <dl className="space-y-2.5">
      {questions.map((item) => (
        <div key={item.questionId} className="min-w-0">
          <dt className="whitespace-pre-wrap break-words text-xs text-secondary">{item.question || item.questionId}</dt>
          <dd className="mt-0.5">
            {item.choices.length === 0 ? (
              <span className="text-sm italic text-muted">Skipped</span>
            ) : item.choices.length === 1 ? (
              <span className="whitespace-pre-wrap break-words text-sm font-medium text-primary">
                {item.choices[0].label}
              </span>
            ) : (
              <ul className="flex flex-wrap gap-1" aria-label="Chosen options">
                {item.choices.map((choice, index) => (
                  <li
                    key={`${index}:${choice.value ?? choice.label}`}
                    className="max-w-full whitespace-pre-wrap break-words rounded-full border border-accent/30 bg-chrome-paper/70 px-2 py-0.5 text-xs font-medium text-primary dark:bg-chrome-scrim/20"
                  >
                    {choice.label}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A human's answer to the agent's ask_human question, delivered into the agent's chat. Replaces
 * the generic inbox card for that delivery: who answered and when, then each question and answer.
 */
export function QuestionAnswerDeliveryCard({ data }: { data: QuestionAnswerCardData }) {
  const answeredAt = toMessageDate(data.answeredAt)
  return (
    <div className="flex w-full flex-col items-end gap-1" aria-label="Question answer">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
        <QuestionIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">
          {data.answeredBy ? `Answered by ${data.answeredBy}` : 'Question answered'}
          {answeredAt && (
            <>
              {' · '}
              <time className="whitespace-nowrap" dateTime={answeredAt.toISOString()} title={fullTimestamp(answeredAt)}>
                {messageTimeLabel(answeredAt)}
              </time>
            </>
          )}
        </span>
      </div>
      <div className="w-full rounded-lg border border-accent/30 bg-accent/10 px-3 py-2.5 text-left">
        <QuestionAnswerList questions={data.questions} />
      </div>
    </div>
  )
}
