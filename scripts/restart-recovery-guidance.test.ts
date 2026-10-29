import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

test('the canonical recovery doctrine is one paragraph', () => {
  const section = read('config/agent-types/shared/rules.md')
    .split('### Interrupted commands and bounded recovery')[1]!
    .split('### Slot Coordination')[0]!
    .trim()
  expect(section.split(/\n\s*\n/)).toHaveLength(1)
})

test('worker, engineer, reviewer, general and manager each receive restart-safe recovery doctrine', () => {
  for (const role of ['assistant-worker', 'engineer', 'reviewer', 'general', 'manager']) {
    const config = Bun.YAML.parse(read(`config/agent-types/${role}.yaml`)) as {
      includes: string[]
      systemPrompt: string
    }
    const prompt = [
      config.systemPrompt,
      ...config.includes.map((part) => read(`config/agent-types/shared/${part}.md`)),
    ].join('\n')
    expect(prompt).toContain('A correlated Ficus restart is an interruption, not an incident')
    expect(prompt).toContain('check partial output and the affected state')
    expect(prompt).toContain('default 3')
    expect(prompt).toContain('known restart is a free retry')
    expect(prompt).toContain('Never ask a person for host logs, registry records, platform forensics')
    expect(prompt).toContain('squad manager first')
    expect(prompt).toContain('at most one extra recovery cycle per recovery record')
    expect(prompt).toContain('automatically forwards')
    expect(prompt).toContain('expectedVersion')
    expect(prompt).not.toContain('request-input <id> -m')
    expect(prompt).not.toContain('or the existing authorized task owner when no squad manager exists')
    expect(prompt).not.toContain('report the box as overloaded instead of retrying')
    const withoutProhibition = prompt.replace(
      'Never ask a person for host logs, registry records, platform forensics or technical evidence they cannot provide.',
      ''
    )
    expect(withoutProhibition).not.toMatch(
      /(?:ask|request|collect|gather)[^\n.]{0,80}(?:host logs|registry records|platform forensics|operator diagnostics)/i
    )
  }
})
