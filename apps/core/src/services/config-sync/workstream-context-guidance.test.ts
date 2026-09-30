import { describe, expect, test } from 'bun:test'
import { readFile } from 'fs/promises'
import { join } from 'path'

const repoRoot = join(import.meta.dir, '../../../../../')

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8')
}

describe('work stream context guidance', () => {
  test('flow outcomes route work while scoped waits request input without advancing a review', async () => {
    const guidance = (await readRepoFile('config/agent-types/shared/squad-rules.md')).replace(/\s+/g, ' ')
    expect(guidance).toContain('ficus workstream advance')
    expect(guidance).toContain('expectedVersion')
    expect(guidance).toContain('attemptId')
    expect(guidance).toContain('Never advance by changing the assignee, calling legacy handoff, or editing status')
    expect(guidance).toContain('default to the current flow attempt')
    expect(guidance).toContain('Sibling branches can continue')
    expect(guidance).toContain('Input answers are not review approvals')
    expect(guidance).toContain('declared human-approval step')
  })

  test('flow delivery requires policy evidence, not a role-owned legacy review wait', async () => {
    const shared = (await readRepoFile('config/agent-types/shared/squad-rules.md')).replace(/\s+/g, ' ')
    const manager = (await readRepoFile('config/agent-types/manager.yaml')).replace(/\s+/g, ' ')
    expect(shared).toContain('completion-ready')
    expect(shared).toContain('ficus workstream finish')
    expect(shared).toContain('not evidence of merge')
    expect(shared).toContain('no role may grant itself that authority')
    expect(manager).toContain('No role inherently owns PR creation')
    expect(manager).toContain('metadata.policies.allowAutoMerge')
    expect(manager).toContain('metadata.policies.allowDirectMerge')
    expect(manager).toContain('bare done command cannot finish a flow')
  })

  test('scheduled work respects flow steps and does not introduce a no-code bypass', async () => {
    const guidance = (await readRepoFile('config/agent-types/shared/squad-rules.md')).replace(/\s+/g, ' ')
    expect(guidance).toContain('scheduled')
    expect(guidance).not.toContain('explicit exception to generic handoff guidance')
    expect(guidance).toContain('required checks')
  })

  test('manager treats work stream creation as a mutation during approval-gated requests', async () => {
    const managerPrompt = (await readRepoFile('config/agent-types/manager.yaml')).replace(/\s+/g, ' ')

    expect(managerPrompt).toContain('Creating a work stream mutates platform state')
    expect(managerPrompt).toContain('read-only investigation or requires approval before mutations')
    expect(managerPrompt).toContain(
      'do not create a work stream, spawn agents, edit files, or perform any other mutation'
    )
    expect(managerPrompt).toContain('without their explicit approval')
  })

  test('manager and consultant classify read-only streams without weakening worktree safety', async () => {
    const prompts = await Promise.all([
      readRepoFile('config/agent-types/manager.yaml'),
      readRepoFile('config/agent-types/consultant.yaml'),
    ])

    for (const prompt of prompts) {
      const guidance = prompt.replace(/\s+/g, ' ')
      expect(guidance).toContain('code-producing or read-only/research')
      expect(guidance).toContain('no worktree or branch is intentionally configured')
      expect(guidance).toContain('repository mutations, commits, and PRs are prohibited')
      expect(guidance).toContain('intentional no-worktree exception')
      expect(guidance).toContain('separate worktree-backed implementation stream')
      expect(guidance).toContain(
        'Any code, configuration, or documentation mutation requires a dedicated branch and worktree'
      )
    }
  })

  test('manager, consultant, and work-stream skill require self-contained task context', async () => {
    const [managerPrompt, consultantPrompt, workStreamSkill] = await Promise.all([
      readRepoFile('config/agent-types/manager.yaml'),
      readRepoFile('config/agent-types/consultant.yaml'),
      readRepoFile('config/skills/work-stream-driven-development/SKILL.md'),
    ])

    for (const guidance of [managerPrompt, consultantPrompt, workStreamSkill]) {
      const normalizedGuidance = guidance.replace(/\s+/g, ' ')
      expect(normalizedGuidance).toContain('self-contained')
      expect(normalizedGuidance).toContain('do not rely on or merely reference prior chat conversations')
      expect(normalizedGuidance).toContain('"as discussed"')
      expect(normalizedGuidance).toContain('"the conversation above"')
      expect(normalizedGuidance).toContain(
        'goal, current behavior/problem, desired behavior, constraints, and important decisions'
      )
    }
  })
})

test('workflow guidance prefers inline content and stdin rather than mandatory temp files', async () => {
  const files = [
    'config/agent-types/shared/squad-rules.md',
    'config/agent-types/manager.yaml',
    'config/agent-types/consultant.yaml',
    'config/skills/setup-workflows/SKILL.md',
    'config/skills/work-stream-driven-development/SKILL.md',
    'config/skills/roadmap-phase-loop/SKILL.md',
    'apps/core/src/entities/agent-runners/squad-manager-runner.ts',
    'apps/core/src/entities/agent-runners/squad-worker-runner.ts',
    'apps/docs/src/content/docs/reference/workflow-definition.mdx',
  ]
  for (const file of files) {
    const text = await readRepoFile(file)
    expect(text).toMatch(/--(?:flow-)?content/)
    expect(text).toMatch(/--(?:flow-)?stdin/)
    expect(text).not.toMatch(/tau workstream advance[^\n]*--file/)
    expect(text).not.toContain('--flow source.yaml')
  }
})

test('consultants opt into terminal observation for reporting, never management', async () => {
  const prompt = (await readRepoFile('config/agent-types/consultant.yaml')).replace(/\s+/g, ' ')
  for (const syntax of [
    '--observe terminal',
    'ficus workstream observe <id>',
    'ficus workstream unobserve <id>',
    'ficus workstream observation <id>',
  ])
    expect(prompt).toContain(syntax)
  expect(prompt).toContain('one-shot')
  expect(prompt).toContain('already terminal')
  expect(await readRepoFile('docs/wiki/consultant.md')).toContain('USER subscribe/unsubscribe')
  expect(prompt).toContain('not management instructions')
  expect(prompt).toContain('Assistant task reporting')
  expect(prompt).toContain('do not poll')
})

test('consultant observation guidance distinguishes observers from owners without implementation details', async () => {
  const prompt = (await readRepoFile('config/agent-types/consultant.yaml')).replace(/\s+/g, ' ')
  const observation = prompt.split('## Observing delegated results (opt-in)')[1]!.split('## Editing directly')[0]!
  expect(observation).toContain('The work stream owner retains responsibility')
  expect(observation).toContain('If you remain the owner')
  expect(observation).toContain('already receive owner updates and do not need to observe')
  expect(observation).not.toContain('The manager retains')
  expect(observation).not.toContain('atomic')
  expect(observation).not.toContain('fast completion')
  expect(observation).not.toContain('These commands authenticate')
  expect(observation).not.toContain('USER subscribe/unsubscribe')
})
