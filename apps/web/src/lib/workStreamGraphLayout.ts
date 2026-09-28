import { compareCanonicalWorkStreams, type WorkStream } from '@ficus/shared'

export const WORK_STREAM_GRAPH_NODE_WIDTH = 240
export const WORK_STREAM_GRAPH_NODE_HEIGHT = 128
const COLUMN_GAP = 96
const ROW_GAP = 28
const CLUSTER_GAP = 72
const PADDING = 24

export interface WorkStreamGraphNodeLayout {
  id: string
  x: number
  y: number
  layer: number
  unresolved: boolean
  disconnected: boolean
}

export interface WorkStreamGraphEdgeLayout {
  from: string
  to: string
  points: Array<{ x: number; y: number }>
}

export interface WorkStreamGraphLayout {
  nodes: WorkStreamGraphNodeLayout[]
  edges: WorkStreamGraphEdgeLayout[]
  width: number
  height: number
}

const compareStreams = compareCanonicalWorkStreams

/** Iteratively lays out open work streams. Missing blockers are ignored and cycles degrade safely. */
export function layoutWorkStreamGraph(streams: WorkStream[]): WorkStreamGraphLayout {
  const streamById = new Map(streams.map((stream) => [stream.id, stream]))
  const blockers = new Map<string, Set<string>>()
  const connected = new Set<string>()
  const edges: Array<{ from: string; to: string }> = []

  for (const stream of streams) {
    const openBlockers = new Set(stream.dependsOn.filter((id) => streamById.has(id)))
    blockers.set(stream.id, openBlockers)
    for (const blockerId of openBlockers) {
      connected.add(blockerId)
      connected.add(stream.id)
      edges.push({ from: blockerId, to: stream.id })
    }
  }

  const connectedStreams = streams.filter((stream) => connected.has(stream.id))
  const layers = new Map<string, number>()
  for (let pass = 0; pass < connectedStreams.length; pass += 1) {
    let changed = false
    for (const stream of connectedStreams) {
      if (layers.has(stream.id)) continue
      const streamBlockers = blockers.get(stream.id) ?? new Set()
      if (streamBlockers.size === 0 || [...streamBlockers].every((id) => layers.has(id))) {
        const layer = streamBlockers.size === 0 ? 0 : 1 + Math.max(...[...streamBlockers].map((id) => layers.get(id)!))
        layers.set(stream.id, layer)
        changed = true
      }
    }
    if (!changed) break
  }

  const unresolved = connectedStreams.filter((stream) => !layers.has(stream.id))
  if (unresolved.length > 0) {
    console.warn(
      'Work-stream dependency graph contains a cycle; rendering unresolved nodes separately',
      unresolved.map((s) => s.id)
    )
    const unresolvedLayer = layers.size > 0 ? Math.max(...layers.values()) + 1 : 0
    for (const stream of unresolved) layers.set(stream.id, unresolvedLayer)
  }

  const byLayer = new Map<number, WorkStream[]>()
  for (const stream of connectedStreams) {
    const layer = layers.get(stream.id) ?? 0
    const group = byLayer.get(layer) ?? []
    group.push(stream)
    byLayer.set(layer, group)
  }
  for (const group of byLayer.values()) group.sort(compareStreams)

  const nodes: WorkStreamGraphNodeLayout[] = []
  let connectedHeight = 0
  for (const layer of [...byLayer.keys()].sort((a, b) => a - b)) {
    const group = byLayer.get(layer)!
    group.forEach((stream, index) => {
      const y = PADDING + index * (WORK_STREAM_GRAPH_NODE_HEIGHT + ROW_GAP)
      connectedHeight = Math.max(connectedHeight, y + WORK_STREAM_GRAPH_NODE_HEIGHT)
      nodes.push({
        id: stream.id,
        x: PADDING + layer * (WORK_STREAM_GRAPH_NODE_WIDTH + COLUMN_GAP),
        y,
        layer,
        unresolved: unresolved.some((item) => item.id === stream.id),
        disconnected: false,
      })
    })
  }

  const disconnected = streams.filter((stream) => !connected.has(stream.id)).sort(compareStreams)
  const disconnectedY = connectedStreams.length > 0 ? connectedHeight + CLUSTER_GAP : PADDING
  disconnected.forEach((stream, index) => {
    nodes.push({
      id: stream.id,
      x: PADDING + index * (WORK_STREAM_GRAPH_NODE_WIDTH + ROW_GAP),
      y: disconnectedY,
      layer: 0,
      unresolved: false,
      disconnected: true,
    })
  })

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const routedEdges: WorkStreamGraphEdgeLayout[] = edges.map(({ from, to }) => {
    const source = nodeById.get(from)!
    const target = nodeById.get(to)!
    return {
      from,
      to,
      points: [
        { x: source.x + WORK_STREAM_GRAPH_NODE_WIDTH, y: source.y + WORK_STREAM_GRAPH_NODE_HEIGHT / 2 },
        { x: target.x, y: target.y + WORK_STREAM_GRAPH_NODE_HEIGHT / 2 },
      ],
    }
  })

  return {
    nodes,
    edges: routedEdges,
    width: Math.max(480, ...nodes.map((node) => node.x + WORK_STREAM_GRAPH_NODE_WIDTH + PADDING)),
    height: Math.max(180, ...nodes.map((node) => node.y + WORK_STREAM_GRAPH_NODE_HEIGHT + PADDING)),
  }
}
