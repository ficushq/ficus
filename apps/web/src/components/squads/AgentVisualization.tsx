import { useGraphModulesReady } from './useGraphModulesReady'
import { agentGraphColor, graphColor } from '../../theme/graph'
import { useThemeColors } from '../../theme/useThemeColors'
import { useState, useMemo, useCallback, useRef, useEffect, lazy, Suspense } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AgentInboxPanel } from './AgentInboxPanel'
import { InboxIcon } from '../icons'
import { AGENT_STATUS_ROLE, type Agent } from '@ficus/shared'
import { getAgentPrimaryLabel } from '../../lib/agentDisplay'
import { webStatus } from '../../lib/statusPresentation'
import { CanvasSkeleton } from '../loading/Skeleton'
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl'

// Lazy load force graph components
const ForceGraph2DLazy = lazy(() => import('react-force-graph-2d'))
const ForceGraph3DLazy = lazy(() => import('react-force-graph-3d'))

// Lazy imports for 3D labels
let SpriteText: any = null
let ThreeGroup: any = null
const spriteTextReady = Promise.all([
  import('three-spritetext').then((mod) => {
    SpriteText = mod.default
  }),
  import('three').then((mod) => {
    ThreeGroup = mod.Group
  }),
])

const GRAPH_VIEW_OPTIONS: SegmentedControlOption<'2d' | '3d'>[] = [
  { value: '2d', label: '2D' },
  { value: '3d', label: '3D' },
]

interface Props {
  agents: Agent[]
  squadId: string
  isLoading?: boolean
}

interface AgentNode {
  id: string
  name: string
  type: string
  status: string
  val: number
  x?: number
  y?: number
  z?: number
}

interface GraphData {
  nodes: AgentNode[]
  links: { source: string; target: string }[]
}

export function AgentVisualization({ agents, squadId: _squadId, isLoading }: Props) {
  const colors = useThemeColors()
  const [, setSearchParams] = useSearchParams()
  const [is3D, setIs3D] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [showInbox, setShowInbox] = useState(false)
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 400 })
  const spriteTextLoaded = useGraphModulesReady(is3D, spriteTextReady)
  const fgRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Build graph data
  const graphData = useMemo<GraphData>(() => {
    if (agents.length === 0) return { nodes: [], links: [] }

    const nodes: AgentNode[] = agents.map((agent) => ({
      id: agent.id,
      name: getAgentPrimaryLabel(agent),
      type: agent.agentTypeId,
      status: agent.status,
      val: agent.status === 'active' ? 12 : 8,
    }))

    const links: { source: string; target: string }[] = []
    if (agents.length > 1) {
      const hubId = agents[0].id
      agents.slice(1).forEach((agent) => {
        links.push({ source: hubId, target: agent.id })
      })
    }

    return { nodes, links }
  }, [agents])

  // Handle node click
  const handleNodeClick = useCallback(
    (node: any) => {
      const agent = agents.find((a) => a.id === node.id)
      if (agent) {
        setSelectedAgent(agent)
        setShowInbox(false)
      }
    },
    [agents]
  )

  // Custom node rendering for 2D with pulse animation
  const paintNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const radius = node.status === 'active' ? 12 : 10
      const x = node.x
      const y = node.y

      // Pulse effect for active agents
      if (node.status === 'active') {
        const pulseRadius = radius + 4 + Math.sin(Date.now() / 200) * 2
        ctx.beginPath()
        ctx.arc(x, y, pulseRadius, 0, 2 * Math.PI)
        ctx.strokeStyle = agentGraphColor(colors, 'active')
        ctx.lineWidth = 2 / globalScale
        ctx.stroke()
      }

      // Pulse effect for waiting-input agents (human-wait, slower)
      if (node.status === 'waiting-input') {
        const pulseRadius = radius + 4 + Math.sin(Date.now() / 400) * 3
        ctx.beginPath()
        ctx.arc(x, y, pulseRadius, 0, 2 * Math.PI)
        ctx.strokeStyle = agentGraphColor(colors, 'waiting-input')
        ctx.lineWidth = 2 / globalScale
        ctx.stroke()
      }

      // Selection ring
      if (selectedAgent?.id === node.id) {
        ctx.beginPath()
        ctx.arc(x, y, radius + 6, 0, 2 * Math.PI)
        ctx.strokeStyle = graphColor(colors, '--graph-node-selected')
        ctx.lineWidth = 3 / globalScale
        ctx.stroke()
      }

      // Node circle
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, 2 * Math.PI)
      ctx.fillStyle = agentGraphColor(colors, node.status)
      ctx.fill()
      ctx.strokeStyle = graphColor(colors, '--graph-node-border')
      ctx.lineWidth = 1.5 / globalScale
      ctx.stroke()

      // Keep a large graph readable at overview scale; nodes remain clickable.
      if (
        agents.length > 20 &&
        globalScale < 1.4 &&
        selectedAgent?.id !== node.id &&
        node.status !== 'active' &&
        node.status !== 'waiting-input'
      )
        return

      // Agent name (below node)
      const fontSize = Math.max(10 / globalScale, 8)
      ctx.font = `bold ${fontSize}px Sans-Serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = graphColor(colors, '--graph-label')
      const displayName = node.name.length > 14 ? node.name.slice(0, 12) + '…' : node.name
      ctx.fillText(displayName, x, y + radius + 3)

      // Agent type (below name)
      ctx.font = `${fontSize * 0.8}px Sans-Serif`
      ctx.fillStyle = graphColor(colors, '--graph-label-muted')
      const displayType = node.type.length > 14 ? node.type.slice(0, 12) + '…' : node.type
      ctx.fillText(displayType, x, y + radius + 3 + fontSize * 1.1)
    },
    [selectedAgent, agents.length, colors]
  )

  // Configure forces for better spacing, then fit to view
  useEffect(() => {
    if (!fgRef.current || graphData.nodes.length === 0 || dimensions.width === 0) return

    const fg = fgRef.current
    // Increase charge repulsion so nodes push apart
    fg.d3Force?.('charge')?.strength(-300).distanceMax(400)
    // Increase link distance so connected nodes aren't too close
    fg.d3Force?.('link')?.distance(100)
    // Reheat simulation with new forces
    fg.d3ReheatSimulation?.()

    const timer = setTimeout(() => {
      fg.zoomToFit?.(400, 80)
    }, 500)
    return () => clearTimeout(timer)
  }, [graphData, is3D, dimensions])

  const hasAgents = agents.length > 0

  // Reattach after the loading/empty view gives way to the graph container.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect
        if (width > 0) {
          setDimensions({ width, height: 400 })
        }
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasAgents])

  if (isLoading && agents.length === 0) {
    return <CanvasSkeleton label="Loading agent graph" className="h-[400px]" />
  }

  if (agents.length === 0) {
    return (
      <div className="text-center py-12 text-muted">
        <p className="text-lg">No agents in this squad yet</p>
        <p className="text-sm mt-1">Agents will appear here when work begins.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Graph container */}
      <div className="flex-1 min-w-0">
        <div className="relative">
          {/* 2D/3D Toggle */}
          <SegmentedControl
            ariaLabel="Graph view"
            size="compact"
            className="absolute top-2 right-2 z-10"
            options={GRAPH_VIEW_OPTIONS}
            value={is3D ? '3d' : '2d'}
            onChange={(view) => setIs3D(view === '3d')}
          />

          {/* Graph */}
          <div
            ref={containerRef}
            className="border border-th-border rounded-lg overflow-hidden bg-[rgb(var(--graph-bg))]"
            style={{ height: 400 }}
          >
            {dimensions.width === 0 ? (
              <CanvasSkeleton label="Preparing agent graph" className="h-full" />
            ) : (
              <Suspense fallback={<CanvasSkeleton label="Loading agent graph" className="h-full" />}>
                {dimensions.width > 0 &&
                  (is3D ? (
                    <ForceGraph3DLazy
                      ref={fgRef}
                      width={dimensions.width}
                      height={dimensions.height}
                      graphData={graphData}
                      nodeLabel={(node: any) => `${node.name} (${node.type})\nStatus: ${node.status}`}
                      nodeColor={(node: any) =>
                        selectedAgent?.id === node.id
                          ? graphColor(colors, '--graph-node-selected-3d')
                          : agentGraphColor(colors, node.status)
                      }
                      nodeVal={(node: any) => (selectedAgent?.id === node.id ? (node.val ?? 8) * 2 : node.val)}
                      nodeOpacity={0.9}
                      linkOpacity={1}
                      linkColor={() => graphColor(colors, '--graph-link-4')}
                      linkWidth={1}
                      onNodeClick={handleNodeClick}
                      backgroundColor={graphColor(colors, '--graph-bg')}
                      showNavInfo={false}
                      {...(spriteTextLoaded && SpriteText && ThreeGroup
                        ? {
                            nodeThreeObjectExtend: true,
                            nodeThreeObject: (node: any) => {
                              const group = new ThreeGroup()
                              const nameLabel = new SpriteText(node.name)
                              nameLabel.color = graphColor(colors, '--graph-label')
                              nameLabel.textHeight = 3
                              nameLabel.position.y = -10
                              group.add(nameLabel)
                              const typeLabel = new SpriteText(node.type)
                              typeLabel.color = graphColor(colors, '--graph-label-muted')
                              typeLabel.textHeight = 2.2
                              typeLabel.position.y = -14
                              group.add(typeLabel)
                              return group
                            },
                          }
                        : {})}
                    />
                  ) : (
                    <ForceGraph2DLazy
                      ref={fgRef}
                      width={dimensions.width}
                      height={dimensions.height}
                      graphData={graphData}
                      nodeCanvasObject={paintNode}
                      nodeLabel={(node: any) => {
                        const label = document.createElement('span')
                        label.textContent = `${node.name} (${node.type}) — ${node.status}`
                        return label.innerHTML
                      }}
                      nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
                        ctx.fillStyle = color
                        ctx.beginPath()
                        ctx.arc(node.x, node.y, 15, 0, 2 * Math.PI)
                        ctx.fill()
                      }}
                      linkColor={() => graphColor(colors, '--graph-link-4')}
                      linkWidth={1}
                      onNodeClick={handleNodeClick}
                      backgroundColor={graphColor(colors, '--graph-bg')}
                      d3VelocityDecay={0.3}
                      d3AlphaDecay={0.02}
                    />
                  ))}
              </Suspense>
            )}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 text-xs text-muted">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-[rgb(var(--graph-legend-idle))]" />
              <span>Idle</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-status-progress-solid" />
              <span>Active</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`w-3 h-3 rounded-full ${webStatus(AGENT_STATUS_ROLE['waiting-input']).markerClass}`} />
              <span>Waiting Input</span>
            </div>
          </div>
        </div>
      </div>

      {/* Agent details panel */}
      {selectedAgent && !showInbox && (
        <div className="w-full lg:w-72 shrink-0 py-4 lg:px-4 lg:border-l border-panel-border">
          <h3 className="font-semibold text-primary">{getAgentPrimaryLabel(selectedAgent)}</h3>
          <p className="text-sm text-muted mt-1">{selectedAgent.agentTypeId}</p>

          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">ID</dt>
              <dd className="text-primary font-mono text-xs">{selectedAgent.id.slice(0, 8)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Status</dt>
              <dd className="text-primary capitalize">{selectedAgent.status.replace('-', ' ')}</dd>
            </div>
          </dl>

          <div className="mt-4 space-y-2">
            <button
              onClick={() => setShowInbox(true)}
              className="ficus-button ficus-button-primary w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-md"
            >
              <InboxIcon className="w-4 h-4" />
              View Inbox
            </button>
            <button
              onClick={() => {
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev)
                  next.set('tab', 'threads')
                  next.set('agent', selectedAgent.id)
                  return next
                })
              }}
              className="ficus-button ficus-button-secondary w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-md"
            >
              Open Chat
            </button>
          </div>
        </div>
      )}

      {/* Inbox panel */}
      {selectedAgent && showInbox && <AgentInboxPanel agent={selectedAgent} onClose={() => setShowInbox(false)} />}
    </div>
  )
}
