import { useGraphModulesReady } from './useGraphModulesReady'
import { agentGraphColor, squadGraphColor, relationshipGraphColor, graphColor } from '../../theme/graph'
import { useThemeColors } from '../../theme/useThemeColors'
import { useState, useMemo, useCallback, useRef, useEffect, lazy, Suspense } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { listSquadAgents } from '../../api/squads'
import { useSquadSlugs } from '../../hooks/useSquadSlugs'
import { CanvasSkeleton } from '../loading/Skeleton'
import { AGENT_STATUS_ROLE, type Squad, type SquadRelationship, type Agent } from '@ficus/shared'
import { getAgentPrimaryLabel } from '../../lib/agentDisplay'
import { webStatus } from '../../lib/statusPresentation'

// Lazy load 3D force graph (use standalone package — the combined react-force-graph pulls in aframe)
const ForceGraph3DLazy = lazy(() => import('react-force-graph-3d'))

// Lazy imports for 3D labels (same as AgentVisualization)
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

interface Props {
  squads: Squad[]
  relationships: SquadRelationship[]
}

interface UniverseNode {
  id: string
  name: string
  type: 'squad' | 'agent'
  status: string
  val: number
  squadId?: string
  purpose?: string
  agentCount?: number
  agentTypeId?: string
  x?: number
  y?: number
  z?: number
  fx?: number
  fy?: number
  fz?: number
}

interface UniverseLink {
  source: string
  target: string
  type: 'squad-relationship' | 'agent-to-squad'
  relationshipType?: string
  width: number
}

interface GraphData {
  nodes: UniverseNode[]
  links: UniverseLink[]
}

export function SquadUniverse({ squads, relationships }: Props) {
  const colors = useThemeColors()
  const navigate = useNavigate()
  const { slugFor } = useSquadSlugs()
  const spriteTextLoaded = useGraphModulesReady(true, spriteTextReady)
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 600 })
  const fgRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hoveredNode, setHoveredNode] = useState<UniverseNode | null>(null)

  // Fetch agents for all squads
  const agentQueries = useQueries({
    queries: squads.map((squad) => ({
      queryKey: ['squad-agents', squad.id],
      queryFn: () => listSquadAgents(squad.id),
      refetchInterval: 30000,
    })),
  })

  // Combine all agents with their squad info
  const allAgents = useMemo(() => {
    const agents: { agent: Agent; squadId: string }[] = []
    squads.forEach((squad, i) => {
      const squadAgents = agentQueries[i]?.data || []
      squadAgents.forEach((agent) => {
        agents.push({ agent, squadId: squad.id })
      })
    })
    return agents
  }, [squads, agentQueries])

  // Build the combined graph data
  const graphData = useMemo<GraphData>(() => {
    if (squads.length === 0) return { nodes: [], links: [] }

    const nodes: UniverseNode[] = []
    const links: UniverseLink[] = []

    // Add squad nodes (larger) — let force simulation position them like AgentVisualization
    squads.forEach((squad, i) => {
      const squadAgents = agentQueries[i]?.data || []
      nodes.push({
        id: squad.id,
        name: squad.name,
        type: 'squad',
        status: squad.status,
        purpose: squad.purpose,
        agentCount: squadAgents.length,
        val: 40 + squadAgents.length * 5,
      })
    })

    // Add agent nodes (smaller, clustered around their squad)
    allAgents.forEach(({ agent, squadId }) => {
      nodes.push({
        id: agent.id,
        name: getAgentPrimaryLabel(agent),
        type: 'agent',
        status: agent.status,
        squadId,
        agentTypeId: agent.agentTypeId,
        val: agent.status === 'active' ? 8 : 5,
      })

      // Link agent to their squad
      links.push({
        source: agent.id,
        target: squadId,
        type: 'agent-to-squad',
        width: 0.5,
      })
    })

    // Filter links to only reference nodes that exist in the graph
    const nodeIds = new Set(nodes.map((n) => n.id))
    const safeLinks = links.filter((l) => l.source && l.target && nodeIds.has(l.source) && nodeIds.has(l.target))

    // Add squad relationship links (only if both squads are in the graph)
    relationships.forEach((rel) => {
      if (!nodeIds.has(rel.sourceSquadId) || !nodeIds.has(rel.targetSquadId)) return
      safeLinks.push({
        source: rel.sourceSquadId,
        target: rel.targetSquadId,
        type: 'squad-relationship',
        relationshipType: rel.relationshipType,
        width: 3,
      })
    })

    return { nodes, links: safeLinks }
  }, [squads, relationships, allAgents, agentQueries])

  // Handle node click
  const handleNodeClick = useCallback(
    (node: any) => {
      if (node.type === 'squad') {
        navigate(`/squads/${slugFor(node.id)}`)
      } else if (node.type === 'agent') {
        navigate(`/chat/${node.id}`)
      }
    },
    [navigate, slugFor]
  )

  // Handle node hover
  const handleNodeHover = useCallback((node: any) => {
    setHoveredNode(node)
  }, [])

  // Configure forces for tighter clustering
  useEffect(() => {
    if (!fgRef.current || graphData.nodes.length === 0 || dimensions.width === 0) return

    const fg = fgRef.current
    fg.d3Force?.('charge')?.strength(-150).distanceMax(200)
    fg.d3Force?.('link')?.distance(50)
    fg.d3ReheatSimulation?.()
  }, [graphData, dimensions])

  // Fit to view when simulation stops
  const handleEngineStop = useCallback(() => {
    fgRef.current?.zoomToFit?.(400, 80)
  }, [])

  // Measure container dimensions (ResizeObserver + fallback for zero-dimension edge cases)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const measure = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setDimensions({ width: rect.width, height: rect.height })
      }
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          setDimensions({ width, height })
        } else {
          // contentRect can report 0 initially; fallback to getBoundingClientRect
          measure()
        }
      }
    })
    observer.observe(el)
    measure() // Initial measurement in case ResizeObserver fires late
    const fallback = setTimeout(measure, 100) // Fallback if layout completes after observer
    return () => {
      observer.disconnect()
      clearTimeout(fallback)
    }
  }, [])

  if (squads.length === 0) {
    return (
      <div className="text-center py-12 text-muted">
        <p className="text-lg">No squads to visualize</p>
        <p className="text-sm mt-1">Create squads to see them in the universe view.</p>
      </div>
    )
  }

  return (
    <div className="relative w-full h-[600px] min-h-[600px]">
      {/* Info panel */}
      {hoveredNode && (
        <div className="absolute top-4 left-4 z-10 bg-surface/95 border border-th-border rounded-lg p-3 max-w-xs pointer-events-none">
          <div className="flex items-center gap-2 mb-2">
            <span
              className="w-3 h-3 rounded-full"
              style={{
                backgroundColor:
                  hoveredNode.type === 'squad'
                    ? squadGraphColor(colors, hoveredNode.status)
                    : agentGraphColor(colors, hoveredNode.status as Agent['status']),
              }}
            />
            <span className="font-semibold text-primary">{hoveredNode.name}</span>
            <span className="text-xs text-muted px-1.5 py-0.5 bg-surface-secondary rounded">{hoveredNode.type}</span>
          </div>
          <p className="text-sm text-muted capitalize">Status: {hoveredNode.status}</p>
          {hoveredNode.type === 'squad' && hoveredNode.purpose && (
            <p className="text-sm text-secondary mt-1">{hoveredNode.purpose}</p>
          )}
          {hoveredNode.type === 'squad' && hoveredNode.agentCount !== undefined && (
            <p className="text-xs text-muted mt-1">{hoveredNode.agentCount} agents</p>
          )}
          <p className="text-xs text-accent-light mt-2">Click to open</p>
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-10 bg-surface/95 border border-th-border rounded-lg p-3">
        <div className="text-xs font-medium text-muted mb-2">Squads</div>
        <div className="flex gap-3 mb-3">
          <div className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full bg-status-success-solid" />
            <span className="text-xs text-muted">Active</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full bg-[rgb(var(--graph-legend-paused))]" />
            <span className="text-xs text-muted">Paused</span>
          </div>
        </div>
        <div className="text-xs font-medium text-muted mb-2">Agents</div>
        <div className="flex gap-3 mb-3">
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-[rgb(var(--graph-legend-idle))]" />
            <span className="text-xs text-muted">Idle</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-status-progress-solid" />
            <span className="text-xs text-muted">Active</span>
          </div>
          <div className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full ${webStatus(AGENT_STATUS_ROLE['waiting-input']).markerClass}`} />
            <span className="text-xs text-muted">Waiting</span>
          </div>
        </div>
        <div className="text-xs font-medium text-muted mb-2">Relationships</div>
        <div className="flex gap-3">
          <div className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-status-neutral-solid" />
            <span className="text-xs text-muted">Reports</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-status-progress-solid" />
            <span className="text-xs text-muted">Collab</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-status-success-solid" />
            <span className="text-xs text-muted">Depends</span>
          </div>
        </div>
      </div>

      {/* Controls hint */}
      <div className="absolute top-4 right-4 z-10 bg-surface/95 border border-th-border rounded-lg p-2 text-xs text-muted">
        <p>🖱️ Drag to rotate</p>
        <p>🔍 Scroll to zoom</p>
        <p>👆 Click node to open</p>
      </div>

      {/* 3D Graph */}
      <div
        ref={containerRef}
        className="w-full h-full rounded-lg overflow-hidden border border-th-border bg-[rgb(var(--graph-loading-bg))]"
      >
        {dimensions.width === 0 ? (
          <CanvasSkeleton label="Preparing squad universe" className="h-full" />
        ) : (
          <Suspense fallback={<CanvasSkeleton label="Loading squad universe" className="h-full" />}>
            <ForceGraph3DLazy
              ref={fgRef}
              width={dimensions.width}
              height={dimensions.height}
              graphData={graphData}
              nodeLabel={(node: any) =>
                node.type === 'squad' ? `${node.name}\n${node.purpose || ''}` : `${node.name}\n${node.type}`
              }
              nodeColor={(node: any) =>
                node.type === 'squad' ? squadGraphColor(colors, node.status) : agentGraphColor(colors, node.status)
              }
              nodeVal={(node: any) => node.val ?? 5}
              nodeOpacity={0.9}
              linkOpacity={1}
              linkColor={(link: any) =>
                link.type === 'agent-to-squad'
                  ? graphColor(colors, '--graph-link-5')
                  : relationshipGraphColor(colors, link.relationshipType)
              }
              linkWidth={(link: any) => link.width}
              linkDirectionalArrowLength={(link: any) => (link.type === 'squad-relationship' ? 6 : 0)}
              linkDirectionalArrowRelPos={1}
              onNodeClick={handleNodeClick}
              onNodeHover={handleNodeHover}
              onEngineStop={handleEngineStop}
              cooldownTicks={200}
              backgroundColor={graphColor(colors, '--graph-bg')}
              showNavInfo={false}
              d3AlphaDecay={0.02}
              d3VelocityDecay={0.3}
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
                      const subLabel = new SpriteText(
                        node.type === 'squad' ? node.purpose || '' : node.agentTypeId || 'agent'
                      )
                      subLabel.color = graphColor(colors, '--graph-label-muted')
                      subLabel.textHeight = 2.2
                      subLabel.position.y = -14
                      group.add(subLabel)
                      return group
                    },
                  }
                : {})}
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}
