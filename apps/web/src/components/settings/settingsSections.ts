interface SectionItem {
  id: string
  label: string
  description: string
}

interface SectionGroup {
  label?: string
  items: readonly SectionItem[]
}

export const SECTION_GROUPS: readonly SectionGroup[] = [
  {
    label: 'Personal',
    items: [
      { id: 'account', label: 'Account', description: 'Your profile, email, password, and passkeys.' },
      {
        id: 'appearance',
        label: 'Appearance',
        description: 'Theme, color, and dark mode preferences.',
      },
      {
        id: 'app',
        label: 'App',
        description: 'App installation, cache, and offline storage.',
      },
      {
        id: 'notifications',
        label: 'Notifications',
        description: 'Your notification delivery and sound preferences.',
      },
      { id: 'mobile', label: 'Mobile', description: 'Mobile app, Pro coverage, and relay setup.' },
      { id: 'devices', label: 'Paired Devices', description: 'Pair and manage linked devices.' },
      { id: 'sessions', label: 'Sessions', description: 'Active sign-in sessions and revocation.' },
    ],
  },
  {
    label: 'Work',
    items: [
      {
        id: 'workflows',
        label: 'Workflows',
        description: 'Flows, participants, handoffs, approvals, limits and delivery.',
      },
      {
        id: 'agent-types',
        label: 'Agent Types',
        description: 'Agent expertise, model tiers, tools, skills, and permissions.',
      },
      {
        id: 'skills',
        label: 'Skills',
        description: 'Reusable agent instructions and supporting resources.',
      },
      {
        id: 'integrations',
        label: 'Integrations',
        description: 'Apps, accounts, credentials and services.',
      },
    ],
  },
  {
    label: 'Access',
    items: [
      { id: 'users', label: 'Users', description: 'Invite people and manage their access.' },
      { id: 'roles', label: 'Access Roles', description: 'Create and edit permission-based access roles.' },
      {
        id: 'system-tokens',
        label: 'System Tokens',
        description: 'Issue and revoke API tokens with selected permissions.',
      },
      { id: 'signup', label: 'Sign-up', description: 'Registration policy and allowed email domains.' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      {
        id: 'squad-presets',
        label: 'Squad Presets',
        description: 'Starting templates copied into newly created squads.',
      },
      {
        id: 'git',
        label: 'Git',
        description: 'Default commit author identity and GitHub identity overrides.',
      },
      {
        id: 'notification-rules',
        label: 'Notification Rules',
        description: 'Rules for routing events to outbound notifications.',
      },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      {
        id: 'providers',
        label: 'AI Providers',
        description: 'Model accounts and local providers.',
      },
      {
        id: 'memory',
        label: 'Assistant & Memory',
        description: 'Voice assistant and semantic memory search, including OpenAI API setup.',
      },
      { id: 'amtp', label: 'Federation', description: 'Federation identity, peers, and trust rules.' },
      {
        id: 'machines',
        label: 'Machines',
        description: 'Machines and capacity used to run squad workloads.',
      },
      { id: 'remote-hosts', label: 'Remote hosts', description: 'Shared SSH targets squads can access.' },
    ],
  },
  {
    label: 'Operations',
    items: [
      {
        id: 'system',
        label: 'System',
        description: 'Runtime health, maximum active agents, maintenance, and process controls.',
      },
      {
        id: 'storage',
        label: 'Storage',
        description: 'Disk usage by squad, repositories, worktrees, and tools.',
      },
      { id: 'system-logs', label: 'Logs', description: 'Search and inspect system logs.' },
      {
        id: 'ops-insights',
        label: 'Recommendations',
        description: 'Operational recommendations and optimization insights.',
      },
      { id: 'updates', label: 'Updates', description: 'Update source, schedule, and deployment progress.' },
    ],
  },
] as const

export const ALL_SECTIONS = SECTION_GROUPS.flatMap((g) => g.items)
export type SectionId = (typeof ALL_SECTIONS)[number]['id']

const SECTION_IDS = ALL_SECTIONS.map((s) => s.id)

const SECRET_READ_PERMISSIONS = ['secrets:read', 'secrets:read:integration']

const SECTION_PERMISSIONS: Partial<Record<SectionId, string>> = {
  'ops-insights': 'recommendations:read',
  users: 'users:read',
  roles: 'roles:read',
  'system-tokens': 'system-tokens:manage',
  // Reading the policy exposes the allowed-domain list, which GET /auth/settings gates on settings:read.
  signup: 'settings:read',
  memory: 'settings:read',
  providers: 'provider-auth:read',
  skills: 'skills:read',
  'agent-types': 'agent-types:read',
  'squad-presets': 'squad-presets:read',
  workflows: 'workflows:read',
  'notification-rules': 'settings:read',
  amtp: 'amtp:read',
  machines: 'machines:read',
  'remote-hosts': 'remote-hosts:read',
  system: 'squads:read',
  storage: 'system:logs',
  'system-logs': 'system:logs',
  updates: 'updates:read',
}

export function isValidSection(value: string | null): value is SectionId {
  return value !== null && SECTION_IDS.includes(value)
}

export function isSectionAllowed(
  section: SectionId,
  can: (permission: string) => boolean,
  isLoading: boolean,
  integrationAllowed = false
): boolean {
  if (section === 'integrations') return !isLoading && integrationAllowed
  if (section === 'git') {
    if (isLoading) return false
    return SECRET_READ_PERMISSIONS.some((permission) => can(permission))
  }
  if (section === 'system') {
    if (isLoading) return false
    return ['settings:read', 'squads:read', 'system:restart', 'system:pause'].some((permission) => can(permission))
  }
  const permission = SECTION_PERMISSIONS[section]
  if (!permission) return true
  if (isLoading) return false
  return can(permission)
}
