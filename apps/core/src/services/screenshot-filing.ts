import { createHash } from 'node:crypto'
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import {
  DECISION_IMAGE_MEDIA_TYPES,
  SCREENSHOT_ACTIONS,
  SCREENSHOT_KINDS,
  SCREENSHOT_WORK_STREAM_MIN_PROBABILITY,
  screenshotGuessSummary,
  type DecisionAnswer,
  type DecisionRequest,
  type FileScreenshotRequest,
  type FileScreenshotResponse,
  type ScreenshotAction,
  type ScreenshotCorrection,
  type ScreenshotGuess,
  type ScreenshotKind,
} from '@ficus/shared'
import { assistantConversations, db, messages, workStreams } from '../db'
import { Agent } from '../entities/Agent'
import { Image } from '../entities/Image'
import { User } from '../entities/User'
import { ensureAssistantConversationAgent } from './assistant-conversation-agent'
import { decisionImageCopy } from './images/decision-image'
import { requireAssistantConversation } from './assistant-task-requests'
import { InvalidAttachmentError } from './attachments/agent-scope'
import { ChatIdempotencyConflictError } from './chat/consultant-idempotency'
import { decide as defaultDecide, isDecisionFeatureEnabled } from './decisions/service'
import { captureCorrection } from './decisions/evals/capture'
import { listVisibleSquads } from './entity-search'
import { hasPermission, resolveActingUser, type Identity } from './rbac'
import { createLogger } from '../lib/infra/logger'

const log = createLogger('screenshot-filing')

/** A choice question takes at most 64 options; one is "none". */
const MAX_SQUADS = 63
const MAX_WORK_STREAMS = 63
const NO_SQUAD = 'none'
const NO_WORK_STREAM = 'none'

export interface ScreenshotFilingDeps {
  decide?: typeof defaultDecide
  isEnabled?: () => boolean
}

export interface ScreenshotSquad {
  id: string
  name: string
  purpose: string | null
  /** Active or queued work streams, so "add it to an existing work stream" is only offered where there are some. */
  openWorkStreams?: number
}

/** An open work stream in the guessed squad, offered by the second question. */
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
 * The one decision a screenshot is filed with. Everything that came from the user (the image and
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

/** The work stream question's pick, when it is clear enough; null for "none" or a weak pick. */
export function pickWorkStream(
  answer: DecisionAnswer | undefined,
  streams: ScreenshotWorkStream[]
): { id: string; title: string; probability: number } | null {
  const picked = chosen(answer)
  const stream = picked ? streams.find((_, index) => workStreamOptionKey(index) === picked.choice) : undefined
  return stream && picked && picked.probability >= SCREENSHOT_WORK_STREAM_MIN_PROBABILITY
    ? { id: stream.id, title: stream.title, probability: picked.probability }
    : null
}

/**
 * The guess in a decision's answers, or null when the kind or action was refused. `workStreams` is
 * the second question's answer and the streams it was asked about, when it was asked.
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
  if (workStream) {
    // It names the work it belongs to: add it there.
    action.choice = 'existing_work_stream'
    action.probability = workStream.probability
  } else if (
    action.choice === 'existing_work_stream' &&
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
    action: {
      id: action.choice as ScreenshotAction,
      label: SCREENSHOT_ACTIONS[action.choice as ScreenshotAction].label,
      probability: action.probability,
    },
    ...(workStream !== undefined ? { workStream } : {}),
  }
}

const percent = (probability: number) => `${Math.round(probability * 100)}%`

/** The first message of a screenshot's conversation: what was guessed, as context the Assistant checks. */
export function screenshotFilingMessage(input: { imageId: string; note?: string; guess: ScreenshotGuess | null }) {
  const { guess } = input
  const lines: string[] = []
  if (guess) {
    const where = guess.squad
      ? ` in ${guess.squad.name} (${percent(guess.squad.probability)})`
      : ` (${percent(guess.kind.probability)}); no squad stood out`
    lines.push(
      `Filed screenshot: ${screenshotGuessSummary(guess)}${where}. Please file it in the right place.`,
      '',
      'What a decision model guessed from the image (it can be wrong, so look at the image yourself):',
      `- Kind: ${guess.kind.label} (${percent(guess.kind.probability)})`,
      guess.squad
        ? `- Squad: ${guess.squad.name}, squad ID ${guess.squad.id} (${percent(guess.squad.probability)})`
        : '- Squad: none stood out',
      `- Suggested action: ${guess.action.label} (${percent(guess.action.probability)})`
    )
    if (guess.workStream)
      lines.push(
        `- Work stream: ${JSON.stringify(guess.workStream.title)}, work stream ID ${guess.workStream.id} (${percent(guess.workStream.probability)})`
      )
    else if (guess.workStream === null) lines.push("- Work stream: none of the squad's open ones stood out")
  } else {
    lines.push('Filed screenshot. Please look at it and file it in the right place.')
  }
  if (input.note) lines.push('', `My note: ${input.note}`)
  lines.push(
    '',
    `The screenshot is attached (image ID ${input.imageId}). When you hand it to a squad, pass it as imageIds so they can see it.`
  )
  return lines.join('\n')
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
async function openWorkStreams(identity: Identity, squadId: string): Promise<ScreenshotWorkStream[]> {
  if (!(await hasPermission(identity, 'workstreams:read', squadId))) return []
  return db
    .select({ id: workStreams.id, title: workStreams.title, description: workStreams.description })
    .from(workStreams)
    .where(and(eq(workStreams.squadId, squadId), inArray(workStreams.status, ['active', 'queued'])))
    .orderBy(desc(workStreams.updatedAt))
    .limit(MAX_WORK_STREAMS)
}

/**
 * File a dropped screenshot: guess what it is and where it belongs (when the feature is on and a
 * decision model that reads images answers; a second question picks the squad's open work stream
 * when it has some), then start a new Assistant conversation for the user
 * with the image and the guess, so the Assistant files it with its normal tools.
 */
export async function fileScreenshot(
  identity: Identity | undefined,
  input: FileScreenshotRequest,
  deps: ScreenshotFilingDeps = {}
): Promise<FileScreenshotResponse> {
  const user = await resolveActingUser(identity)
  if (!user) throw filingError(403, 'Forbidden')
  const image = await Image.find(input.imageId)
  const conversationId = stableUuid('screenshot-conversation', user.userId, input.imageId)
  if (image?.agentId && image.uploadedByUserId === user.userId) {
    // A retry after the filing committed (a lost response): the same conversation, without re-asking.
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
    if (filed) return { conversationId, guess: null }
  }
  // Only the user's own staged upload: not yet sent anywhere, not bound to an agent or squad.
  if (
    !image ||
    image.status !== 'pending' ||
    image.agentId !== null ||
    image.squadId !== null ||
    image.uploadedByUserId !== user.userId
  )
    throw filingError(404, 'Screenshot not found')

  await db
    .insert(assistantConversations)
    .values({ id: conversationId, ownerUserId: user.userId, title: 'Filed screenshot' })
    .onConflictDoNothing()
  await requireAssistantConversation(identity, conversationId)
  const { agentId } = await ensureAssistantConversationAgent(identity, conversationId)
  const assistant = await Agent.mustFind(agentId)
  if (assistant.supportsSelectedModelImages() === false)
    throw filingError(400, "The Assistant's model cannot read images. Choose a vision-capable model.")

  let guess: ScreenshotGuess | null = null
  if ((deps.isEnabled ?? (() => isDecisionFeatureEnabled('screenshot-filing')))()) {
    // The decision sees a small copy; the conversation keeps the original.
    const copy = await decisionImageCopy(await image.getBuffer()).catch((error) => {
      log.warn('Could not prepare a screenshot for the decision model', error)
      return null
    })
    if (copy) {
      const squads = await visibleSquads(user)
      const request = buildScreenshotDecision({ image: copy.image, note: input.note, squads })
      try {
        const outcome = await (deps.decide ?? defaultDecide)('screenshot-filing', request, {
          source: { kind: 'screenshot', userId: user.userId },
        })
        if (outcome.ok) {
          guess = readScreenshotGuess(outcome.result.answers, squads)
          const squad = guess && squads.find((candidate) => candidate.id === guess!.squad?.id)
          const streams = squad?.openWorkStreams ? await openWorkStreams(user, squad.id) : []
          if (streams.length) {
            const second = await (deps.decide ?? defaultDecide)(
              'screenshot-filing',
              buildScreenshotWorkStreamDecision({
                image: copy.image,
                note: input.note,
                squadName: squad!.name,
                workStreams: streams,
              }),
              { source: { kind: 'screenshot', userId: user.userId } }
            ).catch((error) => {
              log.warn('Screenshot work stream decision failed', error)
              return null
            })
            if (second?.ok)
              guess = readScreenshotGuess(outcome.result.answers, squads, {
                answer: second.result.answers.work_stream,
                streams,
              })
          }
        }
      } catch (error) {
        // Filing never depends on the guess.
        log.warn('Screenshot decision failed', error)
      }
    }
  }

  const title = guess
    ? `Screenshot: ${guess.kind.label}${guess.squad ? ` in ${guess.squad.name}` : ''}`.slice(0, 120)
    : 'Filed screenshot'
  await db
    .update(assistantConversations)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(assistantConversations.id, conversationId), eq(assistantConversations.ownerUserId, user.userId)))

  try {
    await assistant.sendMessage(screenshotFilingMessage({ imageId: image.id, note: input.note, guess }), {
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
  return { conversationId, guess }
}

/** The filing question for a filed screenshot, rebuilt from its conversation's first message. */
async function screenshotRequestForConversation(identity: Identity, agentId: string) {
  const [first] = await db
    .select({ content: messages.content, metadata: messages.metadata })
    .from(messages)
    .where(and(eq(messages.agentId, agentId), eq(messages.role, 'human')))
    .orderBy(asc(messages.createdAt))
    .limit(1)
  const imageId = (first?.metadata as { imageIds?: string[] } | null)?.imageIds?.[0]
  const image = imageId ? await Image.find(imageId) : null
  if (!image) return null
  const copy = await decisionImageCopy(await image.getBuffer())
  if (!copy) return null
  const squads = await visibleSquads(identity)
  const note = first?.content.match(/\nMy note: (.+)/)?.[1]
  return { request: buildScreenshotDecision({ image: copy.image, note, squads }), context: { squads } }
}

/** "Wrong squad?": tell the screenshot's conversation where it really belongs. */
export async function correctScreenshotSquad(identity: Identity | undefined, input: ScreenshotCorrection) {
  const { user, conversation } = await requireAssistantConversation(identity, input.conversationId)
  if (!conversation.agentId) throw filingError(404, 'Conversation not found')
  let text: string
  let squadName: string | null = null
  if (input.squadId) {
    const squad = (await visibleSquads(user)).find((candidate) => candidate.id === input.squadId)
    if (!squad) throw filingError(404, 'Squad not found')
    squadName = squad.name
    text = `Correction: this screenshot belongs in ${squad.name} (squad ID ${squad.id}). File it there instead.`
  } else {
    text = "Correction: this screenshot doesn't belong to any squad. Don't file it with one; just keep it."
  }
  const assistant = await Agent.mustFind(conversation.agentId)
  const agentId = conversation.agentId
  void captureCorrection({
    evalName: 'screenshot-filing',
    purpose: 'screenshot-filing',
    build: () => screenshotRequestForConversation(user, agentId),
    expect: { squad: squadName },
    summary: `Screenshot → ${squadName ?? 'no squad'}`,
    source: { kind: 'screenshot-wrong-squad' },
  })
  try {
    await assistant.sendMessage(text, {
      metadata: { source: 'user_chat', sender: await senderOf(user.userId), clientId: input.clientId },
    })
  } catch (error) {
    if (error instanceof ChatIdempotencyConflictError) throw filingError(409, error.message)
    throw error
  }
  return { conversationId: conversation.id }
}
