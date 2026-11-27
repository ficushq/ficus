import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import {
  QUESTION_RECOMMENDATION_REASON_MAX_LENGTH,
  type QuestionItem,
  type QuestionOption,
  type QuestionType,
} from '@ficus/shared'
import { toolCallIdempotencyKey } from '@ficus/shared/node'
import { createAgentQuestion } from '../services/agents/questions'

const QUESTION_CONTEXT_MAX_LENGTH = 2000

const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: 'The value returned when this option is selected' }),
  label: Type.Optional(Type.String({ description: 'Display label (defaults to value if not provided)' })),
  recommended: Type.Optional(
    Type.Boolean({
      description:
        'Mark the one option you recommend; the card labels it Recommended. It is not preselected. ' +
        'At most one option per question.',
    })
  ),
  reason: Type.Optional(
    Type.String({
      maxLength: QUESTION_RECOMMENDATION_REASON_MAX_LENGTH,
      description:
        'One-line plain-text reason for your recommendation (no Markdown), shown with it. Expected whenever ' +
        'you recommend an option. Only on the recommended option.',
    })
  ),
})

const QuestionItemSchema = Type.Object({
  id: Type.String({ description: 'Unique identifier for this question (used in the response)' }),
  type: Type.Optional(
    Type.Union([Type.Literal('text'), Type.Literal('select'), Type.Literal('multi-select')], {
      description: "The type of input expected. Defaults to 'text'",
    })
  ),
  question: Type.String({ description: 'The question text to display. Keep it to one clear ask.' }),
  context: Type.Optional(
    Type.String({
      maxLength: QUESTION_CONTEXT_MAX_LENGTH,
      description:
        'Background shown under the question: what you are working on, what you found, and what each answer ' +
        'would lead to. The human usually answers from the Feed or a notification without your conversation. ' +
        'Markdown is allowed.',
    })
  ),
  options: Type.Optional(
    Type.Array(QuestionOptionSchema, {
      description:
        'Choices for select/multi-select questions. For text questions, suggested answers the human can pick and edit.',
    })
  ),
  default: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  optional: Type.Optional(Type.Boolean({ description: 'If true, this question can be left unanswered' })),
})

const QuestionsSchema = Type.Array(QuestionItemSchema, {
  description: 'One or more questions to ask. Each has an id, type, question text, and optional context and options.',
})

/** Managers and assistants: the question is always asynchronous; no wait can be opened. */
const AsyncOnlyAskHumanSchema = Type.Object({
  questions: QuestionsSchema,
})

/** Work-stream agents: may additionally block their flow attempt on the answer. */
const AsyncAskHumanSchema = Type.Object({
  questions: QuestionsSchema,
  waitScope: Type.Optional(
    Type.Union([Type.Literal('attempt'), Type.Literal('stream')], {
      description:
        'For blocking questions: default is your active flow attempt; use stream only when every branch needs the answer. Non-flow work uses whole-stream waits.',
    })
  ),
  blocking: Type.Optional(
    Type.Boolean({
      description:
        'Default false. When true, a wait prevents the affected flow attempt from advancing until answered. ' +
        'Independent branches can continue. The stream may park after the squad grace only when no branch can proceed. ' +
        'The tool returns immediately; finish your current turn when blocked rather than polling.',
    })
  ),
})

type AskParams = {
  questions: Array<{
    id: string
    type?: QuestionType
    question: string
    context?: string
    options?: QuestionOption[]
    default?: string | string[]
    optional?: boolean
  }>
  blocking?: boolean
  waitScope?: 'attempt' | 'stream'
}

/**
 * Validates and normalizes a question's options: `recommended` is kept only when true, `reason`
 * is trimmed and kept only on the recommended option. Returns an error message when the
 * recommendation is malformed.
 */
function normalizeOptions(
  questionId: string,
  options: QuestionOption[] | undefined
): { options: QuestionOption[] | undefined } | { error: string } {
  if (!options) return { options }
  const recommended = options.filter((option) => option.recommended === true)
  if (recommended.length > 1) {
    return {
      error:
        `Question '${questionId}': at most one option can be recommended, but ${recommended.length} were ` +
        `(${recommended.map((option) => `'${option.value}'`).join(', ')})`,
    }
  }
  const normalized: QuestionOption[] = []
  for (const option of options) {
    const reason = typeof option.reason === 'string' ? option.reason.trim() : ''
    const isRecommended = option.recommended === true
    if (reason && !isRecommended) {
      return {
        error: `Question '${questionId}': option '${option.value}' has a reason but is not recommended; a reason belongs only on the recommended option`,
      }
    }
    if (/[\r\n]/.test(reason)) {
      return { error: `Question '${questionId}': the reason for option '${option.value}' must be one line` }
    }
    if (reason.length > QUESTION_RECOMMENDATION_REASON_MAX_LENGTH) {
      return {
        error: `Question '${questionId}': the reason for option '${option.value}' must be at most ${QUESTION_RECOMMENDATION_REASON_MAX_LENGTH} characters`,
      }
    }
    normalized.push({
      value: option.value,
      ...(option.label !== undefined ? { label: option.label } : {}),
      ...(isRecommended ? { recommended: true } : {}),
      ...(reason ? { reason } : {}),
    })
  }
  return { options: normalized }
}

function errorResult(message: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], details: { error: message } }
}

/**
 * Async ask_human: records a structured question and returns immediately — the agent does NOT halt.
 * Anyone with canonical read access to the agent sees the question in its conversation/history; Action
 * Center/push attention routes to consumed execution participants, attributable work-stream
 * requesters, compatible owners, and relevant authorized watchers. Having no safe attention
 * recipient is NOT the same as an unreadable question. The answer arrives later as an inbox
 * message. A blocking question pauses its work scope, not the tool call or independent branches.
 */
export interface AsyncAskHumanOrigin {
  agentId: string
  executionId: string
  flushPersistence: () => Promise<void>
}

export interface AsyncAskHumanOptions {
  /**
   * Whether `blocking: true` is offered at all. Only work-stream agents may block: a blocking
   * question opens a `question` wait on the agent's flow attempt, which the workflow step system
   * holds until the answer clears it. Managers and assistants coordinate other work and must keep
   * working while a human decides, so their tool exposes no blocking parameter and always records
   * the question asynchronously. Default true.
   */
  allowBlocking?: boolean
}

const COMMON_DESCRIPTION =
  'Ask one or more structured questions of the humans responsible for this agent (your owner and ' +
  'the watchers of your squad). The tool returns immediately; the answer arrives later in your inbox. Use this tool for human decisions, not a manual wait or inbox message. '
const DESCRIPTION_TAIL =
  'An answer does not approve a workflow approval gate. ' +
  'Humans usually answer from the Feed or a notification, away from your conversation, so make each question ' +
  'stand alone and give it context: what you are doing, what you found, and the consequence of each answer. ' +
  'Never ask the person to run commands or to provide logs, status output, host state or other diagnostics; ' +
  'such questions are rejected. To get approval for an action you will perform yourself, describe that action ' +
  'in plain words (for example "May I restart the service once?"). ' +
  "For simple questions use type 'text', optionally with options as suggested answers; for choices " +
  "use 'select' or 'multi-select' with options and the trade-off, and name the evidence. " +
  'When you recommend a choice, set recommended true on that one option with a one-line plain-text reason, ' +
  'instead of writing the recommendation into the question or context.'

const BLOCKING_DESCRIPTION =
  COMMON_DESCRIPTION +
  'Set blocking true when your current step needs the answer before proceeding, then end your turn; ' +
  'independent branches can continue. ' +
  DESCRIPTION_TAIL

const ASYNC_ONLY_DESCRIPTION =
  COMMON_DESCRIPTION +
  'You cannot block on the answer: keep working on everything that does not depend on it, and act on ' +
  'the answer when it arrives (for example by resolving the wait it unblocks). ' +
  DESCRIPTION_TAIL

export function createAsyncAskHumanTool(
  origin: AsyncAskHumanOrigin,
  dependencies: { createQuestion: typeof createAgentQuestion } = { createQuestion: createAgentQuestion },
  options: AsyncAskHumanOptions = {}
): ToolDefinition {
  const allowBlocking = options.allowBlocking !== false
  return {
    name: 'ask_human',
    label: 'Ask Human',
    description: allowBlocking ? BLOCKING_DESCRIPTION : ASYNC_ONLY_DESCRIPTION,
    parameters: allowBlocking ? AsyncAskHumanSchema : AsyncOnlyAskHumanSchema,
    async execute(toolCallId: string, params: AskParams): Promise<AgentToolResult<unknown>> {
      const questions = params.questions ?? []
      if (!questions.length) return errorResult('At least one question is required.')

      const items: QuestionItem[] = []
      const seen = new Set<string>()
      const errors: string[] = []
      for (const q of questions) {
        if (!q.id) {
          errors.push("Each question must have an 'id' field")
          continue
        }
        if (seen.has(q.id)) {
          errors.push(`Duplicate question id: '${q.id}'`)
          continue
        }
        seen.add(q.id)
        const type = q.type ?? 'text'
        if ((type === 'select' || type === 'multi-select') && !q.options?.length) {
          errors.push(`Question '${q.id}': options are required for ${type} questions`)
          continue
        }
        const context = typeof q.context === 'string' ? q.context.trim() : ''
        if (context.length > QUESTION_CONTEXT_MAX_LENGTH) {
          errors.push(`Question '${q.id}': context must be at most ${QUESTION_CONTEXT_MAX_LENGTH} characters`)
          continue
        }
        const normalized = normalizeOptions(q.id, q.options)
        if ('error' in normalized) {
          errors.push(normalized.error)
          continue
        }
        items.push({
          id: q.id,
          type,
          question: q.question,
          ...(context ? { context } : {}),
          options: normalized.options,
          default: q.default,
          optional: q.optional,
        })
      }
      if (errors.length) return errorResult(errors.join('; '))

      // A provider that skips schema validation may still pass blocking; an agent that cannot block
      // gets its question recorded asynchronously and is told so, never silently held.
      const blockingRequested = params.blocking === true
      const blocking = allowBlocking && blockingRequested
      const cannotBlockNote =
        !allowBlocking && blockingRequested
          ? ' This agent cannot block on answers, so the question was recorded as non-blocking.'
          : ''
      await origin.flushPersistence()
      let record
      try {
        record = await dependencies.createQuestion(
          { agentId: origin.agentId, executionId: origin.executionId },
          { questions: items },
          {
            blocking,
            ...(blocking && params.waitScope ? { waitScope: params.waitScope } : {}),
            // The same tool call executed again returns its question instead of asking twice.
            ...(toolCallId
              ? { idempotencyKey: toolCallIdempotencyKey(origin.agentId, origin.executionId, toolCallId) }
              : {}),
          }
        )
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
      const summary = items.map((q) => `"${q.question}"`).join(', ')
      const openedWaitWorkStreamIds = record.openedWaitWorkStreamIds
      if (record.reused) {
        const waits =
          openedWaitWorkStreamIds.length === 0
            ? ' It holds no work-stream waits.'
            : ` It holds waits on ${openedWaitWorkStreamIds.length === 1 ? '1 work stream' : `${openedWaitWorkStreamIds.length} work streams`}: ${openedWaitWorkStreamIds.join(', ')}.`
        const why =
          record.reused === 'tool-call'
            ? 'This tool call was already recorded'
            : 'You already asked exactly this question in this run and it is still open'
        return {
          content: [
            {
              type: 'text' as const,
              text: `${why}, so no new question was created: question ${record.id.slice(0, 8)} (${record.status}).${waits} The answer will arrive as an inbox message; do not ask again or poll.`,
            },
          ],
          details: {
            questionId: record.id,
            async: true,
            blocking: openedWaitWorkStreamIds.length > 0,
            openedWaitCount: openedWaitWorkStreamIds.length,
            openedWaitWorkStreamIds,
            reused: record.reused,
          },
        }
      }
      const blockingNote = !blocking
        ? ''
        : openedWaitWorkStreamIds.length === 0
          ? ' No work-stream waits were opened.'
          : openedWaitWorkStreamIds.length === 1
            ? ` Opened a wait on 1 work stream: ${openedWaitWorkStreamIds[0]}.`
            : ` Opened waits on ${openedWaitWorkStreamIds.length} work streams: ${openedWaitWorkStreamIds.join(', ')}.`
      const questionGuidance =
        ' Do not repeat the question in chat or infer an answer. A human answer is not review approval.'
      return {
        content: [
          {
            type: 'text' as const,
            text:
              record.audienceResolution === 'unroutable'
                ? `Question recorded (${record.id.slice(0, 8)}), but no direct Action Center recipient was found; the question is still visible and answerable by everyone who can read this agent.${blockingNote}${questionGuidance}`
                : `Question recorded (${record.id.slice(0, 8)}): ${summary}. The answer will arrive as an inbox message.${blockingNote}${blocking && openedWaitWorkStreamIds.length > 0 ? ' End your turn while the affected work waits; do not poll.' : ' You can continue other work in the meantime.'}${cannotBlockNote}${questionGuidance}`,
          },
        ],
        details: {
          questionId: record.id,
          async: true,
          blocking,
          openedWaitCount: openedWaitWorkStreamIds.length,
          openedWaitWorkStreamIds,
        },
      }
    },
  }
}
