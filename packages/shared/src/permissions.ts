// ── Permission Constants ─────────────────────────────────────────────────────

export const Permissions = {
  WILDCARD: '*',

  // Squads
  SQUADS_READ: 'squads:read',
  SQUADS_CREATE: 'squads:create',
  SQUADS_DELETE: 'squads:delete',

  // Agents
  AGENTS_READ: 'agents:read',
  AGENTS_WRITE: 'agents:write',
  AGENTS_CREATE: 'agents:create',
  AGENTS_RUN: 'agents:run',
  AGENTS_TERMINATE: 'agents:terminate', // unspawn a flex agent (manager/operator); NOT DB deletion
  AGENTS_SCOPES_READ: 'agents:scopes:read',
  AGENTS_SCOPES_MANAGE: 'agents:scopes:manage',

  // Workstreams
  WORKSTREAMS_READ: 'workstreams:read',
  WORKSTREAMS_CREATE: 'workstreams:create',
  WORKSTREAMS_UPDATE: 'workstreams:update',
  WORKSTREAMS_REVISE_FLOW: 'workstreams:revise-flow',
  WORKSTREAMS_REVIEW: 'workstreams:review',
  WORKSTREAMS_DELETE: 'workstreams:delete',
  /** Gates typed wait resolution (POST /:id/waits/:waitId/resolve) and the approve/send-back/unblock sugar. */
  WORKSTREAMS_RESPOND: 'workstreams:respond',
  WORKSTREAMS_MANAGE_AGENTS: 'workstreams:manage-agents',

  // Chat
  CHAT_READ: 'chat:read',
  CHAT_SEND: 'chat:send',

  // Terminal
  TERMINAL_ACCESS: 'terminal:access',

  // Sandbox logs (read-only sandbox/container log tailing)
  SANDBOX_LOGS: 'sandbox:logs',

  // SSH
  SSH_READ: 'ssh:read',
  SSH_WRITE: 'ssh:write',

  // Environment
  ENV_READ: 'env:read',
  ENV_WRITE: 'env:write',

  // Integrations
  INTEGRATIONS_READ: 'integrations:read',
  INTEGRATIONS_USE: 'integrations:use',
  INTEGRATIONS_WRITE: 'integrations:write',
  INTEGRATIONS_EXPORT: 'integrations:export',

  // Memory
  MEMORY_READ: 'memory:read',
  MEMORY_WRITE: 'memory:write',

  // Inbox
  INBOX_READ: 'inbox:read',
  INBOX_WRITE: 'inbox:write',
  // Read and post the shared system/announcements inbox (sandbox crashes, update failures, broadcasts)
  INBOX_SYSTEM: 'inbox:system',
  // Read another agent's inbox within a squad the caller can access.
  INBOX_READ_SQUAD: 'inbox:read-squad',

  // Federation
  AMTP_READ: 'amtp:read',
  AMTP_WRITE: 'amtp:write',
  AMTP_SEND: 'amtp:send',
  AMTP_REGISTER: 'amtp:register',

  // Workspace
  WORKSPACE_READ: 'workspace:read',
  WORKSPACE_WRITE: 'workspace:write',

  // Schedules
  SCHEDULES_READ: 'schedules:read',

  // Squad Relationships
  SQUAD_RELATIONSHIPS_READ: 'squad-relationships:read',
  SQUAD_RELATIONSHIPS_WRITE: 'squad-relationships:write',

  // AI
  AI_VOICE: 'ai:voice',

  // Actions
  ACTIONS_READ: 'actions:read',

  // Operations recommendations
  RECOMMENDATIONS_READ: 'recommendations:read',
  RECOMMENDATIONS_UPDATE: 'recommendations:update',

  // Secrets (with qualifier groups)
  // Bare secrets:read grants access to all qualified secrets:read:<group> variants.
  // Bare secrets:write grants access to all qualified secrets:write:<group> variants.
  // Qualified forms (e.g. secrets:read:integration) only grant that specific group.
  SECRETS_READ: 'secrets:read',
  SECRETS_WRITE: 'secrets:write',
  SECRETS_READ_INTEGRATION: 'secrets:read:integration',
  SECRETS_WRITE_INTEGRATION: 'secrets:write:integration',
  SECRETS_READ_PROVIDER: 'secrets:read:provider',
  SECRETS_WRITE_PROVIDER: 'secrets:write:provider',
  SECRETS_READ_NOTIFICATION: 'secrets:read:notification',
  SECRETS_WRITE_NOTIFICATION: 'secrets:write:notification',
  SECRETS_READ_SYSTEM: 'secrets:read:system',
  SECRETS_WRITE_SYSTEM: 'secrets:write:system',

  // Roles
  ROLES_READ: 'roles:read',
  ROLES_CREATE: 'roles:create',
  ROLES_UPDATE: 'roles:update',
  ROLES_DELETE: 'roles:delete',

  // Users
  USERS_READ: 'users:read',
  USERS_CREATE: 'users:create',
  USERS_UPDATE: 'users:update',
  USERS_DELETE: 'users:delete',

  // Settings
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',

  // Skills
  SKILLS_READ: 'skills:read',
  SKILLS_WRITE: 'skills:write',

  // Squad slot coordination
  SLOTS_USE: 'slots:use',
  SLOTS_WRITE: 'slots:write',

  // Monitors
  MONITORS_READ: 'monitors:read',
  MONITORS_WRITE: 'monitors:write',

  // Machines (VM-based sandbox hosts)
  MACHINES_READ: 'machines:read',
  MACHINES_WRITE: 'machines:write',
  MACHINES_FORCE_MIGRATE: 'machines:force-migrate',

  // Remote hosts (team-owned SSH targets agents reach out to; not tau substrate)
  REMOTE_HOSTS_READ: 'remote-hosts:read',
  REMOTE_HOSTS_WRITE: 'remote-hosts:write',

  // Deployments
  DEPLOYMENTS_READ: 'deployments:read',
  DEPLOYMENTS_WRITE: 'deployments:write',
  DEPLOYMENTS_DELETE: 'deployments:delete',

  // Artifacts
  ARTIFACTS_READ: 'artifacts:read',
  ARTIFACTS_WRITE: 'artifacts:write',

  // Grants
  GRANTS_READ: 'grants:read',
  GRANTS_WRITE: 'grants:write',

  // Updates
  UPDATES_READ: 'updates:read',
  UPDATES_WRITE: 'updates:write',

  // Routing
  ROUTING_READ: 'routing:read',

  // Agent types
  AGENT_TYPES_READ: 'agent-types:read',
  AGENT_TYPES_CREATE: 'agent-types:create',
  AGENT_TYPES_UPDATE: 'agent-types:update',
  AGENT_TYPES_DELETE: 'agent-types:delete',

  // Squad presets
  SQUAD_PRESETS_READ: 'squad-presets:read',
  SQUAD_PRESETS_CREATE: 'squad-presets:create',
  SQUAD_PRESETS_UPDATE: 'squad-presets:update',
  SQUAD_PRESETS_DELETE: 'squad-presets:delete',

  // Workflow catalog (inline definitions only require work-stream creation authority)
  WORKFLOWS_READ: 'workflows:read',
  WORKFLOWS_CREATE: 'workflows:create',
  WORKFLOWS_UPDATE: 'workflows:update',
  WORKFLOWS_DELETE: 'workflows:delete',

  // Channels (management)
  CHANNELS_READ: 'channels:read',
  CHANNELS_CREATE: 'channels:create',
  CHANNELS_UPDATE: 'channels:update',
  CHANNELS_DELETE: 'channels:delete',

  // Provider auth
  PROVIDER_AUTH_READ: 'provider-auth:read',
  PROVIDER_AUTH_WRITE: 'provider-auth:write',

  // Webhooks
  WEBHOOKS_READ: 'webhooks:read',

  // Agent and squad updates
  AGENTS_UPDATE: 'agents:update',
  AGENTS_DELETE: 'agents:delete',
  SQUADS_UPDATE: 'squads:update',

  // Schedule lifecycle
  SCHEDULES_CREATE: 'schedules:create',
  SCHEDULES_UPDATE: 'schedules:update',
  SCHEDULES_DELETE: 'schedules:delete',
  SCHEDULES_TRIGGER: 'schedules:trigger',

  // Terminal (read/write in addition to access)
  TERMINAL_READ: 'terminal:read',
  TERMINAL_WRITE: 'terminal:write',

  // AI services
  AI_EXTRACT: 'ai:extract',
  AI_TRANSCRIBE: 'ai:transcribe',
  AI_TTS: 'ai:tts',

  // System
  SYSTEM_PAUSE: 'system:pause',
  SYSTEM_RESTART: 'system:restart',
  SYSTEM_CLEANUP: 'system:cleanup',
  SYSTEM_LOGS: 'system:logs',
  SYSTEM_DEMO: 'system:demo',

  // System API tokens (user-less, scoped automation tokens — admin-managed)
  SYSTEM_TOKENS_MANAGE: 'system-tokens:manage',

  // Theme presets: self-service create/read/update/delete/share needs no permission
  // (owner-only, resolveActingUser — see routes/theme-presets.ts). Only removing
  // someone ELSE's preset from the instance-wide shared list is privileged.
  THEME_PRESETS_MODERATE: 'theme-presets:moderate',

  // The farm's multiplayer (people talking to people: farm chat and presence,
  // routes/farm-chat.ts and the ws presence/farmChat topics). Its own resource,
  // checked instance-wide (never per squad), so anyone can be given farm:* even
  // when their chat and squad roles are limited. farm:read sees farm chat and
  // who's on the farm; farm:chat posts, reacts, DMs, types and appears there;
  // farm:manage-rooms creates, renames and deletes rooms (never the general
  // room). Only a message's sender edits or deletes it. Operators hold farm:*,
  // Viewers farm:read.
  FARM_READ: 'farm:read',
  FARM_CHAT: 'farm:chat',
  FARM_MANAGE_ROOMS: 'farm:manage-rooms',
} as const

export type Permission = (typeof Permissions)[keyof typeof Permissions]

export const KNOWN_GRANTABLE_PERMISSIONS = new Set<string>(
  Object.values(Permissions).filter((permission) => permission !== Permissions.WILDCARD)
)
export const KNOWN_GRANTABLE_RESOURCES = new Set<string>(
  [...KNOWN_GRANTABLE_PERMISSIONS].map((permission) => permission.split(':')[0]!)
)

/** Whether the create/update APIs may persist this permission on a custom role or scope. */
export function isGrantablePermission(permission: string): boolean {
  if (permission === Permissions.WILDCARD) return false
  if (KNOWN_GRANTABLE_PERMISSIONS.has(permission)) return true
  return permission.endsWith(':*') && KNOWN_GRANTABLE_RESOURCES.has(permission.slice(0, -2))
}

// ── Permission Matching (shared between backend and frontend) ────────────────

/**
 * Check if a held permission grants access to a requested permission.
 *
 * Rules:
 * 1. Global wildcard: `*` matches anything
 * 2. Exact match
 * 3. Resource wildcard: `secrets:*` matches `secrets:read`, `secrets:write`, etc.
 * 4. Bare grants qualified: `secrets:read` matches `secrets:read:integration` (prefix at `:` boundary)
 * 5. Qualified does NOT grant bare: `secrets:read:integration` does NOT match `secrets:read`
 */
export function permissionMatches(held: string, requested: string): boolean {
  if (held === '*') return true
  if (held === requested) return true
  if (held.endsWith(':*')) {
    const prefix = held.slice(0, -1)
    if (requested.startsWith(prefix)) return true
  }
  // Rule 4 only applies when the held permission already includes an action.
  // A bare resource name (e.g. "secrets") must not act as a resource wildcard;
  // use an explicit resource wildcard (e.g. "secrets:*") for that behavior.
  if (held.includes(':') && requested.startsWith(held) && requested[held.length] === ':') return true
  return false
}
