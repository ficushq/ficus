import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

const types = [
  'assistant-worker',
  'architect',
  'consultant',
  'engineer',
  'reviewer',
  'general',
  'manager',
  'sysops',
  'security-auditor',
  'system-manager',
  'subagent',
  'artifact-builder-default',
  'assistant',
]

function compose(role: string) {
  const config = Bun.YAML.parse(read(`config/agent-types/${role}.yaml`)) as { includes: string[]; systemPrompt: string }
  return {
    config,
    prompt: [config.systemPrompt, ...config.includes.map((part) => read(`config/agent-types/shared/${part}.md`))].join(
      '\n\n'
    ),
  }
}

const once = (prompt: string, text: string) => expect(prompt.split(text)).toHaveLength(2)

test('squad agents get worktree setup and post-delivery safety once, not cleanup diagnosis', () => {
  for (const role of types) {
    const { config, prompt } = compose(role)
    if (!config.includes.includes('squad-rules')) {
      expect(prompt).not.toContain('## Git Worktrees')
      continue
    }
    // Before code work: find and confirm the assigned tree; never implement on the base branch.
    once(prompt, '## Git Worktrees')
    once(prompt, 'git -C <worktree> branch --show-current')
    once(prompt, 'there is no top-level `.git`')
    once(prompt, 'do not implement on the base branch')
    once(prompt, '"key":"git.worktree"')
    // A cleaned-up tree is never recreated; only a never-provisioned one may be set up.
    once(prompt, 'Never recreate or reuse a path the\nplatform is removing or has removed')
    once(prompt, 'never-provisioned, metadata-only')
    once(prompt, "without resetting\nanother stream's checkout")
    once(prompt, "reuse, write into, recreate or remove a finished stream's worktree")
    once(prompt, 'ficus workstream cleanup retain <workstream-id>')
    once(prompt, 'ficus workstream cleanup --help')
    // Operator diagnosis lives in `ficus workstream cleanup --help`.
    expect(prompt).not.toContain('server-observed creation receipt')
    expect(prompt).not.toContain('operation markers')
    expect(prompt).not.toContain('Platform-owned cleanup')
  }
})

test('the squad-rules worktree section stays small', () => {
  const rules = read('config/agent-types/shared/squad-rules.md')
  const section = rules.slice(rules.indexOf('## Git Worktrees'), rules.indexOf('## Diagrams'))
  expect(Buffer.byteLength(section)).toBeLessThanOrEqual(2_200)
})

test('CI runs the database-free worktree guidance checks', () => {
  const workflow = Bun.YAML.parse(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> }>
  }
  expect(Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])).toContainEqual({
    name: 'Validate worktree guidance',
    run: 'bun test ../scripts/worktree-guidance.test.ts',
    'working-directory': '.github',
  })
})
