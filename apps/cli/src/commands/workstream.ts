import { registerWorkstreamCleanupCommands } from './workstream-cleanup'
import {
  workStreamLabel,
  workStreamRef,
  readDeliveryState,
  resolveTrackedResources,
  parseTrackedResourceReference,
  parseTrackedResourceUrl,
  trackedResourceLabel,
} from '@ficus/shared'
import { addStructuredInputOptions, readWorkflowSource } from '../structured-input'
import { registerWorkstreamFlowCommands, type WorkstreamFlowDependencies } from './workstream-flow'
import { Command, Option } from 'commander'
import { apiGet, apiPost, apiPatch, apiDelete } from '../client'
import { output, outputTable, outputError, isJsonMode, setOutputOptions } from '../output'
import { WORK_STREAM_COMPLETION_MODES, WORK_STREAM_PRIORITIES, WORK_STREAM_WAIT_ACTORS } from '@ficus/shared'
import { buildMetadataDelta, getMetadataValue, parseMetadataPath, parseMetadataValue } from '../metadata'
import { selectOpenWait } from './workstream-wait-selection'
import { describeAttention, performAttentionSubscribe, type SubscriptionResponse } from './attention'
import type {
  Agent as AgentJson,
  ResolvedTrackedResource,
  TrackedResourceKind,
  TrackedResourcesView,
  WorktreeCleanupSummary,
  WorkStreamCompletionMode,
  WorkStreamMetrics,
  WorkStreamPriority,
  WorkStreamSourceLink,
  WorkStreamAgentSummary as WorkStreamSpawnedAgentSummary,
} from '@ficus/shared'

export interface WorkStream {
  number?: number
  id: string
  squadId: string
  taskId: string | null
  title: string
  description: string
  status: string
  priority?: WorkStreamPriority
  effectivePriority?: WorkStreamPriority
  effectivePriorityVia?: string
  queuePosition?: number
  /** Park response only: the freed slot went straight back to this stream. */
  reAdmitted?: boolean
  waitingOnDependencies?: boolean
  assigneeAgentId: string | null
  ownerAgentId: string | null
  assignedReviewerIds?: string[]
  agentIds: string[] | null
  dependsOn: string[]
  derivedState?: string
  openWaits?: WorkStreamWaitSummary[]
  reviewRounds?: number
  reviewHistory?: WorkStreamWaitSummary[]
  waitHistory?: WorkStreamWaitSummary[]
  handoffMessage: string | null
  files: string[]
  response: string | string[] | null
  requestingUserId?: string | null
  requestingUserName?: string | null
  metadata: Record<string, unknown>
  completionMode?: WorkStreamCompletionMode
  branch?: string
  autoCleanupWorktree?: boolean
  worktreeCleanup?: WorktreeCleanupSummary | null
  worktree?: string
  baseBranch?: string
  spawnedAgents?: WorkStreamSpawnedAgentSummary[]
  observing?: boolean
  createdAt: string
  metrics?: WorkStreamMetrics | null
  /** create returns 200 with this set when an idempotent replay from --from-event matched an existing stream. */
  reusedFromEvent?: boolean
}

interface WorkStreamWaitSummary {
  id: string
  type: 'dependency' | 'question' | 'review' | 'manual'
  referenceId: string | null
  message: string | null
  /** Manual waits: who must act (human | owner). Older servers omit it. */
  actor?: string
  createdBy: string
  /** Review waits: false = mid-work checkpoint (approval does not complete the stream). */
  completesOnApproval?: boolean
  openedAt: string
  closedAt: string | null
  resolution: string | null
  resolutionNote: string | null
}

const statusColors: Record<string, string> = {
  queued: '\x1b[36m', // cyan (parked / waiting for an admission slot)
  active: '\x1b[34m', // blue
  done: '\x1b[32m', // green
  canceled: '\x1b[90m', // gray
  // derived display states
  in_progress: '\x1b[34m', // blue
  in_review: '\x1b[33m', // yellow
  waiting_on_answer: '\x1b[33m', // yellow
  waiting_on_dependency: '\x1b[36m', // cyan
  blocked: '\x1b[31m', // red
  idle: '\x1b[31m', // red — an admitted stream doing nothing for no recorded reason
  execution_failed: '\x1b[31m', // red — the newest execution failed and needs attention
}
const reset = '\x1b[0m'

function colorStatus(status: string): string {
  return `${statusColors[status] || ''}${status}${reset}`
}

/** Derived display + stored status when they differ (e.g. `in_review (active)`). */
function formatState(ws: Pick<WorkStream, 'status' | 'derivedState'>): string {
  if (!ws.derivedState || ws.derivedState === ws.status) return colorStatus(ws.status)
  return `${colorStatus(ws.derivedState)} (${ws.status})`
}

/**
 * Legacy status vocabulary (pre-consolidation), accepted in filters for one
 * release. Prints a deprecation note and returns the mapped value.
 */
const LEGACY_STATUS_MAP: Record<string, string> = {
  pending: 'queued',
  in_progress: 'active',
  blocked: 'active',
  review: 'active',
}

function mapLegacyStatusFilter(status: string): string {
  const mapped = LEGACY_STATUS_MAP[status]
  if (mapped) {
    console.error(
      `Note: status '${status}' is deprecated (statuses are now queued|active|done|canceled); filtering by '${mapped}'.`
    )
    return mapped
  }
  return status
}

// Format token count for display (e.g., 1234 -> "1.2K", 1234567 -> "1.2M")
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// Format duration in ms to human readable (e.g., 65000 -> "1m 5s")
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value])
}

export function parseMemorySourceLink(value: string): WorkStreamSourceLink {
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid --from-memory value: ${value}. Expected <squadId>:<path>`)
  }
  return {
    kind: 'memory_document',
    sourceSquadId: value.slice(0, separator),
    path: value.slice(separator + 1),
    addedAt: new Date().toISOString(),
  }
}

export function buildWorkStreamSourceLinks(options: {
  sourceLink?: string[]
  fromMemory?: string
  fromUrl?: string[]
  fromSlack?: string[]
}): WorkStreamSourceLink[] | undefined {
  const sources: WorkStreamSourceLink[] = []

  for (const raw of options.sourceLink ?? []) {
    const parsed = JSON.parse(raw) as Partial<WorkStreamSourceLink>
    sources.push({ ...parsed, addedAt: parsed.addedAt ?? new Date().toISOString() } as WorkStreamSourceLink)
  }

  if (options.fromMemory) sources.push(parseMemorySourceLink(options.fromMemory))

  for (const url of options.fromUrl ?? []) {
    sources.push({ kind: 'url', url, addedAt: new Date().toISOString() })
  }

  for (const url of options.fromSlack ?? []) {
    sources.push({ kind: 'slack_thread', url, addedAt: new Date().toISOString() })
  }

  return sources.length > 0 ? sources : undefined
}

export { WORK_STREAM_COMPLETION_MODES }

export function isWorkStreamCompletionMode(value: string): value is WorkStreamCompletionMode {
  return WORK_STREAM_COMPLETION_MODES.includes(value as WorkStreamCompletionMode)
}

function formatInvalidCompletionModeMessage(value: string): string {
  return `Invalid --completion-mode: ${value}. Must be one of: ${WORK_STREAM_COMPLETION_MODES.join(', ')}`
}

function validateWorkStreamCompletionMode(value: string | undefined): WorkStreamCompletionMode | undefined {
  if (value === undefined) return undefined
  if (!isWorkStreamCompletionMode(value)) {
    outputError(new Error(formatInvalidCompletionModeMessage(value)))
    process.exit(1)
    return undefined
  }
  return value
}

export function isWorkStreamPriority(value: string): value is WorkStreamPriority {
  return (WORK_STREAM_PRIORITIES as readonly string[]).includes(value)
}

export function formatInvalidPriorityMessage(value: string): string {
  return `Invalid --priority: ${value}. Must be one of: ${WORK_STREAM_PRIORITIES.join(', ')}`
}

function validateWorkStreamPriority(value: string | undefined): WorkStreamPriority | undefined {
  if (value === undefined) return undefined
  if (!isWorkStreamPriority(value)) {
    outputError(new Error(formatInvalidPriorityMessage(value)))
    process.exit(1)
    return undefined
  }
  return value
}

/** Compact table form: 'high', or 'low→high' when boosted by a dependent. */
export function formatWorkStreamPriorityCell(ws: Pick<WorkStream, 'priority' | 'effectivePriority'>): string {
  const stored = ws.priority ?? 'normal'
  if (ws.effectivePriority && ws.effectivePriority !== stored) return `${stored}→${ws.effectivePriority}`
  return stored
}

/** Long form for `ws get`: 'low (effective: high via <dependent title>)'. */
export function formatWorkStreamPriorityDetail(
  ws: Pick<WorkStream, 'priority' | 'effectivePriority' | 'effectivePriorityVia'>
): string {
  const stored = ws.priority ?? 'normal'
  if (ws.effectivePriority && ws.effectivePriority !== stored) {
    const via = ws.effectivePriorityVia ? ` via ${ws.effectivePriorityVia}` : ''
    return `${stored} (effective: ${ws.effectivePriority}${via})`
  }
  return stored
}

type WorkStreamAgentSummary = Pick<AgentJson, 'id' | 'agentTypeId' | 'status' | 'metadata'>

function formatAgentSummary(agentId: string, agent?: WorkStreamAgentSummary | null): string {
  const id = agent?.id ?? agentId
  const type = agent?.agentTypeId ?? 'unknown'
  const details = [type]
  const name = typeof agent?.metadata?.name === 'string' ? agent.metadata.name : undefined
  if (name) details.push(name)
  if (agent?.status) details.push(agent.status)

  return `${id.slice(0, 8)} (${details.join(', ')})`
}

async function getWorkStreamAgentSummaries(
  agentIds: string[] | null | undefined
): Promise<Map<string, WorkStreamAgentSummary | null>> {
  const summaries = new Map<string, WorkStreamAgentSummary | null>()
  if (!agentIds || agentIds.length === 0) return summaries

  await Promise.all(
    agentIds.map(async (agentId) => {
      try {
        const agent = await apiGet<WorkStreamAgentSummary>(`/api/agents/${agentId}`)
        summaries.set(agentId, agent)
      } catch {
        // Agents may have been deleted since being bound to the work stream.
        // Keep the work stream readable and mark missing details as unknown.
        summaries.set(agentId, null)
      }
    })
  )

  return summaries
}

export function getWorkStreamAgentTypes(
  agentIds: string[] | null | undefined,
  summaries: Map<string, WorkStreamAgentSummary | null> = new Map()
): Record<string, string> {
  const agentTypes: Record<string, string> = {}
  for (const agentId of agentIds ?? []) {
    agentTypes[agentId] = summaries.get(agentId)?.agentTypeId ?? 'unknown'
  }
  return agentTypes
}

export function parseAgentModelOverrides(values: string[] = []): Map<string, string> {
  const overrides = new Map<string, string>()

  for (const value of values) {
    const separatorIndex = value.indexOf('=')
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
      throw new Error(
        `Invalid --agent-model value "${value}". Expected format: <agentType>=<provider:model-id[:thinking-level]>[,<spec>...]`
      )
    }

    const agentType = value.slice(0, separatorIndex).trim()
    const model = value.slice(separatorIndex + 1).trim()
    if (!agentType || !model) {
      throw new Error(
        `Invalid --agent-model value "${value}". Expected format: <agentType>=<provider:model-id[:thinking-level]>[,<spec>...]`
      )
    }

    overrides.set(agentType, model)
  }

  return overrides
}

export function resolveWorkStreamSpawnModel(
  agentTypeId: string,
  defaultModel?: string,
  agentModelOverrides: Map<string, string> = new Map()
): string | undefined {
  return agentModelOverrides.get(agentTypeId) ?? defaultModel
}

export function buildWorkStreamSpawnAgentBody(
  agentTypeId: string,
  model?: string,
  agentModelOverrides: Map<string, string> = new Map()
): { agentTypeId: string; model?: string } {
  const resolvedModel = resolveWorkStreamSpawnModel(agentTypeId, model, agentModelOverrides)
  return {
    agentTypeId,
    ...(resolvedModel ? { model: resolvedModel } : {}),
  }
}

export function formatWorkStreamAgents(
  agentIds: string[] | null | undefined,
  summaries: Map<string, WorkStreamAgentSummary | null> = new Map()
): string {
  if (!agentIds || agentIds.length === 0) return '(any)'
  return agentIds.map((agentId) => formatAgentSummary(agentId, summaries.get(agentId))).join(', ')
}

export function registerWorkstreamCommands(program: Command, flowDependencies?: WorkstreamFlowDependencies) {
  const ws = program.command('workstream').alias('ws').description('Manage work streams')
  registerWorkstreamFlowCommands(ws, flowDependencies)
  registerWorkstreamCleanupCommands(ws)

  // ficus workstream list [--squad <id>] [--task <id>] [--status <status>]
  ws.command('list')
    .description('List work streams')
    .option('-q, --squad <squadId>', 'Filter by squad ID')
    .option('-t, --task <taskId>', 'Filter by task ID')
    .option('-s, --status <status>', 'Filter by status')
    .option('--json', 'Output in JSON format')
    .option('--no-truncate', 'Show full table values without shortening titles')
    .action(async (options) => {
      if (options.json) setOutputOptions({ json: true })
      try {
        const params = new URLSearchParams()
        if (options.squad) params.set('squadId', options.squad)
        if (options.task) params.set('taskId', options.task)
        if (options.status) params.set('status', mapLegacyStatusFilter(options.status))
        const query = params.toString()

        const streams = await apiGet<WorkStream[]>(`/api/workstreams${query ? `?${query}` : ''}`)

        if (isJsonMode()) {
          output(streams)
        } else {
          if (streams.length === 0) {
            console.log('No work streams found')
            return
          }
          outputTable(
            streams.map((ws) => ({
              ID: workStreamLabel(ws),
              Title:
                options.truncate === false ? ws.title : ws.title.slice(0, 30) + (ws.title.length > 30 ? '...' : ''),
              Status: formatState(ws),
              Priority: formatWorkStreamPriorityCell(ws),
              Pos: ws.queuePosition ?? (ws.waitingOnDependencies ? 'deps' : '-'),
              Squad: ws.squadId.slice(0, 8),
              Deps: ws.dependsOn.length || '-',
            })),
            ['ID', 'Title', 'Status', 'Priority', 'Pos', 'Squad', 'Deps']
          )
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream create <title> --squad <squadId> [options]
  ws.command('reviewers')
    .description('List users eligible to review work streams in a squad')
    .requiredOption('-q, --squad <squadId>', 'Squad ID')
    .action(async (options) => {
      try {
        output(await apiGet(`/api/workflows/reviewers?squadId=${encodeURIComponent(options.squad)}`))
      } catch (error) {
        outputError(error as Error)
      }
    })

  addStructuredInputOptions(ws.command('create <title>'), true)
    .alias('new')
    .description('Create a work stream using the squad default or an explicit workflow')
    .option('--workflow <id>', 'Saved workflow; participants are created lazily')
    .requiredOption('-q, --squad <squadId>', 'Squad ID')
    .option('-t, --task <taskId>', 'Associated task ID')
    .option('-d, --description <desc>', 'Description')
    .option('--owner <agentId>', 'Owner agent for this work stream (receives lifecycle notifications)')
    .addOption(
      new Option('--observe <events>', 'Agent-only, one-shot terminal update; does not change ownership').choices([
        'terminal',
      ])
    )
    .option('--reviewer <userId>', 'Assign a reviewer user ID (can repeat)', collect, [])
    .option('--depends-on <wsId>', 'Dependency work stream ID (can repeat)', collect, [])
    .option('--priority <priority>', `Scheduling priority: ${WORK_STREAM_PRIORITIES.join(', ')} (default: normal)`)
    .option('--repository <path>', 'Create or validate a worktree from this repository in the squad workspace')
    .option(
      '--auto-cleanup-worktree <true|false>',
      'Reclaim an owned worktree after delivery (new streams: true); set false to retain unless removal is already in flight'
    )
    .option('--git-remote <name>', 'Remote for code-host detection and default base (default: origin)')
    .option('--branch <name>', 'Git branch for this work stream (stored at git.branch metadata)')
    .option('--worktree <path>', 'Worktree path for this work stream (stored at git.worktree metadata)')
    .option('--base-branch <name>', 'Base branch for provisioning and delivery')
    .addOption(
      new Option('--base-source <source>', 'New branch base source (default: remote)').choices(['remote', 'local'])
    )
    .option('--source-link <json>', 'Attach a WorkStreamSourceLink JSON object (repeatable)', collect, [])
    .option('--from-memory <squadId:path>', 'Shortcut: attach a memory_document source link')
    .option('--from-url <url>', 'Shortcut: attach a url source link (repeatable)', collect, [])
    .option('--from-slack <permalink>', 'Shortcut: attach a slack_thread source link (repeatable)', collect, [])
    .option(
      '--from-event <eventId>',
      'Create idempotently from an integration event; replays return the existing work stream'
    )
    .option('-m, --message <msg>', 'Handoff message (included in assignment notifications)')
    .option(
      '--requesting-user <userId>',
      'Attribute the request to a specific user (defaults to whoever you are chatting with)'
    )
    .option('--json', 'Output in JSON format')
    .action(async (title, options) => {
      if (options.json) setOutputOptions({ json: true })
      try {
        const autoCleanupWorktree = parseCleanupSetting(options.autoCleanupWorktree)
        const priority = validateWorkStreamPriority(options.priority as string | undefined)

        const sources = buildWorkStreamSourceLinks(options)

        const workflow = await readWorkflowSource(options)
        const ws = await apiPost<WorkStream>('/api/workstreams', {
          ...(workflow ? { workflow } : {}),
          squadId: options.squad,
          taskId: options.task,
          title,
          description: options.description,
          ownerAgentId: options.owner,
          ...(options.observe ? { observe: options.observe } : {}),
          ...(options.reviewer?.length ? { assignedReviewerIds: options.reviewer } : {}),
          handoffMessage: options.message,
          ...(options.requestingUser ? { requestingUserId: options.requestingUser } : {}),
          dependsOn: options.dependsOn,
          ...(priority !== undefined ? { priority } : {}),
          ...(sources !== undefined ? { metadata: { sources } } : {}),
          ...(options.branch !== undefined ? { branch: options.branch } : {}),
          ...(options.repository !== undefined ? { repository: options.repository } : {}),
          ...(autoCleanupWorktree !== undefined ? { autoCleanupWorktree } : {}),
          ...(options.gitRemote !== undefined ? { gitRemote: options.gitRemote } : {}),
          ...(options.worktree !== undefined ? { worktree: options.worktree } : {}),
          ...(options.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
          ...(options.baseSource !== undefined ? { baseSource: options.baseSource } : {}),
          ...(options.fromEvent !== undefined ? { integrationEventId: options.fromEvent } : {}),
        })

        output(
          ws,
          ws.reusedFromEvent
            ? `Reused existing work stream ${workStreamLabel(ws)} for this event`
            : `Created work stream ${workStreamLabel(ws)}: ${ws.title}`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream get <id>
  ws.command('get <id>')
    .alias('info')
    .description('Get work stream details')
    .option('--metrics', 'Include usage metrics (tokens, cost, duration)')
    .action(async (id, options) => {
      try {
        const params = options.metrics ? '?metrics=true' : ''
        const ws = await apiGet<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}${params}`)
        const agentSummaries = await getWorkStreamAgentSummaries(ws.agentIds)

        if (isJsonMode()) {
          output({ ...ws, agentTypes: getWorkStreamAgentTypes(ws.agentIds, agentSummaries) })
        } else {
          console.log(`Work:        ${workStreamLabel(ws)}`)
          console.log(`Title:       ${ws.title}`)
          console.log(`Status:      ${formatState(ws)}`)
          if (ws.observing !== undefined) console.log(`Observing:   ${ws.observing ? 'terminal (one-shot)' : 'no'}`)
          console.log(
            `Auto cleanup: ${ws.autoCleanupWorktree ? 'enabled (after delivery and execution settlement)' : 'disabled (retain worktree)'}`
          )
          if (ws.worktreeCleanup)
            console.log(
              `Cleanup:     ${ws.worktreeCleanup.status}${ws.worktreeCleanup.reason ? ` — ${ws.worktreeCleanup.reason}` : ''}`
            )
          console.log(`Priority:    ${formatWorkStreamPriorityDetail(ws)}`)
          if (ws.queuePosition !== undefined) {
            console.log(`Queue Pos:   ${ws.queuePosition}`)
          } else if (ws.waitingOnDependencies) {
            console.log(`Queue Pos:   waiting on dependencies (not eligible until every dependency is done)`)
          }
          console.log(`Squad:       ${ws.squadId}`)
          console.log(`Task:        ${ws.taskId || '(none)'}`)
          console.log(`Assignee:    ${ws.assigneeAgentId || '(none)'}`)
          if (ws.requestingUserId) {
            const who = ws.requestingUserName || ws.requestingUserId.slice(0, 8)
            console.log(`Requested By: ${who} [${ws.requestingUserId.slice(0, 8)}]`)
          }
          console.log(`Agents:      ${formatWorkStreamAgents(ws.agentIds, agentSummaries)}`)
          console.log(
            `Reviewers:   ${ws.assignedReviewerIds?.length ? ws.assignedReviewerIds.join(', ') : 'Anyone with review permission'}`
          )
          console.log(
            `Depends On:  ${ws.dependsOn.length > 0 ? (await Promise.all(ws.dependsOn.map(async (id) => workStreamLabel(await apiGet<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}`))))).join(', ') : '(none)'}`
          )
          if (ws.description) {
            console.log(`Description: ${ws.description}`)
          }
          const tracked = resolveTrackedResources(ws.metadata)
          if (tracked.length > 0) {
            const observed = readDeliveryState(ws.metadata).pullRequests
            console.log(`\n\x1b[36mTracked:\x1b[0m`)
            for (const resource of tracked) {
              console.log(`  ${formatTrackedResourceLine(resource, observed[resource.key]?.state)}`)
            }
          }
          if (ws.openWaits && ws.openWaits.length > 0) {
            console.log(`\n\x1b[33mOpen waits:\x1b[0m`)
            for (const wait of ws.openWaits) {
              const opened = new Date(wait.openedAt).toLocaleString()
              // The id is what `resolve`/`approve`/`send-back --wait <id>`
              // take when multiple waits of one type are open.
              const checkpoint = wait.type === 'review' && wait.completesOnApproval === false ? ', checkpoint' : ''
              const actor = wait.type === 'manual' && wait.actor ? `, actor: ${wait.actor}` : ''
              console.log(
                `  [${wait.type}] ${wait.id} (since ${opened}${checkpoint}${actor})${wait.message ? ` — ${wait.message}` : ''}`
              )
            }
          }
          if (ws.reviewRounds !== undefined && ws.reviewRounds > 0) {
            console.log(`Review rounds: ${ws.reviewRounds}`)
          }
          // The auditable closed-wait trail. Open waits are shown above; this is
          // every resolved wait (type, how it resolved, and the resolution note).
          const closedWaits = (ws.waitHistory ?? []).filter((wait) => wait.closedAt)
          if (closedWaits.length > 0) {
            console.log(`\n\x1b[90mWait history (resolved):\x1b[0m`)
            for (const wait of closedWaits) {
              const closed = wait.closedAt ? new Date(wait.closedAt).toLocaleString() : '?'
              const resolution = wait.resolution ? ` ${wait.resolution}` : ''
              const note = wait.resolutionNote ? ` — ${wait.resolutionNote}` : wait.message ? ` — ${wait.message}` : ''
              console.log(`  [${wait.type}]${resolution} (closed ${closed})${note}`)
            }
          }
          if (ws.files && ws.files.length > 0) {
            console.log(`Files:       ${ws.files.join(', ')}`)
          }
          if (ws.handoffMessage) {
            console.log(`\n\x1b[36mHandoff:\x1b[0m ${ws.handoffMessage}`)
          }
          if (ws.metadata && Object.keys(ws.metadata).length > 0) {
            console.log(`\n\x1b[35mMetadata:\x1b[0m`)
            for (const [key, value] of Object.entries(ws.metadata)) {
              const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value)
              console.log(`  ${key}: ${valueStr}`)
            }
          }
          if (ws.metrics) {
            const m = ws.metrics
            const costStr = m.cost < 0.01 ? `$${m.cost.toFixed(4)}` : `$${m.cost.toFixed(2)}`
            console.log(`\n\x1b[36mMetrics:\x1b[0m`)
            console.log(`  Cost:       ${costStr}`)
            console.log(
              `  Tokens:     ${formatTokens(m.tokens.total)} (in: ${formatTokens(m.tokens.input)}, out: ${formatTokens(m.tokens.output)})`
            )
            console.log(`  Executions: ${m.executions.completed}/${m.executions.total} completed`)
            if (m.duration.totalMs > 0) {
              console.log(`  Duration:   ${formatDuration(m.duration.totalMs)}`)
            }
          }
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream update <id> [options]
  ws.command('update <id>')
    .alias('edit')
    .description('Update a work stream')
    .option('-s, --status <status>', 'New status')
    .option('--priority <priority>', `Scheduling priority: ${WORK_STREAM_PRIORITIES.join(', ')}`)
    .option('--depends-on <wsId>', 'Replace dependencies with these work stream IDs (can repeat)', collect, [])
    .option('--clear-dependencies|--remove-dependency', 'Clear all dependencies (cannot be combined with --depends-on)')
    .option('--title <title>', 'New title')
    .option('-d, --description <desc>', 'New description')
    .option('--assign <agentId>', 'Assign to agent')
    .option('--unassign', 'Remove assignee')
    .option('--owner <agentId>', 'Owner agent for this work stream (receives lifecycle notifications)')
    .option('--clear-owner', 'Clear owner agent and fall back to manager routing')
    .option('--agent-ids <ids>', 'Agent IDs to bind (comma-separated)')
    .option('--clear-agents', 'Remove agent restrictions')
    .option('--reviewer <userId>', 'Replace assigned reviewers with these user IDs (can repeat)', collect, [])
    .option('--clear-reviewers', 'Clear the reviewer filter; anyone with review permission may decide')
    .option('-m, --message <msg>', 'Handoff message (included in assignment notifications)')
    .option('-f, --file <path>', 'Attach file path (can repeat)', collect, [])
    .option('--repository <path>', 'Create or validate a worktree from this repository in the squad workspace')
    .option(
      '--auto-cleanup-worktree <true|false>',
      'Reclaim an owned worktree after delivery (new streams: true); set false to retain unless removal is already in flight'
    )
    .option('--git-remote <name>', 'Remote for code-host detection and default base (default: origin)')
    .option('--branch <name>', 'Git branch for this work stream')
    .option('--worktree <path>', 'Worktree path for this work stream')
    .option('--base-branch <name>', 'Base branch for provisioning and delivery')
    .addOption(
      new Option('--base-source <source>', 'New branch base source (default: remote)').choices(['remote', 'local'])
    )
    .option(
      '--completion-mode <mode>',
      "Completion mode: 'pr-merge' (default), 'pr-auto-merge', 'review-approval', or 'direct-merge'"
    )
    .action(async (id, options) => {
      try {
        // --clear-dependencies and --remove-dependency are one multi-name
        // flag; commander exposes it under either spelling's camelCase key.
        if (options.clearReviewers && options.reviewer?.length)
          throw new Error('--clear-reviewers and --reviewer are mutually exclusive')
        const clearDependencies = options.clearDependencies === true || options.removeDependency === true
        if (clearDependencies && options.dependsOn && options.dependsOn.length > 0) {
          outputError(
            new Error(
              '--clear-dependencies/--remove-dependency and --depends-on are mutually exclusive: either clear all dependencies or provide the new dependency list, not both.'
            )
          )
          process.exit(1)
          return
        }
        const completionMode = validateWorkStreamCompletionMode(options.completionMode as string | undefined)
        const autoCleanupWorktree = parseCleanupSetting(options.autoCleanupWorktree)
        const priority = validateWorkStreamPriority(options.priority as string | undefined)
        const updates: Record<string, unknown> = {}
        if (autoCleanupWorktree !== undefined) updates.autoCleanupWorktree = autoCleanupWorktree
        if (options.clearReviewers) updates.assignedReviewerIds = []
        else if (options.reviewer?.length) updates.assignedReviewerIds = options.reviewer
        if (options.status) {
          if (options.status === 'blocked' || options.status === 'review') {
            outputError(
              new Error(
                `'${options.status}' is no longer a status. Use 'ficus workstream ${options.status === 'blocked' ? 'request-input <id> -m "<why>"' : 'request-review <id> -m "<note>"'}' instead.`
              )
            )
            return
          }
          if (LEGACY_STATUS_MAP[options.status]) {
            console.error(
              `Note: status '${options.status}' is deprecated; writing '${LEGACY_STATUS_MAP[options.status]}' (statuses are now queued|active|done|canceled).`
            )
          }
          updates.status = options.status
        }
        if (priority !== undefined) updates.priority = priority
        if (clearDependencies) updates.dependsOn = []
        else if (options.dependsOn && options.dependsOn.length > 0) updates.dependsOn = options.dependsOn
        if (options.title) updates.title = options.title
        if (options.description) updates.description = options.description
        if (options.assign) updates.assigneeAgentId = options.assign
        if (options.unassign) updates.assigneeAgentId = null
        if (options.owner) updates.ownerAgentId = options.owner
        if (options.clearOwner) updates.ownerAgentId = null
        if (options.agentIds) updates.agentIds = options.agentIds.split(',').map((id: string) => id.trim())
        if (options.clearAgents) updates.agentIds = null
        if (options.message) updates.handoffMessage = options.message
        if (options.file && options.file.length > 0) updates.files = options.file
        if (completionMode !== undefined) updates.completionMode = completionMode
        if (options.branch !== undefined) updates.branch = options.branch
        if (options.repository !== undefined) updates.repository = options.repository
        if (options.gitRemote !== undefined) updates.gitRemote = options.gitRemote
        if (options.worktree !== undefined) updates.worktree = options.worktree
        if (options.baseBranch !== undefined) updates.baseBranch = options.baseBranch
        if (options.baseSource !== undefined) updates.baseSource = options.baseSource

        const ws = await apiPatch<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}`, updates)
        output(ws, `Updated work stream ${workStreamLabel(ws)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // Resolve sugar: fetch the stream's open waits and pick the one to resolve.
  // With more than one open wait of the target type, refuse and require --wait.
  // The stream's waitHistory rides along so a --wait id that names a CLOSED
  // wait can be reported precisely instead of as a generic no-match.
  const resolveTargetWait = async (
    id: string,
    type: 'review' | 'manual',
    typeLabel: string,
    explicitWaitId: string | undefined
  ): Promise<{ ws: WorkStream; wait: { id: string } }> => {
    const ws = await apiGet<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}`)
    const wait = selectOpenWait(ws.openWaits, type, {
      explicitWaitId,
      typeLabel,
      history: ws.waitHistory,
    })
    return { ws, wait }
  }

  // ficus workstream request-input <id> --message <msg> [--file <path>...]
  ws.command('request-input <id>')
    .description(
      'Open a manual wait: the work stream cannot proceed until the named actor acts (--actor human by default)'
    )
    .requiredOption('-m, --message <msg>', 'What input/action is needed, and from whom (the wait message)')
    .addOption(
      new Option(
        '--actor <actor>',
        "Who must act: human (the user/operator must act; shown to users as an action to take) or owner (the stream's owning agent; the squad manager if none). Questions use ask_human; prerequisite deliverables use dependsOn"
      ).choices([...WORK_STREAM_WAIT_ACTORS])
    )
    .option('-f, --file <path>', 'File to include for context (can repeat; stored on the work stream)', collect, [])
    .option('--scope <scope>', 'Wait scope: stream or attempt (agents default to their active attempt)')
    .option('--attempt <id>', 'Flow attempt ID to block', parseInt)
    .action(async (id, options) => {
      try {
        if (options.file.length > 0) {
          await apiPatch<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}`, { files: options.file })
        }
        const ws = await apiPost<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}/request-input`, {
          message: options.message,
          scope: options.scope,
          flowAttemptId: options.attempt,
          actor: options.actor,
        })
        const actor = options.actor && options.actor !== 'human' ? ` [actor: ${options.actor}]` : ''
        output(
          ws,
          `Work stream ${workStreamLabel(ws)} is requesting input (manual wait opened${actor}): ${options.message}`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream wait-actor <id> <actor> [--wait <waitId>] [-m <note>]
  ws.command('wait-actor <id> <actor>')
    .description(
      'Correct who must act on an open manual wait (human|owner); the wait stays open and keeps blocking. Stream owner agent or squad manager only; audited on the wait'
    )
    .option('--wait <waitId>', 'Manual wait id to relabel (required when several manual waits are open)')
    .option('-m, --message <note>', 'Why the actor changed (recorded in the wait audit trail)')
    .action(async (id, actor, options) => {
      try {
        if (!(WORK_STREAM_WAIT_ACTORS as readonly string[]).includes(actor)) {
          throw new Error(`Invalid actor '${actor}'. Use one of: ${WORK_STREAM_WAIT_ACTORS.join(', ')}`)
        }
        const { ws: found, wait } = await resolveTargetWait(id, 'manual', 'manual (input-request)', options.wait)
        const ws = await apiPost<WorkStream & { changed?: boolean }>(
          `/api/workstreams/${found.id}/waits/${wait.id}/actor`,
          { actor, ...(options.message ? { note: options.message } : {}) }
        )
        output(
          ws,
          ws.changed === false
            ? `Wait ${wait.id.slice(0, 8)} on work stream ${workStreamLabel(ws)} already has actor ${actor}`
            : `Wait ${wait.id.slice(0, 8)} on work stream ${workStreamLabel(ws)} now waits on: ${actor}`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream unblock <id> [--message <note>] [--wait <waitId>]
  ws.command('unblock <id>')
    .description("Clear the work stream's open manual wait (with several open, pass --wait <id>)")
    .option('-m, --message <note>', 'Resolution note recorded on the cleared wait and delivered to the assignee')
    .option('--wait <waitId>', 'Wait id to clear (required when several manual waits are open)')
    .action(async (id, options) => {
      try {
        const { ws: found, wait } = await resolveTargetWait(id, 'manual', 'manual (input-request)', options.wait)
        const ws = await apiPost<WorkStream>(`/api/workstreams/${found.id}/waits/${wait.id}/resolve`, {
          resolution: 'cleared',
          ...(options.message ? { note: options.message } : {}),
        })
        output(ws, `Work stream ${workStreamLabel(ws)} unblocked (wait ${wait.id.slice(0, 8)} cleared)`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream approve <id> [-m <note>] [--wait <waitId>]
  ws.command('approve <id>')
    .description(
      'Approve the open review: completes the stream in one transaction (a --no-complete checkpoint review resolves the wait only)'
    )
    .option('--wait <waitId>', 'Review wait id to approve (required when several review waits are open)')
    .option('-m, --message <note>', 'Approval note recorded on the wait and delivered with the outcome notification')
    .option('--note <note>', 'Alias for -m/--message')
    .action(async (id, options) => {
      try {
        const note = options.message || options.note
        const { ws: found, wait } = await resolveTargetWait(id, 'review', 'review', options.wait)
        const ws = await apiPost<WorkStream>(`/api/workstreams/${found.id}/waits/${wait.id}/resolve`, {
          resolution: 'approved',
          ...(note ? { note } : {}),
        })
        output(
          ws,
          ws.status === 'done'
            ? `Approved work stream ${workStreamLabel(ws)} — done`
            : `Approved checkpoint review on work stream ${workStreamLabel(ws)} — stream continues (status: ${ws.status})`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream send-back <id> -m <feedback> [--wait <waitId>] (alias: reject)
  ws.command('send-back <id>')
    .alias('reject')
    .description('Close the open review wait with required feedback; the stream stays schedulable')
    .option('-m, --message <feedback>', 'Send-back feedback (required)')
    .option('--note <note>', 'Alias for -m/--message')
    .option('-r, --reason <reason>', 'Alias for -m/--message')
    .option('--wait <waitId>', 'Review wait id to send back (required when several review waits are open)')
    .action(async (id, options) => {
      try {
        const note = options.message || options.note || options.reason
        if (!note) {
          outputError(new Error('Send-back requires feedback: pass -m "<feedback>"'))
          return
        }
        const { ws: found, wait } = await resolveTargetWait(id, 'review', 'review', options.wait)
        const ws = await apiPost<WorkStream>(`/api/workstreams/${found.id}/waits/${wait.id}/resolve`, {
          resolution: 'sent_back',
          note,
        })
        output(ws, `Sent work stream ${workStreamLabel(ws)} back with feedback (review round recorded)`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream request-review <id> --message <msg> [--file <path>...]
  ws.command('request-review <id>')
    .description('Open the review wait: the work is ready for someone to review (idempotent while open)')
    .requiredOption('-m, --message <msg>', 'What to review (stored on the review wait)')
    .option('-f, --file <path>', 'Artifact file to review (can repeat; stored on the work stream)', collect, [])
    .option(
      '--no-complete',
      'Mid-work checkpoint review: approval resolves the wait only and the stream continues (default: approval completes the stream)'
    )
    .action(async (id, options) => {
      try {
        if (options.file.length > 0) {
          await apiPatch<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}`, { files: options.file })
        }
        const ws = await apiPost<
          WorkStream & { alreadyOpen?: boolean; wait?: { id: string; completesOnApproval?: boolean } }
        >(`/api/workstreams/${encodeURIComponent(id)}/request-review`, {
          message: options.message,
          ...(options.complete === false ? { completesOnApproval: false } : {}),
        })
        // The no-op keeps the EXISTING wait's completesOnApproval; surface a
        // mismatch so a checkpoint request against a completing wait (or vice
        // versa) isn't silently ignored.
        const requestedCompletes = options.complete !== false
        const existingCompletes = ws.wait?.completesOnApproval ?? true
        const flagMismatch =
          ws.alreadyOpen && ws.wait && requestedCompletes !== existingCompletes
            ? ` — note: the open wait has completesOnApproval=${existingCompletes} and keeps it (your request asked for ${requestedCompletes}; resolve or send back the open wait first to change it)`
            : ''
        output(
          ws,
          ws.alreadyOpen
            ? `Work stream ${workStreamLabel(ws)} already has an open review wait (no-op)${flagMismatch}`
            : `Work stream ${workStreamLabel(ws)} ready for review (review wait open${options.complete === false ? '; checkpoint — approval will not complete the stream' : ''})`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream handoff <id> --to <agentId> --message <msg> [options]
  // Reassignment only — opening a review wait is `request-review`.
  ws.command('handoff <id>')
    .description('Hand off the work stream to another agent (reassignment; use request-review to ask for review)')
    .option('--to <agentId>', 'Agent to hand off to')
    .requiredOption('-m, --message <msg>', "Handoff message explaining what was done/what's next")
    .option('-f, --file <path>', 'File to include for context (can repeat)', collect, [])
    .action(async (id, options) => {
      try {
        if (!options.to) {
          outputError(
            new Error(
              'handoff requires --to <agentId> (message-only handoff no longer opens a review — ' +
                'use `ficus workstream request-review <id> -m "<msg>"` to ask for review)'
            )
          )
          return
        }
        const ws = await apiPatch<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}`, {
          assigneeAgentId: options.to,
          handoffMessage: options.message,
          ...(options.file.length > 0 ? { files: options.file } : {}),
        })
        output(
          ws,
          ws.status === 'queued'
            ? `Work stream ${workStreamLabel(ws)} handed off to ${options.to}; pending admission; recipient will be notified on promotion`
            : `Work stream ${workStreamLabel(ws)} handed off to ${options.to}`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream done <id> [--next-steps <notes>]
  ws.command('done <id>')
    .description('Mark work stream as done')
    .option(
      '--next-steps <notes>',
      'Follow-up notes to persist on the work stream and include in completion notifications'
    )
    .action(async (id, options) => {
      try {
        const ws = await apiPatch<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}`, {
          status: 'done',
          ...(options.nextSteps ? { nextSteps: options.nextSteps } : {}),
        })

        output(ws, `Work stream ${workStreamLabel(ws)} marked done`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  ws.command('pause <id>')
    .description(
      'Stop current work and suppress dispatch/idle follow-ups until explicit resume; keep the admission slot'
    )
    .option('--reason <text>', 'Reason shown to assigned agents')
    .option('--park-after <minutes>', 'Release the slot after this many paused minutes; remain paused')
    .action(async (id, options: { reason?: string; parkAfter?: string }) => {
      try {
        const minutes = options.parkAfter === undefined ? undefined : Number(options.parkAfter)
        if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080))
          throw new Error('--park-after must be an integer from 1 to 10080')
        const stream = await apiPost<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}/pause`, {
          ...(options.reason ? { reason: options.reason } : {}),
          ...(minutes !== undefined ? { parkAfterMinutes: minutes } : {}),
        })
        output(stream, `Paused work stream ${workStreamLabel(stream)} until explicit resume`)
      } catch (error) {
        outputError(error as Error)
      }
    })
  ws.command('resume <id>')
    .description('Resume paused work; if parked, wait for an admission slot before dispatch')
    .action(async (id) => {
      try {
        const stream = await apiPost<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}/resume`)
        output(stream, `Resumed work stream ${workStreamLabel(stream)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream park <id>
  ws.command('park <id>')
    .description(
      'Park an admitted work stream. For running work, ask the running agent to stop at a safe point and ' +
        'wait for confirmation before parking. It releases the concurrency slot, stops agents’ sandboxes, ' +
        'and re-enters the stream at its effective priority.'
    )
    .option(
      '--preempt-running',
      'Discard a running turn only when genuinely abandonable; normally ask the agent to stop and wait for confirmation first'
    )
    .action(async (id, options: { preemptRunning?: boolean }) => {
      try {
        const ws = options.preemptRunning
          ? await apiPost<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}/park`, { preemptRunning: true })
          : await apiPost<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}/park`)
        if (ws.reAdmitted) {
          output(
            ws,
            `Parked work stream ${workStreamLabel(ws)} was immediately re-admitted — it is the highest-priority ` +
              `eligible stream in the queue, so this park freed nothing. Park a lower-priority stream instead, ` +
              `or lower this stream's priority first.`
          )
        } else {
          const pos = ws.queuePosition !== undefined ? ` (queue position ${ws.queuePosition})` : ''
          output(ws, `Parked work stream ${workStreamLabel(ws)}${pos}`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream reopen <id>
  ws.command('reopen <id>')
    .description(
      'Reopen a done or canceled work stream: it re-enters admission (active if a slot is free, else queued)'
    )
    .action(async (id) => {
      try {
        const ws = await apiPost<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}/reopen`)
        output(
          ws,
          ws.status === 'active'
            ? `Reopened work stream ${workStreamLabel(ws)} — admitted (active)`
            : `Reopened work stream ${workStreamLabel(ws)} — queued for admission`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream cancel <id>
  ws.command('cancel <id>')
    .description('Cancel a work stream and stop assigned active executions where possible')
    .action(async (id) => {
      try {
        const ws = await apiPost<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}/cancel`)
        output(ws, `Canceled work stream ${workStreamLabel(ws)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream find-by-meta --match <path>=<value> [--match ...] [--status <status>] [--id-only] [--squad-id-only]
  ws.command('find-by-meta')
    .description('Find work streams by metadata fields')
    .option('-m, --match <pathValue>', 'Match criterion in path=value format (repeatable)', collect, [])
    .option('-s, --status <status>', 'Filter by status')
    .option('--id-only', 'Output only the work stream ID(s)')
    .option('--squad-id-only', 'Output only the squad ID(s)')
    .action(async (options) => {
      try {
        if (!options.match || options.match.length === 0) {
          throw new Error('At least one --match option is required')
        }

        const params = new URLSearchParams()
        if (options.status) params.set('status', mapLegacyStatusFilter(options.status))

        for (const matchStr of options.match) {
          const eqIndex = matchStr.indexOf('=')
          if (eqIndex === -1) {
            throw new Error(`Invalid match format: "${matchStr}". Expected "path=value"`)
          }
          const path = matchStr.slice(0, eqIndex)
          const value = matchStr.slice(eqIndex + 1)
          if (!path) {
            throw new Error(`Invalid match format: "${matchStr}". Path cannot be empty`)
          }
          params.append('match', `${path}:${value}`)
        }

        const streams = await apiGet<WorkStream[]>(`/api/workstreams/by-metadata?${params}`)
        if (streams.length === 0) {
          if (!isJsonMode()) console.log('No matching work streams found')
          return
        }

        if (options.idOnly) {
          for (const ws of streams) console.log(workStreamRef(ws))
        } else if (options.squadIdOnly) {
          const uniqueSquadIds = [...new Set(streams.map((ws) => ws.squadId))]
          for (const sid of uniqueSquadIds) console.log(sid)
        } else {
          outputTable(streams, ['id', 'squadId', 'title', 'status', 'assigneeAgentId'])
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  ws.command('notify-ci <id> <recipientId>')
    .description('Atomically settle one terminal workflow notification and its per-workflow watermark')
    .requiredOption('--repository <repository>', 'Repository owner/name')
    .requiredOption('--workflow-id <id>', 'Stable provider workflow ID')
    .requiredOption('--run-id <id>', 'Provider run ID')
    .requiredOption('--run-number <number>', 'Numeric workflow run number')
    .requiredOption('--run-attempt <attempt>', 'Numeric run attempt')
    .requiredOption('--conclusion <conclusion>', 'Terminal conclusion')
    .requiredOption('--subject <subject>', 'Notification subject')
    .requiredOption('--content <content>', 'Notification content')
    .action(async (id, recipientId, options) => {
      try {
        const result = await apiPost(`/api/workstreams/${encodeURIComponent(id)}/ci-notification`, {
          recipientId,
          ...options,
        })
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })

  const arrayHelp =
    '\nArrays replace the whole array. To change one element, get the array, modify it, then set the entire array key.\n'

  ws.command('set-meta <id> <key> <value>')
    .description('Set a metadata field on a work stream using a dot path')
    .addHelpText('after', arrayHelp)
    .action(async (id, key, value) => {
      try {
        const updated = await apiPatch<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}`, {
          metadata: buildMetadataDelta(key, parseMetadataValue(value)),
        })
        output(updated, `Set ${key}=${value} on work stream ${id.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  ws.command('unset-meta <id> <key>')
    .description('Delete a metadata field from a work stream using a dot path')
    .addHelpText('after', arrayHelp)
    .action(async (id, key) => {
      try {
        const updated = await apiPatch<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}`, {
          metadata: buildMetadataDelta(key, null),
        })
        output(updated, `Unset ${key} on work stream ${id.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  ws.command('get-meta <id> <key>')
    .description('Get a metadata value from a work stream using a dot path')
    .addHelpText('after', arrayHelp)
    .action(async (id, key) => {
      try {
        parseMetadataPath(key)
        const stream = await apiGet<WorkStream>(`/api/workstreams/${encodeURIComponent(id)}`)
        const value = getMetadataValue(stream.metadata ?? {}, key)
        output(isJsonMode() ? value : JSON.stringify(value, null, 2))
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream add-agent <workstreamId> <types...>
  ws.command('add-agent <workstreamId> <types...>')
    .description('Spawn and bind agents to a work stream')
    .option(
      '--model <model>',
      'Model spec override for all spawned agents (provider:model-id[:thinking-level], or a comma-separated priority list of specs)'
    )
    .option(
      '--agent-model <agentType=model>',
      'Model spec override for a specific spawned agent type (repeatable)',
      collect,
      []
    )
    .action(async (workstreamId: string, types: string[], options) => {
      try {
        const ws = await apiGet<WorkStream>(`/api/workstreams/${workstreamId}`)
        const agentModelOverrides = parseAgentModelOverrides(options.agentModel)

        for (const agentType of types) {
          const agent = await apiPost<{ id: string }>(
            `/api/squads/${ws.squadId}/spawn`,
            buildWorkStreamSpawnAgentBody(agentType, options.model, agentModelOverrides)
          )

          await apiPost(`/api/workstreams/${ws.id}/agents/${agent.id}`)
          console.log(`Added ${agentType} agent: ${agent.id.slice(0, 8)}`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream remove-agent <workstreamId> <agentId>
  ws.command('remove-agent <workstreamId> <agentId>')
    .description('Remove an agent from a work stream')
    .action(async (workstreamId: string, agentId: string) => {
      try {
        await apiDelete(`/api/workstreams/${workstreamId}/agents/${agentId}`)
        console.log(`Removed agent ${agentId.slice(0, 8)} from work stream`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream delete <id>
  ws.command('delete <id>')
    .alias('rm')
    .description('Delete a work stream')
    .action(async (id) => {
      try {
        await apiDelete(`/api/workstreams/${encodeURIComponent(id)}`)
        console.log(`Deleted work stream ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  ws.command('observe <id>')
    .description('Observe one terminal outcome as the calling agent (not a user subscription)')
    .addOption(new Option('--events <events>', 'Event set').choices(['terminal']).default('terminal'))
    .action(async (id, options) => {
      try {
        output(await apiPost(`/api/workstreams/${encodeURIComponent(id)}/observe`, { events: options.events }))
      } catch (error) {
        outputError(error as Error)
      }
    })
  ws.command('unobserve <id>')
    .description('Remove the calling agent’s terminal observation')
    .action(async (id) => {
      try {
        output(await apiDelete(`/api/workstreams/${encodeURIComponent(id)}/observe`))
      } catch (error) {
        outputError(error as Error)
      }
    })
  ws.command('observation <id>')
    .description('Show whether the calling agent is observing terminal delivery')
    .action(async (id) => {
      try {
        output(await apiGet(`/api/workstreams/${encodeURIComponent(id)}/observation`))
      } catch (error) {
        outputError(error as Error)
      }
    })

  // --- Work-stream watch (subscribe to a stream's lifecycle updates, like watching a GitHub PR) ---

  // --- Tracked links (issues and pull requests this stream follows alongside its delivery) ---

  // ficus workstream tracked <id>
  ws.command('tracked <id>')
    .alias('links')
    .description('List issues and pull requests tracked by a work stream')
    .action(async (id) => {
      try {
        const view = await apiGet<TrackedResourcesView>(`/api/workstreams/${encodeURIComponent(id)}/tracked`)
        if (isJsonMode()) {
          output(view)
        } else {
          outputTable(
            view.resources.map((r) => ({
              Kind: r.kind,
              Resource: trackedResourceLabel(r),
              Source: r.source,
              Delivery: r.source === 'delivery' ? 'primary' : r.delivery ? 'yes' : '-',
              Merge: r.mergeState ?? '-',
              Subscribed: r.subscribed ? 'yes' : 'no',
              URL: r.url ?? '-',
            })),
            ['Kind', 'Resource', 'Source', 'Delivery', 'Merge', 'Subscribed', 'URL']
          )
          console.log(`Subscriptions: ${formatTrackedSubscriptionsFooter(view.subscriptions)}`)
          const footer = formatTrackedDeliveryFooter(view.delivery)
          if (footer) console.log(footer)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream track <id> [--event | --url | --issue | --pr] [--connection]
  ws.command('track <id>')
    .description('Track an issue or pull request alongside this work stream')
    .option('--event <eventId>', 'Track the resource observed by an integration event')
    .option('--url <url>', 'Track by code-host resource URL')
    .option('--issue <ref>', 'Track an issue: owner/repo#12 is GitHub, KEY-123 is always a Linear reference')
    .option('--pr <ref>', 'Track a GitHub pull request, e.g. owner/repo#12')
    .option('--connection <connectionId>', 'Integration connection ID (--issue/--pr only)')
    .option('--delivery', 'Count this pull request toward the work stream delivery')
    .action(async (id, options) => {
      try {
        const body = buildTrackRequestBody(options)
        const result = await apiPost<{ added: unknown[] }>(`/api/workstreams/${encodeURIComponent(id)}/tracked`, body)
        output(result, `Tracked ${result.added.length} resource(s) on work stream ${id.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream untrack <id> [--url | --issue | --pr] [--connection]
  ws.command('untrack <id>')
    .description('Stop tracking an issue or pull request on this work stream')
    .option('--url <url>', 'Untrack by code-host resource URL')
    .option('--issue <ref>', 'Untrack an issue: owner/repo#12 is GitHub, KEY-123 is always a Linear reference')
    .option('--pr <ref>', 'Untrack a GitHub pull request, e.g. owner/repo#12')
    .option('--connection <connectionId>', 'Integration connection ID (--issue/--pr only)')
    .action(async (id, options) => {
      try {
        const body = buildUntrackRequestBody(options)
        const result = await apiDelete<{ removed: boolean }>(`/api/workstreams/${encodeURIComponent(id)}/tracked`, body)
        output(
          result,
          result.removed ? `Untracked resource on work stream ${id.slice(0, 8)}` : 'No matching tracked link'
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream subscription <id>
  ws.command('subscription <id>')
    .description('Show your attention levels for this work stream, and the watcher count')
    .action(async (id) => {
      try {
        const sub = await apiGet<SubscriptionResponse>(`/api/workstreams/${encodeURIComponent(id)}/subscription`)
        output(
          sub,
          `Watching: ${sub.subscribed ? 'yes' : 'no'} (${sub.count} watcher(s)) — ${describeAttention(sub.attention, { inherited: sub.inherited })}`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus workstream subscribe <id> [--decisions <level>] [--progress <level>]
  ws.command('subscribe <id>')
    .alias('watch')
    .description('Watch a work stream. Levels: mute (hidden), show (listed), notify (inbox + push)')
    .option('--decisions <level>', 'Questions, reviews, and blockers: mute, show, or notify')
    .option('--progress <level>', 'Active work and completions: mute, show, or notify')
    .action(async (id, options) => {
      try {
        const sub = await performAttentionSubscribe({
          apiGet,
          apiPost,
          subscriptionPath: `/api/workstreams/${encodeURIComponent(id)}/subscription`,
          subscribePath: `/api/workstreams/${encodeURIComponent(id)}/subscribe`,
          flags: options,
        })
        output(
          sub,
          `Watching work stream ${id.slice(0, 8)} (${sub.count} watcher(s)) — ${describeAttention(sub.attention)}`
        )
      } catch (error) {
        outputError(error as Error)
        // outputError is a no-op under the test mock (see test-setup.ts) and calls
        // process.exit in production; rethrow so tests can observe the rejection.
        throw error
      }
    })

  // ficus workstream unsubscribe <id>
  ws.command('unsubscribe <id>')
    .alias('unwatch')
    .description('Stop watching a work stream (back to inheriting the squad levels)')
    .action(async (id) => {
      try {
        const sub = await apiDelete<SubscriptionResponse>(`/api/workstreams/${encodeURIComponent(id)}/subscribe`)
        output(
          sub,
          `Unwatched work stream ${id.slice(0, 8)} (${sub.count} watcher(s)) — now ${describeAttention(sub.attention, { inherited: sub.inherited })}`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })
}

function parseCleanupSetting(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('--auto-cleanup-worktree must be true or false')
}

const OWNER_REPO_NUMBER_REF = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/

function parseResourceRef(
  kind: TrackedResourceKind,
  value: string
): { integration: 'github'; repository: string; kind: TrackedResourceKind; number: number } {
  const match = OWNER_REPO_NUMBER_REF.exec(value)
  if (!match) throw new Error('Expected owner/repo#number')
  return { integration: 'github', repository: match[1]!, kind, number: Number(match[2]) }
}

/**
 * `--issue` accepts a GitHub `owner/repo#12` reference or a Linear `KEY-123` reference. GitHub
 * keeps sending the explicit `{ resource }` body (unchanged); Linear sends `{ reference }` so the
 * server's `describe` step can fill in the issue's externalId/url from a live connection. Either
 * way `--connection` travels with the reference: the server checks it against the squad's own
 * assignment rather than letting it be silently dropped.
 */
function buildIssueRequestBody(value: string, connection?: string): Record<string, unknown> {
  const parsed = parseTrackedResourceReference(value)
  if (!parsed) throw new Error('Expected owner/repo#number or KEY-123')
  if (parsed.integration === 'linear')
    return { reference: value.trim(), ...(connection !== undefined ? { connectionId: connection } : {}) }
  return {
    resource: {
      integration: 'github',
      repository: parsed.repository,
      kind: 'issue',
      number: parsed.number,
      ...(connection !== undefined ? { connectionId: connection } : {}),
    },
  }
}

/** Linear has no pull requests, so a Linear-shaped `--pr` value is always a mistake. */
function rejectLinearPrReference(value: string): void {
  if (parseTrackedResourceReference(value)?.integration === 'linear')
    throw new Error('Linear references are issues; use --issue')
}

interface TrackSelectorOptions {
  event?: string
  url?: string
  issue?: string
  pr?: string
  connection?: string
  delivery?: boolean
}

function buildTrackRequestBody(options: TrackSelectorOptions): Record<string, unknown> {
  const selected = [options.event, options.url, options.issue, options.pr].filter((v) => v !== undefined)
  if (selected.length !== 1) throw new Error('Choose exactly one of --event, --url, --issue, --pr')
  // An event can carry an issue and an issue is never a delivery change request; a URL is checked by the server.
  if (options.delivery && (options.event !== undefined || options.issue !== undefined))
    throw new Error('--delivery applies to pull requests only')
  if (options.delivery && options.url !== undefined && parseTrackedResourceUrl(options.url)?.integration === 'linear')
    throw new Error('--delivery applies to pull requests only')
  // --connection only applies to a resolved reference (--issue/--pr); with --url or --event it
  // would silently be dropped, so reject it up front instead of pretending it took effect.
  if (options.connection !== undefined && (options.url !== undefined || options.event !== undefined))
    throw new Error('--connection applies to --issue and --pr only')
  const delivery = options.delivery ? { delivery: true } : {}
  if (options.event !== undefined) return { event: options.event }
  if (options.url !== undefined) return { url: options.url, ...delivery }
  if (options.issue !== undefined) return buildIssueRequestBody(options.issue, options.connection)
  rejectLinearPrReference(options.pr!)
  const ref = parseResourceRef('pull_request', options.pr!)
  return {
    resource: { ...ref, ...(options.connection !== undefined ? { connectionId: options.connection } : {}) },
    ...delivery,
  }
}

function buildUntrackRequestBody(options: Omit<TrackSelectorOptions, 'event' | 'delivery'>): Record<string, unknown> {
  const selected = [options.url, options.issue, options.pr].filter((v) => v !== undefined)
  if (selected.length !== 1) throw new Error('Choose exactly one of --url, --issue, --pr')
  if (options.connection !== undefined && options.url !== undefined)
    throw new Error('--connection applies to --issue and --pr only')
  if (options.url !== undefined) return { url: options.url }
  if (options.issue !== undefined) return buildIssueRequestBody(options.issue, options.connection)
  rejectLinearPrReference(options.pr!)
  const ref = parseResourceRef('pull_request', options.pr!)
  return { resource: { ...ref, ...(options.connection !== undefined ? { connectionId: options.connection } : {}) } }
}

/** Delivery progress, or nothing at all when no pull request counts toward delivery. */
function formatTrackedDeliveryFooter(delivery: TrackedResourcesView['delivery']): string | null {
  const total = delivery.pullRequests.length
  if (total === 0) return null
  const merged = delivery.pullRequests.filter((pr) => pr.state === 'merged').length
  return `Delivery: ${merged}/${total} pull requests merged${delivery.complete ? ' (complete)' : ''}`
}

function formatTrackedSubscriptionsFooter(status: TrackedResourcesView['subscriptions']): string {
  switch (status) {
    case 'active':
      return 'active'
    case 'no-flow':
      return 'no-flow (attach a workflow)'
    case 'not-following':
      return 'not-following (workflow does not follow code-host changes)'
    case 'ended':
      return 'ended'
  }
}

function formatTrackedResourceLine(
  resource: ResolvedTrackedResource,
  mergeState?: TrackedResourcesView['resources'][number]['mergeState']
): string {
  const sourceLabel = resource.source === 'delivery' ? 'delivery PR' : resource.delivery ? 'delivery' : 'tracked'
  // Merge state only exists for pull requests the stream has observed an event for.
  const note = mergeState ? `${sourceLabel}, ${mergeState}` : sourceLabel
  const url = resource.url ? ` ${resource.url}` : ''
  return `[${resource.kind}] ${trackedResourceLabel(resource)} (${note})${url}`
}
