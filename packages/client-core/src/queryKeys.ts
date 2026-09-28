import type { NormalizedSquadActivityFilters } from '@ficus/shared'
/**
 * Centralized query key definitions (shared between web and mobile).
 *
 * Every React Query cache key lives here so invalidation logic
 * can reference them by name instead of duplicating string arrays.
 *
 * Conventions:
 * - Each domain has an `all` prefix that is spread into every other key,
 *   so `invalidateQueries({ queryKey: queryKeys.tasks.all })` wipes
 *   list, detail, checkpoint, agents, artifacts, and children at once.
 * - Helper functions accept ids to build composite keys.
 */
export const queryKeys = {
  workflows: {
    all: ['workflows'] as const,
    reviewers: (squadId: string) => ['workflows', 'reviewers', squadId] as const,
    list: () => ['workflows', 'list'] as const,
    run: (id: string) => ['workflows', 'run', id] as const,
  },
  agents: {
    all: ['agents'] as const,
    /**
     * Every `list(...)` variant, whatever its filters. Lets an agent-scoped
     * event refresh the collections an agent appears in without reaching for
     * `all` — which also covers every OTHER agent's detail, messages and
     * sandbox status, and so turned one agent's status tick into a refetch of
     * every agent the UI had mounted.
     */
    listPrefix: () => [...queryKeys.agents.all, 'list'] as const,
    list: (filters?: { agentTypeId?: string; scopeType?: string; scopeId?: string }) =>
      [...queryKeys.agents.all, 'list', filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.agents.all, 'detail', id] as const,
    activeExecution: (agentId: string) => [...queryKeys.agents.all, 'activeExecution', agentId] as const,
    messages: (agentId: string) => [...queryKeys.agents.all, 'messages', agentId] as const,
    messagesInfinite: (agentId: string) => [...queryKeys.agents.all, 'messages', agentId, 'infinite'] as const,
    context: (agentId: string) => [...queryKeys.agents.all, agentId, 'context'] as const,
    scopes: (agentId: string) => [...queryKeys.agents.detail(agentId), 'scopes'] as const,
    sandboxStatus: (agentId: string) => [...queryKeys.agents.all, agentId, 'sandboxStatus'] as const,
    sandboxProcesses: (agentId: string) => [...queryKeys.agents.all, agentId, 'sandboxProcesses'] as const,
    children: (parentId: string) => [...queryKeys.agents.all, 'children', parentId] as const,
    /**
     * Every parent's children list. An agent event carries no parent id, so a
     * child's status change has to refresh child lists by prefix.
     */
    childrenPrefix: () => [...queryKeys.agents.all, 'children'] as const,
  },

  skills: {
    all: ['skills'] as const,
    list: () => [...queryKeys.skills.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.skills.all, 'detail', id] as const,
    templateDiff: (id: string) => [...queryKeys.skills.all, 'templateDiff', id] as const,
  },

  sharedPrompts: {
    all: ['sharedPrompts'] as const,
    list: () => [...queryKeys.sharedPrompts.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.sharedPrompts.all, 'detail', id] as const,
    templateDiff: (id: string) => [...queryKeys.sharedPrompts.all, 'templateDiff', id] as const,
  },

  agentTypes: {
    all: ['agentTypes'] as const,
    list: () => [...queryKeys.agentTypes.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.agentTypes.all, 'detail', id] as const,
    templateDiff: (id: string) => [...queryKeys.agentTypes.all, 'templateDiff', id] as const,
  },

  schedules: {
    all: ['schedules'] as const,
    list: (params?: { scopeType?: string; scopeId?: string; enabled?: boolean; kind?: string; excludeKind?: string }) =>
      [...queryKeys.schedules.all, 'list', params] as const,
    detail: (id: string) => [...queryKeys.schedules.all, 'detail', id] as const,
  },

  monitors: {
    all: ['monitors'] as const,
    list: (params?: { agentId?: string; squadId?: string; status?: string }) =>
      [...queryKeys.monitors.all, 'list', params ?? {}] as const,
    detail: (id: string) => [...queryKeys.monitors.all, 'detail', id] as const,
    logs: (id: string, tail: number) => [...queryKeys.monitors.all, 'logs', id, tail] as const,
  },

  actions: {
    all: ['actions'] as const,
    pending: () => [...queryKeys.actions.all, 'pending'] as const,
  },

  artifacts: {
    all: ['artifacts'] as const,
    list: (params?: { query?: string; includeArchived?: boolean }) =>
      [...queryKeys.artifacts.all, 'list', params ?? {}] as const,
    context: (agentId: string, artifactId: string) =>
      [...queryKeys.artifacts.all, 'context', agentId, artifactId] as const,
  },

  workspace: {
    all: ['workspace'] as const,
    tree: (taskId: string, path?: string, depth?: number) =>
      depth !== undefined
        ? ([...queryKeys.workspace.all, 'tree', taskId, path, depth] as const)
        : ([...queryKeys.workspace.all, 'tree', taskId, ...(path ? [path] : [])] as const),
    file: (taskId: string, filePath: string) => [...queryKeys.workspace.all, 'file', taskId, filePath] as const,
    sessions: (taskId: string) => [...queryKeys.workspace.all, 'sessions', taskId] as const,
  },

  squadPresets: {
    all: ['squadPresets'] as const,
    list: () => [...queryKeys.squadPresets.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.squadPresets.all, 'detail', id] as const,
    templateDiff: (id: string) => [...queryKeys.squadPresets.all, 'templateDiff', id] as const,
  },

  squads: {
    all: ['squads'] as const,
    createOptions: () => [...queryKeys.squads.all, 'createOptions'] as const,
    list: (status?: string) => [...queryKeys.squads.all, 'list', status ?? 'all'] as const,
    detail: (id: string) => [...queryKeys.squads.all, 'detail', id] as const,
    basic: (id: string) => [...queryKeys.squads.all, id] as const,
    agents: (squadId: string) => [...queryKeys.squads.all, 'agents', squadId] as const,
    activityInfinite: (squadId: string, filters: NormalizedSquadActivityFilters, accessSignature = '') =>
      [...queryKeys.squads.all, 'activity', 'infinite', squadId, accessSignature, filters] as const,
    agentsWithRecent: (squadId: string) => [...queryKeys.squads.all, 'agentsWithRecent', squadId] as const,
    workStreams: (squadId: string) => [...queryKeys.squads.all, 'workStreams', squadId] as const,
    allWorkStreams: () => [...queryKeys.squads.all, 'allWorkStreams'] as const,
    activeWorkStreamsPrefix: () => [...queryKeys.squads.all, 'activeWorkStreams'] as const,
    activeWorkStreams: (squadId?: string) => [...queryKeys.squads.activeWorkStreamsPrefix(), squadId ?? 'all'] as const,
    activeWorkStreamsInfinite: (squadId?: string) =>
      [...queryKeys.squads.activeWorkStreamsPrefix(), 'infinite', squadId ?? 'all'] as const,
    /** The feed's cross-squad active list, already narrowed by the viewer's attention. */
    attentionWorkStreams: () => [...queryKeys.squads.activeWorkStreamsPrefix(), 'attention'] as const,
    doneWorkStreamsInfinite: (squadId: string | undefined, statuses: string, squadIds?: readonly string[]) =>
      [
        ...queryKeys.squads.all,
        'doneWorkStreams',
        'infinite',
        squadId ?? (squadIds?.length ? [...squadIds].sort().join(',') : 'all'),
        statuses,
      ] as const,
    workStreamDetail: (id: string) => [...queryKeys.squads.all, 'workStreamDetail', id] as const,
    workStreamTracked: (id: string) => [...queryKeys.squads.all, 'workStreamTracked', id] as const,
    workStreamMetrics: (id: string) => [...queryKeys.squads.all, 'workStreamMetrics', id] as const,
    schedules: (squadId: string) => [...queryKeys.squads.all, 'schedules', squadId] as const,
    relationships: (squadId: string) => [...queryKeys.squads.all, 'relationships', squadId] as const,
    deployments: (squadId: string) => [...queryKeys.squads.all, 'deployments', squadId] as const,
    localDeployments: (squadId: string) => [...queryKeys.squads.all, 'localDeployments', squadId] as const,
    grants: {
      outbound: (squadId: string) => [...queryKeys.squads.all, squadId, 'grants', 'outbound'] as const,
      inbound: (squadId: string) => [...queryKeys.squads.all, squadId, 'grants', 'inbound'] as const,
    },
    workspaceTree: (squadId: string, path?: string, depth?: number) =>
      depth !== undefined
        ? ([...queryKeys.squads.all, 'workspaceTree', squadId, path, depth] as const)
        : ([...queryKeys.squads.all, 'workspaceTree', squadId, ...(path ? [path] : [])] as const),
    workspaceFile: (squadId: string, filePath: string) =>
      [...queryKeys.squads.all, 'workspaceFile', squadId, filePath] as const,
    workspaceSessions: (squadId: string) => [...queryKeys.squads.all, 'workspaceSessions', squadId] as const,
    sshKeys: (squadId: string) => [...queryKeys.squads.all, squadId, 'ssh-keys'] as const,
    remoteHosts: (squadId: string) => [...queryKeys.squads.all, squadId, 'remote-hosts'] as const,
    memory: {
      syncStatus: (squadId: string) => [...queryKeys.squads.all, squadId, 'memory', 'sync-status'] as const,
      tree: (squadId: string, path = '/memory', depth?: number) =>
        depth !== undefined
          ? ([...queryKeys.squads.all, squadId, 'memory', 'tree', path, depth] as const)
          : ([...queryKeys.squads.all, squadId, 'memory', 'tree', path] as const),
      file: (squadId: string, filePath: string) =>
        [...queryKeys.squads.all, squadId, 'memory', 'file', filePath] as const,
      search: (squadId: string, params: unknown) =>
        [...queryKeys.squads.all, squadId, 'memory', 'search', params] as const,
    },
  },

  /** Cross-squad activity feed (GET /api/activity) — sibling of squads.activityInfinite, one squad at a time. */
  activity: {
    all: ['activity'] as const,
    presence: () => [...queryKeys.activity.all, 'presence'] as const,
    globalInfinite: (filters: NormalizedSquadActivityFilters) =>
      [...queryKeys.activity.all, 'global', 'infinite', filters] as const,
  },

  channelInstances: {
    all: ['channelInstances'] as const,
    list: () => [...queryKeys.channelInstances.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.channelInstances.all, 'detail', id] as const,
    templateDiff: (id: string) => [...queryKeys.channelInstances.all, 'templateDiff', id] as const,
  },

  notificationConfig: {
    all: ['notificationConfig'] as const,
    detail: () => [...queryKeys.notificationConfig.all, 'detail'] as const,
    templateDiff: () => [...queryKeys.notificationConfig.all, 'templateDiff'] as const,
    // The caller's own notification preferences (self-service).
    mine: () => [...queryKeys.notificationConfig.all, 'mine'] as const,
  },
  workStreamSubscription: {
    all: ['workStreamSubscription'] as const,
    detail: (id: string) => ['workStreamSubscription', id] as const,
  },
  squadSubscription: {
    all: ['squadSubscription'] as const,
    detail: (id: string) => ['squadSubscription', id] as const,
  },
  agentQuestions: {
    all: ['agentQuestions'] as const,
    byAgent: (agentId: string, status?: 'open' | 'answered') => ['agentQuestions', agentId, status ?? 'all'] as const,
  },
  systemTokens: {
    all: ['systemTokens'] as const,
    list: (includeWebhook: boolean) => ['systemTokens', 'list', includeWebhook] as const,
  },

  inbox: {
    all: ['inbox'] as const,
    messagesPrefix: (agentId: string) => [...queryKeys.inbox.all, 'messages', agentId] as const,
    messages: (agentId: string, includeRead = false) =>
      [...queryKeys.inbox.messagesPrefix(agentId), includeRead] as const,
    messagesInfinite: (agentId: string, readState: 'read' | 'unread' | 'all') =>
      [...queryKeys.inbox.messagesPrefix(agentId), 'infinite', readState] as const,
    unreadCount: (agentId: string) => [...queryKeys.inbox.all, 'unreadCount', agentId] as const,
    // The authenticated user's own inbox (cache is cleared on auth change, so no userId in the key).
    minePrefix: () => [...queryKeys.inbox.all, 'mine'] as const,
    mine: (includeRead = false) => [...queryKeys.inbox.minePrefix(), includeRead] as const,
    mineInfinite: (readState: 'read' | 'unread' | 'all') =>
      [...queryKeys.inbox.minePrefix(), 'infinite', readState] as const,
    mineCount: () => [...queryKeys.inbox.minePrefix(), 'count'] as const,
    // The shared system/announcements inbox.
    systemPrefix: () => [...queryKeys.inbox.all, 'system'] as const,
    system: (includeRead = false) => [...queryKeys.inbox.systemPrefix(), includeRead] as const,
    systemInfinite: (readState: 'read' | 'unread' | 'all') =>
      [...queryKeys.inbox.systemPrefix(), 'infinite', readState] as const,
    systemCount: () => [...queryKeys.inbox.systemPrefix(), 'count'] as const,
  },
  terminal: {
    all: ['terminal'] as const,
    sessions: (sandboxId: string) => [...queryKeys.terminal.all, 'sessions', sandboxId] as const,
  },
  sandbox: {
    all: ['sandbox'] as const,
    status: (squadId: string) => [...queryKeys.sandbox.all, 'status', squadId] as const,
    processes: (squadId: string) => [...queryKeys.sandbox.all, 'processes', squadId] as const,
  },
  secrets: {
    all: ['secrets'] as const,
    list: () => [...queryKeys.secrets.all, 'list'] as const,
  },

  auth: {
    all: ['auth'] as const,
    status: () => [...queryKeys.auth.all, 'status'] as const,
    /** Native discovery must never reuse a different paired server's capabilities. */
    serverInfoPrefix: () => [...queryKeys.auth.all, 'serverInfo'] as const,
    serverInfo: (origin: string) => [...queryKeys.auth.all, 'serverInfo', origin] as const,
    me: () => [...queryKeys.auth.all, 'me'] as const,
    myCredentials: () => [...queryKeys.auth.all, 'me', 'credentials'] as const,
    permissions: (squadId?: string) => [...queryKeys.auth.all, 'permissions', squadId ?? null] as const,
    /** Signup policy (allowed domains / invite-only). Admin-only: requires settings:read. */
    settings: () => [...queryKeys.auth.all, 'settings'] as const,
  },
  users: {
    all: ['users'] as const,
    list: () => [...queryKeys.users.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.users.all, 'detail', id] as const,
    roles: (id: string) => [...queryKeys.users.all, id, 'roles'] as const,
    sessions: (id: string) => [...queryKeys.users.all, id, 'sessions'] as const,
  },
  roles: {
    all: ['roles'] as const,
    list: () => [...queryKeys.roles.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.roles.all, 'detail', id] as const,
  },
  sessions: {
    all: ['sessions'] as const,
    list: () => [...queryKeys.sessions.all, 'list'] as const,
  },
  settings: {
    all: ['settings'] as const,
    list: () => [...queryKeys.settings.all, 'list'] as const,
  },
  system: {
    all: ['system'] as const,
    storage: () => [...queryKeys.system.all, 'storage'] as const,
    storageStatus: () => [...queryKeys.system.all, 'storage-status'] as const,
    pause: () => [...queryKeys.system.all, 'pause'] as const,
    pauseDetails: () => [...queryKeys.system.pause(), 'details'] as const,
  },
  updates: {
    all: ['updates'] as const,
    settings: () => [...queryKeys.updates.all, 'settings'] as const,
    status: () => [...queryKeys.updates.all, 'status'] as const,
  },
  voice: {
    all: ['voice'] as const,
    /** Whether the server has an OpenAI key, i.e. whether voice can work at all. */
    status: () => [...queryKeys.voice.all, 'status'] as const,
  },
  images: {
    all: ['images'] as const,
    signedUrls: (ids: string[]) => [...queryKeys.images.all, 'signedUrls', [...ids].sort()] as const,
  },
  providerAuth: {
    all: ['providerAuth'] as const,
    list: () => [...queryKeys.providerAuth.all, 'list'] as const,
    catalog: () => [...queryKeys.providerAuth.all, 'catalog'] as const,
    openRouterRouting: () => [...queryKeys.providerAuth.all, 'openRouterRouting'] as const,
    oauthProviders: () => [...queryKeys.providerAuth.all, 'oauthProviders'] as const,
    oauthStatus: (provider: string) => [...queryKeys.providerAuth.all, 'oauthStatus', provider] as const,
    accounts: (provider: string) => [...queryKeys.providerAuth.all, 'accounts', provider] as const,
  },
  recommendations: {
    all: ['recommendations'] as const,
    infinite: (params?: { status?: string; squadId?: string; limit?: number }) =>
      [...queryKeys.recommendations.all, 'infinite', params ?? {}] as const,
    detail: (id: string) => [...queryKeys.recommendations.all, 'detail', id] as const,
  },
  // VM sandbox runtime: the admin machines fleet (list) + per-machine detail (boxes).
  machines: {
    all: ['machines'] as const,
    list: () => [...queryKeys.machines.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.machines.all, 'detail', id] as const,
  },
  // Global remote-hosts registry (admin): list + per-host detail (grants).
  remoteHosts: {
    all: ['remoteHosts'] as const,
    detail: (id: string) => [...queryKeys.remoteHosts.all, 'detail', id] as const,
  },
  // Native push device registrations (self-service, used by mobile Settings).
  pushDevices: {
    all: ['pushDevices'] as const,
    list: () => [...queryKeys.pushDevices.all, 'list'] as const,
  },
  // Paired clients (self-service, used by web DevicesSection).
  devices: {
    all: ['devices'] as const,
    list: () => [...queryKeys.devices.all, 'list'] as const,
    authorization: (code: string) => [...queryKeys.devices.all, 'authorization', code] as const,
  },
  // Federation (AMTP): instance identity, peer CRUD, and per-agent mailbox status/allow-rules.
  amtp: {
    all: ['amtp'] as const,
    identity: () => [...queryKeys.amtp.all, 'identity'] as const,
    peers: () => [...queryKeys.amtp.all, 'peers'] as const,
    agentStatus: (agentId: string) => [...queryKeys.amtp.all, 'agentStatus', agentId] as const,
    allowRules: (agentId: string) => [...queryKeys.amtp.all, 'allowRules', agentId] as const,
  },
} as const
