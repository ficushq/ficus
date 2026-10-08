import { WorkflowPicker } from '../squads/WorkflowPicker'
import { WorkflowEditorModal } from '../squads/WorkflowEditorModal'
import type { WorkflowDefinition, WorkflowSource } from '@ficus/shared'
import { isWorkerAgentType } from '@ficus/shared'
import clsx from 'clsx'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { useWebSocket } from '../../hooks/useWebSocket'
import { useEffect, useState } from 'react'
import { useURLBooleanState, useURLStringState } from '../../hooks/useURLState'
import type { Schedule, ScheduleAction, Agent, Squad } from '@ficus/shared'
import { MarkdownContent } from '../MarkdownContent'
import { Modal } from '../Modal'
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl'
import { Badge, type BadgeColor } from '../Badge'
import { schedulesApi } from '../../api/schedules'
import { usePermissions } from '../../hooks/usePermissions'
import {
  AgentIcon,
  ClipboardIcon,
  ClockIcon,
  LinkIcon,
  MailIcon,
  PencilIcon,
  PlayIcon,
  RefreshIcon,
  WarningIcon,
} from '../icons'
import { SUBAGENT_WATCHDOG_KIND } from '../../lib/subagentWatchdog'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { LoadingSurface, SkeletonBlock, SkeletonCard, SkeletonLine, SkeletonRows } from '../loading/Skeleton'

interface SchedulesListDependencies {
  useWebSocket: typeof useWebSocket
}

interface Props {
  /** Scope filter - if provided, only shows schedules for this scope */
  scopeType?: 'squad' | 'agent'
  scopeId?: string
  /** Agents for resolving names in action summaries (optional for squad scope) */
  agents?: Agent[]
  /** Per-instance overrides for isolated rendering and tests. */
  dependencies?: Partial<SchedulesListDependencies>
}

const defaultDependencies: SchedulesListDependencies = { useWebSocket }

const ACTION_LABELS: Record<string, string> = {
  spawn_agent: 'Spawn Agent',
  inbox_message: 'Inbox Message',
  create_work_stream: 'Create Work Stream',
}

const HEALTH_BADGE: Record<Schedule['healthStatus'], { label: string; color: BadgeColor }> = {
  never_run: { label: 'Never run', color: 'neutral' },
  healthy: { label: 'Healthy', color: 'success' },
  failing: { label: 'Failing', color: 'danger' },
  automatically_disabled: { label: 'Automatically disabled', color: 'danger' },
}

const ACTION_BADGE_COLORS: Record<string, BadgeColor> = {
  spawn_agent: 'accent-2',
  inbox_message: 'accent-1',
  create_work_stream: 'accent-3',
}

function actionCreatesWorkStream(action: Schedule['action']): boolean {
  return action.type === 'create_work_stream' || (action.type === 'spawn_agent' && Boolean(action.workStream))
}

function isSkipIfUnresolvedEnabled(schedule: Schedule['schedule'], action: Schedule['action']): boolean {
  return actionCreatesWorkStream(action) && schedule.skipIfUnresolved !== false
}

function formatSchedule(schedule: Schedule['schedule'], action: Schedule['action']): string {
  const suffix = isSkipIfUnresolvedEnabled(schedule, action) ? ' · skip-if-unresolved' : ''
  if (schedule.interval) return `Every ${schedule.interval}${suffix}`
  if (schedule.cron) return `Cron: ${schedule.cron}${suffix}`
  if (schedule.runAt) return `At ${new Date(schedule.runAt).toLocaleString()}${suffix}`
  return isSkipIfUnresolvedEnabled(schedule, action) ? 'skip-if-unresolved' : '-'
}

function formatRelativeTime(date: Date | string): string {
  const now = Date.now()
  const ms = new Date(date).getTime() - now
  const absMs = Math.abs(ms)
  const future = ms > 0

  if (absMs < 60_000) return future ? 'in <1m' : '<1m ago'
  const minutes = Math.floor(absMs / 60_000)
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  return future ? `in ${days}d` : `${days}d ago`
}

type EditScheduleType = 'interval' | 'cron' | 'runAt' | 'webhookOnly'

const SCHEDULE_TYPE_OPTIONS: SegmentedControlOption<EditScheduleType>[] = [
  { value: 'interval', label: 'Interval' },
  { value: 'cron', label: 'Cron' },
  { value: 'runAt', label: 'Run At' },
]
const WEBHOOK_ONLY_OPTION: SegmentedControlOption<EditScheduleType> = { value: 'webhookOnly', label: 'Webhook Only' }
const INBOX_TARGET_OPTIONS: SegmentedControlOption<ScheduleEditState['inboxTarget']>[] = [
  { value: 'agent', label: 'Specific Agent' },
  { value: 'squad_manager', label: 'Squad Manager' },
]

export interface ScheduleEditState {
  originalAction: ScheduleAction
  name: string
  scheduleType: EditScheduleType
  interval: string
  cron: string
  runAt: string
  expiresAt: string
  actionType: ScheduleAction['type']
  // spawn_agent fields
  spawnAgentTypeId: string
  spawnPrompt: string
  // inbox_message fields
  inboxTarget: 'agent' | 'squad_manager'
  inboxTargetAgentId: string
  inboxSubject: string
  inboxContent: string
  // create_work_stream fields
  workStreamTitle: string
  workStreamDescription: string
  workflow?: WorkflowSource
  skipIfUnresolved: boolean
}

function hasLegacyWorkStreamAction(action: ScheduleAction): boolean {
  return action.type === 'spawn_agent'
    ? action.workStream !== undefined
    : action.type === 'create_work_stream' &&
        [
          action.agentTypes,
          action.agentIds,
          action.assigneeAgentId,
          action.assigneeAgentIndex,
          action.completionMode,
        ].some((value) => value !== undefined)
}

export function createScheduleEditState(schedule: Schedule): ScheduleEditState {
  const action = schedule.action
  const hasTimeTrigger = schedule.schedule.interval || schedule.schedule.cron || schedule.schedule.runAt
  return {
    originalAction: action,
    name: schedule.name,
    scheduleType: !hasTimeTrigger
      ? 'webhookOnly'
      : schedule.schedule.runAt
        ? 'runAt'
        : schedule.schedule.cron
          ? 'cron'
          : 'interval',
    interval: schedule.schedule.interval || '',
    cron: schedule.schedule.cron || '',
    runAt: schedule.schedule.runAt || '',
    expiresAt: schedule.schedule.expiresAt || '',
    actionType: action.type === 'spawn_agent' && action.workStream ? 'create_work_stream' : action.type,
    // spawn_agent
    spawnAgentTypeId: action.type === 'spawn_agent' ? action.agentTypeId : '',
    spawnPrompt: action.type === 'spawn_agent' ? action.prompt : '',
    // inbox_message
    inboxTarget:
      action.type === 'inbox_message' ? (action.target.type === 'squad_manager' ? 'squad_manager' : 'agent') : 'agent',
    inboxTargetAgentId: action.type === 'inbox_message' && action.target.type === 'agent' ? action.target.agentId : '',
    inboxSubject: action.type === 'inbox_message' ? (action.subject ?? '') : '',
    inboxContent: action.type === 'inbox_message' ? action.content : '',
    // create_work_stream
    workStreamTitle:
      action.type === 'create_work_stream'
        ? action.title
        : action.type === 'spawn_agent'
          ? (action.workStream?.title ?? '')
          : '',
    workStreamDescription:
      action.type === 'create_work_stream'
        ? (action.description ?? '')
        : action.type === 'spawn_agent' && action.workStream
          ? [action.workStream.description, action.prompt].filter(Boolean).join('\n\n')
          : '',
    workflow: action.type === 'create_work_stream' ? action.workflow : undefined,
    skipIfUnresolved: actionCreatesWorkStream(action) ? schedule.schedule.skipIfUnresolved !== false : false,
  }
}

export function buildScheduleUpdateFromEditState(state: ScheduleEditState): Parameters<typeof schedulesApi.update>[1] {
  const scheduleConfig =
    state.scheduleType === 'webhookOnly'
      ? {} // Empty config for webhook-only
      : state.scheduleType === 'interval'
        ? { interval: state.interval }
        : state.scheduleType === 'cron'
          ? { cron: state.cron }
          : { runAt: state.runAt }

  const scheduleWithExpiry = state.expiresAt ? { ...scheduleConfig, expiresAt: state.expiresAt } : scheduleConfig
  const shouldIncludeSkip = state.actionType === 'create_work_stream'
  const base = {
    name: state.name,
    schedule: shouldIncludeSkip
      ? { ...scheduleWithExpiry, skipIfUnresolved: state.skipIfUnresolved }
      : scheduleWithExpiry,
  }

  switch (state.actionType) {
    case 'spawn_agent': {
      return {
        ...base,
        action: { type: 'spawn_agent', agentTypeId: state.spawnAgentTypeId, prompt: state.spawnPrompt },
      }
    }
    case 'inbox_message': {
      const original = state.originalAction.type === 'inbox_message' ? state.originalAction : undefined
      return {
        ...base,
        action:
          state.inboxTarget === 'squad_manager'
            ? {
                ...original,
                type: 'inbox_message' as const,
                target: { type: 'squad_manager' as const },
                content: state.inboxContent,
                ...(state.inboxSubject ? { subject: state.inboxSubject } : { subject: undefined }),
              }
            : {
                ...original,
                type: 'inbox_message' as const,
                target: { type: 'agent' as const, agentId: state.inboxTargetAgentId },
                content: state.inboxContent,
                ...(state.inboxSubject ? { subject: state.inboxSubject } : { subject: undefined }),
              },
      }
    }
    case 'create_work_stream': {
      const original = state.originalAction.type === 'create_work_stream' ? state.originalAction : undefined
      return {
        ...base,
        action: {
          type: 'create_work_stream',
          title: state.workStreamTitle,
          description: state.workStreamDescription || undefined,
          handoffMessage: original?.handoffMessage,
          ...(state.workflow ? { workflow: state.workflow } : {}),
        },
      }
    }
  }
}

function ActionSummary({ action, agents }: { action: ScheduleAction; agents: Agent[] }) {
  const agentMap = new Map(agents.map((a) => [a.id, a]))

  switch (action.type) {
    case 'spawn_agent':
      return (
        <span className="text-xs text-secondary">
          Spawn <span className="font-medium text-primary">{action.agentTypeId}</span>
          {action.workStream && (
            <>
              {' → '}
              <span className="text-muted">ws: {action.workStream.title}</span>
            </>
          )}
        </span>
      )
    case 'inbox_message': {
      if (action.target.type === 'squad_manager') {
        return (
          <span className="text-xs text-secondary">
            Message <span className="font-medium text-primary">Squad Manager</span>
            {action.subject && (
              <>
                : <span className="text-muted">{action.subject}</span>
              </>
            )}
          </span>
        )
      }
      const target = agentMap.get(action.target.agentId)
      return (
        <span className="text-xs text-secondary">
          Message{' '}
          <span className="font-medium text-primary">
            {(target?.metadata?.name as string | undefined) || action.target.agentId.slice(0, 8)}
          </span>
          {action.subject && (
            <>
              : <span className="text-muted">{action.subject}</span>
            </>
          )}
        </span>
      )
    }
    case 'create_work_stream':
      return (
        <span className="text-xs text-secondary">
          Create ws: <span className="font-medium text-primary">{action.title}</span>
        </span>
      )
  }
}

export function SchedulesList({ scopeType, scopeId, agents: providedAgents, dependencies }: Props) {
  const queryClient = useQueryClient()
  const { subscribe } = (dependencies?.useWebSocket ?? defaultDependencies.useWebSocket)()

  // Whether we're showing global view (all schedules) vs scoped view (single squad/agent)
  const isGlobalView = !scopeType || !scopeId

  const [showSystemSchedules, setShowSystemSchedules] = useURLBooleanState('systemSchedules')

  // Build query params. Hide subagent watchdog schedules by default; the server owns filtering.
  const queryParams = {
    ...(scopeType && scopeId ? { scopeType, scopeId } : {}),
    ...(showSystemSchedules ? {} : { excludeKind: SUBAGENT_WATCHDOG_KIND }),
  }

  const { data: schedules = [], isLoading } = useQuery({
    ...queries.schedules.list(queryParams),
  })
  const loadingCardCount = useLoadingShapeCount(
    `schedules:${scopeType ?? 'global'}:${scopeId ?? 'all'}`,
    isLoading ? undefined : schedules.length,
    { fallbackCount: 4, maxCount: 8 }
  )

  // If scopeType is squad and scopeId provided, fetch agents for that squad
  const { data: squadAgents = [] } = useQuery({
    ...queries.squads.agents(scopeId!),
    enabled: scopeType === 'squad' && !!scopeId && !providedAgents,
  })

  // Fetch all squads for global view to resolve squad names
  const { data: squads = [] } = useQuery({
    ...queries.squads.list('active'),
    enabled: isGlobalView,
  })

  const agents = providedAgents || squadAgents

  const [selectedScheduleId, setSelectedScheduleId] = useURLStringState<string>('schedule', '')
  const selectedSchedule = selectedScheduleId ? (schedules.find((s) => s.id === selectedScheduleId) ?? null) : null

  const invalidateQueries = () => {
    if (scopeType && scopeId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.list(queryParams) })
    } else {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all })
    }
  }

  const handleToggle = async (schedule: Schedule) => {
    if (schedule.enabled) {
      await schedulesApi.disable(schedule.id)
    } else {
      await schedulesApi.enable(schedule.id)
    }
    invalidateQueries()
  }

  // Real-time updates
  useEffect(() => {
    const unsub = subscribe('schedules', () => {
      invalidateQueries()
    })

    return unsub
  }, [scopeType, scopeId, subscribe, queryClient])

  const systemToggle = (
    <label className="inline-flex items-center gap-2 text-xs text-muted">
      <input
        type="checkbox"
        checked={showSystemSchedules}
        onChange={(e) => setShowSystemSchedules(e.currentTarget.checked)}
        className="rounded border-input-border"
      />
      Show system schedules
    </label>
  )

  if (isLoading) {
    return (
      <div className="h-full space-y-4 overflow-y-auto">
        <div className="flex justify-end">{systemToggle}</div>
        <LoadingSurface
          label="Loading schedules"
          className="grid max-w-5xl grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
        >
          <SkeletonRows count={Math.max(1, loadingCardCount)}>
            {(index) => (
              <SkeletonCard key={index} className="min-h-32 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <SkeletonLine className={index % 2 ? 'w-2/5' : 'w-3/5'} />
                  <SkeletonBlock className="h-5 w-14 rounded-full" />
                </div>
                <SkeletonLine className="w-5/6" />
                <SkeletonLine className="w-2/3" />
                <div className="flex gap-2 pt-2">
                  <SkeletonBlock className="h-5 w-16 rounded-full" />
                  <SkeletonBlock className="h-5 w-20 rounded-full" />
                </div>
              </SkeletonCard>
            )}
          </SkeletonRows>
        </LoadingSurface>
      </div>
    )
  }

  if (schedules.length === 0) {
    return (
      <div className="space-y-4 overflow-y-auto h-full">
        <div className="flex justify-end">{systemToggle}</div>
        <div className="text-center py-12 text-muted">
          <p className="text-lg">No schedules yet</p>
          <p className="text-sm mt-1">
            {scopeType === 'squad'
              ? 'Squad managers can create schedules to automate recurring work.'
              : 'Create schedules to automate recurring tasks.'}
          </p>
        </div>
      </div>
    )
  }

  const enabled = schedules.filter((s) => s.enabled)
  const disabled = schedules.filter((s) => !s.enabled)

  return (
    <div className="space-y-4 overflow-y-auto h-full">
      <div className="flex justify-end">{systemToggle}</div>
      {enabled.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-secondary mb-2">Active ({enabled.length})</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2 max-w-5xl">
            {enabled.map((schedule) => (
              <ScheduleCard
                key={schedule.id}
                schedule={schedule}
                agents={agents}
                squads={squads}
                showScope={isGlobalView}
                onClick={(s) => setSelectedScheduleId(s.id)}
                onToggle={handleToggle}
              />
            ))}
          </div>
        </section>
      )}

      {disabled.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-secondary mb-2">Disabled ({disabled.length})</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2 max-w-5xl opacity-60">
            {disabled.map((schedule) => (
              <ScheduleCard
                key={schedule.id}
                schedule={schedule}
                agents={agents}
                squads={squads}
                showScope={isGlobalView}
                onClick={(s) => setSelectedScheduleId(s.id)}
                onToggle={handleToggle}
              />
            ))}
          </div>
        </section>
      )}

      {selectedSchedule && (
        <ScheduleDetailModal
          schedule={selectedSchedule}
          agents={agents}
          squads={squads}
          showScope={isGlobalView}
          onClose={() => setSelectedScheduleId('')}
          scopeType={scopeType}
          scopeId={scopeId}
        />
      )}
    </div>
  )
}

function ScopeBadge({
  schedule,
  squads,
  className,
  onClick,
}: {
  schedule: Schedule
  squads: Squad[]
  className?: string
  onClick?: (e: React.MouseEvent) => void
}) {
  const squadMap = new Map(squads.map((s) => [s.id, s]))

  if (schedule.scopeType === 'squad') {
    const squad = squadMap.get(schedule.scopeId)
    const name = squad?.name || schedule.scopeId.slice(0, 8)
    return (
      <Badge to={`/squads/${schedule.scopeId}`} color="accent-6" onClick={onClick} className={className}>
        {name}
      </Badge>
    )
  }

  // Agent scope - no link for now
  return (
    <Badge color="accent-7" className={className}>
      Agent: {schedule.scopeId.slice(0, 8)}
    </Badge>
  )
}

function ScheduleCard({
  schedule,
  agents,
  squads,
  showScope,
  onClick,
  onToggle,
}: {
  schedule: Schedule
  agents: Agent[]
  squads: Squad[]
  showScope: boolean
  onClick: (s: Schedule) => void
  onToggle: (s: Schedule) => void
}) {
  return (
    <div
      className="rounded-lg p-3 sm:p-4 cursor-pointer hover:bg-surface-hover transition-colors"
      onClick={() => onClick(schedule)}
    >
      <div className="flex items-center gap-1.5 sm:gap-2">
        {/* Name */}
        <span className="font-medium text-sm text-primary truncate flex-1">{schedule.name}</span>

        {/* Scope badge (only on global view) - hidden on mobile */}
        {showScope && (
          <ScopeBadge
            schedule={schedule}
            squads={squads}
            className="hidden sm:inline-flex"
            onClick={(e) => e.stopPropagation()}
          />
        )}

        {/* Action type badge - shorter on mobile */}
        <Badge color={ACTION_BADGE_COLORS[schedule.action.type] || 'neutral'}>
          <span className="hidden sm:inline">{ACTION_LABELS[schedule.action.type] || schedule.action.type}</span>
          <span className="sm:hidden">
            {schedule.action.type === 'inbox_message' ? (
              <MailIcon className="h-3.5 w-3.5" />
            ) : schedule.action.type === 'spawn_agent' ? (
              <AgentIcon className="h-3.5 w-3.5" />
            ) : (
              <ClipboardIcon className="h-3.5 w-3.5" />
            )}
          </span>
        </Badge>

        <Badge color={HEALTH_BADGE[schedule.healthStatus].color}>{HEALTH_BADGE[schedule.healthStatus].label}</Badge>

        {/* Webhook indicator */}
        {schedule.webhookEnabled && (
          <span className="text-accent-light" title="Webhook enabled">
            <LinkIcon className="w-4 h-4" />
          </span>
        )}

        {/* Toggle switch */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggle(schedule)
          }}
          className={clsx(
            'relative w-9 h-5 rounded-full transition-colors shrink-0',
            schedule.enabled ? 'bg-status-success-500' : 'bg-th-border'
          )}
          title={schedule.enabled ? 'Disable' : 'Enable'}
        >
          <span
            className={clsx(
              'absolute top-0.5 left-0.5 w-4 h-4 bg-chrome-toggle-thumb rounded-full transition-transform',
              schedule.enabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Action summary - hidden on mobile */}
      <div className="hidden sm:block mt-1.5 ml-4">
        <ActionSummary action={schedule.action} agents={agents} />
      </div>

      {/* Schedule + stats row - simplified on mobile */}
      <div className="mt-1.5 sm:mt-2 flex items-center gap-x-2 sm:gap-x-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          <ClockIcon className="h-3.5 w-3.5 text-placeholder" />
          {formatSchedule(schedule.schedule, schedule.action)}
        </span>
        {schedule.nextTriggerAt && schedule.enabled && (
          <span className="hidden sm:inline-flex items-center gap-1">
            <span className="text-th-border">·</span>
            <span className="text-secondary" title={new Date(schedule.nextTriggerAt).toLocaleString()}>
              Next {formatRelativeTime(schedule.nextTriggerAt)}
            </span>
          </span>
        )}
        <span className="ml-auto text-muted">{schedule.triggerCount}×</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail Modal
// ---------------------------------------------------------------------------

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted uppercase tracking-wide">{label}</label>
      <div className="mt-0.5">{children}</div>
    </div>
  )
}

function ScheduleDetailModal({
  schedule,
  agents,
  squads,
  showScope,
  onClose,
  scopeType,
  scopeId,
}: {
  schedule: Schedule
  agents: Agent[]
  squads: Squad[]
  showScope: boolean
  onClose: () => void
  scopeType?: 'squad' | 'agent'
  scopeId?: string
}) {
  const queryClient = useQueryClient()
  const agentMap = new Map(agents.map((a) => [a.id, a]))
  const { data: agentTypes = [] } = useQuery(queries.agentTypes.list())
  const squadPermissionScope = scopeType === 'squad' ? scopeId : undefined
  const { can, isLoading: permissionsLoading } = usePermissions(squadPermissionScope)
  const canUpdateSchedules = !permissionsLoading && can('schedules:update')
  const canTriggerSchedules = !permissionsLoading && can('schedules:trigger')

  const [isEditing, setIsEditing] = useState(false)
  const [editState, setEditState] = useState(() => createScheduleEditState(schedule))
  const [editError, setEditError] = useState<string | null>(null)

  useEffect(() => {
    setEditState(createScheduleEditState(schedule))
    setEditError(null)
  }, [schedule])

  const invalidateQueries = () => {
    // Detail is backed by whichever filtered list is mounted (including the
    // default system-schedule exclusion), so invalidate every list variant.
    queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all })
  }

  const updateMutation = useMutation({
    mutationFn: (input: Parameters<typeof schedulesApi.update>[1]) => schedulesApi.update(schedule.id, input),
    onSuccess: () => {
      invalidateQueries()
      setEditError(null)
      setIsEditing(false)
    },
  })

  const triggerMutation = useMutation({
    mutationFn: () => schedulesApi.trigger(schedule.id),
    onSettled: invalidateQueries,
  })

  const toggleEnabled = () => {
    if (schedule.enabled) {
      schedulesApi.disable(schedule.id).then(invalidateQueries)
    } else {
      schedulesApi.enable(schedule.id).then(invalidateQueries)
    }
  }

  const saveEdits = () => {
    setEditError(null)

    if (editState.scheduleType === 'interval' && !editState.interval.trim()) {
      setEditError('Interval is required')
      return
    }
    if (editState.scheduleType === 'cron' && !editState.cron.trim()) {
      setEditError('Cron expression is required')
      return
    }
    if (editState.scheduleType === 'runAt' && !editState.runAt.trim()) {
      setEditError('Run-at datetime is required')
      return
    }
    if (editState.scheduleType === 'webhookOnly' && !schedule.webhookEnabled) {
      setEditError('Enable webhook first to use webhook-only mode')
      return
    }

    if (
      editState.actionType === 'spawn_agent' &&
      (!editState.spawnAgentTypeId.trim() || !editState.spawnPrompt.trim())
    ) {
      setEditError('Spawn Agent requires agent type and prompt')
      return
    }
    if (editState.actionType === 'inbox_message') {
      if (editState.inboxTarget === 'agent' && !editState.inboxTargetAgentId.trim()) {
        setEditError('Inbox Message requires target agent')
        return
      }
      if (!editState.inboxContent.trim()) {
        setEditError('Inbox Message requires content')
        return
      }
    }
    if (editState.actionType === 'create_work_stream' && !editState.workStreamTitle.trim()) {
      setEditError('Create Work Stream requires a title')
      return
    }

    updateMutation.mutate(buildScheduleUpdateFromEditState(editState))
  }

  const cancelEdits = () => {
    setEditState(createScheduleEditState(schedule))
    setEditError(null)
    setIsEditing(false)
  }

  const headerExtra = (
    <div className="flex items-center justify-between flex-1">
      <div className="flex items-center gap-2">
        {showScope && <ScopeBadge schedule={schedule} squads={squads} />}
        <Badge color={ACTION_BADGE_COLORS[schedule.action.type] || 'neutral'}>
          {ACTION_LABELS[schedule.action.type] || schedule.action.type}
        </Badge>
      </div>
      <div className="flex items-center gap-1">
        {!isEditing && (
          <>
            <button
              onClick={() => triggerMutation.mutate()}
              disabled={triggerMutation.isPending || !canTriggerSchedules}
              className="ficus-button ficus-button-ghost p-1 rounded transition-colors"
              title={canTriggerSchedules ? 'Trigger now' : 'You do not have permission to trigger schedules'}
            >
              <PlayIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => setIsEditing(true)}
              disabled={!canUpdateSchedules}
              className="ficus-button ficus-button-ghost p-1 rounded transition-colors disabled:opacity-50"
              title={canUpdateSchedules ? 'Edit schedule' : 'You do not have permission to edit schedules'}
            >
              <PencilIcon className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
    </div>
  )

  return (
    <Modal isOpen onClose={onClose} title={schedule.name} headerExtra={headerExtra} maxWidth="readable">
      <div className="space-y-4 text-sm">
        {/* Name field (editable) */}
        {isEditing && (
          <DetailRow label="Name">
            <input
              type="text"
              value={editState.name}
              onChange={(e) => setEditState((prev) => ({ ...prev, name: e.target.value }))}
              className="ficus-field w-full px-2 py-1 text-sm bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
            />
          </DetailRow>
        )}

        {/* Schedule + stats grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <DetailRow label="Status">
            <button
              onClick={toggleEnabled}
              disabled={updateMutation.isPending || !canUpdateSchedules}
              className={clsx(
                'ficus-button ficus-button-secondary',
                'flex items-center gap-2 px-2 py-1 rounded-md transition-colors',
                schedule.enabled
                  ? 'bg-status-success-100 dark:bg-status-success-900/30 hover:bg-status-success-200 dark:hover:bg-status-success-900/50'
                  : 'bg-status-neutral-100 dark:bg-status-neutral-800 hover:bg-status-neutral-200 dark:hover:bg-status-neutral-700'
              )}
            >
              <span
                className={clsx(
                  'w-2 h-2 rounded-full',
                  schedule.enabled ? 'bg-status-success-500' : 'bg-status-neutral-400'
                )}
              />
              <span className="text-primary text-xs font-medium">{schedule.enabled ? 'Enabled' : 'Disabled'}</span>
            </button>
          </DetailRow>

          <DetailRow label="Health">
            <Badge color={HEALTH_BADGE[schedule.healthStatus].color}>{HEALTH_BADGE[schedule.healthStatus].label}</Badge>
          </DetailRow>

          <DetailRow label="Schedule">
            {isEditing ? (
              <div className="space-y-2">
                <SegmentedControl
                  ariaLabel="Schedule type"
                  size="compact"
                  options={
                    schedule.webhookEnabled ? [...SCHEDULE_TYPE_OPTIONS, WEBHOOK_ONLY_OPTION] : SCHEDULE_TYPE_OPTIONS
                  }
                  value={editState.scheduleType}
                  onChange={(scheduleType) => setEditState((prev) => ({ ...prev, scheduleType }))}
                />
                {editState.scheduleType === 'webhookOnly' && (
                  <p className="text-xs text-muted">No time-based triggers. Only triggered via webhook.</p>
                )}
                {editState.scheduleType === 'interval' && (
                  <input
                    type="text"
                    value={editState.interval}
                    onChange={(e) => setEditState((prev) => ({ ...prev, interval: e.target.value }))}
                    placeholder="e.g. 1h, 30m, 1d"
                    className="ficus-field w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
                  />
                )}
                {editState.scheduleType === 'cron' && (
                  <input
                    type="text"
                    value={editState.cron}
                    onChange={(e) => setEditState((prev) => ({ ...prev, cron: e.target.value }))}
                    placeholder="e.g. 0 9 * * 1-5"
                    className="ficus-field w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary font-mono"
                  />
                )}
                {editState.scheduleType === 'runAt' && (
                  <input
                    type="datetime-local"
                    value={editState.runAt ? new Date(editState.runAt).toISOString().slice(0, 16) : ''}
                    onChange={(e) =>
                      setEditState((prev) => ({
                        ...prev,
                        runAt: e.target.value ? new Date(e.target.value).toISOString() : '',
                      }))
                    }
                    className="ficus-field w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
                  />
                )}
                <label className="block text-xs text-muted">
                  Expires (optional)
                  <input
                    type="datetime-local"
                    value={editState.expiresAt ? new Date(editState.expiresAt).toISOString().slice(0, 16) : ''}
                    onChange={(e) =>
                      setEditState((prev) => ({
                        ...prev,
                        expiresAt: e.target.value ? new Date(e.target.value).toISOString() : '',
                      }))
                    }
                    className="ficus-field mt-1 w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
                  />
                </label>
              </div>
            ) : (
              <p className="text-primary">{formatSchedule(schedule.schedule, schedule.action)}</p>
            )}
          </DetailRow>

          <DetailRow label="Attempts">
            <p className="text-primary">{schedule.triggerCount}</p>
          </DetailRow>
          <DetailRow label="Failures">
            <p className="text-primary">
              {schedule.failureCount} total · {schedule.consecutiveFailureCount} consecutive
            </p>
          </DetailRow>
          <DetailRow label="Last success">
            <p className="text-primary">
              {schedule.lastSuccessAt ? formatRelativeTime(schedule.lastSuccessAt) : 'Never'}
            </p>
          </DetailRow>
          <DetailRow label="Last failure">
            <p className="text-primary">
              {schedule.lastFailureAt ? formatRelativeTime(schedule.lastFailureAt) : 'Never'}
            </p>
          </DetailRow>
          <DetailRow label="Last recovery">
            <p className="text-primary">
              {schedule.lastRecoveredAt ? formatRelativeTime(schedule.lastRecoveredAt) : 'Never'}
            </p>
          </DetailRow>
          <DetailRow label="Expires">
            <p className="text-primary">
              {schedule.schedule.expiresAt ? new Date(schedule.schedule.expiresAt).toLocaleString() : 'Never'}
            </p>
          </DetailRow>
          {schedule.automaticallyDisabledAt && (
            <DetailRow label="Automatically disabled">
              <p className="text-primary">{new Date(schedule.automaticallyDisabledAt).toLocaleString()}</p>
            </DetailRow>
          )}

          {schedule.skipCount > 0 && (
            <DetailRow label="Skipped">
              <p className="text-primary">
                {schedule.skipCount}
                {schedule.lastSkippedAt ? ` · ${formatRelativeTime(schedule.lastSkippedAt)}` : ''}
              </p>
            </DetailRow>
          )}

          {schedule.lastTriggeredAt && (
            <DetailRow label="Last Triggered">
              <p className="text-primary" title={new Date(schedule.lastTriggeredAt).toLocaleString()}>
                {formatRelativeTime(schedule.lastTriggeredAt)}
              </p>
            </DetailRow>
          )}

          {schedule.nextTriggerAt && schedule.enabled && (
            <DetailRow label="Next Trigger">
              <p className="text-primary" title={new Date(schedule.nextTriggerAt).toLocaleString()}>
                {formatRelativeTime(schedule.nextTriggerAt)}
              </p>
            </DetailRow>
          )}
        </div>

        {(schedule.healthStatus === 'failing' || schedule.healthStatus === 'automatically_disabled') && (
          <div className="rounded border border-status-danger-300 bg-status-danger-50 dark:bg-status-danger-950/30 p-3 text-sm text-status-danger-800 dark:text-status-danger-200">
            <p className="font-medium">{schedule.lastErrorCode || 'Schedule failure'}</p>
            {schedule.lastErrorSummary && <p>{schedule.lastErrorSummary}</p>}
            {schedule.automaticDisableReason && <p>{schedule.automaticDisableReason}</p>}
          </div>
        )}
        {schedule.healthStatus === 'healthy' && schedule.lastErrorSummary && (
          <div className="border-b border-panel-border last:border-b-0 p-3 text-sm text-muted">
            <p className="font-medium">Previous failure</p>
            {schedule.lastErrorCode && <p>{schedule.lastErrorCode}</p>}
            <p>{schedule.lastErrorSummary}</p>
          </div>
        )}

        {hasLegacyWorkStreamAction(schedule.action) && (
          <p className="text-sm text-warning">
            This schedule uses retired work-stream settings. Edit it to choose a workflow. Saving will use that style or
            the squad default while keeping the task description.
          </p>
        )}

        {/* Divider */}
        <div className="border-t border-th-border" />

        {isEditing ? (
          <EditActionFields
            editState={editState}
            setEditState={setEditState}
            agents={agents}
            agentTypes={agentTypes}
            scopeType={schedule.scopeType}
            scopeId={schedule.scopeId}
          />
        ) : (
          <ActionDetails action={schedule.action} agentMap={agentMap} />
        )}

        {/* Edit actions */}
        {isEditing && (
          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={saveEdits}
              disabled={updateMutation.isPending}
              className="ficus-button ficus-button-primary px-3 py-1.5 text-xs font-medium rounded disabled:opacity-50"
            >
              {updateMutation.isPending ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={cancelEdits}
              disabled={updateMutation.isPending}
              className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs font-medium rounded"
            >
              Cancel
            </button>
            {(updateMutation.isError || editError) && (
              <span className="text-xs text-status-danger-500">{editError || 'Failed to save'}</span>
            )}
          </div>
        )}

        {/* Webhook Section */}
        {!isEditing && <WebhookSection schedule={schedule} onUpdate={invalidateQueries} />}

        {/* Footer */}
        <div className="border-t border-th-border pt-3 flex items-center gap-4 text-xs text-muted">
          <span title={new Date(schedule.createdAt).toLocaleString()}>
            Created {formatRelativeTime(schedule.createdAt)}
          </span>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Webhook Section
// ---------------------------------------------------------------------------

function WebhookSection({ schedule, onUpdate }: { schedule: Schedule; onUpdate: () => void }) {
  const [showToken, setShowToken] = useState<string | null>(null)
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canUpdateSchedules = !permissionsLoading && can('schedules:update')
  const [copied, setCopied] = useState(false)

  const enableMutation = useMutation({
    mutationFn: () => schedulesApi.enableWebhook(schedule.id),
    onSuccess: (result) => {
      setShowToken(result.token)
      onUpdate()
    },
  })

  const disableMutation = useMutation({
    mutationFn: () => schedulesApi.disableWebhook(schedule.id),
    onSuccess: () => {
      setShowToken(null)
      onUpdate()
    },
  })

  const regenerateMutation = useMutation({
    mutationFn: () => schedulesApi.regenerateWebhookToken(schedule.id),
    onSuccess: (result) => {
      setShowToken(result.token)
      onUpdate()
    },
  })

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const webhookUrl = `${window.location.origin}/api/webhooks/trigger/${schedule.id}`

  return (
    <div className="space-y-3">
      <div className="border-t border-th-border" />

      <DetailRow label="Webhook Trigger">
        <div className="space-y-2">
          {/* Status and toggle */}
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium',
                schedule.webhookEnabled
                  ? 'bg-status-success-100 dark:bg-status-success-900/30 text-status-success-700 dark:text-status-success-300'
                  : 'bg-status-neutral-100 dark:bg-status-neutral-800 text-status-neutral-600 dark:text-status-neutral-400'
              )}
            >
              <LinkIcon className="w-3 h-3" />
              {schedule.webhookEnabled ? 'Enabled' : 'Disabled'}
            </span>

            {!schedule.webhookEnabled ? (
              <button
                onClick={() => enableMutation.mutate()}
                disabled={enableMutation.isPending || !canUpdateSchedules}
                className="ficus-button ficus-button-link text-xs disabled:opacity-50"
                title={canUpdateSchedules ? 'Enable webhook' : 'You do not have permission to edit schedules'}
              >
                {enableMutation.isPending ? 'Enabling...' : 'Enable'}
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => regenerateMutation.mutate()}
                  disabled={regenerateMutation.isPending || !canUpdateSchedules}
                  className="ficus-button ficus-button-link inline-flex items-center gap-1 text-xs disabled:opacity-50"
                  title={canUpdateSchedules ? 'Regenerate token' : 'You do not have permission to edit schedules'}
                >
                  <RefreshIcon className="w-3 h-3" />
                  {regenerateMutation.isPending ? 'Regenerating...' : 'Regenerate'}
                </button>
                <button
                  onClick={() => disableMutation.mutate()}
                  disabled={disableMutation.isPending || !canUpdateSchedules}
                  className="ficus-button ficus-button-danger px-2 py-1 text-xs disabled:opacity-50"
                >
                  {disableMutation.isPending ? 'Disabling...' : 'Disable'}
                </button>
              </div>
            )}
          </div>

          {/* Token display (only shown once after enable/regenerate) */}
          {showToken && (
            <div className="bg-status-review-50 dark:bg-status-review-900/20 border border-status-review-200 dark:border-status-review-800 rounded p-2 space-y-1">
              <p className="flex items-center gap-1.5 text-xs text-status-review-700 dark:text-status-review-300 font-medium">
                <WarningIcon className="h-3.5 w-3.5 shrink-0" /> Save this token - it will not be shown again!
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-surface px-2 py-1 rounded border border-status-review-200 dark:border-status-review-800 text-primary overflow-x-auto">
                  {showToken}
                </code>
                <button
                  onClick={() => copyToClipboard(showToken)}
                  className="ficus-button ficus-button-ghost p-1"
                  title="Copy token"
                >
                  <ClipboardIcon className="w-4 h-4" />
                </button>
              </div>
              {copied && <p className="text-xs text-status-success-600 dark:text-status-success-400">Copied!</p>}
            </div>
          )}

          {/* Webhook URL (always shown when enabled) */}
          {schedule.webhookEnabled && (
            <div className="space-y-1">
              <label className="text-xs text-muted">Webhook URL:</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-surface-secondary px-2 py-1 rounded border border-th-border text-secondary overflow-x-auto">
                  {webhookUrl}
                </code>
                <button
                  onClick={() => copyToClipboard(webhookUrl)}
                  className="ficus-button ficus-button-ghost p-1"
                  title="Copy URL"
                >
                  <ClipboardIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Last webhook trigger */}
          {schedule.lastWebhookTriggerAt && (
            <p className="text-xs text-muted">
              Last webhook trigger: {formatRelativeTime(schedule.lastWebhookTriggerAt)}
            </p>
          )}

          {/* Usage instructions */}
          {schedule.webhookEnabled && !showToken && (
            <details className="text-xs">
              <summary className="text-muted cursor-pointer hover:text-secondary">Usage example</summary>
              <pre className="mt-1 bg-surface-secondary p-2 rounded border border-th-border overflow-x-auto text-secondary">
                {`curl -X POST "${webhookUrl}" \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"context": {"event": "example"}}'`}
              </pre>
            </details>
          )}
        </div>
      </DetailRow>
    </div>
  )
}

function EditActionFields({
  editState,
  setEditState,
  agents,
  agentTypes,
  scopeType,
  scopeId,
}: {
  editState: ScheduleEditState
  setEditState: React.Dispatch<React.SetStateAction<ScheduleEditState>>
  agents: Agent[]
  agentTypes: Array<{ id: string; name: string; systemOnly?: boolean; disabled?: boolean }>
  scopeType: string
  scopeId: string
}) {
  // A fresh `session` remounts the editor so each open starts from its own draft.
  const [flowEditor, setFlowEditor] = useState<{ session: number; initial?: WorkflowDefinition } | null>(null)
  return (
    <div className="space-y-3">
      <DetailRow label="Action Type">
        <select
          value={editState.actionType}
          onChange={(e) => setEditState((prev) => ({ ...prev, actionType: e.target.value as ScheduleAction['type'] }))}
          className="ficus-field w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
        >
          <option value="inbox_message">Inbox Message</option>
          {scopeType === 'squad' && (
            <>
              <option value="spawn_agent">Spawn Agent</option>
              <option value="create_work_stream">Create Work Stream</option>
            </>
          )}
        </select>
      </DetailRow>

      {editState.actionType === 'spawn_agent' && (
        <div className="space-y-2">
          <p className="text-xs text-muted">Required: agent type and prompt</p>
          <select
            value={editState.spawnAgentTypeId}
            onChange={(e) => setEditState((prev) => ({ ...prev, spawnAgentTypeId: e.target.value }))}
            className="ficus-field w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
          >
            <option value="">Select agent type...</option>
            {agentTypes.filter(isWorkerAgentType).map((agentType) => (
              <option key={agentType.id} value={agentType.id}>
                {agentType.name} ({agentType.id})
              </option>
            ))}
          </select>
          <textarea
            value={editState.spawnPrompt}
            onChange={(e) => setEditState((prev) => ({ ...prev, spawnPrompt: e.target.value }))}
            placeholder="Prompt"
            rows={4}
            className="ficus-field w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
          />
        </div>
      )}

      {editState.actionType === 'create_work_stream' && (
        <label className="flex items-start gap-2 text-primary">
          <input
            type="checkbox"
            checked={editState.skipIfUnresolved}
            onChange={(e) => setEditState((prev) => ({ ...prev, skipIfUnresolved: e.target.checked }))}
            className="mt-0.5 rounded border-th-border"
          />
          <span>
            <span className="block text-xs">Skip if prior work stream still open</span>
            <span className="block text-xs text-muted">Useful for recurring jobs that may get stuck.</span>
          </span>
        </label>
      )}

      {editState.actionType === 'inbox_message' && (
        <div className="space-y-2">
          <p className="text-xs text-muted">Required: target and content</p>
          {scopeType === 'squad' && (
            <SegmentedControl
              ariaLabel="Inbox target"
              size="compact"
              options={INBOX_TARGET_OPTIONS}
              value={editState.inboxTarget}
              onChange={(inboxTarget) => setEditState((prev) => ({ ...prev, inboxTarget }))}
            />
          )}
          {editState.inboxTarget === 'agent' && (
            <select
              value={editState.inboxTargetAgentId}
              onChange={(e) => setEditState((prev) => ({ ...prev, inboxTargetAgentId: e.target.value }))}
              className="ficus-field w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
            >
              <option value="">Select target agent...</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {(agent.metadata?.name as string | undefined) || agent.id.slice(0, 8)} ({agent.agentTypeId})
                </option>
              ))}
            </select>
          )}
          <input
            type="text"
            value={editState.inboxSubject}
            onChange={(e) => setEditState((prev) => ({ ...prev, inboxSubject: e.target.value }))}
            placeholder="Optional subject"
            className="ficus-field w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
          />
          <textarea
            value={editState.inboxContent}
            onChange={(e) => setEditState((prev) => ({ ...prev, inboxContent: e.target.value }))}
            placeholder="Message content"
            rows={3}
            className="ficus-field w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
          />
        </div>
      )}

      {editState.actionType === 'create_work_stream' && (
        <div className="space-y-2">
          <p className="text-xs text-muted">Required: title</p>
          <input
            type="text"
            value={editState.workStreamTitle}
            onChange={(e) => setEditState((prev) => ({ ...prev, workStreamTitle: e.target.value }))}
            placeholder="Work stream title"
            className="ficus-field w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
          />
          <input
            type="text"
            value={editState.workStreamDescription}
            onChange={(e) => setEditState((prev) => ({ ...prev, workStreamDescription: e.target.value }))}
            placeholder="Optional description"
            className="ficus-field w-full px-2 py-1 text-xs bg-surface-secondary border border-th-border rounded focus:border-accent  text-primary"
          />
          <WorkflowPicker
            squadId={scopeType === 'squad' ? scopeId : undefined}
            value={editState.workflow}
            onChange={(workflow) => setEditState((prev) => ({ ...prev, workflow }))}
            onUseSquadDefault={() => setEditState((prev) => ({ ...prev, workflow: undefined }))}
            onCustomize={(initial) => setFlowEditor({ session: Date.now(), initial })}
            preview={false}
          />
          {flowEditor && (
            <WorkflowEditorModal
              key={flowEditor.session}
              isOpen
              squadId={scopeType === 'squad' ? scopeId : undefined}
              initialDefinition={flowEditor.initial}
              onClose={() => setFlowEditor(null)}
              onSave={(definition) => {
                setEditState((prev) => ({ ...prev, workflow: { kind: 'inline', definition } }))
                setFlowEditor(null)
              }}
            />
          )}
          <p className="text-xs text-muted">Uses the squad default at each run unless you choose a workflow here.</p>
        </div>
      )}
    </div>
  )
}

function ActionDetails({ action, agentMap }: { action: ScheduleAction; agentMap: Map<string, Agent> }) {
  switch (action.type) {
    case 'spawn_agent':
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <DetailRow label="Agent Type">
              <p className="text-primary font-mono text-xs">{action.agentTypeId}</p>
            </DetailRow>
            {action.workStream && (
              <DetailRow label="Work Stream">
                <p className="text-primary text-xs">{action.workStream.title}</p>
              </DetailRow>
            )}
          </div>
          <DetailRow label="Prompt">
            <div className="text-xs bg-surface-secondary rounded p-2 border border-th-border max-h-64 overflow-y-auto">
              <MarkdownContent className="prose-xs">{action.prompt}</MarkdownContent>
            </div>
          </DetailRow>
          {action.workStream?.description && (
            <DetailRow label="Work Stream Description">
              <p className="text-secondary text-xs">{action.workStream.description}</p>
            </DetailRow>
          )}
        </div>
      )
    case 'inbox_message': {
      if (action.target.type === 'squad_manager') {
        return (
          <div className="space-y-3">
            <DetailRow label="Target">
              <p className="text-primary text-xs">Squad Manager</p>
            </DetailRow>
            {action.subject && (
              <DetailRow label="Subject">
                <p className="text-primary text-xs">{action.subject}</p>
              </DetailRow>
            )}
            <DetailRow label="Content">
              <div className="text-xs bg-surface-secondary rounded p-2 border border-th-border max-h-64 overflow-y-auto">
                <MarkdownContent className="prose-xs">{action.content}</MarkdownContent>
              </div>
            </DetailRow>
          </div>
        )
      }
      const target = agentMap.get(action.target.agentId)
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <DetailRow label="Target Agent">
              <p className="text-primary text-xs">
                {(target?.metadata?.name as string | undefined) || (
                  <span className="font-mono">{action.target.agentId.slice(0, 8)}</span>
                )}
                {target && <span className="text-muted ml-1">({target.agentTypeId})</span>}
              </p>
            </DetailRow>
            {action.subject && (
              <DetailRow label="Subject">
                <p className="text-primary text-xs">{action.subject}</p>
              </DetailRow>
            )}
          </div>
          <DetailRow label="Content">
            <div className="text-xs bg-surface-secondary rounded p-2 border border-th-border max-h-64 overflow-y-auto">
              <MarkdownContent className="prose-xs">{action.content}</MarkdownContent>
            </div>
          </DetailRow>
        </div>
      )
    }
    case 'create_work_stream': {
      const assignee = action.assigneeAgentId ? agentMap.get(action.assigneeAgentId) : null
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <DetailRow label="Title">
              <p className="text-primary text-xs">{action.title}</p>
            </DetailRow>
            {action.assigneeAgentId && (
              <DetailRow label="Assignee">
                <p className="text-primary text-xs">
                  {(assignee?.metadata?.name as string | undefined) || (
                    <span className="font-mono">{action.assigneeAgentId.slice(0, 8)}</span>
                  )}
                </p>
              </DetailRow>
            )}
          </div>
          {!hasLegacyWorkStreamAction(action) && (
            <DetailRow label="Workflow">
              <p className="text-secondary text-xs">
                {action.workflow
                  ? action.workflow.kind === 'preset'
                    ? action.workflow.id
                    : action.workflow.definition.name
                  : 'Squad default'}
              </p>
            </DetailRow>
          )}
          {action.description && (
            <DetailRow label="Description">
              <p className="text-secondary text-xs">{action.description}</p>
            </DetailRow>
          )}
        </div>
      )
    }
  }
}
