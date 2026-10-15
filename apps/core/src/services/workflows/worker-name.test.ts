import { describe, expect, test } from 'bun:test'
import { FLOW_WORKER_TITLE_MAX, flowWorkerName, shortenTitle } from './worker-name'

describe('flow worker names', () => {
  test('keeps a title that fits unchanged', () => {
    expect(flowWorkerName('worker', 'Fix VM box port collisions')).toBe('worker · Fix VM box port collisions')
    const exact = 'x'.repeat(FLOW_WORKER_TITLE_MAX)
    expect(shortenTitle(exact)).toBe(exact)
  })

  test('ends a long title with an ellipsis at a word boundary instead of mid-word', () => {
    const title = 'Fix VM box port collisions: reserve box port range, block bound ports and retry on conflict'
    const name = flowWorkerName('worker', title)
    expect(name).toBe('worker · Fix VM box port collisions: reserve box port range, block…')
    const shortened = shortenTitle(title)
    expect(Array.from(shortened).length).toBeLessThanOrEqual(FLOW_WORKER_TITLE_MAX)
    expect(shortened.endsWith('…')).toBe(true)
  })

  test('drops trailing punctuation before the ellipsis', () => {
    expect(shortenTitle('Alpha beta, gamma delta epsilon', 18)).toBe('Alpha beta…')
  })

  test('cuts a single overlong word with an ellipsis', () => {
    const shortened = shortenTitle('a'.repeat(100))
    expect(shortened).toBe(`${'a'.repeat(FLOW_WORKER_TITLE_MAX - 1)}…`)
  })

  test('never splits a surrogate pair', () => {
    const shortened = shortenTitle('🌿'.repeat(70))
    expect(shortened).toBe(`${'🌿'.repeat(FLOW_WORKER_TITLE_MAX - 1)}…`)
  })
})
