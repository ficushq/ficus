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

const once = (prompt: string, text: string) => expect(prompt.split(text)).toHaveLength(2)

// The integration notification carries the event commands; `track`/`tracked` help carries delivery details.
const moved = [
  'Linear notification carries',
  'converted automatically at startup',
  'per-resource delivery outcomes',
  'active subscription',
  'replayed event returns the same stream',
]

test('agents that create or link work learn event tracking once, not its server mechanics', () => {
  for (const role of ['manager', 'consultant']) {
    const prompt = compose(role)
    once(prompt, '--from-event <id>')
    once(prompt, 'ficus workstream track <ws-id> --event <id>')
    once(prompt, 'never by hand-writing `github.*`/`codeHost` metadata')
    once(prompt, 'A `--from-url` link is reference material only')
    for (const text of moved) expect(prompt).not.toContain(text)
  }
})

test('the manager learns that tracked activity never finishes a stream and which pull requests must merge', () => {
  const prompt = compose('manager')
  once(prompt, 'it never finishes a stream or clears its waits')
  once(prompt, 'pull requests tracked with `--delivery` to merge')
  once(prompt, 'ficus workstream tracked <ws-id>')
})

test('no other agent type carries the tracking guidance', () => {
  for (const role of types.filter((type) => !['manager', 'consultant'].includes(type))) {
    const prompt = compose(role)
    expect(prompt).not.toContain('--from-event')
    expect(prompt).not.toContain('workstream track ')
  }
})

test('the manager tracking section stays small', () => {
  const manager = read('config/agent-types/manager.yaml')
  const section = manager.slice(
    manager.indexOf('## Tracking issues and pull requests'),
    manager.indexOf('### Dynamic Agent Configuration')
  )
  expect(Buffer.byteLength(section)).toBeLessThanOrEqual(800)
})

test('CI runs the database-free tracking guidance checks', () => {
  const workflow = Bun.YAML.parse(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> }>
  }
  expect(Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])).toContainEqual({
    name: 'Validate tracking guidance',
    run: 'bun test ../scripts/tracking-guidance.test.ts',
    'working-directory': '.github',
  })
})
