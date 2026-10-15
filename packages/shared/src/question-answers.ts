import type { QuestionData, QuestionItem, QuestionOption } from './types'

/**
 * Human-readable views of a stored ask_human answer.
 *
 * The stored answer (agent_questions.answer) is what the answer form submits: for one question the
 * chosen option VALUE (multi-select values joined by ", ", free "Other" text verbatim), for several
 * questions a JSON object of question id -> that string, and "(empty)" when every optional question
 * was skipped. These helpers map values back to the option LABELS the human actually saw, without
 * changing what is stored.
 */

/** Inbox `metadata.source` of the answer delivered back to the asking agent. */
export const QUESTION_ANSWER_INBOX_SOURCE = 'agent-question-answer'

/** What the answer form submits when every (optional) question was skipped. */
export const SKIPPED_QUESTION_ANSWER = '(empty)'

/** Shown to agents and humans for a skipped optional question. */
export const SKIPPED_QUESTION_ANSWER_TEXT = '(skipped)'

export interface QuestionAnswerChoice {
  /** The option label, or the free text the human typed. */
  label: string
  /** The option value; absent for free text ("Other", text questions, unknown values). */
  value?: string
}

export interface ResolvedQuestionAnswer {
  questionId: string
  question: string
  /** Chosen options and free text, in answer order. Empty when the question was skipped. */
  choices: QuestionAnswerChoice[]
}

/**
 * Structured question answer carried on the answer inbox row and its chat delivery summary, so
 * clients can render it without parsing markdown. Every string is plain text.
 */
export interface QuestionAnswerCardData {
  questionId: string
  /** Display name of the answering human (summary only; never a raw ID). */
  answeredBy?: string
  /** ISO timestamp of the answer. */
  answeredAt?: string
  questions: ResolvedQuestionAnswer[]
}

function optionChoice(option: QuestionOption): QuestionAnswerChoice {
  return { label: option.label?.trim() || option.value, value: option.value }
}

/** Multi-select answers are option values joined by ", ", with any "Other" text last. */
function resolveMultiSelect(raw: string, options: QuestionOption[]): QuestionAnswerChoice[] {
  const byValue = new Map(options.map((option) => [option.value, option]))
  const tokens = raw.split(', ')
  const choices: QuestionAnswerChoice[] = []
  let freeText: string[] = []
  const flushFreeText = () => {
    const text = freeText.join(', ').trim()
    if (text) choices.push({ label: text })
    freeText = []
  }
  let index = 0
  outer: while (index < tokens.length) {
    // Longest match first: an option value may itself contain ", ".
    for (let end = tokens.length; end > index; end--) {
      const option = byValue.get(tokens.slice(index, end).join(', '))
      if (option) {
        flushFreeText()
        choices.push(optionChoice(option))
        index = end
        continue outer
      }
    }
    freeText.push(tokens[index])
    index++
  }
  flushFreeText()
  return choices
}

function resolveOne(question: QuestionItem, raw: string): QuestionAnswerChoice[] {
  const value = raw.trim()
  if (!value) return []
  const options = question.options ?? []
  if (question.type === 'select') {
    const option = options.find((candidate) => candidate.value === value)
    return [option ? optionChoice(option) : { label: value }]
  }
  if (question.type === 'multi-select') return resolveMultiSelect(value, options)
  // Text answers stay verbatim, even when they match a suggestion.
  return [{ label: value }]
}

function parseAnswerObject(answer: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(answer)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Resolve a stored answer into per-question choices with option labels. Returns null when the
 * question data is missing or a multi-question answer is not the form's JSON object, so callers
 * can fall back to the raw answer. Unknown values are kept as free text.
 */
export function resolveQuestionAnswers(
  data: QuestionData | null | undefined,
  answer: string | null | undefined
): ResolvedQuestionAnswer[] | null {
  const questions = Array.isArray(data?.questions) ? data.questions : []
  if (questions.length === 0) return null
  const raw = answer ?? ''
  const skippedAll = raw.trim() === '' || raw.trim() === SKIPPED_QUESTION_ANSWER
  const item = (question: QuestionItem, choices: QuestionAnswerChoice[]): ResolvedQuestionAnswer => ({
    questionId: question.id,
    question: question.question ?? '',
    choices,
  })
  if (questions.length === 1) return [item(questions[0], skippedAll ? [] : resolveOne(questions[0], raw))]
  if (skippedAll) return questions.map((question) => item(question, []))

  const parsed = parseAnswerObject(raw)
  if (!parsed) return null
  const known = new Set(questions.map((question) => question.id))
  const resolved = questions.map((question) => {
    const value = parsed[question.id]
    if (value === undefined || value === null) return item(question, [])
    return item(question, resolveOne(question, typeof value === 'string' ? value : JSON.stringify(value)))
  })
  // Keys the form would never send (e.g. an API answer) are kept rather than silently dropped.
  for (const [key, value] of Object.entries(parsed)) {
    if (known.has(key) || value === undefined || value === null) continue
    const text = (typeof value === 'string' ? value : JSON.stringify(value)).trim()
    if (text) resolved.push({ questionId: key, question: key, choices: [{ label: text }] })
  }
  return resolved
}

/** One answer as text for agents: "Label (value)" per option, free text verbatim, or "(skipped)". */
export function formatQuestionAnswerChoices(choices: QuestionAnswerChoice[]): string {
  if (choices.length === 0) return SKIPPED_QUESTION_ANSWER_TEXT
  return choices
    .map((choice) =>
      choice.value !== undefined && choice.value !== choice.label ? `${choice.label} (${choice.value})` : choice.label
    )
    .join(', ')
}

/** Validates the structured answer read back from persisted (untyped) metadata. */
export function parseQuestionAnswerCardData(value: unknown): QuestionAnswerCardData | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  if (typeof data.questionId !== 'string' || !Array.isArray(data.questions)) return null
  const questions: ResolvedQuestionAnswer[] = []
  for (const entry of data.questions) {
    if (!entry || typeof entry !== 'object') return null
    const question = entry as Record<string, unknown>
    if (typeof question.questionId !== 'string' || typeof question.question !== 'string') return null
    if (!Array.isArray(question.choices)) return null
    const choices: QuestionAnswerChoice[] = []
    for (const choice of question.choices) {
      if (!choice || typeof choice !== 'object' || typeof (choice as QuestionAnswerChoice).label !== 'string')
        return null
      const { label, value: optionValue } = choice as QuestionAnswerChoice
      choices.push(typeof optionValue === 'string' ? { label, value: optionValue } : { label })
    }
    questions.push({ questionId: question.questionId, question: question.question, choices })
  }
  return {
    questionId: data.questionId,
    ...(typeof data.answeredBy === 'string' && data.answeredBy ? { answeredBy: data.answeredBy } : {}),
    ...(typeof data.answeredAt === 'string' && data.answeredAt ? { answeredAt: data.answeredAt } : {}),
    questions,
  }
}
