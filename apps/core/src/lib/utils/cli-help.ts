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

const CLI_ERROR = `[ERROR] The ficus CLI is not installed or not accessible. Inspect and repair your authorized local tooling, then retry within the bounded recovery budget. Do not ask a person to run installation or diagnostic commands. If local recovery exhausts, use the existing typed recovery decision and manager-first routing. You cannot execute any ficus commands until the CLI is available.`

/** One top-level command group listed by `ficus --help`. */
interface CommandGroup {
  name: string
  aliases: string[]
  description: string
}

/**
 * Parses the `Commands:` section of `ficus --help` into top-level groups,
 * joining wrapped description lines and dropping commander's `help` entry.
 */
export function parseCommandGroups(rootHelp: string): CommandGroup[] {
  const groups: CommandGroup[] = []
  let inCommands = false
  for (const line of rootHelp.split('\n')) {
    if (/^\S/.test(line)) {
      inCommands = line.startsWith('Commands:')
    } else if (inCommands && /^ {2}\S/.test(line)) {
      // `  name|alias [options] <arg>    Description`: the term ends at a run of spaces.
      const [term = '', ...description] = line.trim().split(/\s{2,}/)
      const [name = '', ...aliases] = term.split(' ')[0]!.split('|')
      if (name !== 'help') groups.push({ name, aliases, description: description.join(' ') })
    } else if (inCommands && line.trim() !== '' && groups.length > 0) {
      const last = groups.at(-1)!
      last.description = `${last.description} ${line.trim()}`.trim()
    }
  }
  return groups
}

let rootGroups: CommandGroup[] | null = null

/** Test-only: drop the cached command groups. */
export function resetCliHelpCacheForTests(): void {
  rootGroups = null
}

/**
 * Reads the top-level command groups from the built CLI. Caches ONLY a
 * successful read: a worker that boots one second before
 * apps/cli/dist/ficus.js lands (artifact activation, first build) must not bake
 * "CLI not installed" into every agent prompt for the life of the process.
 */
async function loadCommandGroups(): Promise<CommandGroup[] | null> {
  if (rootGroups) return rootGroups
  const cliPath = getCliHostPath()
  // Rely solely on the built CLI. A shipped artifact has no `apps/cli/src/`,
  // so when the dist bundle is missing we return the actionable CLI_ERROR.
  if (!existsSync(cliPath)) return null
  const help = await $`${[cliPath]} --help`.text().catch(() => '')
  const groups = parseCommandGroups(help)
  if (groups.length === 0) return null
  rootGroups = groups
  return groups
}

const INDEX_INTRO = 'You have access to the `ficus` CLI. Its top-level command groups:'
const INDEX_DETAILS =
  "Run `ficus <group> --help` to list the commands in a group, and `ficus <group> <command> --help` for a command's arguments, flags and examples."
const OMITTED_GROUPS_NOTE =
  'Groups and commands that need permissions you do not hold are left out. Route those requests to your squad manager.'

/**
 * A short index of the `ficus` CLI for an agent prompt: one line per top-level
 * command group the caller may use, then where to find the details. With
 * `permissions`, groups the caller cannot use are left out, and the commands it
 * cannot use inside the listed groups are named so it routes them to its
 * manager instead of discovering the 403 (see {@link CLI_COMMAND_PERMISSIONS}).
 * Without `permissions` every group is listed. Operator-only groups are never
 * listed. Returns an error notice when the CLI cannot be read.
 */
export async function getCliCommandIndex(
  permissions: readonly string[] = ['*'],
  options: CliIndexOptions = {}
): Promise<string> {
  const groups = await loadCommandGroups()
  if (!groups) return CLI_ERROR
  return renderCliCommandIndex(groups, permissions, options)
}

export interface CliIndexOptions {
  /**
   * Leave out {@link HOST_ONLY_GROUPS}. Set for squad agents: they run in sandboxes, so commands
   * that act on the machine the CLI runs on (the Ficus server install, its worker, the desktop app)
   * cannot do anything useful for them.
   */
  omitHostGroups?: boolean
}

/**
 * Groups that operate the machine the CLI runs on rather than calling the API for squad work:
 * the local Ficus server and its worker process, instance updates, CLI and desktop installs, and
 * app-store demo access (which needs a host environment flag).
 */
export const HOST_ONLY_GROUPS: readonly string[] = ['server', 'update', 'install', 'desktop', 'worker', 'demo']

/** Renders the index for `groups`; exported for tests. */
export function renderCliCommandIndex(
  groups: readonly CommandGroup[],
  permissions: readonly string[],
  options: CliIndexOptions = {}
): string {
  const offered = options.omitHostGroups ? groups.filter((group) => !HOST_ONLY_GROUPS.includes(group.name)) : groups
  const listed = offered.filter((group) => mayUse(group.name, permissions))
  const lines = listed.map((group) => {
    const aliases = group.aliases.length > 0 ? ` (${group.aliases.join(', ')})` : ''
    return `- ${group.name}${aliases}: ${group.description}`
  })
  const parts = [INDEX_INTRO, lines.join('\n'), INDEX_DETAILS]
  const withheld = withheldCommands(
    listed.map((group) => group.name),
    permissions
  )
  const hidesGroups = listed.length < offered.filter((group) => !isOperatorOnly(group.name)).length
  if (withheld.length > 0 || hidesGroups) {
    parts.push(
      withheld.length > 0
        ? `${OMITTED_GROUPS_NOTE} Inside the groups above, these commands are not available to you: ${withheld.join('; ')}.`
        : OMITTED_GROUPS_NOTE
    )
  }
  return parts.join('\n\n')
}

/** `group cmd, cmd` for each listed group with commands the caller cannot use. */
function withheldCommands(listedGroups: readonly string[], permissions: readonly string[]): string[] {
  const byGroup = new Map<string, string[]>()
  for (const key of Object.keys(CLI_COMMAND_PERMISSIONS)) {
    const [group, command] = key.split(' ')
    if (!command || !listedGroups.includes(group!) || mayUse(key, permissions)) continue
    byGroup.set(group!, [...(byGroup.get(group!) ?? []), command])
  }
  return listedGroups.filter((group) => byGroup.has(group)).map((group) => `${group} ${byGroup.get(group)!.join(', ')}`)
}

export async function warmupCliCommandIndex(): Promise<void> {
  await loadCommandGroups()
}

/**
 * Permissions the Core API enforces for CLI commands, used to trim the
 * CLI index an agent sees. Keys are a top-level group (`agent-type`) or `<group>
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
  'agent recovery': ['agents:run'],
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
  'squad storage': ['storage:read'], // GET /:id/storage
  'squad idle-consultants': ['agents:terminate'], // GET /:id/idle-consultants, POST /:id/idle-consultants/dormant
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
  'workstream resolve-input': ['workstreams:respond', 'workstreams:update'],
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

/** Groups never shown to an agent, whatever permissions it holds. */
function isOperatorOnly(group: string): boolean {
  return group === 'secret'
}

function mayUse(key: string, permissions: readonly string[]): boolean {
  if (isOperatorOnly(key.split(' ')[0]!)) return false
  const required = CLI_COMMAND_PERMISSIONS[key]
  if (!required) return true
  return required.some((permission) => permissions.some((held) => permissionMatches(held, permission)))
}
