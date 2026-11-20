import { and, eq, gte, isNull, lt, lte, or } from 'drizzle-orm'
import type { IntegrationOutputFact, GitHubWriteWindowMatch } from '@ficus/shared'
import type { IntegrationOutputAuthority } from '../outputs/types'
import { db, githubWriteWindows, integrationConnections, settings } from '../../../db'
import { getSecretStore } from '../../secrets/store'
import { parseOAuthCredential } from '../authorization/credential-bundle'

/**
 * Ficus's own GitHub reviews and review comments, told apart from the connected account owner's.
 *
 * Ficus writes to GitHub as the connected account, and GitHub attributes reviews and review comments to
 * no app, so the login cannot separate Ficus's writes from the person's. Agents write through `gh` in
 * their sandbox, which never reports the IDs it creates (`gh pr review` prints none). What Core does see
 * is every credential exchange: a command can only write after `ficus integration exec` asks Core for the
 * token. Core therefore opens a window for the account's login before handing out the token of a command
 * that can post comments or reviews, and the CLI closes it when the command exits. A review by that login
 * written inside a window is Ficus's own; one written outside every window is the person's.
 *
 * The window is open from before the token leaves Core, so a webhook can never arrive ahead of its record.
 * While a window is still open (the command is running, or its close was lost) it covers everything up to
 * now, so an echo is never mistaken for a person; a window whose close never arrives stops covering
 * writes after {@link GITHUB_WRITE_WINDOW_MAX_OPEN_MS}.
 */

/** How long a window without a recorded close keeps covering writes (a lost close, or an older CLI). */
export const GITHUB_WRITE_WINDOW_MAX_OPEN_MS = 60 * 60_000
/** Allowance for the difference between GitHub's timestamps and Core's clock, on both ends. */
export const GITHUB_WRITE_WINDOW_CLOCK_SKEW_MS = 10_000
/** Windows older than this are pruned; events written earlier than this keep the login rule. */
export const GITHUB_WRITE_WINDOW_RETENTION_MS = 7 * 24 * 60 * 60_000
/** When this instance began recording windows. Events written earlier keep the login rule. */
export const GITHUB_WRITE_WINDOWS_SINCE_KEY = 'GITHUB_WRITE_WINDOWS_SINCE'

const FEEDBACK_OUTPUTS = [
  'issue.comment',
  'pull_request.comment',
  'pull_request.reviewed',
  'pull_request.review_comment',
]

type Store = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Open a window before a command that can post comments or reviews receives `login`'s token. */
export async function openGitHubWriteWindow(
  input: { squadId: string; login: string; now?: Date },
  store: Store = db
): Promise<string | undefined> {
  const login = input.login.trim().toLowerCase()
  if (!login) return undefined
  const now = input.now ?? new Date()
  // First window ever: record when coverage began. It never moves, so pruning cannot widen it.
  await store
    .insert(settings)
    .values({ key: GITHUB_WRITE_WINDOWS_SINCE_KEY, value: now.toISOString(), updatedBy: 'system:github-write-windows' })
    .onConflictDoNothing()
  const [row] = await store
    .insert(githubWriteWindows)
    .values({ squadId: input.squadId, login, openedAt: now })
    .returning({ id: githubWriteWindows.id })
  await store
    .delete(githubWriteWindows)
    .where(lt(githubWriteWindows.openedAt, new Date(now.getTime() - GITHUB_WRITE_WINDOW_RETENTION_MS)))
  return row?.id
}

/** Close a squad's window once its command has exited. Closing twice, or another squad's window, is a no-op. */
export async function closeGitHubWriteWindow(
  input: { squadId: string; windowId: string; now?: Date },
  store: Store = db
): Promise<boolean> {
  const closed = await store
    .update(githubWriteWindows)
    .set({ closedAt: input.now ?? new Date() })
    .where(
      and(
        eq(githubWriteWindows.id, input.windowId),
        eq(githubWriteWindows.squadId, input.squadId),
        isNull(githubWriteWindows.closedAt)
      )
    )
    .returning({ id: githubWriteWindows.id })
  return closed.length > 0
}

/**
 * Whether `login` wrote at `occurredAt` inside one of Ficus's write windows (in any squad: a review by
 * the account from another squad's command is still Ficus's write). Undefined when the windows cannot
 * answer: the write predates recording, or is older than the retained windows.
 */
export async function githubWriteWindowMatch(
  input: { login: string; occurredAt: Date; now?: Date },
  store: Store = db
): Promise<GitHubWriteWindowMatch | undefined> {
  const login = input.login.trim().toLowerCase()
  const at = input.occurredAt.getTime()
  const now = (input.now ?? new Date()).getTime()
  if (!login || !Number.isFinite(at) || at < now - GITHUB_WRITE_WINDOW_RETENTION_MS + GITHUB_WRITE_WINDOW_MAX_OPEN_MS)
    return undefined
  const [since] = await store
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, GITHUB_WRITE_WINDOWS_SINCE_KEY))
  const sinceAt = since ? Date.parse(since.value) : NaN
  if (!Number.isFinite(sinceAt) || at < sinceAt) return undefined
  const earliestOpen = new Date(at + GITHUB_WRITE_WINDOW_CLOCK_SKEW_MS)
  const latestEnd = new Date(at - GITHUB_WRITE_WINDOW_CLOCK_SKEW_MS)
  const [inside] = await store
    .select({ id: githubWriteWindows.id })
    .from(githubWriteWindows)
    .where(
      and(
        eq(githubWriteWindows.login, login),
        lte(githubWriteWindows.openedAt, earliestOpen),
        or(
          gte(githubWriteWindows.closedAt, latestEnd),
          // Still open (running, or its close was lost): it covers writes up to the bounded time after opening.
          and(
            isNull(githubWriteWindows.closedAt),
            gte(githubWriteWindows.openedAt, new Date(latestEnd.getTime() - GITHUB_WRITE_WINDOW_MAX_OPEN_MS))
          )
        )
      )
    )
    .limit(1)
  return inside ? 'inside' : 'outside'
}

/** The GitHub App client a connection was authorized through, read from its credential bundle. */
async function connectionAppClientId(credentialRef: string): Promise<string | undefined> {
  try {
    const raw = await getSecretStore().get(credentialRef)
    return raw ? parseOAuthCredential(raw).clientBinding?.clientId : undefined
  } catch {
    return undefined
  }
}

/**
 * Record, on a GitHub comment or review the connected account wrote, whether Ficus wrote it. Runs once,
 * when the event is first stored, so the decision stays fixed for its native ID. A comment through an
 * app GitHub names but normalization did not recognise is Ficus's when that app is the one this
 * connection was authorized with; otherwise it, and every review and review comment, is decided by the
 * write windows. Facts this cannot decide are returned unchanged and keep the login rule.
 */
export async function annotateGitHubWriteAttribution(
  fact: IntegrationOutputFact,
  authority: IntegrationOutputAuthority,
  dependencies: { store?: Store; now?: Date; appClientId?: (credentialRef: string) => Promise<string | undefined> } = {}
): Promise<IntegrationOutputFact> {
  if (authority.kind !== 'connection' || !FEEDBACK_OUTPUTS.includes(fact.output)) return fact
  const data = record(fact.data) ?? {}
  if (data.viaApp === 'none' || data.viaApp === 'ficus' || data.ficusWriteWindow !== undefined) return fact
  const actor = typeof data.actor === 'string' ? data.actor.toLowerCase() : ''
  if (!actor) return fact
  const store = dependencies.store ?? db
  const [connection] = await store
    .select({
      configuration: integrationConnections.configuration,
      credentialRef: integrationConnections.credentialRef,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, authority.connectionId))
  const login = String(record(connection?.configuration)?.login ?? '').toLowerCase()
  if (!connection || !login || login !== actor) return fact
  if (data.viaApp === 'other' && typeof data.viaAppClientId === 'string') {
    const bound = await (dependencies.appClientId ?? connectionAppClientId)(connection.credentialRef)
    if (bound && bound === data.viaAppClientId) return { ...fact, data: { ...fact.data, viaApp: 'ficus' } }
  }
  const match = await githubWriteWindowMatch(
    { login, occurredAt: new Date(fact.occurredAt), ...(dependencies.now ? { now: dependencies.now } : {}) },
    store
  )
  return match ? { ...fact, data: { ...fact.data, ficusWriteWindow: match } } : fact
}
