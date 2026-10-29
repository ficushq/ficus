import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const normalize = (text: string) => text.replace(/\s+/g, ' ')
const typeDirectory = 'config/agent-types'
const types = readdirSync(join(root, typeDirectory))
  .filter((file) => file.endsWith('.yaml'))
  .map(
    (file) =>
      Bun.YAML.parse(read(`${typeDirectory}/${file}`)) as {
        id: string
        includes: string[]
        systemPrompt: string
      }
  )

// Assert the rule itself, not just a heading or a slogan elsewhere in a prompt.
const contracts = [
  'Write every text field in normal, readable prose with normal spacing and complete words.',
  'Never remove spaces, run words together, invent abbreviations, or use telegraphic shorthand to save tokens or length.',
  'When material is long, use headings, bullets, or a linked file instead of compressing it.',
  'work stream descriptions',
  'step instructions and outputs',
  'wait, approval, and review messages',
  'questions',
  'inbox and steering messages',
  'metadata values',
  'pull request text',
]

function readableSection(text: string): string {
  return normalize(text.split('### Readable text fields\n')[1]?.split(/\n#{1,3} /)[0] ?? '')
}

for (const name of ['rules', 'squad-rules']) {
  test(`${name} requires readable prose in every required field category`, () => {
    const guidance = readableSection(read(`${typeDirectory}/shared/${name}.md`))
    for (const contract of contracts) expect(guidance).toContain(contract)
  })
}

for (const [id, location] of [
  ['manager', '## Creating Work'],
  ['assistant', 'Delegate longer work with delegate_task.'],
] as const) {
  test(`${id} keeps the readable prose rule at its brief-writing location`, () => {
    const prompt = types.find((type) => type.id === id)!.systemPrompt
    expect(prompt).toContain(location)
    const brief = prompt.slice(prompt.indexOf(location)).split(/\n## /)[0]!
    const guidance = readableSection(brief)
    for (const contract of contracts) expect(guidance).toContain(contract)
  })
}

test('every built-in agent type includes the shared rule, including assistant workers', () => {
  expect(types.length).toBeGreaterThan(0)
  for (const type of types) {
    expect({ id: type.id, rules: type.includes.filter((id) => id === 'rules').length }).toEqual({
      id: type.id,
      rules: 1,
    })
  }
  for (const id of ['assistant', 'assistant-worker', 'system-manager', 'subagent', 'artifact-builder-default']) {
    expect(types.some((type) => type.id === id)).toBe(true)
  }
})

test('squad agent types retain the squad guidance include', () => {
  for (const id of [
    'manager',
    'consultant',
    'architect',
    'engineer',
    'reviewer',
    'security-auditor',
    'sysops',
    'general',
  ]) {
    expect(types.find((type) => type.id === id)!.includes).toContain('squad-rules')
  }
})

test('CI runs this database-free guidance suite', () => {
  const workflow = Bun.YAML.parse(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> }>
  }
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
  const step = steps.find((step) => step.name === 'Validate readable agent text guidance')
  expect(step).toEqual({
    name: 'Validate readable agent text guidance',
    run: 'bun test ../scripts/readable-agent-text-guidance.test.ts',
    'working-directory': '.github',
  })
})
