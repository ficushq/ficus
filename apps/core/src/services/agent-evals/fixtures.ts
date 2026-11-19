/** Narrow read-only facts about the fictional repository, not a shell emulator. */
export const FIXTURE_WORK_STREAM_ID = '3f6c2d1e-8a4b-4c7d-9e2f-1a2b3c4d5e6f'
export const FIXTURE_WORKTREE = `/home/box_e49af02f8b45/workspace/worktrees/${FIXTURE_WORK_STREAM_ID}`
export const FIXTURE_BRANCH = `work/${FIXTURE_WORK_STREAM_ID}`
export const FIXTURE_HEAD = '4f1c2ab9d3e5f60718293a4b5c6d7e8f90a1b2c3'
const workspace = '/home/box_e49af02f8b45/workspace'

/**
 * Answer discovery only for the fixture tree (or the tool's known initial workspace). Unknown
 * paths/commands remain unscripted. Scenario-specific negative facts take priority in the caller.
 * Combined discovery calls get all their known facts, not just whichever regex matched first.
 */
export function fixtureDiscovery(command: string): string | undefined {
  const tree = command.includes(FIXTURE_WORKTREE) || command.includes(`worktrees/${FIXTURE_WORK_STREAM_ID}`)
  const noExplicitPath = !command.includes('/')
  const facts: string[] = []
  if (/\bpwd\s*(?:$|[;&|])/.test(command) && (tree || noExplicitPath)) facts.push(tree ? FIXTURE_WORKTREE : workspace)
  if (tree && /\bgit\b[^;\n&|]*\bbranch --show-current\b/.test(command)) facts.push(FIXTURE_BRANCH)
  if (tree && /\bgit\b[^;\n&|]*\brev-parse HEAD\b/.test(command)) facts.push(FIXTURE_HEAD)
  if (tree && /\bgit\b[^;\n&|]*\blog\b/.test(command))
    facts.push(`${FIXTURE_HEAD.slice(0, 8)} Retry slot grants after a host budget change`)
  for (const match of command.matchAll(/\bls(?:\s+-[a-zA-Z]+)*([^;|&\n]*)/g)) {
    const paths = match[1]!.trim().split(/\s+/).filter(Boolean)
    for (const raw of paths.length ? paths : ['.']) {
      const path = raw.replace(/^['"]|['"]$/g, '').replace(/\/$/, '')
      if (
        path === `${FIXTURE_WORKTREE}/apps/core/src/services/slots` ||
        (tree && path === 'apps/core/src/services/slots')
      )
        facts.push('host-budget.ts\nhost-budget.test.ts')
      else if (path === FIXTURE_WORKTREE || path === `worktrees/${FIXTURE_WORK_STREAM_ID}` || (tree && path === '.'))
        facts.push('apps\nconfig\ndocs\npackage.json\nbun.lock')
      else if (path === `${workspace}/worktrees` || path === 'worktrees') facts.push(FIXTURE_WORK_STREAM_ID)
      else if (path === workspace || (!tree && path === '.')) facts.push('worktrees')
    }
  }
  if (tree && /\bfind\b/.test(command) && /host-budget/.test(command))
    facts.push(`${FIXTURE_WORKTREE}/apps/core/src/services/slots/host-budget.test.ts`)
  return facts.length ? facts.join('\n') : undefined
}

/** Only PR inspection gets PR JSON. Repository settings requests must not impersonate it. */
export function isFixturePrInspection(command: string): boolean {
  return (
    /\bgh pr (view|status)\b/.test(command) ||
    /\bgh api\s+(?:--[^ ]+\s+)*\/?repos\/ficushq\/ficus\/pulls\/950(?:[\s/'"?]|$)/.test(command) ||
    (/\bgh api graphql\b/.test(command) && /pullRequest\s*\(/.test(command))
  )
}

/** The fictional repository allows only squash, and requires these three checks and one review. */
export function fixtureRepositorySettings(command: string): string | undefined {
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
