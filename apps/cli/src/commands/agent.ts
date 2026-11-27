import { manualWaitDecisionSchema } from '@ficus/shared'
import { addStructuredInputOptions, readStructuredInput, validateStructuredInput } from '../structured-input'
import { Command } from 'commander'
import { apiGet, apiPatch, apiPost, apiDelete } from '../client'
import { explainDormantRecipient, WAKE_OPTION_DESCRIPTION } from '../dormant-agent'
import { output, outputTable, outputError, isJsonMode } from '../output'
import { readLine, StdinClosedError } from '../local-server/prompt'
import { registerSandboxProcessCommands } from './sandbox-processes'
import { parseSearchScope, registerAgentSearchCommand } from './agent-search'

function truncate(s: string, max: number): string {
  if (!s) return ''
  const oneLine = s.replace(/\n/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value])
}

export function registerAgentCommands(program: Command) {
  const agent = program.command('agent').description('Manage agents')

  addStructuredInputOptions(
    agent
      .command('recovery <id> <recoveryId>')
      .description('Resolve a standalone runtime recovery with a typed, versioned decision')
  ).action(async (id: string, recoveryId: string, options) => {
    try {
      const decision = validateStructuredInput(manualWaitDecisionSchema, await readStructuredInput(options))
      output(
        await apiPost(
          `/api/agents/${encodeURIComponent(id)}/recoveries/${encodeURIComponent(recoveryId)}/input`,
          decision
        )
      )
    } catch (error) {
      outputError(error as Error)
    }
  })

  // ficus agent list [--type <agentTypeId>] [--status <status>] [--orphaned] [--older-than <duration>]
  agent
    .command('list')
    .description('List agents')
    .option('-t, --type <agentTypeId>', 'Filter by agent type')
    .option('-s, --status <status>', 'Filter by status')
    .option('--scope <scopeType>', 'Filter by scope type')
    .option('--scope-id <scopeId>', 'Filter by scope ID')
    .option('--task <taskId>', 'Filter by task ID')
    .option('--orphaned', 'List only orphaned agents (no squad assignment)')
    .option('--older-than <duration>', 'Filter by age (e.g. 7d, 24h, 30m)')
    .action(async (options) => {
      try {
        const params = new URLSearchParams()
        if (options.type) params.set('agentTypeId', options.type)
        if (options.status) params.set('status', options.status)
        if (options.scope) params.set('scopeType', options.scope)
        if (options.scopeId) params.set('scopeId', options.scopeId)
        if (options.task) params.set('taskId', options.task)
        if (options.orphaned) params.set('orphaned', 'true')
        if (options.olderThan) params.set('olderThan', options.olderThan)
        const url = params.toString() ? `/api/agents?${params}` : '/api/agents'
        const agents = await apiGet<any[]>(url)
        const rows = agents.map((a) => ({ ...a, name: a.metadata?.name ?? '' }))
        if (options.orphaned) {
          outputTable(rows, ['id', 'name', 'agentTypeId', 'status', 'createdAt', 'terminatedAt'])
        } else {
          outputTable(rows, ['id', 'name', 'agentTypeId', 'status', 'configuredModel', 'updatedAt'])
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent get <id>
  agent
    .command('get <id>')
    .alias('info')
    .description('Get agent details')
    .action(async (id) => {
      try {
        const a = await apiGet<any>(`/api/agents/${id}`)
        output(a)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent sandbox-status <id>
  agent
    .command('sandbox-status <id>')
    .description("Get live sandbox status for an agent's individual sandbox")
    .action(async (id) => {
      try {
        const result = await apiGet<any>(`/api/agents/${id}/sandbox/status`)
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })

  registerSandboxProcessCommands(agent, 'agent')

  // ficus agent rename <id> <name>
  agent
    .command('rename <id> <name>')
    .description('Rename an agent')
    .action(async (id, name) => {
      try {
        const result = await apiPatch<any>(`/api/agents/${id}`, { name })
        output(result, `Renamed agent ${id} to "${name}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent persist <id> <true|false>
  agent
    .command('persist <id> <value>')
    .description("Set an agent's persist flag (must be false before unspawn)")
    .action(async (id, value) => {
      try {
        const normalized = String(value).toLowerCase()
        const persist = normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y'

        const result = await apiPatch<any>(`/api/agents/${id}`, { persist })
        output(result, `Set persist=${persist} for agent ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent model <id> [spec] [--tier <slug>] [--clear] [--now]
  agent
    .command('model <id> [spec]')
    .description(
      "Override the model an agent runs (e.g. 'openai:gpt-5.5:high'; comma-separated for a fallback priority list), or with --tier make it follow a model tier's current chain. An agent has one override at most: setting a model clears its tier and vice versa. --clear removes both, so the agent runs its workflow participant's or agent type's model again. Changes apply from the agent's next turn; add --now to switch a running agent immediately."
    )
    .option('-t, --tier <slug>', "Follow this model tier's chain (clears any model override)")
    .option('-c, --clear', "Clear the model and tier overrides; the agent's workflow or agent type model applies")
    .option('--now', 'Switch to the configured model now instead of from the next turn')
    .action(async (id, spec, options) => {
      try {
        if (spec && options.tier) {
          outputError(new Error('Set either a model spec or --tier, not both'))
          return
        }
        if (options.clear && (spec || options.tier)) {
          outputError(new Error('Cannot combine --clear with a model spec or --tier'))
          return
        }
        let body: Record<string, string | null> | undefined
        let message = ''
        if (options.clear) {
          body = { modelOverride: null, tierOverride: null }
          message = `Cleared model and tier overrides for agent ${id}`
        } else if (options.tier) {
          body = { tierOverride: options.tier }
          message = `Set tier override for agent ${id} to ${options.tier}`
        } else if (spec) {
          body = { modelOverride: spec }
          message = `Set model override for agent ${id} to ${spec}`
        } else if (!options.now) {
          outputError(
            new Error('A model spec or --tier is required (or use --clear to remove overrides, or --now to apply)')
          )
          return
        }
        const updated = body ? await apiPatch<any>(`/api/agents/${id}`, body) : undefined
        if (!options.now) {
          output(updated, `${message}; applies from its next turn`)
          return
        }
        const applied = await apiPost<{ code: string; message: string }>(`/api/agents/${id}/model/apply`, {})
        output(
          updated ? { agent: updated, apply: applied } : applied,
          [message, applied.message].filter(Boolean).join('. ')
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent active <id>
  agent
    .command('active <id>')
    .description('Get active execution for an agent')
    .action(async (id) => {
      try {
        const result = await apiGet<any>(`/api/agents/${id}/active`)
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent executions <id>
  agent
    .command('executions <id>')
    .description('List executions for an agent')
    .action(async (id) => {
      try {
        const executions = await apiGet<any[]>(`/api/agents/${id}/executions`)
        outputTable(executions, ['id', 'status', 'startedAt', 'endedAt'])
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent messages <id> [options]
  agent
    .command('messages <id>')
    .description(
      'Show conversation messages for an agent. With --raw and the global --json, each human chat message carries metadata.sender: userId is the stable address, name is for display only.'
    )
    .option('--raw', 'Output full JSON including metadata (metadata.sender names who sent a human message)')
    .option('--last <n>', 'Shortcut for --limit (show last N messages)')
    .option('--limit <n>', 'Max messages to return')
    .option('--offset <n>', 'Offset for pagination')
    .option('--before <timestamp>', 'Only messages before this ISO timestamp')
    .option('--after <timestamp>', 'Only messages after this ISO timestamp')
    .option(
      '--search <term>',
      'Only messages containing this case-insensitive, literal text (%, _ and \\ match themselves). For snippets, tool output and context use `ficus agent search`'
    )
    .option(
      '--in <scope>',
      'Where --search looks: text (default, the message text), tools (tool calls and results), or all'
    )
    .option('--role <role>', 'Filter by role (human or assistant)')
    .action(async (id, options) => {
      try {
        const scope = parseSearchScope(options.in, 'text')
        const params = new URLSearchParams()
        // --last is a shortcut for --limit
        const limit = options.limit || options.last
        if (limit) params.set('limit', limit)
        if (options.offset) params.set('offset', options.offset)
        if (options.before) params.set('before', options.before)
        if (options.after) params.set('after', options.after)
        if (options.search) params.set('search', options.search)
        if (options.search && scope !== 'text') params.set('in', scope)
        if (options.role) params.set('role', options.role)
        const query = params.toString() ? `?${params}` : ''
        const result = await apiGet<{ messages: any[]; pagination: any }>(`/api/agents/${id}/messages${query}`)
        const messages = result.messages
        if (options.raw) {
          output(result)
        } else {
          if (messages.length === 0) {
            console.log('No messages')
            return
          }
          for (const msg of messages) {
            const role = msg.role === 'human' ? 'You' : 'Agent'
            const time = new Date(msg.createdAt).toLocaleString()
            console.log(`[${role}] (${time})`)
            console.log(`${msg.content}\n`)
          }
          if (options.search && typeof result.pagination?.totalCount === 'number' && !options.offset) {
            console.log(`--- Showing ${messages.length} of ${result.pagination.totalCount} matching message(s) ---`)
          } else if (limit) {
            console.log(`--- Showing ${messages.length} message(s) ---`)
          }
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  registerAgentSearchCommand(agent)

  // ficus agent worker-log <id> [options] — condensed activity log
  agent
    .command('worker-log <id>')
    .description('Show condensed activity log for an agent (tool calls and key actions)')
    .option('--last <n>', 'Shortcut for --limit (show last N messages)')
    .option('--limit <n>', 'Max messages to return')
    .option('--before <timestamp>', 'Only messages before this ISO timestamp')
    .option('--after <timestamp>', 'Only messages after this ISO timestamp')
    .option(
      '--search <term>',
      'Only messages whose text or tool calls (names, arguments, results) contain this case-insensitive, literal text'
    )
    .option('--tools-only', 'Show only tool calls (no text responses)')
    .option('--raw', 'Output full JSON including metadata')
    .action(async (id, options) => {
      try {
        const params = new URLSearchParams()
        params.set('role', 'assistant') // worker-log focuses on agent output
        // --last is a shortcut for --limit
        const limit = options.limit || options.last
        if (limit) params.set('limit', limit)
        if (options.before) params.set('before', options.before)
        if (options.after) params.set('after', options.after)
        if (options.search) {
          params.set('search', options.search)
          params.set('in', 'all')
        }
        params.set('count', 'false') // worker-log never shows totalCount
        const query = `?${params}`
        const result = await apiGet<{ messages: any[]; pagination: any }>(`/api/agents/${id}/messages${query}`)
        const messages = result.messages

        if (options.raw) {
          output(messages)
          return
        }

        if (messages.length === 0) {
          console.log('No activity')
          return
        }

        const agentInfo = await apiGet<any>(`/api/agents/${id}`)
        const name = agentInfo.metadata?.name || agentInfo.agentTypeId
        console.log(`=== Worker Log: ${name} [${id.slice(0, 8)}] ===\n`)

        for (const msg of messages) {
          const time = new Date(msg.createdAt).toLocaleString()
          const blocks = msg.metadata?.content as any[] | undefined

          if (blocks && blocks.length > 0) {
            for (const block of blocks) {
              if (block.type === 'tool_use') {
                const tool = block.toolCall
                const result = tool.result
                  ? tool.isError
                    ? `ERROR: ${truncate(tool.result, 200)}`
                    : truncate(tool.result, 300)
                  : '(no result)'
                console.log(`[${time}] 🔧 ${tool.toolName ?? tool.name}`)
                console.log(`  args: ${truncate(tool.args, 200)}`)
                console.log(`  result: ${result}`)
                console.log()
              } else if (block.type === 'text' && !options.toolsOnly) {
                console.log(`[${time}] 💬 ${truncate(block.content, 300)}`)
                console.log()
              }
            }
          } else if (!options.toolsOnly) {
            // No metadata blocks — show plain content
            console.log(`[${time}] 💬 ${truncate(msg.content, 300)}`)
            console.log()
          }
        }

        console.log(`--- ${messages.length} message(s) ---`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent message <id> <content> [--follow-up] [--image <imageId>...]
  agent
    .command('message <id> <content>')
    .description('Send a message to an agent (a dormant agent is refused unless you pass --wake)')
    .option('--follow-up', 'If agent is running, queue for after current turn (default: interrupt)')
    .option('--image <imageId>', 'Attach image ID (can be repeated)', collect, [])
    .option('--wake', WAKE_OPTION_DESCRIPTION)
    .action(async (id, content, options) => {
      try {
        const body: Record<string, unknown> = { content }
        if (options.followUp) body.deliveryMode = 'follow-up'
        if (options.image.length) body.imageIds = options.image
        if (options.wake) body.wake = true
        const result = await apiPost<any>(`/api/agents/${id}/message`, body)
        output(result, `Message sent to agent ${id}`)
      } catch (error) {
        outputError((await explainDormantRecipient(error, id)) as Error)
      }
    })

  // ficus agent stop <id>
  agent
    .command('stop <id>')
    .description('Stop the active execution')
    .action(async (id) => {
      try {
        await apiPost(`/api/agents/${id}/stop`)
        output({ id }, `Stopped agent ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent force-stop <id> [--reason <reason>]
  agent
    .command('force-stop <id>')
    .description('Forcibly terminate a stuck execution (use when stop fails)')
    .option('-r, --reason <reason>', 'Reason for force-stopping')
    .action(async (id, options) => {
      try {
        const body: Record<string, unknown> = {}
        if (options.reason) body.reason = options.reason
        await apiPost(`/api/agents/${id}/force-stop`, body)
        output({ id }, `Force-stopped agent ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent abort-tool <id>
  agent
    .command('abort-tool <id>')
    .description('Abort the currently running tool')
    .action(async (id) => {
      try {
        await apiPost(`/api/agents/${id}/abort-tool`)
        output({ id }, `Aborted tool for agent ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent compact <id> [--instructions <text>]
  agent
    .command('compact <id>')
    .description('Trigger manual context compaction for an idle agent')
    .option('-i, --instructions <text>', 'Custom instructions for the compaction summary')
    .action(async (id, options) => {
      try {
        const body: Record<string, unknown> = {}
        if (options.instructions) body.instructions = options.instructions

        await apiPost(`/api/agents/${id}/compact`, body)
        output({ id }, `Compaction completed for agent ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent steer <id> <message>
  agent
    .command('steer <id> <message>')
    .description(
      'Interrupt a running agent with a message (delivered after current tool; a dormant agent needs --wake)'
    )
    .option('--wake', WAKE_OPTION_DESCRIPTION)
    .action(async (id, message, options) => {
      try {
        await apiPost(`/api/agents/${id}/steer`, { message, ...(options.wake ? { wake: true } : {}) })
        output({ id }, `Sent steering message to agent ${id}`)
      } catch (error) {
        outputError((await explainDormantRecipient(error, id)) as Error)
      }
    })

  // ficus agent follow-up <id> <message>
  agent
    .command('follow-up <id> <message>')
    .description('Queue a message for after the agent finishes its current turn (a dormant agent needs --wake)')
    .option('--wake', WAKE_OPTION_DESCRIPTION)
    .action(async (id, message, options) => {
      try {
        await apiPost(`/api/agents/${id}/follow-up`, { message, ...(options.wake ? { wake: true } : {}) })
        output({ id }, `Queued follow-up message for agent ${id}`)
      } catch (error) {
        outputError((await explainDormantRecipient(error, id)) as Error)
      }
    })

  // ficus agent reset <id>
  agent
    .command('reset <id>')
    .description('Reset agent session history (only works on idle agents)')
    .action(async (id) => {
      try {
        await apiPost(`/api/agents/${id}/reset`)
        output({ id }, `Reset session history for agent ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent context <id>
  agent
    .command('context <id>')
    .description("Get agent's working context (short-term memory, todos, etc.)")
    .action(async (id) => {
      try {
        const result = await apiGet<any>(`/api/agents/${id}/context`)
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent delete <id>
  agent
    .command('delete <id>')
    .alias('rm')
    .description('Delete an agent')
    .action(async (id) => {
      try {
        await apiDelete(`/api/agents/${id}`)
        output({ id }, `Deleted agent ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent clear-queue <id>
  agent
    .command('clear-queue <id>')
    .description('Clear all pending steer/follow-up messages for an agent')
    .action(async (id) => {
      try {
        await apiPost(`/api/agents/${id}/clear-queue`)
        output({ id }, `Cleared pending messages for agent ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent prune --orphaned — bulk delete orphaned agents
  agent
    .command('prune')
    .description('Bulk delete orphaned agents')
    .option('--orphaned', 'Delete orphaned agents (required)')
    .option('-t, --type <agentTypeId>', 'Filter by agent type')
    .option('--older-than <duration>', 'Only delete agents older than duration (e.g. 7d, 24h)')
    .option('--force', 'Skip confirmation prompt')
    .option('--dry-run', 'Show what would be deleted without actually deleting')
    .action(async (options) => {
      try {
        if (!options.orphaned) {
          console.error('Error: --orphaned flag is required for safety')
          console.error('Usage: ficus agent prune --orphaned [--older-than 7d] [--force]')
          process.exit(1)
        }

        // Fetch orphaned agents
        const params = new URLSearchParams()
        params.set('orphaned', 'true')
        if (options.type) params.set('agentTypeId', options.type)
        if (options.olderThan) params.set('olderThan', options.olderThan)

        const agents = await apiGet<any[]>(`/api/agents?${params}`)

        if (agents.length === 0) {
          console.log('No orphaned agents found matching criteria')
          return
        }

        // Display what will be deleted
        console.log(`Found ${agents.length} orphaned agent(s) to prune:\n`)
        const rows = agents.map((a) => ({
          id: a.id.slice(0, 8),
          name: a.metadata?.name ?? '',
          type: a.agentTypeId,
          created: new Date(a.createdAt).toLocaleDateString(),
        }))
        outputTable(rows, ['id', 'name', 'type', 'created'])

        if (options.dryRun) {
          console.log('\n[Dry run] No agents were deleted')
          return
        }

        // Confirm unless --force
        if (!options.force && !isJsonMode()) {
          const confirmed = await promptConfirm(`Delete ${agents.length} agent(s)?`)
          if (!confirmed) {
            console.log('Aborted')
            return
          }
        }

        // Delete agents
        let deleted = 0
        let failed = 0
        for (const agent of agents) {
          try {
            await apiDelete(`/api/agents/${agent.id}`)
            deleted++
          } catch (err) {
            failed++
            if (!isJsonMode()) {
              console.error(`Failed to delete ${agent.id.slice(0, 8)}: ${(err as Error).message}`)
            }
          }
        }

        if (isJsonMode()) {
          output({ deleted, failed, total: agents.length })
        } else {
          console.log(`\nDeleted ${deleted} agent(s)${failed > 0 ? `, ${failed} failed` : ''}`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent continue <id> — resume a single agent halted by a provider/rate-limit error
  agent
    .command('continue <id>')
    .description('Resume an agent halted by a provider/rate-limit error')
    .action(async (id) => {
      try {
        const result = await apiPost<{ resumed: boolean }>(`/api/agents/${id}/continue`)
        output(result, result.resumed ? `Resumed agent ${id.slice(0, 8)}` : `Agent ${id.slice(0, 8)} was not halted`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  const scope = agent.command('scope').description('Manage per-agent extra permission scopes')

  scope
    .command('list <id>')
    .description('List extra scopes granted to an agent')
    .action(async (id) => {
      try {
        const { scopes } = await apiGet<{ scopes: { permission: string; createdAt: string }[] }>(
          `/api/agents/${id}/scopes`
        )
        outputTable(scopes, ['permission', 'createdAt'])
      } catch (error) {
        outputError(error as Error)
      }
    })

  scope
    .command('grant <id> <permission>')
    .description('Grant an extra permission to an agent (admin only)')
    .action(async (id, permission) => {
      try {
        await apiPost(`/api/agents/${id}/scopes`, { permission })
        output({ granted: permission, to: id }, `Granted ${permission} to agent ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  scope
    .command('revoke <id> <permission>')
    .alias('rm')
    .description('Revoke an extra permission from an agent (admin only)')
    .action(async (id, permission) => {
      try {
        await apiDelete(`/api/agents/${id}/scopes/${encodeURIComponent(permission)}`)
        output({ revoked: permission, from: id }, `Revoked ${permission} from agent ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent continue-halted — bulk-resume every halted agent you can run (after a provider recovers)
  agent
    .command('continue-halted')
    .description('Resume every error-halted agent you can run (use after a provider recovers)')
    .action(async () => {
      try {
        const result = await apiPost<{ resumed: number }>(`/api/agents/continue-halted`)
        output(result, `Resumed ${result.resumed} halted agent(s)`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}

/**
 * Prompt for yes/no confirmation from the user. End-of-input counts as no.
 * readLine, not readline: see its note on Bun, kqueue and /dev/tty.
 */
async function promptConfirm(question: string): Promise<boolean> {
  let answer: string
  try {
    answer = readLine(`${question} [y/N] `, 1).trim().toLowerCase()
  } catch (error) {
    // No one left to answer is a no; a failing terminal is an error, not a decline.
    if (error instanceof StdinClosedError) return false
    throw error
  }
  return answer === 'y' || answer === 'yes'
}
