import { describe, test, expect } from 'bun:test'
import {
  findOrphanProjects,
  listTestDbContainers,
  listLiveWorktreePaths,
  projectNameForPath,
  sweepOrphanTestDbs,
} from './test-db-sweep'

const ROOT = '/repo/main'
const WT_A = '/repo/main/.claude/worktrees/a'
const WT_GONE = '/repo/main/.claude/worktrees/deleted'

describe('findOrphanProjects', () => {
  test('labeled container whose path exists is kept; missing path is an orphan', () => {
    const orphans = findOrphanProjects({
      containers: [
        { project: projectNameForPath(WT_A), repoRoot: WT_A },
        { project: projectNameForPath(WT_GONE), repoRoot: WT_GONE },
      ],
      liveWorktreePaths: [ROOT, WT_A],
      currentProject: projectNameForPath(ROOT),
      pathExists: (p) => p !== WT_GONE,
    })
    expect(orphans).toEqual([projectNameForPath(WT_GONE)])
  })

  test('legacy (unlabeled) container is an orphan iff no live worktree hashes to it', () => {
    const orphans = findOrphanProjects({
      containers: [
        { project: projectNameForPath(WT_A), repoRoot: '' },
        { project: 'ficus-test-deadbeef', repoRoot: '' },
      ],
      liveWorktreePaths: [ROOT, WT_A],
      currentProject: projectNameForPath(ROOT),
      pathExists: () => true,
    })
    expect(orphans).toEqual(['ficus-test-deadbeef'])
  })

  test('the current project is never an orphan, even unlabeled with no worktree match', () => {
    const current = projectNameForPath('/somewhere/odd')
    const orphans = findOrphanProjects({
      containers: [{ project: current, repoRoot: '' }],
      liveWorktreePaths: [],
      currentProject: current,
      pathExists: () => false,
    })
    expect(orphans).toEqual([])
  })

  test('non ficus-test projects are ignored', () => {
    const orphans = findOrphanProjects({
      containers: [{ project: 'ficus-management_postgres', repoRoot: '' }],
      liveWorktreePaths: [ROOT],
      currentProject: projectNameForPath(ROOT),
      pathExists: () => false,
    })
    expect(orphans).toEqual([])
  })
})

describe('docker/git output parsing', () => {
  test('listTestDbContainers parses project + label, dedupes, drops non-matching', () => {
    const exec = () =>
      [
        `ficus-test-aaaaaaaa\t${WT_A}`,
        'ficus-test-aaaaaaaa\t' + WT_A, // duplicate service container
        'ficus-test-bbbbbbbb\t', // legacy: no label
        'unrelated-project\t/x',
        '',
      ].join('\n')
    expect(listTestDbContainers(exec)).toEqual([
      { project: 'ficus-test-aaaaaaaa', repoRoot: WT_A },
      { project: 'ficus-test-bbbbbbbb', repoRoot: '' },
    ])
  })

  test('listLiveWorktreePaths parses porcelain output', () => {
    const exec = () => `worktree ${ROOT}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${WT_A}\nHEAD def\n`
    expect(listLiveWorktreePaths(exec, ROOT)).toEqual([ROOT, WT_A])
  })
})

describe('sweepOrphanTestDbs', () => {
  test('tears down exactly the orphans and returns them; never throws on exec failure', () => {
    const downs: string[] = []
    const exec = (cmd: string[]) => {
      if (cmd[0] === 'docker' && cmd[1] === 'ps') {
        return `${projectNameForPath(WT_GONE)}\t${WT_GONE}\n${projectNameForPath(ROOT)}\t${ROOT}\n`
      }
      if (cmd[0] === 'git') return `worktree ${ROOT}\n`
      if (cmd[0] === 'docker' && cmd[1] === 'compose') {
        downs.push(cmd[cmd.indexOf('-p') + 1])
        return ''
      }
      return ''
    }
    const removed = sweepOrphanTestDbs({
      composeFile: '/repo/main/docker-compose.test.yml',
      currentRepoRoot: ROOT,
      deps: { exec },
    })
    expect(removed).toEqual([projectNameForPath(WT_GONE)])
    expect(downs).toEqual([projectNameForPath(WT_GONE)])

    const throwing = () => {
      throw new Error('docker exploded')
    }
    expect(sweepOrphanTestDbs({ composeFile: 'x', currentRepoRoot: ROOT, deps: { exec: throwing } })).toEqual([])
  })
})
