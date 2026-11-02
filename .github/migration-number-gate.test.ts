import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkAgainstBase,
  checkAgainstOpenPullRequests,
  listOpenMigrationPullRequests,
  loadTreeFromGit,
  runGate,
  type GateDependencies,
  type JournalEntry,
  type MigrationTree,
  type OpenPullRequest,
  type SnapshotLink,
} from './migration-number-gate'

// All data here is synthetic: tiny journals named 0000_m0, 0001_m1, ... with
// snapshot ids snap-<idx>, never the repository's real migrations.

const pad = (idx: number) => String(idx).padStart(4, '0')
const entry = (idx: number, name = `m${idx}`, when = 1_000 + idx): JournalEntry => ({
  idx,
  tag: `${pad(idx)}_${name}`,
  when,
})

interface TreeSpec {
  entries: JournalEntry[]
  sqlTags?: string[]
  snapshots?: Record<number, SnapshotLink | undefined>
}

function tree({ entries, sqlTags, snapshots = {} }: TreeSpec): MigrationTree {
  return {
    entries,
    sqlTags: sqlTags ?? entries.map((item) => item.tag),
    snapshot: (idx) =>
      idx in snapshots ? snapshots[idx] : entries.some((item) => item.idx === idx) ? chained(idx) : undefined,
  }
}
const chained = (idx: number): SnapshotLink => ({ id: `snap-${idx}`, prevId: idx === 0 ? 'origin' : `snap-${idx - 1}` })
const range = (count: number) => Array.from({ length: count }, (_, idx) => entry(idx))

/** main has 0000..0002. */
const base = tree({ entries: range(3) })
/** A PR head that correctly adds 0003_mine on top of main. */
const goodHead = tree({ entries: [...range(3), entry(3, 'mine')] })

describe('checkAgainstBase', () => {
  test('a PR without new migrations is an explicit skip', () => {
    const result = checkAgainstBase(base, tree({ entries: range(3) }))
    expect(result.newTags).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.notices.join(' ')).toContain('adds no new drizzle migrations')
  })

  test('a correctly generated migration passes', () => {
    const result = checkAgainstBase(base, goodHead)
    expect(result.errors).toEqual([])
    expect(result.newTags).toEqual(['0003_mine'])
  })

  test('several new migrations chain from each other', () => {
    const head = tree({ entries: [...range(3), entry(3, 'a'), entry(4, 'b')] })
    expect(checkAgainstBase(base, head).errors).toEqual([])
  })

  test('a number main already has always fails, naming the existing migration and the fix', () => {
    const main = tree({ entries: [...range(3), entry(3, 'theirs', 2_000)] })
    const result = checkAgainstBase(main, goodHead)
    expect(result.errors).toHaveLength(1)
    const [message] = result.errors
    expect(message).toContain('Migration 0003_mine uses number 0003, which main already has as 0003_theirs')
    expect(message).toContain('Merge main into this branch')
    expect(message).toContain('drizzle-kit')
    expect(message).toContain("prevId chains to main's latest snapshot (snap-3)")
  })

  test('a SQL file on main without a journal entry still owns its number', () => {
    const main = tree({ entries: range(3), sqlTags: [...range(3).map((item) => item.tag), '0003_stray'] })
    expect(checkAgainstBase(main, goodHead).errors[0]).toContain('main already has as 0003_stray')
  })

  test('a journal that is missing main’s latest entry does not chain', () => {
    const main = tree({ entries: [...range(3), entry(3, 'theirs')] })
    const head = tree({ entries: [...range(3), entry(4, 'mine', 5_000)] })
    const result = checkAgainstBase(main, head)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("does not chain from main's latest migration 0003_theirs")
    expect(result.errors[0]).toContain('missing 0003_theirs')
  })

  test('an idx gap after main’s latest entry fails', () => {
    const head = tree({ entries: [...range(3), entry(4, 'mine')], snapshots: { 4: { id: 'x', prevId: 'snap-2' } } })
    const result = checkAgainstBase(base, head)
    expect(result.errors.join('\n')).toContain('has idx 4, but it must follow 0002_m2 with idx 3')
  })

  test('a tag number that differs from its idx fails', () => {
    const head = tree({ entries: [...range(3), { idx: 3, tag: '0007_mine', when: 9_000 }] })
    expect(checkAgainstBase(base, head).errors.join('\n')).toContain(
      '0007_mine has idx 3; its tag number and idx must match'
    )
  })

  test('a tag without a four-digit number fails', () => {
    const head = tree({ entries: [...range(3), { idx: 3, tag: 'mine', when: 9_000 }] })
    expect(checkAgainstBase(base, head).errors.join('\n')).toContain(
      'does not start with a four-digit migration number'
    )
  })

  test('a when that is not later than main’s latest fails, because the migrator would skip it', () => {
    const head = tree({ entries: [...range(3), entry(3, 'mine', 1_002)] })
    const message = checkAgainstBase(base, head).errors.join('\n')
    expect(message).toContain('has when 1002, not later than 0002_m2 (1002)')
    expect(message).toContain('would be skipped')
  })

  test('a snapshot whose prevId is not main’s latest snapshot fails', () => {
    const head = tree({ entries: goodHead.entries, snapshots: { 3: { id: 'snap-3', prevId: 'snap-1' } } })
    expect(checkAgainstBase(base, head).errors.join('\n')).toContain(
      "has prevId snap-1, but it must chain to 0002_m2's snapshot id snap-2"
    )
  })

  test('the second new snapshot must chain to the first', () => {
    const head = tree({
      entries: [...range(3), entry(3, 'a'), entry(4, 'b')],
      snapshots: { 4: { id: 'snap-4', prevId: 'snap-2' } },
    })
    expect(checkAgainstBase(base, head).errors.join('\n')).toContain("must chain to 0003_a's snapshot id snap-3")
  })

  test('missing SQL and snapshot files fail', () => {
    const head = tree({
      entries: goodHead.entries,
      sqlTags: range(3).map((item) => item.tag),
      snapshots: { 3: undefined },
    })
    const message = checkAgainstBase(base, head).errors.join('\n')
    expect(message).toContain('0003_mine has no apps/core/drizzle/0003_mine.sql file')
    expect(message).toContain('0003_mine has no apps/core/drizzle/meta/0003_snapshot.json file')
  })

  test('a new SQL file without a journal entry fails', () => {
    const head = tree({ entries: range(3), sqlTags: [...range(3).map((item) => item.tag), '0003_orphan'] })
    const result = checkAgainstBase(base, head)
    expect(result.newTags).toEqual(['0003_orphan'])
    expect(result.errors.join('\n')).toContain('0003_orphan.sql is not in meta/_journal.json')
  })

  test('changing an existing journal entry fails', () => {
    const head = tree({ entries: [entry(0), entry(1, 'm1', 1_500), entry(2), entry(3, 'mine')] })
    expect(checkAgainstBase(base, head).errors.join('\n')).toContain('Journal entry 0001_m1 differs from main')
  })

  test('a new entry placed before main’s entries fails', () => {
    const head = tree({ entries: [entry(0), entry(1), entry(3, 'mine', 2_000), entry(2)] })
    expect(checkAgainstBase(base, head).errors.join('\n')).toContain("must come after main's latest entry 0002_m2")
  })
})

const pr = (number: number, tags: string[], draft = false, title = `Synthetic PR ${number}`): OpenPullRequest => ({
  number,
  title,
  draft,
  addedMigrationTags: tags,
})

describe('checkAgainstOpenPullRequests', () => {
  test('an older open PR with the same number fails the newer PR with exact instructions', () => {
    const result = checkAgainstOpenPullRequests(
      { number: 810, draft: false },
      ['0003_mine'],
      [pr(807, ['0003_theirs'])]
    )
    expect(result.errors).toHaveLength(1)
    const [message] = result.errors
    expect(message).toContain(
      'Open PR #807 ("Synthetic PR 807") is older and already claims number 0003 as 0003_theirs'
    )
    expect(message).toContain('Wait for PR #807 to merge, then merge main into this branch')
    expect(message).toContain('regenerate with drizzle-kit')
    expect(message).toContain("prevId chains to main's latest snapshot")
    expect(message).toContain('coordinate on PR #807 to swap the order')
  })

  test('the older PR passes with a warning naming the newer one', () => {
    const result = checkAgainstOpenPullRequests(
      { number: 807, draft: false },
      ['0003_theirs'],
      [pr(810, ['0003_mine'])]
    )
    expect(result.errors).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('Newer open PR #810 ("Synthetic PR 810") also adds migration number 0003')
    expect(result.warnings[0]).toContain('PR #810 fails until this PR merges')
  })

  test('a draft PR never claims a number, even when it is older', () => {
    const result = checkAgainstOpenPullRequests(
      { number: 810, draft: false },
      ['0003_mine'],
      [pr(700, ['0003_old'], true)]
    )
    expect(result.errors).toEqual([])
    expect(result.warnings[0]).toContain('Draft PR #700')
    expect(result.warnings[0]).toContain('do not claim a number')
  })

  test('a draft PR yields to a newer non-draft PR', () => {
    const result = checkAgainstOpenPullRequests({ number: 700, draft: true }, ['0003_old'], [pr(810, ['0003_mine'])])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('This PR is a draft, so it does not claim migration numbers')
    expect(result.errors[0]).toContain('Wait for PR #810 to merge')
  })

  test('the same migration file in a stacked PR is not a collision', () => {
    const result = checkAgainstOpenPullRequests({ number: 810, draft: false }, ['0003_mine'], [pr(809, ['0003_mine'])])
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.notices[0]).toContain('PR #809')
  })

  test('different numbers and the PR itself are ignored', () => {
    const result = checkAgainstOpenPullRequests(
      { number: 810, draft: false },
      ['0003_mine'],
      [pr(810, ['0003_mine']), pr(805, ['0004_other']), pr(806, [])]
    )
    expect(result).toEqual({ errors: [], warnings: [], notices: [] })
  })
})

function deps(overrides: Partial<GateDependencies> = {}): GateDependencies {
  return {
    baseRef: 'main',
    current: { number: 810, draft: false },
    loadBase: () => base,
    loadHead: () => goodHead,
    listOpenPullRequests: async () => [],
    ...overrides,
  }
}

describe('runGate', () => {
  test('passes and says what it checked', async () => {
    const report = await runGate(deps())
    expect(report.status).toBe('passed')
    expect(report.notices.at(-1)).toBe('Checked 0003_mine against main and its open pull requests.')
  })

  test('skips explicitly without calling the API when there are no new migrations', async () => {
    const report = await runGate(
      deps({
        loadHead: () => base,
        listOpenPullRequests: async () => {
          throw new Error('must not be called')
        },
      })
    )
    expect(report.status).toBe('skipped')
    expect(report.notices.join(' ')).toContain('adds no new drizzle migrations')
  })

  test('a main collision fails whatever the open PRs are, and open PRs are not consulted', async () => {
    const report = await runGate(
      deps({
        loadBase: () => tree({ entries: [...range(3), entry(3, 'theirs', 2_000)] }),
        listOpenPullRequests: async () => {
          throw new Error('must not be called')
        },
      })
    )
    expect(report.status).toBe('failed')
    expect(report.errors[0]).toContain('which main already has as 0003_theirs')
    expect(report.notices.join(' ')).toContain('Open pull requests were not checked')
  })

  test('fails on an older open PR collision', async () => {
    const report = await runGate(deps({ listOpenPullRequests: async () => [pr(807, ['0003_theirs'])] }))
    expect(report.status).toBe('failed')
    expect(report.errors[0]).toContain('PR #807')
  })

  test('uses the live draft state of the PR rather than the event payload', async () => {
    const report = await runGate(
      deps({
        current: { number: 700, draft: false },
        listOpenPullRequests: async () => [pr(700, ['0003_mine'], true), pr(810, ['0003_theirs'])],
      })
    )
    expect(report.status).toBe('failed')
    expect(report.errors[0]).toContain('This PR is a draft')
  })

  test('an API error fails instead of passing silently', async () => {
    const report = await runGate(
      deps({
        listOpenPullRequests: async () => {
          throw new Error('GitHub API GET /pulls returned HTTP 403 (Resource not accessible by integration)')
        },
      })
    )
    expect(report.status).toBe('failed')
    expect(report.errors[0]).toContain('could not run, so it fails instead of passing unchecked')
    expect(report.errors[0]).toContain('HTTP 403')
  })

  test('an unreadable revision fails', async () => {
    const report = await runGate(
      deps({
        loadHead: () => {
          throw new Error('cannot read apps/core/drizzle/meta/_journal.json at deadbeef')
        },
      })
    )
    expect(report.status).toBe('failed')
    expect(report.errors[0]).toContain('cannot read')
  })
})

type FakeRoute = (url: URL) => Response
function fakeFetch(route: FakeRoute, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(`${url.pathname}${url.search}`)
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token')
    return route(url)
  }) as typeof fetch
}
const api = (fetchImpl: typeof fetch) => ({
  apiUrl: 'https://api.example.test',
  repository: 'example/repo',
  token: 'synthetic-token',
  baseRef: 'main',
  fetchImpl,
})

describe('listOpenMigrationPullRequests', () => {
  test('pages through open PRs and keeps only drizzle SQL files each PR adds', async () => {
    const pulls = Array.from({ length: 101 }, (_, index) => ({
      number: index + 1,
      title: `PR ${index + 1}`,
      draft: index === 0,
    }))
    const calls: string[] = []
    const fetchImpl = fakeFetch((url) => {
      if (url.pathname === '/repos/example/repo/pulls') {
        expect(url.searchParams.get('state')).toBe('open')
        expect(url.searchParams.get('base')).toBe('main')
        const page = Number(url.searchParams.get('page'))
        return Response.json(page === 1 ? pulls.slice(0, 100) : pulls.slice(100))
      }
      if (url.pathname === '/repos/example/repo/pulls/1/files') {
        return Response.json([
          { filename: 'apps/core/drizzle/0003_added.sql', status: 'added' },
          { filename: 'apps/core/drizzle/0002_m2.sql', status: 'modified' },
          { filename: 'apps/core/drizzle/0004_gone.sql', status: 'removed' },
          { filename: 'apps/core/drizzle/meta/0003_snapshot.json', status: 'added' },
          { filename: 'apps/core/drizzle/0005_moved.sql', status: 'renamed' },
          { filename: 'apps/web/0003_not_drizzle.sql', status: 'added' },
        ])
      }
      return Response.json([])
    }, calls)
    const result = await listOpenMigrationPullRequests(api(fetchImpl))
    expect(result).toHaveLength(101)
    expect(result[0]).toEqual({
      number: 1,
      title: 'PR 1',
      draft: true,
      addedMigrationTags: ['0003_added', '0005_moved'],
    })
    expect(result[100]).toEqual({ number: 101, title: 'PR 101', draft: false, addedMigrationTags: [] })
    expect(calls.filter((call) => call.startsWith('/repos/example/repo/pulls?'))).toHaveLength(2)
  })

  test('an HTTP error throws with the status and GitHub message', async () => {
    const fetchImpl = fakeFetch(() =>
      Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
    )
    await expect(listOpenMigrationPullRequests(api(fetchImpl))).rejects.toThrow(
      /HTTP 403 \(Resource not accessible by integration\)/
    )
  })

  test('a non-list response throws', async () => {
    const fetchImpl = fakeFetch(() => Response.json({ unexpected: true }))
    await expect(listOpenMigrationPullRequests(api(fetchImpl))).rejects.toThrow(/did not return a list/)
  })
})

// A throwaway git repository with synthetic drizzle files, to exercise the git
// loader and the CLI end to end against a fake GitHub API.
describe('git loader and CLI', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve>
  let openPulls: { number: number; title: string; draft: boolean }[] = []
  let filesByPull: Record<number, { filename: string; status: string }[]> = {}
  let failApi = false
  const gateScript = join(import.meta.dir, 'migration-number-gate.ts')

  const run = (cwd: string, args: string[]) => {
    const child = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (child.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${child.stderr.toString()}`)
    return child.stdout.toString().trim()
  }
  const writeMigrations = (entries: JournalEntry[]) => {
    const dir = join(repo, 'apps/core/drizzle')
    mkdirSync(join(dir, 'meta'), { recursive: true })
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }))
    for (const item of entries) {
      writeFileSync(join(dir, `${item.tag}.sql`), 'SELECT 1;\n')
      writeFileSync(join(dir, `meta/${pad(item.idx)}_snapshot.json`), JSON.stringify(chained(item.idx)))
    }
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'migration-number-gate-'))
    run(repo, ['init', '-q', '-b', 'main'])
    run(repo, ['config', 'user.email', 'gate@example.test'])
    run(repo, ['config', 'user.name', 'Gate Test'])
    writeMigrations(range(3))
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-q', '-m', 'base'])
    run(repo, ['checkout', '-q', '-b', 'feature'])
    writeMigrations([...range(3), entry(3, 'mine')])
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-q', '-m', 'head'])

    server = Bun.serve({
      port: 0,
      fetch(request) {
        if (failApi) return Response.json({ message: 'synthetic outage' }, { status: 502 })
        const url = new URL(request.url)
        if (url.pathname === '/repos/example/repo/pulls') return Response.json(openPulls)
        const match = /^\/repos\/example\/repo\/pulls\/(\d+)\/files$/.exec(url.pathname)
        if (match) return Response.json(filesByPull[Number(match[1])] ?? [])
        return new Response('not found', { status: 404 })
      },
    })
  })

  afterAll(() => {
    server?.stop(true)
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  test('loadTreeFromGit reads the journal, SQL tags and snapshots of a revision', () => {
    const head = loadTreeFromGit('feature', repo)
    expect(head.entries.map((item) => item.tag)).toEqual(['0000_m0', '0001_m1', '0002_m2', '0003_mine'])
    expect(head.sqlTags).toEqual(['0000_m0', '0001_m1', '0002_m2', '0003_mine'])
    expect(head.snapshot(3)).toEqual({ id: 'snap-3', prevId: 'snap-2' })
    expect(head.snapshot(9)).toBeUndefined()
    expect(() => loadTreeFromGit('no-such-revision', repo)).toThrow(/cannot read/)
  })

  const cli = async (env: Record<string, string>) => {
    const summary = join(repo, '.summary.md')
    writeFileSync(summary, '')
    // Async spawn: a synchronous one would block the in-process fake API server.
    const child = Bun.spawn(['bun', gateScript, 'check'], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
        GITHUB_REPOSITORY: 'example/repo',
        GITHUB_TOKEN: 'synthetic-token',
        GITHUB_STEP_SUMMARY: summary,
        BASE_REF: 'main',
        BASE_REV: 'main',
        HEAD_SHA: run(repo, ['rev-parse', 'feature']),
        PR_NUMBER: '810',
        PR_DRAFT: 'false',
        ...env,
      },
    })
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()])
    return { code, out, summary: readFileSync(summary, 'utf8') }
  }

  test('the CLI passes a clean PR and writes a step summary', async () => {
    openPulls = [{ number: 810, title: 'This PR', draft: false }]
    filesByPull = { 810: [{ filename: 'apps/core/drizzle/0003_mine.sql', status: 'added' }] }
    failApi = false
    const result = await cli({})
    expect(result.code).toBe(0)
    expect(result.out).toContain('PASSED: no drizzle migration number collisions.')
    expect(result.summary).toContain('### Drizzle migration numbers: passed')
  })

  test('the CLI fails with an annotation naming the older PR', async () => {
    openPulls = [
      { number: 807, title: 'Older PR', draft: false },
      { number: 810, title: 'This PR', draft: false },
    ]
    filesByPull = { 807: [{ filename: 'apps/core/drizzle/0003_theirs.sql', status: 'added' }] }
    failApi = false
    const result = await cli({})
    expect(result.code).toBe(1)
    expect(result.out).toContain(
      '::error title=Drizzle migration number::Migration 0003_mine collides with another open PR.'
    )
    expect(result.out).toContain('Wait for PR #807 to merge')
    expect(result.out).toContain('FAILED')
  })

  test('the CLI fails clearly when the API is unavailable', async () => {
    failApi = true
    const result = await cli({})
    expect(result.code).toBe(1)
    expect(result.out).toContain('HTTP 502 (synthetic outage)')
    failApi = false
  })

  test('the CLI prints an explicit skip when the PR adds no migrations', async () => {
    const result = await cli({ HEAD_SHA: run(repo, ['rev-parse', 'main']) })
    expect(result.code).toBe(0)
    expect(result.out).toContain('SKIPPED: this PR adds no new drizzle migrations.')
  })

  test('the CLI fails when its configuration is missing', async () => {
    const result = await cli({ GITHUB_TOKEN: '' })
    expect(result.code).toBe(1)
    expect(result.out).toContain('::error::Migration number check is misconfigured: GITHUB_TOKEN is not set')
  })
})

describe('migration-numbers workflow', () => {
  const workflow = Bun.YAML.parse(readFileSync(join(import.meta.dir, 'workflows/migration-numbers.yml'), 'utf8')) as any
  const job = workflow.jobs['migration-numbers']

  test('runs on PRs to main that touch drizzle migrations or the gate itself, including drafts becoming ready', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request'])
    expect(workflow.on.pull_request.branches).toEqual(['main'])
    expect(workflow.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened', 'ready_for_review'])
    expect(workflow.on.pull_request.paths).toEqual([
      'apps/core/drizzle/**',
      '.github/migration-number-gate.ts',
      '.github/workflows/migration-numbers.yml',
    ])
  })

  test('is read-only and needs no stored secrets', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
    const text = readFileSync(join(import.meta.dir, 'workflows/migration-numbers.yml'), 'utf8')
    expect(text).not.toMatch(/secrets\s*(?:\.|\[)/)
    expect(text).not.toContain('pull_request_target')
  })

  test('fetches the current base branch and the PR head, then runs the gate', () => {
    const runs = job.steps.map((step: { run?: string }) => step.run ?? '').join('\n')
    expect(runs).toContain('+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}')
    expect(runs).toContain('"${HEAD_SHA}"')
    expect(runs).toContain('bun .github/migration-number-gate.ts check')
    const check = job.steps.find((step: { run?: string }) => step.run?.includes('migration-number-gate.ts check'))
    expect(check.env.BASE_REV).toBe('origin/${{ github.base_ref }}')
    expect(check.env.HEAD_SHA).toBe('${{ github.event.pull_request.head.sha }}')
  })
})
