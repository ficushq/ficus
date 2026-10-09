import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import {
  ASSISTANT_ROUTING_MIN_CONFIDENCE,
  effectiveAssistantRouting,
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
/** The user's own earlier messages the decision sees, plus the Assistant's latest reply. */
const RECENT_USER_MESSAGES = 4
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

/**
 * What a user message is, asked alongside its scope. Scope is the message's target (a squad, Ficus
 * itself, or general), whether or not it asks for new work, so it decides the hint; kind only lets a
 * confident `follow_up` carry the conversation's earlier routing instead of a fresh guess.
 */
export const ROUTING_KINDS = ['new_request', 'follow_up', 'conversation'] as const
export type RoutingKind = (typeof ROUTING_KINDS)[number]

/** What the decision sees of the conversation before a message, and what the skip rules need. */
export interface RoutingContext {
  /** The user's last few messages and the Assistant's latest reply, oldest first. */
  recent: RecentEntry[]
}

export interface InheritedRouting {
  messageId: string
  hint: AssistantRoutingHint
}

export interface AssistantRoutingDeps {
  decide?: (purpose: 'assistant-routing', input: DecisionRequest, options: DecideOptions) => Promise<DecisionOutcome>
  /** Whether the feature is on (Settings → Decision Providers → Features). */
  enabled?: () => boolean
  /** The deadline timer; tests pass their own to fire it. Returns a cancel function. */
  setTimer?: (fire: () => void, ms: number) => () => void
  timeoutMs?: number
  listSquads?: (identity: Identity) => Promise<RoutingSquad[]>
  loadContext?: (message: Pick<Message, 'id' | 'agentId' | 'createdAt'>) => Promise<RoutingContext>
  /** The conversation's latest routing (hint or correction) before a message. */
  findInherited?: (message: Pick<Message, 'id' | 'agentId' | 'createdAt'>) => Promise<InheritedRouting | null>
}

export interface RankedRoutingTarget extends AssistantRoutingTarget {
  probability: number
}

export interface AssistantRoutingDecision {
  /** The pick, whatever its confidence; null when no decision model answered. */
  hint: AssistantRoutingHint | null
  /** Every option the model rated, likeliest first. */
  ranked: RankedRoutingTarget[]
  /** What the message is, when the kind question was asked and answered. */
  kind?: { kind: RoutingKind; confidence: number }
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

export const KIND_INSTRUCTIONS =
  'What is the user’s latest message (state.message)? state.recent is the conversation just before it: the ' +
  'user’s earlier messages and the Assistant’s latest reply.'

const KIND_OPTIONS: Record<RoutingKind, string> = {
  new_request:
    'Asks for work to be done that is not already under way in this conversation, even when it comes as a reply to the Assistant, including redoing earlier work somewhere else (for example in a different squad).',
  follow_up:
    'About work or a request already in this conversation: its progress, details, changes, or more of the same work.',
  conversation:
    'A confirmation, thanks or reaction; answering the Assistant’s question or brainstorming with it without asking for new work; or a question to the Assistant itself, with no work to hand off.',
}

const ACKNOWLEDGEMENT_WORDS = new Set(
  (
    'ok okay k kk yes yeah yep yup ya no nope nah sure thanks thank you ty thx cheers cool great nice perfect ' +
    'awesome amazing good fine lgtm sgtm done got it sounds right alright agreed agree correct exactly please pls ' +
    'go ahead do that this wow haha lol hmm oh ah np noted understood appreciated much very so'
  ).split(' ')
)

/** A short reply that only acknowledges ("ok", "thanks!", "sounds good", "👍"): nothing to route. */
export function isAcknowledgement(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return words.length <= 4 && words.every((word) => ACKNOWLEDGEMENT_WORDS.has(word))
}

/**
 * Why a message needs no decision at all (no call, no cost), or null to ask. Only acknowledgements:
 * a reply to the Assistant's question may still be a new request, which the kind question decides.
 */
export function routingSkipReason(text: string): 'acknowledgement' | null {
  return isAcknowledgement(text) ? 'acknowledgement' : null
}

/** The decision: one choice. Squad names and purposes are ours; the user's words go only in `state`. */
export function buildRoutingRequest(input: {
  text: string
  recent: readonly RecentEntry[]
  squads: readonly RoutingSquad[]
  /** Also ask what kind of message it is (user messages; suggest_squad only asks the scope). */
  withKind?: boolean
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
        recent: input.recent.slice(-(RECENT_USER_MESSAGES + 1)).map((entry) => ({
          role: entry.role,
          text: truncate(entry.text.trim(), RECENT_ENTRY_CHARS),
        })),
      },
      questions: {
        ...(input.withKind
          ? { kind: { type: 'choice' as const, instructions: KIND_INSTRUCTIONS, options: { ...KIND_OPTIONS } } }
          : {}),
        scope: { type: 'choice', instructions: ROUTING_INSTRUCTIONS, options },
      },
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

/**
 * How sure the model is of its pick: the chosen option's own probability. Not a provider's `confidence`,
 * which some (Jev) report as how concentrated the probabilities are, so a 52/41 split scores 0.28.
 */
const pickProbability = (answer: Extract<DecisionAnswer, { type: 'choice' }>) =>
  unit(answer.probabilities?.[answer.choice] ?? answer.confidence)

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
    hint: { ...target, confidence: pickProbability(answer) },
    ranked,
  }
}

/** Just the target fields: no confidence or correction. */
function routingTarget({ scope, squadId, squadName }: AssistantRoutingTarget): AssistantRoutingTarget {
  return { scope, ...(squadId ? { squadId } : {}), ...(squadName ? { squadName } : {}) }
}

/** The kind answer, when it is one of the kinds. */
export function interpretKindAnswer(answer: DecisionAnswer | undefined): AssistantRoutingDecision['kind'] {
  if (answer?.type !== 'choice' || !(ROUTING_KINDS as readonly string[]).includes(answer.choice)) return undefined
  return {
    kind: answer.choice as RoutingKind,
    confidence: pickProbability(answer),
  }
}

/**
 * Ask the decision model where a message belongs. Never throws, and never waits past the timeout:
 * a slow provider is aborted and the Assistant goes on without a hint.
 */
export async function decideAssistantRouting(
  input: { text: string; recent: readonly RecentEntry[]; squads: readonly RoutingSquad[]; withKind?: boolean },
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
    const kind = input.withKind ? interpretKindAnswer(outcome.result.answers.kind) : undefined
    const scope = interpretRoutingAnswer(outcome.result.answers.scope, keys)
    if (!scope) return { hint: null, ranked: [], ...(kind ? { kind } : {}), reason: 'unanswered' }
    return { ...scope, ...(kind ? { kind } : {}) }
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

/**
 * The conversation before a message, for the decision: the user's last few chat messages and the
 * Assistant's latest reply (so a reply to its question can be judged), oldest first, each truncated.
 */
export async function loadRoutingContext(
  message: Pick<Message, 'id' | 'agentId' | 'createdAt'>
): Promise<RoutingContext> {
  const rows = await db
    .select({
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, message.agentId),
        inArray(messages.role, ['human', 'assistant']),
        lt(messages.createdAt, message.createdAt)
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(40)
  // Newest first: the user's own chat messages and the Assistant's rows, never system notices.
  const relevant = rows.filter((row) => {
    const metadata = row.metadata as MessageMetadata | null
    if (row.content.startsWith('[System]') || metadata?.isSystem) return false
    return row.role === 'assistant' || metadata?.source === USER_CHAT_SOURCE
  })
  const userRows = relevant.filter((row) => row.role === 'human' && row.content.trim()).slice(0, RECENT_USER_MESSAGES)
  const reply = relevant.find((row) => row.role === 'assistant' && row.content.trim())
  const recent = [...userRows, ...(reply ? [reply] : [])]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => ({
      role: row.role === 'human' ? ('user' as const) : ('assistant' as const),
      text: truncate(row.content.trim(), RECENT_ENTRY_CHARS),
    }))
  return { recent }
}

/** The conversation's latest saved routing before a message: a hint the user saw, or their correction. */
export async function findInheritedRouting(
  message: Pick<Message, 'id' | 'agentId' | 'createdAt'>
): Promise<InheritedRouting | null> {
  const [row] = await db
    .select({ id: messages.id, metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, message.agentId),
        eq(messages.role, 'human'),
        lt(messages.createdAt, message.createdAt),
        sql`${jsonbObjectRecovered(messages.metadata)} -> 'assistantRouting' IS NOT NULL`
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(1)
  const hint = (row?.metadata as MessageMetadata | null)?.assistantRouting
  return row && hint ? { messageId: row.id, hint } : null
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
 * The rule on a routing decision: a confident follow-up keeps the conversation's earlier routing
 * (when it has some); otherwise the message's target decides, whatever its kind (a question about a
 * squad is for that squad), when it is confident. `hint` is what applies without earlier routing.
 */
export function assistantRoutingVerdict(decision: Pick<AssistantRoutingDecision, 'hint' | 'kind'>): {
  followUp: boolean
  hint: AssistantRoutingHint | null
} {
  const followUp = decision.kind?.kind === 'follow_up' && decision.kind.confidence >= ASSISTANT_ROUTING_MIN_CONFIDENCE
  const hint = decision.hint && decision.hint.confidence >= ASSISTANT_ROUTING_MIN_CONFIDENCE ? decision.hint : null
  return { followUp, hint }
}

/** Where a user's text goes: a confident hint, the conversation's earlier routing for a follow-up, or null. */
export type AssistantTextRouting = { hint: AssistantRoutingHint } | { inherited: InheritedRouting } | null

/**
 * Where a user's text goes, with the conversation before `at` as context. Short acknowledgements
 * are not asked about at all. Otherwise one decision asks what kind of message it is and where it
 * belongs: a confident follow-up keeps the conversation's latest routing; else a confident target
 * is the hint. Used for a sent message and for the composer's preview of a draft. Never throws.
 */
export async function routeAssistantText(
  identity: Identity,
  at: Pick<Message, 'id' | 'agentId' | 'createdAt'>,
  text: string,
  deps: AssistantRoutingDeps = {},
  source: Record<string, string> = { kind: 'assistant', agentId: at.agentId }
): Promise<AssistantTextRouting> {
  try {
    if (!(deps.enabled ?? (() => isDecisionFeatureEnabled('assistant-routing')))()) return null
    const user = await resolveActingUser(identity)
    if (!user) return null
    if (routingSkipReason(text)) return null
    const context = await (deps.loadContext ?? loadRoutingContext)(at)
    const squadList = await (deps.listSquads ?? listRoutableSquads)(user)
    const { hint, kind } = await decideAssistantRouting(
      { text, recent: context.recent, squads: squadList, withKind: true },
      { ...deps, enabled: () => true },
      source
    )
    const verdict = assistantRoutingVerdict({ hint, kind })
    // A confident follow-up keeps the conversation's earlier routing, when it has some.
    if (verdict.followUp) {
      const inherited = await (deps.findInherited ?? findInheritedRouting)(at)
      if (inherited) return { inherited }
    }
    return verdict.hint ? { hint: verdict.hint } : null
  } catch (error) {
    log.warn('Could not route Assistant text', error)
    return null
  }
}

/**
 * Route one user message to the Assistant (see `routeAssistantText`):
 * - a confident hint is saved on the message (the UI shows its chip; the model reads it with the message);
 * - a confident follow-up carries the conversation's latest routing to the model, unsaved, with no chip;
 * - anything else comes back unchanged. A message sent with routing from the composer already has
 *   it and is not asked about again. Never throws.
 */
export async function annotateAssistantMessage(
  identity: Identity,
  message: Message,
  deps: AssistantRoutingDeps = {}
): Promise<Message> {
  if (!isRoutableUserMessage(message)) return message
  try {
    const routing = await routeAssistantText(identity, message, message.content, deps)
    if (!routing) return message
    if ('inherited' in routing)
      return {
        ...message,
        metadata: {
          ...message.metadata,
          assistantRoutingInherited: {
            ...routingTarget(effectiveAssistantRouting(routing.inherited.hint)),
            fromMessageId: routing.inherited.messageId,
          },
        },
      }
    const { hint } = routing
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
