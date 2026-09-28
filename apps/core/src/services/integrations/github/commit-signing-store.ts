import { and, eq, or } from 'drizzle-orm'
import { db, integrationConnectionAssignments, integrationConnections } from '../../../db'
import { getSecretStore } from '../../secrets'
import { integrationEnabledPredicate } from '../provider-state'

/**
 * Per-connection commit-signing state, kept in the secret store because the
 * "on" record carries the private key. Absent means signing was never decided
 * for the connection (connect-time setup may turn it on); an explicit "off" is
 * remembered so setup never re-enables what the user turned off.
 */
export type GitHubSigningRecord =
  | {
      version: 1
      state: 'on'
      privateKey: string
      publicKey: string
      githubKeyId: number
      enabledAt: string
      enabledBy: string
    }
  | { version: 1; state: 'off'; updatedAt: string; updatedBy: string }

export function githubSigningSecretKey(connectionId: string): string {
  return `__integration-github-signing:${connectionId}`
}

export function parseGitHubSigningRecord(raw: string | undefined): GitHubSigningRecord | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as GitHubSigningRecord
    if (value?.version !== 1) return undefined
    if (value.state === 'off') return value
    if (
      value.state === 'on' &&
      typeof value.privateKey === 'string' &&
      typeof value.publicKey === 'string' &&
      Number.isInteger(value.githubKeyId)
    )
      return value
  } catch {
    // Unreadable records count as undecided.
  }
  return undefined
}

export async function readGitHubSigningRecord(connectionId: string): Promise<GitHubSigningRecord | undefined> {
  const key = githubSigningSecretKey(connectionId)
  await getSecretStore().refreshKey(key)
  return parseGitHubSigningRecord(getSecretStore().get(key))
}

/**
 * The GitHub connection a squad's `git` uses: its default assignment, the same
 * one `ficus integration exec github --squad` resolves without `--connection`.
 * Validation freshness is deliberately not required: env files are rendered at
 * arbitrary moments and must not drop signing because a 15-minute validation
 * window lapsed; the credential helper enforces usability per push.
 */
export async function defaultGitHubConnectionId(squadId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnectionAssignments)
    .innerJoin(integrationConnections, eq(integrationConnectionAssignments.connectionId, integrationConnections.id))
    .where(
      and(
        eq(integrationConnectionAssignments.squadId, squadId),
        eq(integrationConnectionAssignments.providerKey, 'github'),
        eq(integrationConnectionAssignments.isDefault, true),
        eq(integrationConnections.enabled, true),
        integrationEnabledPredicate(),
        eq(integrationConnections.authState, 'authenticated')
      )
    )
    .limit(1)
  return row?.id
}

/** Enabled, authenticated GitHub connections this Ficus user connected or last reconnected. */
export async function githubConnectionIdsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.providerKey, 'github'),
        eq(integrationConnections.enabled, true),
        eq(integrationConnections.authState, 'authenticated'),
        or(eq(integrationConnections.createdByUserId, userId), eq(integrationConnections.updatedByUserId, userId))
      )
    )
  return rows.map((row) => row.id)
}

/** Public key the squad's git should sign with, or undefined when signing is off for its connection. */
export async function githubSigningPublicKeyForSquad(squadId: string): Promise<string | undefined> {
  const connectionId = await defaultGitHubConnectionId(squadId)
  if (!connectionId) return undefined
  const record = await readGitHubSigningRecord(connectionId)
  return record?.state === 'on' ? record.publicKey : undefined
}
