/**
 * The commit a checkout's builds were last brought up to date with.
 *
 * The updaters chose build tasks from the files one pull changed. That misses
 * everything whenever the checkout moved without a completed build: an update that
 * failed or was interrupted after its pull, or a `git pull` run by hand. The next
 * update then starts on the new commit, sees no changed files, builds nothing and
 * restarts onto stale bundles (the web app most visibly: Core at least refuses to
 * start on a stale migration list).
 *
 * So the last commit known to be fully built is recorded next to the update status
 * file, and an update plans from that commit instead of only from where its own
 * pull started. It is recorded when a run completes every build, and seeded with a
 * run's starting commit when nothing is recorded yet, so a first run that fails is
 * already covered.
 *
 * Imports only Node built-ins: `scripts/update-offline-bootstrap.ts` loads this
 * before any dependency install (see dependency-install.ts for why that matters).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHA = /^[0-9a-f]{40}$/
const FILE = 'built-commit.json'

/** The status directory of a checkout: where the update status file lives too. */
export function updateStateDir(repoRoot: string): string {
  return join(repoRoot, '.ficus')
}

/** The recorded commit, or undefined when none is recorded or the record is unreadable. */
export function readBuiltCommit(stateDir: string): string | undefined {
  try {
    const path = join(stateDir, FILE)
    if (!existsSync(path)) return undefined
    const sha = (JSON.parse(readFileSync(path, 'utf8')) as { sha?: unknown }).sha
    return typeof sha === 'string' && SHA.test(sha) ? sha : undefined
  } catch {
    return undefined
  }
}

/** Best effort, like the status file: an update never fails because this could not be written. */
export function writeBuiltCommit(stateDir: string, sha: string): void {
  if (!SHA.test(sha)) return
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, FILE), JSON.stringify({ sha, recordedAt: new Date().toISOString() }))
  } catch {
    // Without the record the next update plans from its own pull, as before.
  }
}

/**
 * Record `sha` as built only when nothing is recorded: the builds are assumed current
 * at the commit the first tracked update starts from, which is what every update
 * assumed before this record existed.
 */
export function seedBuiltCommit(stateDir: string, sha: string): void {
  if (readBuiltCommit(stateDir) === undefined) writeBuiltCommit(stateDir, sha)
}

/**
 * Move the record from `from` to `to` after a run that built exactly that range. It
 * stays where it is when it names an older commit: that run did not build what is
 * still outstanding from there.
 */
export function advanceBuiltCommit(stateDir: string, from: string, to: string): void {
  const recorded = readBuiltCommit(stateDir)
  if (recorded === undefined || recorded === from) writeBuiltCommit(stateDir, to)
}
