import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createStackingFixture,
  fixtureCommit as commit,
  fixtureGit as git,
  gitFixtureExec as exec,
  type StackingFixture,
} from '../../test-utils/git-stacking-fixture'
import { stackOntoDependencies } from './dependency-stacking'
import { GITHUB_FETCH_TOKEN_ENV, type RepositoryExec } from './repository-setup'

/**
 * Real Git, no database rows: the rules for moving a dependent's branch onto
 * its dependency's. Each case owns a temporary upstream, a squad checkout with
 * the dependent's worktree, and a clone that plays the dependency's author.
 */

let fixture: StackingFixture
let upstream: string
let repo: string
let author: string
let worktree: string
let baseCommit: string
const pushDependencyBranch = (branch: string, file: string, from?: string) =>
  fixture.pushDependencyBranch(branch, file, from)

const stack = (candidates: Array<{ id: string; branch: string }>, run: RepositoryExec = exec) =>
  stackOntoDependencies(
    { exec: run },
    { repository: repo, worktree, branch: 'work/dependent', remote: 'origin', baseCommit, candidates }
  )

beforeEach(async () => {
  fixture = await createStackingFixture()
  ;({ upstream, repo, author, worktree, baseCommit } = fixture)
})
afterEach(async () => {
  await fixture.cleanup()
})

test('moves a clean, never-started branch onto the dependency head and leaves the dependency untouched', async () => {
  const head = await pushDependencyBranch('work/dependency', 'dependency.txt')

  const decisions = await stack([{ id: 'dep', branch: 'work/dependency' }])

  expect(decisions.dep).toMatchObject({ mode: 'stacked', branch: 'work/dependency', headSha: head })
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(head)
  expect(await git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('work/dependent')
  expect(existsSync(join(worktree, 'dependency.txt'))).toBe(true)
  // The dependency's branch is exactly what its author pushed, and no fetch ref outlives the call.
  expect(await git(upstream, 'rev-parse', 'refs/heads/work/dependency')).toBe(head)
  expect(await git(repo, 'for-each-ref', 'refs/ficus/stacking')).toBe('')
})

test('a never-started branch provisioned from a newer base still stacks (it has no commits to lose)', async () => {
  const head = await pushDependencyBranch('work/dependency', 'dependency.txt')
  // The base moved on after the dependency branched; the dependent was provisioned from the newer base.
  await git(author, 'checkout', 'main')
  const newerBase = await commit(author, 'later.txt', 'later base work')
  await git(author, 'push', 'origin', 'main')
  await git(repo, 'fetch', 'origin')
  await git(worktree, 'reset', '--hard', newerBase)
  baseCommit = newerBase

  const decisions = await stack([{ id: 'dep', branch: 'work/dependency' }])

  expect(decisions.dep).toMatchObject({ mode: 'stacked', headSha: head })
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(head)
})

test('a branch that already has commits is left alone and the assignee is told to merge', async () => {
  const head = await pushDependencyBranch('work/dependency', 'dependency.txt')
  const own = await commit(worktree, 'own.txt', 'own work')

  const decisions = await stack([{ id: 'dep', branch: 'work/dependency' }])

  expect(decisions.dep).toMatchObject({
    mode: 'manual',
    branch: 'work/dependency',
    headSha: head,
    reason: 'the branch already has commits',
  })
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(own)
})

test('a dirty worktree is left alone, including untracked files', async () => {
  await pushDependencyBranch('work/dependency', 'dependency.txt')
  await writeFile(join(worktree, 'scratch.txt'), 'not committed\n')

  const decisions = await stack([{ id: 'dep', branch: 'work/dependency' }])

  expect(decisions.dep).toMatchObject({ mode: 'manual', reason: 'the worktree has uncommitted changes' })
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(baseCommit)
  expect(await Bun.file(join(worktree, 'scratch.txt')).text()).toBe('not committed\n')
})

test('a never-started branch that was already pushed is not moved sideways', async () => {
  await pushDependencyBranch('work/dependency', 'dependency.txt')
  await git(author, 'checkout', 'main')
  const newerBase = await commit(author, 'later.txt', 'later base work')
  await git(author, 'push', 'origin', 'main')
  await git(repo, 'fetch', 'origin')
  await git(worktree, 'reset', '--hard', newerBase)
  baseCommit = newerBase
  await git(worktree, 'push', 'origin', 'work/dependent')

  const decisions = await stack([{ id: 'dep', branch: 'work/dependency' }])

  expect(decisions.dep).toMatchObject({ mode: 'manual', reason: 'the branch was already pushed' })
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(newerBase)
})

test('with several dependencies, stacks on the one that contains the others', async () => {
  const first = await pushDependencyBranch('work/first', 'first.txt')
  const second = await pushDependencyBranch('work/second', 'second.txt', 'work/first')

  const decisions = await stack([
    { id: 'first', branch: 'work/first' },
    { id: 'second', branch: 'work/second' },
  ])

  expect(decisions.second).toMatchObject({ mode: 'stacked', headSha: second })
  expect(decisions.first).toMatchObject({ mode: 'included', headSha: first })
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(second)
})

test('with several dependencies that do not contain one another, rewrites nothing and names each branch', async () => {
  const first = await pushDependencyBranch('work/first', 'first.txt')
  const second = await pushDependencyBranch('work/second', 'second.txt')

  const decisions = await stack([
    { id: 'first', branch: 'work/first' },
    { id: 'second', branch: 'work/second' },
  ])

  expect(decisions.first).toMatchObject({ mode: 'manual', branch: 'work/first', headSha: first })
  expect(decisions.second).toMatchObject({ mode: 'manual', branch: 'work/second', headSha: second })
  expect(decisions.first!.mode === 'manual' && decisions.first!.reason).toContain('do not contain one another')
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(baseCommit)
})

test('a dependency branch that cannot be fetched is a manual merge, without leaking transport detail', async () => {
  const decisions = await stack([{ id: 'dep', branch: 'work/never-pushed' }])

  expect(decisions.dep).toMatchObject({ mode: 'manual', branch: 'work/never-pushed' })
  expect(decisions.dep!.mode === 'manual' && decisions.dep!.reason).toBe(
    'could not fetch work/never-pushed from origin'
  )
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(baseCommit)
})

test('the squad credential reaches the fetch only through its environment', async () => {
  const head = await pushDependencyBranch('work/dependency', 'dependency.txt')
  const token = 'ghs_stackingfixturetoken'
  const calls: Array<{ args: string[]; env?: Record<string, string> }> = []
  // The fixture upstream is a local path; report a GitHub HTTPS URL so the credential path engages.
  const recording: RepositoryExec = async (args, options) => {
    calls.push({ args, env: options?.env })
    if (args.includes('get-url')) return 'https://github.com/example/repo.git\n'
    return exec(args, options)
  }

  const decisions = await stackOntoDependencies(
    { exec: recording, resolveGitHubToken: async () => token },
    {
      repository: repo,
      worktree,
      branch: 'work/dependent',
      remote: 'origin',
      baseCommit,
      candidates: [{ id: 'dep', branch: 'work/dependency' }],
    }
  )

  expect(decisions.dep).toMatchObject({ mode: 'stacked', headSha: head })
  expect(JSON.stringify(decisions)).not.toContain(token)
  for (const call of calls) expect(call.args.join(' ')).not.toContain(token)
  const fetch = calls.find((call) => call.args.includes('fetch'))!
  expect(fetch.env?.[GITHUB_FETCH_TOKEN_ENV]).toBe(token)
  expect(calls.filter((call) => call.env?.[GITHUB_FETCH_TOKEN_ENV]).length).toBe(1)
})
