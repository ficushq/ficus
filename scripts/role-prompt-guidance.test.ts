import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The role prompts keep what is specific to Ficus or to the role's judgment.
 * Generic checklists, cheat sheets and the architect's per-step code template
 * were removed; `--help` carries command flags. These checks keep them out and
 * keep the invariants the rewrite preserved.
 */

const root = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const prompt = (role: string) =>
  (Bun.YAML.parse(read(`config/agent-types/${role}.yaml`)) as { systemPrompt: string }).systemPrompt
const flat = (role: string) => prompt(role).replace(/\s+/g, ' ')

function section(role: string, heading: string): string {
  const text = prompt(role)
  const start = text.indexOf(heading)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = text.slice(start + heading.length).search(/\n#{2,3} /)
  return next < 0 ? text.slice(start) : text.slice(start, start + heading.length + next)
}

test('the architect plans without a per-step code template', () => {
  const architect = prompt('architect')
  for (const removed of ['2-5 minutes', 'Bite-Sized', '### Task Structure', '```python', 'pytest', 'git commit -m'])
    expect(architect).not.toContain(removed)
  expect(architect).toContain('Scale detail to the work')
  expect(architect).toContain('testing strategy')
})

test('role prompts drop generic checklists and cheat sheets', () => {
  expect(prompt('engineer')).not.toContain('Self-Review Checklist')
  expect(prompt('engineer')).not.toContain('DRY, YAGNI')
  expect(prompt('sysops')).not.toContain('Common Tools Reference')
  expect(prompt('sysops')).not.toMatch(/docker ps|kubectl|df -h|curl -v/)
  // Ordinary agents reach humans through notify_contact, not the system inbox.
  expect(prompt('sysops')).not.toContain('ficus inbox send system')
  expect(flat('sysops')).toContain('report important events through `notify_contact`')
  expect(prompt('security-auditor')).not.toContain('unsafe deserialization, path traversal')
})

test('role prompts keep their judgment and Ficus-specific rules', () => {
  expect(flat('reviewer')).toContain("Do not trust the engineer's report")
  expect(flat('reviewer')).toContain('unrequested work, which is a spec failure too')
  expect(flat('reviewer')).toContain('do NOT automatically revert it as scope creep')
  expect(flat('reviewer')).toContain('a decision to defer a dependency is not evidence that the failure is unrelated')
  expect(flat('engineer')).toContain('reply to each individual thread')
  expect(flat('sysops')).toContain('use `squad_bash` by default')
  expect(flat('sysops')).toContain('An assignment to investigate is not permission to change a live system')
  expect(flat('sysops')).toContain('staging or another isolated environment')
  expect(flat('security-auditor')).toContain('Never reproduce a secret value')
  expect(flat('security-auditor')).toContain('unless the task explicitly asks for it')
})

test('the long manager sections stay short', () => {
  expect(Buffer.byteLength(section('manager', '### Durable Systems'))).toBeLessThanOrEqual(2_800)
  expect(section('manager', '### Observing Workers').trim().split('\n')).toHaveLength(3)
  const manager = flat('manager')
  for (const removed of [
    '--tools-only',
    '--limit 20 --offset 40',
    'Major milestones completed',
    'Cross-Squad Communication',
  ])
    expect(manager).not.toContain(removed)
  expect(manager).toContain('Encode only invariants')
  expect(manager).toContain('Never encode manual process that gates execution')
  expect(manager).toContain('tests, typechecks, lint, formatting and mutation checks whenever they like')
  expect(manager).toContain('"one execution authorized"')
  expect(manager).toContain('evidence, results and run logs belong in the PR or handoff, never in a new ledger')
  expect(manager).toContain('retire something before adding anything')
  expect(manager).toContain('never use `ficus agent message` to send messages to workers')
})

test('CI runs the database-free role prompt checks', () => {
  const workflow = Bun.YAML.parse(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> }>
  }
  expect(Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])).toContainEqual({
    name: 'Validate role prompt guidance',
    run: 'bun test ../scripts/role-prompt-guidance.test.ts',
    'working-directory': '.github',
  })
})
