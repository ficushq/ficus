import { posix as path } from 'node:path'
import type { CreateWorkStreamInput, WorktreeOwnership } from '@ficus/shared'

export class RepositorySetupError extends Error {}

export type RepositorySetupInput = Pick<
  CreateWorkStreamInput,
  'repository' | 'gitRemote' | 'worktree' | 'branch' | 'baseBranch'
>
export type RepositoryExec = (args: string[]) => Promise<string>

export type { WorktreeOwnership } from '@ficus/shared'

type RecordOwnership = (ownership: WorktreeOwnership) => unknown

/** Recognize resource identity, never credentials or an account selection. */
export function codeHostFromRemote(remote: string): { integration: string; repository: string } | undefined {
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      remote
    )
  return match ? { integration: 'github', repository: match[1] } : undefined
}

/** Runs Git in the squad runtime, not on the API host's potentially unrelated filesystem. */
export async function prepareRepository(
  exec: RepositoryExec,
  workspace: string,
  input: RepositorySetupInput,
  key: string,
  metadata: Record<string, unknown>,
  recordOwnership?: RecordOwnership,
  validateTarget?: (target: string, repository: string) => unknown
): Promise<Record<string, unknown>> {
  const physical = (dir: string) => exec(['sh', '-c', 'cd -- "$1" && pwd -P', 'tau-worktree', dir])
  const root = (await physical(workspace)).trim()
  const inside = (value: string) => value === root || value.startsWith(`${root}/`)
  const requestedRepo = path.resolve(root, input.repository!)
  if (!inside(requestedRepo)) throw new Error('Repository must be inside the squad workspace')
  const repo = (await physical(requestedRepo)).trim()
  if (!inside(repo)) throw new Error('Repository resolves outside the squad workspace')
  const git = (...args: string[]) => exec(['git', '-C', repo, ...args]).then((out) => out.trim())
  if ((await git('rev-parse', '--show-toplevel')) !== repo)
    throw new Error('Repository must point to a Git checkout root')
  const common = (await physical(await git('rev-parse', '--path-format=absolute', '--git-common-dir'))).trim()
  if (!inside(common)) throw new Error('Repository Git storage resolves outside the squad workspace')
  const remote = input.gitRemote ?? 'origin'
  if (!/^[\w][\w.-]*$/.test(remote)) throw new Error('Invalid Git remote name')
  const remotes = (await git('remote', 'get-url', '--push', '--all', remote)).split('\n')
  if (remotes.length !== 1) throw new Error('Choose a Git remote with exactly one push URL')
  const detected = codeHostFromRemote(remotes[0])
  const fetchIdentity = codeHostFromRemote(await git('remote', 'get-url', remote))
  if (detected && fetchIdentity && detected.repository.toLowerCase() !== fetchIdentity.repository.toLowerCase())
    throw new Error('Remote fetch and push repositories differ; select a remote targeting one repository')
  const explicit = metadata.codeHost as { integration?: string; repository?: string } | undefined
  if (
    explicit &&
    detected &&
    (explicit.integration !== detected.integration ||
      explicit.repository?.toLowerCase() !== detected.repository.toLowerCase())
  ) {
    throw new Error('Code-host metadata does not match the selected Git remote')
  }
  let base = input.baseBranch
  if (!base) {
    try {
      const head = await git('symbolic-ref', `refs/remotes/${remote}/HEAD`)
      base = head.slice(`refs/remotes/${remote}/`.length)
    } catch {
      throw new Error('Remote default branch is unknown; provide baseBranch / --base-branch')
    }
  }
  await git('check-ref-format', `refs/heads/${base}`)
  const branch = input.branch ?? `work/${key}`
  await git('check-ref-format', '--branch', branch)
  if (branch === base || branch.startsWith('-')) throw new Error('Worktree branch must differ from the base branch')
  let baseRef = `refs/remotes/${remote}/${base}`
  try {
    await git('rev-parse', '--verify', `${baseRef}^{commit}`)
  } catch {
    baseRef = `refs/heads/${base}`
    await git('rev-parse', '--verify', `${baseRef}^{commit}`)
  }
  const requestedTarget = path.resolve(root, input.worktree ?? `worktrees/${key}`)
  if (!inside(requestedTarget) || requestedTarget === root)
    throw new Error('Worktree must be inside the squad workspace')
  const pathExists = async (value: string) =>
    (await exec(['sh', '-c', 'if [ -e "$1" ] || [ -L "$1" ]; then printf yes; fi', 'tau-worktree', value])) === 'yes'
  // Canonicalize the closest existing ancestor before creating any parent dirs.
  let ancestor = path.dirname(requestedTarget)
  const missing: string[] = []
  while (!(await pathExists(ancestor))) {
    if (!inside(ancestor) || ancestor === root) throw new Error('Worktree parent is unavailable')
    missing.unshift(path.basename(ancestor))
    ancestor = path.dirname(ancestor)
  }
  const physicalAncestor = (await physical(ancestor)).trim()
  if (!inside(physicalAncestor)) throw new Error('Worktree parent resolves outside the squad workspace')
  const parent = path.join(physicalAncestor, ...missing)
  const target = path.join(parent, path.basename(requestedTarget))
  await validateTarget?.(target, repo)
  if (target === repo || target === common || target.startsWith(`${common}/`))
    throw new Error('Worktree must be separate from the source checkout and its Git storage')
  if (target.startsWith(`${repo}/`)) {
    try {
      await git('check-ignore', '-q', '--', target)
    } catch {
      throw new Error(
        'A worktree inside the repository must be Git-ignored; choose an ignored directory or a sibling path'
      )
    }
  }
  if (missing.length) await exec(['mkdir', '-p', parent])
  // Test existence without treating an invalid checkout as permission to replace it.
  const exists = await pathExists(target)
  if (exists) {
    if ((await physical(target)).trim() !== target) throw new Error('Worktree path must not be a symlink')
    const at = (...args: string[]) => exec(['git', '-C', target, ...args]).then((out) => out.trim())
    if (
      (await at('rev-parse', '--show-toplevel')) !== target ||
      (await at('rev-parse', '--path-format=absolute', '--git-common-dir')) !== common ||
      (await at('symbolic-ref', '--short', 'HEAD')) !== branch
    ) {
      throw new Error('Existing worktree must belong to this repository and requested branch')
    }
  } else {
    // Never reset a pre-existing branch or overwrite another checkout.
    let branchExists = false
    try {
      await git('show-ref', '--verify', `refs/heads/${branch}`)
      branchExists = true
    } catch {
      /* New branch. */
    }
    await git('worktree', 'add', ...(branchExists ? [] : ['-b', branch]), '--', target, branchExists ? branch : baseRef)
    if (recordOwnership) {
      const gitDirectory = (
        await physical((await exec(['git', '-C', target, 'rev-parse', '--path-format=absolute', '--git-dir'])).trim())
      ).trim()
      if (gitDirectory === common || !gitDirectory.startsWith(`${common}/worktrees/`))
        throw new Error('Created worktree has unexpected Git storage; ownership not recorded')
      const directoryIdentity = (
        await exec([
          'bun',
          '-e',
          'const s = require("node:fs").lstatSync(process.argv[1], {bigint:true}); if (!s.isDirectory() || s.isSymbolicLink()) process.exit(1); console.log(`${s.dev}:${s.ino}`)',
          target,
        ])
      ).trim()
      if (!/^\d+:\d+$/.test(directoryIdentity)) throw new Error('Could not identify created worktree')
      await recordOwnership({
        workspace: root,
        repository: repo,
        commonDirectory: common,
        gitDirectory,
        worktree: target,
        directoryIdentity,
        branch,
      })
    }
  }
  return {
    ...metadata,
    ...(!explicit && detected ? { codeHost: detected } : {}),
    git: { ...((metadata.git as object) ?? {}), repository: repo, remote, worktree: target, branch, baseBranch: base },
  }
}

export async function setupWorkStreamRepository(
  squadId: string,
  input: RepositorySetupInput,
  key: string,
  metadata: Record<string, unknown>,
  recordOwnership?: RecordOwnership
) {
  const { ensureSquadSandbox } = await import('../sandbox/ensure')
  const { getSandboxManager } = await import('../sandbox/factory')
  const { Squad } = await import('../../entities/Squad')
  const workspace = await ensureSquadSandbox(squadId)
  const manager = getSandboxManager()
  try {
    return await prepareRepository(
      async (args) => (await manager.exec(Squad.getSandboxId(squadId), args)).toString(),
      workspace,
      input,
      key,
      metadata,
      recordOwnership,
      async (target, repository) => {
        const { assertRepositoryTargetAvailable } = await import('./worktree-cleanup-store')
        await assertRepositoryTargetAvailable(squadId, key, target, repository)
      }
    )
  } catch (error) {
    throw new RepositorySetupError(`Repository setup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
