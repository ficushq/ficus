import { isChannelAllowed } from './channel-policy'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, lte, isNull, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { db, channelIdentityLinks, channelLinkChallenges, channelInstances, users } from '../db'
import { ChannelInstance } from '../entities/ChannelInstance'
import { hasUserPermissionWithExecutor } from './rbac/permissions'
import { COMMAND_WORD } from '../lib/channels'

const identityScope = (instance: ChannelInstance) => JSON.stringify([instance.provider, instance.platformId])

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex')

export function parseChannelIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200 || id.trim() === '*')
  ) {
    throw new HTTPException(400, { message: 'Channel IDs must be a list of explicit channel IDs (no wildcard).' })
  }
  return [...new Set(value.map((id) => id.trim()))]
}

export const parseTrustedChannelIds = parseChannelIds

/** Fresh RBAC lookup on every message; no cached permission survives revocation. */
export async function canUseChannel(
  instance: ChannelInstance,
  channelId: string,
  externalUserId: string,
  squadId: string
): Promise<boolean> {
  if (!isChannelAllowed(instance, channelId) || !externalUserId) return false
  if (instance.trustedChannelIds.includes(channelId)) return true
  const link = await findLinkedChannelUser(instance, externalUserId)
  return !!link && hasUserPermissionWithExecutor(db, link.userId, 'chat:send', squadId)
}

/** A provider-verified identity; display names never establish authorization. */
export async function findLinkedChannelUser(instance: ChannelInstance, externalUserId: string) {
  if (instance.disabled || !externalUserId) return null
  const [link] = await db
    .select({ id: channelIdentityLinks.id, userId: users.id })
    .from(channelIdentityLinks)
    .innerJoin(users, eq(users.id, channelIdentityLinks.userId))
    .where(
      and(
        eq(channelIdentityLinks.instanceId, instance.id),
        eq(channelIdentityLinks.identityScope, identityScope(instance)),
        eq(channelIdentityLinks.externalUserId, externalUserId),
        isNull(users.disabledAt)
      )
    )
  return link ?? null
}

export async function startChannelLink(userId: string) {
  // Serialize per account to bound outstanding codes even with concurrent requests.
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.disabledAt)))
      .for('update')
    if (!user) throw new HTTPException(403)
    await tx
      .delete(channelLinkChallenges)
      .where(and(eq(channelLinkChallenges.userId, userId), lte(channelLinkChallenges.expiresAt, new Date())))
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(channelLinkChallenges)
      .where(and(eq(channelLinkChallenges.userId, userId), gt(channelLinkChallenges.expiresAt, new Date())))
    if (count >= 5)
      throw new HTTPException(429, { message: 'Cancel an existing link request or wait for it to expire.' })
    const code = randomBytes(16).toString('hex')
    const [challenge] = await tx
      .insert(channelLinkChallenges)
      .values({ userId, tokenHash: hashCode(code), expiresAt: new Date(Date.now() + 10 * 60_000) })
      .returning()
    return { id: challenge.id, code, expiresAt: challenge.expiresAt }
  })
}

/** Only called with a provider-authenticated sender. Claim once; never create a binding here. */
export async function claimChannelLink(
  instanceId: string,
  externalUserId: string,
  externalUserName: string,
  code: string
): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/.test(code) || !externalUserId) return false
  const instance = await ChannelInstance.find(instanceId)
  if (!instance || instance.disabled) return false
  const [row] = await db
    .update(channelLinkChallenges)
    .set({ instanceId, identityScope: identityScope(instance), externalUserId, externalUserName })
    .where(
      and(
        eq(channelLinkChallenges.tokenHash, hashCode(code)),
        isNull(channelLinkChallenges.externalUserId),
        gt(channelLinkChallenges.expiresAt, new Date())
      )
    )
    .returning({ id: channelLinkChallenges.id })
  return !!row
}

export async function confirmChannelLink(userId: string, id: string) {
  return db.transaction(async (tx) => {
    const [challenge] = await tx
      .select()
      .from(channelLinkChallenges)
      .where(
        and(
          eq(channelLinkChallenges.id, id),
          eq(channelLinkChallenges.userId, userId),
          gt(channelLinkChallenges.expiresAt, new Date())
        )
      )
      .for('update')
    if (!challenge?.instanceId || !challenge.externalUserId || challenge.externalUserName === null) {
      throw new HTTPException(409, {
        message: 'Send the code from your external account first, or start a new link request.',
      })
    }
    const [instance] = await tx.select().from(channelInstances).where(eq(channelInstances.id, challenge.instanceId))
    if (!instance || instance.disabled)
      throw new HTTPException(409, { message: 'This channel connection is disabled.' })
    if (challenge.identityScope !== identityScope(new ChannelInstance(instance)))
      throw new HTTPException(409, { message: 'The channel connection changed. Start a new link request.' })
    await tx
      .insert(channelIdentityLinks)
      .values({
        userId,
        instanceId: challenge.instanceId,
        identityScope: challenge.identityScope,
        externalUserId: challenge.externalUserId,
        externalUserName: challenge.externalUserName,
      })
      .onConflictDoNothing()
    const [link] = await tx
      .select()
      .from(channelIdentityLinks)
      .where(
        and(
          eq(channelIdentityLinks.instanceId, challenge.instanceId),
          eq(channelIdentityLinks.externalUserId, challenge.externalUserId)
        )
      )
    if (link.userId !== userId)
      throw new HTTPException(409, { message: 'This external account is already linked to another Ficus account.' })
    await tx.delete(channelLinkChallenges).where(eq(channelLinkChallenges.id, id))
    return { id: link.id }
  })
}

/** Linking is deliberately handled outside the model and is available before chat authorization. */
export async function channelLinkReply(
  instance: ChannelInstance,
  user: { id: string; name: string },
  text: string
): Promise<string | null> {
  const match = text
    .trim()
    .replace(new RegExp(String.raw`^@${COMMAND_WORD}\s*`, 'i'), '')
    .match(/^link\s+([a-f0-9]{32})$/i)
  if (!match) return null
  if (instance.disabled) return 'This channel connection is disabled.'
  return (await claimChannelLink(instance.id, user.id, user.name, match[1].toLowerCase()))
    ? 'Account verified. Return to Ficus → Settings → Account → Linked chat accounts and confirm this account. Linking does not grant squad access.'
    : 'This link code is invalid, expired, or already used. Start a new request in Ficus → Settings → Account → Linked chat accounts.'
}

export const CHANNEL_ACCESS_DENIED =
  'Link your account in Ficus → Settings → Account → Linked chat accounts. Your Ficus account must have permission to chat in this squad. An administrator can also explicitly trust this channel.'
