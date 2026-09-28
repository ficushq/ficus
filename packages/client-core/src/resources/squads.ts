import type { Transport } from '../transport'
import type {
  Agent,
  Attention,
  GlobalSquadActivityPage,
  Squad,
  SquadActivityKind,
  SquadActivityPage,
  ResolveWorkStreamWaitInput,
  SandboxPressure,
  WorkStream,
  WorkStreamStatus,
  WorkStreamWait,
} from '@ficus/shared'
import type { ImageContent } from './images'

export const WS_ACTIVE_STATUSES = ['queued', 'active'] as const satisfies readonly WorkStreamStatus[]
export const WS_DONE_STATUSES = ['done', 'canceled'] as const satisfies readonly WorkStreamStatus[]

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
}

// Mobile is the operator's own device, so the web client's RBAC-redaction
// cache-keying (accessSignature) is unnecessary here — this is a plain cursor fetch.
function squadActivityPath(squadId: string, opts: ListSquadActivityOptions): string {
  const params = new URLSearchParams()
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.cursor) params.set('cursor', opts.cursor)
  for (const kind of [...new Set(opts.kinds ?? [])].sort()) params.append('kind', kind)
  const query = params.toString()
  return `/squads/${squadId}/activity${query ? `?${query}` : ''}`
}

/** Cross-squad sibling of squadActivityPath — GET /api/activity, no squadId in the path. */
function globalActivityPath(opts: ListSquadActivityOptions): string {
  const params = new URLSearchParams()
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.cursor) params.set('cursor', opts.cursor)
  for (const kind of [...new Set(opts.kinds ?? [])].sort()) params.append('kind', kind)
  const query = params.toString()
  return `/activity${query ? `?${query}` : ''}`
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
    // Squad-scoped work streams. Optional statuses filter (comma-joined) for the active-count use case.
    // Route returns WorkStream[] directly (no limit → not paginated).
    listSquadWorkStreams: (squadId: string, statuses?: WorkStreamStatus[]): Promise<WorkStream[]> => {
      let path = `/workstreams?squadId=${squadId}`
      if (statuses && statuses.length > 0) path += `&statuses=${statuses.join(',')}`
      return t.request(path)
    },
    /** Cross-squad listing — same route without the squadId filter. */
    listAllWorkStreams: (statuses?: WorkStreamStatus[]): Promise<WorkStream[]> => {
      const path = statuses && statuses.length > 0 ? `/workstreams?statuses=${statuses.join(',')}` : '/workstreams'
      return t.request(path)
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
    // Squad activity feed (unified timeline: messages, work-stream lifecycle, subagent
    // dispatch, PR events). Cursor-paged, newest-first — see packages/shared/squad-activity.
    listSquadActivity: (squadId: string, opts: ListSquadActivityOptions = {}): Promise<SquadActivityPage> =>
      t.request(squadActivityPath(squadId, opts)),
    /** Cross-squad activity feed (every squad the caller can see, merged and RBAC-redacted per squad). */
    listGlobalActivity: (opts: ListSquadActivityOptions = {}): Promise<GlobalSquadActivityPage> =>
      t.request(globalActivityPath(opts)),
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
