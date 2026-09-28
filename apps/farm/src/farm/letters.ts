import type { LiveEvent } from '../live/invalidation'

/*
 * Letters: whenever a robot is sent something (you chat with it, someone
 * answers its question, another robot mails it) a little letter flies to it
 * across the farm. Anything can post one here; the farm screen draws them
 * (FlyingLetters.tsx).
 */

/** Where a letter comes from: you (on the farm, else the mailbox), the farmhouse mailbox, or another robot. */
export type LetterFrom = { kind: 'me' } | { kind: 'mailbox' } | { kind: 'agent'; agentId: string }

export interface Letter {
  from: LetterFrom
  toAgentId: string
}

type Listener = (letter: Letter) => void
const listeners = new Set<Listener>()

/** Sends a letter flying to a robot (if both ends are on the farm). */
export function sendLetter(letter: Letter): void {
  for (const listener of listeners) listener(letter)
}

export function onLetter(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The letter a live event stands for, if any: mail to a robot, or an answer to its question. */
export function letterForEvent(event: LiveEvent): Letter | null {
  const data = (event.data ?? {}) as Record<string, unknown>
  if (event.event === 'inbox.messageReceived' && data.recipientType === 'agent' && typeof data.recipientId === 'string')
    return {
      from:
        typeof data.senderAgentId === 'string' ? { kind: 'agent', agentId: data.senderAgentId } : { kind: 'mailbox' },
      toAgentId: data.recipientId,
    }
  if (event.event === 'agent-question.answered' && typeof data.agentId === 'string')
    return { from: { kind: 'mailbox' }, toAgentId: data.agentId }
  return null
}
