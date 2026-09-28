import { WorkStreamStatusBadges } from './WorkStreamStatusBadges'
import { useMemo } from 'react'
import clsx from 'clsx'
import type { Agent, WorkStream } from '@ficus/shared'
import { getAgentPrimaryLabel } from '../lib/agentDisplay'
import { Badge } from './Badge'
import { workStreamStatusLabel, WS_STATUS_BADGE_COLORS, WS_STATUS_LABELS } from '../lib/workStreamStatusPresentation'
import { WS_PRIORITY_BADGE_COLORS } from './WorkStreamDetailModal'
import {
  layoutWorkStreamGraph,
  WORK_STREAM_GRAPH_NODE_HEIGHT,
  WORK_STREAM_GRAPH_NODE_WIDTH,
} from '../lib/workStreamGraphLayout'

interface WorkStreamGraphProps {
  workStreams: WorkStream[]
  agentMap: Map<string, Agent>
  onSelectWorkStream: (id: string) => void
}

export function WorkStreamGraph({ workStreams, agentMap, onSelectWorkStream }: WorkStreamGraphProps) {
  const layout = useMemo(() => layoutWorkStreamGraph(workStreams), [workStreams])
  const streamById = useMemo(() => new Map(workStreams.map((stream) => [stream.id, stream])), [workStreams])

  if (workStreams.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">No active work streams</p>
  }

  return (
    <div className="space-y-2">
      {layout.edges.length === 0 && <p className="text-xs text-muted">No dependencies — streams run independently.</p>}
      <div className="max-w-full overflow-x-auto rounded-lg border border-th-border bg-surface-secondary/40">
        <svg
          role="img"
          aria-label={`Dependency graph with ${layout.nodes.length} work streams and ${layout.edges.length} dependencies`}
          width={layout.width}
          height={layout.height}
          className="block"
        >
          <defs>
            <marker id="work-stream-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" className="fill-placeholder" />
            </marker>
          </defs>
          {layout.edges.map((edge) => {
            const [start, end] = edge.points
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                data-from={edge.from}
                data-to={edge.to}
                d={`M ${start.x} ${start.y} L ${end.x} ${end.y}`}
                fill="none"
                className="stroke-placeholder"
                strokeWidth="2"
                markerEnd="url(#work-stream-arrow)"
              />
            )
          })}
          {layout.nodes.map((node) => {
            const stream = streamById.get(node.id)!
            const storedPriority = stream.priority ?? 'normal'
            const effectivePriority = stream.effectivePriority ?? storedPriority
            const boosted = effectivePriority !== storedPriority
            const assignee = stream.assigneeAgentId ? agentMap.get(stream.assigneeAgentId) : undefined
            const assigneeLabel = assignee ? getAgentPrimaryLabel(assignee) : null
            const assigneeInitial = assigneeLabel?.charAt(0).toUpperCase() ?? '—'
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`Open ${stream.title}, ${workStreamStatusLabel(stream)}, ${effectivePriority} priority`}
                onClick={() => onSelectWorkStream(stream.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelectWorkStream(stream.id)
                  }
                }}
                className="group cursor-pointer focus-visible:outline-none"
              >
                <foreignObject
                  x={node.x}
                  y={node.y}
                  width={WORK_STREAM_GRAPH_NODE_WIDTH}
                  height={WORK_STREAM_GRAPH_NODE_HEIGHT}
                >
                  <div
                    className={clsx(
                      'h-full rounded-lg border bg-surface p-3 transition-colors motion-reduce:transition-none hover:border-accent group-focus-visible:ring-2 group-focus-visible:ring-accent group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-surface',
                      boosted
                        ? 'border-status-external-wait-400 ring-2 ring-status-external-wait-400/50'
                        : 'border-th-border',
                      node.unresolved && 'border-dashed border-status-danger-400'
                    )}
                  >
                    <div className="mb-2 truncate text-sm font-medium text-primary" title={stream.title}>
                      {stream.title.length > 28 ? `${stream.title.slice(0, 28)}…` : stream.title}
                    </div>
                    <WorkStreamStatusBadges workStream={stream} />
                    <div className="mt-1 flex items-center gap-1.5">
                      <Badge
                        color={WS_PRIORITY_BADGE_COLORS[effectivePriority]}
                        title={boosted ? `${storedPriority} → ${effectivePriority}` : undefined}
                      >
                        {boosted ? '↑ ' : ''}
                        {effectivePriority}
                      </Badge>
                      <span
                        className="ml-auto flex h-6 w-6 items-center justify-center rounded-full bg-status-human-wait-100 text-xs font-semibold text-status-human-wait-700 dark:bg-status-human-wait-900/50 dark:text-status-human-wait-200"
                        aria-label={assigneeLabel ? `Assigned to ${assigneeLabel}` : 'Unassigned'}
                      >
                        {assigneeInitial}
                      </span>
                    </div>
                  </div>
                </foreignObject>
              </g>
            )
          })}
        </svg>
      </div>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none">Graph legend</summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {(['queued', 'active'] as const).map((status) => (
            <Badge key={status} color={WS_STATUS_BADGE_COLORS[status]}>
              {WS_STATUS_LABELS[status]}
            </Badge>
          ))}
          <span aria-hidden="true">·</span>
          {(['critical', 'high', 'normal', 'low'] as const).map((priority) => (
            <Badge key={priority} color={WS_PRIORITY_BADGE_COLORS[priority]}>
              {priority}
            </Badge>
          ))}
          <span className="rounded border-2 border-status-external-wait-400 px-2 py-0.5">Boosted priority</span>
        </div>
      </details>
    </div>
  )
}
