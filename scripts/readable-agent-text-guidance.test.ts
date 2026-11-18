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

function composed(type: { includes: string[]; systemPrompt: string }): string {
  return [type.systemPrompt, ...type.includes.map((id) => read(`${typeDirectory}/shared/${id}.md`))].join('\n\n')
}

test('the readable-text include requires readable prose in every required field category', () => {
  const guidance = readableSection(read(`${typeDirectory}/shared/readable-text.md`))
  for (const contract of contracts) expect(guidance).toContain(contract)
})

test('every built-in agent type includes the readable-text rule exactly once, including assistant workers', () => {
  expect(types.length).toBeGreaterThan(0)
  for (const type of types) {
    expect({ id: type.id, includes: type.includes.filter((id) => id === 'readable-text').length }).toEqual({
      id: type.id,
      includes: 1,
    })
  }
  for (const id of ['assistant', 'assistant-worker', 'system-manager', 'subagent', 'artifact-builder-default']) {
    expect(types.some((type) => type.id === id)).toBe(true)
  }
})

test('every composed built-in prompt carries the readable prose rule once, in full', () => {
  for (const type of types) {
    const prompt = composed(type)
    expect({ id: type.id, copies: prompt.split('### Readable text fields').length - 1 }).toEqual({
      id: type.id,
      copies: 1,
    })
    const guidance = readableSection(prompt)
    for (const contract of contracts) expect(guidance).toContain(contract)
    // The leading sentence is the rule itself; it must not survive anywhere else as a stray copy.
    expect(normalize(prompt).split(contracts[0]!).length - 1).toBe(1)
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

test('manager leaves round-specific human decision briefs with producing agents', () => {
  const prompt = normalize(types.find((type) => type.id === 'manager')!.systemPrompt)
  expect(prompt).toContain('Human gate instructions describe the kind of gate and are not rewritten for each round.')
  expect(prompt).toContain('The producing agent writes the structured decision brief')
  expect(prompt).toContain('Durable constraints belong in the work stream description')
  expect(prompt).toContain('Managers do not author each round')
})
