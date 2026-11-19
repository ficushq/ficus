import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

const types = readdirSync(resolve(root, 'config/agent-types'))
  .filter((file) => file.endsWith('.yaml'))
  .map((file) => file.slice(0, -'.yaml'.length))

function compose(role: string) {
  const config = Bun.YAML.parse(read(`config/agent-types/${role}.yaml`)) as {
    includes?: string[]
    systemPrompt: string
  }
  return {
    includes: config.includes ?? [],
    prompt: [
      config.systemPrompt,
      ...(config.includes ?? []).map((part) => read(`config/agent-types/shared/${part}.md`)),
    ]
      .join('\n\n')
      .replace(/\s+/g, ' '),
  }
}

const once = (prompt: string, text: string) => expect(prompt.split(text)).toHaveLength(2)

const squadTypes = types.filter((role) => compose(role).includes.includes('squad-rules'))

// `ficus schedule --help` now carries the management commands and timing options.
const moved = ['Manage your reminders', 'ficus schedule show <id>', 'ficus schedule trigger <id>', 'Schedule types:']

test('squad agents learn the self-reminder recipe and the schedule invariants once', () => {
  expect(squadTypes.length).toBeGreaterThan(0)
  for (const role of squadTypes) {
    const { prompt } = compose(role)
    once(prompt, '--action inbox_message --target-agent {{agent.id}}')
    once(prompt, '`ficus schedule --help`')
    once(prompt, 'A schedule grants no authority')
    once(prompt, 'never schedule a continuation')
    once(prompt, '{{activeSchedules}}')
    for (const text of moved) expect(prompt).not.toContain(text)
  }
})

test('agent types without squad rules carry no schedule recipe', () => {
  for (const role of types.filter((type) => !squadTypes.includes(type))) {
    expect(compose(role).prompt).not.toContain('ficus schedule create')
  }
})

test('the schedules section stays small', () => {
  const rules = read('config/agent-types/shared/squad-rules.md')
  const section = rules.slice(rules.indexOf('## Schedules & Reminders'), rules.indexOf('{{activeSchedules}}'))
  expect(Buffer.byteLength(section)).toBeLessThanOrEqual(500)
})

test('CI runs the database-free schedule guidance checks', () => {
  const workflow = Bun.YAML.parse(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> }>
  }
  expect(Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])).toContainEqual({
    name: 'Validate schedule guidance',
    run: 'bun test ../scripts/schedule-guidance.test.ts',
    'working-directory': '.github',
  })
})
