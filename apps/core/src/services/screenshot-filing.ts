import { createHash } from 'node:crypto'
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import {
  DECISION_IMAGE_MEDIA_TYPES,
  SCREENSHOT_ACTIONS,
  SCREENSHOT_GUESS_MIN_PROBABILITY,
  SCREENSHOT_KINDS,
  type DecisionAnswer,
  type DecisionRequest,
  type FileScreenshotRequest,
  type FileScreenshotResponse,
  type GuessScreenshotRequest,
  type GuessScreenshotResponse,
  type ScreenshotAction,
  type ScreenshotChoices,
  type ScreenshotGuess,
  type ScreenshotKind,
  type ScreenshotWorkStreamsResponse,
} from '@ficus/shared'
import { assistantConversations, db, workStreams } from '../db'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Image } from '../entities/Image'
import { User } from '../entities/User'
import { ensureAssistantConversationAgent } from './assistant-conversation-agent'
import { decisionImageCopy } from './images/decision-image'
import { requireAssistantConversation } from './assistant-task-requests'
import { InvalidAttachmentError } from './attachments/agent-scope'
import { ChatIdempotencyConflictError } from './chat/consultant-idempotency'
import { decide as defaultDecide, isDecisionFeatureEnabled } from './decisions/service'
import { captureCorrection as defaultCaptureCorrection } from './decisions/evals/capture'
import { findVisibleSquad, listVisibleSquads } from './entity-search'
import { hasPermission, resolveActingUser, type Identity, type UserIdentity } from './rbac'
import { createLogger } from '../lib/infra/logger'
import { splitModelPriorityList, supportsImageInput } from '../lib/utils/model-spec'

const log = createLogger('screenshot-filing')

/** A choice question takes at most 64 options; one is "none". */
const MAX_SQUADS = 63
const MAX_WORK_STREAMS = 63
/** How many open work streams the review card's picker lists, most recently active first. */
const MAX_LISTED_WORK_STREAMS = 200
const NO_SQUAD = 'none'
const NO_WORK_STREAM = 'none'

export interface ScreenshotFilingDeps {
  decide?: typeof defaultDecide
  isEnabled?: () => boolean
  captureCorrection?: typeof defaultCaptureCorrection
}

export interface ScreenshotSquad {
  id: string
  name: string
  purpose: string | null
  /** Active or queued work streams, so "add it to an existing work stream" is only offered where there are some. */
  openWorkStreams?: number
}

/** An open work stream in a squad, offered by the second question. */
export interface ScreenshotWorkStream {
  id: string
  title: string
  description: string
}

function filingError(status: 400 | 403 | 404 | 409, message: string) {
  return new HTTPException(status, { message, res: Response.json({ error: message }, { status }) })
}

/** A stable UUID for one filing, so a retried request lands on the same conversation and message. */
function stableUuid(...parts: string[]): string {
  const bytes = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** A squad's option key: decision names are lowercase letters, digits and underscores. */
export function squadOptionKey(squadId: string): string {
  return `s_${squadId.replaceAll('-', '').toLowerCase()}`
}

/**
 * The first question a screenshot's guess asks. Everything that came from the user (the image and
 * their note) goes only in `images` and `state`, which decision models treat as data; the questions
 * and their options are Ficus's own, including each squad's name and purpose.
 */
export function buildScreenshotDecision(input: {
  image: { mediaType: (typeof DECISION_IMAGE_MEDIA_TYPES)[number]; base64: string }
  note?: string
  squads: ScreenshotSquad[]
}): DecisionRequest {
  const squads = input.squads.slice(0, MAX_SQUADS)
  const streams = (squad: ScreenshotSquad) =>
    squad.openWorkStreams === undefined
      ? ''
      : squad.openWorkStreams
        ? ` (${squad.openWorkStreams} open work stream${squad.openWorkStreams === 1 ? '' : 's'})`
        : ' (no open work streams)'
  const describe = (squad: ScreenshotSquad) =>
    (squad.purpose?.trim() ? `${squad.name}: ${squad.purpose.trim()}` : squad.name).slice(0, 960) + streams(squad)
  return {
    state: {
      input: 'A screenshot the user dropped into Ficus to be filed with the right squad.',
      ...(input.note ? { note: input.note } : {}),
    },
    images: [input.image],
    questions: {
      kind: {
        type: 'choice',
        instructions: 'What the screenshot shows.',
        options: Object.fromEntries(Object.entries(SCREENSHOT_KINDS).map(([id, kind]) => [id, kind.description])),
      },
      ...(squads.length
        ? {
            squad: {
              type: 'choice' as const,
              instructions: "Which squad's work the screenshot is about, judged by each squad's name and purpose.",
              options: {
                ...Object.fromEntries(squads.map((squad) => [squadOptionKey(squad.id), describe(squad)])),
                [NO_SQUAD]: 'None of these squads.',
              },
            },
          }
        : {}),
      action: {
        type: 'choice',
        instructions: 'What should happen with the screenshot.',
        options: Object.fromEntries(Object.entries(SCREENSHOT_ACTIONS).map(([id, action]) => [id, action.description])),
      },
    },
  }
}

/** A work stream's option key: its place in `state.workStreams`. */
export function workStreamOptionKey(index: number): string {
  return `w${index + 1}`
}

/**
 * The second question, asked only when the guessed squad has open work streams: which of them the
 * screenshot is about. Work stream titles and descriptions can come from anywhere (issue titles,
 * agents), so they go in `state` as data; the options only point at them.
 */
export function buildScreenshotWorkStreamDecision(input: {
  image: { mediaType: (typeof DECISION_IMAGE_MEDIA_TYPES)[number]; base64: string }
  note?: string
  squadName: string
  workStreams: ScreenshotWorkStream[]
}): DecisionRequest {
  const streams = input.workStreams.slice(0, MAX_WORK_STREAMS)
  return {
    state: {
      input: `A screenshot the user dropped into Ficus, filed with the squad ${JSON.stringify(input.squadName)}. workStreams lists that squad's open work streams.`,
      ...(input.note ? { note: input.note } : {}),
      workStreams: streams.map((stream, index) => ({
        option: workStreamOptionKey(index),
        title: stream.title,
        description: stream.description.trim().slice(0, 400),
      })),
    },
    images: [input.image],
    questions: {
      work_stream: {
        type: 'choice',
        instructions:
          'Which work stream in workStreams the screenshot is about: pick one only when the screenshot is clearly about that work.',
        options: {
          ...Object.fromEntries(
            streams.map((_, index) => [
              workStreamOptionKey(index),
              `The work stream with option ${workStreamOptionKey(index)} in workStreams.`,
            ])
          ),
          [NO_WORK_STREAM]: 'None of them: it is not about work already under way.',
        },
      },
    },
  }
}

function chosen(answer: DecisionAnswer | undefined): { choice: string; probability: number } | null {
  if (answer?.type !== 'choice') return null
  return { choice: answer.choice, probability: answer.probabilities[answer.choice] ?? answer.confidence ?? 0 }
}

type WorkStreamPick = { id: string; title: string; probability: number }

/** The stream the work stream question chose, however sure it was; null for "none" or no answer. */
function chosenWorkStream(answer: DecisionAnswer | undefined, streams: ScreenshotWorkStream[]): WorkStreamPick | null {
  const picked = chosen(answer)
  const stream = picked ? streams.find((_, index) => workStreamOptionKey(index) === picked.choice) : undefined
  return stream && picked ? { id: stream.id, title: stream.title, probability: picked.probability } : null
}

/** The work stream question's pick, when it is clear enough; null for "none" or a weak pick. */
export function pickWorkStream(
  answer: DecisionAnswer | undefined,
  streams: ScreenshotWorkStream[]
): WorkStreamPick | null {
  const stream = chosenWorkStream(answer, streams)
  return stream && stream.probability >= SCREENSHOT_GUESS_MIN_PROBABILITY ? stream : null
}

/**
 * The guess in a decision's answers, or null when the kind or action was refused. `workStreams` is
 * the second question's answer and the streams it was asked about, when it was asked. Only a clear
 * work stream pick sets the action. A weak one is carried as `workStreamSuggestion` and changes
 * nothing, except that an action already answered as "existing work stream" then has a stream to
 * offer and so does not fall back.
 */
export function readScreenshotGuess(
  answers: Record<string, DecisionAnswer>,
  squads: ScreenshotSquad[],
  workStreams?: { answer: DecisionAnswer | undefined; streams: ScreenshotWorkStream[] }
): ScreenshotGuess | null {
  const kind = chosen(answers.kind)
  const action = chosen(answers.action)
  if (!kind || !(kind.choice in SCREENSHOT_KINDS) || !action || !(action.choice in SCREENSHOT_ACTIONS)) return null
  const squadAnswer = chosen(answers.squad)
  const squad = squadAnswer ? squads.find((candidate) => squadOptionKey(candidate.id) === squadAnswer.choice) : null
  const workStream: ScreenshotGuess['workStream'] = workStreams
    ? pickWorkStream(workStreams.answer, workStreams.streams)
    : undefined
  // A pick under the bar, in the squad it was asked about: shown as "not sure", never acted on.
  const suggestion =
    squad && workStreams && !workStream ? chosenWorkStream(workStreams.answer, workStreams.streams) : null
  if (workStream) {
    // It names the work it belongs to: add it there.
    action.choice = 'existing_work_stream'
    action.probability = workStream.probability
  } else if (
    action.choice === 'existing_work_stream' &&
    !suggestion &&
    (!squad || squad.openWorkStreams === 0 || workStream === null)
  ) {
    // "Add it to an existing work stream" makes no sense without one that fits: take the next likeliest action.
    const probabilities = answers.action?.type === 'choice' ? answers.action.probabilities : {}
    const others = Object.keys(SCREENSHOT_ACTIONS).filter((id) => id !== 'existing_work_stream')
    const next = others.sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0))[0]!
    // Its share among the actions still possible, so ruling "existing" out doesn't make it look unsure.
    const rest = others.reduce((total, id) => total + (probabilities[id] ?? 0), 0)
    action.choice = next
    action.probability = rest > 0 ? (probabilities[next] ?? 0) / rest : 0
  }
  return {
    kind: {
      id: kind.choice as ScreenshotKind,
      label: SCREENSHOT_KINDS[kind.choice as ScreenshotKind].label,
      probability: kind.probability,
    },
    squad: squad && squadAnswer ? { id: squad.id, name: squad.name, probability: squadAnswer.probability } : null,
    ...(squadAnswer?.choice === NO_SQUAD ? { noSquadProbability: squadAnswer.probability } : {}),
    action: {
      id: action.choice as ScreenshotAction,
      label: SCREENSHOT_ACTIONS[action.choice as ScreenshotAction].label,
      probability: action.probability,
    },
    ...(workStream !== undefined ? { workStream } : {}),
    ...(suggestion ? { workStreamSuggestion: suggestion } : {}),
  }
}

/** What the user confirmed on the review card, resolved to what the Assistant is told. */
export interface ConfirmedScreenshot {
  kind?: ScreenshotKind
  /** Null is the explicit choice "No squad"; absent means the user left it to the Assistant. */
  squad?: { id: string; name: string } | null
  action?: ScreenshotAction
  workStream?: { id: string; title: string }
}

/**
 * The first message of a screenshot's conversation: the user's note first, then the choices they
 * confirmed on the review card, stated as theirs (not as a guess to double-check).
 */
export function screenshotFilingMessage(input: { imageId: string; note?: string; confirmed: ConfirmedScreenshot }) {
  const { confirmed } = input
  const choices: string[] = []
  const open: string[] = []
  if (confirmed.kind) choices.push(`- Kind: ${SCREENSHOT_KINDS[confirmed.kind].label}`)
  else open.push('what it shows')
  if (confirmed.squad) choices.push(`- Squad: ${confirmed.squad.name} (squad ID ${confirmed.squad.id})`)
  else if (confirmed.squad === null) choices.push("- Squad: none. Don't file it with a squad.")
  else open.push('which squad it belongs to')
  if (confirmed.action) choices.push(`- Action: ${SCREENSHOT_ACTIONS[confirmed.action].label}`)
  else open.push('what to do with it')
  if (confirmed.workStream)
    choices.push(
      `- Work stream: ${JSON.stringify(confirmed.workStream.title)} (work stream ID ${confirmed.workStream.id})`
    )
  else if (confirmed.action === 'existing_work_stream') open.push('which work stream it is about')

  const lines: string[] = []
  if (input.note) lines.push(input.note, '')
  if (choices.length) {
    lines.push(
      'Please file the attached screenshot. I reviewed and confirmed these choices myself, so follow them:',
      ...choices
    )
    if (open.length) lines.push(`I left the rest for you to decide: ${open.join(', ')}.`)
  } else {
    lines.push('Please look at the attached screenshot and file it in the right place.')
  }
  lines.push(
    '',
    `The screenshot is attached (image ID ${input.imageId}). When you hand it to a squad, pass it as imageIds so they can see it.`
  )
  return lines.join('\n')
}

/** The fields of the review card the user changed from what the guess filled in. */
export type ScreenshotCorrectedField = 'kind' | 'squad' | 'action' | 'workStream'

/**
 * Which fields the user changed from the guess. A field left unchosen is not a correction. For the
 * work stream, picking a different one (or one where none was guessed) is; dropping a guessed one
 * is only when the user also chose another action, which says it is not about work under way.
 * `guessed` is what the card showed: it holds a weak work stream suggestion only when the card
 * pre-selected it, so replacing or dropping one the user saw is a correction, and one they never
 * saw is not.
 */
export function screenshotCorrections(
  guessed: ScreenshotChoices | undefined,
  confirmed: ScreenshotChoices
): ScreenshotCorrectedField[] {
  if (!guessed) return []
  const changed: ScreenshotCorrectedField[] = []
  if (confirmed.kind !== undefined && confirmed.kind !== guessed.kind) changed.push('kind')
  if (confirmed.squadId !== undefined && confirmed.squadId !== guessed.squadId) changed.push('squad')
  if (confirmed.action !== undefined && confirmed.action !== guessed.action) changed.push('action')
  if (confirmed.workStreamId !== guessed.workStreamId) {
    const droppedForAnotherAction = confirmed.action !== undefined && confirmed.action !== 'existing_work_stream'
    if (confirmed.workStreamId !== undefined || droppedForAnotherAction) changed.push('workStream')
  }
  return changed
}

async function senderOf(userId: string) {
  const user = await User.findById(userId).catch(() => null)
  return { userId, name: user?.displayName || user?.email || 'a user' }
}

async function visibleSquads(identity: Identity): Promise<ScreenshotSquad[]> {
  const rows = (await listVisibleSquads(identity, 100))
    .filter((squad) => squad.status !== 'archived')
    .slice(0, MAX_SQUADS)
  const open = rows.length
    ? await db
        .select({ squadId: workStreams.squadId, open: count() })
        .from(workStreams)
        .where(
          and(
            inArray(
              workStreams.squadId,
              rows.map((squad) => squad.id)
            ),
            inArray(workStreams.status, ['active', 'queued'])
          )
        )
        .groupBy(workStreams.squadId)
    : []
  const openBySquad = new Map(open.map((row) => [row.squadId, Number(row.open)]))
  return rows.map((squad) => ({
    id: squad.id,
    name: squad.name,
    purpose: squad.purpose,
    openWorkStreams: openBySquad.get(squad.id) ?? 0,
  }))
}

/** The squad's open work streams, most recently active first, when the user may read them. */
async function openWorkStreams(
  identity: Identity,
  squadId: string,
  limit = MAX_WORK_STREAMS
): Promise<ScreenshotWorkStream[]> {
  if (!(await hasPermission(identity, 'workstreams:read', squadId))) return []
  return db
    .select({ id: workStreams.id, title: workStreams.title, description: workStreams.description })
    .from(workStreams)
    .where(and(eq(workStreams.squadId, squadId), inArray(workStreams.status, ['active', 'queued'])))
    .orderBy(desc(workStreams.updatedAt))
    .limit(limit)
}

/** A squad a screenshot can be filed with: one the user can see that is not archived. */
async function filingSquad(identity: Identity, squadId: string) {
  const squad = await findVisibleSquad(identity, squadId)
  return squad && squad.status !== 'archived' ? squad : null
}

async function actingUser(identity: Identity | undefined): Promise<UserIdentity> {
  const user = await resolveActingUser(identity)
  if (!user) throw filingError(403, 'Forbidden')
  return user
}

/** Only the user's own staged upload: not yet sent anywhere, not bound to an agent or squad. */
function isStagedBy(image: Image | null, userId: string): image is Image {
  return Boolean(
    image &&
    image.status === 'pending' &&
    image.agentId === null &&
    image.squadId === null &&
    image.uploadedByUserId === userId
  )
}

/**
 * Guess what a dropped screenshot is and where it belongs, for the review card: nothing is created
 * and nothing is sent. Null when the feature is off, no decision model that reads images answers,
 * or the image cannot be prepared; a second question picks the guessed squad's open work stream
 * when it has some.
 */
export async function guessScreenshot(
  identity: Identity | undefined,
  input: GuessScreenshotRequest,
  deps: ScreenshotFilingDeps = {}
): Promise<GuessScreenshotResponse> {
  const user = await actingUser(identity)
  const image = await Image.find(input.imageId)
  if (!isStagedBy(image, user.userId)) throw filingError(404, 'Screenshot not found')
  if (!(deps.isEnabled ?? (() => isDecisionFeatureEnabled('screenshot-filing')))()) return { guess: null }
  // The decision sees a small copy; the conversation keeps the original.
  const copy = await decisionImageCopy(await image.getBuffer()).catch((error) => {
    log.warn('Could not prepare a screenshot for the decision model', error)
    return null
  })
  if (!copy) return { guess: null }
  const decide = deps.decide ?? defaultDecide
  const source = { kind: 'screenshot', userId: user.userId }
  try {
    const squads = await visibleSquads(user)
    const outcome = await decide('screenshot-filing', buildScreenshotDecision({ image: copy.image, squads }), {
      source,
    })
    if (!outcome.ok) return { guess: null }
    const guess = readScreenshotGuess(outcome.result.answers, squads)
    const squad = guess && squads.find((candidate) => candidate.id === guess.squad?.id)
    const streams = squad?.openWorkStreams ? await openWorkStreams(user, squad.id) : []
    if (!squad || !streams.length) return { guess }
    const second = await decide(
      'screenshot-filing',
      buildScreenshotWorkStreamDecision({ image: copy.image, squadName: squad.name, workStreams: streams }),
      { source }
    ).catch((error) => {
      log.warn('Screenshot work stream decision failed', error)
      return null
    })
    if (!second?.ok) return { guess }
    return {
      guess: readScreenshotGuess(outcome.result.answers, squads, {
        answer: second.result.answers.work_stream,
        streams,
      }),
    }
  } catch (error) {
    // Filing never depends on the guess.
    log.warn('Screenshot decision failed', error)
    return { guess: null }
  }
}

/** The open work streams of a squad the user can see, for the review card's picker. */
export async function listScreenshotWorkStreams(
  identity: Identity | undefined,
  squadId: string
): Promise<ScreenshotWorkStreamsResponse> {
  const user = await actingUser(identity)
  if (!(await filingSquad(user, squadId))) throw filingError(404, 'Squad not found')
  const streams = await openWorkStreams(user, squadId, MAX_LISTED_WORK_STREAMS)
  return { workStreams: streams.map(({ id, title }) => ({ id, title })) }
}

/** The confirmed choices, checked against what this user may see: a visible squad, and an open work stream in it. */
async function confirmedScreenshot(user: UserIdentity, input: FileScreenshotRequest): Promise<ConfirmedScreenshot> {
  const squad = input.squadId ? await filingSquad(user, input.squadId) : null
  if (input.squadId && !squad) throw filingError(404, 'Squad not found')
  let workStream: ConfirmedScreenshot['workStream']
  if (input.workStreamId) {
    const [stream] =
      squad && (await hasPermission(user, 'workstreams:read', squad.id))
        ? await db
            .select({ id: workStreams.id, title: workStreams.title })
            .from(workStreams)
            .where(
              and(
                eq(workStreams.id, input.workStreamId),
                eq(workStreams.squadId, squad.id),
                inArray(workStreams.status, ['active', 'queued'])
              )
            )
        : []
    if (!stream) throw filingError(404, 'Work stream not found')
    workStream = stream
  }
  return {
    ...(input.kind ? { kind: input.kind } : {}),
    // `squadId: null` is the explicit "No squad"; leaving it out leaves the squad to the Assistant.
    ...(input.squadId !== undefined ? { squad: squad && { id: squad.id, name: squad.name } } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(workStream ? { workStream } : {}),
  }
}

function conversationTitle(confirmed: ConfirmedScreenshot): string {
  const where = confirmed.squad ? ` in ${confirmed.squad.name}` : ''
  if (confirmed.kind) return `Screenshot: ${SCREENSHOT_KINDS[confirmed.kind].label}${where}`.slice(0, 120)
  return where ? `Screenshot${where}`.slice(0, 120) : 'Filed screenshot'
}

/**
 * Save the fields the user changed from the guess as candidate eval cases (only while capture is
 * on): kind, squad and action for the first question, the work stream for the second. Each request
 * is rebuilt the way the guess builds it, with the note the user filed it with.
 */
function captureScreenshotCorrections(
  user: UserIdentity,
  image: Image,
  input: FileScreenshotRequest,
  confirmed: ConfirmedScreenshot,
  capture: typeof defaultCaptureCorrection
) {
  const changed = screenshotCorrections(input.guessed, input)
  if (!changed.length) return
  const copyOf = async () => (await decisionImageCopy(await image.getBuffer()))?.image ?? null
  const source = { kind: 'screenshot-review' }
  const squadName = confirmed.squad?.name ?? null
  const expect = {
    ...(changed.includes('kind') ? { kind: confirmed.kind } : {}),
    ...(changed.includes('squad') ? { squad: squadName } : {}),
    ...(changed.includes('action') ? { action: confirmed.action } : {}),
  }
  if (Object.keys(expect).length)
    void capture({
      evalName: 'screenshot-filing',
      purpose: 'screenshot-filing',
      build: async () => {
        const copy = await copyOf()
        if (!copy) return null
        const squads = await visibleSquads(user)
        // The question only offers these; a squad outside them cannot be a case for it.
        if (changed.includes('squad') && confirmed.squad && !squads.some(({ id }) => id === confirmed.squad!.id))
          return null
        return { request: buildScreenshotDecision({ image: copy, note: input.note, squads }), context: { squads } }
      },
      expect,
      summary: `Screenshot → ${[
        changed.includes('kind') && confirmed.kind && SCREENSHOT_KINDS[confirmed.kind].label,
        changed.includes('squad') && (squadName ?? 'no squad'),
        changed.includes('action') && confirmed.action && SCREENSHOT_ACTIONS[confirmed.action].label,
      ]
        .filter(Boolean)
        .join(', ')}`,
      source,
    })
  const squad = confirmed.squad
  if (changed.includes('workStream') && squad)
    void capture({
      evalName: 'screenshot-work-stream',
      purpose: 'screenshot-filing',
      build: async () => {
        const streams = await openWorkStreams(user, squad.id)
        // The question is only asked about these; a pick outside them cannot be a case for it.
        if (!streams.length || (confirmed.workStream && !streams.some(({ id }) => id === confirmed.workStream!.id)))
          return null
        const copy = await copyOf()
        if (!copy) return null
        return {
          request: buildScreenshotWorkStreamDecision({
            image: copy,
            note: input.note,
            squadName: squad.name,
            workStreams: streams,
          }),
          context: { streams },
        }
      },
      expect: confirmed.workStream?.title ?? null,
      summary: `Screenshot in ${squad.name} → ${confirmed.workStream ? JSON.stringify(confirmed.workStream.title) : 'no open work stream'}`,
      source,
    })
}

function imagesUnreadableError() {
  return filingError(400, "The Assistant's model cannot read images. Choose a vision-capable model.")
}

/**
 * Whether the Assistant a filing goes to can read images, asked before the filing creates anything;
 * undefined when its model is not known. A conversation left by an earlier attempt keeps its own
 * Assistant and that Assistant's model. A new one gets a new Assistant, on the Assistant type's model.
 */
async function assistantReadsImages(userId: string, conversationId: string): Promise<boolean | undefined> {
  const [conversation] = await db
    .select({ agentId: assistantConversations.agentId })
    .from(assistantConversations)
    .where(and(eq(assistantConversations.id, conversationId), eq(assistantConversations.ownerUserId, userId)))
  if (conversation?.agentId) return (await Agent.find(conversation.agentId))?.supportsSelectedModelImages()
  const model = (await AgentType.find('assistant'))?.model?.trim()
  return model ? supportsImageInput(splitModelPriorityList(model)[0]!) : undefined
}

/**
 * File a screenshot the user confirmed on the review card: start a new Assistant conversation of
 * theirs with the image, their note and the choices they confirmed, so the Assistant files it with
 * its normal tools. Nothing here asks a decision model; the guess was made before, by `guessScreenshot`.
 */
export async function fileScreenshot(
  identity: Identity | undefined,
  input: FileScreenshotRequest,
  deps: ScreenshotFilingDeps = {}
): Promise<FileScreenshotResponse> {
  const user = await actingUser(identity)
  const image = await Image.find(input.imageId)
  const conversationId = stableUuid('screenshot-conversation', user.userId, input.imageId)
  if (image?.agentId && image.uploadedByUserId === user.userId) {
    // A retry after the filing committed (a lost response): the same conversation, nothing sent twice.
    const [filed] = await db
      .select({ id: assistantConversations.id })
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.id, conversationId),
          eq(assistantConversations.ownerUserId, user.userId),
          eq(assistantConversations.agentId, image.agentId)
        )
      )
    if (filed) return { conversationId }
  }
  if (!isStagedBy(image, user.userId)) throw filingError(404, 'Screenshot not found')
  // Both checked before anything is created, so a refused confirm leaves no conversation behind.
  const confirmed = await confirmedScreenshot(user, input)
  if ((await assistantReadsImages(user.userId, conversationId)) === false) throw imagesUnreadableError()

  await db
    .insert(assistantConversations)
    .values({ id: conversationId, ownerUserId: user.userId, title: 'Filed screenshot' })
    .onConflictDoNothing()
  await requireAssistantConversation(identity, conversationId)
  const { agentId } = await ensureAssistantConversationAgent(identity, conversationId)
  const assistant = await Agent.mustFind(agentId)
  // Only reached when the model changed since the check above.
  if (assistant.supportsSelectedModelImages() === false) throw imagesUnreadableError()

  await db
    .update(assistantConversations)
    .set({ title: conversationTitle(confirmed), updatedAt: new Date() })
    .where(and(eq(assistantConversations.id, conversationId), eq(assistantConversations.ownerUserId, user.userId)))

  try {
    await assistant.sendMessage(screenshotFilingMessage({ imageId: image.id, note: input.note, confirmed }), {
      imageIds: [image.id],
      attachmentActorUserId: user.userId,
      metadata: {
        source: 'user_chat',
        sender: await senderOf(user.userId),
        clientId: stableUuid('screenshot-message', conversationId, image.id),
      },
    })
  } catch (error) {
    if (error instanceof InvalidAttachmentError || error instanceof ChatIdempotencyConflictError)
      throw filingError(409, 'This screenshot was already filed')
    throw error
  }
  captureScreenshotCorrections(user, image, input, confirmed, deps.captureCorrection ?? defaultCaptureCorrection)
  return { conversationId }
}
