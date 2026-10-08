import clsx from 'clsx'
import { useMemo, useState, useEffect, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { queries } from '../../queryOptions'
import { useSquadSlugs } from '../../hooks/useSquadSlugs'
import { reorderSquads } from '../../api/squads'
import { Badge, type BadgeColor } from '../Badge'
import { SquadAvatar } from './SquadAvatar'
import { SquadIcon, DragHandleIcon } from '../icons'
import { isLiveAgentStatus, type Squad, type Agent, type WorkStream } from '@ficus/shared'
import { countableSquadAgents } from '../../lib/agentDisplay'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { LoadingSurface, SkeletonBlock, SkeletonCard, SkeletonLine, SkeletonRows } from '../loading/Skeleton'

const STATUS_BADGE_COLORS: Record<string, BadgeColor> = {
  active: 'success',
  paused: 'review',
  archived: 'neutral',
}

// Detect if we're on a touch device (mobile/tablet)
function useIsTouchDevice() {
  const [isTouch, setIsTouch] = useState(false)
  useEffect(() => {
    setIsTouch('ontouchstart' in window || navigator.maxTouchPoints > 0)
  }, [])
  return isTouch
}

export function SquadList() {
  const queryClient = useQueryClient()
  const isTouchDevice = useIsTouchDevice()
  const { data: squads = [], isLoading } = useQuery(queries.squads.list('active'))
  const { data: allAgents = [] } = useQuery(queries.agents.list())
  const { data: allWorkStreams = [] } = useQuery(queries.squads.activeWorkStreams())

  // Filter out anonymous squads
  const visibleSquads = squads.filter((s) => !s.isAnonymous)
  const loadingCardCount = useLoadingShapeCount('squads:list', isLoading ? undefined : visibleSquads.length, {
    fallbackCount: 4,
    maxCount: 8,
  })

  // Local state for optimistic reordering
  const [localOrder, setLocalOrder] = useState<string[] | null>(null)

  // Compute displayed squads based on local order or server order
  const displayedSquads = useMemo(() => {
    if (!localOrder) return visibleSquads
    const squadMap = new Map(visibleSquads.map((s) => [s.id, s]))
    return localOrder.map((id) => squadMap.get(id)).filter((s): s is Squad => !!s)
  }, [visibleSquads, localOrder])

  // Group only live agents for active headcount; dormant agents stay rostered but are not running.
  const agentsBySquad = useMemo(() => {
    const map = new Map<string, Agent[]>()
    for (const agent of allAgents) {
      if (agent.squadId && isLiveAgentStatus(agent.status)) {
        const list = map.get(agent.squadId) || []
        list.push(agent)
        map.set(agent.squadId, list)
      }
    }
    return map
  }, [allAgents])

  const workStreamsBySquad = useMemo(() => {
    const map = new Map<string, WorkStream[]>()
    for (const ws of allWorkStreams) {
      const list = map.get(ws.squadId) || []
      list.push(ws)
      map.set(ws.squadId, list)
    }
    return map
  }, [allWorkStreams])

  // Reorder mutation
  const reorderMutation = useMutation({
    mutationFn: reorderSquads,
    onSuccess: () => {
      queryClient.refetchQueries(queries.squads.list('active')).finally(() => setLocalOrder(null))
    },
    onError: () => {
      // Revert optimistic update on error
      setLocalOrder(null)
    },
  })

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      const currentOrder = localOrder || visibleSquads.map((s) => s.id)
      const oldIndex = currentOrder.indexOf(active.id as string)
      const newIndex = currentOrder.indexOf(over.id as string)
      const newOrder = arrayMove(currentOrder, oldIndex, newIndex)

      // Optimistic update
      setLocalOrder(newOrder)

      // Save to server
      reorderMutation.mutate(newOrder)
    }
  }

  if (isLoading) {
    return (
      <LoadingSurface label="Loading squads" className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <SkeletonRows count={Math.max(1, loadingCardCount)}>
          {(index) => (
            <SkeletonCard key={index} className="min-h-[126px] space-y-3">
              <div className="flex items-center gap-2">
                <SkeletonBlock className="h-7 w-7 shrink-0 rounded-full" />
                <SkeletonLine className="w-2/5" />
              </div>
              <SkeletonLine className="w-full" />
              <SkeletonLine className="w-4/5" />
              <div className="flex gap-3 pt-1">
                <SkeletonLine className="w-24" />
                <SkeletonLine className="w-20" />
              </div>
            </SkeletonCard>
          )}
        </SkeletonRows>
      </LoadingSurface>
    )
  }

  if (visibleSquads.length === 0) {
    return (
      <div className="text-center py-12 text-muted">
        <SquadIcon className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p className="text-lg">No squads yet</p>
        <p className="text-sm mt-1">Create a squad to start organizing agents and work.</p>
      </div>
    )
  }

  // Disable drag-and-drop on touch devices due to PWA issues
  if (isTouchDevice) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {displayedSquads.map((squad) => (
          <SquadCard
            key={squad.id}
            squad={squad}
            agents={agentsBySquad.get(squad.id) || []}
            workStreams={workStreamsBySquad.get(squad.id) || []}
          />
        ))}
      </div>
    )
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={displayedSquads.map((s) => s.id)} strategy={rectSortingStrategy}>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {displayedSquads.map((squad) => (
            <SortableSquadCard
              key={squad.id}
              squad={squad}
              agents={agentsBySquad.get(squad.id) || []}
              workStreams={workStreamsBySquad.get(squad.id) || []}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

export function hasWorkingAgent(agents: Array<Pick<Agent, 'status'>>): boolean {
  return agents.some((agent) => agent.status === 'active')
}

// Shared card content
function SquadCardContent({
  squad,
  agents,
  workStreams,
}: {
  squad: Squad
  agents: Agent[]
  workStreams: WorkStream[]
}) {
  const activeWorkStreams = workStreams.filter((ws) => ws.status !== 'done' && ws.status !== 'canceled').length
  const countableAgents = countableSquadAgents(agents)
  const activeAgents = countableAgents.filter((a) => a.status === 'active').length
  const hasActiveAgent = hasWorkingAgent(agents)

  return (
    <>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <SquadAvatar name={squad.name} avatarUrl={squad.avatarUrl} size={28} />
          <h3 className="font-semibold text-primary truncate">{squad.name}</h3>
          {hasActiveAgent && (
            <span
              className="relative flex h-2 w-2 shrink-0"
              title="Agent activity in progress"
              aria-label="Agent activity in progress"
            >
              <span className="absolute inline-flex h-full w-full rounded-full bg-status-progress-500 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-status-progress-500" />
            </span>
          )}
        </div>
        {squad.status !== 'active' && (
          <Badge color={STATUS_BADGE_COLORS[squad.status] || 'success'}>{squad.status}</Badge>
        )}
      </div>
      <p className="text-sm text-secondary line-clamp-2 mb-3">{squad.purpose}</p>
      {/* Pinned to the card's bottom, so a short description still lines it up across a row. */}
      <div className="mt-auto flex items-center gap-3 text-xs text-muted">
        <span>
          {activeWorkStreams} active work {activeWorkStreams === 1 ? 'stream' : 'streams'}
        </span>
        <span>
          {activeAgents} active {activeAgents === 1 ? 'agent' : 'agents'}
        </span>
      </div>
    </>
  )
}

function SortableSquadCard({
  squad,
  agents,
  workStreams,
}: {
  squad: Squad
  agents: Agent[]
  workStreams: WorkStream[]
}) {
  const { slugFor } = useSquadSlugs()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: squad.id })

  const baseTransition = 'opacity 150ms ease, border-color 150ms ease, box-shadow 150ms ease'
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition: transition ? `${transition}, ${baseTransition}` : baseTransition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(
        'ficus-panel ficus-interactive-card relative',
        isDragging && 'opacity-50 shadow-lg scale-105 z-10'
      )}
    >
      <button
        {...attributes}
        {...listeners}
        className="ficus-button ficus-button-ghost absolute bottom-2 right-2 p-1.5 cursor-grab active:cursor-grabbing rounded hover:bg-surface-secondary transition-colors touch-none"
        aria-label="Drag to reorder"
      >
        <DragHandleIcon className="w-4 h-4" />
      </button>
      <Link to={`/squads/${slugFor(squad.id)}`} className="flex h-full flex-col p-5">
        <SquadCardContent squad={squad} agents={agents} workStreams={workStreams} />
      </Link>
    </div>
  )
}

function SquadCard({ squad, agents, workStreams }: { squad: Squad; agents: Agent[]; workStreams: WorkStream[] }) {
  const { slugFor } = useSquadSlugs()
  return (
    <Link to={`/squads/${slugFor(squad.id)}`} className="ficus-panel ficus-interactive-card flex flex-col p-5">
      <SquadCardContent squad={squad} agents={agents} workStreams={workStreams} />
    </Link>
  )
}
