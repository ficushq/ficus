import { createHash, timingSafeEqual } from 'crypto'
import { eq, and, gt, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { sessions, agentTokens, users } from '../../db/schema'
import { getSecretStore } from '../secrets'
import type { Identity } from '../rbac'
import { adminHasPasskey } from './admin-users'
import { resolveSystemToken } from './system-tokens'
import { resolveDeviceToken } from './device-tokens'
import { AGENT_TOKEN_PREFIX, SESSION_TOKEN_PREFIX } from './token-prefixes'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface AuthContext {
  identity: Identity
  deviceTokenId: string | null
}

/** Resolve a raw token while retaining credential provenance beside its RBAC identity. */
export async function resolveTokenContext(token: string): Promise<AuthContext | null> {
  const tokenHash = hashToken(token)

  // Sessions and agent tokens are looked up only under their own prefix, so a value minted as
  // another kind (or under an earlier product prefix) never matches a row here.
  // 1. Check sessions table
  const [session] = token.startsWith(SESSION_TOKEN_PREFIX)
    ? await db
        .select({ userId: sessions.userId })
        .from(sessions)
        .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
        .limit(1)
    : []

  if (session) {
    // Check if user is disabled
    const [user] = await db
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1)
    if (user?.disabledAt) {
      return null // Disabled users can't authenticate
    }
    return { identity: { type: 'user', userId: session.userId }, deviceTokenId: null }
  }

  // 2. Check agent tokens table
  const [agentToken] = token.startsWith(AGENT_TOKEN_PREFIX)
    ? await db
        .select({
          agentId: agentTokens.agentId,
          squadId: agentTokens.squadId,
          userId: agentTokens.userId,
        })
        .from(agentTokens)
        .where(and(eq(agentTokens.tokenHash, tokenHash), isNull(agentTokens.revokedAt)))
        .limit(1)
    : []

  if (agentToken) {
    if (agentToken.userId) {
      const [owner] = await db
        .select({ disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, agentToken.userId))
        .limit(1)
      if (!owner || owner.disabledAt) return null
    }

    return {
      identity: {
        type: 'agent',
        agentId: agentToken.agentId,
        squadId: agentToken.squadId,
        ...(agentToken.userId ? { userId: agentToken.userId } : {}),
      },
      deviceTokenId: null,
    }
  }

  // 2b. Check system API tokens (user-less automation identity with explicit scopes)
  const system = await resolveSystemToken(token)
  if (system) {
    return {
      identity: { type: 'system', systemTokenId: system.id, name: system.name, scopes: system.scopes },
      deviceTokenId: null,
    }
  }

  // 2c. Check mobile device tokens (a paired phone authenticates as its owning user)
  const device = await resolveDeviceToken(token)
  if (device) {
    return {
      identity: { type: 'user', userId: device.userId },
      deviceTokenId: device.id,
    }
  }

  // 3. Check FICUS_PASSWORD (legacy auth, only while no admin user has a passkey).
  // Gating on "no usable admin credential" rather than "no admin user" lets the
  // env-held bootstrap password recover a cross-subdomain restore, where the
  // admin/role rows survive but every origin-bound WebAuthn credential is dead.
  const secretStore = getSecretStore()
  const ficusPassword = secretStore.get('FICUS_PASSWORD')
  if (ficusPassword) {
    const tokenDigest = Buffer.from(tokenHash, 'hex')
    const passwordDigest = Buffer.from(hashToken(ficusPassword), 'hex')
    if (tokenDigest.length === passwordDigest.length && timingSafeEqual(tokenDigest, passwordDigest)) {
      const passkeyExists = await adminHasPasskey()
      if (!passkeyExists) {
        return { identity: { type: 'legacy' }, deviceTokenId: null }
      }
    }
  }

  return null
}

/** Compatibility wrapper for callers that need authorization identity only. */
export async function resolveToken(token: string): Promise<Identity | null> {
  return (await resolveTokenContext(token))?.identity ?? null
}
