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
  return [config.systemPrompt, ...(config.includes ?? []).map((part) => read(`config/agent-types/shared/${part}.md`))]
    .join('\n\n')
    .replace(/\s+/g, ' ')
}

// Warnings about pre-flow verbs that the static prompts used to carry. The CLI help now marks those
// verbs and a flow refuses each of them with a message naming the replacement.
const removed = [
  'legacy handoff',
  'legacy role or skill',
  'Old work streams without a flow',
  'completing-review commands',
  'bare status updates',
  'bare done command',
  'legacy agent lists',
  'next-steps metadata when marking done',
]

test('no built-in agent type carries the legacy work stream verb warnings', () => {
  for (const role of types) {
    const prompt = compose(role)
    for (const text of removed)
      expect({ role, text, present: prompt.includes(text) }).toEqual({ role, text, present: false })
  }
})

test('squad agents keep the flow invariants the warnings protected', () => {
  for (const role of types.filter((type) => compose(type).includes('## Work Streams, Handoffs, and Reviews'))) {
    const prompt = compose(role)
    expect(prompt).toContain('take precedence over role or skill instructions about routing')
    expect(prompt).toContain('The runtime routes the next step and enforces joins and required checks')
    expect(prompt).toContain('ficus workstream finish')
  }
})

test('workstream help marks every pre-flow verb as legacy and names the flow replacement', () => {
  const cli = read('apps/cli/src/commands/workstream.ts').replace(/\s+/g, ' ')
  expect(cli.split("'Legacy, streams without a flow: ").length - 1).toBe(7)
  expect(cli).toContain('Commands marked "Legacy" serve only streams without a flow')
  expect(cli).toContain('"ficus workstream advance"')
  expect(cli).toContain('"ficus workstream finish"')
})

test('flow refusals name the command that replaces each pre-flow verb', () => {
  const execution = read('apps/core/src/services/workflows/execution.ts')
  const refusals = execution.slice(execution.indexOf('export const FLOW_REFUSALS'), execution.indexOf('} as const'))
  const messages = [...refusals.matchAll(/^ {2}\w+:\s*\n?\s*(['"])(.+)\1,$/gm)].map((match) => match[2]!)
  expect(messages).toHaveLength(5)
  for (const message of messages) expect(message).toContain('ficus workstream advance')
  expect(execution).toContain(
    '`Use flow completion to evaluate the configured delivery policy: ficus workstream finish ${stream.id} --version ${run.version}`'
  )
})

test('CI runs the database-free legacy work stream guidance checks', () => {
  const workflow = Bun.YAML.parse(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> }>
  }
  expect(Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])).toContainEqual({
    name: 'Validate legacy work stream guidance',
    run: 'bun test ../scripts/legacy-workstream-guidance.test.ts',
    'working-directory': '.github',
  })
})
