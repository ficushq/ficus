import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Command } from 'commander'
import { apiGet, apiPatch, apiPost } from '../client'
import { isJsonMode, output, outputError, outputTable, setOutputOptions } from '../output'
import { registerScheduleCommands } from './schedule'

async function run(args: string[]) {
  const program = new Command()
  program.exitOverride()
  program.option('--json').option('--quiet')
  program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
  registerScheduleCommands(program)
  await program.parseAsync(['--quiet', ...args], { from: 'user' })
}

const schedule = {
  id: 'schedule-id',
  scopeType: 'squad' as const,
  scopeId: 'squad-id',
  name: 'health',
  enabled: true,
  schedule: { interval: '1h' },
  action: { type: 'create_work_stream', title: 'Health', completionMode: 'review-approval' },
  triggerCount: 0,
  lastTriggeredAt: null,
  lastSkippedAt: null,
  skipCount: 0,
  lastWebhookTriggerAt: null,
  nextTriggerAt: null,
  webhookEnabled: false,
  healthStatus: 'failing' as const,
  failureCount: 3,
  consecutiveFailureCount: 3,
  lastSuccessAt: null,
  lastFailureAt: new Date().toISOString(),
  lastRecoveredAt: null,
  lastErrorCode: 'transport_error',
  lastErrorSummary: 'A transport error interrupted the scheduled action.',
  automaticallyDisabledAt: null,
  automaticDisableReason: null,
  createdAt: new Date().toISOString(),
}

beforeEach(() => {
  for (const fn of [apiGet, apiPatch, apiPost, output, outputError, outputTable]) {
    ;(fn as ReturnType<typeof mock>).mockClear()
  }
  ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(false)
  ;(apiPost as ReturnType<typeof mock>).mockResolvedValue(schedule)
  ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue(schedule)
  ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(schedule)
})

afterEach(() => mock.restore())

describe('schedule flow CLI', () => {
  it('creates work with an explicit preset', async () => {
    await run([
      'schedule',
      'create',
      '--squad',
      'squad-id',
      '--name',
      'health',
      '--interval',
      '1h',
      '--action',
      'create_work_stream',
      '--title',
      'Health',
      '--workflow',
      'solo-coding',
    ])
    expect(apiPost).toHaveBeenCalledWith(
      '/api/schedules',
      expect.objectContaining({
        action: expect.objectContaining({
          type: 'create_work_stream',
          workflow: { kind: 'preset', id: 'solo-coding', customizations: [] },
        }),
      })
    )
  })

  it('leaves workflow unset to inherit the squad default at execution', async () => {
    await run([
      'schedule',
      'create',
      '--squad',
      'squad-id',
      '--name',
      'health',
      '--interval',
      '1h',
      '--action',
      'create_work_stream',
      '--title',
      'Health',
    ])
    const body = (apiPost as ReturnType<typeof mock>).mock.calls[0][1]
    expect(body.action.workflow).toBeUndefined()
    expect(body.action).not.toHaveProperty('completionMode')
  })

  it('rejects stream creation through spawn_agent and styles on inbox actions', async () => {
    await run([
      'schedule',
      'create',
      '--squad',
      'squad-id',
      '--name',
      'health',
      '--interval',
      '1h',
      '--action',
      'spawn_agent',
      '--agent-type',
      'sysops',
      '--prompt',
      'check',
      '--title',
      'Health',
    ])
    expect(outputError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('create_work_stream') })
    )
    await run([
      'schedule',
      'create',
      '--agent',
      'agent-id',
      '--name',
      'message',
      '--interval',
      '1h',
      '--action',
      'inbox_message',
      '--target-agent',
      'agent-id',
      '--content',
      'hello',
      '--workflow',
      'solo',
    ])
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('replaces legacy staffing with a preset without losing the task', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      ...schedule,
      action: {
        type: 'create_work_stream',
        title: 'Health',
        description: 'Daily check',
        agentTypes: ['sysops'],
        completionMode: 'review-approval',
      },
    })
    await run(['schedule', 'update', 'schedule-id', '--workflow', 'solo'])
    expect(apiPatch).toHaveBeenCalledWith('/api/schedules/schedule-id', {
      action: {
        type: 'create_work_stream',
        title: 'Health',
        description: 'Daily check',
        workflow: { kind: 'preset', id: 'solo', customizations: [] },
      },
    })
  })

  it('shows the inherited workflow instead of claiming a legacy completion default', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      ...schedule,
      action: { type: 'create_work_stream', title: 'Health' },
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    await run(['schedule', 'show', 'schedule-id'])
    expect(log).toHaveBeenCalledWith('Workflow: Squad default')
  })

  it('creates an expiring schedule and clears expiry without losing timing', async () => {
    await run([
      'schedule',
      'create',
      '--squad',
      'squad-id',
      '--name',
      'health',
      '--interval',
      '1h',
      '--expires-at',
      '2026-09-01T12:00:00Z',
      '--action',
      'create_work_stream',
      '--title',
      'Health',
    ])
    expect(apiPost).toHaveBeenCalledWith(
      '/api/schedules',
      expect.objectContaining({
        schedule: expect.objectContaining({ interval: '1h', expiresAt: '2026-09-01T12:00:00Z' }),
      })
    )
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      ...schedule,
      schedule: { interval: '1h', skipIfUnresolved: true, expiresAt: '2026-09-01T12:00:00Z' },
    })
    await run(['schedule', 'update', 'schedule-id', '--clear-expires-at'])
    expect(apiPatch).toHaveBeenCalledWith('/api/schedules/schedule-id', {
      schedule: { interval: '1h', skipIfUnresolved: true },
    })
  })

  it('replaces the timing mode when interval and expiry are updated together', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      ...schedule,
      schedule: { cron: '0 9 * * *', expiresAt: '2026-09-01T12:00:00Z' },
    })
    await run(['schedule', 'update', 'schedule-id', '--interval', '30m', '--expires-at', '2026-10-01T12:00:00Z'])
    expect(apiPatch).toHaveBeenCalledWith('/api/schedules/schedule-id', {
      schedule: { interval: '30m', expiresAt: '2026-10-01T12:00:00Z' },
    })
    expect(apiGet).not.toHaveBeenCalled()
  })

  it('labels retained healthy error history as a previous failure', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      ...schedule,
      healthStatus: 'healthy',
      lastSuccessAt: new Date().toISOString(),
      lastRecoveredAt: new Date().toISOString(),
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await run(['schedule', 'show', 'schedule-id'])
      expect(log).toHaveBeenCalledWith(`Previous failure: ${schedule.lastErrorSummary}`)
      expect(log).not.toHaveBeenCalledWith(`Last error: ${schedule.lastErrorSummary}`)
    } finally {
      log.mockRestore()
    }
  })

  it('passes schedule health through unchanged in JSON mode', async () => {
    ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([schedule])
    await run(['schedule', 'list'])
    expect(output).toHaveBeenCalledWith([schedule])
  })

  it('includes health separately from enabled state in human list output', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([schedule])
    await run(['schedule', 'list'])
    expect(outputTable).toHaveBeenCalledWith(
      [expect.objectContaining({ Enabled: '✓', Health: 'Failing', Attempts: 0 })],
      expect.arrayContaining(['Enabled', 'Health', 'Attempts'])
    )
  })

  it('flags legacy configuration in human list output', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([schedule])
    await run(['schedule', 'list'])
    expect(outputTable).toHaveBeenCalledWith(
      [expect.objectContaining({ Workflow: 'Legacy configuration — choose a workflow' })],
      expect.arrayContaining(['Workflow'])
    )
  })
  it('schedule help carries the reminder recipe and management commands moved out of the agent rules', async () => {
    const program = new Command()
    registerScheduleCommands(program)
    const sched = program.commands.find((command) => command.name() === 'schedule')!
    let help = ''
    sched.configureOutput({
      writeOut: (chunk) => {
        help += chunk
      },
    })
    sched.outputHelp()
    for (const name of ['list', 'create', 'update', 'enable', 'disable', 'trigger', 'delete', 'show']) {
      expect(help).toContain(name)
    }
    expect(help).toContain('--interval <15m|2h>')
    expect(help).toContain('--cron')
    expect(help).toContain('a schedule grants no authority')
    expect(help).toContain('never use one to get around a pause or an open wait')

    // The reminder example in the help must be a command the CLI accepts as written.
    const example = help.match(/ficus (schedule create [^\n]+)/)![1]!
    const args = example
      .replace('<squad-id>', 'squad-id')
      .replace('<name>', 'check')
      .replace('<your-agent-id>', 'agent-id')
      .replace('<text>', 'look')
      .replace('<ISO-datetime>', '2026-11-20T09:00:00Z')
      .split(' ')
    await run(args)
    expect(outputError).not.toHaveBeenCalled()
    expect(apiPost).toHaveBeenCalledWith(
      '/api/schedules',
      expect.objectContaining({
        scopeType: 'squad',
        scopeId: 'squad-id',
        name: 'check',
        enabled: true,
        schedule: { runAt: '2026-11-20T09:00:00Z' },
        action: expect.objectContaining({
          type: 'inbox_message',
          target: { type: 'agent', agentId: 'agent-id' },
          content: 'look',
        }),
      })
    )
  })
})
