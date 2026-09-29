import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { LocalUpdateManager } from './local-updater'

/**
 * Whether an update applies is decided by COMMIT ANCESTRY at fetch time — not
 * by the workflow event, the branch name, or whether CI happened to be quiet.
 *
 * The `local-setup` CI job sets up an instance at the checked-out commit and
 * runs a real check and apply against live `origin/main`. `git merge --ff-only`
 * succeeds only when one of the two commits is an ancestor of the other, so a
 * merge landing on main mid-run leaves neither ancestral and the job fails with
 * a bare `fatal: Not possible to fast-forward, aborting.` This has been
 * observed on `workflow_dispatch` runs (33793970280, 33793588171) AND on a
 * pull_request run (33798147505), whose merge ref was built on `87b225a5`
 * before main advanced to `caee0eef` — so a quiet PR window passing is not
 * evidence of correctness.
 *
 * These tests build an ISOLATED synthetic graph with real git, so the apply
 * target genuinely descends (or does not) from the instance commit and cannot
 * move underneath the assertion. The updater's injectable git seam runs real
 * git in that graph; only the `fetch` URL is redirected to the local remote,
 * because the production path hardcodes github.com.
 */

const FLAVOR = { source: 'git-checkout', supervisor: 'pm2', sandboxRuntime: 'k3d-local' } as const

let scratch: string
let remote: string
let checkout: string

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`)
  return stdout
}

async function commit(cwd: string, file: string, body: string): Promise<string> {
  writeFileSync(join(cwd, file), body)
  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', `add ${file}`])
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim()
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'updater-ancestry-'))
  remote = join(scratch, 'remote')
  checkout = join(scratch, 'checkout')
  await git(scratch, ['init', '-b', 'main', 'remote'])
  await commit(remote, 'base.txt', 'base')
  await git(scratch, ['clone', remote, 'checkout'])
  // The updater persists its run state to <repoRoot>/.tau, which the real repo
  // gitignores. Without this the checkout reads dirty and every apply below
  // would skip before it ever fetched — a fixture artefact, not a behaviour.
  writeFileSync(join(checkout, '.git', 'info', 'exclude'), '.tau/\n')
})

afterEach(() => rmSync(scratch, { recursive: true, force: true }))

/** A manager whose git runs for real in the checkout, with fetch pointed at the local remote. */
function manager(): { updater: LocalUpdateManager } {
  const updater = new LocalUpdateManager({
    repoRoot: checkout,
    flavor: () => FLAVOR,
    settings: { githubOwner: 'ficus', githubRepo: 'ficus' },
    git: async (args: string[]) => {
      // The one redirect: production fetches https://github.com/<slug>.git.
      const rewritten = args.map((a) => (a.startsWith('https://github.com/') ? remote : a))
      return git(checkout, rewritten)
    },
    gh: async (args: string[]) =>
      ({ 'auth token': 'test-token', 'repo view --json owner,name --jq .owner.login + "/" + .name': 'ficus/tau' })[
        args.join(' ')
      ] ?? '',
    // The planned commands are asserted through run.changedFiles/status; this
    // only has to resolve so a successful apply reaches 'succeeded'.
    commandRunner: { runAll: async () => {} },
    sandboxRuntimePreflight: () => {},
    runLock: async () => ({ release: async () => {} }),
  } as any)
  return { updater }
}

describe('update apply, by ancestry', () => {
  it('fast-forwards when the target descends from the checkout', async () => {
    const ahead = await commit(remote, 'next.txt', 'next')

    const run = await manager().updater.apply()

    expect(run.status).toBe('succeeded')
    expect(run.afterSha).toBe(ahead)
    // The checkout really moved — not merely a status the updater reported.
    expect((await git(checkout, ['rev-parse', 'HEAD'])).trim()).toBe(ahead)
    expect(run.changedFiles).toContain('next.txt')
  })

  it('reports divergence specifically, instead of a raw fast-forward failure', async () => {
    // Both descend from the shared base; neither descends from the other.
    const local = await commit(checkout, 'local.txt', 'local only')
    const upstream = await commit(remote, 'upstream.txt', 'upstream only')

    await expect(manager().updater.apply()).rejects.toThrow(/diverged/i)

    const run = manager().updater.status().latest
    expect(run?.status).toBe('failed')
    // The contract is a named divergence naming both sides and their ancestor —
    // NOT `fatal: Not possible to fast-forward`, which says nothing actionable.
    expect(run?.error).toContain('diverged')
    expect(run?.error).toContain(local.slice(0, 12))
    expect(run?.error).toContain(upstream.slice(0, 12))
    expect(run?.error).not.toContain('Not possible to fast-forward')
    expect(run?.error).not.toContain('test-token')
    // Nothing was applied.
    expect((await git(checkout, ['rev-parse', 'HEAD'])).trim()).toBe(local)
  })

  it('reports already-up-to-date separately, so the fast-forward case cannot pass vacuously', async () => {
    // No new upstream commit: if "no update available" and "fast-forwarded"
    // shared an outcome, the first test above would prove nothing.
    const before = (await git(checkout, ['rev-parse', 'HEAD'])).trim()

    const run = await manager().updater.apply()

    expect(run.status).toBe('skipped')
    expect(run.message).toBe('Already up to date')
    expect((await git(checkout, ['rev-parse', 'HEAD'])).trim()).toBe(before)
  })

  it('treats a checkout that is ahead of the target as up to date, not diverged', async () => {
    // The target is an ancestor of the checkout. Nothing to apply, but this is
    // not a divergence and must not be reported as one.
    await commit(checkout, 'local.txt', 'local only')

    const run = await manager().updater.apply()

    expect(run.status).toBe('skipped')
    expect(run.message).toBe('Already up to date')
  })

  it('holds the same contract for a PR merge ref whose base then advances', async () => {
    // The shape of run 33798147505: a merge ref is computed on main, main
    // advances, and the instance commit is now neither ancestor nor descendant.
    const mergeRefBase = (await git(checkout, ['rev-parse', 'HEAD'])).trim()
    await git(checkout, ['checkout', '-b', 'pr-merge-ref'])
    const mergeRef = await commit(checkout, 'pr.txt', 'pr contents')
    expect(mergeRef).not.toBe(mergeRefBase)
    await commit(remote, 'main-advanced.txt', 'main moved on')

    await expect(manager().updater.apply()).rejects.toThrow(/diverged/i)
    expect(manager().updater.status().latest?.error).toContain('diverged')
  })
})
