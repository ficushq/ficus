import { $ } from 'bun'
import { existsSync } from 'fs'
import { join } from 'path'
import { permissionMatches } from '@ficus/shared'
import { MONOREPO_ROOT } from '../paths'

let cliPathOverride: string | null = null
/** Test-only: force getCliHostPath()'s result. */
export function setCliPathOverrideForTests(path: string | null): void {
  cliPathOverride = path
}

/**
 * Get the absolute host path to the built ficus CLI (`apps/cli/dist/ficus.js`).
 * Used for mounting into sandbox containers and generating help output.
 */
export function getCliHostPath(): string {
  return cliPathOverride ?? join(MONOREPO_ROOT, 'apps/cli/dist/ficus.js')
}

const CLI_ERROR = `[ERROR] The ficus CLI is not installed or not accessible. Tell the user that the CLI could not be found and ask them to install it (e.g. run "bun run build:cli" in the project root and ensure the "ficus" binary is on the PATH). You cannot execute any ficus commands until this is resolved.`

/**
 * Generate CLI help for specific subcommands.
 * Always includes `ficus --help` as the first entry.
 */
async function generateHelpFor(subcommands: string[]): Promise<string> {
  const cliPath = getCliHostPath()
  // Rely solely on the built CLI at apps/cli/dist/ficus.js. A shipped artifact
  // has no `apps/cli/src/`, so the old `bun apps/cli/src/index.ts` source
  // fallback would silently vanish there; when the dist bundle is missing we
  // surface the actionable CLI_ERROR instead of spawning a nonexistent file.
  if (!existsSync(cliPath)) return CLI_ERROR
  const cliCommand = [cliPath]

  try {
    const promises = [
      $`${cliCommand} --help`.text().catch(() => ''),
      ...subcommands.map((cmd) => $`${cliCommand} ${cmd} --help`.text().catch(() => '')),
    ]
    const results = await Promise.all(promises)

    // Agent references never advertise operator-only commands, even for an
    // assistant acting with a human's broad permissions. Operator CLI help is unchanged.
    const filtered = results.filter(Boolean).map((section) => filterHelpSection(section, ['*']))
    if (filtered.length > 0) {
      return `You have access to the \`ficus\` CLI. Here's the full command reference:\n\n${filtered.join('\n\n---\n\n')}`
    }
    throw new Error('No help output')
  } catch {
    return CLI_ERROR
  }
}

/** Subcommands relevant to system manager */
const SYSTEM_MANAGER_SUBCOMMANDS = ['agent', 'squad', 'workflow', 'inbox']

/** Subcommands relevant to task-workflow agents and the system manager */
const TASK_SUBCOMMANDS = ['task', 'schedule', 'task-type', 'agent-type']

/** Subcommands relevant to squad workers */
const SQUAD_WORKER_SUBCOMMANDS = ['agent', 'workstream', 'workflow', 'squad', 'inbox']

/** Subcommands relevant to squad managers */
const SQUAD_MANAGER_SUBCOMMANDS = ['agent', 'workstream', 'workflow', 'squad', 'inbox']

// Separate caches per help profile
const cache: Record<string, string> = {}

/** Test-only: drop the per-profile help cache. */
export function resetCliHelpCacheForTests(): void {
  for (const k of Object.keys(cache)) delete cache[k]
}

/**
 * Cache ONLY successful help. The error sentinel is returned but never stored:
 * a worker that boots one second before apps/cli/dist/ficus.js lands (artifact
 * activation, first build) must not bake "CLI not installed" into every agent
 * prompt for the life of the process.
 */
async function cachedHelp(key: string, subcommands: string[]): Promise<string> {
  if (cache[key]) return cache[key]
  const help = await generateHelpFor(subcommands)
  if (help !== CLI_ERROR) cache[key] = help
  return help
}

/** CLI help for system manager */
export async function getSystemManagerCliHelp(): Promise<string> {
  return cachedHelp('systemManager', SYSTEM_MANAGER_SUBCOMMANDS)
}

/** CLI help for task-workflow runners */
export async function getTaskWorkflowCliHelp(): Promise<string> {
  return cachedHelp('task', TASK_SUBCOMMANDS)
}

/** CLI help for squad workers */
export async function getSquadWorkerCliHelp(): Promise<string> {
  return cachedHelp('squadWorker', SQUAD_WORKER_SUBCOMMANDS)
}

/** CLI help for squad managers */
export async function getSquadManagerCliHelp(): Promise<string> {
  return cachedHelp('squadManager', SQUAD_MANAGER_SUBCOMMANDS)
}

export async function warmupCliHelpCaches(): Promise<void> {
  await Promise.all([getSystemManagerCliHelp(), getSquadWorkerCliHelp(), getSquadManagerCliHelp()])
}

export function clearCliHelpCache(): void {
  for (const key of Object.keys(cache)) {
    delete cache[key]
  }
}

/**
 * Permissions the Core API enforces for CLI commands that squad workers see in
 * their reference. Keys are a top-level group (`agent-type`) or `<group>
 * <subcommand>` (`workstream create`); values list the permissions that unlock
 * the command (any one suffices). Each entry mirrors the route guard named in
 * its comment, so a caller holding none of them would only get a 403.
 *
 * Commands absent from this map are always listed: the server still enforces
 * every request, so the map only trims commands that are certain to fail.
 */
export const CLI_COMMAND_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  // Top-level groups whose every command calls a route guarded by these permissions.
  admin: ['system:cleanup'], // routes/admin.ts
  'agent-type': ['agent-types:read', 'agent-types:create', 'agent-types:update', 'agent-types:delete'], // routes/agent-types.ts
  channel: ['channels:read', 'channels:create', 'channels:update', 'channels:delete'], // routes/channel-instances.ts
  machines: ['machines:read', 'machines:write'], // routes/machines.ts
  'provider-auth': ['provider-auth:read', 'provider-auth:write'], // routes/provider-auth.ts
  role: ['roles:read', 'roles:create', 'roles:update', 'roles:delete'], // routes/roles.ts
  'shared-prompt': ['agent-types:read', 'agent-types:update'], // routes/shared-prompts.ts
  'squad-env': ['env:read', 'env:write'], // routes/squad-env.ts
  'squad-preset': ['squad-presets:read', 'squad-presets:create', 'squad-presets:update', 'squad-presets:delete'], // routes/squad-presets.ts
  user: ['users:read', 'users:create', 'users:update', 'users:delete'], // routes/users.ts
  webhook: ['webhooks:read'], // routes/webhooks.ts

  // ficus agent — routes/agents.ts
  'agent rename': ['agents:update'], // PATCH /:id
  'agent persist': ['agents:update'], // PATCH /:id
  'agent model': ['agents:update'], // PATCH /:id
  'agent message': ['agents:run'],
  'agent stop': ['agents:run'],
  'agent force-stop': ['agents:run'],
  'agent abort-tool': ['agents:run'],
  'agent compact': ['agents:run'],
  'agent steer': ['agents:run'],
  'agent follow-up': ['agents:run'],
  'agent reset': ['agents:run'],
  'agent clear-queue': ['agents:run'],
  'agent continue': ['agents:run'],
  'agent continue-halted': ['agents:run'],
  'agent sandbox-ps': ['agents:run'], // /:id/sandbox/processes
  'agent sandbox-kill': ['agents:run'],
  'agent sandbox-stop-container': ['agents:run'],
  'agent delete': ['agents:delete'],
  'agent prune': ['agents:delete'],
  'agent scope': ['agents:scopes:read', 'agents:scopes:manage'],

  // ficus inbox — routes/inbox.ts
  'inbox send-system': ['inbox:system'],

  // ficus squad — routes/squads.ts, squad-relationships.ts, squad-ssh.ts, grants.ts
  'squad create': ['squads:create'],
  'squad update': ['squads:update'],
  'squad set-meta': ['squads:update'],
  'squad unset-meta': ['squads:update'],
  'squad delete': ['squads:delete'],
  'squad sandbox-ps': ['squads:update'],
  'squad sandbox-kill': ['squads:update'],
  'squad sandbox-stop-container': ['squads:update'],
  'squad link': ['squad-relationships:write'],
  'squad unlink': ['squad-relationships:write'],
  'squad search-messages': ['chat:read'],
  'squad spawn': ['agents:create'],
  'squad unspawn': ['agents:terminate'],
  'squad terminate-bulk': ['agents:terminate'],
  'squad cleanup-agents': ['agents:terminate', 'system:cleanup'],
  'squad ssh': ['ssh:read', 'ssh:write'],
  'squad grant': ['grants:read', 'grants:write'],

  // ficus workflow — routes/workflows.ts (catalog routes need workflows:*; resolve needs workstreams:create)
  'workflow list': ['workflows:read'],
  'workflow get': ['workflows:read'],
  'workflow export': ['workflows:read'],
  'workflow template-diff': ['workflows:read'],
  'workflow create': ['workflows:create'],
  'workflow update': ['workflows:update'],
  'workflow enable': ['workflows:update'],
  'workflow disable': ['workflows:update'],
  'workflow revert': ['workflows:update'],
  'workflow delete': ['workflows:delete'],
  'workflow resolve': ['workstreams:create'],

  // ficus workstream — routes/work-streams.ts. Commands that PATCH the stream, request
  // input/review, or resolve waits are open to bound workers (workstreams:respond) and
  // stay listed.
  'workstream create': ['workstreams:create'],
  'workstream wait-actor': ['workstreams:update'],
  'workstream pause': ['workstreams:update'],
  'workstream resume': ['workstreams:update'],
  'workstream park': ['workstreams:update'],
  'workstream reopen': ['workstreams:update'],
  'workstream cancel': ['workstreams:update'],
  'workstream notify-ci': ['inbox:system'], // also needs workstreams:update
  'workstream add-agent': ['workstreams:manage-agents'], // also squad spawn (agents:create)
  'workstream remove-agent': ['workstreams:manage-agents'],
  'workstream delete': ['workstreams:delete'],
}

const OMITTED_COMMANDS_NOTE =
  'Commands that need permissions you do not hold are omitted below. Route those requests to your squad manager.'

/** The command group a help section documents, or '' for the top-level `ficus --help`. */
function helpSectionGroup(section: string): string {
  const usage = /^Usage: ficus (\S+)/m.exec(section)?.[1] ?? ''
  return usage.startsWith('[') ? '' : (usage.split('|')[0] ?? '')
}

function mayUse(key: string, permissions: readonly string[]): boolean {
  if (key === 'secret' || key.startsWith('secret ')) return false
  const required = CLI_COMMAND_PERMISSIONS[key]
  if (!required) return true
  return required.some((permission) => permissions.some((held) => permissionMatches(held, permission)))
}

/** Drops `Commands:` entries (and their wrapped description lines) the caller cannot use. */
function filterHelpSection(section: string, permissions: readonly string[]): string {
  const group = helpSectionGroup(section)
  const out: string[] = []
  let inCommands = false
  let skipping = false
  for (const line of section.split('\n')) {
    if (/^\S/.test(line)) {
      inCommands = line.startsWith('Commands:')
      skipping = false
    } else if (inCommands && /^ {2}\S/.test(line)) {
      const name = line.trim().split(/\s/)[0]!.split('|')[0]!
      skipping = !mayUse(group ? `${group} ${name}` : name, permissions)
    } else if (inCommands && line.trim() === '') {
      skipping = false
    }
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

/**
 * Narrows generated CLI help to the commands an agent holding `permissions` can
 * use (see {@link CLI_COMMAND_PERMISSIONS}). Help sections for a whole group the
 * caller cannot use are dropped too. When anything is removed, a note tells the
 * reader to route those requests to the manager.
 */
export function filterCliHelpForPermissions(help: string, permissions: readonly string[]): string {
  const separator = '\n\n---\n\n'
  const sections = help.split(separator)
  const kept = sections
    .filter((section) => {
      const group = helpSectionGroup(section)
      return !group || mayUse(group, permissions)
    })
    .map((section) => filterHelpSection(section, permissions))
  const filtered = kept.join(separator)
  if (filtered === help) return help
  const intro = /^You have access to the `ficus` CLI\.[^\n]*\n/.exec(filtered)?.[0]
  return intro
    ? `${intro}\n${OMITTED_COMMANDS_NOTE}\n${filtered.slice(intro.length)}`
    : `${OMITTED_COMMANDS_NOTE}\n\n${filtered}`
}
