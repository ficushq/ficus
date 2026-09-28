import { agentSlotWaitQueryKeys } from './queryKeys'
import { desktopQueryKeys } from './queryKeys'
import { desktopBridge, type DesktopNotificationBatch } from './lib/desktop'
import { apiFetch } from './api/client'
import { channelLinkQueryKeys } from './queryKeys'
import { getChannelLinks } from './api/channelLinks'
import { listIntegrationOutputs } from './api/integrations'
import { getSquadGitAuthorDefaults } from './api/integrations'
import { getDeploymentIntegrationSettings } from './api/integrations'
import { feedQueryKeys } from './queryKeys'
import { getFeedVisit } from './api/auth'
import { listDoneWorkStreams } from './api/squads'
import { client } from './api/clientInstance'
import { assistantApi } from './api/assistant'
import { assistantQueryKeys } from './queryKeys'
import { getModelCatalog } from './api/modelCatalog'
import { modelCatalogQueryKeys } from './queryKeys'
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query'
import { queryKeys, onboardingQueryKeys, integrationQueryKeys, themePresetQueryKeys } from './queryKeys'
import { getStorageStatus, getStorage, getSystemPause, getSystemPauseDetails } from './api/system'
import { getGlobalActivityPresence, listGlobalActivity } from './api/activity'

// API functions
import {
  listAgents,
  getAgentSlotWaits,
  getAgent,
  getActiveExecution,
  getAgentContext,
  getAgentSandboxStatus,
  getAgentSandboxProcesses,
  listAgentScopes,
} from './api/agents'
import { listAgentTypes } from './api/agentTypes'
import { getModelTiers, getSquadPresets } from './api/config'
import { modelTierQueryKeys } from './queryKeys'
import { schedulesApi, type ListSchedulesParams } from './api/schedules'
import { monitorsApi, type ListMonitorsParams } from './api/monitors'
import { getRecommendation, listRecommendations, type ListRecommendationsParams } from './api/recommendations'

import { listPendingActions } from './api/actions'
import { getArtifactContext, listArtifacts, type ListArtifactsParams } from './api/artifacts'
import {
  getWorkspaceTree,
  getWorkspaceFile,
  getWorkspaceSessions,
  getTerminalSessions,
  getSquadWorkspaceTree,
  getSquadWorkspaceFile,
  getSquadWorkspaceSessions,
  getSquadMemoryTree,
  getSquadMemoryFile,
  getSandboxStatus,
  getSandboxProcesses,
  listLocalDeployments,
} from './api/workspace'
import { listInboundGrants, listOutboundGrants } from './api/grants'
import { searchMemory, type SearchMemoryParams } from './api/memory'
import { getMyInbox, getMyInboxUnreadCount, getSystemInbox, getSystemInboxUnreadCount } from './api/inbox'
import { listSecrets, getGitAuthorDefaults } from './api/secrets'
import { listSettings } from './api/settings'
import { getAuthSettings, getAuthStatus, getCurrentUser, getMyPermissions, listMyCredentials } from './api/auth'
import { getSeatPricing, getUser, getUserRoles, listUsers, listUserSessions } from './api/users'
import { getRole, listRoles } from './api/roles'
import { listSessions } from './api/sessions'
import { getUpdateSettings, getUpdateStatus } from './api/updates'
import { getVoiceStatus } from './api/voice'
import { inspectDeviceAuthorization, listDevices } from './api/devices'
import {
  getOAuthStatus,
  getOpenRouterRouting,
  listProviderAccounts,
  listProviderAuth,
  listOAuthProviders,
  listProviderCatalog,
} from './api/providerAuth'
import { listChannelInstances } from './api/channelInstances'
import { listMachines, getMachine } from './api/machines'
import { signImageUrls } from './api/images'
import {
  getAgentType,
  getAgentTypeTemplateDiff,
  getSquadPreset,
  getSquadPresetTemplateDiff,
  getChannelInstances,
  getChannelInstance,
  getChannelInstanceTemplateDiff,
  getNotificationConfig,
  getNotificationConfigTemplateDiff,
  getMyNotificationPrefs,
  getSkills,
  getSkill,
  getSkillTemplateDiff,
  getSharedPrompts,
  getSharedPrompt,
  getSharedPromptTemplateDiff,
} from './api/config'
import {
  listSquads,
  getSquad,
  getSquadWithRelationships,
  getSquadCreateOptions,
  listSquadAgents,
  listSquadAgentsWithRecent,
  listSquadActivity,
  listWorkStreams,
  listAllWorkStreams,
  listActiveWorkStreams,
  listAttentionWorkStreams,
  getWorkStream,
  getWorkStreamMetrics,
  getWorkStreamTracked,
  getWorkStreamSubscription,
  getSquadSubscription,
  getInboxMessages,
  getMemorySyncStatus,
  listSshKeys,
} from './api/squads'
import { getAgentQuestions } from './api/agentQuestions'
import { getSystemTokens } from './api/systemTokens'
import { getInstanceIdentity, listPeers, getAgentFederationStatus, listAgentAllowRules } from './api/amtp'
import { getOnboardingStatus } from './api/onboarding'
import type { NormalizedSquadActivityFilters, ThemePresetScope } from '@ficus/shared'

/**
 * Centralized query option factories.
 *
 * Each factory pairs a query key with its fetch function, so components
 * only need `useQuery(queries.tasks.list())` instead of repeating both.
 *
 * For invalidation, use `queryKeys` directly — `queryKeys.tasks.all`
 * invalidates every query under that domain via prefix matching.
 */
export const queries = {
  desktop: {
    enabled: () =>
      queryOptions({
        queryKey: desktopQueryKeys.enabled(),
        queryFn: () => desktopBridge()?.notificationsEnabled() ?? Promise.resolve(false),
      }),
    notifications: () =>
      queryOptions({
        queryKey: desktopQueryKeys.notifications(),
        queryFn: () => apiFetch<DesktopNotificationBatch>('/push/desktop'),
      }),
  },
  channelLinks: { list: () => queryOptions({ queryKey: channelLinkQueryKeys.all, queryFn: getChannelLinks }) },
  workflows: {
    reviewers: (squadId: string) =>
      queryOptions({
        queryKey: queryKeys.workflows.reviewers(squadId),
        queryFn: () => client.workflows.reviewers(squadId),
      }),
    list: () => queryOptions({ queryKey: queryKeys.workflows.list(), queryFn: client.workflows.list }),
    run: (id: string) =>
      queryOptions({ queryKey: queryKeys.workflows.run(id), queryFn: () => client.workflows.run(id) }),
  },
  themePresets: {
    list: (scope?: ThemePresetScope) =>
      queryOptions({ queryKey: themePresetQueryKeys.list(scope), queryFn: () => client.themePresets.list(scope) }),
  },
  agents: {
    slotWaits: (squadId: string, agentId: string) =>
      queryOptions({
        queryKey: agentSlotWaitQueryKeys.agent(squadId, agentId),
        queryFn: () => getAgentSlotWaits(agentId),
        // Lifecycle frames and authenticated reconnects repair this projection.
        // Do not poll or retain the previous agent's data across navigation.
        retry: false,
      }),
    list: (filters?: { agentTypeId?: string; scopeType?: string; scopeId?: string }) =>
      queryOptions({
        queryKey: queryKeys.agents.list(filters),
        queryFn: () => listAgents(filters),
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.agents.detail(id),
        queryFn: () => getAgent(id),
      }),
    activeExecution: (agentId: string) =>
      queryOptions({
        queryKey: queryKeys.agents.activeExecution(agentId),
        queryFn: () => getActiveExecution(agentId),
      }),
    context: (agentId: string) =>
      queryOptions({
        queryKey: queryKeys.agents.context(agentId),
        queryFn: () => getAgentContext(agentId),
      }),
    scopes: (agentId: string) =>
      queryOptions({
        queryKey: queryKeys.agents.scopes(agentId),
        queryFn: () => listAgentScopes(agentId),
      }),
    sandboxProcesses: (agentId: string) =>
      queryOptions({
        queryKey: queryKeys.agents.sandboxProcesses(agentId),
        queryFn: () => getAgentSandboxProcesses(agentId),
      }),
    sandboxStatus: (agentId: string) =>
      queryOptions({
        queryKey: queryKeys.agents.sandboxStatus(agentId),
        queryFn: () => getAgentSandboxStatus(agentId),
      }),
    children: (parentId: string) =>
      queryOptions({
        queryKey: queryKeys.agents.children(parentId),
        queryFn: () => listAgents({ parentAgentId: parentId }),
      }),
  },

  skills: {
    list: () =>
      queryOptions({
        queryKey: queryKeys.skills.list(),
        queryFn: getSkills,
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.skills.detail(id),
        queryFn: () => getSkill(id),
      }),
    templateDiff: (id: string) =>
      queryOptions({
        queryKey: queryKeys.skills.templateDiff(id),
        queryFn: () => getSkillTemplateDiff(id),
      }),
  },

  sharedPrompts: {
    list: () =>
      queryOptions({
        queryKey: queryKeys.sharedPrompts.list(),
        queryFn: getSharedPrompts,
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.sharedPrompts.detail(id),
        queryFn: () => getSharedPrompt(id),
      }),
    templateDiff: (id: string) =>
      queryOptions({
        queryKey: queryKeys.sharedPrompts.templateDiff(id),
        queryFn: () => getSharedPromptTemplateDiff(id),
      }),
  },

  modelTiers: {
    list: () => queryOptions({ queryKey: modelTierQueryKeys.list(), queryFn: getModelTiers }),
  },

  agentTypes: {
    list: () =>
      queryOptions({
        queryKey: queryKeys.agentTypes.list(),
        queryFn: listAgentTypes,
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.agentTypes.detail(id),
        queryFn: () => getAgentType(id),
      }),
    templateDiff: (id: string) =>
      queryOptions({
        queryKey: queryKeys.agentTypes.templateDiff(id),
        queryFn: () => getAgentTypeTemplateDiff(id),
      }),
  },

  schedules: {
    list: (params?: ListSchedulesParams) =>
      queryOptions({
        queryKey: queryKeys.schedules.list(params),
        queryFn: () => schedulesApi.list(params),
        placeholderData: keepPreviousData,
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.schedules.detail(id),
        queryFn: () => schedulesApi.get(id),
      }),
  },

  monitors: {
    list: (params?: ListMonitorsParams) =>
      queryOptions({
        queryKey: queryKeys.monitors.list({
          agentId: params?.agentId,
          squadId: params?.squadId,
          status: params?.status?.join(','),
        }),
        queryFn: () => monitorsApi.list(params),
      }),
    listForAgent: (agentId: string, params?: Omit<ListMonitorsParams, 'agentId'>) =>
      queries.monitors.list({ ...params, agentId }),
    listForSquad: (squadId: string, params?: Omit<ListMonitorsParams, 'squadId'>) =>
      queries.monitors.list({ ...params, squadId }),
    detail: (id: string) =>
      queryOptions({ queryKey: queryKeys.monitors.detail(id), queryFn: () => monitorsApi.get(id) }),
    logs: (id: string, tail = 100) =>
      queryOptions({ queryKey: queryKeys.monitors.logs(id, tail), queryFn: () => monitorsApi.logs(id, tail) }),
  },

  recommendations: {
    detail: (id: string) =>
      queryOptions({ queryKey: queryKeys.recommendations.detail(id), queryFn: () => getRecommendation(id) }),
    infinite: (filters?: Omit<ListRecommendationsParams, 'cursor'>) =>
      infiniteQueryOptions({
        queryKey: queryKeys.recommendations.infinite(filters),
        queryFn: ({ pageParam }) => listRecommendations({ ...filters, cursor: pageParam ?? undefined }),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        refetchInterval: 30_000,
        placeholderData: keepPreviousData,
      }),
  },

  actions: {
    pending: () =>
      queryOptions({
        queryKey: queryKeys.actions.pending(),
        queryFn: listPendingActions,
      }),
  },

  artifacts: {
    list: (params?: ListArtifactsParams) =>
      queryOptions({
        queryKey: queryKeys.artifacts.list(params),
        queryFn: () => listArtifacts(params),
      }),
    context: (agentId: string, artifactId: string) =>
      queryOptions({
        queryKey: queryKeys.artifacts.context(agentId, artifactId),
        queryFn: () => getArtifactContext(agentId, artifactId),
      }),
  },

  workspace: {
    tree: (taskId: string, path: string, depth?: number) =>
      queryOptions({
        queryKey: queryKeys.workspace.tree(taskId, path, depth),
        queryFn: () => getWorkspaceTree(taskId, path, depth ?? 1),
      }),
    file: (taskId: string, filePath: string) =>
      queryOptions({
        queryKey: queryKeys.workspace.file(taskId, filePath),
        queryFn: () => getWorkspaceFile(taskId, filePath),
      }),
    sessions: (taskId: string) =>
      queryOptions({
        queryKey: queryKeys.workspace.sessions(taskId),
        queryFn: () => getWorkspaceSessions(taskId),
      }),
  },

  squadWorkspace: {
    tree: (squadId: string, path: string, depth?: number) =>
      queryOptions({
        queryKey: queryKeys.squads.workspaceTree(squadId, path, depth),
        queryFn: () => getSquadWorkspaceTree(squadId, path, depth ?? 1),
      }),
    file: (squadId: string, filePath: string) =>
      queryOptions({
        queryKey: queryKeys.squads.workspaceFile(squadId, filePath),
        queryFn: () => getSquadWorkspaceFile(squadId, filePath),
      }),
    sessions: (squadId: string) =>
      queryOptions({
        queryKey: queryKeys.squads.workspaceSessions(squadId),
        queryFn: () => getSquadWorkspaceSessions(squadId),
      }),
  },

  squadMemory: {
    tree: (squadId: string, path = '/memory', depth?: number) =>
      queryOptions({
        queryKey: queryKeys.squads.memory.tree(squadId, path, depth),
        queryFn: () => getSquadMemoryTree(squadId, path, depth ?? 1),
      }),
    file: (squadId: string, filePath: string) =>
      queryOptions({
        queryKey: queryKeys.squads.memory.file(squadId, filePath),
        queryFn: () => getSquadMemoryFile(squadId, filePath),
      }),
    search: (squadId: string, params: SearchMemoryParams) =>
      queryOptions({
        queryKey: queryKeys.squads.memory.search(squadId, params),
        queryFn: () => searchMemory(squadId, params),
      }),
  },

  squadPresets: {
    list: () =>
      queryOptions({
        queryKey: queryKeys.squadPresets.list(),
        queryFn: getSquadPresets,
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.squadPresets.detail(id),
        queryFn: () => getSquadPreset(id),
      }),
    templateDiff: (id: string) =>
      queryOptions({
        queryKey: queryKeys.squadPresets.templateDiff(id),
        queryFn: () => getSquadPresetTemplateDiff(id),
      }),
  },

  squads: {
    createOptions: () =>
      queryOptions({
        queryKey: queryKeys.squads.createOptions(),
        queryFn: getSquadCreateOptions,
        staleTime: Infinity,
      }),
    list: (status?: string) =>
      queryOptions({
        queryKey: queryKeys.squads.list(status),
        queryFn: () => listSquads(status),
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.squads.detail(id),
        queryFn: () => getSquadWithRelationships(id),
      }),
    basic: (id: string) =>
      queryOptions({
        queryKey: queryKeys.squads.basic(id),
        queryFn: () => getSquad(id),
      }),
    agents: (squadId: string) =>
      queryOptions({
        queryKey: queryKeys.squads.agents(squadId),
        queryFn: () => listSquadAgents(squadId),
      }),
    activity: (squadId: string, filters: NormalizedSquadActivityFilters, accessSignature = '', enabled = true) =>
      infiniteQueryOptions({
        queryKey: queryKeys.squads.activityInfinite(squadId, filters, accessSignature),
        enabled,
        queryFn: ({ pageParam, signal }) =>
          listSquadActivity(squadId, { ...filters, limit: 50, cursor: pageParam, signal }),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
        placeholderData: keepPreviousData,
        staleTime: 5_000,
      }),
    agentsWithRecent: (squadId: string) =>
      queryOptions({
        queryKey: queryKeys.squads.agentsWithRecent(squadId),
        queryFn: () => listSquadAgentsWithRecent(squadId, { terminatedLimit: 20, terminatedOffset: 0 }),
      }),
    workStreams: (squadId: string) =>
      queryOptions({
        queryKey: queryKeys.squads.workStreams(squadId),
        queryFn: () => listWorkStreams(squadId),
      }),
    allWorkStreams: () =>
      queryOptions({
        queryKey: queryKeys.squads.allWorkStreams(),
        queryFn: listAllWorkStreams,
      }),
    activeWorkStreams: (squadId?: string) =>
      queryOptions({
        queryKey: queryKeys.squads.activeWorkStreams(squadId),
        queryFn: () => listActiveWorkStreams(squadId),
      }),
    attentionWorkStreams: () =>
      queryOptions({
        queryKey: queryKeys.squads.attentionWorkStreams(),
        queryFn: () => listAttentionWorkStreams(),
      }),
    workStreamDetail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.squads.workStreamDetail(id),
        queryFn: () => getWorkStream(id),
      }),
    workStreamTracked: (id: string) =>
      queryOptions({
        queryKey: queryKeys.squads.workStreamTracked(id),
        queryFn: () => getWorkStreamTracked(id),
      }),
    workStreamMetrics: (id: string) =>
      queryOptions({
        queryKey: queryKeys.squads.workStreamMetrics(id),
        queryFn: () => getWorkStreamMetrics(id),
        staleTime: 30_000, // Cache for 30 seconds
      }),
    sshKeys: (squadId: string) =>
      queryOptions({
        queryKey: queryKeys.squads.sshKeys(squadId),
        queryFn: () => listSshKeys(squadId),
      }),
    localDeployments: (squadId: string) =>
      queryOptions({
        queryKey: queryKeys.squads.localDeployments(squadId),
        queryFn: () => listLocalDeployments(squadId),
      }),
    memory: {
      syncStatus: (squadId: string) =>
        queryOptions({
          queryKey: queryKeys.squads.memory.syncStatus(squadId),
          queryFn: () => getMemorySyncStatus(squadId),
          refetchInterval: 30000,
        }),
    },
    grants: {
      outbound: (squadId: string) =>
        queryOptions({
          queryKey: queryKeys.squads.grants.outbound(squadId),
          queryFn: () => listOutboundGrants(squadId),
        }),
      inbound: (squadId: string) =>
        queryOptions({
          queryKey: queryKeys.squads.grants.inbound(squadId),
          queryFn: () => listInboundGrants(squadId),
        }),
    },
  },

  /** Cross-squad activity feed — sibling of squads.activity, one squad at a time. */
  activity: {
    presence: () =>
      queryOptions({
        queryKey: queryKeys.activity.presence(),
        queryFn: () => getGlobalActivityPresence(),
        refetchInterval: 30_000,
      }),
    global: (filters: NormalizedSquadActivityFilters, enabled = true) =>
      infiniteQueryOptions({
        queryKey: queryKeys.activity.globalInfinite(filters),
        enabled,
        queryFn: ({ pageParam, signal }) => listGlobalActivity({ ...filters, limit: 50, cursor: pageParam, signal }),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
        placeholderData: keepPreviousData,
        // No live-overlay WS subscription for the global feed (v1) — a modest
        // poll keeps it reasonably fresh. Follow-up: a global WS topic.
        refetchInterval: 30_000,
      }),
  },

  channelInstances: {
    all: () =>
      queryOptions({
        queryKey: queryKeys.channelInstances.all,
        queryFn: listChannelInstances,
      }),
    list: () =>
      queryOptions({
        queryKey: queryKeys.channelInstances.list(),
        queryFn: getChannelInstances,
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.channelInstances.detail(id),
        queryFn: () => getChannelInstance(id),
      }),
    templateDiff: (id: string) =>
      queryOptions({
        queryKey: queryKeys.channelInstances.templateDiff(id),
        queryFn: () => getChannelInstanceTemplateDiff(id),
      }),
  },

  notificationConfig: {
    detail: () =>
      queryOptions({
        queryKey: queryKeys.notificationConfig.detail(),
        queryFn: getNotificationConfig,
      }),
    templateDiff: () =>
      queryOptions({
        queryKey: queryKeys.notificationConfig.templateDiff(),
        queryFn: getNotificationConfigTemplateDiff,
      }),
    mine: () =>
      queryOptions({
        queryKey: queryKeys.notificationConfig.mine(),
        queryFn: getMyNotificationPrefs,
      }),
  },

  workStreamSubscription: {
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.workStreamSubscription.detail(id),
        queryFn: () => getWorkStreamSubscription(id),
      }),
  },

  squadSubscription: {
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.squadSubscription.detail(id),
        queryFn: () => getSquadSubscription(id),
      }),
  },

  agentQuestions: {
    byAgent: (agentId: string, status?: 'open' | 'answered') =>
      queryOptions({
        queryKey: queryKeys.agentQuestions.byAgent(agentId, status),
        queryFn: () => getAgentQuestions(agentId, status),
      }),
  },

  systemTokens: {
    list: (includeWebhook: boolean) =>
      queryOptions({
        queryKey: queryKeys.systemTokens.list(includeWebhook),
        queryFn: () => getSystemTokens(includeWebhook),
      }),
  },

  inbox: {
    messages: (agentId: string, includeRead = false) =>
      queryOptions({
        queryKey: queryKeys.inbox.messages(agentId, includeRead),
        queryFn: () => getInboxMessages(agentId, includeRead),
      }),
    mine: (includeRead = false) =>
      queryOptions({
        queryKey: queryKeys.inbox.mine(includeRead),
        queryFn: () => getMyInbox(includeRead),
      }),
    mineCount: () =>
      queryOptions({
        queryKey: queryKeys.inbox.mineCount(),
        queryFn: () => getMyInboxUnreadCount(),
      }),
    system: (includeRead = false) =>
      queryOptions({
        queryKey: queryKeys.inbox.system(includeRead),
        queryFn: () => getSystemInbox(includeRead),
      }),
    systemCount: () =>
      queryOptions({
        queryKey: queryKeys.inbox.systemCount(),
        queryFn: () => getSystemInboxUnreadCount(),
      }),
  },
  terminal: {
    sessions: (sandboxId: string) =>
      queryOptions({
        queryKey: queryKeys.terminal.sessions(sandboxId),
        queryFn: () => getTerminalSessions(sandboxId),
      }),
  },
  sandbox: {
    status: (squadId: string) =>
      queryOptions({
        queryKey: queryKeys.sandbox.status(squadId),
        queryFn: () => getSandboxStatus(squadId),
      }),
    processes: (squadId: string) =>
      queryOptions({
        queryKey: queryKeys.sandbox.processes(squadId),
        queryFn: () => getSandboxProcesses(squadId),
      }),
  },
  secrets: {
    gitAuthorDefaults: () =>
      queryOptions({ queryKey: integrationQueryKeys.gitAuthorDefaults(), queryFn: getGitAuthorDefaults }),
    list: () =>
      queryOptions({
        queryKey: queryKeys.secrets.list(),
        queryFn: () => listSecrets(),
      }),
  },

  auth: {
    status: () =>
      queryOptions({
        queryKey: queryKeys.auth.status(),
        queryFn: getAuthStatus,
      }),
    me: () =>
      queryOptions({
        queryKey: queryKeys.auth.me(),
        queryFn: getCurrentUser,
      }),
    myCredentials: () =>
      queryOptions({
        queryKey: queryKeys.auth.myCredentials(),
        queryFn: listMyCredentials,
      }),
    permissions: (squadId?: string) =>
      queryOptions({
        queryKey: queryKeys.auth.permissions(squadId),
        queryFn: () => getMyPermissions(squadId),
      }),
    /** Signup policy. Admin-only (settings:read) — only fetch it behind that gate. */
    settings: () =>
      queryOptions({
        queryKey: queryKeys.auth.settings(),
        queryFn: getAuthSettings,
      }),
  },
  users: {
    list: () =>
      queryOptions({
        queryKey: queryKeys.users.list(),
        queryFn: listUsers,
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.users.detail(id),
        queryFn: () => getUser(id),
      }),
    roles: (id: string) =>
      queryOptions({
        queryKey: queryKeys.users.roles(id),
        queryFn: () => getUserRoles(id),
      }),
    sessions: (id: string) =>
      queryOptions({
        queryKey: queryKeys.users.sessions(id),
        queryFn: () => listUserSessions(id),
      }),
    /**
     * Seat billing for the instance. Admin-only (users:read), same gate as the
     * list — only fetch it behind that gate.
     *
     * The key is declared here rather than in @ficus/client-core's queryKeys
     * because the admin Users page is its only consumer (same reasoning as
     * UserListEntry in api/users.ts). It sits UNDER `users.all` on purpose: the
     * invite/delete/disable mutations already invalidate that prefix, so the
     * billed-seat count refreshes with the list instead of going stale the
     * moment the admin changes the very thing it counts.
     */
    seatPricing: () =>
      queryOptions({
        queryKey: [...queryKeys.users.all, 'seats'] as const,
        queryFn: getSeatPricing,
      }),
  },
  roles: {
    list: () =>
      queryOptions({
        queryKey: queryKeys.roles.list(),
        queryFn: listRoles,
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.roles.detail(id),
        queryFn: () => getRole(id),
      }),
  },
  sessions: {
    list: () =>
      queryOptions({
        queryKey: queryKeys.sessions.list(),
        queryFn: listSessions,
      }),
  },
  settings: {
    list: () =>
      queryOptions({
        queryKey: queryKeys.settings.list(),
        queryFn: () => listSettings(),
      }),
  },
  system: {
    storageStatus: () =>
      queryOptions({
        queryKey: queryKeys.system.storageStatus(),
        queryFn: getStorageStatus,
        refetchInterval: 60_000,
        staleTime: 30_000,
      }),
    storage: () =>
      queryOptions({
        queryKey: queryKeys.system.storage(),
        queryFn: getStorage,
        refetchInterval: (query) => (query.state.data?.scanning ? 2000 : 300000),
      }),
    pause: () =>
      queryOptions({
        queryKey: queryKeys.system.pause(),
        queryFn: getSystemPause,
      }),
    pauseDetails: () =>
      queryOptions({
        queryKey: queryKeys.system.pauseDetails(),
        queryFn: getSystemPauseDetails,
      }),
  },
  updates: {
    settings: () =>
      queryOptions({
        queryKey: queryKeys.updates.settings(),
        queryFn: () => getUpdateSettings(),
      }),
    status: () =>
      queryOptions({
        queryKey: queryKeys.updates.status(),
        queryFn: () => getUpdateStatus(),
      }),
  },
  voice: {
    /**
     * Server voice capability. Server config changes rarely, so cache it for the
     * session rather than refetching on every mount of every microphone.
     */
    status: () =>
      queryOptions({
        queryKey: queryKeys.voice.status(),
        queryFn: () => getVoiceStatus(),
        staleTime: 5 * 60 * 1000,
      }),
  },
  images: {
    signedUrls: (ids: string[]) =>
      queryOptions({
        queryKey: queryKeys.images.signedUrls(ids),
        queryFn: () => signImageUrls(ids),
        staleTime: 18 * 60 * 60 * 1000,
        gcTime: 24 * 60 * 60 * 1000,
        enabled: ids.length > 0,
      }),
  },
  providerAuth: {
    list: () =>
      queryOptions({
        queryKey: queryKeys.providerAuth.list(),
        queryFn: () => listProviderAuth(),
      }),
    openRouterRouting: () =>
      queryOptions({
        queryKey: queryKeys.providerAuth.openRouterRouting(),
        queryFn: () => getOpenRouterRouting(),
      }),
    catalog: () =>
      queryOptions({
        queryKey: queryKeys.providerAuth.catalog(),
        queryFn: () => listProviderCatalog(),
        staleTime: Infinity,
      }),
    oauthProviders: () =>
      queryOptions({
        queryKey: queryKeys.providerAuth.oauthProviders(),
        queryFn: () => listOAuthProviders(),
        staleTime: Infinity,
      }),
    oauthStatus: (provider: string) =>
      queryOptions({
        queryKey: queryKeys.providerAuth.oauthStatus(provider),
        queryFn: () => getOAuthStatus(provider),
        refetchInterval: (query) => {
          const need = query.state.data?.need
          return need && need.kind !== 'done' && need.kind !== 'error' ? 1000 : false
        },
      }),
    accounts: (provider: string) =>
      queryOptions({
        queryKey: queryKeys.providerAuth.accounts(provider),
        queryFn: () => listProviderAccounts(provider),
      }),
  },
  devices: {
    list: () =>
      queryOptions({
        queryKey: queryKeys.devices.list(),
        queryFn: listDevices,
      }),
    authorization: (code: string) =>
      queryOptions({
        queryKey: queryKeys.devices.authorization(code),
        queryFn: () => inspectDeviceAuthorization({ verificationCode: code }),
        enabled: code.length > 0,
        retry: false,
      }),
  },
  machines: {
    list: () =>
      queryOptions({
        queryKey: queryKeys.machines.list(),
        queryFn: () => listMachines(),
        // Poll while any machine is mid-bootstrap or unreachable so its status
        // badge settles even without a WS event; idle otherwise.
        refetchInterval: (query) =>
          query.state.data?.some((m) => m.status === 'bootstrapping' || m.status === 'unreachable') ? 5000 : false,
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: queryKeys.machines.detail(id),
        queryFn: () => getMachine(id),
        refetchInterval: (query) => {
          const status = query.state.data?.status
          return status === 'bootstrapping' || status === 'unreachable' ? 5000 : false
        },
      }),
  },
  amtp: {
    identity: () =>
      queryOptions({
        queryKey: queryKeys.amtp.identity(),
        queryFn: getInstanceIdentity,
      }),
    peers: () =>
      queryOptions({
        queryKey: queryKeys.amtp.peers(),
        queryFn: listPeers,
      }),
    agentStatus: (agentId: string) =>
      queryOptions({
        queryKey: queryKeys.amtp.agentStatus(agentId),
        queryFn: () => getAgentFederationStatus(agentId),
      }),
    allowRules: (agentId: string) =>
      queryOptions({
        queryKey: queryKeys.amtp.allowRules(agentId),
        queryFn: () => listAgentAllowRules(agentId),
      }),
  },
  onboarding: {
    status: () =>
      queryOptions({
        queryKey: onboardingQueryKeys.status(),
        queryFn: getOnboardingStatus,
      }),
  },
} as const

import {
  getExternalExport,
  getIntegrationOAuthApp,
  getGitHubWebhookSettings,
  getGitHubCommitSigning,
  getGitHubRepositoryAccess,
  getLinearWebhookSettings,
  getChannelIntegrationSettings,
  getServiceIntegrationSettings,
  getSquadIntegrationSelection,
  listIntegrationCatalog,
  listIntegrationPool,
} from './api/integrations'
export const integrationQueries = {
  githubRepositoryAccess: (connectionId: string) =>
    queryOptions({
      queryKey: integrationQueryKeys.githubRepositoryAccess(connectionId),
      queryFn: () => getGitHubRepositoryAccess(connectionId),
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: 'always',
    }),
  githubCommitSigning: (connectionId: string) =>
    queryOptions({
      queryKey: integrationQueryKeys.githubCommitSigning(connectionId),
      queryFn: () => getGitHubCommitSigning(connectionId),
      staleTime: 60_000,
      retry: false,
    }),
  outputs: () => queryOptions({ queryKey: integrationQueryKeys.outputs(), queryFn: listIntegrationOutputs }),
  credentialSettings: (provider: string, kind: 'channel' | 'deployment' | 'service') =>
    queryOptions({
      queryKey:
        kind === 'service'
          ? integrationQueryKeys.serviceSettings(provider)
          : kind === 'deployment'
            ? integrationQueryKeys.deploymentSettings(provider)
            : integrationQueryKeys.channelSettings(provider),
      queryFn: () =>
        kind === 'service'
          ? getServiceIntegrationSettings(provider)
          : kind === 'deployment'
            ? getDeploymentIntegrationSettings(provider)
            : getChannelIntegrationSettings(provider),
    }),
  deploymentSettings: (provider: string) =>
    queryOptions({
      queryKey: integrationQueryKeys.deploymentSettings(provider),
      queryFn: () => getDeploymentIntegrationSettings(provider),
    }),
  channelSettings: (provider: string) =>
    queryOptions({
      queryKey: integrationQueryKeys.channelSettings(provider),
      queryFn: () => getChannelIntegrationSettings(provider),
    }),
  linearWebhook: () =>
    queryOptions({ queryKey: integrationQueryKeys.linearWebhook(), queryFn: getLinearWebhookSettings }),
  githubWebhook: () =>
    queryOptions({ queryKey: integrationQueryKeys.githubWebhook(), queryFn: () => getGitHubWebhookSettings() }),
  catalog: () => queryOptions({ queryKey: integrationQueryKeys.catalog(), queryFn: () => listIntegrationCatalog() }),
  pool: (provider: string) =>
    queryOptions({
      queryKey: integrationQueryKeys.pool(provider),
      queryFn: () => listIntegrationPool(provider),
    }),
  oauthApp: (provider: string) =>
    queryOptions({
      queryKey: integrationQueryKeys.oauthApp(provider),
      queryFn: () => getIntegrationOAuthApp(provider),
    }),
  squadGitAuthorDefaults: (squadId: string) =>
    queryOptions({
      queryKey: integrationQueryKeys.squadGitAuthorDefaults(squadId),
      queryFn: () => getSquadGitAuthorDefaults(squadId),
    }),
  squad: (squadId: string, provider: string) =>
    queryOptions({
      queryKey: integrationQueryKeys.squad(squadId, provider),
      queryFn: () => getSquadIntegrationSelection(squadId, provider),
    }),
  export: (agentId: string) =>
    queryOptions({ queryKey: integrationQueryKeys.export(agentId), queryFn: () => getExternalExport(agentId) }),
}

export const modelCatalogQuery = (agentId?: string) =>
  queryOptions({
    queryKey: modelCatalogQueryKeys.list(agentId),
    queryFn: () => getModelCatalog(agentId),
    staleTime: 5 * 60_000,
    retry: false,
  })

export const assistantQueries = {
  updates: (ownerId: string, id: string, ids: string[]) =>
    queryOptions({
      queryKey: assistantQueryKeys.updates(ownerId, id, ids),
      queryFn: async () => {
        const updates = [] as Awaited<ReturnType<typeof assistantApi.readUpdates>>
        for (let offset = 0; offset < ids.length; offset += 50)
          updates.push(...(await assistantApi.readUpdates(id, ids.slice(offset, offset + 50))))
        return updates
      },
    }),
  editor: (id: string) =>
    queryOptions({ queryKey: assistantQueryKeys.editor(id), queryFn: () => assistantApi.editor(id) }),
  list: (q = '', offset = 0) =>
    queryOptions({ queryKey: assistantQueryKeys.list(q, offset), queryFn: () => assistantApi.list(q, offset) }),
  history: (id: string) =>
    queryOptions({ queryKey: assistantQueryKeys.history(id), queryFn: () => assistantApi.history(id) }),
  /**
   * Global activity discovery. WebSocket invalidation is the primary signal; the visible-page
   * interval is a fallback only, never a background poll. Errors keep the last good counts.
   */
  activity: (ownerId: string, offset = 0) =>
    queryOptions({
      queryKey: assistantQueryKeys.activity(ownerId, offset),
      queryFn: () => assistantApi.activity(30, offset),
      staleTime: 15_000,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    }),
  conversationActivity: (ownerId: string, id: string) =>
    queryOptions({
      queryKey: assistantQueryKeys.conversationActivity(ownerId, id),
      queryFn: () => assistantApi.conversationActivity(id),
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    }),
}

export const feedQueries = {
  visit: (userId: string) =>
    queryOptions({
      queryKey: feedQueryKeys.visit(userId),
      queryFn: getFeedVisit,
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
    }),
  completed: (after: string, before: string) =>
    infiniteQueryOptions({
      queryKey: feedQueryKeys.completed(after, before),
      queryFn: ({ pageParam }) =>
        listDoneWorkStreams({
          completedAfter: after,
          completedBefore: before,
          statuses: ['done'],
          limit: 20,
          cursor: pageParam,
        }),
      initialPageParam: undefined as string | null | undefined,
      getNextPageParam: (page) => (page.hasMore ? page.nextCursor : undefined),
      staleTime: 30_000,
    }),
  recent: (after: string, squadIds: readonly string[]) =>
    queryOptions({
      queryKey: feedQueryKeys.recent(after, squadIds),
      queryFn: () => listDoneWorkStreams({ completedAfter: after, squadIds, statuses: ['done'], limit: 5 }),
      staleTime: 30_000,
    }),
}
