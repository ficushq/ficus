import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet, apiPost } from '../client'
import { output, outputError } from '../output'
import { buildSystemLogsWsRequest, buildSystemLogsWsUrl, registerSystemCommands } from './system'

describe('system CLI commands', () => {
  let systemCommand: Command | undefined

  beforeAll(() => {
    const program = new Command()
    program.exitOverride()
    registerSystemCommands(program)
    systemCommand = program.commands.find((command) => command.name() === 'system')
  })

  it('exposes maintenance, restart, logs, and storage subcommands', () => {
    expect(systemCommand?.commands.map((command) => command.name()).sort()).toEqual([
      'logs',
      'pause',
      'pause-status',
      'restart',
      'resume',
      'storage',
    ])
  })

  it('supports an optional maintenance reason', () => {
    const pause = systemCommand?.commands.find((command) => command.name() === 'pause')
    expect(pause?.options.some((option) => option.long === '--reason')).toBe(true)
  })

  it('supports component, tail, and follow flags for logs', () => {
    const logs = systemCommand?.commands.find((command) => command.name() === 'logs')
    expect(logs?.options.find((option) => option.long === '--component')?.defaultValue).toBe('all')
    expect(logs?.options.find((option) => option.long === '--tail')?.defaultValue).toBe('500')
    expect(logs?.options.some((option) => option.long === '--follow')).toBe(true)
  })
})

describe('system storage CLI', () => {
  const get = apiGet as ReturnType<typeof mock>
  const post = apiPost as ReturnType<typeof mock>
  const print = output as ReturnType<typeof mock>
  const fail = outputError as ReturnType<typeof mock>
  const reset = () => {
    get.mockReset().mockResolvedValue({})
    post.mockReset().mockResolvedValue({})
    print.mockReset()
    fail.mockReset()
  }
  beforeEach(reset)
  afterEach(reset)

  async function run(...args: string[]) {
    const program = new Command().exitOverride()
    registerSystemCommands(program)
    await program.parseAsync(['system', 'storage', ...args], { from: 'user' })
  }

  it('reads cached results without hiding an ongoing scan or partial machine state', async () => {
    const snapshot = {
      supported: true,
      scanning: true,
      scannedAt: '2026-09-19T12:00:00Z',
      error: null,
      machines: [{ id: 'machine-1', status: 'partial', usedBytes: 1024, squads: [] }],
    }
    get.mockResolvedValue(snapshot)
    await run()
    expect(get).toHaveBeenCalledWith('/api/system/storage')
    expect(post).not.toHaveBeenCalled()
    expect(print).toHaveBeenCalledWith(snapshot, JSON.stringify(snapshot, null, 2))
  })

  it('requests a scan once and immediately exposes the returned state without polling or bypassing cooldown', async () => {
    const snapshot = { supported: true, scanning: true, scannedAt: null, error: null, machines: [] }
    post.mockResolvedValue(snapshot)
    await run('--refresh')
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/api/system/storage/refresh')
    expect(get).not.toHaveBeenCalled()
    expect(print).toHaveBeenCalledWith(snapshot, JSON.stringify(snapshot, null, 2))
  })

  it('reports permission errors without printing a successful scan', async () => {
    const error = new Error('Forbidden: requires system:logs')
    post.mockRejectedValue(error)
    await run('--refresh')
    expect(fail).toHaveBeenCalledWith(error)
    expect(print).not.toHaveBeenCalled()
  })
})

describe('buildSystemLogsWsUrl', () => {
  it('builds ws URL from http API URL and clamps tail', () => {
    expect(
      buildSystemLogsWsUrl({
        apiUrl: 'http://localhost:3000/',
        token: 'tok',
        component: 'api',
        tail: 99999,
        follow: false,
      })
    ).toBe('ws://localhost:3000/ws/system/logs?component=api&tailLines=5000&follow=false')
  })

  it('builds wss URL from https API URL', () => {
    expect(buildSystemLogsWsUrl({ apiUrl: 'https://ficus.example', component: 'all', tail: 100, follow: true })).toBe(
      'wss://ficus.example/ws/system/logs?component=all&tailLines=100'
    )
  })

  it('keeps the bearer out of the URL and sends it as a header', () => {
    const request = buildSystemLogsWsRequest({
      apiUrl: 'https://ficus.example',
      token: 'secret',
      component: 'all',
      tail: 100,
      follow: true,
    })
    expect(request.url).not.toContain('secret')
    expect(request.headers).toEqual({ Authorization: 'Bearer secret' })
  })
})
