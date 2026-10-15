import type { WorkflowDefinition } from './workflows'

export interface FlowGraphNode {
  id: string
  kind: 'start' | 'step' | 'fork' | 'join' | 'finish' | 'missing' | 'integration' | 'code-host'
  stepId?: string
  subscriptionId?: string
  label: string
  x: number
  y: number
}
export interface FlowGraphEdge {
  from: string
  to: string
  label: string
  rework: boolean
  returnsToRequester?: boolean
  subscriptionId?: string
}
export interface FlowGraph {
  nodes: FlowGraphNode[]
  edges: FlowGraphEdge[]
  width: number
  height: number
}
export const FLOW_START_ID = '$start'
export const FLOW_NODE_WIDTH = 180
export const FLOW_NODE_HEIGHT = 78

/** Place only new cards in free space; saved coordinates also survive removal and undo. */
export function placeNewWorkflowNodes(
  nodes: FlowGraphNode[],
  positions: Record<string, { x: number; y: number }>,
  width: number,
  height: number,
  viewportWidth: number
) {
  const occupied = nodes.filter((node) => positions[node.id]).map((node) => positions[node.id]!)
  if (!occupied.length) return nodes
  const gap = 24
  return nodes.map((node) => {
    if (positions[node.id]) return node
    const free = (point: { x: number; y: number }) =>
      occupied.every(
        (other) =>
          point.x + width + gap <= other.x ||
          other.x + width + gap <= point.x ||
          point.y + height + gap <= other.y ||
          other.y + height + gap <= point.y
      )
    const candidates = [
      { x: node.x, y: node.y },
      { x: gap, y: 32 },
      ...occupied.flatMap((point) => [
        { x: point.x + width + gap, y: point.y },
        { x: point.x - width - gap, y: point.y },
        { x: point.x, y: point.y + height + gap },
        { x: point.x, y: point.y - height - gap },
      ]),
    ].filter(
      (point) =>
        point.x >= gap &&
        point.y >= 32 &&
        point.x + width + gap <= Math.max(viewportWidth, width + gap * 2) &&
        free(point)
    )
    candidates.sort((a, b) => (a.x - node.x) ** 2 + (a.y - node.y) ** 2 - ((b.x - node.x) ** 2 + (b.y - node.y) ** 2))
    const point = candidates[0] ?? { x: gap, y: Math.max(...occupied.map((other) => other.y + height + gap)) }
    occupied.push(point)
    return { ...node, ...point }
  })
}

const isWorkflowAttribute = (node: FlowGraphNode) => node.kind === 'integration' || node.kind === 'code-host'

/** Event sources configure recipients; they do not occupy ranks in the execution flow. */
function placeWorkflowAttributes(
  nodes: FlowGraphNode[],
  edges: FlowGraphEdge[],
  nodeWidth: number,
  nodeHeight: number,
  gap: number
) {
  const flow = nodes.filter((node) => !isWorkflowAttribute(node))
  const top = Math.max(0, ...flow.map((node) => node.y + nodeHeight)) + gap
  const placed: FlowGraphNode[] = []
  for (const node of nodes.filter(isWorkflowAttribute)) {
    const recipient = edges
      .filter((edge) => edge.from === node.id)
      .map((edge) => flow.find((candidate) => candidate.id === edge.to))
      .find((candidate) => candidate !== undefined)
    node.x = (recipient ?? flow.find((candidate) => candidate.kind === 'finish') ?? flow[0])?.x ?? 32
    node.y = top
    while (placed.some((other) => Math.abs(other.x - node.x) < nodeWidth && other.y === node.y)) {
      node.y += nodeHeight + gap
    }
    placed.push(node)
  }
}

/** Pure, bounded layout: draft graphs may be incomplete or cyclic while editing. */
export function layoutWorkflowGraph(definition: WorkflowDefinition): FlowGraph {
  const nodes: FlowGraphNode[] = definition.steps.map((step) => ({
    id: step.id,
    stepId: step.id,
    kind: 'step',
    label: step.name ?? step.id,
    x: 0,
    y: 0,
  }))
  nodes.unshift({ id: FLOW_START_ID, kind: 'start', label: 'Start', x: 0, y: 0 })
  const edges: FlowGraphEdge[] = definition.steps.some((step) => step.id === definition.entry)
    ? [{ from: FLOW_START_ID, to: definition.entry, label: 'starts', rework: false }]
    : []
  const addNode = (id: string, kind: FlowGraphNode['kind'], label: string, stepId?: string) => {
    if (!nodes.some((n) => n.id === id)) nodes.push({ id, kind, label, stepId, x: 0, y: 0 })
  }
  for (const step of definition.steps)
    for (const [outcome, target] of Object.entries(step.outcomes)) {
      if ('parallel' in target) {
        for (const entry of target.parallel) edges.push({ from: step.id, to: entry, label: outcome, rework: false })
      } else if ('returnTo' in target) {
        edges.push({
          from: step.id,
          to: target.returnTo,
          label: outcome,
          returnsToRequester: target.afterRework === 'return-to-requester',
          rework: true,
        })
      } else {
        const to = target.next
        if (to === 'finish') addNode(to, 'finish', 'Finish')
        edges.push({ from: step.id, to, label: outcome, rework: false })
      }
    }
  for (const edge of edges)
    for (const id of [edge.from, edge.to]) if (!nodes.some((node) => node.id === id)) addNode(id, 'missing', id)
  const outgoing = new Map(nodes.map((node) => [node.id, new Set<string>()]))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  for (const edge of edges.filter((e) => !e.rework)) {
    if (!outgoing.get(edge.from)!.has(edge.to)) {
      outgoing.get(edge.from)!.add(edge.to)
      indegree.set(edge.to, indegree.get(edge.to)! + 1)
    }
  }
  const ranks = new Map(nodes.map((node) => [node.id, 0]))
  const queue = nodes.filter((n) => !indegree.get(n.id)).map((n) => n.id)
  const visited = new Set<string>()
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    visited.add(id)
    for (const next of outgoing.get(id)!) {
      ranks.set(next, Math.max(ranks.get(next)!, ranks.get(id)! + 1))
      indegree.set(next, indegree.get(next)! - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  // Keep malformed drafts visible without repeatedly chasing their cycles.
  const fallback = Math.max(0, ...ranks.values()) + 1
  const rows = new Map<number, number>()
  for (const node of nodes) {
    const rank = visited.has(node.id) ? ranks.get(node.id)! : fallback
    const row = rows.get(rank) ?? 0
    rows.set(rank, row + 1)
    node.x = 24 + rank * 240
    node.y = 94 + row * 116
  }
  const integrationY = Math.max(220, ...nodes.map((node) => node.y + FLOW_NODE_HEIGHT + 70))
  for (const [index, subscription] of (definition.subscriptions ?? []).entries()) {
    const id = 'integration:' + subscription.id
    nodes.push({
      id,
      kind: 'integration',
      subscriptionId: subscription.id,
      label: subscription.source.integration + ' · ' + subscription.id,
      x: 24 + (index % 4) * 240,
      y: integrationY + Math.floor(index / 4) * 116,
    })
    const target = subscription.deliver.to
    const consumers =
      target === 'delivery-owner'
        ? ['finish']
        : definition.steps
            .filter(
              (step) =>
                step.kind === 'agent' &&
                (target === 'active' ||
                  (typeof target === 'object' &&
                    ('participant' in target ? step.participant === target.participant : step.id === target.step)))
            )
            .map((step) => step.id)
    for (const consumer of consumers) {
      if (!nodes.some((node) => node.id === consumer)) continue
      edges.push({
        from: id,
        to: consumer,
        label: subscription.source.output,
        rework: false,
        subscriptionId: subscription.id,
      })
    }
  }
  if (definition.completion.followChanges) {
    const index = definition.subscriptions?.length ?? 0
    nodes.push({
      id: 'code-host:delivery',
      kind: 'code-host',
      label: 'Code hosting',
      x: 24 + (index % 4) * 240,
      y: integrationY + Math.floor(index / 4) * 116,
    })
    const recipient = definition.completion.changeEventsTo
    const target = typeof recipient === 'object' ? recipient.step : 'finish'
    if (nodes.some((node) => node.id === target))
      edges.push({
        from: 'code-host:delivery',
        to: target,
        label: typeof recipient === 'object' ? 'code hosting change events' : 'code hosting events → delivery owner',
        rework: false,
      })
  }
  placeWorkflowAttributes(nodes, edges, FLOW_NODE_WIDTH, FLOW_NODE_HEIGHT, 44)
  return {
    nodes,
    edges,
    width: Math.max(260, ...nodes.map((n) => n.x + FLOW_NODE_WIDTH + 24)),
    height: Math.max(220, ...nodes.map((n) => n.y + FLOW_NODE_HEIGHT + 26)),
  }
}

/** Keep branch groups together and pack each continuation beside its downstream neighbors. */
export function fitWorkflowGraph(graph: FlowGraph, width: number, nodeWidth: number, nodeHeight: number): FlowGraph {
  const gapX = 64,
    gapY = 44,
    padding = 32
  const columns = Math.max(1, Math.floor((width - padding * 2 + gapX) / (nodeWidth + gapX)))
  const middle = graph.nodes.filter(
    (node) => node.kind !== 'start' && node.kind !== 'finish' && !isWorkflowAttribute(node)
  )
  const ranks = [...new Set(middle.map((node) => node.x))].sort((a, b) => a - b)
  const groups = [
    graph.nodes.filter((node) => node.kind === 'start'),
    ...ranks.map((rank) => middle.filter((node) => node.x === rank).sort((a, b) => a.y - b.y)),
    graph.nodes.filter((node) => node.kind === 'finish'),
  ].filter((group) => group.length)
  const occupiedColumns = Math.min(columns, groups.length)
  const nodes: FlowGraphNode[] = []
  // Leave room above the first row for return arrows as well as the cards.
  let top = padding + 40
  for (let offset = 0; offset < groups.length; offset += columns) {
    const band = groups.slice(offset, offset + columns)
    const lanes = Math.max(1, ...band.map((group) => group.length))
    // Right-align the whole final group, not just Finish. Its predecessor stays next
    // to it, and the previous row connects across a shorter distance.
    const firstColumn = offset === 0 ? 0 : occupiedColumns - band.length
    band.forEach((group, column) => {
      group.forEach((node, lane) => {
        const finish = node.kind === 'finish'
        nodes.push({
          ...node,
          x: padding + (firstColumn + column) * (nodeWidth + gapX),
          y: top + (finish ? lanes - 1 : lane) * (nodeHeight + gapY),
        })
      })
    })
    top += lanes * (nodeHeight + gapY)
  }
  nodes.push(...graph.nodes.filter(isWorkflowAttribute).map((node) => ({ ...node })))
  placeWorkflowAttributes(nodes, graph.edges, nodeWidth, nodeHeight, gapY)
  return {
    ...graph,
    nodes,
    width: Math.max(nodeWidth + padding * 2, ...nodes.map((node) => node.x + nodeWidth + padding)),
    height: Math.max(nodeHeight + padding * 2, ...nodes.map((node) => node.y + nodeHeight + padding)),
  }
}

/** Round each bend while keeping the route and its control points within the supplied bounds. */
export function roundedFlowPath(points: { x: number; y: number }[], radius = 28): string {
  const start = points[0]
  if (!start) return ''
  let path = `M ${start.x} ${start.y}`
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1]!,
      corner = points[index]!,
      after = points[index + 1]!
    const incoming = Math.hypot(corner.x - before.x, corner.y - before.y)
    const outgoing = Math.hypot(after.x - corner.x, after.y - corner.y)
    if (!incoming || !outgoing) continue
    const bend = Math.min(radius, incoming / 2, outgoing / 2)
    const entry = {
      x: corner.x + ((before.x - corner.x) * bend) / incoming,
      y: corner.y + ((before.y - corner.y) * bend) / incoming,
    }
    const exit = {
      x: corner.x + ((after.x - corner.x) * bend) / outgoing,
      y: corner.y + ((after.y - corner.y) * bend) / outgoing,
    }
    path += ` L ${entry.x} ${entry.y} Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`
  }
  const end = points.at(-1)!
  return `${path} L ${end.x} ${end.y}`
}
