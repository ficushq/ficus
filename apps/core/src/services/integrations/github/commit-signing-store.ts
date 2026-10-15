import { and, desc, eq, or, sql } from 'drizzle-orm'
import { parseGitHubConfiguration } from '@ficus/shared/oauth-providers/github/config'
import { resolveOAuthAuthority } from '../authorization/authority'
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

/** A GitHub connection as commit signing sees it: who it is, and whether it may sign at all. */
export interface GitHubSigningAccount {
  connectionId: string
  login: string
  userId: number
  /** The squad's default attachment; false outside a squad. */
  isDefault: boolean
  /**
   * The connection may be used to sign: enabled (account and provider), issued
   * under this instance's client authority, and authenticated or mid-refresh.
   * Disabled, other-authority and reauthorization-required connections never
   * sign, and neither does one whose token GitHub rejected.
   *
   * Validation freshness and health are deliberately not required, unlike
   * token use: a signature uses the stored signing key and does not call
   * GitHub, env files are rendered at arbitrary moments, and commits must not
   * start failing because a 15-minute validation window lapsed. For the same
   * reason a token that is being refreshed keeps signing: for those seconds the
   * connection is `invalid` with `refresh_validation_pending` (see
   * {@link signingAuthStatePredicate}), and only that exact state is accepted.
   */
  canSign: boolean
}

/**
 * Authentication states that may sign: `authenticated`, or the transient state
 * the refresh service records while a rotated token is validated (`invalid`,
 * health `degraded`, last error `refresh_validation_pending`). The refresh
 * outcome overwrites that state: success returns to `authenticated`; a
 * rejected token becomes `unreachable` or `reauthorization_required`, and any
 * other failure records its own error code, so none of those sign. This is the
 * same window git identity is kept through (`resolveGitHubAuthorAssignment`).
 */
const signingAuthStatePredicate = sql`(${integrationConnections.authState} = 'authenticated' or (${integrationConnections.authState} = 'invalid' and ${integrationConnections.healthState} = 'degraded' and ${integrationConnections.lastErrorCode} = 'refresh_validation_pending'))`

const signingAccountColumns = {
  id: integrationConnections.id,
  configuration: integrationConnections.configuration,
  canSign: sql<boolean>`${integrationConnections.enabled} and ${integrationEnabledPredicate()} and ${signingAuthStatePredicate} and ${integrationConnections.adapterVersion} = 1`,
  clientAuthority: integrationConnections.clientAuthority,
}

function signingAccount(
  row: { id: string; configuration: unknown; canSign: boolean; clientAuthority: unknown },
  isDefault: boolean
): GitHubSigningAccount[] {
  try {
    const { login, userId } = parseGitHubConfiguration(row.configuration)
    return [
      {
        connectionId: row.id,
        login,
        userId,
        isDefault,
        canSign: row.canSign && row.clientAuthority === resolveOAuthAuthority(),
      },
    ]
  } catch {
    // A connection whose account cannot be read vouches for no one.
    return []
  }
}

/**
 * Every GitHub connection ASSIGNED to the squad, default first. Assignment is
 * the only way a squad reaches a signing key: another squad's connection is
 * never returned, and the same rule lets `ficus integration exec github
 * --connection` use an attached account's token.
 */
export async function githubSigningAccountsForSquad(squadId: string): Promise<GitHubSigningAccount[]> {
  const rows = await db
    .select({ ...signingAccountColumns, isDefault: integrationConnectionAssignments.isDefault })
    .from(integrationConnectionAssignments)
    .innerJoin(integrationConnections, eq(integrationConnectionAssignments.connectionId, integrationConnections.id))
    .where(
      and(
        eq(integrationConnectionAssignments.squadId, squadId),
        eq(integrationConnectionAssignments.providerKey, 'github'),
        eq(integrationConnections.providerKey, 'github')
      )
    )
    .orderBy(desc(integrationConnectionAssignments.isDefault), integrationConnections.id)
  return rows.flatMap((row) => signingAccount(row, row.isDefault))
}

/** One GitHub connection outside any squad, for the per-connection signing summary. */
export async function githubSigningAccount(connectionId: string): Promise<GitHubSigningAccount | undefined> {
  const [row] = await db
    .select(signingAccountColumns)
    .from(integrationConnections)
    .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.providerKey, 'github')))
    .limit(1)
  return row ? signingAccount(row, false)[0] : undefined
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

/**
 * Public key the squad's git names as `user.signingkey`, or undefined when no
 * attached account signs (git then commits unsigned). It only switches signing
 * on in the sandbox: Core picks the key for each commit from the committer
 * email, so the default account's key is named when it signs and otherwise the
 * first attached account's that does.
 */
export async function githubSigningPublicKeyForSquad(squadId: string): Promise<string | undefined> {
  for (const account of await githubSigningAccountsForSquad(squadId)) {
    if (!account.canSign) continue
    const record = await readGitHubSigningRecord(account.connectionId)
    if (record?.state === 'on') return record.publicKey
  }
  return undefined
}
