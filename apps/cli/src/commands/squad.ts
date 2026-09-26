import { Command } from 'commander'
import { readFileSync } from 'fs'
import { expandTilde } from '@ficus/shared/node'
import { apiGet, apiPost, apiPatch, apiPut, apiDelete, apiGetRaw } from '../client'
import { output, outputTable, outputError, isJsonMode } from '../output'
import { WorkStream } from './workstream'
import { registerSquadGrantCommands } from './squad-grant'
import { describeAttention, performAttentionSubscribe, type SubscriptionResponse } from './attention'
import { buildMetadataDelta, getMetadataValue, parseMetadataPath, parseMetadataValue } from '../metadata'
import { registerSandboxProcessCommands } from './sandbox-processes'

interface Squad {
  id: string
  name: string
  purpose: string
  status: string
  squadPresetId: string | null
  defaultAgents: string[]
  managerAgentId: string | null
  isAnonymous: boolean
  globalCollaborationEnabled: boolean
  context: string | null
  typeContext: Record<string, string> | null
  metadata: Record<string, unknown>
  maxConcurrentWorkStreams?: number | null
  blockedGraceMinutes?: number | null
  createdAt: string
  updatedAt: string
}

/** Parse `--blocked-grace-minutes N|default` → number | null. Throws on anything else (negatives rejected). */
export function parseBlockedGraceMinutes(value: string): number | null {
  if (value === 'default') return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --blocked-grace-minutes: ${value}. Must be a non-negative integer or 'default' (30)`)
  }
  return parsed
}

/** Parse `--max-concurrent-streams N|unlimited` → number | null. Throws on anything else. */
export function parseMaxConcurrentStreams(value: string): number | null {
  if (value === 'unlimited') return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid --max-concurrent-streams: ${value}. Must be a positive integer or 'unlimited'`)
  }
  return parsed
}

/** Parse `--host-workspace-path <abs>|none` → string | null. Absolute, no `..` segments. */
export function parseHostWorkspacePath(value: string): string | null {
  if (value === 'none') return null
  // Expand `~` HERE, client-side, before the absolute check. The server keeps
  // requiring an absolute path and must: it is also reached from a browser,
  // which cannot know what a given user's home directory is. Only the machine
  // where `~/repo` was typed can answer that, and this is that machine.
  //
  // The `..` check has to look at the value AS TYPED as well as at the result:
  // join() inside expandTilde() normalizes `..` away, so `~/repo/../../etc`
  // would arrive as a clean `/Users/etc` and slip past a check on the expanded
  // path alone. Rejecting traversal is the point, not tidying it up.
  const expanded = expandTilde(value)
  if (value.split('/').includes('..') || !expanded.startsWith('/') || expanded.split('/').includes('..')) {
    throw new Error(
      `Invalid --host-workspace-path: ${value}. Must be an absolute path without ".." segments, or 'none'`
    )
  }
  return expanded
}

interface Agent {
  id: string
  agentTypeId: string
  squadId: string | null
  workStreamId: string | null
  status: string
  metadata?: { name?: string } | null
  configuredModel?: string
  modelOverride?: string | null
  terminatedAt: string | null
  createdAt: string
  updatedAt: string
}

interface SquadRelationship {
  id: string
  sourceSquadId: string
  targetSquadId: string
  relationshipType: string
  metadata: Record<string, unknown>
  createdAt: string
}

interface SquadRelationshipSummary {
  id: string
  name: string
  purpose: string
  managerAgentId: string | null
}

interface SquadRelationships {
  reportsTo: SquadRelationshipSummary[]
  collaborates: SquadRelationshipSummary[]
  dependsOn: SquadRelationshipSummary[]
  reportedBy: SquadRelationshipSummary[]
  dependedOnBy: SquadRelationshipSummary[]
}

interface BulkTerminateAgentsResult {
  terminated: string[]
  deferred: string[]
  skipped: Array<{ id: string; reason: string }>
}

interface TreeNode {
  name: string
  type: 'file' | 'directory'
  size?: number
  children?: TreeNode[]
}

function printTree(node: TreeNode, indent = '') {
  const isRoot = indent === ''
  const prefix = isRoot ? '' : indent.slice(0, -2) + '├─ '
  const suffix = node.type === 'directory' ? '/' : ''
  console.log(`${prefix}${node.name}${suffix}`)

  if (node.children) {
    const lastIdx = node.children.length - 1
    node.children.forEach((child, idx) => {
      const childIndent = isRoot ? '' : indent
      const connector = idx === lastIdx ? '└─ ' : '├─ '
      const nextIndent = idx === lastIdx ? '   ' : '│  '

      if (child.type === 'directory') {
        console.log(`${childIndent}${connector}${child.name}/`)
        if (child.children && child.children.length > 0) {
          child.children.forEach((grandchild, gIdx) => {
            const gLastIdx = child.children!.length - 1
            const gConnector = gIdx === gLastIdx ? '└─ ' : '├─ '
            const gSuffix = grandchild.type === 'directory' ? '/' : ''
            console.log(`${childIndent}${nextIndent}${gConnector}${grandchild.name}${gSuffix}`)
          })
        }
      } else {
        console.log(`${childIndent}${connector}${child.name}`)
      }
    })
  }
}

function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value])
}

export function registerSquadCommands(program: Command) {
  const squad = program.command('squad').description('Manage squads')

  const toolchain = squad.command('toolchain').description('Manage the squad sandbox toolchain')
  toolchain.command('get <squadId>').action(async (squadId: string) => {
    const config = await apiGet<{ packages: string[]; setupScript?: string }>(`/api/squads/${squadId}/toolchain`)
    if (isJsonMode()) output(config)
    else {
      console.log(`Packages: ${config.packages.join(', ') || 'none'}`)
      console.log(
        config.setupScript
          ? `Setup script: configured (${Buffer.byteLength(config.setupScript)} bytes)`
          : 'Setup script: none'
      )
    }
  })
  toolchain
    .command('set <squadId>')
    .option('-p, --package <spec>', 'Package reference (repeatable)', collect, [])
    .option('--setup-file <path>', 'Read the setup script from a file')
    .action(async (squadId: string, opts: { package: string[]; setupFile?: string }) => {
      const body = {
        packages: opts.package,
        ...(opts.setupFile ? { setupScript: readFileSync(opts.setupFile, 'utf8') } : {}),
      }
      output(await apiPut(`/api/squads/${squadId}/toolchain`, body))
    })
  toolchain.command('clear <squadId>').action(async (squadId: string) => {
    output(await apiDelete(`/api/squads/${squadId}/toolchain`))
  })
  toolchain.command('apply <squadId>').action(async (squadId: string) => {
    output(await apiPost(`/api/squads/${squadId}/toolchain/apply`, {}))
  })

  const source = squad.command('source').description('Manage per-squad memory source ingestion policies')
  const memory = squad.command('memory').description('Manage squad memory operations')

  memory
    .command('ingest <squadId> <url>')
    .description('Ingest a supported external URL into squad memory')
    .action(async (squadId, url) => {
      try {
        const result = await apiPost<{
          sourceType: string
          sourceId: string
          result: { success: boolean; skipped?: boolean; chunksCreated?: number; linksCreated?: number; error?: string }
        }>(`/api/memory/${squadId}/ingest-url`, { url })
        const status = result.result.skipped ? 'skipped' : result.result.success ? 'indexed' : 'failed'
        output(result, `${status}: ${result.sourceType} ${result.sourceId}`)
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  source
    .command('list <squadId>')
    .description('List source ingestion policies for a squad')
    .action(async (squadId) => {
      try {
        const configs = await apiGet<Record<string, unknown>[]>(`/api/squads/${squadId}/source-configs`)
        output(configs, configs.length ? undefined : `No source configs for squad ${squadId.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  source
    .command('set <squadId> <sourceType>')
    .description('Set source ingestion policy for a squad')
    .option('--enabled', 'Enable this source')
    .option('--disabled', 'Disable this source')
    .option('--policy <json>', 'Policy JSON', '{"version":1}')
    .action(async (squadId, sourceType, options) => {
      try {
        const policy = JSON.parse(options.policy)
        const config = await apiPut<Record<string, unknown>>(`/api/squads/${squadId}/source-configs/${sourceType}`, {
          enabled: options.disabled ? false : options.enabled ? true : undefined,
          policy,
        })
        output(config, `Updated ${sourceType} source config for squad ${squadId.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad list [--status <status>] [--include-anonymous]
  squad
    .command('list')
    .description('List all squads')
    .option('-s, --status <status>', 'Filter by status (active, paused, archived)')
    .option('-a, --include-anonymous', 'Include anonymous squads')
    .action(async (options) => {
      try {
        const params = new URLSearchParams()
        if (options.status) params.set('status', options.status)
        if (options.includeAnonymous) params.set('includeAnonymous', 'true')
        const query = params.toString()
        const squads = await apiGet<Squad[]>(`/api/squads${query ? `?${query}` : ''}`)

        if (isJsonMode()) {
          output(squads)
        } else {
          if (squads.length === 0) {
            console.log('No squads found')
            return
          }
          outputTable(
            squads.map((s) => ({
              id: s.id,
              name: s.name,
              status: s.status,
              purpose: s.purpose,
              global: s.globalCollaborationEnabled ? 'yes' : 'no',
              ...(options.includeAnonymous ? { anonymous: s.isAnonymous ? 'yes' : 'no' } : {}),
            })),
            options.includeAnonymous
              ? ['id', 'name', 'status', 'global', 'anonymous', 'purpose']
              : ['id', 'name', 'status', 'global', 'purpose']
          )
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad create <name> -p <purpose> [options]
  squad
    .command('create <name>')
    .alias('new')
    .description('Create a new squad')
    .requiredOption('-p, --purpose <purpose>', 'Squad purpose')
    .option('--preset <presetId>', 'Squad preset to copy at creation')
    .option(
      '-a, --default-agent <agentType>',
      'Override preset members with this agent type (can be repeated)',
      collect
    )
    .option('--context <context>', "Additional context for all squad agents' system prompts")
    .option('--type-context <json>', 'JSON map of agent type ID -> context string (e.g. \'{"engineer":"..."}\')')
    .option(
      '--host-workspace-path <path>',
      'Host sandbox runtime only: absolute directory on the Ficus host this squad works in; `~` is expanded on the machine running the CLI'
    )
    .action(async (name, options) => {
      try {
        const payload: Record<string, unknown> = {
          name,
          purpose: options.purpose,
          squadPresetId: options.preset,
          defaultAgents: options.defaultAgent,
          context: options.context,
        }
        if (options.typeContext) {
          payload.typeContext = JSON.parse(options.typeContext)
        }
        if (options.hostWorkspacePath !== undefined) {
          const hostWorkspacePath = parseHostWorkspacePath(options.hostWorkspacePath)
          if (hostWorkspacePath !== null) payload.hostWorkspacePath = hostWorkspacePath
        }
        const squad = await apiPost<Squad>('/api/squads', payload)

        output(squad, `Created squad ${squad.id.slice(0, 8)}: ${squad.name}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad get <id>
  squad
    .command('get <id>')
    .alias('info')
    .description('Get squad details')
    .action(async (id) => {
      try {
        const squad = await apiGet<Squad>(`/api/squads/${id}`)

        if (isJsonMode()) {
          output(squad)
        } else {
          console.log(`ID:          ${squad.id}`)
          console.log(`Name:        ${squad.name}`)
          console.log(`Purpose:     ${squad.purpose}`)
          if (squad.context) {
            console.log(`Context:     ${squad.context}`)
          }
          console.log(`Metadata:    ${JSON.stringify(squad.metadata, null, 2)}`)
          console.log(`Status:      ${squad.status}`)
          console.log(`Anonymous:   ${squad.isAnonymous ? 'yes' : 'no'}`)
          console.log(`Global Collaboration: ${squad.globalCollaborationEnabled ? 'yes' : 'no'}`)
          console.log(`Preset:      ${squad.squadPresetId || '(none)'}`)
          console.log(
            `Default Agents: ${squad.defaultAgents && squad.defaultAgents.length > 0 ? squad.defaultAgents.join(', ') : '(none)'}`
          )
          if (squad.typeContext && Object.keys(squad.typeContext).length > 0) {
            console.log('Type Context:')
            for (const [typeId, ctx] of Object.entries(squad.typeContext)) {
              console.log(`  ${typeId}: ${ctx.slice(0, 80)}${ctx.length > 80 ? '...' : ''}`)
            }
          }
          console.log(`Created:     ${squad.createdAt}`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad update <id> [options]
  squad
    .command('update <id>')
    .alias('edit')
    .description('Update a squad')
    .option('-n, --name <name>', 'New name')
    .option('-p, --purpose <purpose>', 'New purpose')
    .option('-s, --status <status>', 'New status (active, paused, archived)')
    .option('--add-default-agent <agentType>', 'Add default agent type')
    .option('--remove-default-agent <agentType>', 'Remove default agent type')
    .option('--global-collaboration', 'Make this squad reachable by all squad managers')
    .option('--no-global-collaboration', 'Disable global squad collaboration')
    .option(
      '--type-context <json>',
      'JSON map of agent type ID -> context string (e.g. \'{"engineer":"..."}\'). Merges with existing values on update; use null for a key to delete it (e.g. \'{"engineer":null}\').'
    )
    .option(
      '--context <context>',
      "Set the all-agent squad context string injected into every agent's prompt (pass empty to clear)"
    )
    .option(
      '--max-concurrent-streams <value>',
      "Max simultaneously-admitted work streams, or 'unlimited' (excess creations queue; lowering never evicts)"
    )
    .option(
      '--blocked-grace-minutes <value>',
      "Auto-park grace: an active stream with an open wait older than this many minutes is parked. 'default' = 30; 0 = immediate"
    )
    .option(
      '--host-workspace-path <path>',
      "Host sandbox runtime only: absolute directory on the Ficus host this squad works in; `~` is expanded on the machine running the CLI; 'none' restores the default. Takes effect at the squad's next sandbox start"
    )
    .action(async (id, options) => {
      try {
        const updates: Record<string, unknown> = {}

        if (options.name) updates.name = options.name
        if (options.purpose) updates.purpose = options.purpose
        if (options.status) updates.status = options.status
        if (options.maxConcurrentStreams !== undefined) {
          updates.maxConcurrentWorkStreams = parseMaxConcurrentStreams(options.maxConcurrentStreams)
        }
        if (options.blockedGraceMinutes !== undefined) {
          updates.blockedGraceMinutes = parseBlockedGraceMinutes(options.blockedGraceMinutes)
        }
        if (options.hostWorkspacePath !== undefined) {
          updates.hostWorkspacePath = parseHostWorkspacePath(options.hostWorkspacePath)
        }
        if (typeof options.globalCollaboration === 'boolean') {
          updates.globalCollaborationEnabled = options.globalCollaboration
        }
        if (options.typeContext) {
          updates.typeContext = JSON.parse(options.typeContext)
        }
        if (options.context !== undefined) updates.context = options.context

        // Handle default agent modifications
        const addDefault = options.addDefaultAgent
        const removeDefault = options.removeDefaultAgent

        if (addDefault || removeDefault) {
          const current = await apiGet<Squad>(`/api/squads/${id}`)
          let defaultAgents = current.defaultAgents || []

          if (addDefault) {
            defaultAgents = [...defaultAgents, addDefault]
          }
          if (removeDefault) {
            defaultAgents = defaultAgents.filter((t) => t !== removeDefault)
          }

          updates.defaultAgents = defaultAgents
        }

        const squad = await apiPatch<Squad>(`/api/squads/${id}`, updates)
        output(squad, `Updated squad ${squad.id.slice(0, 8)}: ${squad.name}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad delete|rm|archive <id>
  squad
    .command('delete <id>')
    .aliases(['rm', 'archive'])
    .description(
      'Archive a squad (soft-delete; preserves history). Use --delete-workspace to also remove workspace files.'
    )
    .option('--delete-workspace', "Permanently delete the squad's workspace files on disk", false)
    .action(async (id, opts) => {
      try {
        const qs = opts.deleteWorkspace ? '?deleteWorkspace=true' : ''
        await apiDelete(`/api/squads/${id}${qs}`)
        output({ id }, `Archived squad ${id}${opts.deleteWorkspace ? ' (workspace deleted)' : ''}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad workspace <id>
  squad
    .command('workspace <id>')
    .alias('ws')
    .description('Show workspace directory tree')
    .action(async (id) => {
      try {
        const tree = await apiGet<TreeNode>(`/api/squads/${id}/workspace/tree`)

        if (isJsonMode()) {
          output(tree)
        } else {
          printTree(tree)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad file <id> <path>
  squad
    .command('file <id> <path>')
    .alias('cat')
    .description('Show file contents from squad workspace')
    .action(async (id, path) => {
      try {
        const response = await apiGetRaw(`/api/squads/${id}/workspace/file?path=${encodeURIComponent(path)}`)
        const content = await response.text()
        console.log(content)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad workspace-search <id> <query>
  squad
    .command('workspace-search <id> <query>')
    .description('Search files in squad workspace')
    .action(async (id, query) => {
      try {
        const { files } = await apiGet<{ files: string[] }>(
          `/api/squads/${id}/workspace/search?q=${encodeURIComponent(query)}`
        )
        if (isJsonMode()) {
          output(files)
        } else {
          if (!files || files.length === 0) {
            console.log('No results')
            return
          }
          for (const file of files) {
            console.log(file)
          }
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad sandbox-status <id>
  squad
    .command('sandbox-status <id>')
    .description('Get sandbox status for a squad')
    .action(async (id) => {
      try {
        const result = await apiGet<any>(`/api/squads/${id}/sandbox/status`)
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })

  registerSandboxProcessCommands(squad, 'squad')

  // ficus squad link <source> <target> -t <type>
  squad
    .command('link <source> <target>')
    .description('Create relationship between squads')
    .requiredOption('-t, --type <type>', 'Relationship type (reports_to, collaborates, depends_on)')
    .action(async (source, target, options) => {
      const validTypes = ['reports_to', 'collaborates', 'depends_on']
      if (!validTypes.includes(options.type)) {
        console.error(`Invalid relationship type. Must be one of: ${validTypes.join(', ')}`)
        process.exit(1)
      }

      try {
        const rel = await apiPost<SquadRelationship>('/api/squad-relationships', {
          sourceSquadId: source,
          targetSquadId: target,
          relationshipType: options.type,
        })

        if (isJsonMode()) {
          output(rel)
        } else {
          console.log(`Created ${options.type} relationship:`)
          console.log(`  ${source.slice(0, 8)} → ${target.slice(0, 8)}`)
          console.log(`  ID: ${rel.id}`)
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad unlink <relationshipId>
  squad
    .command('unlink <relationshipId>')
    .description('Remove a relationship between squads')
    .action(async (id) => {
      try {
        await apiDelete(`/api/squad-relationships/${id}`)

        if (isJsonMode()) {
          output({ id, deleted: true })
        } else {
          console.log(`Removed relationship ${id}`)
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad relationships <id>
  squad
    .command('relationships <id>')
    .alias('rels')
    .description('List relationships for a squad')
    .action(async (id) => {
      try {
        const rels = await apiGet<SquadRelationships>(`/api/squads/${id}/relationships`)

        if (isJsonMode()) {
          output(rels)
        } else {
          const sections = [
            { label: 'Reports To', data: rels.reportsTo },
            { label: 'Reported By', data: rels.reportedBy },
            { label: 'Collaborates With', data: rels.collaborates },
            { label: 'Depends On', data: rels.dependsOn },
            { label: 'Depended On By', data: rels.dependedOnBy },
          ]

          for (const section of sections) {
            console.log(`${section.label}:`)
            if (section.data.length === 0) {
              console.log('  (none)')
            } else {
              for (const squad of section.data) {
                console.log(`  - ${squad.name} (${squad.id.slice(0, 8)})`)
              }
            }
          }
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad can-communicate <squadA> <squadB>
  squad
    .command('can-communicate <squadA> <squadB>')
    .alias('can-comm')
    .description('Check if two squads can communicate')
    .action(async (squadA, squadB) => {
      try {
        const result = await apiGet<{ canCommunicate: boolean }>(`/api/squads/${squadA}/can-communicate/${squadB}`)

        if (isJsonMode()) {
          output(result)
        } else {
          if (result.canCommunicate) {
            console.log('✓ Squads can communicate (have a relationship)')
          } else {
            console.log('✗ Squads cannot communicate (no relationship)')
          }
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad agents <id>
  squad
    .command('agents <id>')
    .description('List agents in squad')
    .action(async (id) => {
      try {
        const { agents = [] } = await apiGet<{ agents: Agent[] }>(`/api/squads/${id}/agents`)

        if (isJsonMode()) {
          output(agents)
        } else {
          if (agents.length === 0) {
            console.log('No agents in squad')
            return
          }
          outputTable(
            agents.map((a) => ({
              ID: a.id.slice(0, 8),
              Name: a.metadata?.name ?? '',
              Type: a.agentTypeId,
              Status: a.status,
              WorkStream: a.workStreamId?.slice(0, 8) || '-',
            })),
            ['ID', 'Name', 'Type', 'Status', 'WorkStream']
          )
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad search-messages <id> <query> [--limit <n>] [--role <role>]
  squad
    .command('search-messages <id> <query>')
    .alias('grep')
    .description('Search messages across all agents in a squad')
    .option('--limit <n>', 'Max results (default: 20)')
    .option('--role <role>', 'Filter by role (human or assistant)')
    .option('--raw', 'Output full JSON')
    .action(async (id, query, options) => {
      try {
        const params = new URLSearchParams({ q: query })
        if (options.limit) params.set('limit', options.limit)
        if (options.role) params.set('role', options.role)

        const results = await apiGet<any[]>(`/api/squads/${id}/messages/search?${params}`)

        if (options.raw || isJsonMode()) {
          output(results)
        } else {
          if (results.length === 0) {
            console.log('No matches')
            return
          }
          for (const msg of results) {
            const role = msg.role === 'human' ? 'You' : 'Agent'
            const agent = msg.agentName || msg.agentTypeId || msg.agentId?.slice(0, 8)
            const time = new Date(msg.createdAt).toLocaleString()
            const content = msg.content.length > 300 ? msg.content.slice(0, 300) + '…' : msg.content
            console.log(`[${time}] ${role} (${agent} [${msg.agentId.slice(0, 8)}])`)
            console.log(`  ${content.replace(/\n/g, '\n  ')}`)
            console.log()
          }
          console.log(`--- ${results.length} result(s) ---`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad spawn <agentType> <squadId> [--workstream <wsId>]
  squad
    .command('spawn <agentType> <squadId>')
    .description('Spawn an agent in a squad, optionally assigning it to a work stream')
    .option('-w, --workstream <workstreamId>', 'Assign to work stream')
    .option('--model <model>', 'Override model spec for this agent (provider:model-id[:thinking-level])')
    .action(async (agentType, squadId, options) => {
      try {
        const body: {
          agentTypeId: string
          workStreamId?: string
          model?: string
        } = {
          agentTypeId: agentType,
          ...(options.model ? { model: options.model } : {}),
        }

        const agent = await apiPost<Agent>(`/api/squads/${squadId}/spawn`, body)

        let workStream
        if (options.workstream) {
          workStream = await apiPatch<WorkStream>(`/api/workstreams/${options.workstream}`, {
            assigneeAgentId: agent.id,
          })
        }

        if (isJsonMode()) {
          output({
            agent,
            workStream,
          })
        } else {
          console.log(`Spawned ${agent.agentTypeId} agent: ${agent.id.slice(0, 8)}`)
          if (agent.configuredModel) {
            console.log(`  Model: ${agent.configuredModel}`)
          }
          if (workStream) {
            console.log(`  Assigned to work stream: ${workStream.id.slice(0, 8)}`)
          }
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad unspawn <agentId>
  squad
    .command('unspawn <agentId>')
    .description('Terminate a flex agent')
    .action(async (agentId) => {
      try {
        // First get the agent to find its squad
        const agent = await apiGet<Agent>(`/api/agents/${agentId}`)
        if (!agent.squadId) {
          console.error('Agent is not part of a squad')
          process.exit(1)
        }

        await apiDelete(`/api/squads/${agent.squadId}/agents/${agent.id}`)

        if (isJsonMode()) {
          output({ agentId: agent.id, terminated: true })
        } else {
          console.log(`Agent ${agent.id.slice(0, 8)} terminated`)
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad terminate-bulk <squadId> --type <agentTypeId>
  squad
    .command('terminate-bulk <squadId>')
    .description('Terminate all eligible agents of a type in a squad')
    .requiredOption('--type <agentTypeId>', 'Agent type to terminate')
    .action(async (squadId, options) => {
      try {
        const result = await apiPost<BulkTerminateAgentsResult>(`/api/squads/${squadId}/agents/terminate-bulk`, {
          agentTypeId: options.type,
        })

        if (isJsonMode()) {
          output(result)
        } else {
          console.log(
            `Terminated ${result.terminated.length}, deferred ${result.deferred.length}, skipped ${result.skipped.length}`
          )
          if (result.skipped.length > 0) {
            outputTable(
              result.skipped.map((skipped) => ({ id: skipped.id, reason: skipped.reason })),
              ['id', 'reason']
            )
          }
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  const arrayHelp =
    '\nArrays replace the whole array. To change one element, get the array, modify it, then set the entire array key.\n'

  squad
    .command('set-meta <id> <key> <value>')
    .description('Set a metadata field on a squad using a dot path')
    .addHelpText('after', arrayHelp)
    .action(async (id, key, value) => {
      try {
        const updated = await apiPatch<Squad>(`/api/squads/${id}`, {
          metadata: buildMetadataDelta(key, parseMetadataValue(value)),
        })
        output(updated, `Set ${key}=${value} on squad ${id.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  squad
    .command('unset-meta <id> <key>')
    .description('Delete a metadata field from a squad using a dot path')
    .addHelpText('after', arrayHelp)
    .action(async (id, key) => {
      try {
        const updated = await apiPatch<Squad>(`/api/squads/${id}`, { metadata: buildMetadataDelta(key, null) })
        output(updated, `Unset ${key} on squad ${id.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  squad
    .command('get-meta <id> <key>')
    .description('Get a metadata value from a squad using a dot path')
    .addHelpText('after', arrayHelp)
    .action(async (id, key) => {
      try {
        parseMetadataPath(key)
        const sq = await apiGet<Squad>(`/api/squads/${id}`)
        const value = getMetadataValue(sq.metadata ?? {}, key)
        output(isJsonMode() ? value : JSON.stringify(value, null, 2))
      } catch (error) {
        outputError(error as Error)
      }
    })

  // --- SSH Credentials Commands ---
  const ssh = squad.command('ssh').description('Manage SSH credentials for a squad')

  // ficus squad ssh list-keys <squad-id>
  ssh
    .command('list-keys <squadId>')
    .description('List SSH keys for a squad')
    .action(async (squadId) => {
      try {
        const keys = await apiGet<{ name: string; hasPublicKey: boolean; createdAt: string }[]>(
          `/api/squads/ssh/${squadId}/keys`
        )
        if (isJsonMode()) {
          output(keys)
        } else if (keys.length === 0) {
          console.log('No SSH keys configured')
        } else {
          outputTable(keys, ['name', 'hasPublicKey', 'createdAt'])
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad ssh add-key <squad-id> <key-name> --private-key <path> [--public-key <path>]
  ssh
    .command('add-key <squadId> <keyName>')
    .description('Add an SSH key to a squad')
    .requiredOption('--private-key <path>', 'Path to private key file')
    .option('--public-key <path>', 'Path to public key file')
    .action(async (squadId, keyName, options) => {
      try {
        const fs = await import('fs')
        const privateKey = fs.readFileSync(options.privateKey, 'utf-8')
        const publicKey = options.publicKey ? fs.readFileSync(options.publicKey, 'utf-8') : undefined

        await apiPost(`/api/squads/ssh/${squadId}/keys`, {
          name: keyName,
          privateKey,
          publicKey,
        })

        if (isJsonMode()) {
          output({ success: true, keyName })
        } else {
          console.log(`Added SSH key "${keyName}" to squad ${squadId.slice(0, 8)}`)
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad ssh remove-key <squad-id> <key-name>
  ssh
    .command('remove-key <squadId> <keyName>')
    .description('Remove an SSH key from a squad')
    .action(async (squadId, keyName) => {
      try {
        await apiDelete(`/api/squads/ssh/${squadId}/keys/${keyName}`)
        if (isJsonMode()) {
          output({ success: true })
        } else {
          console.log(`Removed SSH key "${keyName}" from squad ${squadId.slice(0, 8)}`)
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad ssh get-public-key <squad-id> <key-name>
  ssh
    .command('get-public-key <squadId> <keyName>')
    .description('Get the public key for an SSH key')
    .action(async (squadId, keyName) => {
      try {
        const result = await apiGet<{ publicKey: string }>(`/api/squads/ssh/${squadId}/keys/${keyName}/public`)
        if (isJsonMode()) {
          output(result)
        } else {
          console.log(result.publicKey)
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad ssh set-config <squad-id> --file <path>
  ssh
    .command('set-config <squadId>')
    .description('Set SSH config for a squad')
    .requiredOption('--file <path>', 'Path to SSH config file')
    .action(async (squadId, options) => {
      try {
        const fs = await import('fs')
        const config = fs.readFileSync(options.file, 'utf-8')

        await apiPut(`/api/squads/ssh/${squadId}/config`, { config })

        if (isJsonMode()) {
          output({ success: true })
        } else {
          console.log(`Set SSH config for squad ${squadId.slice(0, 8)}`)
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad ssh get-config <squad-id>
  ssh
    .command('get-config <squadId>')
    .description('Get SSH config for a squad')
    .action(async (squadId) => {
      try {
        const result = await apiGet<{ config: string | null }>(`/api/squads/ssh/${squadId}/config`)
        if (isJsonMode()) {
          output(result)
        } else if (result.config) {
          console.log(result.config)
        } else {
          console.log('No SSH config set')
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad ssh add-known-host <squad-id> <host-entry>
  ssh
    .command('add-known-host <squadId> <hostEntry>')
    .description('Add a host entry to known_hosts')
    .action(async (squadId, hostEntry) => {
      try {
        await apiPost(`/api/squads/ssh/${squadId}/known-hosts`, { host: hostEntry })
        if (isJsonMode()) {
          output({ success: true })
        } else {
          console.log(`Added known host entry to squad ${squadId.slice(0, 8)}`)
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad ssh list-known-hosts <squad-id>
  ssh
    .command('list-known-hosts <squadId>')
    .description('List known hosts for a squad')
    .action(async (squadId) => {
      try {
        const result = await apiGet<{ knownHosts: string[] }>(`/api/squads/ssh/${squadId}/known-hosts`)
        if (isJsonMode()) {
          output(result)
        } else if (result.knownHosts && result.knownHosts.length > 0) {
          for (const host of result.knownHosts) {
            console.log(host)
          }
        } else {
          console.log('No known hosts configured')
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad ssh generate-key <squad-id> <key-name> [--type ed25519|rsa]
  ssh
    .command('generate-key <squadId> <keyName>')
    .description('Generate a new SSH key pair for a squad')
    .option('--type <type>', 'Key type (ed25519 or rsa)', 'ed25519')
    .action(async (squadId, keyName, options) => {
      try {
        const fs = await import('fs')
        const os = await import('os')
        const path = await import('path')
        const { spawnSync } = await import('child_process')

        // Generate key pair in temp directory
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-ssh-'))
        const keyPath = path.join(tmpDir, keyName)

        const result = spawnSync(
          'ssh-keygen',
          ['-t', options.type, '-f', keyPath, '-N', '', '-C', `tau-squad-${squadId}`],
          {
            stdio: 'inherit',
          }
        )

        if (result.status !== 0) {
          throw new Error('ssh-keygen failed')
        }

        const privateKey = fs.readFileSync(keyPath, 'utf-8')
        const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf-8')

        await apiPost(`/api/squads/ssh/${squadId}/keys`, {
          name: keyName,
          privateKey,
          publicKey,
        })

        // Clean up temp files
        fs.rmSync(tmpDir, { recursive: true })

        if (isJsonMode()) {
          output({ success: true, keyName, publicKey })
        } else {
          console.log(`Generated and added SSH key "${keyName}" to squad ${squadId.slice(0, 8)}`)
          console.log(`\nPublic key (add to your Git provider):\n${publicKey}`)
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // ficus squad cleanup-agents
  squad
    .command('cleanup-agents')
    .description('Terminate eligible flex agents (those with all work streams done)')
    .option('--dry-run', 'Show agents that would be terminated without actually terminating')
    .action(async (options) => {
      try {
        const url = options.dryRun ? '/api/squads/cleanup-agents?dryRun=true' : '/api/squads/cleanup-agents'
        const result = await apiPost<{
          checked: number
          terminated: number
          agents: Array<{ id: string; name: string | null; agentTypeId: string; squadName: string | null }>
        }>(url, {})

        if (isJsonMode()) {
          output(result)
        } else if (options.dryRun) {
          console.log(
            `[Dry run] Would terminate ${result.terminated} of ${result.checked} flex agents${result.agents.length > 0 ? `:` : ''}`
          )
          if (result.agents.length > 0) {
            outputTable(
              result.agents.map((a) => ({
                id: a.id.slice(0, 8),
                name: a.name ?? '-',
                type: a.agentTypeId,
                squad: a.squadName ?? '-',
              })),
              ['id', 'name', 'type', 'squad']
            )
          }
        } else {
          console.log(
            `Checked ${result.checked} flex agents, terminated ${result.terminated}${result.agents.length > 0 ? `:` : ''}`
          )
          if (result.agents.length > 0) {
            outputTable(
              result.agents.map((a) => ({
                id: a.id.slice(0, 8),
                name: a.name ?? '-',
                type: a.agentTypeId,
                squad: a.squadName ?? '-',
              })),
              ['id', 'name', 'type', 'squad']
            )
          }
        }
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  // --- Squad attention (what this squad's decisions and progress do in your Action Center and push) ---

  // ficus squad subscription <id>
  squad
    .command('subscription <id>')
    .description('Show your attention levels for this squad, and the watcher count')
    .action(async (id) => {
      try {
        const sub = await apiGet<SubscriptionResponse>(`/api/squads/${id}/subscription`)
        output(
          sub,
          `Watching: ${sub.subscribed ? 'yes' : 'no'} (${sub.count} watcher(s)) — ${describeAttention(sub.attention)}`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad subscribe <id> [--decisions <level>] [--progress <level>]
  squad
    .command('subscribe <id>')
    .alias('watch')
    .description('Watch a squad. Levels: mute (hidden), show (listed), notify (inbox + push)')
    .option('--decisions <level>', 'Questions, reviews, and blockers: mute, show, or notify')
    .option('--progress <level>', 'Active work and completions: mute, show, or notify')
    .action(async (id, options) => {
      try {
        const sub = await performAttentionSubscribe({
          apiGet,
          apiPost,
          subscriptionPath: `/api/squads/${id}/subscription`,
          subscribePath: `/api/squads/${id}/subscribe`,
          flags: options,
        })
        output(sub, `Watching squad ${id.slice(0, 8)} (${sub.count} watcher(s)) — ${describeAttention(sub.attention)}`)
      } catch (error) {
        outputError(error as Error)
        // outputError is a no-op under the test mock (see test-setup.ts) and calls
        // process.exit in production; rethrow so tests can observe the rejection.
        throw error
      }
    })

  // ficus squad unsubscribe <id>
  squad
    .command('unsubscribe <id>')
    .alias('unwatch')
    .description('Stop watching a squad (back to the default: listed, never notified)')
    .action(async (id) => {
      try {
        const sub = await apiDelete<SubscriptionResponse>(`/api/squads/${id}/subscribe`)
        output(sub, `Unwatched squad ${id.slice(0, 8)} (${sub.count} watcher(s))`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  registerSquadGrantCommands(squad)
}
