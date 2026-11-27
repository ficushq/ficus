import type { Transport } from '../transport'
import type {
  Agent,
  Attention,
  GlobalActivityPresence,
  GlobalSquadActivityPage,
  Squad,
  SquadActivityPresence,
  SquadActivityKind,
  SquadActivityPage,
  ResolveWorkStreamWaitInput,
  ManualWaitDecision,
  SandboxPressure,
  WorkStream,
  WorkStreamStatus,
  WorkStreamWait,
} from '@ficus/shared'
import type { ImageContent } from './images'

export const WS_ACTIVE_STATUSES = ['queued', 'active'] as const satisfies readonly WorkStreamStatus[]
export const WS_DONE_STATUSES = ['done', 'canceled'] as const satisfies readonly WorkStreamStatus[]

/**
 * The status filter of an unpaged list, which may only ask for open work (queued, active). Without
 * one (or with a finished status) Core returns every open stream plus a capped slice of history, so
 * these helpers refuse it at run time; finished work is read with listDoneWorkStreamsPage. The type
 * stays WorkStreamStatus so callers holding open statuses in a WorkStreamStatus[] keep compiling.
 */
function openStatusesParam(statuses: readonly WorkStreamStatus[]): string {
  if (statuses.length === 0) throw new Error('An unpaged work stream list needs open statuses (queued or active)')
  const finished = statuses.filter((status) => !(WS_ACTIVE_STATUSES as readonly string[]).includes(status))
  if (finished.length > 0)
    throw new Error(`An unpaged work stream list cannot ask for ${finished.join(', ')}; page finished work instead`)
  return `statuses=${statuses.join(',')}`
}

export type ResolveWorkStreamWaitResult = WorkStream & { wait: WorkStreamWait }

export interface WorkStreamsPage {
  items: WorkStream[]
  hasMore: boolean
  nextCursor: string | null
  totalCount: number
}

export interface WorkStreamsPageOptions {
  limit?: number
  cursor?: string | null
}

function workStreamsPagePath(opts: { squadId?: string; statuses: readonly string[] } & WorkStreamsPageOptions): string {
  let path = `/workstreams?statuses=${opts.statuses.join(',')}&limit=${opts.limit ?? 50}`
  if (opts.squadId) path += `&squadId=${encodeURIComponent(opts.squadId)}`
  if (opts.cursor) path += `&cursor=${encodeURIComponent(opts.cursor)}`
  return path
}

export interface ListSquadActivityOptions {
  /** Kind filter — deduped and sorted onto the wire, mirroring the web client. */
  kinds?: SquadActivityKind[]
  limit?: number
  cursor?: string | null
  /** "Show everything": include rows the default view folds away (CI and auto-merge notices). */
  verbose?: boolean
  /** Only this work stream's rows and its bound participants' rows (the Active work card filter). */
  workStreamId?: string
}

function activityQuery(opts: ListSquadActivityOptions): string {
  const params = new URLSearchParams()
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.verbose) params.set('verbose', 'true')
  if (opts.workStreamId) params.set('workStreamId', opts.workStreamId)
  for (const kind of [...new Set(opts.kinds ?? [])].sort()) params.append('kind', kind)
  const query = params.toString()
  return query ? `?${query}` : ''
}

// Mobile is the operator's own device, so the web client's RBAC-redaction
// cache-keying (accessSignature) is unnecessary here — this is a plain cursor fetch.
function squadActivityPath(squadId: string, opts: ListSquadActivityOptions): string {
  return `/squads/${squadId}/activity${activityQuery(opts)}`
}

/** Cross-squad sibling of squadActivityPath — GET /api/activity, no squadId in the path. */
function globalActivityPath(opts: ListSquadActivityOptions): string {
  return `/activity${activityQuery(opts)}`
}

/** Live sandbox pod status for a squad (mirrors the web SandboxStatusIndicator). */
export interface SandboxStatus {
  status: 'not_found' | 'pending' | 'starting' | 'running' | 'succeeded' | 'failed' | 'terminating' | 'unknown'
  phase?: string
  reason?: string
  containerReady?: boolean
  startedAt?: string
  devboxReady?: boolean
  /**
   * Server-driven runtime this sandbox runs under (FICUS_SANDBOX_RUNTIME) — never
   * inferred client-side. On `host` there is no sandbox at all, so clients must
   * not offer start/stop.
   */
  runtime?: 'docker' | 'k8s' | 'vm' | 'host'
  /** Load and memory from the sandbox's last health check (VM runtime). */
  pressure?: SandboxPressure
}

/** The caller's attention for a squad: stored levels when subscribed, otherwise the default. */
export interface SquadSubscription {
  subscribed: boolean
  count: number
  attention: Attention
}

export interface ListAllWorkStreamsOptions {
  /** Drop streams whose progress the caller muted. The route refuses it with pagination. */
  respectAttention?: boolean
  /** Return rows with a null description, for lists that show none. */
  omitDescription?: boolean
}

/** Lean squads surface used by mobile (list squads + their agents to find the manager). */
export function squadsResource(t: Transport) {
  return {
    listSquads: (status?: string): Promise<Squad[]> => t.request(`/squads${status ? `?status=${status}` : ''}`),
    getSquad: (id: string): Promise<Squad> => t.request(`/squads/${id}`),
    // GET /squads/:id/agents responds with { agents: [...] } — unwrap to the array.
    listSquadAgents: async (squadId: string): Promise<Agent[]> => {
      const res = await t.request<{ agents: Agent[] }>(`/squads/${squadId}/agents`)
      return res.agents ?? []
    },
    // DELETE /squads/:id/agents/:agentId — server enforces agents:terminate and
    // Agent.tryTerminate() safety (managers, persist, idle, active work streams).
    terminateSquadAgent: (squadId: string, agentId: string): Promise<void> =>
      t.request(`/squads/${squadId}/agents/${agentId}`, { method: 'DELETE' }),
    /**
     * A squad's open work streams (unpaged; the route returns WorkStream[]). `statuses` is required
     * and open-only: the squad's full history is never one read. Page finished work with
     * listDoneWorkStreamsPage, or read one stream with getWorkStream.
     */
    listSquadWorkStreams: (squadId: string, statuses: readonly WorkStreamStatus[]): Promise<WorkStream[]> =>
      t.request(`/workstreams?squadId=${encodeURIComponent(squadId)}&${openStatusesParam(statuses)}`),
    /**
     * Open work streams across every squad the caller can see (unpaged, so open statuses only, as
     * listSquadWorkStreams). `respectAttention` drops streams the caller muted (stream or squad
     * progress level), as a feed wants; `omitDescription` returns each row with a null description
     * when the list shows none.
     */
    listAllWorkStreams: (
      statuses: readonly WorkStreamStatus[],
      options: ListAllWorkStreamsOptions = {}
    ): Promise<WorkStream[]> => {
      const params = [openStatusesParam(statuses)]
      if (options.respectAttention) params.push('respectAttention=true')
      if (options.omitDescription) params.push('omitDescription=true')
      return t.request(`/workstreams?${params.join('&')}`)
    },
    getWorkStream: (id: string): Promise<WorkStream> => t.request(`/workstreams/${encodeURIComponent(id)}`),
    resolveWorkStreamWait: (
      workStreamId: string,
      waitId: string,
      input: ResolveWorkStreamWaitInput
    ): Promise<ResolveWorkStreamWaitResult> =>
      t.request(`/workstreams/${encodeURIComponent(workStreamId)}/waits/${waitId}/resolve`, {
        method: 'POST',
        body: input,
      }),
    resolveStructuredWorkStreamInput: (
      workStreamId: string,
      waitId: string,
      input: ManualWaitDecision
    ): Promise<ResolveWorkStreamWaitResult> =>
      t.request(`/workstreams/${encodeURIComponent(workStreamId)}/waits/${encodeURIComponent(waitId)}/input`, {
        method: 'POST',
        body: input,
      }),
    // Squad activity feed (unified timeline: messages, work-stream lifecycle, subagent
    // dispatch, PR events). Cursor-paged, newest-first — see packages/shared/squad-activity.
    listSquadActivity: (squadId: string, opts: ListSquadActivityOptions = {}): Promise<SquadActivityPage> =>
      t.request(squadActivityPath(squadId, opts)),
    /** Cross-squad activity feed (every squad the caller can see, merged and RBAC-redacted per squad). */
    listGlobalActivity: (opts: ListSquadActivityOptions = {}): Promise<GlobalSquadActivityPage> =>
      t.request(globalActivityPath(opts)),
    /** Counts and Active work cards across every squad the caller can see. */
    getGlobalActivityPresence: (): Promise<GlobalActivityPresence> => t.request('/activity/presence'),
    /** Counts and Active work cards for one squad's Activity tab. */
    getSquadActivityPresence: (squadId: string): Promise<SquadActivityPresence> =>
      t.request(`/squads/${squadId}/activity/presence`),
    countActiveWorkStreams: (squadId: string): Promise<{ totalCount: number }> =>
      t.request(`${workStreamsPagePath({ squadId, statuses: WS_ACTIVE_STATUSES, limit: 1 })}&countOnly=true`),
    listActiveWorkStreamsPage: (squadId?: string, opts: WorkStreamsPageOptions = {}): Promise<WorkStreamsPage> =>
      t.request(workStreamsPagePath({ ...opts, squadId, statuses: WS_ACTIVE_STATUSES })),
    listDoneWorkStreamsPage: (
      opts: { squadId?: string; statuses?: readonly string[] } & WorkStreamsPageOptions = {}
    ): Promise<WorkStreamsPage> =>
      t.request(workStreamsPagePath({ ...opts, statuses: opts.statuses ?? WS_DONE_STATUSES })),

    // Sandbox pod controls (squad workspace).
    getSandboxStatus: (squadId: string): Promise<SandboxStatus> => t.request(`/squads/${squadId}/sandbox/status`),
    startSandbox: (squadId: string): Promise<void> => t.request(`/squads/${squadId}/sandbox/start`, { method: 'POST' }),
    stopSandbox: (squadId: string): Promise<void> => t.request(`/squads/${squadId}/sandbox/stop`, { method: 'POST' }),

    // Squad attention: which of this squad's decisions and progress reach you, and how loudly.
    getSquadSubscription: (squadId: string): Promise<SquadSubscription> => t.request(`/squads/${squadId}/subscription`),
    subscribeSquad: (squadId: string, attention?: Attention): Promise<SquadSubscription> =>
      t.request(`/squads/${squadId}/subscribe`, { method: 'POST', ...(attention ? { body: { attention } } : {}) }),
    unsubscribeSquad: (squadId: string): Promise<SquadSubscription> =>
      t.request(`/squads/${squadId}/subscribe`, { method: 'DELETE' }),

    // Squad avatar (base64 image; png/jpeg/gif/webp). Returns the updated squad (with avatarUrl).
    uploadSquadAvatar: (squadId: string, image: ImageContent): Promise<Squad> =>
      t.request(`/squads/${squadId}/avatar`, { method: 'POST', body: { image } }),
    removeSquadAvatar: (squadId: string): Promise<Squad> =>
      t.request(`/squads/${squadId}/avatar`, { method: 'DELETE' }),
  }
}
