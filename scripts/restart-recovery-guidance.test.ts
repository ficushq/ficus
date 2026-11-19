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

test('composed prompts keep pre-tool safety once, not the recovery decision procedure', () => {
  for (const role of types) {
    const { config, prompt } = compose(role)
    if (role === 'assistant') {
      expect(config.includes).not.toContain('rules')
      expect(config.includes).not.toContain('recovery-waits')
      continue
    }
    expect(prompt.split('Unknown transport loss is not proof of a restart')).toHaveLength(2)
    expect(prompt).toContain('never repeat an external side effect with an unknown outcome')
    expect(prompt).toContain('3 unexplained failures')
    expect(prompt).toContain('1s then 2s')
    expect(prompt).toContain('safe, idempotent work')
    expect(prompt).toContain('stop your own heavy processes')
    const hasWaits = config.includes.includes('recovery-waits')
    expect(hasWaits).toBe(!['subagent', 'artifact-builder-default'].includes(role))
    if (hasWaits) {
      expect(prompt.split('Use the runtime-issued recovery record')).toHaveLength(2)
      expect(prompt).toContain('never invent attempts or reset a budget')
      expect(prompt).toContain('Never ask a person for technical evidence')
    }
    expect(prompt).not.toContain('at most one extra recovery cycle per normalized recovery scope')
    expect(prompt).not.toContain('expectedRecoveryVersion')
  }
})

test('the always-loaded recovery includes contain only the pre-tool invariants', () => {
  const interrupted = read('config/agent-types/shared/rules.md')
    .split('### Interrupted commands and bounded recovery')[1]!
    .split('### Messaging / Shell Safety')[0]!
    .trim()
  expect(Buffer.byteLength(interrupted)).toBeLessThanOrEqual(550)
  expect(Buffer.byteLength(read('config/agent-types/shared/recovery-waits.md'))).toBeLessThanOrEqual(500)
})

test('CI runs the database-free restart guidance checks', () => {
  const workflow = Bun.YAML.parse(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> }>
  }
  expect(Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])).toContainEqual({
    name: 'Validate restart recovery guidance',
    run: 'bun test ../scripts/restart-recovery-guidance.test.ts',
    'working-directory': '.github',
  })
})
