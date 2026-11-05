/*
 * Who is typing in which agent's chat, in memory in the API process (the only
 * process holding sockets; see docs/wiki/event-emitter.md). Nothing is stored:
 * a restart simply forgets everyone's typing, and their next heartbeat says so
 * again.
 *
 * Each connection that says its person is typing in an agent's chat gets an
 * entry, which ends when that connection says it stopped, closes, or goes quiet
 * for the TTL. The manager (manager.ts) checks access and delivers; this module
 * only decides what is worth passing on, so a flood of typing messages becomes
 * a bounded number of broadcasts:
 *
 * - The first "typing" from a connection for an agent is passed on straight
 *   away, and later ones at most every HEARTBEAT_GAP_MS ("still typing").
 * - Every pass-on spends a token from a small per-connection bucket.
 * - A "stopped" is passed on only for an entry whose typing was delivered (at
 *   most one per delivered start), and only once the person has no other
 *   connection still typing there (several tabs count as one person).
 */

/** Typing from one connection in one agent's chat is passed on at most this often. */
export const AGENT_CHAT_TYPING_HEARTBEAT_GAP_MS = 2_000
/** A connection not heard from for this long has stopped typing (the client heartbeats every 2.5s). */
export const AGENT_CHAT_TYPING_TTL_MS = 8_000
/** A connection may pass on this much typing at once, refilling this many per second. */
const AGENT_CHAT_TYPING_BURST = 5
const AGENT_CHAT_TYPING_PER_SECOND = 1
/** At most this many agent chats typed in at once per connection. */
const AGENT_CHAT_TYPING_AGENTS = 10

/** One connection typing in one agent's chat. Opaque to callers: a handle for isCurrent and delivered. */
export interface AgentChatTypingEntry {
  readonly agentId: string
  readonly userId: string
}

interface Entry extends AgentChatTypingEntry {
  /** When this connection last said it was typing here (passed on or not). */
  heardAt: number
  /** When typing here was last passed on. */
  sentAt: number
  /** Whether the typing was delivered to anyone, so stopping must be too. */
  delivered: boolean
  expiry: ReturnType<typeof setTimeout> | null
}

/** A person stopped typing in an agent's chat: pass it on. */
export interface AgentChatTypingStop {
  agentId: string
  userId: string
}

export interface AgentChatTypingRegistryOptions {
  /** Called when a connection went quiet for the TTL and its person stopped typing there. */
  onExpire: (clientId: string, stop: AgentChatTypingStop) => void
  ttlMs?: number
  now?: () => number
}

export class AgentChatTypingRegistry {
  private readonly byClient = new Map<string, Map<string, Entry>>()
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(private readonly options: AgentChatTypingRegistryOptions) {
    this.ttlMs = options.ttlMs ?? AGENT_CHAT_TYPING_TTL_MS
    this.now = options.now ?? Date.now
  }

  /**
   * Notes that a connection's person is typing in an agent's chat. Returns the
   * entry when it should be passed on now, else null (too soon, over budget, or
   * too many chats at once).
   */
  typing(clientId: string, userId: string, agentId: string): AgentChatTypingEntry | null {
    const now = this.now()
    let entries = this.byClient.get(clientId)
    let entry = entries?.get(agentId)
    if (entry && entry.userId !== userId) return null
    if (!entry) {
      if (entries && entries.size >= AGENT_CHAT_TYPING_AGENTS) return null
      entry = { agentId, userId, heardAt: now, sentAt: -Infinity, delivered: false, expiry: null }
      if (!entries) this.byClient.set(clientId, (entries = new Map()))
      entries.set(agentId, entry)
    }
    entry.heardAt = now
    this.scheduleExpiry(clientId, entry)
    if (now - entry.sentAt < AGENT_CHAT_TYPING_HEARTBEAT_GAP_MS || !this.spend(clientId, now)) return null
    entry.sentAt = now
    return entry
  }

  /** Whether `entry` is still this connection's typing in its agent's chat (it hasn't stopped since). */
  isCurrent(clientId: string, entry: AgentChatTypingEntry): boolean {
    return this.byClient.get(clientId)?.get(entry.agentId) === entry
  }

  /** Records that `entry`'s typing reached others, so its stop must reach them too. */
  delivered(entry: AgentChatTypingEntry): void {
    ;(entry as Entry).delivered = true
  }

  /** A connection's person stopped typing in an agent's chat. Returns the stop to pass on, if any. */
  stop(clientId: string, agentId: string): AgentChatTypingStop | null {
    const entries = this.byClient.get(clientId)
    const entry = entries?.get(agentId)
    if (!entries || !entry) return null
    this.remove(clientId, entries, entry)
    return this.stopFor(entry)
  }

  /** A connection closed: everything it was typing in stops. Returns the stops to pass on. */
  withdraw(clientId: string): AgentChatTypingStop[] {
    const entries = this.byClient.get(clientId)
    this.buckets.delete(clientId)
    if (!entries) return []
    const removed = [...entries.values()]
    for (const entry of removed) this.remove(clientId, entries, entry)
    return removed.map((entry) => this.stopFor(entry)).filter((stop) => stop !== null)
  }

  /** How many connections are typing anywhere (for tests and diagnostics). */
  size(): number {
    let size = 0
    for (const entries of this.byClient.values()) size += entries.size
    return size
  }

  private remove(clientId: string, entries: Map<string, Entry>, entry: Entry): void {
    if (entry.expiry) clearTimeout(entry.expiry)
    entry.expiry = null
    entries.delete(entry.agentId)
    if (!entries.size) this.byClient.delete(clientId)
  }

  /** The stop for a removed entry, unless it was never delivered or another tab of theirs still types there. */
  private stopFor(entry: Entry): AgentChatTypingStop | null {
    if (!entry.delivered) return null
    for (const entries of this.byClient.values()) {
      const other = entries.get(entry.agentId)
      if (other && other.userId === entry.userId && other.delivered) return null
    }
    return { agentId: entry.agentId, userId: entry.userId }
  }

  private scheduleExpiry(clientId: string, entry: Entry): void {
    if (entry.expiry) clearTimeout(entry.expiry)
    entry.expiry = setTimeout(() => {
      entry.expiry = null
      if (!this.isCurrent(clientId, entry)) return
      const stop = this.stop(clientId, entry.agentId)
      if (stop) this.options.onExpire(clientId, stop)
    }, this.ttlMs)
    ;(entry.expiry as { unref?: () => void }).unref?.()
  }

  /** Takes a token from the connection's bucket, if it has one. */
  private spend(clientId: string, now: number): boolean {
    const bucket = this.buckets.get(clientId) ?? { tokens: AGENT_CHAT_TYPING_BURST, at: now }
    bucket.tokens = Math.min(
      AGENT_CHAT_TYPING_BURST,
      bucket.tokens + ((now - bucket.at) / 1000) * AGENT_CHAT_TYPING_PER_SECOND
    )
    bucket.at = now
    this.buckets.set(clientId, bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }
}
