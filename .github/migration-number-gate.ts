/**
 * Drizzle migration number gate (run by .github/workflows/migration-numbers.yml).
 *
 * drizzle-kit numbers a new migration after the latest one it can see, so two
 * branches cut from the same main both generate the same number. Git only
 * notices when the second one merges (or never, if the SQL file names differ),
 * and the migrator applies only journal entries whose `when` is newer than the
 * last applied one, so a stale duplicate can be skipped silently in production.
 *
 * This gate compares the PR head with the current base branch and with the
 * other open pull requests that target it:
 *
 * - every new migration has a SQL file, a journal entry whose idx matches the
 *   tag number, and a snapshot;
 * - a number already on the base branch always fails;
 * - the journal chains from the base branch's latest entry (contiguous idx,
 *   increasing `when`) and the first new snapshot's prevId is the base
 *   branch's latest snapshot id;
 * - a number also added by another open, non-draft PR fails only the newer
 *   (higher-numbered) PR; the older PR passes with a warning naming the newer
 *   one. Draft PRs never claim a number.
 *
 * It is read-only: it reads git objects and the pull request REST API with the
 * workflow's GITHUB_TOKEN, and never writes labels, comments or statuses.
 * The decision logic is pure and covered by migration-number-gate.test.ts.
 */
import { appendFile } from 'node:fs/promises'

export const DRIZZLE_DIR = 'apps/core/drizzle'
const JOURNAL_PATH = `${DRIZZLE_DIR}/meta/_journal.json`
const TAG_PATTERN = /^(\d{4})_[A-Za-z0-9_-]+$/
const SQL_PATH_PATTERN = /^apps\/core\/drizzle\/(\d{4}_[^/]+)\.sql$/
/** GitHub's pull request files endpoint stops listing after this many files. */
const PULL_REQUEST_FILES_LIMIT = 3000

export interface JournalEntry {
  idx: number
  tag: string
  when: number
}

export interface SnapshotLink {
  id: string
  prevId: string
}

/** The migration state of one git revision. */
export interface MigrationTree {
  /** Journal entries in file order. */
  entries: JournalEntry[]
  /** SQL migration tags present in the drizzle folder (file names without `.sql`). */
  sqlTags: string[]
  /** The id/prevId of `meta/<NNNN>_snapshot.json`, or undefined when the file is missing. */
  snapshot(idx: number): SnapshotLink | undefined
}

export interface OpenPullRequest {
  number: number
  title: string
  draft: boolean
  /** Tags of the drizzle SQL files the PR adds. */
  addedMigrationTags: string[]
}

export interface CurrentPullRequest {
  number: number
  draft: boolean
}

export interface Findings {
  errors: string[]
  warnings: string[]
  notices: string[]
}

export interface BaseCheck extends Findings {
  /** The PR's new migrations, in journal order (plus SQL files missing from the journal). */
  newTags: string[]
}

export type GateStatus = 'passed' | 'failed' | 'skipped'

export interface GateReport extends Findings {
  status: GateStatus
}

export const migrationNumber = (tag: string): string | undefined => TAG_PATTERN.exec(tag)?.[1]
const pad = (idx: number) => String(idx).padStart(4, '0')

function regenerateAdvice(baseRef: string, baseSnapshotId: string | undefined): string {
  const snapshot = baseSnapshotId ? ` (${baseSnapshotId})` : ''
  return (
    `Merge ${baseRef} into this branch, regenerate the migration with drizzle-kit ` +
    `(bun db:generate from the repository root, after removing this branch's generated migration), ` +
    `and make sure the new snapshot's prevId chains to ${baseRef}'s latest snapshot${snapshot}.`
  )
}

/**
 * Checks the PR head's migrations against the base branch. Never needs the network.
 */
export function checkAgainstBase(base: MigrationTree, head: MigrationTree, baseRef = 'main'): BaseCheck {
  const errors: string[] = []
  const notices: string[] = []
  const baseTags = new Set(base.entries.map((entry) => entry.tag))
  const newEntries = head.entries.filter((entry) => !baseTags.has(entry.tag))
  const headJournalTags = new Set(head.entries.map((entry) => entry.tag))
  const baseSqlTags = new Set(base.sqlTags)
  const orphanSqlTags = head.sqlTags.filter((tag) => !baseSqlTags.has(tag) && !headJournalTags.has(tag))
  const newTags = [...newEntries.map((entry) => entry.tag), ...orphanSqlTags]
  const baseLatest = base.entries.at(-1)
  const baseSnapshotId = baseLatest ? base.snapshot(baseLatest.idx)?.id : undefined
  const advice = regenerateAdvice(baseRef, baseSnapshotId)

  if (newTags.length === 0) {
    notices.push(`This PR adds no new drizzle migrations, so there is no migration number to check.`)
    return { errors, warnings: [], notices, newTags }
  }

  // A number the base branch already uses is always the real collision.
  const baseNumbers = new Map<string, string>()
  for (const entry of base.entries) baseNumbers.set(pad(entry.idx), entry.tag)
  for (const tag of base.sqlTags) {
    const number = migrationNumber(tag)
    if (number && !baseNumbers.has(number)) baseNumbers.set(number, tag)
  }
  for (const tag of newTags) {
    const number = migrationNumber(tag)
    const existing = number ? baseNumbers.get(number) : undefined
    if (existing) {
      errors.push(`Migration ${tag} uses number ${number}, which ${baseRef} already has as ${existing}. ${advice}`)
    }
  }
  if (errors.length > 0) return { errors, warnings: [], notices, newTags }

  const headSqlTags = new Set(head.sqlTags)
  for (const tag of orphanSqlTags) {
    errors.push(`${DRIZZLE_DIR}/${tag}.sql is not in meta/_journal.json, so the migrator would never run it. ${advice}`)
  }
  for (const entry of newEntries) {
    const number = migrationNumber(entry.tag)
    if (!number) errors.push(`Journal tag ${entry.tag} does not start with a four-digit migration number.`)
    else if (number !== pad(entry.idx)) {
      errors.push(`Journal entry ${entry.tag} has idx ${entry.idx}; its tag number and idx must match. ${advice}`)
    }
    if (!headSqlTags.has(entry.tag))
      errors.push(`Journal entry ${entry.tag} has no ${DRIZZLE_DIR}/${entry.tag}.sql file.`)
    if (!head.snapshot(entry.idx)) {
      errors.push(`Journal entry ${entry.tag} has no ${DRIZZLE_DIR}/meta/${pad(entry.idx)}_snapshot.json file.`)
    }
  }

  // The journal must be the base journal followed by the new entries, unchanged.
  const headByTag = new Map(head.entries.map((entry) => [entry.tag, entry]))
  const missing = base.entries.filter((entry) => !headByTag.has(entry.tag)).map((entry) => entry.tag)
  if (missing.length > 0) {
    errors.push(
      `The journal does not chain from ${baseRef}'s latest migration ${baseLatest?.tag}: this branch is missing ` +
        `${missing.join(', ')}. ${advice}`
    )
    return { errors, warnings: [], notices, newTags }
  }
  for (const entry of base.entries) {
    const mine = headByTag.get(entry.tag)!
    if (mine.idx !== entry.idx || mine.when !== entry.when) {
      errors.push(
        `Journal entry ${entry.tag} differs from ${baseRef} (idx or when changed). Existing migrations must not change.`
      )
    }
  }
  const expectedOrder = [...base.entries.map((entry) => entry.tag), ...newEntries.map((entry) => entry.tag)]
  if (head.entries.map((entry) => entry.tag).join('\n') !== expectedOrder.join('\n')) {
    errors.push(`New journal entries must come after ${baseRef}'s latest entry ${baseLatest?.tag}. ${advice}`)
  }

  let previous = baseLatest
  let previousSnapshotId = baseSnapshotId
  for (const entry of newEntries) {
    const expectedIdx = previous ? previous.idx + 1 : 0
    if (entry.idx !== expectedIdx) {
      errors.push(
        `Journal entry ${entry.tag} has idx ${entry.idx}, but it must follow ${previous?.tag ?? 'the start of the journal'} ` +
          `with idx ${expectedIdx}. ${advice}`
      )
    }
    if (previous && entry.when <= previous.when) {
      errors.push(
        `Journal entry ${entry.tag} has when ${entry.when}, not later than ${previous.tag} (${previous.when}). ` +
          `The migrator only applies migrations newer than the last applied one, so it would be skipped. ${advice}`
      )
    }
    const link = head.snapshot(entry.idx)
    if (link && previousSnapshotId && link.prevId !== previousSnapshotId) {
      errors.push(
        `Snapshot ${pad(entry.idx)}_snapshot.json has prevId ${link.prevId}, but it must chain to ` +
          `${previous?.tag}'s snapshot id ${previousSnapshotId}. ${advice}`
      )
    }
    previous = entry
    previousSnapshotId = link?.id
  }

  return { errors, warnings: [], notices, newTags }
}

/**
 * Checks the PR's new migration numbers against the other open PRs that target the base branch.
 * Only non-draft PRs claim a number; between two claimants the lower PR number keeps it.
 */
export function checkAgainstOpenPullRequests(
  current: CurrentPullRequest,
  newTags: string[],
  openPullRequests: OpenPullRequest[],
  baseRef = 'main'
): Findings {
  const errors: string[] = []
  const warnings: string[] = []
  const notices: string[] = []
  const swapHint = (other: number) =>
    `Alternatively, coordinate on PR #${other} to swap the order: a PR that is converted to draft stops claiming its number, ` +
    `so this check passes when re-run.`

  for (const tag of newTags) {
    const number = migrationNumber(tag)
    if (!number) continue
    for (const other of openPullRequests) {
      if (other.number === current.number) continue
      for (const otherTag of other.addedMigrationTags) {
        if (migrationNumber(otherTag) !== number) continue
        const label = `PR #${other.number} ("${other.title}")`
        if (otherTag === tag) {
          notices.push(
            `${label} adds the same migration file ${tag}.sql (a stacked branch?), so it is not a collision.`
          )
        } else if (other.draft) {
          warnings.push(
            `Draft ${label} also adds migration number ${number} as ${otherTag}. Draft PRs do not claim a number, ` +
              `so this does not fail; whichever merges later must regenerate.`
          )
        } else if (current.draft || other.number < current.number) {
          const reason = current.draft
            ? `This PR is a draft, so it does not claim migration numbers, and ${label} already uses ${number} as ${otherTag}.`
            : `Open ${label} is older and already claims number ${number} as ${otherTag}.`
          errors.push(
            `Migration ${tag} collides with another open PR. ${reason} Wait for PR #${other.number} to merge, then merge ` +
              `${baseRef} into this branch, regenerate with drizzle-kit (bun db:generate, after removing this branch's ` +
              `generated migration), and make sure the new snapshot's prevId chains to ${baseRef}'s latest snapshot. ` +
              swapHint(other.number)
          )
        } else {
          warnings.push(
            `Newer open ${label} also adds migration number ${number} as ${otherTag}. This PR keeps the number because ` +
              `it is older; PR #${other.number} fails until this PR merges and it regenerates.`
          )
        }
      }
    }
  }
  return { errors, warnings, notices }
}

export interface GateDependencies {
  baseRef: string
  current: CurrentPullRequest
  loadBase(): MigrationTree
  loadHead(): MigrationTree
  listOpenPullRequests(): Promise<OpenPullRequest[]>
}

/** Runs both checks. Any thrown error becomes a failure: the gate never passes silently. */
export async function runGate(deps: GateDependencies): Promise<GateReport> {
  try {
    const baseCheck = checkAgainstBase(deps.loadBase(), deps.loadHead(), deps.baseRef)
    if (baseCheck.newTags.length === 0) return { status: 'skipped', ...baseCheck }
    if (baseCheck.errors.length > 0) {
      return {
        status: 'failed',
        ...baseCheck,
        notices: [
          ...baseCheck.notices,
          `Open pull requests were not checked: fix the ${deps.baseRef} problems first, because regenerating changes the migration number.`,
        ],
      }
    }
    const openPullRequests = await deps.listOpenPullRequests()
    // Prefer the live draft state: a re-run reuses the original event payload.
    const live = openPullRequests.find((pull) => pull.number === deps.current.number)
    const current = live ? { number: live.number, draft: live.draft } : deps.current
    const openCheck = checkAgainstOpenPullRequests(current, baseCheck.newTags, openPullRequests, deps.baseRef)
    const errors = [...baseCheck.errors, ...openCheck.errors]
    return {
      status: errors.length > 0 ? 'failed' : 'passed',
      errors,
      warnings: [...baseCheck.warnings, ...openCheck.warnings],
      notices: [
        ...baseCheck.notices,
        ...openCheck.notices,
        `Checked ${baseCheck.newTags.join(', ')} against ${deps.baseRef} and its open pull requests.`,
      ],
    }
  } catch (error) {
    return {
      status: 'failed',
      errors: [
        `The migration number check could not run, so it fails instead of passing unchecked: ` +
          `${error instanceof Error ? error.message : String(error)}. Re-run the failed job; if it keeps failing, report it.`,
      ],
      warnings: [],
      notices: [],
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub REST API (read-only)

export interface GitHubApiOptions {
  apiUrl: string
  repository: string
  token: string
  baseRef: string
  fetchImpl?: typeof fetch
}

async function getPages<T>(options: GitHubApiOptions, path: string, maxItems = Infinity): Promise<T[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const items: T[] = []
  for (let page = 1; items.length < maxItems; page++) {
    const separator = path.includes('?') ? '&' : '?'
    const url = `${options.apiUrl}/repos/${options.repository}${path}${separator}per_page=100&page=${page}`
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      let message = body.slice(0, 200)
      try {
        message = (JSON.parse(body) as { message?: string }).message ?? message
      } catch {
        // Not JSON: keep the raw body excerpt.
      }
      throw new Error(`GitHub API GET ${path} returned HTTP ${response.status}${message ? ` (${message})` : ''}`)
    }
    const batch = (await response.json()) as unknown
    if (!Array.isArray(batch)) throw new Error(`GitHub API GET ${path} did not return a list`)
    items.push(...(batch as T[]))
    if (batch.length < 100) break
  }
  return items
}

interface ApiPullRequest {
  number: number
  title: string
  draft?: boolean
}
interface ApiPullRequestFile {
  filename: string
  status: string
}

/** Lists the open PRs targeting the base branch with the drizzle SQL files each one adds. */
export async function listOpenMigrationPullRequests(
  options: GitHubApiOptions,
  warn: (message: string) => void = () => {}
): Promise<OpenPullRequest[]> {
  const pulls = await getPages<ApiPullRequest>(options, `/pulls?state=open&base=${encodeURIComponent(options.baseRef)}`)
  const result: OpenPullRequest[] = []
  for (const pull of pulls) {
    const files = await getPages<ApiPullRequestFile>(options, `/pulls/${pull.number}/files`, PULL_REQUEST_FILES_LIMIT)
    if (files.length >= PULL_REQUEST_FILES_LIMIT) {
      warn(
        `PR #${pull.number} changes ${PULL_REQUEST_FILES_LIMIT} or more files; GitHub lists only the first ${PULL_REQUEST_FILES_LIMIT}.`
      )
    }
    const addedMigrationTags = files
      .filter((file) => file.status === 'added' || file.status === 'renamed' || file.status === 'copied')
      .map((file) => SQL_PATH_PATTERN.exec(file.filename)?.[1])
      .filter((tag): tag is string => tag !== undefined)
    result.push({ number: pull.number, title: pull.title, draft: pull.draft === true, addedMigrationTags })
  }
  return result
}

// ---------------------------------------------------------------------------
// Git

function git(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const child = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { ok: child.exitCode === 0, stdout: child.stdout.toString(), stderr: child.stderr.toString().trim() }
}

/** Reads a revision's drizzle journal, SQL file list and (lazily) snapshot links from git objects. */
export function loadTreeFromGit(rev: string, cwd?: string): MigrationTree {
  const journal = git(['show', `${rev}:${JOURNAL_PATH}`], cwd)
  if (!journal.ok) throw new Error(`cannot read ${JOURNAL_PATH} at ${rev}: ${journal.stderr}`)
  const parsed = JSON.parse(journal.stdout) as { entries?: JournalEntry[] }
  if (!Array.isArray(parsed.entries)) throw new Error(`${JOURNAL_PATH} at ${rev} has no entries list`)
  const listing = git(['ls-tree', '--name-only', rev, `${DRIZZLE_DIR}/`], cwd)
  if (!listing.ok) throw new Error(`cannot list ${DRIZZLE_DIR} at ${rev}: ${listing.stderr}`)
  const sqlTags = listing.stdout
    .split('\n')
    .map((path) => SQL_PATH_PATTERN.exec(path)?.[1])
    .filter((tag): tag is string => tag !== undefined)
  return {
    entries: parsed.entries.map(({ idx, tag, when }) => ({ idx, tag, when })),
    sqlTags,
    snapshot(idx) {
      const file = git(['show', `${rev}:${DRIZZLE_DIR}/meta/${pad(idx)}_snapshot.json`], cwd)
      if (!file.ok) return undefined
      const { id, prevId } = JSON.parse(file.stdout) as SnapshotLink
      return { id, prevId }
    },
  }
}

// ---------------------------------------------------------------------------
// CLI

const escapeAnnotation = (message: string) => message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function main(): Promise<number> {
  let deps: GateDependencies
  try {
    const baseRef = requireEnv('BASE_REF')
    const baseRev = requireEnv('BASE_REV')
    const headSha = requireEnv('HEAD_SHA')
    const prNumber = Number(requireEnv('PR_NUMBER'))
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error(`PR_NUMBER is not a pull request number`)
    const api: GitHubApiOptions = {
      apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
      repository: requireEnv('GITHUB_REPOSITORY'),
      token: requireEnv('GITHUB_TOKEN'),
      baseRef,
    }
    deps = {
      baseRef,
      current: { number: prNumber, draft: process.env.PR_DRAFT === 'true' },
      loadBase: () => loadTreeFromGit(baseRev),
      loadHead: () => loadTreeFromGit(headSha),
      listOpenPullRequests: () =>
        listOpenMigrationPullRequests(api, (message) => console.log(`::warning::${escapeAnnotation(message)}`)),
    }
  } catch (error) {
    console.log(
      `::error::Migration number check is misconfigured: ${escapeAnnotation(String((error as Error).message ?? error))}`
    )
    return 1
  }

  const report = await runGate(deps)
  for (const message of report.errors)
    console.log(`::error title=Drizzle migration number::${escapeAnnotation(message)}`)
  for (const message of report.warnings)
    console.log(`::warning title=Drizzle migration number::${escapeAnnotation(message)}`)
  for (const message of report.notices)
    console.log(`::notice title=Drizzle migration number::${escapeAnnotation(message)}`)
  const headline = {
    passed: 'PASSED: no drizzle migration number collisions.',
    failed: 'FAILED: drizzle migration number problems found.',
    skipped: 'SKIPPED: this PR adds no new drizzle migrations.',
  }[report.status]
  console.log(headline)

  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    const lines = [
      `### Drizzle migration numbers: ${report.status}`,
      '',
      ...report.errors.map((message) => `- Error: ${message}`),
      ...report.warnings.map((message) => `- Warning: ${message}`),
      ...report.notices.map((message) => `- ${message}`),
      '',
    ]
    await appendFile(summary, lines.join('\n'))
  }
  return report.status === 'failed' ? 1 : 0
}

if (import.meta.main) {
  if (process.argv[2] !== 'check') {
    console.error('Usage: bun .github/migration-number-gate.ts check')
    process.exit(2)
  }
  process.exit(await main())
}
