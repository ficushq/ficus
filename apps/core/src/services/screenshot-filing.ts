import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import {
  DECISION_IMAGE_MEDIA_TYPES,
  DECISION_MAX_IMAGE_BYTES,
  SCREENSHOT_ACTIONS,
  SCREENSHOT_KINDS,
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
import { assistantConversations, db } from '../db'
import { Agent } from '../entities/Agent'
import { Image } from '../entities/Image'
import { User } from '../entities/User'
import { ensureAssistantConversationAgent } from './assistant-conversation-agent'
import { requireAssistantConversation } from './assistant-task-requests'
import { InvalidAttachmentError } from './attachments/agent-scope'
import { ChatIdempotencyConflictError } from './chat/consultant-idempotency'
import { decide as defaultDecide, isDecisionFeatureEnabled } from './decisions/service'
import { listVisibleSquads } from './entity-search'
import { resolveActingUser, type Identity } from './rbac'
import { createLogger } from '../lib/infra/logger'

const log = createLogger('screenshot-filing')

/** A choice question takes at most 64 options; one is "none". */
const MAX_SQUADS = 63
const NO_SQUAD = 'none'

export interface ScreenshotFilingDeps {
  decide?: typeof defaultDecide
  isEnabled?: () => boolean
}

export interface ScreenshotSquad {
  id: string
  name: string
  purpose: string | null
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
  const describe = (squad: ScreenshotSquad) =>
    (squad.purpose?.trim() ? `${squad.name}: ${squad.purpose.trim()}` : squad.name).slice(0, 1000)
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

function chosen(answer: DecisionAnswer | undefined): { choice: string; probability: number } | null {
  if (answer?.type !== 'choice') return null
  return { choice: answer.choice, probability: answer.probabilities[answer.choice] ?? answer.confidence ?? 0 }
}

/** The guess in a decision's answers, or null when the kind or action was refused. */
export function readScreenshotGuess(
  answers: Record<string, DecisionAnswer>,
  squads: ScreenshotSquad[]
): ScreenshotGuess | null {
  const kind = chosen(answers.kind)
  const action = chosen(answers.action)
  if (!kind || !(kind.choice in SCREENSHOT_KINDS) || !action || !(action.choice in SCREENSHOT_ACTIONS)) return null
  const squadAnswer = chosen(answers.squad)
  const squad = squadAnswer ? squads.find((candidate) => squadOptionKey(candidate.id) === squadAnswer.choice) : null
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
  const rows = await listVisibleSquads(identity, 100)
  return rows
    .filter((squad) => squad.status !== 'archived')
    .slice(0, MAX_SQUADS)
    .map((squad) => ({ id: squad.id, name: squad.name, purpose: squad.purpose }))
}

/**
 * File a dropped screenshot: guess what it is and where it belongs (when the feature is on and a
 * decision model that reads images answers), then start a new Assistant conversation for the user
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
  const decidable =
    (DECISION_IMAGE_MEDIA_TYPES as readonly string[]).includes(image.mimeType) && image.size <= DECISION_MAX_IMAGE_BYTES
  if (decidable && (deps.isEnabled ?? (() => isDecisionFeatureEnabled('screenshot-filing')))()) {
    const squads = await visibleSquads(user)
    const content = await image.loadContent()
    const request = buildScreenshotDecision({
      image: { mediaType: image.mimeType as (typeof DECISION_IMAGE_MEDIA_TYPES)[number], base64: content.data },
      note: input.note,
      squads,
    })
    try {
      const outcome = await (deps.decide ?? defaultDecide)('screenshot-filing', request, {
        source: { kind: 'screenshot', userId: user.userId },
      })
      if (outcome.ok) guess = readScreenshotGuess(outcome.result.answers, squads)
    } catch (error) {
      // Filing never depends on the guess.
      log.warn('Screenshot decision failed', error)
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

/** "Wrong squad?": tell the screenshot's conversation where it really belongs. */
export async function correctScreenshotSquad(identity: Identity | undefined, input: ScreenshotCorrection) {
  const { user, conversation } = await requireAssistantConversation(identity, input.conversationId)
  if (!conversation.agentId) throw filingError(404, 'Conversation not found')
  let text: string
  if (input.squadId) {
    const squad = (await visibleSquads(user)).find((candidate) => candidate.id === input.squadId)
    if (!squad) throw filingError(404, 'Squad not found')
    text = `Correction: this screenshot belongs in ${squad.name} (squad ID ${squad.id}). File it there instead.`
  } else {
    text = "Correction: this screenshot doesn't belong to any squad. Don't file it with one; just keep it."
  }
  const assistant = await Agent.mustFind(conversation.agentId)
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
