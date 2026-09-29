import type { FarmLook } from './farm-look'

/**
 * Who's on the farm and what they're working on. The farm tells Core (over the
 * WebSocket, `{ type: 'presence', focus }`) what you're focused on; Core tells
 * everyone else who's subscribed to the `presence` topic. People who choose
 * single-player mode neither announce nor subscribe.
 *
 * Others only see your focus when they can see it themselves (the squad, or
 * a private agent's owner); otherwise you're simply "around the farm".
 */

export type PresenceFocus =
  | { kind: 'agent'; agentId: string }
  | { kind: 'workstream'; workstreamId: string }
  | { kind: 'squad'; squadId: string }

export interface PresencePerson {
  userId: string
  name: string
  /** What they're working on, when you can see it; null means around the farm. */
  focus: PresenceFocus | null
  /** When their focus last changed (ISO). */
  since: string
  /** How they chose to look (the character builder), or null for the farm's pick for them. */
  look: FarmLook | null
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** A focus as sent by a client: one of the known kinds, with a well-formed id. Null is "around the farm". */
export function parsePresenceFocus(input: unknown): { ok: true; focus: PresenceFocus | null } | { ok: false } {
  if (input === null) return { ok: true, focus: null }
  if (!input || typeof input !== 'object') return { ok: false }
  const value = input as Record<string, unknown>
  const id = (key: string) =>
    typeof value[key] === 'string' && ID.test(value[key] as string) ? (value[key] as string) : null
  switch (value.kind) {
    case 'agent': {
      const agentId = id('agentId')
      return agentId ? { ok: true, focus: { kind: 'agent', agentId } } : { ok: false }
    }
    case 'workstream': {
      const workstreamId = id('workstreamId')
      return workstreamId ? { ok: true, focus: { kind: 'workstream', workstreamId } } : { ok: false }
    }
    case 'squad': {
      const squadId = id('squadId')
      return squadId ? { ok: true, focus: { kind: 'squad', squadId } } : { ok: false }
    }
    default:
      return { ok: false }
  }
}
