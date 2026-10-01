import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  CodeHostingRegistry,
  type CodeHostingAdapter,
  type RecoveryTarget,
} from '../integrations/code-hosting/registry'
import { githubCodeHostingAdapter } from '../integrations/github/code-hosting'
import * as resolveConnection from '../integrations/github/resolve-connection'
import * as delivery from './worktree-cleanup-delivery'
const head = 'a'.repeat(40)
const metadata = {
  git: { repository: '/workspace/repo', branch: 'feature', baseBranch: 'main', remote: 'origin' },
  codeHost: { integration: 'github', repository: 'example/repo', changeRequest: { number: 42 } },
}

function fixture(
  overrides: {
    merged?: boolean
    headSha?: string
    remoteHead?: string | null
    remote?: string
    contains?: boolean
    baseBranch?: string
    headBranch?: string
  } = {}
) {
  const adapter: CodeHostingAdapter = {
    integration: 'github',
    validateRepository: () => true,
    changeRequest: async () => ({
      merged: overrides.merged ?? true,
      headSha: overrides.headSha ?? head,
      headBranch: overrides.headBranch ?? 'feature',
      baseBranch: overrides.baseBranch ?? 'main',
    }),
    changeRequestsByHead: async () => [],
    containsCommit: async () => overrides.contains ?? true,
    recoveryHead: async (_reference, _squadId, target) => {
      targets.push(target)
      return overrides.remoteHead === undefined ? head : overrides.remoteHead
    },
    subscriptions: () => [],
  }
  const calls: string[][] = []
  const targets: RecoveryTarget[] = []
  const exec = async (args: string[]) => {
    calls.push(args)
    if (args.includes('get-url')) return overrides.remote ?? 'git@github.com:example/repo.git\n'
    throw new Error('Unexpected command')
  }
  return { registry: new CodeHostingRegistry([adapter]), exec, calls, targets }
}

test('merged squash delivery uses the exact recoverable PR head, not local ancestry', async () => {
  expect(delivery.verifyWorktreeCleanupDelivery).toBeDefined()
  const f = fixture()
  expect(
    await delivery.verifyWorktreeCleanupDelivery(
      { squadId: 'squad', metadata, mode: 'pr-auto-merge', deliveredHead: head, repository: '/workspace/repo' },
      f.exec,
      f.registry
    )
  ).toBe(head)
  expect(f.targets).toEqual([{ changeRequest: 42 }])
  expect(f.calls.some((args) => args.includes('merge-base') || args.includes('ls-remote'))).toBe(false)
})

for (const defect of [
  'unmerged',
  'changed-head',
  'unrecoverable',
  'unavailable-recovery-ref',
  'wrong-remote',
  'missing-delivered-head',
  'wrong-base',
  'wrong-branch',
] as const) {
  test(`retains worktree when delivery is ${defect}`, async () => {
    expect(delivery.verifyWorktreeCleanupDelivery).toBeDefined()
    const f = fixture({
      merged: defect !== 'unmerged',
      baseBranch: defect === 'wrong-base' ? 'other' : 'main',
      headBranch: defect === 'wrong-branch' ? 'other' : 'feature',
      headSha: defect === 'changed-head' ? 'b'.repeat(40) : head,
      remoteHead: defect === 'unrecoverable' ? 'b'.repeat(40) : defect === 'unavailable-recovery-ref' ? null : head,
      remote: defect === 'wrong-remote' ? 'git@github.com:other/repo.git' : undefined,
    })
    await expect(
      delivery.verifyWorktreeCleanupDelivery(
        {
          squadId: 'squad',
          metadata,
          mode: 'pr-merge',
          deliveredHead: defect === 'missing-delivered-head' ? null : head,
          repository: '/workspace/repo',
        },
        f.exec,
        f.registry
      )
    ).rejects.toBeInstanceOf(delivery.WorktreeDeliveryUnprovenError)
  })
}

test('direct merge requires both live containment and remote base availability', async () => {
  expect(delivery.verifyWorktreeCleanupDelivery).toBeDefined()
  const f = fixture()
  expect(
    await delivery.verifyWorktreeCleanupDelivery(
      { squadId: 'squad', metadata, mode: 'direct-merge', deliveredHead: head, repository: '/workspace/repo' },
      f.exec,
      f.registry
    )
  ).toBe(head)
  expect(f.targets).toEqual([{ branch: 'main' }])
  const missing = fixture({ contains: false })
  await expect(
    delivery.verifyWorktreeCleanupDelivery(
      { squadId: 'squad', metadata, mode: 'direct-merge', deliveredHead: head, repository: '/workspace/repo' },
      missing.exec,
      missing.registry
    )
  ).rejects.toThrow()
})

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

/** A private repository: every API read 404s unless it carries the squad connection's token. */
function privateGitHub(token: string | undefined) {
  spies.push(
    spyOn(resolveConnection, 'resolveGitHubConnection').mockResolvedValue(
      (token ? { credential: { accessToken: token } } : undefined) as any
    )
  )
  const urls: string[] = []
  spies.push(
    spyOn(globalThis, 'fetch').mockImplementation((async (input: URL, init: RequestInit) => {
      const url = String(input)
      urls.push(url)
      if (new Headers(init.headers).get('authorization') !== 'Bearer private-token')
        return new Response('not found', { status: 404 })
      if (url === 'https://api.github.com/repos/example/repo/pulls/42')
        return Response.json({ merged: true, head: { ref: 'feature', sha: head }, base: { ref: 'main' } })
      if (url === 'https://api.github.com/repos/example/repo/git/ref/pull/42/head')
        return Response.json({ ref: 'refs/pull/42/head', object: { sha: head, type: 'commit' } })
      return new Response('not found', { status: 404 })
    }) as any)
  )
  const calls: string[][] = []
  const exec = async (args: string[]) => {
    calls.push(args)
    if (args.includes('get-url')) return 'https://github.com/example/repo.git\n'
    throw new Error('Unexpected command')
  }
  return { exec, calls, urls, registry: new CodeHostingRegistry([githubCodeHostingAdapter]) }
}

const privateInput = {
  squadId: 'squad',
  metadata,
  mode: 'pr-merge',
  deliveredHead: head,
  repository: '/workspace/repo',
}

test('a private repository is proven through the squad connection, never a git credential', async () => {
  const f = privateGitHub('private-token')
  expect(await delivery.verifyWorktreeCleanupDelivery(privateInput, f.exec, f.registry)).toBe(head)
  expect(f.urls).toContain('https://api.github.com/repos/example/repo/git/ref/pull/42/head')
  // Local git only reads remote identity; no network git call and no token in any argv.
  expect(f.calls.every((args) => args.includes('get-url'))).toBe(true)
  expect(JSON.stringify(f.calls)).not.toContain('private-token')
})

test('a private repository fails closed with a sanitized reason when the connection cannot read it', async () => {
  for (const token of [undefined, 'wrong-token']) {
    const f = privateGitHub(token)
    const error = await delivery.verifyWorktreeCleanupDelivery(privateInput, f.exec, f.registry).catch((e) => e)
    expect(error).toBeInstanceOf(delivery.WorktreeDeliveryUnprovenError)
    expect(error.message).toBe('Merged change request no longer proves this exact delivered head')
    expect(error.message).not.toContain('token')
    for (const spy of spies.splice(0)) spy.mockRestore()
  }
})

test('the GitHub recovery head requires the exact ref, a commit object and a full sha', async () => {
  const reference = { integration: 'github', repository: 'example/repo' }
  const answer = (body: unknown) => {
    for (const spy of spies.splice(0)) spy.mockRestore()
    spies.push(
      spyOn(resolveConnection, 'resolveGitHubConnection').mockResolvedValue({
        credential: { accessToken: 'private-token' },
      } as any)
    )
    const urls: string[] = []
    spies.push(
      spyOn(globalThis, 'fetch').mockImplementation((async (input: URL) => {
        urls.push(String(input))
        return Response.json(body)
      }) as any)
    )
    return urls
  }
  let urls = answer({ ref: 'refs/heads/release/v1', object: { sha: head, type: 'commit' } })
  expect(await githubCodeHostingAdapter.recoveryHead(reference, 'squad', { branch: 'release/v1' })).toBe(head)
  expect(urls).toEqual(['https://api.github.com/repos/example/repo/git/ref/heads/release/v1'])
  for (const body of [
    { ref: 'refs/heads/main-other', object: { sha: head, type: 'commit' } },
    { ref: 'refs/heads/main', object: { sha: head, type: 'tag' } },
    { ref: 'refs/heads/main', object: { sha: 'abc', type: 'commit' } },
    [{ ref: 'refs/heads/main', object: { sha: head, type: 'commit' } }],
  ]) {
    answer(body)
    expect(await githubCodeHostingAdapter.recoveryHead(reference, 'squad', { branch: 'main' })).toBeNull()
  }
  for (const target of [{ branch: '../main' }, { branch: 'a b' }, { branch: '' }, { changeRequest: 0 }]) {
    urls = answer({ ref: 'refs/heads/main', object: { sha: head, type: 'commit' } })
    expect(await githubCodeHostingAdapter.recoveryHead(reference, 'squad', target)).toBeNull()
    expect(urls).toEqual([])
  }
})
