import { executedCommands } from './shell-commands'

/** Narrow read-only facts about the fictional repository, not a shell emulator. */
export const FIXTURE_WORK_STREAM_ID = '3f6c2d1e-8a4b-4c7d-9e2f-1a2b3c4d5e6f'
export const FIXTURE_WORKTREE = `/home/box_e49af02f8b45/workspace/worktrees/${FIXTURE_WORK_STREAM_ID}`
export const FIXTURE_BRANCH = `work/${FIXTURE_WORK_STREAM_ID}`
export const FIXTURE_HEAD = '4f1c2ab9d3e5f60718293a4b5c6d7e8f90a1b2c3'
const workspace = '/home/box_e49af02f8b45/workspace'

export interface FixtureRepository {
  head: string
  title: string
  files: Readonly<Record<string, string>>
}

const slotRepository: FixtureRepository = {
  head: FIXTURE_HEAD,
  title: 'Retry slot grants after a host budget change',
  files: {
    'apps/core/src/services/slots/host-budget.ts': 'export function retrySlotGrants() {}',
    'apps/core/src/services/slots/host-budget.test.ts': 'test("retries grants", () => {})',
  },
}

/**
 * Narrow read-only views of a declared fictional repository, not a shell emulator. Each call starts
 * in the shared workspace; cd and git -C scope subsequent queries within that call. Missing files
 * and mismatched revisions never return the claimed artifact. Unsupported commands fall through.
 */
export function fixtureDiscovery(source: string, repository: FixtureRepository = slotRepository): string | undefined {
  let cwd = workspace
  const facts: string[] = []
  const pathOf = (path: string) => {
    if (path.startsWith('/')) return path.replace(/\/$/, '')
    return path === '.' ? cwd : `${cwd}/${path.replace(/^\.\//, '').replace(/\/$/, '')}`
  }
  const relative = (path: string) => {
    const absolute = pathOf(path)
    return absolute === FIXTURE_WORKTREE
      ? ''
      : absolute.startsWith(`${FIXTURE_WORKTREE}/`)
        ? absolute.slice(FIXTURE_WORKTREE.length + 1)
        : undefined
  }
  const files = Object.keys(repository.files)
  const matches = (pattern: string, value: string) =>
    new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`
    ).test(value)
  for (const argv of executedCommands(source)) {
    if (argv[0] === 'cd' && argv[1]) {
      cwd = pathOf(argv[1])
      continue
    }
    if (argv[0] === 'pwd' && argv.length === 1 && [workspace, FIXTURE_WORKTREE].includes(cwd)) {
      facts.push(cwd)
      continue
    }
    const git = [...argv]
    if (git[0] === 'git') {
      let root = cwd
      if (git[1] === '-C') {
        root = pathOf(git[2]!)
        git.splice(1, 2)
      }
      if (root !== FIXTURE_WORKTREE) continue
      const op = git[1]
      if (op === 'branch' && git.includes('--show-current')) facts.push(FIXTURE_BRANCH)
      else if (op === 'remote' && (git.includes('-v') || git[2] === 'get-url'))
        facts.push(
          git[2] === 'get-url'
            ? 'https://github.com/ficushq/ficus.git'
            : 'origin https://github.com/ficushq/ficus.git (fetch)'
        )
      else if (op === 'symbolic-ref' && git[2] === 'refs/remotes/origin/HEAD') facts.push('refs/remotes/origin/main')
      else if (op === 'rev-parse') {
        if (git.includes('HEAD')) facts.push(repository.head)
        else if (git.includes('--show-toplevel')) facts.push(FIXTURE_WORKTREE)
        else if (git.includes('--git-common-dir')) facts.push(`${workspace}/ficus/.git`)
      } else if (op === 'status' || op === 'diff') facts.push('')
      else if (op === 'log') facts.push(`${repository.head.slice(0, 8)} ${repository.title}`)
      else if (op === 'ls-files') facts.push(files.join('\n'))
      else if (op === 'show') {
        const ref = git.slice(2).find((word) => !word.startsWith('-') && !/^\d?>/.test(word)) ?? 'HEAD'
        const [revision, file] = ref.split(':')
        if (revision !== 'HEAD' && !repository.head.startsWith(revision!))
          facts.push(`fatal: invalid object name '${revision}'`)
        else if (file) facts.push(repository.files[file] ?? `fatal: path '${file}' does not exist in '${revision}'`)
        else
          facts.push(
            `commit ${repository.head}\n${repository.title}\n${files.map((path) => ` ${path} | changed`).join('\n')}`
          )
      }
      continue
    }
    if (argv[0] === 'ls') {
      const paths = argv.slice(1).filter((word) => !word.startsWith('-') && !/^\d?>/.test(word))
      for (const raw of paths.length ? paths : ['.']) {
        const path = pathOf(raw)
        if (path === workspace) facts.push('worktrees')
        else if (path === `${workspace}/worktrees`) facts.push(FIXTURE_WORK_STREAM_ID)
        else {
          const dir = relative(raw)
          if (dir === undefined) continue
          if (repository.files[dir] !== undefined) {
            facts.push(dir.split('/').at(-1)!)
            continue
          }
          const prefix = dir ? `${dir}/` : ''
          const children = files
            .filter((file) => file.startsWith(prefix))
            .map((file) => file.slice(prefix.length).split('/')[0]!)
          if (dir === '') children.push('config', 'docs', 'package.json', 'bun.lock')
          if (children.length) facts.push([...new Set(children)].join('\n'))
        }
      }
    } else if (argv[0] === 'find') {
      const root = argv[1] ? pathOf(argv[1]) : cwd
      if (![workspace, `${workspace}/worktrees`, FIXTURE_WORKTREE].includes(root)) continue
      const nameAt = argv.findIndex((word) => word === '-name' || word === '-iname')
      if (nameAt >= 0 && argv[nameAt + 1])
        facts.push(
          files
            .filter((file) => matches(argv[nameAt + 1]!, file.split('/').at(-1)!))
            .map((file) => `${FIXTURE_WORKTREE}/${file}`)
            .join('\n')
        )
    } else if (argv[0] === 'cat') {
      for (const raw of argv.slice(1).filter((word) => !word.startsWith('-') && !/^\d?>/.test(word))) {
        const file = relative(raw)
        if (file !== undefined) facts.push(repository.files[file] ?? `cat: ${raw}: No such file or directory`)
      }
    } else if (['grep', 'rg'].includes(argv[0]!) && cwd === FIXTURE_WORKTREE) {
      // The recorded probes use these literal alternatives. Do not turn arbitrary searches into hits.
      const pattern = argv.find((word) => /Memory System|map\.md|memory section|assembleSquad/.test(word))
      if (!pattern) continue
      const alternatives = pattern.split(/\\?\|/)
      const scopes = argv.slice(argv.indexOf(pattern) + 1).filter((word) => !word.startsWith('-') && !/^\d/.test(word))
      const paths = scopes.length ? scopes.map(relative) : ['']
      for (const [file, text] of Object.entries(repository.files)) {
        if (!paths.some((path) => path !== undefined && (path === '' || file === path || file.startsWith(`${path}/`))))
          continue
        for (const [index, line] of text.split('\n').entries())
          if (alternatives.some((part) => line.includes(part))) facts.push(`${file}:${index + 1}:${line}`)
      }
    }
  }
  return facts.length ? facts.join('\n') : undefined
}

/** Only PR inspection gets PR JSON. Repository settings requests must not impersonate it. */
export function isFixturePrInspection(command: string): boolean {
  return executedCommands(command).some((argv) => {
    if (argv[0] !== 'gh') return false
    if (argv[1] === 'pr' && ['view', 'status'].includes(argv[2] ?? '')) return true
    return (
      argv[1] === 'api' &&
      (argv.some((word) => /^\/?repos\/ficushq\/ficus\/pulls\/950(?:[/?]|$)/.test(word)) ||
        (argv[2] === 'graphql' && argv.some((word) => /pullRequest\s*\(/.test(word))))
    )
  })
}

/** The fictional repository allows only squash, and requires these three checks and one review. */
export function fixtureRepositorySettings(source: string): string | undefined {
  const results = executedCommands(source)
    .filter((argv) => argv[0] === 'gh')
    .map((argv) => repositorySettings(argv.join(' ')))
    .filter((value) => value !== undefined)
  return results.length ? results.join('\n') : undefined
}

function repositorySettings(command: string): string | undefined {
  const settings = {
    nameWithOwner: 'ficushq/ficus',
    squashMergeAllowed: true,
    mergeCommitAllowed: false,
    rebaseMergeAllowed: false,
    autoMergeAllowed: true,
    viewerDefaultMergeMethod: 'SQUASH',
  }
  if (/\bgh repo view\s+ficushq\/ficus\b/.test(command)) return JSON.stringify(settings)
  if (
    /\bgh api graphql\b/.test(command) &&
    /owner:\s*\\?"ficushq\\?"/.test(command) &&
    /name:\s*\\?"ficus\\?"/.test(command) &&
    !/pullRequest\s*\(/.test(command)
  )
    return JSON.stringify({ data: { repository: settings } })
  if (/\bgh api\s+\/?repos\/ficushq\/ficus(?:\s|$)/.test(command))
    return JSON.stringify({
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_auto_merge: true,
    })
  if (
    /\bgh api\s+\/?repos\/ficushq\/ficus\/branches\/main\/protection(?:\s|\/required_status_checks\b|$)/.test(command)
  )
    return JSON.stringify({ contexts: ['core-unit', 'core-integration', 'lint'], required_approving_review_count: 1 })
  if (/\bgh api\s+\/?repos\/ficushq\/ficus\/collaborators\/noahsaso\/permission(?:\s|$)/.test(command))
    return JSON.stringify({ permission: 'admin' })
  return undefined
}
