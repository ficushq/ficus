import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import {
  ASSISTANT_ROUTING_MIN_CONFIDENCE,
  type AssistantRoutingHint,
  type AssistantRoutingTarget,
  type DecisionAnswer,
  type DecisionRequest,
  type Message,
  type MessageMetadata,
  type SuggestSquadResponse,
} from '@ficus/shared'
import { db, messages, squads } from '../../db'
import { jsonbObjectRecovered } from '../../db/jsonb'
import { mapMessage } from '../../entities/message-mapper'
import { messageEventData } from '../../entities/message-event'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { decide, isDecisionFeatureEnabled, type DecideOptions, type DecisionOutcome } from '../decisions/service'
import { withinScope } from '../entity-search'
import { getAccessibleSquadIds, resolveActingUser, resolvePermissionSquadScope, type Identity } from '../rbac'
import { scoreKeywordOverlap, suggestSquadsByPurpose } from './squad-suggester'

const log = createLogger('assistant-routing')

/** How long a user message waits for its routing hint before the Assistant's turn starts anyway. */
export const ASSISTANT_ROUTING_TIMEOUT_MS = 1_500
/** suggest_squad is asked for explicitly, mid-turn, so it can wait a little longer. */
export const SUGGEST_SQUAD_TIMEOUT_MS = 3_000
/** Squads offered as options; above this, the purpose heuristic picks the likeliest. (A choice allows 64 options.) */
export const MAX_ROUTING_SQUADS = 30
const MESSAGE_CHARS = 4_000
const RECENT_ENTRIES = 3
const RECENT_ENTRY_CHARS = 300
const PURPOSE_CHARS = 400
/** The message source of a user's own chat message: the only kind that is routed. */
const USER_CHAT_SOURCE = 'user_chat'

export interface RoutingSquad {
  id: string
  name: string
  purpose: string | null
}

export interface RecentEntry {
  role: 'user' | 'assistant'
  text: string
}

export interface AssistantRoutingDeps {
  decide?: (purpose: 'assistant-routing', input: DecisionRequest, options: DecideOptions) => Promise<DecisionOutcome>
  /** Whether the feature is on (Settings → Decision Providers → Features). */
  enabled?: () => boolean
  /** The deadline timer; tests pass their own to fire it. Returns a cancel function. */
  setTimer?: (fire: () => void, ms: number) => () => void
  timeoutMs?: number
  listSquads?: (identity: Identity) => Promise<RoutingSquad[]>
  loadRecent?: (message: Pick<Message, 'id' | 'agentId' | 'createdAt'>) => Promise<RecentEntry[]>
}

export interface RankedRoutingTarget extends AssistantRoutingTarget {
  probability: number
}

export interface AssistantRoutingDecision {
  /** The pick, whatever its confidence; null when no decision model answered. */
  hint: AssistantRoutingHint | null
  /** Every option the model rated, likeliest first. */
  ranked: RankedRoutingTarget[]
  reason?: 'disabled' | 'no-squads' | 'empty' | 'unconfigured' | 'unavailable' | 'timeout' | 'unanswered'
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** At most `max` squads: all of them when they fit, else the likeliest by the purpose heuristic. */
export function selectRoutingSquads(
  all: readonly RoutingSquad[],
  text: string,
  max = MAX_ROUTING_SQUADS
): RoutingSquad[] {
  if (all.length <= max) return [...all]
  return all
    .map((squad, index) => ({ squad, index, score: scoreKeywordOverlap(text, `${squad.name} ${squad.purpose ?? ''}`) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .map(({ squad }) => squad)
}

/** `squad_<short id>`: the first 8 hex digits of its ID, longer only when two squads share them. */
export function squadOptionKeys(list: readonly RoutingSquad[]): Map<string, RoutingSquad> {
  const hex = (squad: RoutingSquad) => squad.id.toLowerCase().replace(/[^0-9a-f]/g, '')
  const keys = new Map<string, RoutingSquad>()
  for (const squad of list) {
    let length = 8
    const id = hex(squad)
    const clashes = () => list.some((other) => other !== squad && hex(other).slice(0, length) === id.slice(0, length))
    while (length < id.length && clashes()) length += 4
    keys.set(`squad_${id.slice(0, length)}`, squad)
  }
  return keys
}

export const ROUTING_INSTRUCTIONS =
  'Who should handle the user’s latest message (state.message)? state.recent is the conversation just before it, ' +
  'only for working out what the message refers to. Pick a squad only when the message is about a feature, bug ' +
  'or work in that squad’s own project. Pick instance for Ficus itself, and general for work not tied to one ' +
  'squad’s project.'

/** The decision: one choice. Squad names and purposes are ours; the user's words go only in `state`. */
export function buildRoutingRequest(input: {
  text: string
  recent: readonly RecentEntry[]
  squads: readonly RoutingSquad[]
}): {
  request: DecisionRequest
  keys: Map<string, RoutingSquad>
} {
  const keys = squadOptionKeys(selectRoutingSquads(input.squads, input.text))
  const options: Record<string, string> = {
    instance:
      'Ficus itself: its settings, users, roles, permissions, integrations, providers or other instance and admin work, not any squad’s project.',
    general:
      'Work not tied to one squad’s project: general questions, research or writing, personal tasks, or work across several squads.',
  }
  for (const [key, squad] of keys) {
    const purpose = squad.purpose?.trim()
    options[key] = truncate(
      `The squad ${JSON.stringify(squad.name)}${purpose ? `: ${truncate(purpose, PURPOSE_CHARS)}` : ''}. A feature, bug or work in its project.`,
      1000
    )
  }
  return {
    request: {
      state: {
        message: truncate(input.text.trim(), MESSAGE_CHARS),
        recent: input.recent.slice(-RECENT_ENTRIES).map((entry) => ({
          role: entry.role,
          text: truncate(entry.text.trim(), RECENT_ENTRY_CHARS),
        })),
      },
      questions: { scope: { type: 'choice', instructions: ROUTING_INSTRUCTIONS, options } },
    },
    keys,
  }
}

function targetFor(choice: string, keys: Map<string, RoutingSquad>): AssistantRoutingTarget | null {
  if (choice === 'instance' || choice === 'general') return { scope: choice }
  const squad = keys.get(choice)
  return squad ? { scope: 'squad', squadId: squad.id, squadName: squad.name } : null
}

const unit = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0

/** The model's pick and ranking, or null for a refusal, an unknown option or another answer type. */
export function interpretRoutingAnswer(
  answer: DecisionAnswer | undefined,
  keys: Map<string, RoutingSquad>
): Pick<AssistantRoutingDecision, 'hint' | 'ranked'> | null {
  if (answer?.type !== 'choice') return null
  const target = targetFor(answer.choice, keys)
  if (!target) return null
  const ranked = Object.entries(answer.probabilities ?? {})
    .flatMap(([choice, probability]) => {
      const option = targetFor(choice, keys)
      return option ? [{ ...option, probability: unit(probability) }] : []
    })
    .sort((a, b) => b.probability - a.probability)
  return {
    hint: { ...target, confidence: unit(answer.confidence ?? answer.probabilities?.[answer.choice]) },
    ranked,
  }
}

/**
 * Ask the decision model where a message belongs. Never throws, and never waits past the timeout:
 * a slow provider is aborted and the Assistant goes on without a hint.
 */
export async function decideAssistantRouting(
  input: { text: string; recent: readonly RecentEntry[]; squads: readonly RoutingSquad[] },
  deps: AssistantRoutingDeps = {},
  source: Record<string, string> = { kind: 'assistant' }
): Promise<AssistantRoutingDecision> {
  if (!(deps.enabled ?? (() => isDecisionFeatureEnabled('assistant-routing')))())
    return { hint: null, ranked: [], reason: 'disabled' }
  if (!input.text.trim()) return { hint: null, ranked: [], reason: 'empty' }
  if (!input.squads.length) return { hint: null, ranked: [], reason: 'no-squads' }
  const timeoutMs = deps.timeoutMs ?? ASSISTANT_ROUTING_TIMEOUT_MS
  const { request, keys } = buildRoutingRequest(input)
  const controller = new AbortController()
  let cancelTimer = () => {}
  const deadline = new Promise<'timeout'>((resolve) => {
    cancelTimer = (deps.setTimer ?? defaultTimer)(() => {
      controller.abort()
      resolve('timeout')
    }, timeoutMs)
  })
  try {
    const outcome = await Promise.race([
      (deps.decide ?? decide)('assistant-routing', request, { source, timeoutMs, signal: controller.signal }),
      deadline,
    ])
    if (outcome === 'timeout') return { hint: null, ranked: [], reason: 'timeout' }
    if (!outcome.ok) return { hint: null, ranked: [], reason: outcome.reason }
    return (
      interpretRoutingAnswer(outcome.result.answers.scope, keys) ?? { hint: null, ranked: [], reason: 'unanswered' }
    )
  } catch (error) {
    log.warn('Assistant routing failed', error)
    return { hint: null, ranked: [], reason: 'unavailable' }
  } finally {
    cancelTimer()
  }
}

function defaultTimer(fire: () => void, ms: number) {
  const timer = setTimeout(fire, ms)
  return () => clearTimeout(timer)
}

/** Active, named squads the user can read, as the Assistant sees them. */
export async function listRoutableSquads(identity: Identity): Promise<RoutingSquad[]> {
  const [scope, accessible] = await Promise.all([
    resolvePermissionSquadScope(identity, 'squads:read'),
    getAccessibleSquadIds(identity),
  ])
  return db
    .select({ id: squads.id, name: squads.name, purpose: squads.purpose })
    .from(squads)
    .where(
      sql`${squads.status} = 'active' AND ${squads.isAnonymous} = false AND ${withinScope(sql`${squads.id}`, scope)} AND ${
        accessible === 'all' ? sql`true` : withinScope(sql`${squads.id}`, { kind: 'some', squadIds: accessible })
      }`
    )
    .orderBy(squads.name, squads.id)
    .limit(500)
}

/** The last few user and Assistant messages before this one, oldest first. */
export async function loadRecentEntries(
  message: Pick<Message, 'id' | 'agentId' | 'createdAt'>
): Promise<RecentEntry[]> {
  const rows = await db
    .select({ role: messages.role, content: messages.content, metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, message.agentId),
        inArray(messages.role, ['human', 'assistant']),
        lt(messages.createdAt, message.createdAt)
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(12)
  return rows
    .filter((row) => {
      const metadata = row.metadata as MessageMetadata | null
      if (!row.content.trim() || row.content.startsWith('[System]') || metadata?.isSystem) return false
      return row.role === 'assistant' || metadata?.source === USER_CHAT_SOURCE
    })
    .slice(0, RECENT_ENTRIES)
    .reverse()
    .map((row) => ({
      role: row.role === 'human' ? 'user' : 'assistant',
      text: truncate(row.content, RECENT_ENTRY_CHARS),
    }))
}

/** A user's own chat message without a hint yet. */
export function isRoutableUserMessage(message: Pick<Message, 'role' | 'content' | 'metadata'>): boolean {
  return (
    message.role === 'human' &&
    message.metadata?.source === USER_CHAT_SOURCE &&
    !message.metadata.assistantRouting &&
    Boolean(message.content.trim())
  )
}

/**
 * Route one user message to the Assistant: ask the decision, and when it is confident enough, save
 * the hint on the message (the UI shows it; the model reads it with the message) and return the
 * message with it. Otherwise the message comes back unchanged. Never throws.
 */
export async function annotateAssistantMessage(
  identity: Identity,
  message: Message,
  deps: AssistantRoutingDeps = {}
): Promise<Message> {
  if (!isRoutableUserMessage(message)) return message
  try {
    if (!(deps.enabled ?? (() => isDecisionFeatureEnabled('assistant-routing')))()) return message
    const user = await resolveActingUser(identity)
    if (!user) return message
    const [squadList, recent] = await Promise.all([
      (deps.listSquads ?? listRoutableSquads)(user),
      (deps.loadRecent ?? loadRecentEntries)(message),
    ])
    const { hint } = await decideAssistantRouting(
      { text: message.content, recent, squads: squadList },
      { ...deps, enabled: () => true },
      { kind: 'assistant', agentId: message.agentId }
    )
    if (!hint || hint.confidence < ASSISTANT_ROUTING_MIN_CONFIDENCE) return message
    const [saved] = await db
      .update(messages)
      .set({
        metadata: sql<MessageMetadata>`${jsonbObjectRecovered(messages.metadata)} || jsonb_build_object('assistantRouting', ${JSON.stringify(hint)}::jsonb)`,
      })
      .where(and(eq(messages.id, message.id), eq(messages.agentId, message.agentId)))
      .returning()
    if (saved) eventEmitter.emit('message.updated', messageEventData(mapMessage(saved)))
    return { ...message, metadata: { ...message.metadata, assistantRouting: hint } }
  } catch (error) {
    log.warn('Could not route an Assistant message', error)
    return message
  }
}

export type AssistantSquadSuggestion =
  | {
      source: 'decision-model'
      pick: AssistantRoutingHint
      /** At or above the confidence the Assistant trusts by default. */
      confident: boolean
      alternatives: RankedRoutingTarget[]
    }
  | ({ source: 'heuristic'; note: string } & SuggestSquadResponse)

/** suggest_squad: the routing decision for any phrasing, else the purpose heuristic. */
export async function suggestAssistantSquad(
  identity: Identity,
  text: string,
  deps: AssistantRoutingDeps = {}
): Promise<AssistantSquadSuggestion> {
  const squadList = await (deps.listSquads ?? listRoutableSquads)(identity)
  const decision = await decideAssistantRouting(
    { text, recent: [], squads: squadList },
    { timeoutMs: SUGGEST_SQUAD_TIMEOUT_MS, ...deps },
    { kind: 'assistant-suggest-squad' }
  )
  if (decision.hint)
    return {
      source: 'decision-model',
      pick: decision.hint,
      confident: decision.hint.confidence >= ASSISTANT_ROUTING_MIN_CONFIDENCE,
      alternatives: decision.ranked.slice(0, 4),
    }
  return {
    source: 'heuristic',
    note: 'No decision model answered; this ranks squads by how well their name and purpose match the words. It cannot tell instance or general work apart.',
    ...suggestSquadsByPurpose(squadList, text),
  }
}
