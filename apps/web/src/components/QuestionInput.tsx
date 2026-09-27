import { useVoiceEnabled } from '../hooks/useVoiceEnabled'
import clsx from 'clsx'
import { useCallback, useRef, useState } from 'react'
import type { QuestionData, QuestionItem } from '@ficus/shared'
import { useVoiceRecorder, type RecorderState } from '../hooks/useVoiceRecorder'
import { useVoiceKeyboardShortcuts } from '../hooks/useVoiceKeyboardShortcuts'
import { useStableRef } from '../hooks/useStableRef'
import { transcribeAudio } from '../api/transcribe'
import { VoiceMicButton } from './VoiceMicButton'
import { MarkdownContent } from './MarkdownContent'

interface QuestionInputProps {
  questionData: QuestionData
  onSubmit: (answer: string) => void
  disabled?: boolean
  /** Optional second submit button (e.g. "Confirm + go to agent") that receives the same answer. */
  secondaryAction?: { label: string; onSubmit: (answer: string) => void }
  /** Optional destructive action that dismisses the question without answering. */
  onDismiss?: () => void
}

type Answers = Record<string, string | string[]>

export function QuestionInput({ questionData, onSubmit, disabled, secondaryAction, onDismiss }: QuestionInputProps) {
  // Initialize answers from defaults
  const [answers, setAnswers] = useState<Answers>(() => {
    const initial: Answers = {}
    for (const q of questionData.questions) {
      if (q.default !== undefined) {
        initial[q.id] = q.default
      } else if (q.type === 'multi-select') {
        initial[q.id] = []
      } else {
        initial[q.id] = ''
      }
    }
    return initial
  })

  // Track "other" text inputs for select/multi-select
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({})

  // For single text-field questions, enable voice shortcuts even without focus
  const textQuestions = questionData.questions.filter((q) => q.type === 'text')
  const singleTextField = textQuestions.length === 1 ? textQuestions[0] : null

  // Voice recording state
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null)
  const activeQuestionIdRef = useStableRef(activeQuestionId)
  const [focusedQuestionId, setFocusedQuestionId] = useState<string | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const shortcutScopeRef = useRef<HTMLDivElement>(null)
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})

  const handleTranscription = useCallback(
    (text: string) => {
      const qId = activeQuestionIdRef.current
      if (qId) {
        setAnswers((prev) => {
          const current = prev[qId]
          const currentText = typeof current === 'string' ? current : ''
          return { ...prev, [qId]: currentText ? currentText + ' ' + text : text }
        })
        setTimeout(() => textareaRefs.current[qId]?.focus(), 0)
      }
      setActiveQuestionId(null)
    },
    [] // stable — reads from ref
  )

  const handleVoiceError = useCallback((error: string) => {
    setVoiceError(error)
    setActiveQuestionId(null)
    setTimeout(() => setVoiceError(null), 3000)
  }, [])

  // For single text fields, auto-submit after voice "send" (↑ to confirm)
  const onSubmitRef = useStableRef(onSubmit)
  const handleAutoSend = useCallback(
    (text: string) => {
      const qId = activeQuestionIdRef.current
      if (qId && singleTextField) {
        // Set the answer (for UI) and submit directly
        setAnswers((prev) => ({ ...prev, [qId]: text }))
        onSubmitRef.current(text)
      }
      setActiveQuestionId(null)
    },
    [singleTextField]
  )

  const dictationEnabled = useVoiceEnabled()
  const {
    state: voiceState,
    elapsed: voiceElapsed,
    volume: voiceVolume,
    isSupported: recorderSupported,
    isHoldMode,
    start: startRecording,
    stop: stopRecording,
    stopAndSend: stopAndSendRecording,
    cancel: cancelRecording,
    beginPress,
    endPress,
    cancelPress,
    isPressing,
  } = useVoiceRecorder({
    onTranscription: handleTranscription,
    onAutoSend: singleTextField ? handleAutoSend : undefined,
    onError: handleVoiceError,
    transcribe: transcribeAudio,
    disabled: disabled || !dictationEnabled,
  })
  const voiceSupported = recorderSupported && dictationEnabled

  const beginPressForQuestion = useCallback(
    (questionId: string) => {
      setActiveQuestionId(questionId)
      beginPress()
    },
    [beginPress]
  )

  // Keyboard shortcuts work for whichever text question is focused
  const activeVoiceQuestion = focusedQuestionId
    ? (questionData.questions.find((q) => q.id === focusedQuestionId && q.type === 'text') ?? null)
    : singleTextField
  const focusedHasInput = activeVoiceQuestion
    ? !!(
        answers[activeVoiceQuestion.id] &&
        typeof answers[activeVoiceQuestion.id] === 'string' &&
        (answers[activeVoiceQuestion.id] as string).trim()
      )
    : false

  useVoiceKeyboardShortcuts({
    enabled: voiceSupported && !disabled && !!activeVoiceQuestion,
    scopeRef: shortcutScopeRef,
    voiceState,
    isSupported: voiceSupported,
    hasInput: focusedHasInput,
    disabled: !!disabled,
    start: () => {
      if (activeVoiceQuestion) {
        setActiveQuestionId(activeVoiceQuestion.id)
        startRecording()
      }
    },
    stop: stopRecording,
    stopAndSend: singleTextField ? stopAndSendRecording : stopRecording,
    cancel: cancelRecording,
    beginPress: () => {
      if (activeVoiceQuestion) {
        beginPressForQuestion(activeVoiceQuestion.id)
      }
    },
    endPress,
    isPressing,
  })

  const updateAnswer = (id: string, value: string | string[]) => {
    setAnswers((prev) => ({ ...prev, [id]: value }))
  }

  const isValid = () => {
    for (const q of questionData.questions) {
      if (q.optional) continue

      const answer = answers[q.id]
      const otherText = otherTexts[q.id]?.trim()

      if (q.type === 'multi-select') {
        if (!Array.isArray(answer) || answer.length === 0) return false
        // If "other" is selected, require the text
        if (answer.includes('__other__') && !otherText) return false
      } else if (q.type === 'select') {
        if (!answer || (typeof answer === 'string' && !answer.trim())) return false
        // If "other" is selected, require the text
        if (answer === '__other__' && !otherText) return false
      } else {
        if (!answer || (typeof answer === 'string' && !answer.trim())) return false
      }
    }
    return true
  }

  const handleSubmit = (submit: (answer: string) => void = onSubmit) => {
    if (disabled || !isValid()) return

    // Format answers as JSON string for the agent
    const formattedAnswers: Record<string, string> = {}
    for (const q of questionData.questions) {
      const answer = answers[q.id]
      const otherText = otherTexts[q.id]?.trim()

      if (q.type === 'multi-select' && Array.isArray(answer)) {
        // Filter out "__other__" placeholder and add the actual other text
        const selectedValues = answer.filter((v) => v !== '__other__')
        if (answer.includes('__other__') && otherText) {
          selectedValues.push(otherText)
        }
        if (selectedValues.length > 0) {
          formattedAnswers[q.id] = selectedValues.join(', ')
        }
      } else if (q.type === 'select' && typeof answer === 'string') {
        // If "__other__" is selected, use the other text instead
        if (answer === '__other__' && otherText) {
          formattedAnswers[q.id] = otherText
        } else if (answer && answer !== '__other__') {
          formattedAnswers[q.id] = answer.trim()
        }
      } else if (typeof answer === 'string' && answer.trim()) {
        formattedAnswers[q.id] = answer.trim()
      }
    }

    // If single question, just send the value; otherwise send JSON
    if (questionData.questions.length === 1) {
      const value = Object.values(formattedAnswers)[0] ?? ''
      // Send placeholder if skipping an optional question with no answer
      submit(value || '(empty)')
    } else {
      const result = JSON.stringify(formattedAnswers, null, 2)
      // Send placeholder if all optional questions were skipped
      submit(result === '{}' ? '(empty)' : result)
    }
  }

  return (
    <div ref={shortcutScopeRef} className="space-y-4">
      {voiceError && (
        <div className="rounded-md px-3 py-2 bg-status-external-wait-50 dark:bg-status-external-wait-900/30 text-status-external-wait-600 dark:text-status-external-wait-400 text-sm">
          {voiceError}
        </div>
      )}
      {questionData.questions.map((q, idx) => (
        <QuestionField
          key={q.id}
          question={q}
          value={answers[q.id]}
          onChange={(val) => updateAnswer(q.id, val)}
          disabled={disabled}
          autoFocus={idx === 0}
          canSubmit={!disabled && isValid()}
          handleSubmit={handleSubmit}
          otherText={otherTexts[q.id] ?? ''}
          onOtherTextChange={(text) => setOtherTexts((prev) => ({ ...prev, [q.id]: text }))}
          // Voice recording props
          voiceState={voiceState}
          voiceElapsed={voiceElapsed}
          voiceVolume={voiceVolume}
          voiceSupported={voiceSupported}
          isHoldMode={isHoldMode}
          isRecordingThis={activeQuestionId === q.id}
          beginPress={() => beginPressForQuestion(q.id)}
          endPress={endPress}
          cancelPress={cancelPress}
          textareaRef={(el) => {
            textareaRefs.current[q.id] = el
          }}
          onFocus={() => setFocusedQuestionId(q.id)}
          onBlur={() => setFocusedQuestionId(null)}
          isFocused={focusedQuestionId === q.id}
          alwaysShowVoiceHint={!!singleTextField && q.id === singleTextField.id}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => handleSubmit()}
          disabled={disabled || !isValid()}
          className="ficus-button ficus-button-primary min-h-10 px-4 py-2 disabled:opacity-50 text-sm"
        >
          {secondaryAction ? 'Confirm' : `Submit ${questionData.questions.length > 1 ? 'Answers' : 'Answer'}`}
        </button>
        {secondaryAction && (
          <button
            onClick={() => handleSubmit(secondaryAction.onSubmit)}
            disabled={disabled || !isValid()}
            className="ficus-button min-h-10 text-secondary border border-th-border px-3 py-2 hover:bg-surface-hover disabled:opacity-50 text-sm"
          >
            {secondaryAction.label}
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            disabled={disabled}
            title="Dismiss without answering"
            aria-label="Dismiss without answering"
            className="ficus-button min-h-10 px-3 py-2 text-sm text-muted hover:text-status-danger-600 dark:hover:text-status-danger-400 hover:bg-surface-hover disabled:opacity-50"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}

interface QuestionFieldProps {
  question: QuestionItem
  value: string | string[]
  onChange: (value: string | string[]) => void
  disabled?: boolean
  autoFocus?: boolean
  canSubmit?: boolean
  handleSubmit: () => void
  otherText: string
  onOtherTextChange: (text: string) => void
  // Voice recording props
  voiceState?: RecorderState
  voiceElapsed?: number
  voiceVolume?: number
  voiceSupported?: boolean
  isHoldMode?: boolean
  isRecordingThis?: boolean
  beginPress?: () => void
  endPress?: () => void
  cancelPress?: () => void
  textareaRef?: (el: HTMLTextAreaElement | null) => void
  onFocus?: () => void
  onBlur?: () => void
  isFocused?: boolean
  alwaysShowVoiceHint?: boolean
}

function QuestionField({
  question,
  value,
  onChange,
  disabled,
  autoFocus,
  canSubmit,
  handleSubmit,
  otherText,
  onOtherTextChange,
  // Voice recording props
  voiceState,
  voiceElapsed,
  voiceVolume,
  voiceSupported,
  isHoldMode,
  isRecordingThis,
  beginPress,
  endPress,
  cancelPress,
  textareaRef,
  onFocus,
  onBlur,
  isFocused,
  alwaysShowVoiceHint,
}: QuestionFieldProps) {
  const textValue = typeof value === 'string' ? value : ''
  const arrayValue = Array.isArray(value) ? value : []

  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

  const [meFocused, setMeFocused] = useState(false)
  const localTextarea = useRef<HTMLTextAreaElement | null>(null)
  const suggestions = question.type === 'text' ? (question.options ?? []) : []

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="block text-sm font-medium text-secondary">
          {question.question}
          {question.optional && <span className="ml-1 text-placeholder font-normal text-xs">(optional)</span>}
        </label>

        {/* Mic button - only for text questions */}
        {question.type === 'text' && voiceSupported && (
          <VoiceMicButton
            state={isRecordingThis ? (voiceState ?? 'idle') : 'idle'}
            elapsed={voiceElapsed ?? 0}
            volume={isRecordingThis ? voiceVolume : undefined}
            isSupported={true}
            isHoldMode={isHoldMode ?? false}
            beginPress={beginPress ?? (() => {})}
            endPress={endPress ?? (() => {})}
            cancelPress={cancelPress ?? (() => {})}
            disabled={disabled}
            size="md"
          />
        )}
      </div>

      {question.context && (
        <MarkdownContent className="text-xs text-muted prose-p:my-1">{question.context}</MarkdownContent>
      )}

      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested answers">
          {suggestions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={textValue === option.value}
              disabled={disabled}
              onClick={() => {
                // A suggestion fills the answer; the text stays editable before submitting.
                onChange(option.value)
                localTextarea.current?.focus()
              }}
              className={clsx(
                'rounded-full border px-2.5 py-1 text-xs transition-colors cursor-pointer disabled:cursor-default disabled:opacity-60',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                textValue === option.value
                  ? 'border-selection-border bg-selection text-primary'
                  : 'border-th-border text-secondary hover:border-th-border-hover hover:bg-surface-hover'
              )}
            >
              {option.label ?? option.value}
            </button>
          ))}
        </div>
      )}

      {question.type === 'text' && (
        <>
          <textarea
            ref={(el) => {
              localTextarea.current = el
              textareaRef?.(el)
            }}
            value={textValue}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Type your answer..."
            disabled={disabled}
            autoFocus={autoFocus}
            onFocus={() => {
              setMeFocused(true)
              onFocus?.()
            }}
            onBlur={() => {
              setMeFocused(false)
              onBlur?.()
            }}
            onKeyDown={
              canSubmit
                ? (e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      handleSubmit()
                    }
                  }
                : undefined
            }
            rows={5}
            className="ficus-field w-full rounded-md border-input-border bg-input-bg text-primary focus:border-accent focus:ring-accent px-3 py-2 border disabled:bg-surface-secondary text-sm"
          />

          {(meFocused || alwaysShowVoiceHint) && (
            <p className="text-xs text-placeholder mt-1">
              {isRecordingThis && voiceState === 'recording' ? (
                <span className="text-status-external-wait-500 dark:text-status-external-wait-400 flex items-center gap-1">
                  <span className="inline-block w-2 h-2 bg-status-external-wait-500 rounded-full animate-pulse" />
                  {isHoldMode
                    ? `Hold-to-talk... release to ${alwaysShowVoiceHint ? 'send' : 'transcribe'}, Esc to cancel`
                    : alwaysShowVoiceHint
                      ? 'Recording... ↑ to send, ↓ to preview, Esc to cancel'
                      : 'Recording... ↓ to preview, Esc to cancel'}
                </span>
              ) : canSubmit && (isFocused || alwaysShowVoiceHint) && voiceSupported ? (
                textValue.trim() ? (
                  `${isMac ? '⌘' : 'Ctrl'} + Enter to submit, Ctrl+Shift+V for voice`
                ) : (
                  `${isMac ? '⌘' : 'Ctrl'} + Enter to submit, ↑ for voice`
                )
              ) : canSubmit ? (
                `${isMac ? '⌘' : 'Ctrl'} + Enter to submit`
              ) : (isFocused || alwaysShowVoiceHint) && voiceSupported ? (
                textValue.trim() ? (
                  'Ctrl+Shift+V for voice'
                ) : (
                  '↑ for voice'
                )
              ) : null}
            </p>
          )}
        </>
      )}

      {question.type === 'select' && (
        <div className="space-y-1.5">
          {question.options?.map((option) => (
            <label
              key={option.value}
              className={clsx(
                'flex items-center gap-3 p-2.5 rounded-md border cursor-pointer transition-colors',
                textValue === option.value
                  ? 'border-selection-border bg-selection'
                  : 'border-th-border hover:border-th-border-hover hover:bg-surface-hover'
              )}
            >
              <input
                type="radio"
                name={`question-${question.id}`}
                value={option.value}
                checked={textValue === option.value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                className="text-accent focus:ring-accent"
              />
              <span className="text-sm text-primary">{option.label ?? option.value}</span>
            </label>
          ))}
          <label
            className={clsx(
              'flex items-center gap-3 p-2.5 rounded-md border cursor-pointer transition-colors',
              textValue === '__other__'
                ? 'border-selection-border bg-selection'
                : 'border-th-border hover:border-th-border-hover hover:bg-surface-hover'
            )}
          >
            <input
              type="radio"
              name={`question-${question.id}`}
              value="__other__"
              checked={textValue === '__other__'}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              className="text-accent focus:ring-accent"
            />
            <span className="text-sm text-primary">Other</span>
          </label>
          {textValue === '__other__' && (
            <input
              type="text"
              value={otherText}
              onChange={(e) => onOtherTextChange(e.target.value)}
              placeholder="Enter your answer..."
              disabled={disabled}
              autoFocus
              className="ficus-field w-[calc(100%-1.5rem)] rounded-md border-input-border bg-input-bg text-primary focus:border-accent focus:ring-accent px-3 py-2 border disabled:bg-surface-secondary text-sm ml-6"
            />
          )}
        </div>
      )}

      {question.type === 'multi-select' && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted">Select all that apply:</p>
          {question.options?.map((option) => {
            const isSelected = arrayValue.includes(option.value)
            const toggle = () => {
              if (isSelected) {
                onChange(arrayValue.filter((v) => v !== option.value))
              } else {
                onChange([...arrayValue, option.value])
              }
            }
            return (
              <label
                key={option.value}
                className={clsx(
                  'flex items-center gap-3 p-2.5 rounded-md border cursor-pointer transition-colors',
                  isSelected
                    ? 'border-selection-border bg-selection'
                    : 'border-th-border hover:border-th-border-hover hover:bg-surface-hover'
                )}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={toggle}
                  disabled={disabled}
                  className="text-accent focus:ring-accent rounded"
                />
                <span className="text-sm text-primary">{option.label ?? option.value}</span>
              </label>
            )
          })}
          <label
            className={clsx(
              'flex items-center gap-3 p-2.5 rounded-md border cursor-pointer transition-colors',
              arrayValue.includes('__other__')
                ? 'border-selection-border bg-selection'
                : 'border-th-border hover:border-th-border-hover hover:bg-surface-hover'
            )}
          >
            <input
              type="checkbox"
              checked={arrayValue.includes('__other__')}
              onChange={() => {
                if (arrayValue.includes('__other__')) {
                  onChange(arrayValue.filter((v) => v !== '__other__'))
                } else {
                  onChange([...arrayValue, '__other__'])
                }
              }}
              disabled={disabled}
              className="text-accent focus:ring-accent rounded"
            />
            <span className="text-sm text-primary">Other</span>
          </label>
          {arrayValue.includes('__other__') && (
            <input
              type="text"
              value={otherText}
              onChange={(e) => onOtherTextChange(e.target.value)}
              placeholder="Enter your answer..."
              disabled={disabled}
              autoFocus
              className="ficus-field w-[calc(100%-1.5rem)] rounded-md border-input-border bg-input-bg text-primary focus:border-accent focus:ring-accent px-3 py-2 border disabled:bg-surface-secondary text-sm ml-6"
            />
          )}
        </div>
      )}
    </div>
  )
}
