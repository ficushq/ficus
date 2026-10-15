import type { SettingsSearchEntry } from '../settings/settingsSearch'

export const SQUAD_SETTINGS_KEYWORDS: Record<string, string> = {
  general:
    'rename squad title Name purpose mission Description avatar collaboration archive delete remove danger zone Archive squad',
  context:
    'instructions system prompt Squad Context per agent type instructions Type-Specific Context slot pools capacity claim queue usage guidance Slot Pools',
  workspace:
    'git commit identity author name email Git Author Name Git Author Email host directory checkout path repository local folder runtime container restart pause Sandbox Lifecycle sleep dormant timeout Idle Timeout disk space size Ephemeral Storage Limit environment credentials secrets Exposed Secret Store Keys consultant idle dormant inactive cleanup Idle consultants',
  memory:
    'semantic vector model Embedding Model code semantic file search Workspace Indexing glob indexed files Include Patterns glob ignore files Exclude Patterns git sync remote repo providers Memory Sync',
  work: 'workflows flow preset workflow default custom parallel Work capacity concurrency Max concurrent work streams blocked wait timeout idle auto park grace pull request direct merge approval Merge Policies',
  integrations:
    'github issues repo project GitHub Routing GitHub integration accounts github owner repo Repository issue labels Labels linear issue tracker Linear Routing linear team Team ID',
  notifications: 'alerts delivery overrides instance Notification Channels',
  access:
    'public private key authentication SSH Keys ssh fingerprints host key verification Known Hosts remote hosts machines server tunnel',
}

/** Search target for the archive action in Squad Settings > General; anchored in SquadDangerZone. */
export const ARCHIVE_SQUAD_SETTING_ID = 'archive-squad'

export const SQUAD_SETTINGS_SEARCH: readonly SettingsSearchEntry[] = [
  {
    section: 'work',
    id: 'default-workflow',
    label: 'Default workflow',
    keywords: 'flow preset custom workflow routing',
  },
  {
    section: 'general',
    id: 'name',
    label: 'Name',
    keywords: 'rename squad title',
  },
  {
    section: 'general',
    id: 'description',
    label: 'Description',
    keywords: 'purpose mission',
  },
  {
    section: 'general',
    id: ARCHIVE_SQUAD_SETTING_ID,
    label: 'Archive squad',
    keywords: 'delete remove danger zone',
  },
  {
    section: 'work',
    id: 'max-concurrent-work-streams',
    label: 'Max concurrent work streams',
    keywords: 'work capacity concurrency parallel limit',
  },
  {
    section: 'work',
    id: 'auto-park-grace-minutes',
    label: 'Auto-park grace (minutes)',
    keywords: 'blocked wait timeout idle',
  },
  {
    section: 'workspace',
    id: 'host-workspace-directory',
    label: 'Host workspace directory',
    keywords: 'checkout path repository local folder',
  },
  {
    section: 'context',
    id: 'squad-context',
    label: 'Squad Context',
    keywords: 'instructions system prompt',
  },
  {
    section: 'context',
    id: 'type-specific-context',
    label: 'Type-Specific Context',
    keywords: 'per agent type instructions',
  },
  {
    section: 'context',
    id: 'slot-pools',
    label: 'Slot Pools',
    keywords: 'slot capacity claim queue usage guidance concurrency',
  },
  {
    section: 'workspace',
    id: 'sandbox-lifecycle',
    label: 'Sandbox Lifecycle',
    keywords: 'runtime container restart pause',
  },
  {
    section: 'workspace',
    id: 'idle-timeout',
    label: 'Idle Timeout',
    keywords: 'sleep dormant timeout',
  },
  {
    section: 'workspace',
    id: 'ephemeral-storage-limit',
    label: 'Ephemeral Storage Limit',
    keywords: 'disk space size container',
  },
  {
    section: 'memory',
    id: 'embedding-model',
    label: 'Embedding Model',
    keywords: 'semantic vector model',
  },
  {
    section: 'memory',
    id: 'workspace-indexing',
    label: 'Workspace Indexing',
    keywords: 'code semantic file search',
  },
  {
    section: 'memory',
    id: 'include-patterns',
    label: 'Include Patterns',
    keywords: 'glob indexed files',
  },
  {
    section: 'memory',
    id: 'exclude-patterns',
    label: 'Exclude Patterns',
    keywords: 'glob ignore files',
  },
  {
    section: 'memory',
    id: 'memory-sync',
    label: 'Memory Sync',
    keywords: 'git sync remote repo providers',
  },
  {
    section: 'work',
    id: 'merge-policies',
    label: 'Merge Policies',
    keywords: 'pull request direct merge approval',
  },
  {
    section: 'workspace',
    id: 'consultant-idle-dormancy',
    label: 'Idle consultants',
    keywords: 'consultant idle dormant inactive cleanup',
  },
  {
    section: 'workspace',
    id: 'exposed-secret-store-keys',
    label: 'Exposed Secret Store Keys',
    keywords: 'environment credentials secrets',
  },
  {
    section: 'integrations',
    id: 'github-routing',
    label: 'GitHub Routing',
    keywords: 'github issues repo project',
  },
  {
    section: 'workspace',
    id: 'sandbox-github-identity',
    label: 'Git commit identity',
    keywords: 'git user credentials',
  },
  {
    section: 'workspace',
    id: 'git-author-name',
    label: 'Git Author Name',
    keywords: 'commit identity name',
  },
  {
    section: 'workspace',
    id: 'git-author-email',
    label: 'Git Author Email',
    keywords: 'commit identity email',
  },
  {
    section: 'integrations',
    id: 'repository',
    label: 'Repository',
    keywords: 'github owner repo',
  },
  {
    section: 'integrations',
    id: 'labels',
    label: 'Labels',
    keywords: 'issue labels',
  },
  {
    section: 'integrations',
    id: 'linear-routing',
    label: 'Linear Routing',
    keywords: 'linear issue tracker',
  },
  {
    section: 'integrations',
    id: 'team-id',
    label: 'Team ID',
    keywords: 'linear team',
  },
  {
    section: 'notifications',
    id: 'notification-channels',
    label: 'Notification Channels',
    keywords: 'alerts delivery overrides instance',
  },
  {
    section: 'access',
    id: 'ssh-keys',
    label: 'SSH Keys',
    keywords: 'public private key authentication',
  },
  {
    section: 'access',
    id: 'known-hosts',
    label: 'Known Hosts',
    keywords: 'ssh fingerprints host key verification',
  },
  {
    section: 'access',
    id: 'remote-hosts',
    label: 'Remote Hosts',
    keywords: 'ssh machines server tunnel',
  },
]

/** Entries whose destination this squad and this user can actually reach. */
export function squadSettingsSearchEntries({
  hostRuntime,
  sandboxSectionReady,
  canDeleteSquad,
}: {
  hostRuntime: boolean
  sandboxSectionReady: boolean
  canDeleteSquad: boolean
}): SettingsSearchEntry[] {
  return SQUAD_SETTINGS_SEARCH.filter((entry) => {
    if (entry.id === 'host-workspace-directory') return hostRuntime
    if (['sandbox-lifecycle', 'idle-timeout', 'ephemeral-storage-limit'].includes(entry.id)) return sandboxSectionReady
    if (entry.id === ARCHIVE_SQUAD_SETTING_ID) return canDeleteSquad
    return true
  })
}
