import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Command } from 'commander'
import { apiPost, apiPostSSE } from '../client'
import { outputTable, setOutputOptions } from '../output'
import { registerMachinesCommands } from './machines'

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

const emptyPlan = { moves: [], skippedActive: [], unplaceable: [], unresolvable: [], results: [] }

describe('ficus machines commands', () => {
  beforeEach(() => {
    ;(apiPost as AnyMock).mockClear()
    ;(apiPost as AnyMock).mockResolvedValue({})
    ;(apiPostSSE as AnyMock).mockClear()
    ;(apiPostSSE as AnyMock).mockImplementation(
      async (_path: string, _body: unknown, onEvent: (event: string, data: string) => void) => {
        onEvent('result', JSON.stringify({ moved: true }))
      }
    )
  })

  it('migrate-box streams via SSE and posts just the sandboxId body (no allowSquad by default)', async () => {
    await makeRunner(registerMachinesCommands)(['machines', 'migrate-box', 'agent_abc', '--to', 'm-2'])
    expect(apiPostSSE).toHaveBeenCalledWith(
      '/api/machines/m-2/migrate-box',
      { sandboxId: 'agent_abc' },
      expect.any(Function)
    )
  })

  // Squad boxes migrate by default, so the body carries no flag at all. The
  // server owns that default; the CLI must not re-state it, or the two drift.
  it('migrate-box sends no squad flag by default', async () => {
    await makeRunner(registerMachinesCommands)(['machines', 'migrate-box', 'squad_abc', '--to', 'm-2'])
    expect(apiPostSSE).toHaveBeenCalledWith(
      '/api/machines/m-2/migrate-box',
      { sandboxId: 'squad_abc' },
      expect.any(Function)
    )
  })

  it('migrate-box --skip-squad plumbs the opt-OUT through the body', async () => {
    await makeRunner(registerMachinesCommands)(['machines', 'migrate-box', 'squad_abc', '--to', 'm-2', '--skip-squad'])
    expect(apiPostSSE).toHaveBeenCalledWith(
      '/api/machines/m-2/migrate-box',
      { sandboxId: 'squad_abc', allowSquad: false },
      expect.any(Function)
    )
  })

  it('migrate-box --force plumbs the override through the body, and never sends force:false', async () => {
    await makeRunner(registerMachinesCommands)([
      'machines',
      'migrate-box',
      'squad_abc',
      '--to',
      'm-2',
      '--force',
      'Evacuate failing host',
    ])
    expect(apiPostSSE).toHaveBeenCalledWith(
      '/api/machines/m-2/migrate-box',
      { sandboxId: 'squad_abc', force: { reason: 'Evacuate failing host', requestId: expect.any(String) } },
      expect.any(Function)
    )
    // Without the flag the field must be ABSENT, not false: the server's
    // default (refuse while executions are live) has to govern.
    ;(apiPostSSE as AnyMock).mockClear()
    await makeRunner(registerMachinesCommands)(['machines', 'migrate-box', 'squad_abc', '--to', 'm-2', '--skip-squad'])
    expect(apiPostSSE).toHaveBeenCalledWith(
      '/api/machines/m-2/migrate-box',
      { sandboxId: 'squad_abc', allowSquad: false },
      expect.any(Function)
    )
  })

  it('migrate-box --help states the fence exists and what --force gives up', async () => {
    const program = new Command()
    program.exitOverride()
    registerMachinesCommands(program)
    // commander hard-wraps the rendered help, so compare on collapsed
    // whitespace — otherwise a sentence that happens to straddle a wrap point
    // fails for no reason.
    const help = program.commands
      .find((c) => c.name() === 'machines')!
      .commands.find((c) => c.name() === 'migrate-box')!
      .helpInformation()
      .replace(/\s+/g, ' ')
    // Operators read --help, and it used to tell them the safety property did
    // not exist ("squad activity is NOT detected, so only move one you know is
    // quiescent"). Pin both halves of the correction.
    expect(help).not.toContain('squad activity is NOT detected')
    expect(help).toContain('A live execution on the box refuses the move')
    expect(help).toContain('--force')
    expect(help).toMatch(/--force .*DESTROYS the source box/)
    expect(help).toMatch(/--force .*after the copy is read is LOST/)
  })

  it('migrate-box surfaces a streamed error event as a failure', async () => {
    ;(apiPostSSE as AnyMock).mockImplementation(
      async (_path: string, _body: unknown, onEvent: (event: string, data: string) => void) => {
        onEvent('error', JSON.stringify({ error: 'boom' }))
      }
    )
    const outputError = (await import('../output')).outputError as AnyMock
    outputError.mockClear()
    await makeRunner(registerMachinesCommands)(['machines', 'migrate-box', 'agent_abc', '--to', 'm-2'])
    expect(outputError).toHaveBeenCalled()
    expect((outputError.mock.calls[0][0] as Error).message).toBe('boom')
  })

  it('rebalance --dry-run hits POST /api/machines/rebalance with dryRun: true', async () => {
    ;(apiPost as AnyMock).mockResolvedValue(emptyPlan)
    await makeRunner(registerMachinesCommands)(['machines', 'rebalance', '--dry-run'])
    expect(apiPost).toHaveBeenCalledWith('/api/machines/rebalance', { dryRun: true })
  })

  it('rebalance without --dry-run hits POST /api/machines/rebalance with an empty body', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({
      ...emptyPlan,
      moves: [{ sandboxId: 'agent_a', fromMachineId: 'm1', toMachineId: 'm2' }],
      results: [{ sandboxId: 'agent_a', result: { moved: true } }],
    })
    await makeRunner(registerMachinesCommands)(['machines', 'rebalance'])
    expect(apiPost).toHaveBeenCalledWith('/api/machines/rebalance', {})
  })

  it('rebalance prints the RESOLVED machine id for an executed provision-group move', async () => {
    ;(outputTable as AnyMock).mockClear()
    ;(apiPost as AnyMock).mockResolvedValue({
      ...emptyPlan,
      moves: [{ sandboxId: 'agent_a', fromMachineId: 'm1', toMachineId: 'provision:0' }],
      results: [{ sandboxId: 'agent_a', result: { moved: true }, targetMachineId: 'prov-real' }],
    })

    await makeRunner(registerMachinesCommands)(['machines', 'rebalance'])

    const calls = (outputTable as AnyMock).mock.calls
    expect(calls.length).toBe(1)
    expect(calls[0][0]).toEqual([{ sandboxId: 'agent_a', from: 'm1', to: 'prov-real', result: 'moved' }])
  })

  it('rebalance --dry-run keeps the provision placeholder (no real machine exists yet)', async () => {
    ;(outputTable as AnyMock).mockClear()
    ;(apiPost as AnyMock).mockResolvedValue({
      ...emptyPlan,
      moves: [{ sandboxId: 'agent_a', fromMachineId: 'm1', toMachineId: 'provision:0' }],
    })

    await makeRunner(registerMachinesCommands)(['machines', 'rebalance', '--dry-run'])

    const calls = (outputTable as AnyMock).mock.calls
    expect(calls.length).toBe(1)
    expect(calls[0][0]).toEqual([{ sandboxId: 'agent_a', from: 'm1', to: 'provision:0', result: '' }])
  })

  it('rebalance (execute) prints a long-run heads-up BEFORE calling the API; dry-run stays silent', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    let logsWhenApiCalled = -1
    ;(apiPost as AnyMock).mockImplementation(async () => {
      logsWhenApiCalled = logSpy.mock.calls.length
      return emptyPlan
    })
    try {
      await makeRunner(registerMachinesCommands)(['machines', 'rebalance'])
      const headsUp = logSpy.mock.calls.filter((c) => /several minutes/i.test(String(c[0])))
      expect(headsUp.length).toBe(1)
      expect(logsWhenApiCalled).toBeGreaterThanOrEqual(1)

      logSpy.mockClear()
      await makeRunner(registerMachinesCommands)(['machines', 'rebalance', '--dry-run'])
      expect(logSpy.mock.calls.filter((c) => /several minutes/i.test(String(c[0]))).length).toBe(0)
    } finally {
      logSpy.mockRestore()
    }
  })
})
