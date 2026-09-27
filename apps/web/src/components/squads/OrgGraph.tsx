import { useGraphModulesReady } from './useGraphModulesReady'
import { squadGraphColor, relationshipGraphColor, graphColor } from '../../theme/graph'
import { useThemeColors } from '../../theme/useThemeColors'
import clsx from 'clsx'
import { useState, useMemo, useCallback, useRef, useEffect, lazy, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import { CanvasSkeleton } from '../loading/Skeleton'
import { useSquadSlugs } from '../../hooks/useSquadSlugs'
import type { Squad, SquadRelationship } from '@ficus/shared'

// Lazy load force graph components
const ForceGraph2DLazy = lazy(() => import('react-force-graph-2d'))
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

interface GraphNode {
  id: string
  name: string
  status: string
  purpose: string
  val: number
  x?: number
  y?: number
  z?: number
}

interface GraphLink {
  source: string
  target: string
  type: string
  curvature?: number
}

interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}

export function OrgGraph({ squads, relationships }: Props) {
  const colors = useThemeColors()
  const navigate = useNavigate()
  const { slugFor } = useSquadSlugs()
  const [is3D, setIs3D] = useState(false)
  const spriteTextLoaded = useGraphModulesReady(is3D, spriteTextReady)
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 400 })
  const fgRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Build graph data
  const graphData = useMemo<GraphData>(() => {
    if (squads.length === 0) return { nodes: [], links: [] }

    const nodes: GraphNode[] = squads.map((squad) => ({
      id: squad.id,
      name: squad.name,
      status: squad.status,
      purpose: squad.purpose,
      val: 10,
    }))

    const linkCounts = new Map<string, number>()
    const links: GraphLink[] = relationships.map((rel) => {
      const key = [rel.sourceSquadId, rel.targetSquadId].sort().join('-')
      const count = linkCounts.get(key) || 0
      linkCounts.set(key, count + 1)

      return {
        source: rel.sourceSquadId,
        target: rel.targetSquadId,
        type: rel.relationshipType,
        curvature: count * 0.2,
      }
    })

    return { nodes, links }
  }, [squads, relationships])

  // Handle node click
  const handleNodeClick = useCallback(
    (node: any) => {
      navigate(`/squads/${slugFor(node.id)}`)
    },
    [navigate, slugFor]
  )

  // Custom node rendering for 2D — same label spacing as AgentVisualization
  const paintNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const radius = 10
      const x = node.x
      const y = node.y

      ctx.beginPath()
      ctx.arc(x, y, radius, 0, 2 * Math.PI)
      ctx.fillStyle = squadGraphColor(colors, node.status)
      ctx.fill()
      ctx.strokeStyle = graphColor(colors, '--graph-label')
      ctx.lineWidth = 1.5 / globalScale
      ctx.stroke()

      const fontSize = Math.max(10 / globalScale, 8)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'

      // Squad name (below node)
      ctx.font = `bold ${fontSize}px Sans-Serif`
      ctx.fillStyle = graphColor(colors, '--graph-label')
      const displayName = node.name.length > 14 ? node.name.slice(0, 12) + '…' : node.name
      ctx.fillText(displayName, x, y + radius + 3)

      // Purpose (below name)
      ctx.font = `${fontSize * 0.8}px Sans-Serif`
      ctx.fillStyle = graphColor(colors, '--graph-label-muted')
      const purpose = node.purpose || ''
      const displayPurpose = purpose.length > 14 ? purpose.slice(0, 12) + '…' : purpose
      ctx.fillText(displayPurpose, x, y + radius + 3 + fontSize * 1.1)
    },
    [colors]
  )

  // Configure forces for better spacing
  useEffect(() => {
    if (!fgRef.current || graphData.nodes.length === 0 || dimensions.width === 0) return

    const fg = fgRef.current
    fg.d3Force?.('charge')?.strength(-300).distanceMax(400)
    fg.d3Force?.('link')?.distance(100)
    fg.d3ReheatSimulation?.()
  }, [graphData, is3D, dimensions])

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
        setDimensions({ width: rect.width, height: 400 })
      }
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect
        if (width > 0) {
          setDimensions({ width, height: 400 })
        } else {
          measure()
        }
      }
    })
    observer.observe(el)
    measure()
    const fallback = setTimeout(measure, 100)
    return () => {
      observer.disconnect()
      clearTimeout(fallback)
    }
  }, [])

  if (squads.length === 0) {
    return (
      <div className="text-center py-12 text-muted">
        <p>No squads to display</p>
      </div>
    )
  }

  return (
    <div className="relative">
      {/* 2D/3D Toggle */}
      <div className="absolute top-2 right-2 z-10 flex gap-1 bg-surface border border-th-border rounded-lg p-1">
        <button
          onClick={() => setIs3D(false)}
          className={clsx(
            'ficus-button',
            `px-3 py-1 text-sm rounded ${!is3D ? 'bg-accent text-on-accent' : 'text-muted hover:text-primary'}`
          )}
        >
          2D
        </button>
        <button
          onClick={() => setIs3D(true)}
          className={clsx(
            'ficus-button',
            `px-3 py-1 text-sm rounded ${is3D ? 'bg-accent text-on-accent' : 'text-muted hover:text-primary'}`
          )}
        >
          3D
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-2 left-2 z-10 flex gap-4 bg-surface/90 border border-th-border rounded-lg p-2 text-xs">
        <div className="flex items-center gap-1">
          <span className="w-3 h-0.5 bg-status-neutral-solid" />
          <span className="text-muted">Reports To</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-0.5 bg-status-progress-solid" />
          <span className="text-muted">Collaborates</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-0.5 bg-status-success-solid" />
          <span className="text-muted">Depends On</span>
        </div>
      </div>

      {/* Graph */}
      <div
        ref={containerRef}
        className="border border-th-border rounded-lg overflow-hidden bg-[rgb(var(--graph-bg))]"
        style={{ height: 400 }}
      >
        {dimensions.width === 0 ? (
          <CanvasSkeleton label="Preparing organization graph" className="h-full" />
        ) : (
          <Suspense fallback={<CanvasSkeleton label="Loading organization graph" className="h-full" />}>
            {is3D ? (
              <ForceGraph3DLazy
                ref={fgRef}
                width={dimensions.width}
                height={dimensions.height}
                graphData={graphData}
                nodeLabel={(node: any) => `${node.name}\n${node.purpose}`}
                nodeColor={(node: any) => squadGraphColor(colors, node.status)}
                nodeVal={(node: any) => node.val}
                nodeOpacity={0.9}
                linkOpacity={1}
                linkColor={(link: any) => relationshipGraphColor(colors, link.type)}
                linkWidth={2}
                linkDirectionalArrowLength={6}
                linkDirectionalArrowRelPos={1}
                linkCurvature={(link: any) => link.curvature || 0}
                onNodeClick={handleNodeClick}
                onEngineStop={handleEngineStop}
                cooldownTicks={200}
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
                        const purposeLabel = new SpriteText(node.purpose || '')
                        purposeLabel.color = graphColor(colors, '--graph-label-muted')
                        purposeLabel.textHeight = 2.2
                        purposeLabel.position.y = -14
                        group.add(purposeLabel)
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
                nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
                  ctx.fillStyle = color
                  ctx.beginPath()
                  ctx.arc(node.x, node.y, 15, 0, 2 * Math.PI)
                  ctx.fill()
                }}
                linkColor={(link: any) => relationshipGraphColor(colors, link.type)}
                linkWidth={2}
                linkDirectionalArrowLength={6}
                linkDirectionalArrowRelPos={1}
                linkCurvature={(link: any) => link.curvature || 0}
                onNodeClick={handleNodeClick}
                onEngineStop={handleEngineStop}
                cooldownTicks={200}
                backgroundColor={graphColor(colors, '--graph-bg')}
                d3VelocityDecay={0.3}
                d3AlphaDecay={0.02}
              />
            )}
          </Suspense>
        )}
      </div>
    </div>
  )
}
