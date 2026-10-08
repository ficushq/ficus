import { and, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm'
import type { DecisionQuestions, DeliverySuggestion } from '@ficus/shared'
import { db, executions, messages, workStreams } from '../../db'
import type { DecideOptions, DecisionOutcome } from '../decisions/service'

/*
 * The composer's Interrupt / Follow-up suggestion. Agents handle queued work well, so the question
 * is not "stop or wait" but relevance: is the draft about the work the agent is doing right now?
 * Related messages interrupt (the agent folds them into its current plan, even "after that, also…");
 * unrelated ones would distract, so they follow up.
 *
 * The API process can't see the worker's live stream, so the state is built from what the database
 * already holds, deterministically and with no model call of its own.
 */

/** Execution states where a message can still interrupt or queue behind the current turn. */
const BUSY_EXECUTION_STATUSES = ['queued', 'waiting-sandbox', 'running'] as const

/** Drafts shorter than this many words are too thin to judge. */
export const DELIVERY_SUGGESTION_MIN_WORDS = 3
/** `related` at or above this suggests Interrupt (steer); below, Follow up. */
export const DELIVERY_STEER_THRESHOLD = 0.5
export const DELIVERY_SUGGESTION_TIMEOUT_MS = 1500

// Character budgets: about 3,200 characters, roughly 800 tokens, in all.
const ASKED_CHARS = 700
const WORK_STREAM_CHARS = 160
const RECENT_TOOLS = 3
const TOOL_TARGET_CHARS = 120
const LAST_SAID_CHARS = 500
const DRAFT_CHARS = 1200
/** Assistant rows read for recent tool calls: one row per model step, newest first. */
const ASSISTANT_ROWS = 4
/** Tool arguments are read only this far: enough for a path, command or URL. */
const TOOL_ARGS_CHARS = 1000

/** What the decision model reads. Only data: user and agent text never reaches the instructions. */
export type ComposerDeliveryState = {
  /** The message or task that started the agent's current execution. */
  asked: string
  /** The work stream the agent is on, if any. */
  workStream?: string
  /** The latest tool calls of this execution, oldest first: name and a short target. */
  recentTools: string[]
  /** The tail of what the agent last said. */
  lastSaid?: string
  /** The message being written. */
  draft: string
}

export const COMPOSER_DELIVERY_QUESTIONS: DecisionQuestions = {
  related: {
    type: 'yesno',
    instructions:
      "The state describes an AI agent's current work: `asked` is what started it, `workStream` the work stream it is on, " +
      '`recentTools` its latest tool calls and `lastSaid` what it last said. `draft` is a new message someone is writing to it. ' +
      'The new message is about the work the agent is currently doing (same task, files, feature or goal), including follow-on steps of it.',
  },
}

export type DecideFn = (
  purpose: 'composer-delivery',
  input: { state: ComposerDeliveryState; questions: DecisionQuestions },
  options: DecideOptions
) => Promise<DecisionOutcome>

export interface DeliverySuggestionDeps {
  decide: DecideFn
  isEnabled: () => boolean
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function head(text: string, max: number): string {
  const value = squash(text)
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value
}

function tail(text: string, max: number): string {
  const value = squash(text)
  return value.length > max ? `…${value.slice(value.length - max + 1).trimStart()}` : value
}

const TARGET_KEYS = ['path', 'file_path', 'filePath', 'command', 'cmd', 'url', 'query', 'pattern', 'title']

/**
 * A tool call's short target (file path, command head, URL or query), from the start of its JSON
 * arguments. Reads the raw text rather than parsing so truncated arguments still yield a target.
 */
export function toolTarget(args: string): string | undefined {
  for (const key of TARGET_KEYS) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(args)
    if (!match?.[1]) continue
    let value = match[1]
    try {
      value = JSON.parse(`"${value}"`) as string
    } catch {
      // A value cut off mid-escape: keep the raw text.
    }
    // A command's first line says what it does; a path's end says which file.
    if (key === 'command' || key === 'cmd') return head(value.split('\n')[0] ?? '', TOOL_TARGET_CHARS)
    if (key.toLowerCase().includes('path')) return tail(value, TOOL_TARGET_CHARS)
    return head(value, TOOL_TARGET_CHARS)
  }
  return undefined
}

/**
 * The state for a draft written to a busy agent, or null when the agent has no turn in progress to
 * interrupt or queue behind.
 */
export async function buildComposerDeliveryState(
  agentId: string,
  draft: string
): Promise<ComposerDeliveryState | null> {
  const [execution] = await db
    .select({
      id: executions.id,
      message: executions.message,
      flowContext: executions.flowContext,
      latestText: executions.latestText,
      startedAt: executions.startedAt,
    })
    .from(executions)
    .where(and(eq(executions.agentId, agentId), inArray(executions.status, [...BUSY_EXECUTION_STATUSES])))
    .orderBy(desc(executions.startedAt))
    .limit(1)
  if (!execution) return null

  const startedMessage = execution.message?.trim()
  const [startingHuman, workStream, assistantRows] = await Promise.all([
    // A run started without a message (queued inbox or pending work): the latest human message
    // at its start. The starting row is written in the same transaction as the execution.
    startedMessage
      ? Promise.resolve([])
      : db
          .select({ content: sql<string>`left(${messages.content}, ${ASKED_CHARS * 2})` })
          .from(messages)
          .where(
            and(
              eq(messages.agentId, agentId),
              eq(messages.role, 'human'),
              lte(messages.createdAt, new Date(execution.startedAt.getTime() + 5_000))
            )
          )
          .orderBy(desc(messages.createdAt))
          .limit(1),
    db
      .select({ title: workStreams.title })
      .from(workStreams)
      .where(
        execution.flowContext?.workStreamId
          ? eq(workStreams.id, execution.flowContext.workStreamId)
          : and(
              inArray(workStreams.status, ['active', 'queued']),
              or(eq(workStreams.assigneeAgentId, agentId), sql`${agentId}::uuid = ANY(${workStreams.agentIds})`)
            )
      )
      .orderBy(desc(workStreams.updatedAt))
      .limit(1),
    // Newest steps first (idx_messages_agent_execution). Only the text's tail and each tool call's
    // name and argument head leave the database, never tool results.
    db
      .select({
        text: sql<string>`right(${messages.content}, ${LAST_SAID_CHARS * 2})`,
        tools: sql<Array<{ name: string | null; args: string | null }> | null>`(
          SELECT jsonb_agg(jsonb_build_object('name', block->'toolCall'->>'toolName', 'args', left(block->'toolCall'->>'args', ${TOOL_ARGS_CHARS})) ORDER BY position)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${messages.metadata}->'content') = 'array' THEN ${messages.metadata}->'content' ELSE '[]'::jsonb END)
            WITH ORDINALITY AS blocks(block, position)
          WHERE block->>'type' = 'tool_use'
        )`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.agentId, agentId),
          eq(messages.role, 'assistant'),
          sql`${messages.metadata}->>'executionId' = ${execution.id}`,
          gte(messages.createdAt, execution.startedAt)
        )
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(ASSISTANT_ROWS),
  ])

  const recentTools = assistantRows
    .flatMap((row) => [...(row.tools ?? [])].reverse())
    .filter((tool) => tool.name)
    .slice(0, RECENT_TOOLS)
    .reverse()
    .map((tool) => {
      const target = tool.args ? toolTarget(tool.args) : undefined
      return target ? `${tool.name} ${target}` : tool.name!
    })
  const lastText =
    execution.latestText?.trim() ||
    assistantRows.map((row) => row.text?.trim()).find((text) => text && !text.startsWith('[System]'))
  const asked = startedMessage || startingHuman[0]?.content || ''

  return {
    asked: head(asked, ASKED_CHARS),
    ...(workStream[0]?.title ? { workStream: head(workStream[0].title, WORK_STREAM_CHARS) } : {}),
    recentTools,
    ...(lastText ? { lastSaid: tail(lastText, LAST_SAID_CHARS) } : {}),
    draft: head(draft, DRAFT_CHARS),
  }
}

/**
 * Suggest Interrupt or Follow up for a draft. Null, without asking a model, when the feature is
 * off, the draft is too short or the agent isn't working; null too when no model answers.
 */
export async function suggestDelivery(
  agent: { id: string; status: string },
  draft: string,
  deps: DeliverySuggestionDeps,
  signal?: AbortSignal
): Promise<DeliverySuggestion> {
  const none: DeliverySuggestion = { suggestion: null }
  if (!deps.isEnabled()) return none
  if (countWords(draft) < DELIVERY_SUGGESTION_MIN_WORDS) return none
  // A waiting agent's next message answers it; there is no turn to interrupt.
  if (agent.status === 'waiting-input') return none
  const state = await buildComposerDeliveryState(agent.id, draft)
  if (!state) return none

  const outcome = await deps.decide(
    'composer-delivery',
    { state, questions: COMPOSER_DELIVERY_QUESTIONS },
    { timeoutMs: DELIVERY_SUGGESTION_TIMEOUT_MS, source: { kind: 'composer', agentId: agent.id }, signal }
  )
  if (!outcome.ok) return none
  const answer = outcome.result.answers.related
  if (answer?.type !== 'yesno' || !Number.isFinite(answer.probability)) return none
  const probability = Math.min(Math.max(answer.probability, 0), 1)
  return { suggestion: probability >= DELIVERY_STEER_THRESHOLD ? 'steer' : 'follow-up', probability }
}
