import type { ThemePresetScope } from '@ficus/shared'
// Query keys now live in @ficus/client-core so web and mobile share one definition.
export { queryKeys } from '@ficus/client-core'
export const desktopQueryKeys = {
  notifications: () => ['desktop', 'notifications'] as const,
  enabled: () => ['desktop', 'notifications-enabled'] as const,
}

/**
 * The composer's Interrupt / Follow up suggestion, keyed by the whitespace-normalized draft. Kept
 * out of `agents` so agent events never refetch it (each fetch asks a decision model).
 */
export const composerQueryKeys = {
  all: ['composer'] as const,
  deliverySuggestion: (agentId: string, draft: string) =>
    [...composerQueryKeys.all, 'delivery-suggestion', agentId, draft] as const,
  /** Where an Assistant draft would go (the routing preview), by conversation and normalized draft. */
  assistantRouting: (conversationId: string, draft: string) =>
    [...composerQueryKeys.all, 'assistant-routing', conversationId, draft] as const,
}

/** The screenshot review card: a squad's open work streams for its picker. */
export const screenshotQueryKeys = {
  all: ['screenshots'] as const,
  workStreams: (squadId: string) => [...screenshotQueryKeys.all, 'work-streams', squadId] as const,
}

export const modelTierQueryKeys = { list: () => ['model-tiers'] as const }

/** Settings → Spend: the inference cost ledger, per range, filters and grouping. */
export const spendQueryKeys = {
  all: ['spend'] as const,
  summary: (query: object) => [...spendQueryKeys.all, 'summary', query] as const,
  breakdown: (query: object) => [...spendQueryKeys.all, 'breakdown', query] as const,
}

/** Decision model providers, routing and the OpenAI services key state: one settings read. */
export const decisionQueryKeys = {
  all: ['decisions'] as const,
  settings: () => [...decisionQueryKeys.all, 'settings'] as const,
  spend: (days: number) => [...decisionQueryKeys.all, 'spend', days] as const,
}

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
  localBindings: () => [...integrationQueryKeys.all, 'local-bindings', 'bigbrain'] as const,
  localSetup: () => [...integrationQueryKeys.all, 'local-setup', 'bigbrain'] as const,
  outputs: () => ['integrations', 'outputs'] as const,
  all: ['integrations'] as const,
  catalog: () => [...integrationQueryKeys.all, 'catalog'] as const,
  pool: (provider: string) => [...integrationQueryKeys.all, 'pool', provider] as const,
  managedBigbrainVaults: () => [...integrationQueryKeys.all, 'managed-vaults', 'bigbrain'] as const,
  managedBigbrainAttachableSquads: () => [...integrationQueryKeys.all, 'managed-vault-squads', 'bigbrain'] as const,
  /** Display fields only (never an invite link). */
  managedBigbrainMembers: (vaultId: string) =>
    [...integrationQueryKeys.all, 'managed-vaults', 'bigbrain', vaultId, 'members'] as const,
  serviceSettings: (provider: string) => [...integrationQueryKeys.all, 'service-settings', provider] as const,
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
  updates: (userId: string, visitId: string, squads: readonly string[]) =>
    ['squads', 'feed-updates', userId, visitId, [...squads].sort()] as const,
  recent: (after: string, squads: readonly string[]) => ['squads', 'feed-recent', after, [...squads].sort()] as const,
}

export const channelLinkQueryKeys = { all: ['channel-links'] as const }

// Web-only queued-slot status; pool/admission management remains separate.
export const agentSlotWaitQueryKeys = {
  all: ['agent-slot-waits'] as const,
  squad: (squadId: string) => ['agent-slot-waits', squadId] as const,
  agent: (squadId: string, agentId: string) => ['agent-slot-waits', squadId, agentId] as const,
}

export const agentSlotHoldQueryKeys = {
  all: ['agent-slot-holds'] as const,
  squad: (squadId: string) => ['agent-slot-holds', squadId] as const,
  agent: (squadId: string, agentId: string) => ['agent-slot-holds', squadId, agentId] as const,
}

/**
 * GitHub moderation state per squad. Kept outside `queryKeys.squads` and `integrationQueryKeys` so
 * the content-free `githubFeedback.updated` event refreshes only these queries, never squad
 * settings or rule forms.
 */
export const githubFeedbackQueryKeys = {
  all: ['github-feedback'] as const,
  squad: (squadId: string) => ['github-feedback', squadId] as const,
  summary: (squadId: string) => ['github-feedback', squadId, 'summary'] as const,
  list: (squadId: string, queue: 'pending' | 'releasing') => ['github-feedback', squadId, 'list', queue] as const,
  detail: (squadId: string, revisionId: string) => ['github-feedback', squadId, 'detail', revisionId] as const,
  trustedAuthors: (squadId: string) => ['github-feedback', squadId, 'trusted-authors'] as const,
}

/** The signed-in person's own verified GitHub account; refreshed by `githubIdentity.updated`. */
export const githubIdentityQueryKeys = { all: ['github-identity'] as const }

/** The server's canonical public address (runtime config + admin status). */
export const publicUrlQueryKeys = {
  all: ['public-url'] as const,
  runtime: () => ['public-url', 'runtime'] as const,
  status: () => ['public-url', 'status'] as const,
}

export const serverConnectionQueryKeys = {
  status: () => ['push-server-connection'] as const,
  availability: () => ['push-relay-availability'] as const,
}

/** Whether "Send feedback to Ficus" can reach Ficus (never a credential). */
export const productFeedbackQueryKeys = {
  status: () => ['product-feedback-status'] as const,
}
