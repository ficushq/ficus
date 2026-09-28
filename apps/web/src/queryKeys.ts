import type { ThemePresetScope } from '@ficus/shared'
// Query keys now live in @ficus/client-core so web and mobile share one definition.
export { queryKeys } from '@ficus/client-core'
export const desktopQueryKeys = {
  notifications: () => ['desktop', 'notifications'] as const,
  enabled: () => ['desktop', 'notifications-enabled'] as const,
}

export const modelTierQueryKeys = { list: () => ['model-tiers'] as const }

/** A user's theme preset library. Phase 2 adds `scope` ('mine' | 'shared' |
 * 'all') so the caller's own presets and everyone else's shared presets can
 * be cached independently; every scope still shares the `all` prefix, so a
 * single broad invalidation after any mutation (share/unshare/duplicate/use)
 * covers every list, as it did in Phase 1. */
export const themePresetQueryKeys = {
  all: ['theme-presets'] as const,
  list: (scope: ThemePresetScope = 'mine') => [...themePresetQueryKeys.all, 'list', scope] as const,
}

/**
 * Onboarding has no mobile surface yet, so its keys live here directly
 * instead of in the shared @ficus/client-core definitions — same `all` +
 * per-query-shape convention as everything in queryKeys.
 */
export const onboardingQueryKeys = {
  all: ['onboarding'] as const,
  status: () => [...onboardingQueryKeys.all, 'status'] as const,
}

export const integrationQueryKeys = {
  outputs: () => ['integrations', 'outputs'] as const,
  all: ['integrations'] as const,
  catalog: () => [...integrationQueryKeys.all, 'catalog'] as const,
  pool: (provider: string) => [...integrationQueryKeys.all, 'pool', provider] as const,
  serviceSettings: (provider: string) => [...integrationQueryKeys.all, 'service-settings', provider] as const,
  deploymentSettings: (provider: string) => [...integrationQueryKeys.all, 'deployment-settings', provider] as const,
  channelSettings: (provider: string) => [...integrationQueryKeys.all, 'channel-settings', provider] as const,
  linearWebhook: () => [...integrationQueryKeys.all, 'webhook', 'linear'] as const,
  squadGitAuthorDefaults: (squadId: string) =>
    [...integrationQueryKeys.all, 'squad', squadId, 'github', 'author-defaults'] as const,
  gitAuthorDefaults: () => [...integrationQueryKeys.all, 'git-author-defaults'] as const,
  githubWebhook: () => [...integrationQueryKeys.all, 'webhook', 'github'] as const,
  githubRepositoryAccess: (connectionId: string) =>
    [...integrationQueryKeys.all, 'github-repository-access', connectionId] as const,
  githubCommitSigning: (connectionId: string) =>
    [...integrationQueryKeys.all, 'github-commit-signing', connectionId] as const,
  oauthApp: (provider: string) => [...integrationQueryKeys.all, 'oauth-app', provider] as const,
  squad: (squadId: string, provider: string) => [...integrationQueryKeys.all, 'squad', squadId, provider] as const,
  export: (agentId: string) => [...integrationQueryKeys.all, 'export', agentId] as const,
}

export const modelCatalogQueryKeys = {
  all: ['model-catalog'] as const,
  list: (agentId?: string) => ['model-catalog', agentId ?? 'settings'] as const,
}

export const assistantQueryKeys = {
  updates: (ownerId: string, id: string, ids: string[]) =>
    ['assistant-conversations', 'activity', ownerId, 'updates', id, [...ids].sort()] as const,
  editor: (id: string) => ['assistant', 'editor', id] as const,
  all: ['assistant-conversations'] as const,
  list: (q = '', offset = 0) => ['assistant-conversations', 'list', q, offset] as const,
  history: (id: string) => ['assistant-conversations', 'history', id] as const,
  /** Owner-keyed so a device shared between accounts never shows another owner's previews. */
  activityPrefix: ['assistant-conversations', 'activity'] as const,
  activity: (ownerId: string, offset = 0) => ['assistant-conversations', 'activity', ownerId, offset] as const,
  conversationActivity: (ownerId: string, id: string) =>
    ['assistant-conversations', 'activity', ownerId, 'conversation', id] as const,
}

export const feedQueryKeys = {
  visit: (userId: string) => ['auth', 'feed-visit', userId] as const,
  completed: (after: string, before: string) => ['squads', 'feed-completed', after, before, 'items'] as const,
  recent: (after: string, squads: readonly string[]) => ['squads', 'feed-recent', after, [...squads].sort()] as const,
}

export const channelLinkQueryKeys = { all: ['channel-links'] as const }

// Web-only queued-slot status; pool/admission management remains separate.
export const agentSlotWaitQueryKeys = {
  all: ['agent-slot-waits'] as const,
  squad: (squadId: string) => ['agent-slot-waits', squadId] as const,
  agent: (squadId: string, agentId: string) => ['agent-slot-waits', squadId, agentId] as const,
}
