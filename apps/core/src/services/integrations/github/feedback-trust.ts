import { githubAccountIdSchema, type GitHubAccountIdentity, type GitHubTrustOrigin } from '@ficus/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { db, type DbTx } from '../../../db'
import { githubPersonalIdentities, githubTrustedAuthors, integrationAuditEvents, users } from '../../../db/schema'
import { lockGitHubTrustAuthority } from './trust-authority-lock'
import { hasUserPermissionWithExecutor, type Identity } from '../../rbac/permissions'

export class GitHubFeedbackError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 403 | 409 | 502
  ) {
    super(code)
    this.name = 'GitHubFeedbackError'
  }
}

const loginPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\[bot\])?$/

/** Parse only provider-native identities. Names, roles, and association labels never grant trust. */
export function parseGitHubAccount(profile: unknown): GitHubAccountIdentity | null {
  if (!profile || typeof profile !== 'object') return null
  const { id, login, type } = profile as Record<string, unknown>
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof login !== 'string' ||
    !loginPattern.test(login) ||
    login.toLowerCase() === 'ghost' ||
    (type !== 'User' && type !== 'Bot')
  )
    return null
  return { accountId: String(id), login, accountType: type }
}

/** Public fixed-origin lookup; no squad token is ownership proof or exposed to this request. */
async function lookupGitHubAccount(login: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new GitHubFeedbackError('account_lookup_failed', 502)
  return response.json()
}

export async function requireGitHubHuman(
  executor: Pick<typeof db, 'select'>,
  identity: Identity | undefined
): Promise<string> {
  // Do NOT call resolveActingUser/auditActor: delegated agents retain their non-human identity.
  if (identity?.type !== 'user') throw new GitHubFeedbackError('human_required', 403)
  const [user] = await executor
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, identity.userId))
    .limit(1)
  if (!user || user.disabledAt) throw new GitHubFeedbackError('enabled_human_required', 403)
  return identity.userId
}

export async function requireGitHubHumanSquadUpdate(
  executor: Pick<typeof db, 'select'>,
  identity: Identity | undefined,
  squadId: string
): Promise<string> {
  const userId = await requireGitHubHuman(executor, identity)
  if (!(await hasUserPermissionWithExecutor(executor, userId, 'squads:update', squadId)))
    throw new GitHubFeedbackError('squad_update_required', 403)
  return userId
}

/** Live OR resolver, uncached and scoped. A manual grant does not masquerade as a dynamic one. */
export async function resolveGitHubAuthorTrust(
  executor: Pick<typeof db, 'select'>,
  squadId: string,
  accountId: string | null | undefined
): Promise<GitHubTrustOrigin[]> {
  if (!githubAccountIdSchema.safeParse(accountId).success) return []
  const origins: GitHubTrustOrigin[] = []
  const [manual] = await executor
    .select({ userId: githubTrustedAuthors.addedByUserId })
    .from(githubTrustedAuthors)
    .where(
      and(
        eq(githubTrustedAuthors.squadId, squadId),
        eq(githubTrustedAuthors.host, 'github.com'),
        eq(githubTrustedAuthors.accountId, accountId!)
      )
    )
    .limit(1)
  if (manual) origins.push({ kind: 'manual', addedByUserId: manual.userId })
  const [linked] = await executor
    .select({ userId: githubPersonalIdentities.userId })
    .from(githubPersonalIdentities)
    .innerJoin(users, eq(users.id, githubPersonalIdentities.userId))
    .where(
      and(
        eq(githubPersonalIdentities.host, 'github.com'),
        eq(githubPersonalIdentities.accountId, accountId!),
        isNull(githubPersonalIdentities.unlinkedAt),
        isNull(users.disabledAt)
      )
    )
    .limit(1)
  if (linked && (await hasUserPermissionWithExecutor(executor, linked.userId, 'squads:update', squadId)))
    origins.push({ kind: 'linked_user', userId: linked.userId })
  return origins
}

/** Shared lock order: authority mutex, then users, then proof/identity/squad trust rows. */
export async function lockGitHubHuman(tx: DbTx, identity: Identity | undefined): Promise<void> {
  if (identity?.type !== 'user') throw new GitHubFeedbackError('human_required', 403)
  await lockGitHubTrustAuthority(tx)
  await tx.select({ id: users.id }).from(users).where(eq(users.id, identity.userId)).for('update')
}

/** Stable literal principal label; delegated userId never becomes human authorship. */
export function githubAuthorityActor(identity: Identity | undefined): string {
  switch (identity?.type) {
    case 'user':
      return `user:${identity.userId}`
    case 'agent':
      return `agent:${identity.agentId}`
    case 'system':
      return `system:${identity.systemTokenId}`
    case 'legacy':
      return 'legacy'
    default:
      return 'unknown'
  }
}

async function auditFailure(
  identity: Identity | undefined,
  squadId: string,
  action: string,
  error: unknown
): Promise<never> {
  // No raw provider response or caller content in audit. Rejected attempts remain visible after rollback.
  await db.insert(integrationAuditEvents).values({
    actorKey: githubAuthorityActor(identity),
    targetKind: 'squad',
    targetId: squadId,
    action,
    outcome: 'denied',
    code: error instanceof GitHubFeedbackError ? error.code : 'trust_mutation_failed',
  })
  throw error
}

export async function addManualGitHubTrust(
  identity: Identity | undefined,
  squadId: string,
  login: string,
  lookup: (login: string) => Promise<unknown> = lookupGitHubAccount
): Promise<GitHubAccountIdentity> {
  try {
    await requireGitHubHumanSquadUpdate(db, identity, squadId)
    if (!loginPattern.test(login)) throw new GitHubFeedbackError('invalid_login', 400)
    const account = parseGitHubAccount(await lookup(login))
    if (!account) throw new GitHubFeedbackError('unverified_account', 400)
    await db.transaction(async (tx) => {
      await lockGitHubHuman(tx, identity)
      // Recheck after provider I/O; a stale browser guard is not authority.
      const userId = await requireGitHubHumanSquadUpdate(tx, identity, squadId)
      await tx
        .insert(githubTrustedAuthors)
        .values({ squadId, ...account, addedByUserId: userId })
        .onConflictDoNothing()
      await tx.insert(integrationAuditEvents).values({
        squadId,
        userId,
        actorKey: `user:${userId}`,
        action: 'github.trust.add',
        outcome: 'allowed',
        targetKind: 'github_account',
        targetId: account.accountId,
      })
    })
    return account
  } catch (error) {
    return auditFailure(identity, squadId, 'github.trust.add', error)
  }
}

export async function removeManualGitHubTrust(
  identity: Identity | undefined,
  squadId: string,
  accountId: string
): Promise<GitHubTrustOrigin[]> {
  try {
    if (!githubAccountIdSchema.safeParse(accountId).success) throw new GitHubFeedbackError('invalid_account_id', 400)
    return await db.transaction(async (tx) => {
      await lockGitHubHuman(tx, identity)
      const userId = await requireGitHubHumanSquadUpdate(tx, identity, squadId)
      await tx
        .delete(githubTrustedAuthors)
        .where(
          and(
            eq(githubTrustedAuthors.squadId, squadId),
            eq(githubTrustedAuthors.host, 'github.com'),
            eq(githubTrustedAuthors.accountId, accountId)
          )
        )
      await tx.insert(integrationAuditEvents).values({
        squadId,
        userId,
        actorKey: `user:${userId}`,
        action: 'github.trust.remove',
        outcome: 'allowed',
        targetKind: 'github_account',
        targetId: accountId,
      })
      return resolveGitHubAuthorTrust(tx, squadId, accountId)
    })
  } catch (error) {
    return auditFailure(identity, squadId, 'github.trust.remove', error)
  }
}
