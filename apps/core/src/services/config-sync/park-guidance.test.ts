import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'

describe('manager parking guidance', () => {
  it('manager parking guidance contains the stop-first protocol', () => {
    const config = readFileSync(resolve(import.meta.dir, '../../../../../config/agent-types/manager.yaml'), 'utf8')
    const parsed = yaml.load(config) as { systemPrompt?: unknown }
    expect(typeof parsed.systemPrompt).toBe('string')
    const prompt = (parsed.systemPrompt as string).replace(/\s+/g, ' ').toLowerCase()

    // Mutation: deleting the park doctrine or the stop-first protocol must fail these.
    // §7 (work-stream-verbs-redesign): park is priority preemption ONLY.
    expect(prompt).toContain('priority preemption')
    expect(prompt).toContain('never park a stream because it is waiting')
    expect(prompt).toContain('lower-priority')
    // Stop-first protocol for preempting executing work.
    expect(prompt).toContain('message the assigned agent')
    expect(prompt).toContain('stop at a safe point')
    expect(prompt).toContain('commit and push')
    expect(prompt).toContain('wait for confirmation')
    expect(prompt).toContain('--preempt-running')
    expect(prompt).toContain('genuinely abandonable')
    expect(prompt).toContain('lower its priority')
  })
})
