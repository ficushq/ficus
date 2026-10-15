import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Command } from 'commander'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiPost } from '../client'
import { output, outputError } from '../output'
import {
  ASSET_COMMIT_MARKER,
  GitHubError,
  type GitHubRequest,
  composeBody,
  createGitHubRequest,
  parseAttachmentArg,
  parseRepo,
  pruneAssets,
  registerPrCommands,
  uploadAssets,
} from './pr'

type AnyMock = ReturnType<typeof mock>
const REPO = 'acme/app'
const NOW = new Date('2026-10-15T00:00:00Z')

interface FakeIssue {
  state: 'open' | 'closed'
  closed_at: string | null
  body: string | null
}

/** In-memory GitHub: refs, commits, trees, blobs, issues and comments of one repo. */
function fakeGitHub(issues: Record<number, FakeIssue> = { 7: { state: 'open', closed_at: null, body: 'Desc' } }) {
  const refs = new Map<string, string>()
  const commits = new Map<string, { message: string; tree: string; parents: string[] }>()
  const trees = new Map<string, Record<string, string>>()
  const blobs = new Map<string, string>()
  const comments: { number: number; body: string }[] = []
  const calls: string[] = []
  let id = 0
  const next = (kind: string) => `${kind}${++id}`
  const notFound = () => new GitHubError(404, 'Not Found')

  const github: GitHubRequest = async <T>(method: string, path: string, body?: any): Promise<T> => {
    calls.push(`${method} ${path}`)
    const prefix = `/repos/${REPO}`
    if (!path.startsWith(prefix)) throw new Error(`request outside ${REPO}: ${path}`)
    const rest = path.slice(prefix.length)
    let m: RegExpExecArray | null
    if (method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = refs.get(m[1]!)
      if (!sha) throw notFound()
      return { object: { sha } } as T
    }
    if (method === 'GET' && (m = /^\/git\/matching-refs\/heads\/(.+)$/.exec(rest)))
      return [...refs]
        .filter(([name]) => name.startsWith(m![1]!))
        .map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { sha } })) as T
    if (method === 'GET' && (m = /^\/git\/commits\/(.+)$/.exec(rest))) {
      const commit = commits.get(m[1]!)
      if (!commit) throw notFound()
      return { sha: m[1], message: commit.message, tree: { sha: commit.tree } } as T
    }
    if (method === 'POST' && rest === '/git/blobs') {
      const sha = next('blob')
      blobs.set(sha, body.content)
      return { sha } as T
    }
    if (method === 'POST' && rest === '/git/trees') {
      const sha = next('tree')
      const base = body.base_tree ? trees.get(body.base_tree)! : {}
      trees.set(sha, { ...base, ...Object.fromEntries(body.tree.map((e: any) => [e.path, e.sha])) })
      return { sha } as T
    }
    if (method === 'POST' && rest === '/git/commits') {
      const sha = next('commit')
      commits.set(sha, { message: body.message, tree: body.tree, parents: body.parents })
      return { sha } as T
    }
    if (method === 'POST' && rest === '/git/refs') {
      refs.set(body.ref.replace('refs/heads/', ''), body.sha)
      return {} as T
    }
    if ((method === 'PATCH' || method === 'DELETE') && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      if (!refs.has(m[1]!)) throw notFound()
      if (method === 'DELETE') refs.delete(m[1]!)
      else refs.set(m[1]!, body.sha)
      return undefined as T
    }
    if ((m = /^\/issues\/(\d+)$/.exec(rest))) {
      const issue = issues[Number(m[1])]
      if (!issue) throw notFound()
      if (method === 'PATCH') issue.body = body.body
      return { number: Number(m[1]), ...issue, html_url: `https://github.com/${REPO}/pull/${m[1]}` } as T
    }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      comments.push({ number: Number(m[1]), body: body.body })
      return { html_url: `https://github.com/${REPO}/pull/${m[1]}#issuecomment-${comments.length}` } as T
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
  /** A branch someone pushed by hand: its head commit lacks the marker. */
  const pushForeign = (branch: string) => {
    const sha = next('commit')
    commits.set(sha, { message: 'PR screenshots (not for merge)', tree: next('tree'), parents: [] })
    refs.set(branch, sha)
  }
  return { github, refs, commits, trees, blobs, comments, calls, issues, pushForeign }
}

let dir: string
let gh: ReturnType<typeof fakeGitHub>
let originRepo: AnyMock

async function run(...args: string[]) {
  const program = new Command().exitOverride()
  registerPrCommands(program, {
    github: async () => gh.github,
    originRepo: originRepo as unknown as () => Promise<string>,
    readBodyFile: async () => 'from file ![shot](./after.png)',
    now: () => NOW,
  })
  await program.parseAsync(args, { from: 'user' })
}

function lastOutput(): any {
  const calls = (output as AnyMock).mock.calls
  return calls[calls.length - 1]?.[0]
}
function lastError(): string | undefined {
  const calls = (outputError as AnyMock).mock.calls
  return (calls[calls.length - 1]?.[0] as Error | undefined)?.message
}

beforeEach(async () => {
  ;(output as AnyMock).mockClear()
  ;(outputError as AnyMock).mockClear()
  ;(apiPost as AnyMock).mockClear()
  gh = fakeGitHub()
  originRepo = mock(async () => REPO)
  dir = await mkdtemp(join(tmpdir(), 'pr-attach-'))
  process.chdir(dir)
  await writeFile(join(dir, 'after.png'), 'PNGDATA')
  await writeFile(join(dir, 'before.png'), 'OLDPNG')
  await writeFile(join(dir, 'demo.mp4'), 'MP4')
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ficus pr attach', () => {
  test('commits files to an orphan pr-assets branch and comments with commit-pinned images', async () => {
    await run('pr', 'attach', '7', './before.png#Before', 'after.png#After', '--body', 'Before / after')
    expect(lastError()).toBeUndefined()
    const result = lastOutput()
    const head = gh.refs.get('pr-assets/7')!
    expect(result.commit).toBe(head)
    const commit = gh.commits.get(head)!
    expect(commit.parents).toEqual([])
    expect(commit.message.startsWith(ASSET_COMMIT_MARKER)).toBe(true)
    expect(Object.keys(gh.trees.get(commit.tree)!)).toEqual(['before.png', 'after.png'])
    expect([...gh.blobs.values()]).toEqual([
      Buffer.from('OLDPNG').toString('base64'),
      Buffer.from('PNGDATA').toString('base64'),
    ])
    expect(gh.comments).toEqual([
      {
        number: 7,
        body: [
          'Before / after',
          '',
          `![Before](https://github.com/${REPO}/blob/${head}/before.png?raw=true)`,
          `![After](https://github.com/${REPO}/blob/${head}/after.png?raw=true)`,
        ].join('\n'),
      },
    ])
    expect(result.posted).toContain('#issuecomment-1')
    // Only the repository's own branch is written; nothing outside pr-assets/7.
    expect([...gh.refs.keys()]).toEqual(['pr-assets/7'])
  })

  test('a second upload builds on the branch and keeps earlier links valid', async () => {
    await run('pr', 'attach', '7', 'before.png', '--no-comment')
    const first = gh.refs.get('pr-assets/7')!
    await run('pr', 'attach', '7', 'after.png', '--no-comment')
    const second = gh.refs.get('pr-assets/7')!
    expect(second).not.toBe(first)
    expect(gh.commits.get(second)!.parents).toEqual([first])
    expect(Object.keys(gh.trees.get(gh.commits.get(second)!.tree)!).sort()).toEqual(['after.png', 'before.png'])
    expect(gh.calls).toContain(`PATCH /repos/${REPO}/git/refs/heads/pr-assets/7`)
    expect(gh.comments).toEqual([])
    expect(lastOutput().markdown).toBe(`![after.png](https://github.com/${REPO}/blob/${second}/after.png?raw=true)`)
  })

  test('replaces body references, links non-images and can append to the description', async () => {
    await run('pr', 'attach', '7', 'after.png', 'demo.mp4', '--body-file', 'body.md', '--edit-body')
    const head = gh.refs.get('pr-assets/7')!
    expect(gh.comments).toEqual([])
    expect(gh.issues[7]!.body).toBe(
      [
        'Desc',
        '',
        `from file ![shot](https://github.com/${REPO}/blob/${head}/after.png?raw=true)`,
        '',
        `[demo.mp4](https://github.com/${REPO}/blob/${head}/demo.mp4?raw=true)`,
      ].join('\n')
    )
  })

  test('uses the origin remote unless --repo is given', async () => {
    await run('pr', 'attach', '7', 'after.png', '--no-comment')
    expect(originRepo).toHaveBeenCalledTimes(1)
    await run('pr', 'attach', '7', 'after.png', '--no-comment', '--repo', 'https://github.com/acme/app.git')
    expect(originRepo).toHaveBeenCalledTimes(1)
  })

  test('refuses a pr-assets branch it did not create', async () => {
    gh.pushForeign('pr-assets/7')
    const before = gh.refs.get('pr-assets/7')
    await run('pr', 'attach', '7', 'after.png')
    expect(lastError()).toContain('was not created by ficus pr attach')
    expect(gh.refs.get('pr-assets/7')).toBe(before)
    expect(gh.blobs.size).toBe(0)
  })

  test('checks the files and the PR before writing anything', async () => {
    await run('pr', 'attach', '7', 'missing.png')
    expect(lastError()).toContain('Not a file')
    await writeFile(join(dir, 'empty.png'), '')
    await run('pr', 'attach', '7', 'empty.png')
    expect(lastError()).toContain('empty')
    await run('pr', 'attach', '7', 'after.png', `${dir}/after.png`)
    expect(lastError()).toContain('both be stored as after.png')
    await run('pr', 'attach', '99', 'after.png')
    expect(lastError()).toContain('No pull request or issue 99 in acme/app')
    await run('pr', 'attach', '7', 'after.png', '--no-comment', '--body', 'x')
    expect(lastError()).toContain('--no-comment')
    await run('pr', 'attach', 'abc', 'after.png')
    expect(lastError()).toContain('Not a pull request or issue number')
    expect(gh.refs.size).toBe(0)
    expect(gh.blobs.size).toBe(0)
  })
})

describe('pruning', () => {
  async function seed() {
    gh.issues[1] = { state: 'closed', closed_at: '2026-10-01T00:00:00Z', body: null }
    gh.issues[2] = { state: 'closed', closed_at: '2026-10-14T00:00:00Z', body: null }
    gh.issues[3] = { state: 'closed', closed_at: '2026-10-01T00:00:00Z', body: null }
    const file = { source: 'a.png', name: 'a.png', alt: 'a', content: new Uint8Array([1]) }
    for (const n of [1, 2, 7]) await uploadAssets(gh.github, REPO, n, [file])
    gh.pushForeign('pr-assets/3')
    gh.pushForeign('pr-assets/feature')
    gh.pushForeign('main')
  }

  test('deletes only marker branches of PRs closed past the grace period', async () => {
    await seed()
    const result = await pruneAssets(gh.github, REPO, { graceDays: 7, now: NOW })
    expect(result.deleted).toEqual(['pr-assets/1'])
    expect(result.skipped).toEqual([
      { branch: 'pr-assets/2', reason: 'closed less than 7 days ago' },
      { branch: 'pr-assets/7', reason: 'still open' },
      { branch: 'pr-assets/3', reason: 'not created by ficus pr attach' },
      { branch: 'pr-assets/feature', reason: 'not a pr-assets/<number> branch' },
    ])
    expect([...gh.refs.keys()].sort()).toEqual([
      'main',
      'pr-assets/2',
      'pr-assets/3',
      'pr-assets/7',
      'pr-assets/feature',
    ])
    expect(gh.calls.filter((call) => call.startsWith('DELETE'))).toEqual([
      `DELETE /repos/${REPO}/git/refs/heads/pr-assets/1`,
    ])
  })

  test('prune-assets command honours --number and --grace-days', async () => {
    await seed()
    await run('pr', 'prune-assets', '--number', '2', '--grace-days', '0')
    expect(lastOutput().deleted).toEqual(['pr-assets/2'])
    expect(gh.refs.has('pr-assets/1')).toBe(true)
  })

  test('attach prunes other stale asset branches, never the one it just wrote', async () => {
    gh.issues[1] = { state: 'closed', closed_at: '2026-10-01T00:00:00Z', body: null }
    await run('pr', 'attach', '1', 'after.png', '--no-comment')
    expect(lastOutput().pruned).toEqual([])
    expect(gh.refs.has('pr-assets/1')).toBe(true)
    await run('pr', 'attach', '7', 'after.png', '--no-comment')
    expect(lastOutput().pruned).toEqual(['pr-assets/1'])
    expect([...gh.refs.keys()]).toEqual(['pr-assets/7'])
  })
})

describe('credential handling', () => {
  test('the token is sent only as a bearer header to api.github.com', async () => {
    const fetcher = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const request = createGitHubRequest('ghs_secret', fetcher as unknown as typeof fetch)
    await request('POST', `/repos/${REPO}/git/blobs`, { content: 'x' })
    const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]!
    expect(url).toBe(`https://api.github.com/repos/${REPO}/git/blobs`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghs_secret')
    expect(String(init.body)).not.toContain('ghs_secret')
  })

  test('errors carry GitHub’s message, never the token', async () => {
    const fetcher = mock(async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }))
    const request = createGitHubRequest('ghs_secret', fetcher as unknown as typeof fetch)
    const error = (await request('GET', '/repos/a/b').catch((e) => e)) as GitHubError
    expect(error.status).toBe(401)
    expect(error.message).toBe('GitHub GET /repos/a/b failed (401): Bad credentials')
    expect(error.message).not.toContain('ghs_secret')
  })

  test('default client resolves the squad credential through the integration endpoint', async () => {
    ;(apiPost as AnyMock).mockResolvedValueOnce({ environment: {} })
    const program = new Command().exitOverride()
    registerPrCommands(program)
    await program.parseAsync(['pr', 'attach', '7', 'after.png', '--repo', REPO, '--squad', 'squad-1'], { from: 'user' })
    expect(apiPost).toHaveBeenCalledWith('/api/squads/squad-1/integrations/github/execute-environment', {})
    expect(lastError()).toBe('This squad has no GitHub integration credential')
  })
})

describe('parsing', () => {
  test('repositories', () => {
    expect(parseRepo('acme/app')).toBe('acme/app')
    expect(parseRepo('https://github.com/acme/app.git')).toBe('acme/app')
    expect(parseRepo('https://x-access-token@github.com/acme/app')).toBe('acme/app')
    expect(parseRepo('git@github.com:acme/app.git')).toBe('acme/app')
    expect(() => parseRepo('https://gitlab.com/acme/app')).toThrow('Not a github.com repository')
    expect(() => parseRepo('acme/../x')).toThrow()
  })

  test('alt text and body composition', () => {
    expect(parseAttachmentArg('./a.png#Hello world')).toEqual({ source: './a.png', alt: 'Hello world' })
    expect(parseAttachmentArg('a.png')).toEqual({ source: 'a.png' })
    const file = { source: 'a.png', name: 'a.png', alt: 'A', content: new Uint8Array() }
    const asset = { name: 'a.png', url: 'U', markdown: '![A](U)' }
    expect(composeBody('see ![x](./a.png) and [y](a.png)', [file], [asset])).toBe('see ![x](U) and [y](U)')
    expect(composeBody('', [file], [asset])).toBe('![A](U)')
  })
})
