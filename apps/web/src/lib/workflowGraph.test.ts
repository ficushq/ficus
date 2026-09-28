import { expect, test } from 'bun:test'
import { createBlankWorkflow, workflowPresetSchema } from '@ficus/shared'
import { fitWorkflowGraph, layoutWorkflowGraph } from './workflowGraph'
const definition = workflowPresetSchema.parse(
  Bun.YAML.parse(await Bun.file(new URL('../test/fixtures/parallel-flow.yaml', import.meta.url)).text())
).definition
test('parallel preview places sibling checks together and joins before consolidation; rework does not distort progression', () => {
  const graph = layoutWorkflowGraph(definition)
  const node = (id: string) => graph.nodes.find((n) => n.id === id)!
  expect(node('correctness').x).toBe(node('audience').x)
  expect(node('correctness').y).not.toBe(node('audience').y)
  expect(graph.nodes.some((node) => node.kind === 'join')).toBe(false)
  expect(node('consolidate').x).toBeGreaterThan(node('correctness').x)
  expect(
    graph.edges
      .filter((e) => e.to === 'consolidate')
      .map((e) => e.from)
      .sort()
  ).toEqual(['audience', 'correctness'])
  expect(graph.edges.filter((e) => e.rework)).toHaveLength(2)
  expect(graph.nodes.every((n) => n.x >= 0 && n.y >= 0 && n.x < graph.width && n.y < graph.height)).toBe(true)
})
test('incomplete and cyclic drafts remain bounded and display missing destinations', () => {
  const draft = createBlankWorkflow()
  draft.steps[0]!.outcomes.completed = { next: 'execute' }
  expect(Number.isFinite(layoutWorkflowGraph(draft).width)).toBe(true)
  draft.steps[0]!.outcomes.completed = { next: 'missing' }
  expect(layoutWorkflowGraph(draft).nodes.find((n) => n.id === 'missing')!.kind).toBe('missing')
})

test('code hosting preview connects the provider-independent event source to delivery', () => {
  const flow = createBlankWorkflow()
  flow.completion.followChanges = true
  const graph = layoutWorkflowGraph(flow)
  expect(graph.nodes.find((node) => node.kind === 'code-host')?.label).toBe('Code hosting')
  expect(graph.edges).toContainEqual({
    from: 'code-host:delivery',
    to: 'finish',
    label: 'code hosting events → delivery owner',
    rework: false,
  })
})

test('adaptive layout wraps long flows, keeps branch lanes, and does not overlap cards', () => {
  const original = layoutWorkflowGraph(definition)
  const narrow = fitWorkflowGraph(original, 520, 196, 92)
  const wide = fitWorkflowGraph(original, 1100, 196, 92)
  expect(narrow.width).toBeLessThanOrEqual(520)
  expect(narrow.height).toBeGreaterThan(wide.height)
  expect(narrow.edges).toEqual(original.edges)
  expect(narrow.nodes.map((node) => node.id).sort()).toEqual(original.nodes.map((node) => node.id).sort())
  for (const a of narrow.nodes)
    for (const b of narrow.nodes) {
      if (a.id !== b.id) expect(Math.abs(a.x - b.x) >= 196 || Math.abs(a.y - b.y) >= 92).toBe(true)
    }
  const a = narrow.nodes.find((node) => node.id === 'correctness')!
  const b = narrow.nodes.find((node) => node.id === 'audience')!
  expect(a.x).toBe(b.x)
  expect(a.y).not.toBe(b.y)
})

test('auto arrange anchors Start top left and Finish bottom right across viewport sizes', () => {
  for (const width of [300, 520, 900, 1100, 1800]) {
    const graph = fitWorkflowGraph(layoutWorkflowGraph(definition), width, 196, 92)
    const start = graph.nodes.find((node) => node.kind === 'start')!
    const finish = graph.nodes.find((node) => node.kind === 'finish')!
    expect(start.x).toBe(Math.min(...graph.nodes.map((node) => node.x)))
    expect(start.y).toBe(Math.min(...graph.nodes.map((node) => node.y)))
    expect(finish.x).toBe(Math.max(...graph.nodes.map((node) => node.x)))
    expect(finish.y).toBe(Math.max(...graph.nodes.map((node) => node.y)))
    for (const edge of graph.edges.filter((edge) => !edge.rework)) {
      const from = graph.nodes.find((node) => node.id === edge.from)!
      const to = graph.nodes.find((node) => node.id === edge.to)!
      expect(to.y > from.y || to.x > from.x).toBe(true)
    }
  }
})

test('the final connected chain stays adjacent instead of stretching Finish across an empty column', () => {
  const flow = structuredClone(definition)
  const consolidate = flow.steps.find((step) => step.id === 'consolidate')!
  consolidate.outcomes = { completed: { next: 'review' } }
  flow.steps.push(
    { ...structuredClone(consolidate), id: 'review', outcomes: { completed: { next: 'publish' } } },
    { ...structuredClone(consolidate), id: 'publish', outcomes: { completed: { next: 'finish' } } }
  )
  const graph = fitWorkflowGraph(layoutWorkflowGraph(flow), 1100, 196, 92)
  const node = (id: string) => graph.nodes.find((node) => node.id === id)!
  expect(node('review').y).toBe(node('publish').y)
  expect(node('publish').y).toBe(node('finish').y)
  expect(node('publish').x - node('review').x).toBe(196 + 64)
  expect(node('finish').x - node('publish').x).toBe(196 + 64)
  expect(node('review').y - Math.max(node('audience').y, node('correctness').y) - 92).toBe(44)
})

test('code hosting sits below its recipient without taking a column from the normal flow', () => {
  const flow = createBlankWorkflow()
  const withoutEvents = layoutWorkflowGraph(flow)
  flow.completion.followChanges = true
  const withEvents = layoutWorkflowGraph(flow)
  for (const width of [300, 520, 900, 1100, 1800]) {
    const baseline = fitWorkflowGraph(withoutEvents, width, 196, 92)
    const graph = fitWorkflowGraph(withEvents, width, 196, 92)
    const hosting = graph.nodes.find((node) => node.kind === 'code-host')!
    const finish = graph.nodes.find((node) => node.kind === 'finish')!
    expect(graph.nodes.filter((node) => node.kind !== 'code-host')).toEqual(baseline.nodes)
    expect(hosting.x).toBe(finish.x)
    expect(hosting.y).toBeGreaterThanOrEqual(Math.max(...baseline.nodes.map((node) => node.y + 92)) + 44)
    expect(graph.width).toBe(baseline.width)
    expect(graph.height).toBeGreaterThan(hosting.y + 92)
    expect(graph.edges).toEqual(withEvents.edges)
  }
  // Fitting a preview must not mutate the original layout (also used by native previews).
  expect(layoutWorkflowGraph(flow)).toEqual(withEvents)
  expect(withEvents.nodes.find((node) => node.kind === 'code-host')!.x).toBe(
    withEvents.nodes.find((node) => node.kind === 'finish')!.x
  )
})

test('retargeted code hosting aligns with the agent recipient in its own attribute row', () => {
  const flow = createBlankWorkflow()
  flow.completion.followChanges = true
  flow.completion.changeEventsTo = { step: flow.entry }
  const graph = fitWorkflowGraph(layoutWorkflowGraph(flow), 1100, 196, 92)
  const hosting = graph.nodes.find((node) => node.kind === 'code-host')!
  const recipient = graph.nodes.find((node) => node.id === flow.entry)!
  expect(hosting.x).toBe(recipient.x)
  expect(hosting.y).toBeGreaterThan(
    Math.max(...graph.nodes.filter((node) => node !== hosting).map((node) => node.y + 92))
  )
  expect(graph.edges.find((edge) => edge.from === hosting.id)?.to).toBe(flow.entry)
})

test('multiple event attributes share the separate area without overlapping or shifting branch lanes', () => {
  const original = layoutWorkflowGraph(definition)
  const source = { id: 'integration:test', kind: 'integration' as const, label: 'Issue events', x: 24, y: 400 }
  const graph = {
    ...original,
    nodes: [...original.nodes, source, { ...source, id: 'code-host:delivery', kind: 'code-host' as const }],
    edges: [
      ...original.edges,
      { from: source.id, to: 'finish', label: 'events', rework: false, subscriptionId: 'test' },
      { from: 'code-host:delivery', to: 'finish', label: 'events', rework: false },
    ],
  }
  for (const width of [300, 520, 1100]) {
    const fitted = fitWorkflowGraph(graph, width, 196, 92)
    expect(fitted.nodes.filter((node) => node.kind !== 'integration' && node.kind !== 'code-host')).toEqual(
      fitWorkflowGraph(original, width, 196, 92).nodes
    )
    for (const a of fitted.nodes)
      for (const b of fitted.nodes) {
        if (a.id !== b.id) expect(Math.abs(a.x - b.x) >= 196 || Math.abs(a.y - b.y) >= 92).toBe(true)
      }
  }
})
