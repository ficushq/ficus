import { useId, useState } from 'react'
import clsx from 'clsx'
import type { QuestionData, QuestionItem } from '@ficus/shared'
import {
  OTHER,
  answersComplete,
  formatAnswer,
  initialAnswers,
  type AnswerValue,
  type Answers,
  type OtherTexts,
} from './answerFormat'
import { Markdown } from './Markdown'

interface FieldProps {
  question: QuestionItem
  value: AnswerValue
  otherText: string
  disabled: boolean
  autoFocus: boolean
  onChange: (value: AnswerValue) => void
  onOtherText: (text: string) => void
  onSubmitShortcut: () => void
}

function OtherInput({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  disabled: boolean
}) {
  return (
    <input
      type="text"
      className="g-chat-field g-chat-other"
      aria-label="Other answer"
      placeholder="Enter your answer..."
      value={value}
      disabled={disabled}
      autoFocus
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function Field({
  question,
  value,
  otherText,
  disabled,
  autoFocus,
  onChange,
  onOtherText,
  onSubmitShortcut,
}: FieldProps) {
  const labelId = useId()
  const text = typeof value === 'string' ? value : ''
  const selected = Array.isArray(value) ? value : []
  const suggestions = question.type === 'text' ? (question.options ?? []) : []

  return (
    <fieldset className="g-chat-question" aria-labelledby={labelId}>
      <legend id={labelId} className="g-chat-question-label">
        {question.question}
        {question.optional && <span className="g-chat-optional"> (optional)</span>}
      </legend>
      {question.context && <Markdown className="g-chat-question-context">{question.context}</Markdown>}

      {suggestions.length > 0 && (
        <div className="g-chat-chips" role="group" aria-label="Suggested answers">
          {suggestions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={clsx('g-chat-chip', text === option.value && 'g-selected')}
              aria-pressed={text === option.value}
              disabled={disabled}
              onClick={() => onChange(option.value)}
            >
              {option.label ?? option.value}
            </button>
          ))}
        </div>
      )}

      {question.type === 'text' && (
        <textarea
          className="g-chat-field"
          aria-labelledby={labelId}
          rows={4}
          value={text}
          placeholder="Type your answer..."
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              onSubmitShortcut()
            }
          }}
        />
      )}

      {question.type === 'select' && (
        <div className="g-chat-options">
          {[...(question.options ?? []), { value: OTHER, label: 'Other' }].map((option, i) => (
            <label key={option.value} className={clsx('g-chat-option', text === option.value && 'g-selected')}>
              <input
                type="radio"
                name={`${labelId}-choice`}
                value={option.value}
                checked={text === option.value}
                disabled={disabled}
                autoFocus={autoFocus && i === 0}
                onChange={(e) => onChange(e.target.value)}
              />
              <span>{option.label ?? option.value}</span>
            </label>
          ))}
          {text === OTHER && <OtherInput value={otherText} onChange={onOtherText} disabled={disabled} />}
        </div>
      )}

      {question.type === 'multi-select' && (
        <div className="g-chat-options">
          <p className="g-chat-note">Select all that apply:</p>
          {[...(question.options ?? []), { value: OTHER, label: 'Other' }].map((option, i) => {
            const on = selected.includes(option.value)
            return (
              <label key={option.value} className={clsx('g-chat-option', on && 'g-selected')}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled}
                  autoFocus={autoFocus && i === 0}
                  onChange={() =>
                    onChange(on ? selected.filter((v) => v !== option.value) : [...selected, option.value])
                  }
                />
                <span>{option.label ?? option.value}</span>
              </label>
            )
          })}
          {selected.includes(OTHER) && <OtherInput value={otherText} onChange={onOtherText} disabled={disabled} />}
        </div>
      )}
    </fieldset>
  )
}

/**
 * The agent's blocking `ask_human` question, answered inline. Submits the
 * answer string built by the web's QuestionInput rules (see answerFormat.ts).
 */
export function QuestionCard({
  questionData,
  disabled = false,
  onSubmit,
}: {
  questionData: QuestionData
  disabled?: boolean
  onSubmit: (answer: string) => void
}) {
  const questions = questionData.questions
  const [answers, setAnswers] = useState<Answers>(() => initialAnswers(questions))
  const [otherTexts, setOtherTexts] = useState<OtherTexts>({})
  const valid = answersComplete(questions, answers, otherTexts)
  const submit = () => {
    if (disabled || !valid) return
    onSubmit(formatAnswer(questions, answers, otherTexts))
  }

  return (
    <section className="g-chat-ask" aria-label="The robot needs your input">
      <p className="g-chat-ask-title">
        <span className="g-chat-ask-mark" aria-hidden="true">
          ?
        </span>
        Needs your input
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {questions.map((q, i) => (
          <Field
            key={q.id}
            question={q}
            value={answers[q.id] ?? ''}
            otherText={otherTexts[q.id] ?? ''}
            disabled={disabled}
            autoFocus={i === 0}
            onChange={(value) => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
            onOtherText={(text) => setOtherTexts((prev) => ({ ...prev, [q.id]: text }))}
            onSubmitShortcut={submit}
          />
        ))}
        <button type="submit" className="g-button g-button-primary g-chat-ask-submit" disabled={disabled || !valid}>
          {questions.length > 1 ? 'Submit answers' : 'Submit answer'}
        </button>
      </form>
    </section>
  )
}
