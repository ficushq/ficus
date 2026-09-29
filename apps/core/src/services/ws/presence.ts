import { eq } from 'drizzle-orm'
import { farmPersonName, readFarmSettings, type FarmLook, type PresenceFocus } from '@ficus/shared'
import { db, farmPreferences, users } from '../../db'

/*
 * Farm presence, in memory in the API process (the only process holding
 * sockets; see docs/wiki/event-emitter.md). Each connection that announces
 * itself has a focus; a person is present while any of their connections is,
 * and shows the focus they changed most recently. Nothing is stored: a
 * restart simply empties the farm until people's pages announce again.
 */

interface Announcement {
  userId: string
  focus: PresenceFocus | null
  /** When this connection's focus last changed. */
  since: number
}

/** A person as the registry knows them: their latest focus across connections. */
export interface PresentPerson {
  userId: string
  focus: PresenceFocus | null
  since: number
}

export class PresenceRegistry {
  private readonly byClient = new Map<string, Announcement>()

  /**
   * Records a connection's focus. Returns the person as they now appear, or null
   * when nothing visible changed (the same focus again).
   */
  announce(clientId: string, userId: string, focus: PresenceFocus | null, now = Date.now()): PresentPerson | null {
    const before = this.person(userId)
    const previous = this.byClient.get(clientId)
    const same = previous && previous.userId === userId && sameFocus(previous.focus, focus)
    this.byClient.set(clientId, { userId, focus, since: same ? previous.since : now })
    const after = this.person(userId)!
    return before && sameFocus(before.focus, after.focus) && before.since === after.since ? null : after
  }

  /**
   * Forgets a connection. Returns `{ left: userId }` when that was the person's
   * last one, `{ person }` when they're still here but now show another
   * connection's focus, or null when nothing visible changed.
   */
  withdraw(clientId: string): { left: string } | { person: PresentPerson } | null {
    const announcement = this.byClient.get(clientId)
    if (!announcement) return null
    const before = this.person(announcement.userId)!
    this.byClient.delete(clientId)
    const after = this.person(announcement.userId)
    if (!after) return { left: announcement.userId }
    return sameFocus(before.focus, after.focus) && before.since === after.since ? null : { person: after }
  }

  isAnnounced(clientId: string): boolean {
    return this.byClient.has(clientId)
  }

  person(userId: string): PresentPerson | null {
    let latest: Announcement | null = null
    for (const announcement of this.byClient.values())
      if (announcement.userId === userId && (!latest || announcement.since >= latest.since)) latest = announcement
    return latest ? { userId, focus: latest.focus, since: latest.since } : null
  }

  people(): PresentPerson[] {
    const userIds = new Set([...this.byClient.values()].map((announcement) => announcement.userId))
    return [...userIds].map((userId) => this.person(userId)!)
  }
}

function sameFocus(a: PresenceFocus | null, b: PresenceFocus | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const PROFILE_TTL_MS = 60_000
const profiles = new Map<string, { profile: PresenceProfile; expires: number }>()

/**
 * What others see of someone besides their focus: their name (display name,
 * else email, which only viewers who may see emails get; see personName) and
 * how they chose to look.
 */
export interface PresenceProfile {
  displayName: string | null
  email: string | null
  look: FarmLook | null
}

/** Someone's name as a given viewer may see it (their email only with users:read). */
export function personName(profile: PresenceProfile, showEmail: boolean): string {
  return profile.email === null
    ? profile.displayName?.trim() || 'Someone'
    : farmPersonName({ displayName: profile.displayName, email: profile.email }, { showEmail })
}

/** Someone's name and chosen look, cached briefly. */
export async function presenceProfile(userId: string): Promise<PresenceProfile> {
  const cached = profiles.get(userId)
  if (cached && cached.expires > Date.now()) return cached.profile
  const [user] = await db
    .select({ displayName: users.displayName, email: users.email, settings: farmPreferences.settings })
    .from(users)
    .leftJoin(farmPreferences, eq(farmPreferences.userId, users.id))
    .where(eq(users.id, userId))
  const profile: PresenceProfile = {
    displayName: user?.displayName ?? null,
    email: user?.email ?? null,
    look: readFarmSettings(user?.settings).look ?? null,
  }
  profiles.set(userId, { profile, expires: Date.now() + PROFILE_TTL_MS })
  return profile
}

/** Drops someone's cached profile, after they change how they look. */
export function forgetPresenceProfile(userId: string): void {
  profiles.delete(userId)
}
