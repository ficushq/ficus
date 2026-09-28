import { describe, expect, test } from 'bun:test'
import type { WorkStream } from '@ficus/shared'
import { layoutWorkStreamGraph } from './workStreamGraphLayout'

function stream(overrides: Partial<WorkStream> & Pick<WorkStream, 'id'>): WorkStream {
  return {
    squadId: 'squad-1',
    title: overrides.id,
    description: '',
    status: 'queued',
    priority: 'normal',
    effectivePriority: overrides.priority ?? 'normal',
    completionMode: 'pr-merge',
    assigneeAgentId: null,
    ownerAgentId: null,
    creatorAgentId: null,
    requestingUserId: null,
    agentIds: [],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    createdAt: new Date('2026-08-14T12:00:00.000Z'),
    updatedAt: new Date('2026-08-14T12:00:00.000Z'),
    ...overrides,
  }
}

function layers(result: ReturnType<typeof layoutWorkStreamGraph>) {
  return Object.fromEntries(result.nodes.map((node) => [node.id, node.layer]))
}

describe('layoutWorkStreamGraph', () => {
  test('lays out a blocker chain from left to right and emits blocker-to-dependent edges', () => {
    const result = layoutWorkStreamGraph([
      stream({ id: 'a' }),
      stream({ id: 'b', dependsOn: ['a'] }),
      stream({ id: 'c', dependsOn: ['b'] }),
    ])

    expect(layers(result)).toEqual({ a: 0, b: 1, c: 2 })
    expect(result.edges.map(({ from, to }) => `${from}->${to}`)).toEqual(['a->b', 'b->c'])
  })

  test('places the dependent of a diamond in layer two', () => {
    const result = layoutWorkStreamGraph([
      stream({ id: 'a' }),
      stream({ id: 'b', dependsOn: ['a'] }),
      stream({ id: 'c', dependsOn: ['a'] }),
      stream({ id: 'd', dependsOn: ['b', 'c'] }),
    ])

    expect(layers(result)).toEqual({ a: 0, b: 1, c: 1, d: 2 })
  })

  test('sorts disconnected graph nodes by canonical scheduler urgency', () => {
    const result = layoutWorkStreamGraph([
      stream({ id: 'idle', status: 'active', derivedState: 'idle' }),
      stream({ id: 'queue', status: 'queued', queuePosition: 1 }),
      stream({ id: 'review', status: 'active', derivedState: 'in_review' }),
      stream({ id: 'wait', status: 'active', derivedState: 'blocked' }),
      stream({ id: 'progress', status: 'active', derivedState: 'in_progress' }),
    ])
    expect(result.nodes.map((node) => node.id)).toEqual(['review', 'wait', 'progress', 'idle', 'queue'])
  })

  test('sorts a layer by effective priority then creation time', () => {
    const result = layoutWorkStreamGraph([
      stream({ id: 'old-normal', createdAt: new Date('2026-08-14T10:00:00.000Z') }),
      stream({ id: 'new-high', effectivePriority: 'high', createdAt: new Date('2026-08-14T11:00:00.000Z') }),
      stream({ id: 'old-high', effectivePriority: 'high', createdAt: new Date('2026-08-14T09:00:00.000Z') }),
    ])

    expect(result.nodes.map((node) => node.id)).toEqual(['old-high', 'new-high', 'old-normal'])
  })

  test('degrades cycles into an unresolved layer without throwing', () => {
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      const result = layoutWorkStreamGraph([
        stream({ id: 'a', dependsOn: ['b'] }),
        stream({ id: 'b', dependsOn: ['a'] }),
      ])

      expect(result.nodes.map((node) => node.layer)).toEqual([0, 0])
      expect(result.nodes.every((node) => node.unresolved)).toBe(true)
      expect(warnings).toHaveLength(1)
    } finally {
      console.warn = originalWarn
    }
  })

  test('places unresolved cycle nodes after resolved dependency layers', () => {
    const originalWarn = console.warn
    console.warn = () => undefined
    try {
      const result = layoutWorkStreamGraph([
        stream({ id: 'root' }),
        stream({ id: 'leaf', dependsOn: ['root'] }),
        stream({ id: 'cycle-a', dependsOn: ['cycle-b'] }),
        stream({ id: 'cycle-b', dependsOn: ['cycle-a'] }),
      ])
      expect(layers(result)).toEqual({ root: 0, leaf: 1, 'cycle-a': 2, 'cycle-b': 2 })
    } finally {
      console.warn = originalWarn
    }
  })

  test('puts disconnected streams in a separate bottom cluster and ignores missing blockers', () => {
    const result = layoutWorkStreamGraph([
      stream({ id: 'blocker' }),
      stream({ id: 'dependent', dependsOn: ['blocker', 'missing'] }),
      stream({ id: 'independent' }),
    ])
    const byId = new Map(result.nodes.map((node) => [node.id, node]))

    expect(byId.get('independent')?.disconnected).toBe(true)
    expect(byId.get('independent')!.y).toBeGreaterThan(byId.get('dependent')!.y)
    expect(result.edges.map(({ from, to }) => [from, to])).toEqual([['blocker', 'dependent']])
  })
})
