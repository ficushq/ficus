import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet, apiPost, apiPut, apiDelete } from '../client'
import { setOutputOptions } from '../output'
import { registerAgentQuestionCommands } from './agent-question'
import { registerAgentCommands } from './agent'
import { registerSquadCommands } from './squad'
import { registerWorkstreamCommands } from './workstream'
import { registerNotificationConfigCommands } from './notification-config'

type AnyMock = ReturnType<typeof mock>

function makeRunner(register: (program: Command) => void) {
  return async (args: string[]): Promise<void> => {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    register(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }
}

describe('CLI commands for new routes', () => {
  beforeEach(() => {
    for (const fn of [apiGet, apiPost, apiPut, apiDelete, setOutputOptions] as AnyMock[]) fn.mockClear()
    ;(apiGet as AnyMock).mockResolvedValue([])
    ;(apiPost as AnyMock).mockResolvedValue({})
    ;(apiPut as AnyMock).mockResolvedValue({})
    ;(apiDelete as AnyMock).mockResolvedValue({})
  })

  it('agent-question list hits GET /api/agent-questions/by-agent/:id with status', async () => {
    await makeRunner(registerAgentQuestionCommands)(['agent-question', 'list', 'agent-1', '--status', 'open'])
    expect(apiGet).toHaveBeenCalledWith('/api/agent-questions/by-agent/agent-1?status=open')
  })

  it('agent-question answer hits POST /api/agent-questions/:id/answer', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({ id: 'q-1', status: 'answered' })
    await makeRunner(registerAgentQuestionCommands)(['agent-question', 'answer', 'q-1', 'Yes, ship it'])
    expect(apiPost).toHaveBeenCalledWith('/api/agent-questions/q-1/answer', { answer: 'Yes, ship it' })
  })

  it('agent-question dismiss hits DELETE /api/agent-questions/:id with an optional reason', async () => {
    ;(apiDelete as AnyMock).mockResolvedValue({ id: 'q-1', status: 'dismissed' })
    await makeRunner(registerAgentQuestionCommands)(['agent-question', 'dismiss', 'q-1', '--reason', 'stale'])
    expect(apiDelete).toHaveBeenCalledWith('/api/agent-questions/q-1', { reason: 'stale' })
  })

  it('agent-question dismiss omits the body and enables JSON output when requested', async () => {
    ;(apiDelete as AnyMock).mockResolvedValue({ id: 'q-2', status: 'dismissed' })
    await makeRunner(registerAgentQuestionCommands)(['agent-question', 'dismiss', 'q-2', '--json'])
    expect(apiDelete).toHaveBeenCalledWith('/api/agent-questions/q-2', undefined)
    expect(setOutputOptions).toHaveBeenCalledWith(expect.objectContaining({ json: true }))
  })

  it('agent continue hits POST /api/agents/:id/continue', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({ resumed: true })
    await makeRunner(registerAgentCommands)(['agent', 'continue', 'agent-1'])
    expect(apiPost).toHaveBeenCalledWith('/api/agents/agent-1/continue')
  })

  it('agent continue-halted hits POST /api/agents/continue-halted', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({ resumed: 3 })
    await makeRunner(registerAgentCommands)(['agent', 'continue-halted'])
    expect(apiPost).toHaveBeenCalledWith('/api/agents/continue-halted')
  })

  it('squad subscribe with no flags posts no body', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({
      subscribed: true,
      count: 1,
      attention: { decisions: 'notify', progress: 'notify' },
    })
    await makeRunner(registerSquadCommands)(['squad', 'subscribe', 'squad-1'])
    expect(apiGet).not.toHaveBeenCalled()
    expect(apiPost).toHaveBeenCalledWith('/api/squads/squad-1/subscribe')
  })

  it('squad watch with one flag keeps the other level from the existing row', async () => {
    ;(apiGet as AnyMock).mockResolvedValue({
      subscribed: true,
      count: 1,
      attention: { decisions: 'notify', progress: 'notify' },
    })
    ;(apiPost as AnyMock).mockResolvedValue({
      subscribed: true,
      count: 1,
      attention: { decisions: 'notify', progress: 'mute' },
    })
    await makeRunner(registerSquadCommands)(['squad', 'watch', 'squad-1', '--progress', 'mute'])
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiGet).toHaveBeenCalledWith('/api/squads/squad-1/subscription')
    expect(apiPost).toHaveBeenCalledWith('/api/squads/squad-1/subscribe', {
      attention: { decisions: 'notify', progress: 'mute' },
    })
  })

  it('squad watch with one flag keeps the effective other level even with no row yet', async () => {
    // Unsubscribed: the GET still reports the level the user experiences today (the default).
    // Muting decisions must not silently turn progress up to notify.
    ;(apiGet as AnyMock).mockResolvedValue({
      subscribed: false,
      count: 0,
      attention: { decisions: 'show', progress: 'show' },
    })
    ;(apiPost as AnyMock).mockResolvedValue({
      subscribed: true,
      count: 1,
      attention: { decisions: 'mute', progress: 'show' },
    })
    await makeRunner(registerSquadCommands)(['squad', 'watch', 'squad-1', '--decisions', 'mute'])
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiPost).toHaveBeenCalledWith('/api/squads/squad-1/subscribe', {
      attention: { decisions: 'mute', progress: 'show' },
    })
  })

  it('workstream watch with one flag merges with the inherited squad level, not with notify', async () => {
    ;(apiGet as AnyMock).mockResolvedValue({
      subscribed: false,
      count: 1,
      attention: { decisions: 'notify', progress: 'mute' },
      inherited: true,
    })
    ;(apiPost as AnyMock).mockResolvedValue({
      subscribed: true,
      count: 1,
      attention: { decisions: 'show', progress: 'mute' },
      inherited: false,
    })
    await makeRunner(registerWorkstreamCommands)(['workstream', 'watch', 'ws-1', '--decisions', 'show'])
    expect(apiGet).toHaveBeenCalledWith('/api/workstreams/ws-1/subscription')
    expect(apiPost).toHaveBeenCalledWith('/api/workstreams/ws-1/subscribe', {
      attention: { decisions: 'show', progress: 'mute' },
    })
  })

  it('falls back to notify for the untouched kind only when the read carries no attention', async () => {
    ;(apiGet as AnyMock).mockResolvedValue({ subscribed: false, count: 0 })
    ;(apiPost as AnyMock).mockResolvedValue({
      subscribed: true,
      count: 1,
      attention: { decisions: 'mute', progress: 'notify' },
    })
    await makeRunner(registerSquadCommands)(['squad', 'watch', 'squad-1', '--decisions', 'mute'])
    expect(apiPost).toHaveBeenCalledWith('/api/squads/squad-1/subscribe', {
      attention: { decisions: 'mute', progress: 'notify' },
    })
  })

  it('squad unsubscribe hits DELETE /api/squads/:id/subscribe', async () => {
    ;(apiDelete as AnyMock).mockResolvedValue({
      subscribed: false,
      count: 0,
      attention: { decisions: 'show', progress: 'show' },
    })
    await makeRunner(registerSquadCommands)(['squad', 'unsubscribe', 'squad-1'])
    expect(apiDelete).toHaveBeenCalledWith('/api/squads/squad-1/subscribe')
  })

  it('workstream subscribe with no flags posts no body', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({
      subscribed: true,
      count: 1,
      attention: { decisions: 'notify', progress: 'notify' },
      inherited: false,
    })
    await makeRunner(registerWorkstreamCommands)(['workstream', 'subscribe', 'ws-1'])
    expect(apiGet).not.toHaveBeenCalled()
    expect(apiPost).toHaveBeenCalledWith('/api/workstreams/ws-1/subscribe')
  })

  it('workstream subscribe forwards both levels when both flags are given', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({
      subscribed: true,
      count: 1,
      attention: { decisions: 'show', progress: 'mute' },
      inherited: false,
    })
    await makeRunner(registerWorkstreamCommands)([
      'workstream',
      'subscribe',
      'ws-1',
      '--decisions',
      'show',
      '--progress',
      'mute',
    ])
    // Both levels given, so the current row never has to be read.
    expect(apiGet).not.toHaveBeenCalled()
    expect(apiPost).toHaveBeenCalledWith('/api/workstreams/ws-1/subscribe', {
      attention: { decisions: 'show', progress: 'mute' },
    })
  })

  it('workstream subscription hits GET /api/workstreams/:id/subscription', async () => {
    ;(apiGet as AnyMock).mockResolvedValue({
      subscribed: true,
      count: 2,
      attention: { decisions: 'notify', progress: 'show' },
      inherited: false,
    })
    await makeRunner(registerWorkstreamCommands)(['workstream', 'subscription', 'ws-1'])
    expect(apiGet).toHaveBeenCalledWith('/api/workstreams/ws-1/subscription')
  })

  it('rejects an unknown attention level before calling the API', async () => {
    await expect(
      makeRunner(registerSquadCommands)(['squad', 'watch', 'squad-1', '--decisions', 'loud'])
    ).rejects.toThrow('--decisions must be one of mute, show, notify')
    expect(apiGet).not.toHaveBeenCalled()
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('notification-config set-mine hits PUT /api/notification-config/me', async () => {
    ;(apiPut as AnyMock).mockResolvedValue({ pushEnabled: false, mutedEvents: ['x'] })
    await makeRunner(registerNotificationConfigCommands)([
      'notification-config',
      'set-mine',
      '--push-enabled',
      'false',
      '--muted',
      'x, y',
    ])
    expect(apiPut).toHaveBeenCalledWith('/api/notification-config/me', {
      pushEnabled: false,
      mutedEvents: ['x', 'y'],
    })
  })
})
