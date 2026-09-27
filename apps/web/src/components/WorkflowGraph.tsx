import {
  AgentIcon,
  ReturnRouteIcon,
  CodeIcon,
  PlayIcon,
  HumanApprovalIcon,
  FlagIcon,
  LinkIcon,
  WorkStreamIcon,
  CloseIcon,
  TrashIcon,
  PlusIcon,
  MinusIcon,
  ExpandIcon,
} from './icons'
import { useId, useRef, useState, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { connectWorkflowOutcome, type WorkflowDraftNotice } from '../lib/workflowEditing'
import { useGraphNavigation } from '../hooks/useGraphNavigation'
import { useAnimatedGraphPositions } from '../hooks/useAnimatedGraphPositions'
import { useStableRef } from '../hooks/useStableRef'
import clsx from 'clsx'
import {
  integrationValueAt,
  resolveCodeHostReference,
  activeWorkflowAttempts,
  type IntegrationDeliveryView,
  type WorkStreamWait,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@ficus/shared'
import {
  fitWorkflowGraph,
  placeNewWorkflowNodes,
  roundedFlowPath,
  layoutWorkflowGraph,
  FLOW_NODE_HEIGHT,
  FLOW_START_ID,
  FLOW_NODE_WIDTH,
  type FlowGraphNode,
} from '../lib/workflowGraph'

export function WorkflowGraph({
  definition,
  positions: savedPositions,
  onPositionsChange,
  run,
  paused = false,
  queued = false,
  openWaits = [],
  integrationDeliveries = [],
  metadata,
  selectedId,
  selectedEdge,
  notice,
  onDismissNotice,
  onSelect,
  renderStepDetails,
  onSelectEdge,
  onDeleteStep,
  changedStepIds = [],
  onConnect,
  fill = false,
  toolbar,
  arrangeOnMount = false,
  arrangeRequest = 0,
  editorLayout = false,
}: {
  definition: WorkflowDefinition
  positions?: Record<string, { x: number; y: number }>
  onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void
  fill?: boolean
  toolbar?: ReactNode
  arrangeOnMount?: boolean
  arrangeRequest?: number
  editorLayout?: boolean
  onConnect?: (from: string, outcome: string, to: string, branch?: number | 'join') => void
  selectedEdge?: { from: string; label: string }
  notice?: WorkflowDraftNotice
  onDismissNotice?: () => void
  selectedId?: string
  renderStepDetails?: (stepId: string) => ReactNode
  onSelect?: (id: string) => void
  onDeleteStep?: () => void
  onSelectEdge?: (from: string, label: string) => void
  changedStepIds?: string[]
  run?: WorkflowRun
  paused?: boolean
  queued?: boolean
  openWaits?: WorkStreamWait[]
  integrationDeliveries?: IntegrationDeliveryView[]
  metadata?: Record<string, unknown>
}) {
  const control = clsx(
    'ficus-button flex shrink-0 items-center justify-center rounded-md text-secondary hover:bg-surface-hover hover:text-primary disabled:opacity-40',
    onConnect ? 'h-8 w-8' : 'h-7 w-7'
  )
  const marker = useId().replaceAll(':', '') + '-flow-arrow'
  const viewport = useRef<HTMLDivElement>(null)
  const finishContent = useRef<HTMLSpanElement>(null)
  const [finishWidth, setFinishWidth] = useState(152)
  const [animate, setAnimate] = useState(false)
  const [animateZoom, setAnimateZoom] = useState(false)
  const [manualZoom, setManualZoom] = useState<number>()
  const [measured, setMeasured] = useState(typeof ResizeObserver === 'undefined')
  const [bounds, setBounds] = useState({ width: 600, height: 500 })
  useEffect(() => {
    const element = viewport.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return
      setBounds({ width: element.clientWidth, height: element.clientHeight })
      setMeasured(true)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const [localSelected, setSelected] = useState<string>()
  const selected = selectedEdge ? undefined : (selectedId ?? localSelected)
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [arranged, setArranged] = useState(false)
  const initialArrange = arrangeOnMount && !arranged
  const positions = initialArrange ? {} : (savedPositions ?? localPositions)
  const setPositions = (next: Record<string, { x: number; y: number }>) => {
    setLocalPositions(next)
    onPositionsChange?.(next)
  }
  const [wire, setWire] = useState<{
    from: string
    outcome: string
    branch?: number | 'join'
    x: number
    y: number
    target?: string
  }>()
  const drag = useRef<{ id: string; x: number; y: number; startX: number; startY: number; moved: boolean } | undefined>(
    undefined
  )
  const wireStart = useRef<{ x: number; y: number } | undefined>(undefined)
  const surface = useRef<HTMLDivElement>(null)
  const suppressClick = useRef(false)
  const editable = editorLayout || !!onConnect
  const W = editable ? (fill ? 196 : 250) : fill ? 164 : FLOW_NODE_WIDTH
  const ports = (id: string) =>
    id === 'code-host:delivery'
      ? [
          {
            outcome: 'events',
            branch: undefined as number | 'join' | undefined,
            join: undefined as string | undefined,
            label: '',
          },
        ]
      : id === FLOW_START_ID
        ? [
            {
              outcome: 'starts',
              branch: undefined as number | 'join' | undefined,
              join: undefined as string | undefined,
              label: '',
            },
          ]
        : Object.entries(definition.steps.find((step) => step.id === id)?.outcomes ?? {}).map(([outcome, target]) => ({
            outcome,
            branch: undefined as number | 'join' | undefined,
            join: 'parallel' in target ? target.join : undefined,
            label: 'parallel' in target ? `${outcome} · ${target.parallel.length} branches` : outcome,
          }))
  const joinGroups = definition.steps.flatMap((step) =>
    Object.entries(step.outcomes).flatMap(([outcome, target]) =>
      'parallel' in target ? [{ from: step.id, outcome, ...target }] : []
    )
  )
  const headerOffset = (id: string) => 66 + (joinGroups.some((group) => group.join === id) ? 16 : 0)
  const baseHeight = fill ? 92 : 120
  const stepHeight = (id: string) => Math.max(baseHeight, headerOffset(id) + ports(id).length * 26)
  const H = editable
    ? Math.max(baseHeight, ...definition.steps.map((step) => stepHeight(step.id)))
    : fill
      ? joinGroups.length
        ? 70
        : 54
      : joinGroups.length
        ? FLOW_NODE_HEIGHT + 16
        : FLOW_NODE_HEIGHT
  let graph = layoutWorkflowGraph(definition)
  if (fill && !editable) graph = fitWorkflowGraph(graph, bounds.width, W, H)
  if (editable) {
    graph.nodes = graph.nodes.filter((node) => node.kind !== 'fork')
    graph.edges = [
      ...graph.edges.filter(
        (edge) => edge.subscriptionId || edge.from === 'code-host:delivery' || edge.from === FLOW_START_ID
      ),
      ...definition.steps.flatMap((step) =>
        Object.entries(step.outcomes).flatMap(([outcome, target]) =>
          'parallel' in target
            ? [
                ...target.parallel.map((to, index) => ({
                  from: step.id,
                  to,
                  label: `${outcome} · branch ${index + 1}`,
                  rework: false,
                })),
              ]
            : [
                {
                  from: step.id,
                  to: 'next' in target ? target.next : target.returnTo,
                  label: outcome,
                  rework: 'returnTo' in target,
                  returnsToRequester: 'returnTo' in target && target.afterRework === 'return-to-requester',
                },
              ]
        )
      ),
    ]
    // A delivery target must remain available even while a draft has no finish edge.
    if (!graph.nodes.some((node) => node.id === 'finish'))
      graph.nodes.push({ id: 'finish', kind: 'finish', label: 'Finish', x: graph.width, y: 94 })
    for (const node of graph.nodes) {
      const point = fill ? undefined : positions[node.id]
      node.x = point?.x ?? node.x * 1.55
      node.y = point?.y ?? 32 + (node.y - 94) * ((H + 48) / 116)
      node.y = Math.max(32, node.y)
    }
    graph.width = Math.max(900, ...graph.nodes.map((node) => node.x + W + 80))
    graph.height = Math.max(520, ...graph.nodes.map((node) => node.y + H + 80))
  }
  if (fill && editable) {
    // Compact auto layout uses the viewport, while user-dragged positions stay put.
    graph = fitWorkflowGraph(graph, bounds.width, W, H)
    graph.nodes = graph.nodes.map((node) => ({ ...node, ...(positions[node.id] ?? { x: node.x, y: node.y }) }))
    graph.width = Math.max(graph.width, ...graph.nodes.map((node) => node.x + W + 32))
    graph.height = Math.max(graph.height, ...graph.nodes.map((node) => node.y + H + 32))
  }
  if (editable) {
    graph.nodes = placeNewWorkflowNodes(graph.nodes, positions, W, H, bounds.width)
    graph.width = Math.max(graph.width, ...graph.nodes.map((node) => node.x + W + 32))
    graph.height = Math.max(graph.height, ...graph.nodes.map((node) => node.y + H + 32))
  }
  // Freeze generated coordinates too, so structural edits do not rearrange untouched cards.
  // Retain removed IDs for undo. Auto arrange explicitly clears this snapshot.
  const frozenPositions = { ...positions }
  for (const node of graph.nodes) frozenPositions[node.id] ??= { x: node.x, y: node.y }
  const positionsKey = JSON.stringify(positions)
  const frozenKey = JSON.stringify(frozenPositions)
  const savePositions = useStableRef(setPositions)
  const fitZoom = Math.min(1, Math.max(0.2, Math.min(bounds.width / graph.width, bounds.height / graph.height)))
  const targetZoom = manualZoom ?? (fill ? fitZoom : 0.8)
  const zoom = useAnimatedGraphPositions({ zoom: { x: targetZoom, y: 0 } }, animateZoom).zoom!.x
  useEffect(() => {
    if (editable && measured) {
      setManualZoom((current) => current ?? targetZoom)
      if (initialArrange || positionsKey !== frozenKey) {
        setArranged(true)
        savePositions.current(JSON.parse(frozenKey))
      }
    }
  }, [editable, measured, initialArrange, positionsKey, frozenKey, savePositions, targetZoom])
  // An editor is a full-size workspace, not a centered thumbnail. Keep its
  // drawing surface at least as large as the viewport at every zoom level.
  const canvasWidth = fill && editable ? Math.max(graph.width, bounds.width / zoom) : graph.width
  const canvasHeight = fill && editable ? Math.max(graph.height, bounds.height / zoom) : graph.height
  const setZoom = (value: number | ((current: number) => number)) => {
    setAnimateZoom(true)
    setManualZoom(typeof value === 'function' ? value(targetZoom) : value)
  }
  const navigation = useGraphNavigation(
    viewport,
    zoom,
    (value) => {
      setAnimateZoom(false)
      setManualZoom(value)
    },
    () => {
      drag.current = undefined
      setWire(undefined)
    }
  )
  const fit = () => {
    navigation.reset()
    viewport.current?.scrollTo?.({ left: 0, top: 0 })
    setZoom(fitZoom)
  }
  const arrange = () => {
    setAnimate(true)
    navigation.reset()
    viewport.current?.scrollTo?.({ left: 0, top: 0 })
    setPositions({})
    setManualZoom(undefined)
  }
  const arrangeRef = useStableRef(arrange)
  useEffect(() => {
    if (arrangeRequest) arrangeRef.current()
  }, [arrangeRequest, arrangeRef])
  const completionLabel = {
    deliverable: 'Deliverable',
    'review-approval': 'Human approval',
    'pr-merge': 'Human merge',
    'pr-auto-merge': 'Auto merge',
    'direct-merge': 'Direct merge',
  }[definition.completion.mode]
  const hasFinish = graph.nodes.some((node) => node.kind === 'finish')
  useLayoutEffect(() => {
    const element = finishContent.current
    if (!element) return
    const measure = () => {
      // offsetWidth ignores canvas zoom; include both 24px insets and borders.
      if (element.offsetWidth) setFinishWidth(element.offsetWidth + 50)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [completionLabel, hasFinish])
  const nodeRect = (node: FlowGraphNode) => {
    const terminal = node.kind === 'start' || node.kind === 'finish'
    const width = node.kind === 'finish' ? finishWidth : terminal ? 112 : W
    const height = node.kind === 'finish' ? 52 : terminal ? 36 : editable ? stepHeight(node.id) : H
    return {
      x: node.x + (W - width) / 2,
      y: node.y + (terminal ? ((editable ? baseHeight : H) - height) / 2 : 0),
      width,
      height,
    }
  }
  const portOffset = (id: string, index: number) =>
    id === FLOW_START_ID || id === 'code-host:delivery' ? baseHeight / 2 : headerOffset(id) + index * 26
  const point = (clientX: number, clientY: number) => {
    const bounds = surface.current!.getBoundingClientRect()
    return { x: (clientX - bounds.left) / zoom, y: (clientY - bounds.top) / zoom }
  }
  const dropTargetAt = (x: number, y: number) => {
    const element = document.elementFromPoint?.(x, y)?.closest<HTMLElement>('[data-flow-target]')
    return element && surface.current?.contains(element) ? element.dataset.flowTarget : undefined
  }
  const finishWire = (id: string) => {
    if (!wire) return
    onConnect?.(wire.from, wire.outcome, id, wire.branch)
    setWire(undefined)
  }
  const selectConnection = (from: string, label: string) => onSelectEdge?.(from, label)
  const animatedPositions = useAnimatedGraphPositions(
    Object.fromEntries(graph.nodes.map((node) => [node.id, { x: node.x, y: node.y }])),
    animate
  )
  graph.nodes = graph.nodes.map((node) => ({ ...node, ...(animatedPositions[node.id] ?? {}) }))
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const active = run ? activeWorkflowAttempts(run) : []
  const selectedStep = definition.steps.find((step) => step.id === selected)
  const selectedSubscription = definition.subscriptions?.find(
    (subscription) => 'integration:' + subscription.id === selected
  )
  function status(node: FlowGraphNode) {
    if (node.kind === 'start') return `Starts at ${definition.entry || 'the connected step'}`
    if (node.kind === 'code-host') return resolveCodeHostReference(metadata)?.integration ?? 'From work stream metadata'
    if (node.kind === 'integration') {
      const pending = integrationDeliveries.filter(
        (delivery) => delivery.subscriptionId === node.subscriptionId && ['pending', 'queued'].includes(delivery.status)
      ).length
      const subscription = definition.subscriptions?.find((item) => item.id === node.subscriptionId)
      if (
        metadata &&
        subscription &&
        Object.values(subscription.match).some(
          (binding) => 'streamMetadata' in binding && integrationValueAt(metadata, binding.streamMetadata) == null
        )
      )
        return 'Unbound resource'
      return pending
        ? `${pending} pending${paused ? ' · paused' : ''}`
        : run
          ? 'Binding configured'
          : 'Event subscription'
    }
    if (node.kind === 'missing') return 'Missing step'
    if (node.kind === 'finish') return run?.status === 'completion-ready' ? 'Ready' : 'Completion policy'
    if (node.kind === 'fork') return 'Independent branches'
    if (node.kind === 'join') {
      const frame = run?.joins
        ?.slice()
        .reverse()
        .find((join) => join.join === node.stepId && join.status !== 'canceled')
      return frame
        ? frame.status === 'joined'
          ? 'Joined'
          : `${frame.arrived.length}/${frame.branches.length} ready`
        : 'All branches required'
    }
    if (active.some((attempt) => attempt.stepId === node.id))
      return paused
        ? 'Paused'
        : queued
          ? 'Queued'
          : run?.status === 'paused'
            ? 'Needs a decision'
            : active.some(
                  (a) =>
                    a.stepId === node.id && openWaits.some((w) => w.flowAttemptId == null || w.flowAttemptId === a.id)
                )
              ? 'Waiting for input'
              : 'Active'
    if (run?.pendingStarts?.some((start) => start.stepId === node.id)) return 'Queued for capacity'
    if (run?.completedStepIds.includes(node.id)) return 'Completed'
    const step = definition.steps.find((step) => step.id === node.id)
    const groups = joinGroups.filter((group) => group.join === node.id)
    if (groups.length) {
      const frame = run?.joins
        ?.slice()
        .reverse()
        .find((join) => join.join === node.id && join.status === 'open')
      return frame
        ? `Waiting for branches (${frame.arrived.length}/${frame.branches.length})`
        : 'Waits for parallel branches'
    }
    return step?.kind === 'human-approval' ? 'Human approval' : 'Agent step'
  }
  return (
    <section
      className={clsx('min-w-0 w-full max-w-full', fill ? 'flex flex-1 min-h-0 flex-col gap-2' : 'space-y-2')}
      aria-label={editable ? 'Workflow flow canvas' : 'Workflow visual preview'}
    >
      <div className={clsx('relative min-w-0', fill && 'flex flex-1 min-h-0 flex-col')}>
        <div
          className={clsx(
            'absolute z-20 max-h-[calc(100%-1.5rem)] overflow-y-auto flex flex-col rounded-lg border border-th-border bg-surface/95 shadow-lg backdrop-blur-sm',
            editable ? 'bottom-3 left-3 gap-1 p-2' : 'bottom-2 left-2 p-1'
          )}
          role="toolbar"
          aria-label="Flow controls"
        >
          {toolbar}
          <div
            className={clsx(
              'flex flex-col items-center text-xs text-secondary',
              editable && 'gap-1',
              toolbar && 'border-t border-th-border pt-1'
            )}
          >
            {editable && (
              <button
                type="button"
                className={control}
                title="Arrange steps automatically and fit the whole workflow in view"
                onClick={arrange}
              >
                <WorkStreamIcon className="h-4 w-4" />
                <span className="sr-only">Auto arrange</span>
              </button>
            )}
            <button type="button" className={control} title="Fit flow to view" onClick={fit}>
              <ExpandIcon className="h-4 w-4" />
              <span className="sr-only">Fit</span>
            </button>
            <button
              type="button"
              className={control}
              title="Zoom out"
              aria-label="Zoom out flow"
              disabled={zoom <= 0.2}
              onClick={() => setZoom((z) => Math.max(0.2, z - 0.1))}
            >
              <MinusIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={control}
              title="Zoom in"
              aria-label="Zoom in flow"
              disabled={zoom >= 1.6}
              onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))}
            >
              <PlusIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div
          ref={viewport}
          {...navigation.handlers}
          className={clsx(
            'touch-none min-w-0 w-full max-w-full overflow-auto [contain:inline-size] rounded-lg border border-th-border bg-surface',
            navigation.panning ? 'cursor-grabbing' : 'cursor-grab',
            fill ? 'flex-1 min-h-0' : editable ? 'h-[34rem]' : 'max-h-96'
          )}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setWire(undefined)
              drag.current = undefined
            }
          }}
          tabIndex={0}
          role="region"
          aria-label={`${definition.name} flow diagram`}
        >
          <div
            className={clsx('overflow-hidden', fill && !editable && 'mx-auto')}
            style={{ width: canvasWidth * zoom, height: canvasHeight * zoom }}
          >
            <div
              ref={surface}
              className="relative origin-top-left"
              onPointerMove={(event) => {
                if (!onConnect) return
                const p = point(event.clientX, event.clientY)
                if (wire) {
                  if (
                    wireStart.current &&
                    Math.abs(p.x - wireStart.current.x) + Math.abs(p.y - wireStart.current.y) > 4
                  )
                    suppressClick.current = true
                  let target = dropTargetAt(event.clientX, event.clientY)
                  if (target) {
                    try {
                      connectWorkflowOutcome(definition, wire.from, wire.outcome, target, wire.branch)
                    } catch {
                      target = undefined
                    }
                  }
                  setWire({ ...wire, ...p, target })
                }
                const d = drag.current
                if (d) {
                  if (Math.abs(p.x - d.startX) + Math.abs(p.y - d.startY) > 4) d.moved = true
                  if (d.moved)
                    setPositions({
                      ...positions,
                      [d.id]: { x: Math.max(24, d.x + p.x - d.startX), y: Math.max(24, d.y + p.y - d.startY) },
                    })
                }
              }}
              onPointerUp={(event) => {
                if (wire) {
                  const target = dropTargetAt(event.clientX, event.clientY)
                  if (target) finishWire(target)
                  else if (suppressClick.current) setWire(undefined)
                }
                if (drag.current) suppressClick.current = drag.current.moved
                drag.current = undefined
              }}
              onPointerCancel={() => {
                drag.current = undefined
                setWire(undefined)
              }}
              style={{
                width: canvasWidth,
                height: canvasHeight,
                translate: `${navigation.offset.x}px ${navigation.offset.y}px`,
                transform: `scale(${zoom})`,
              }}
            >
              <svg
                className="absolute inset-0 text-secondary pointer-events-none"
                width={canvasWidth}
                height={canvasHeight}
                aria-hidden="true"
                focusable="false"
              >
                <defs>
                  <marker
                    id={marker}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                  </marker>
                </defs>
                {wire &&
                  (() => {
                    const start = byId.get(wire.from)
                    const target = wire.target ? byId.get(wire.target) : undefined
                    const targetRect = target && nodeRect(target)
                    const end = targetRect ? { x: targetRect.x, y: targetRect.y + targetRect.height / 2 } : wire
                    const portIndex = ports(wire.from).findIndex(
                      (p) => p.outcome === wire.outcome && p.branch === wire.branch
                    )
                    return start ? (
                      <path
                        data-flow-wire
                        d={`M ${nodeRect(start).x + nodeRect(start).width} ${start.y + portOffset(start.id, portIndex)} L ${end.x} ${end.y}`}
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeDasharray="6 4"
                        className="text-accent"
                        markerEnd={`url(#${marker})`}
                      />
                    ) : null
                  })()}
                {graph.edges.map((edge, index) => {
                  const a = byId.get(edge.from)!,
                    b = byId.get(edge.to)!
                  if (!a || !b) return null
                  const lane = 20 + (index % 5) * 12
                  const outcome =
                    a.id === 'code-host:delivery'
                      ? 'events'
                      : a.id === FLOW_START_ID
                        ? 'starts'
                        : Object.keys(definition.steps.find((step) => step.id === a.id)?.outcomes ?? {}).find(
                            (name) => edge.label === name || edge.label.startsWith(name + ' ·')
                          )
                  const portIndex = ports(a.id).findIndex((port) => port.outcome === outcome)
                  const sourceRect = nodeRect(a),
                    targetRect = nodeRect(b)
                  const x1 = sourceRect.x + sourceRect.width,
                    y1 =
                      editable && portIndex >= 0
                        ? a.y + portOffset(a.id, portIndex)
                        : sourceRect.y + sourceRect.height / 2,
                    x2 = targetRect.x,
                    y2 = targetRect.y + targetRect.height / 2
                  const middle = (x1 + x2) / 2
                  const integrationEdge = !!edge.subscriptionId || a.kind === 'code-host'
                  const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x)
                  const forward = vertical ? b.y > a.y : b.x > a.x
                  const startX = vertical
                    ? sourceRect.x + sourceRect.width / 2
                    : sourceRect.x + (forward ? sourceRect.width : 0)
                  const startY = vertical
                    ? sourceRect.y + (forward ? sourceRect.height : 0)
                    : sourceRect.y + sourceRect.height / 2
                  const endX = vertical
                    ? targetRect.x + targetRect.width / 2
                    : targetRect.x + (forward ? 0 : targetRect.width)
                  const endY = vertical
                    ? targetRect.y + (forward ? 0 : targetRect.height)
                    : targetRect.y + targetRect.height / 2
                  const curve = vertical
                    ? `M ${startX} ${startY} C ${startX} ${(startY + endY) / 2}, ${endX} ${(startY + endY) / 2}, ${endX} ${endY}`
                    : `M ${startX} ${startY} C ${(startX + endX) / 2} ${startY}, ${(startX + endX) / 2} ${endY}, ${endX} ${endY}`
                  // Backward handoffs can bend beyond the left edge even when both cards
                  // are inside the canvas. Keep control points within its padded bounds;
                  // the entire Bezier curve then stays visible without moving the handles.
                  const bend = edge.rework ? 64 : Math.max(48, Math.abs(x2 - x1) / 2)
                  const controlX1 = Math.min(canvasWidth - 12, x1 + bend)
                  const controlX2 = Math.max(12, x2 - bend)
                  const controlY1 = Math.max(12, edge.rework ? y1 - H : y1)
                  const controlY2 = Math.max(12, edge.rework ? y2 - H : y2)
                  const turnX = Math.min(canvasWidth - 12, x1 + 56)
                  const approachX = Math.max(12, x2 - 56)
                  const returnY = Math.max(12, Math.min(a.y, b.y) - 36)
                  // A forward continuation on the next row crosses the gap between rows.
                  // Only rework or upward connections should loop above their source.
                  const routeY =
                    !edge.rework && targetRect.y >= sourceRect.y + sourceRect.height + 24 ? targetRect.y - 22 : returnY
                  // Leave the source to the right and use broad rounded bends around the cards.
                  const handleCurve =
                    edge.rework || x2 <= x1
                      ? roundedFlowPath([
                          { x: x1, y: y1 },
                          { x: turnX, y: y1 },
                          { x: turnX, y: routeY },
                          { x: approachX, y: routeY },
                          { x: approachX, y: y2 },
                          { x: x2, y: y2 },
                        ])
                      : `M ${x1} ${y1} C ${controlX1} ${controlY1}, ${controlX2} ${controlY2}, ${x2} ${y2}`
                  const d =
                    editable && (!integrationEdge || a.kind === 'code-host')
                      ? handleCurve
                      : fill
                        ? curve
                        : editable && edge.rework
                          ? `M ${x1} ${y1} C ${x1 + 64} ${y1 - H}, ${x2 - 64} ${y2 - H}, ${x2 - 3} ${y2}`
                          : integrationEdge
                            ? `M ${a.x + W / 2} ${a.y} V ${a.y - lane} H ${b.x + W / 2} V ${targetRect.y + targetRect.height + 3}`
                            : edge.rework
                              ? `M ${a.x} ${a.y + H / 2} H ${a.x - 14 - (index % 4) * 5} V ${lane} H ${b.x + W / 2} V ${b.y - 3}`
                              : `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2 - 3} ${y2}`
                  const edgeSelected = selectedEdge?.from === edge.from && selectedEdge.label === edge.label
                  return (
                    <g
                      data-flow-edge={`${edge.from}:${edge.label}`}
                      data-selected={edgeSelected || undefined}
                      data-return-to-requester={edge.returnsToRequester || undefined}
                      className={clsx(edgeSelected && 'text-accent-light')}
                      key={`${edge.from}:${edge.to}:${index}`}
                      opacity={edgeSelected ? 1 : edge.rework ? 0.5 : 0.7}
                    >
                      <title>
                        {edge.rework
                          ? `${edge.label}: revise ${edge.to}, then ${edge.returnsToRequester ? `return directly to ${edge.from}` : 'follow the graph'}`
                          : edge.label}
                      </title>
                      {onSelectEdge && (
                        <path
                          d={d}
                          fill="none"
                          stroke="transparent"
                          strokeWidth="16"
                          className="pointer-events-auto cursor-pointer"
                          onClick={() => selectConnection(edge.from, edge.label)}
                        />
                      )}
                      <path
                        d={d}
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={edgeSelected ? 3 : 1.5}
                        strokeDasharray={
                          integrationEdge || edge.label.endsWith(' · join') ? '2 6' : edge.rework ? '5 5' : undefined
                        }
                        markerStart={edge.returnsToRequester ? `url(#${marker})` : undefined}
                        markerEnd={`url(#${marker})`}
                      />
                    </g>
                  )
                })}
              </svg>
              {graph.nodes.map((node) => {
                const step = definition.steps.find((step) => step.id === node.stepId)
                const groups = joinGroups.filter((group) => group.join === node.id)
                const current = active.some((attempt) => attempt.stepId === node.id)
                const label = status(node)
                const isApproval = node.kind === 'step' && step?.kind === 'human-approval'
                const isStart = node.kind === 'start'
                const isCompletion = node.kind === 'finish'
                const terminal = isStart || isCompletion
                const dropTarget = wire?.target === node.id
                const rect = nodeRect(node)
                const NodeIcon = isStart
                  ? PlayIcon
                  : isCompletion
                    ? FlagIcon
                    : isApproval
                      ? HumanApprovalIcon
                      : node.kind === 'step'
                        ? AgentIcon
                        : node.kind === 'code-host'
                          ? CodeIcon
                          : node.kind === 'integration'
                            ? LinkIcon
                            : WorkStreamIcon
                const typeLabel = isStart
                  ? 'Start'
                  : isCompletion
                    ? 'Completion'
                    : isApproval
                      ? 'Approval'
                      : node.kind === 'step'
                        ? 'Agent'
                        : undefined
                return (
                  <div key={node.id}>
                    <button
                      type="button"
                      data-flow-kind={typeLabel?.toLowerCase() ?? node.kind}
                      data-flow-node-id={node.id}
                      data-flow-drop-target={dropTarget || undefined}
                      data-flow-target={
                        node.kind === 'step' || node.kind === 'finish' || node.kind === 'join' ? node.id : undefined
                      }
                      onPointerDown={(event) => {
                        if (!onConnect || event.button !== 0) return
                        setAnimate(false)
                        event.currentTarget.focus()
                        suppressClick.current = false
                        const p = point(event.clientX, event.clientY)
                        drag.current = { id: node.id, x: node.x, y: node.y, startX: p.x, startY: p.y, moved: false }
                        event.currentTarget.setPointerCapture?.(event.pointerId)
                      }}
                      aria-pressed={selected === node.id}
                      disabled={!onSelect && !node.stepId && node.kind !== 'integration' && node.kind !== 'start'}
                      title={[
                        node.label,
                        typeLabel,
                        node.id === definition.entry ? 'Start' : '',
                        label,
                        step?.kind === 'agent' ? definition.participants[step.participant]?.agentTypeId : '',
                        step?.instructions,
                        step?.output ? `Expected: ${step.output}` : '',
                        step ? JSON.stringify(step.outcomes) : '',
                      ]
                        .filter(Boolean)
                        .join('\n')}
                      aria-label={`${node.label}: ${isCompletion ? completionLabel + ' · ' : ''}${label}`}
                      className={clsx(
                        'absolute border py-2 text-left text-sm disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
                        isCompletion ? 'px-6' : 'px-3',
                        terminal ? 'rounded-full flex flex-col items-center justify-center' : 'rounded-lg',
                        dropTarget ? 'bg-accent/10 ring-2 ring-accent-light' : 'bg-surface',
                        editable && 'touch-none select-none cursor-grab active:cursor-grabbing',
                        editable && !terminal && 'flex flex-col justify-start',
                        {
                          'border-accent': current || selected === node.id,
                          'border-th-border': !current && selected !== node.id,
                          'border-dashed': node.kind === 'join',
                          'text-accent': current,
                          'text-primary': !current,
                        }
                      )}
                      style={{
                        left: rect.x,
                        top: rect.y,
                        width: rect.width,
                        height: rect.height,
                      }}
                      onClick={() => {
                        if (suppressClick.current) {
                          suppressClick.current = false
                          return
                        }
                        if (wire && (node.kind === 'step' || node.kind === 'finish' || node.kind === 'join')) {
                          finishWire(node.id)
                          return
                        }
                        if (editable && node.kind === 'join') {
                          selectConnection(node.id, 'all ready')
                          return
                        }
                        setSelected(node.id)
                        onSelect?.(node.stepId ?? node.id)
                      }}
                    >
                      {isCompletion ? (
                        <span ref={finishContent} className="flex w-max shrink-0 items-start gap-2">
                          <FlagIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent-light" />
                          <span className="flex flex-col whitespace-nowrap text-left">
                            <span className="font-medium">{node.label}</span>
                            <span className="text-xs text-secondary">{completionLabel}</span>
                          </span>
                        </span>
                      ) : (
                        <span
                          className={clsx(
                            'flex w-full min-w-0 items-center gap-2 font-medium',
                            terminal && 'justify-center'
                          )}
                        >
                          <span
                            className={clsx(
                              'shrink-0',
                              isApproval
                                ? 'text-status-attention-400'
                                : node.kind === 'step'
                                  ? 'text-status-progress-400'
                                  : 'text-muted'
                            )}
                          >
                            <NodeIcon className="h-4 w-4" />
                          </span>
                          <span
                            className={
                              node.kind === 'join'
                                ? 'whitespace-normal text-xs'
                                : clsx('truncate', selected === node.id && onDeleteStep && step && 'pr-6')
                            }
                          >
                            {node.label}
                          </span>
                          {changedStepIds.includes(node.stepId ?? '') && node.kind === 'step' && (
                            <span
                              className="absolute bottom-3 left-3 h-2 w-2 rounded-full bg-status-progress-400"
                              title="Changed by assistant"
                              role="img"
                              aria-label="Changed by assistant"
                            ></span>
                          )}
                        </span>
                      )}
                      {step?.kind === 'agent' && (
                        <span
                          className="block w-full truncate pl-6 text-xs text-muted"
                          title={`Participant: ${step.participant}`}
                          data-flow-participant={step.participant}
                        >
                          {step.participant}
                        </span>
                      )}
                      {groups.length > 0 && !terminal && (
                        <span
                          className="mt-1 block truncate text-xs text-secondary"
                          title="Starts once all active branches reach this step. Alternative outcomes and rework do not add extra waits."
                        >
                          {run?.joins?.some((join) => join.join === node.id && join.status === 'open')
                            ? label
                            : groups.length === 1
                              ? `Waits for ${groups[0]!.parallel.length} branches`
                              : 'Waits for parallel branches'}
                        </span>
                      )}
                      <span
                        className={clsx(
                          'block truncate text-xs text-secondary',
                          (fill || terminal || step?.kind === 'agent') && 'hidden'
                        )}
                      >
                        {typeLabel && (
                          <>
                            {typeLabel}
                            {step?.kind === 'agent' ? ' · ' : ''}
                          </>
                        )}
                        {node.kind === 'step'
                          ? step?.kind === 'agent'
                            ? step.participant
                            : ''
                          : node.kind === 'join'
                            ? node.stepId
                            : node.kind === 'integration'
                              ? definition.subscriptions?.find((item) => item.id === node.subscriptionId)?.source.output
                              : ''}
                      </span>
                      <span
                        className={clsx(
                          'block truncate text-xs',
                          (terminal || (fill && !run)) && 'hidden',
                          label === 'Completed' || label === 'Joined' ? 'text-status-success-500' : 'text-secondary'
                        )}
                      >
                        {node.id === definition.entry ? 'Start · ' : ''}
                        {label}
                      </span>
                    </button>
                    {editable && step && selected === node.id && onDeleteStep && (
                      <button
                        type="button"
                        className="ficus-button absolute z-10 flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-status-danger-500/10 hover:text-status-danger-400"
                        style={{ left: node.x + W - 35, top: node.y + 5 }}
                        title={`Delete ${node.label} (Delete or Backspace)`}
                        onClick={onDeleteStep}
                      >
                        <TrashIcon className="h-4 w-4" />
                        <span className="sr-only">Delete step</span>
                      </button>
                    )}
                    {editable && (node.kind === 'step' || node.kind === 'finish' || node.kind === 'join') && (
                      <button
                        type="button"
                        data-flow-target={node.id}
                        aria-label={`Connect to ${node.label}`}
                        className={clsx(
                          'absolute z-10 h-5 w-5 rounded-full border-2 border-accent hover:bg-accent focus-visible:bg-accent touch-none',
                          dropTarget ? 'bg-accent ring-2 ring-accent-light' : 'bg-surface'
                        )}
                        style={{ left: rect.x - 10, top: rect.y + rect.height / 2 - 10 }}
                        onClick={() => finishWire(node.id)}
                      />
                    )}
                    {editable &&
                      ports(node.id).map((port, index) => (
                        <div
                          key={`${port.outcome}:${port.branch}`}
                          className="absolute flex items-center justify-end gap-2 pointer-events-none"
                          style={{
                            left: rect.x + 10,
                            top: node.y + portOffset(node.id, index) - 10,
                            width: rect.width,
                          }}
                        >
                          {port.label && (
                            <button
                              type="button"
                              className="truncate text-xs text-secondary hover:text-accent-light pointer-events-auto"
                              onClick={() =>
                                port.join
                                  ? onSelectEdge?.(node.id, port.outcome)
                                  : onSelectEdge?.(node.id, port.outcome)
                              }
                            >
                              {port.label}
                              {graph.edges.some(
                                (edge) =>
                                  edge.from === node.id && edge.label === port.outcome && edge.returnsToRequester
                              ) && (
                                <span title="Revisions return directly to this step" data-return-indicator>
                                  <ReturnRouteIcon className="ml-1 inline-block h-3 w-3" />
                                </span>
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={
                              isStart
                                ? 'Connect Start'
                                : node.kind === 'code-host'
                                  ? 'Connect Code hosting'
                                  : `Connect ${node.id} ${port.outcome}`
                            }
                            title={
                              node.kind === 'code-host'
                                ? 'Send all code hosting events to an agent step'
                                : isStart
                                  ? 'Choose the first step; connecting replaces the current starting step'
                                  : port.join
                                    ? `Add a parallel branch for ${port.outcome}`
                                    : undefined
                            }
                            className="h-5 w-5 shrink-0 rounded-full border-2 border-accent bg-surface hover:bg-accent focus-visible:bg-accent touch-none pointer-events-auto"
                            onPointerDown={(event) => {
                              event.stopPropagation()
                              suppressClick.current = false
                              wireStart.current = point(event.clientX, event.clientY)
                              setWire({
                                from: node.id,
                                outcome: port.outcome,
                                branch: port.branch,
                                ...wireStart.current,
                              })
                              event.currentTarget.setPointerCapture?.(event.pointerId)
                            }}
                            onClick={() => {
                              if (suppressClick.current) {
                                suppressClick.current = false
                                return
                              }
                              setWire({
                                from: node.id,
                                outcome: port.outcome,
                                branch: port.branch,
                                x: rect.x + rect.width + 36,
                                y: node.y + portOffset(node.id, index),
                              })
                            }}
                          />
                        </div>
                      ))}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
        {notice && (
          <div
            data-workflow-notice
            className="absolute bottom-3 left-3 right-3 z-20 pointer-events-none flex justify-center"
          >
            <div
              role="alert"
              className="ficus-overlay pointer-events-auto flex max-w-lg items-start gap-3 rounded-lg border border-th-border bg-surface p-4 text-sm shadow-lg"
            >
              <div className="min-w-0 flex-1 space-y-2 break-words">
                <p className="font-medium leading-5 text-status-attention-400">Workflow needs attention</p>
                <p className="leading-relaxed text-primary">{notice.message}</p>
                {notice.hint && <p className="text-xs leading-relaxed text-secondary">{notice.hint}</p>}
              </div>
              <button
                type="button"
                aria-label="Dismiss workflow warning"
                className="ficus-button shrink-0 p-1 text-muted"
                onClick={onDismissNotice}
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
      <details className="text-xs text-secondary">
        <summary className="cursor-pointer">Graph help</summary>
        <p>
          {editable && (
            <span>
              Drag empty space to pan; pinch to zoom. Drag an outcome handle to another card’s left handle, or click the
              two handles. Select an arrow to edit its handoff. Escape cancels.{' '}
            </span>
          )}
          Solid arrows advance work. Dashed arrows request rework. Dotted arrows deliver integration events. Select a
          node for details.
        </p>
      </details>
      {!onSelect && selectedSubscription && (
        <div className="space-y-2 border-l-2 border-accent pl-3 text-xs">
          <p className="font-medium">
            {selectedSubscription.source.integration} · {selectedSubscription.source.output} v
            {selectedSubscription.source.version}
          </p>
          <p>
            Notify{' '}
            {typeof selectedSubscription.deliver.to === 'string'
              ? selectedSubscription.deliver.to
              : Object.values(selectedSubscription.deliver.to)[0]}
            . When inactive: {selectedSubscription.deliver.whenInactive}. Events do not advance steps.
          </p>
          <ul>
            {Object.entries(selectedSubscription.match).map(([path, binding]) => (
              <li key={path}>
                {path} = {'value' in binding ? String(binding.value) : `metadata.${binding.streamMetadata}`}
              </li>
            ))}
          </ul>
          {integrationDeliveries
            .filter((delivery) => delivery.subscriptionId === selectedSubscription.id)
            .map((delivery) => (
              <div key={delivery.id} className="border-t border-th-border py-2">
                <p>
                  {delivery.fact.subject} · {delivery.status}
                  {delivery.reason ? ` · ${delivery.reason}` : ''}
                </p>
                {delivery.fact.url && /^https:\/\//.test(delivery.fact.url) && (
                  <a className="text-accent" href={delivery.fact.url} target="_blank" rel="noreferrer">
                    Open event
                  </a>
                )}
              </div>
            ))}
        </div>
      )}
      {!onSelect && selectedStep && (
        <div className="space-y-1 border-l-2 border-accent pl-3 text-xs">
          <p className="font-medium">
            {selectedStep.id}
            {selectedStep.kind === 'agent'
              ? ` · ${definition.participants[selectedStep.participant]?.agentTypeId ?? selectedStep.participant}`
              : ' · Human approval'}
          </p>
          {renderStepDetails?.(selectedStep.id)}
          <p className="whitespace-pre-wrap">{selectedStep.instructions}</p>
          <p className="text-secondary">Expected: {selectedStep.output}</p>
          {Object.entries(selectedStep.outcomes).map(([name, target]) => (
            <p key={name} className="text-secondary">
              {name} →{' '}
              {'next' in target
                ? target.next
                : 'parallel' in target
                  ? `${target.parallel.join(' + ')} → join at ${target.join}`
                  : `${target.returnTo}, then ${target.afterRework === 'return-to-requester' ? 'return directly to requester' : 'follow graph'}`}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}
