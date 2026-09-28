import { addStructuredInputOptions, readWorkflowSource } from '../structured-input'
import { Command } from 'commander'
import { apiGet, apiPost, apiPatch, apiDelete } from '../client'
import { output, outputTable, outputError, isJsonMode } from '../output'
import { workflowSourceSchema } from '@ficus/shared'

interface Schedule {
  id: string
  scopeType: 'squad' | 'agent'
  scopeId: string
  name: string
  enabled: boolean
  schedule: { interval?: string; cron?: string; runAt?: string; skipIfUnresolved?: boolean; expiresAt?: string }
  action: { type: string; [key: string]: unknown }
  triggerCount: number
  lastTriggeredAt: string | null
  lastSkippedAt: string | null
  skipCount: number
  lastWebhookTriggerAt: string | null
  nextTriggerAt: string | null
  webhookEnabled: boolean
  healthStatus: 'never_run' | 'healthy' | 'failing' | 'automatically_disabled'
  failureCount: number
  consecutiveFailureCount: number
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastRecoveredAt: string | null
  lastErrorCode: string | null
  lastErrorSummary: string | null
  automaticallyDisabledAt: string | null
  automaticDisableReason: string | null
  createdAt: string
}

function healthLabel(status: Schedule['healthStatus']): string {
  return (
    {
      never_run: 'Never run',
      healthy: 'Healthy',
      failing: 'Failing',
      automatically_disabled: 'Automatically disabled',
    } as const
  )[status]
}

function getScheduleWorkflow(action: Schedule['action']): string {
  if (action.type === 'spawn_agent' && action.workStream) return 'Legacy configuration — choose a workflow'
  if (action.type !== 'create_work_stream') return '-'
  if (action.workflow) {
    const source = workflowSourceSchema.parse(action.workflow)
    return source.kind === 'preset' ? source.id : source.definition.name
  }
  if (action.completionMode || action.agentTypes || action.agentIds || action.assigneeAgentId)
    return 'Legacy configuration — choose a workflow'
  return 'Squad default'
}

interface WebhookEnableResult {
  webhookEnabled: boolean
  token: string
  webhookUrl: string
}

export function registerScheduleCommands(program: Command) {
  const sched = program.command('schedule').description('Manage schedules')

  // ficus schedule list
  sched
    .command('list')
    .description('List schedules')
    .option('--squad <id>', 'Filter by squad')
    .option('--agent <id>', 'Filter by agent')
    .option('--enabled', 'Only enabled')
    .option('--disabled', 'Only disabled')
    .action(async (options) => {
      try {
        const params = new URLSearchParams()
        if (options.squad) {
          params.set('scopeType', 'squad')
          params.set('scopeId', options.squad)
        }
        if (options.agent) {
          params.set('scopeType', 'agent')
          params.set('scopeId', options.agent)
        }
        if (options.enabled) params.set('enabled', 'true')
        if (options.disabled) params.set('enabled', 'false')

        const query = params.toString()
        const schedules = await apiGet<Schedule[]>(`/api/schedules${query ? `?${query}` : ''}`)

        if (isJsonMode()) {
          output(schedules)
        } else {
          if (schedules.length === 0) {
            console.log('No schedules found')
            return
          }
          outputTable(
            schedules.map((s) => ({
              ID: s.id.slice(0, 8),
              Name: s.name.slice(0, 25) + (s.name.length > 25 ? '...' : ''),
              Scope: `${s.scopeType}:${s.scopeId.slice(0, 8)}`,
              Action: s.action.type,
              Workflow: getScheduleWorkflow(s.action),
              Enabled: s.enabled ? '✓' : '✗',
              Health: healthLabel(s.healthStatus),
              Attempts: s.triggerCount,
              Skips: s.skipCount,
            })),
            ['ID', 'Name', 'Scope', 'Action', 'Workflow', 'Enabled', 'Health', 'Attempts', 'Skips']
          )
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus schedule create
  addStructuredInputOptions(sched.command('create'), true)
    .description('Create a schedule')
    .option('--squad <id>', 'Squad scope')
    .option('--agent <id>', 'Agent scope')
    .requiredOption('--name <name>', 'Schedule name')
    .option('--interval <interval>', 'Interval (e.g., 15m, 1h)')
    .option('--cron <expr>', 'Five-field cron expression (e.g., "15 * * * *" for hourly at minute 15)')
    .option('--run-at <datetime>', 'One-shot datetime (ISO)')
    .option('--expires-at <datetime>', 'Optional expiration datetime (ISO-8601 with timezone)')
    .option('--webhook-only', 'Create webhook-only schedule (no time trigger)')
    .option(
      '--skip-if-unresolved',
      'Skip recurring trigger if prior work from this schedule is still open (default for work-stream actions)'
    )
    .option('--no-skip-if-unresolved', 'Disable default skip-if-unresolved policy for work-stream actions')
    .option('--disabled', 'Create as disabled')
    .requiredOption('--action <type>', 'Action type: inbox_message, spawn_agent, create_work_stream')
    // inbox_message options
    .option('--target-agent <id>', 'Target agent ID')
    .option('--target-manager', 'Target squad manager')
    .option('--subject <subject>', 'Message subject')
    .option('--content <content>', 'Message content')
    // spawn_agent options
    .option('--agent-type <type>', 'Agent type to spawn')
    .option('--prompt <prompt>', 'Prompt for spawned agent')
    // create_work_stream options
    .option('--title <title>', 'Work stream title')
    .option('--description <desc>', 'Work stream description')
    .option('--handoff-message <msg>', 'Handoff message')
    .option('--workflow <id>', 'Workflow override; otherwise inherit the squad default')
    .action(async (options) => {
      try {
        // Validate scope
        if (!options.squad && !options.agent) {
          console.error('Error: Must specify --squad or --agent')
          process.exit(1)
        }
        if (options.squad && options.agent) {
          console.error('Error: Cannot specify both --squad and --agent')
          process.exit(1)
        }

        const scopeType = options.squad ? 'squad' : 'agent'
        const scopeId = options.squad || options.agent

        // Build schedule config
        const schedule: Record<string, string | boolean> = {}
        if (options.interval) schedule.interval = options.interval
        if (options.cron) schedule.cron = options.cron
        if (options.runAt) schedule.runAt = options.runAt
        if (options.expiresAt) schedule.expiresAt = options.expiresAt
        if (options.skipIfUnresolved === false) schedule.skipIfUnresolved = false
        if (options.skipIfUnresolved === true) schedule.skipIfUnresolved = true

        const hasTiming = Boolean(options.interval || options.cron || options.runAt)
        if (!hasTiming && !options.webhookOnly) {
          console.error('Error: Must specify --interval, --cron, --run-at, or --webhook-only')
          process.exit(1)
        }

        // Build action
        const workflow = await readWorkflowSource(options)
        let action: Record<string, unknown>
        switch (options.action) {
          case 'inbox_message':
            if (workflow) throw new Error('Workflow input flags require create_work_stream')
            if (!options.targetAgent && !options.targetManager) {
              console.error('Error: inbox_message requires --target-agent or --target-manager')
              process.exit(1)
            }
            if (!options.content) {
              console.error('Error: inbox_message requires --content')
              process.exit(1)
            }
            action = {
              type: 'inbox_message',
              target: options.targetManager
                ? { type: 'squad_manager' }
                : { type: 'agent', agentId: options.targetAgent },
              subject: options.subject,
              content: options.content,
            }
            break

          case 'spawn_agent':
            if (workflow || options.title) throw new Error('Use --action create_work_stream to schedule a flow')
            if (!options.agentType || !options.prompt) {
              console.error('Error: spawn_agent requires --agent-type and --prompt')
              process.exit(1)
            }
            action = {
              type: 'spawn_agent',
              agentTypeId: options.agentType,
              prompt: options.prompt,
            }
            break

          case 'create_work_stream':
            if (!options.title) {
              console.error('Error: create_work_stream requires --title')
              process.exit(1)
            }
            action = {
              type: 'create_work_stream',
              title: options.title,
              description: options.description,
              handoffMessage: options.handoffMessage,
              ...(workflow && { workflow }),
            }
            break

          default:
            console.error(`Error: Unknown action type: ${options.action}`)
            process.exit(1)
        }

        const created = await apiPost<Schedule>('/api/schedules', {
          scopeType,
          scopeId,
          name: options.name,
          enabled: !options.disabled,
          schedule,
          action,
          webhookOnly: options.webhookOnly || undefined,
        })

        // For webhook-only schedules, enable webhook and show token
        if (options.webhookOnly) {
          const result = await apiPost<WebhookEnableResult>(`/api/schedules/${created.id}/webhook/enable`, {})
          if (isJsonMode()) {
            output({ ...created, webhookToken: result.token, webhookUrl: result.webhookUrl })
          } else {
            console.log(`Created webhook-only schedule: ${created.id.slice(0, 8)} (${created.name})`)
            console.log(`Token: ${result.token}`)
            console.log(`URL: ${result.webhookUrl}`)
            console.log('')
            console.log('⚠️  Save this token - it will not be shown again!')
          }
        } else {
          if (isJsonMode()) {
            output(created)
          } else {
            console.log(`Created schedule: ${created.id.slice(0, 8)} (${created.name})`)
          }
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus schedule update <id>
  addStructuredInputOptions(sched.command('update <id>'), true)
    .description('Update a schedule')
    .option('--name <name>', 'New name')
    .option('--enable', 'Enable schedule')
    .option('--disable', 'Disable schedule')
    // Webhook options
    .option('--enable-webhook', 'Enable webhook triggering (generates token)')
    .option('--disable-webhook', 'Disable webhook triggering')
    .option('--regenerate-webhook-token', 'Regenerate webhook token')
    // Schedule timing
    .option('--interval <interval>', 'Interval (e.g., 15m, 1h)')
    .option('--cron <expr>', 'Five-field cron expression (e.g., "15 * * * *" for hourly at minute 15)')
    .option('--run-at <datetime>', 'One-shot datetime (ISO)')
    .option('--expires-at <datetime>', 'Optional expiration datetime (ISO-8601 with timezone)')
    .option('--clear-expires-at', 'Clear the configured expiration')
    .option(
      '--skip-if-unresolved',
      'Skip recurring trigger if prior work from this schedule is still open (default for work-stream actions)'
    )
    .option('--no-skip-if-unresolved', 'Disable default skip-if-unresolved policy')
    // Action type (replaces entire action)
    .option('--action <type>', 'Action type: inbox_message, spawn_agent, create_work_stream')
    // inbox_message options
    .option('--target-agent <id>', 'Target agent ID')
    .option('--target-manager', 'Target squad manager')
    .option('--subject <subject>', 'Message subject')
    .option('--content <content>', 'Message content')
    // spawn_agent options
    .option('--agent-type <type>', 'Agent type to spawn')
    .option('--prompt <prompt>', 'Prompt for spawned agent')
    // create_work_stream options
    .option('--title <title>', 'Work stream title')
    .option('--description <desc>', 'Work stream description')
    .option('--handoff-message <msg>', 'Handoff message')
    .option('--workflow <id>', 'Workflow override; otherwise inherit the squad default')
    .action(async (id, options) => {
      try {
        const workflow = await readWorkflowSource(options)
        const updates: Record<string, unknown> = {}
        let existingSchedule: Schedule | undefined
        const getExistingSchedule = async () => {
          existingSchedule ??= await apiGet<Schedule>(`/api/schedules/${id}`)
          return existingSchedule
        }
        if (options.name) updates.name = options.name
        if (options.enable) updates.enabled = true
        if (options.disable) updates.enabled = false

        // Schedule timing update
        const schedule: Record<string, string | boolean> = {}
        if (options.interval) schedule.interval = options.interval
        if (options.cron) schedule.cron = options.cron
        if (options.runAt) schedule.runAt = options.runAt
        if (options.expiresAt) schedule.expiresAt = options.expiresAt
        if (options.skipIfUnresolved !== undefined) schedule.skipIfUnresolved = Boolean(options.skipIfUnresolved)
        if (options.expiresAt && options.clearExpiresAt) {
          throw new Error('Cannot combine --expires-at and --clear-expires-at')
        }
        if (Object.keys(schedule).length > 0 || options.clearExpiresAt) {
          const replacesTiming = Boolean(options.interval || options.cron || options.runAt)
          const expiryOnly = !replacesTiming && Boolean(options.expiresAt || options.clearExpiresAt)
          const skipOnly = options.skipIfUnresolved !== undefined && !replacesTiming
          if (expiryOnly || skipOnly) {
            const existing = await getExistingSchedule()
            const merged = { ...existing.schedule, ...schedule }
            if (options.clearExpiresAt) delete merged.expiresAt
            updates.schedule = merged
          } else {
            updates.schedule = schedule
          }
        }

        // Action update
        if (options.action) {
          switch (options.action) {
            case 'inbox_message':
              if (workflow) throw new Error('Workflow input flags require create_work_stream')
              if (!options.targetAgent && !options.targetManager) {
                console.error('Error: inbox_message requires --target-agent or --target-manager')
                process.exit(1)
              }
              if (!options.content) {
                console.error('Error: inbox_message requires --content')
                process.exit(1)
              }
              updates.action = {
                type: 'inbox_message',
                target: options.targetManager
                  ? { type: 'squad_manager' }
                  : { type: 'agent', agentId: options.targetAgent },
                subject: options.subject,
                content: options.content,
              }
              break

            case 'spawn_agent':
              if (workflow || options.title) throw new Error('Use --action create_work_stream to schedule a flow')
              if (!options.agentType || !options.prompt) {
                console.error('Error: spawn_agent requires --agent-type and --prompt')
                process.exit(1)
              }
              updates.action = {
                type: 'spawn_agent',
                agentTypeId: options.agentType,
                prompt: options.prompt,
              }
              break

            case 'create_work_stream':
              if (!options.title) {
                console.error('Error: create_work_stream requires --title')
                process.exit(1)
              }
              updates.action = {
                type: 'create_work_stream',
                title: options.title,
                description: options.description,
                handoffMessage: options.handoffMessage,
                ...(workflow && { workflow }),
              }
              break

            default:
              console.error(`Error: Unknown action type: ${options.action}`)
              process.exit(1)
          }
        } else if (workflow) {
          const existing = await getExistingSchedule()
          if (existing.action.type !== 'create_work_stream')
            throw new Error('Workflow input flags require create_work_stream')
          const { agentTypes, agentIds, assigneeAgentId, assigneeAgentIndex, completionMode, ...action } =
            existing.action
          updates.action = { ...action, workflow }
        }

        // Handle webhook options (these use separate endpoints)
        if (options.enableWebhook) {
          const result = await apiPost<WebhookEnableResult>(`/api/schedules/${id}/webhook/enable`, {})
          if (isJsonMode()) {
            output(result)
          } else {
            console.log(`Webhook enabled for schedule: ${id.slice(0, 8)}`)
            console.log(`Token: ${result.token}`)
            console.log(`URL: ${result.webhookUrl}`)
            console.log('')
            console.log('⚠️  Save this token - it will not be shown again!')
          }
          return
        }

        if (options.disableWebhook) {
          const updated = await apiPost<Schedule>(`/api/schedules/${id}/webhook/disable`, {})
          if (isJsonMode()) {
            output(updated)
          } else {
            console.log(`Webhook disabled for schedule: ${updated.id.slice(0, 8)}`)
          }
          return
        }

        if (options.regenerateWebhookToken) {
          const result = await apiPost<WebhookEnableResult>(`/api/schedules/${id}/webhook/regenerate-token`, {})
          if (isJsonMode()) {
            output(result)
          } else {
            console.log(`Webhook token regenerated for schedule: ${id.slice(0, 8)}`)
            console.log(`Token: ${result.token}`)
            console.log(`URL: ${result.webhookUrl}`)
            console.log('')
            console.log('⚠️  Save this token - it will not be shown again!')
          }
          return
        }

        if (Object.keys(updates).length === 0) {
          console.error('Error: No updates specified')
          process.exit(1)
        }

        const updated = await apiPatch<Schedule>(`/api/schedules/${id}`, updates)

        if (isJsonMode()) {
          output(updated)
        } else {
          console.log(`Updated schedule: ${updated.id.slice(0, 8)}`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus schedule delete <id>
  sched
    .command('delete <id>')
    .description('Delete a schedule')
    .action(async (id) => {
      try {
        await apiDelete(`/api/schedules/${id}`)
        console.log(`Deleted schedule: ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus schedule trigger <id>
  sched
    .command('trigger <id>')
    .description('Manually trigger a schedule')
    .action(async (id) => {
      try {
        const result = await apiPost<{ triggered: boolean }>(`/api/schedules/${id}/trigger`, {})
        if (isJsonMode()) {
          output(result)
        } else {
          console.log(`Triggered schedule: ${id}`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus schedule enable <id>
  sched
    .command('enable <id>')
    .description('Enable a schedule')
    .action(async (id) => {
      try {
        await apiPost(`/api/schedules/${id}/enable`)
        output({ id, enabled: true }, `Enabled schedule ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus schedule disable <id>
  sched
    .command('disable <id>')
    .description('Disable a schedule')
    .action(async (id) => {
      try {
        await apiPost(`/api/schedules/${id}/disable`)
        output({ id, disabled: true }, `Disabled schedule ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus schedule show <id>
  sched
    .command('show <id>')
    .description('Show schedule details')
    .action(async (id) => {
      try {
        const schedule = await apiGet<Schedule>(`/api/schedules/${id}`)
        if (isJsonMode()) {
          output(schedule)
        } else {
          console.log(`ID: ${schedule.id}`)
          console.log(`Name: ${schedule.name}`)
          console.log(`Scope: ${schedule.scopeType}:${schedule.scopeId}`)
          console.log(`Enabled: ${schedule.enabled}`)
          console.log(`Health: ${healthLabel(schedule.healthStatus)}`)
          console.log(`Schedule: ${JSON.stringify(schedule.schedule)}`)
          console.log(`Expires at: ${schedule.schedule.expiresAt || 'none'}`)
          console.log(`Action: ${JSON.stringify(schedule.action, null, 2)}`)
          console.log(`Workflow: ${getScheduleWorkflow(schedule.action)}`)
          console.log(`Attempts: ${schedule.triggerCount}`)
          console.log(`Failures: ${schedule.failureCount}`)
          console.log(`Consecutive failures: ${schedule.consecutiveFailureCount}`)
          console.log(`Last success: ${schedule.lastSuccessAt || 'never'}`)
          console.log(`Last failure: ${schedule.lastFailureAt || 'never'}`)
          console.log(`Last recovery: ${schedule.lastRecoveredAt || 'never'}`)
          if (schedule.lastErrorCode) {
            console.log(
              `${schedule.healthStatus === 'healthy' ? 'Previous failure code' : 'Last error code'}: ${schedule.lastErrorCode}`
            )
          }
          if (schedule.lastErrorSummary) {
            console.log(
              `${schedule.healthStatus === 'healthy' ? 'Previous failure' : 'Last error'}: ${schedule.lastErrorSummary}`
            )
          }
          if (schedule.automaticallyDisabledAt)
            console.log(`Automatically disabled: ${schedule.automaticallyDisabledAt}`)
          if (schedule.automaticDisableReason) console.log(`Disable reason: ${schedule.automaticDisableReason}`)
          console.log(
            `Skips: ${schedule.skipCount}${schedule.lastSkippedAt ? ` (last ${schedule.lastSkippedAt})` : ''}`
          )
          console.log(`Last triggered: ${schedule.lastTriggeredAt || 'never'}`)
          console.log(`Last webhook trigger: ${schedule.lastWebhookTriggerAt || 'never'}`)
          console.log(`Next trigger: ${schedule.nextTriggerAt || 'none'}`)
          console.log(`Webhook: ${schedule.webhookEnabled ? 'enabled' : 'disabled'}`)
          if (schedule.webhookEnabled) {
            console.log(`Webhook URL: /api/webhooks/trigger/${schedule.id}`)
          }
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
