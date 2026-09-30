import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Command } from 'commander'
import { homedir } from 'os'
import { join } from 'path'
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../client'
import { isJsonMode, output, outputError, outputTable, setOutputOptions } from '../output'
import { parseHostWorkspacePath, parseMaxConcurrentStreams, registerSquadCommands } from './squad'

describe('squad CLI commands', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    ;(apiPatch as ReturnType<typeof mock>).mockClear()
    ;(apiPut as ReturnType<typeof mock>).mockClear()
    ;(apiDelete as ReturnType<typeof mock>).mockClear()
    ;(output as ReturnType<typeof mock>).mockClear()
    ;(outputError as ReturnType<typeof mock>).mockClear()
    ;(outputTable as ReturnType<typeof mock>).mockClear()
    ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(false)
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({
      sourceType: 'github_issue',
      sourceId: 'acme/api#42',
      result: { success: true, chunksCreated: 2, linksCreated: 0 },
    })
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerSquadCommands(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }

  describe('cleanup-agents', () => {
    const result = { checked: 3, terminated: 1, agents: [], deferred: 1, deferredAgents: [] }

    it('routes a scoped dry run and keeps JSON output intact', async () => {
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue(result)
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
      await run(['squad', 'cleanup-agents', '--squad', 'squad-1', '--dry-run', '--json'])
      expect(apiPost).toHaveBeenCalledWith('/api/squads/squad-1/cleanup-agents?dryRun=true', {})
      expect(output).toHaveBeenCalledWith(result)
    })

    it('identifies the scope and reports deferred workers separately', async () => {
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue(result)
      const log = spyOn(console, 'log').mockImplementation(() => {})
      try {
        await run(['squad', 'cleanup-agents', '--squad', 'squad-1'])
        expect(apiPost).toHaveBeenCalledWith('/api/squads/squad-1/cleanup-agents', {})
        expect(log.mock.calls.flat().join(' ')).toContain('squad squad-1')
        expect(log.mock.calls.flat().join(' ')).toContain('made dormant 1')
        expect(log.mock.calls.flat().join(' ')).toContain('deferred 1')
      } finally {
        log.mockRestore()
      }
    })

    it('preserves the administrator global route with and without dry-run', async () => {
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue(result)
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
      await run(['squad', 'cleanup-agents'])
      expect(apiPost).toHaveBeenLastCalledWith('/api/squads/cleanup-agents', {})
      await run(['squad', 'cleanup-agents', '--dry-run'])
      expect(apiPost).toHaveBeenLastCalledWith('/api/squads/cleanup-agents?dryRun=true', {})
    })

    it('documents scoped authorization and retained history', () => {
      const program = new Command()
      registerSquadCommands(program)
      const cleanup = program.commands
        .find((c) => c.name() === 'squad')
        ?.commands.find((c) => c.name() === 'cleanup-agents')
      expect(cleanup?.options.find((o) => o.long === '--squad')?.description).toContain('agents:terminate')
      expect(cleanup?.helpInformation()).toContain('history and worktrees')
      expect(cleanup?.helpInformation()).toContain('system:cleanup')
    })
  })

  it('sets and applies a squad toolchain', async () => {
    ;(apiPut as ReturnType<typeof mock>).mockResolvedValue({ packages: ['python3@latest'] })
    await run(['squad', 'toolchain', 'set', 'squad-1', '--package', 'python3@latest'])
    expect(apiPut).toHaveBeenCalledWith('/api/squads/squad-1/toolchain', { packages: ['python3@latest'] })

    await run(['squad', 'toolchain', 'apply', 'squad-1'])
    expect(apiPost).toHaveBeenCalledWith('/api/squads/squad-1/toolchain/apply', {})
  })

  it('maps terminate-bulk to POST /api/squads/:id/agents/terminate-bulk and prints skipped reasons', async () => {
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({
      terminated: ['agent-1', 'agent-2'],
      deferred: ['agent-3'],
      skipped: [{ id: 'agent-4', reason: 'Agent has active work streams.' }],
    })

    await run(['squad', 'terminate-bulk', 'squad-1', '--type', 'consultant'])

    expect(apiPost).toHaveBeenCalledWith('/api/squads/squad-1/agents/terminate-bulk', { agentTypeId: 'consultant' })
    expect(outputTable).toHaveBeenCalledWith(
      [{ id: 'agent-4', reason: 'Agent has active work streams.' }],
      ['id', 'reason']
    )
  })

  it('maps squad create --host-workspace-path into the creation payload', async () => {
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: 'squad-1', name: 'Platform' })

    await run(['squad', 'create', 'Platform', '--purpose', 'Ship it', '--host-workspace-path', '~/platform'])

    expect(apiPost).toHaveBeenCalledWith('/api/squads', {
      name: 'Platform',
      purpose: 'Ship it',
      squadPresetId: undefined,
      defaultAgents: undefined,
      context: undefined,
      hostWorkspacePath: join(homedir(), 'platform'),
    })
  })

  it('inherits preset members unless default agents are explicitly supplied', async () => {
    await run(['squad', 'create', 'Platform', '--purpose', 'Ship it', '--preset', 'engineering'])
    expect(apiPost).toHaveBeenLastCalledWith(
      '/api/squads',
      expect.objectContaining({
        squadPresetId: 'engineering',
        defaultAgents: undefined,
      })
    )
    await run([
      'squad',
      'create',
      'Platform',
      '--purpose',
      'Ship it',
      '--preset',
      'engineering',
      '-a',
      'engineer',
      '-a',
      'reviewer',
    ])
    expect(apiPost).toHaveBeenLastCalledWith(
      '/api/squads',
      expect.objectContaining({
        squadPresetId: 'engineering',
        defaultAgents: ['engineer', 'reviewer'],
      })
    )
  })

  it('maps memory ingest to POST /api/memory/:squadId/ingest-url', async () => {
    const url = 'https://github.com/acme/api/issues/42'

    await run(['squad', 'memory', 'ingest', 'squad-1', url])

    expect(apiPost).toHaveBeenCalledWith('/api/memory/squad-1/ingest-url', { url })
    expect(output).toHaveBeenCalledWith(
      {
        sourceType: 'github_issue',
        sourceId: 'acme/api#42',
        result: { success: true, chunksCreated: 2, linksCreated: 0 },
      },
      'indexed: github_issue acme/api#42'
    )
  })

  it('prints all-agent context in squad get output', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      id: 'squad-1',
      name: 'S',
      purpose: 'p',
      status: 'active',
      squadPresetId: null,
      defaultAgents: [],
      managerAgentId: null,
      isAnonymous: false,
      globalCollaborationEnabled: false,
      typeContext: null,
      metadata: {},
      context: 'Shared squad guidance',
      createdAt: '',
      updatedAt: '',
    })
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})

    try {
      await run(['squad', 'get', 'squad-1'])
      expect(logSpy).toHaveBeenCalledWith('Context:     Shared squad guidance')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('maps squad update --context to PATCH /api/squads/:id with context', async () => {
    ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({
      id: 'squad-1',
      name: 'S',
      purpose: 'p',
      status: 'active',
      squadPresetId: null,
      defaultAgents: [],
      managerAgentId: null,
      isAnonymous: false,
      globalCollaborationEnabled: false,
      typeContext: null,
      metadata: {},
      context: 'CTX',
      createdAt: '',
      updatedAt: '',
    })

    await run(['squad', 'update', 'squad-1', '--context', 'CTX'])

    expect(apiPatch).toHaveBeenCalledWith('/api/squads/squad-1', { context: 'CTX' })
  })

  it('sends context as empty string when squad update --context "" is passed', async () => {
    ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({
      id: 'squad-1',
      name: 'S',
      purpose: 'p',
      status: 'active',
      squadPresetId: null,
      defaultAgents: [],
      managerAgentId: null,
      isAnonymous: false,
      globalCollaborationEnabled: false,
      typeContext: null,
      metadata: {},
      context: '',
      createdAt: '',
      updatedAt: '',
    })

    await run(['squad', 'update', 'squad-1', '--context', ''])

    expect(apiPatch).toHaveBeenCalledWith('/api/squads/squad-1', { context: '' })
  })

  it('maps --max-concurrent-streams N to a numeric cap and unlimited to null', async () => {
    ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({ id: 'squad-1', name: 'S' })

    await run(['squad', 'update', 'squad-1', '--max-concurrent-streams', '3'])
    expect(apiPatch).toHaveBeenCalledWith('/api/squads/squad-1', { maxConcurrentWorkStreams: 3 })

    await run(['squad', 'update', 'squad-1', '--max-concurrent-streams', 'unlimited'])
    expect(apiPatch).toHaveBeenLastCalledWith('/api/squads/squad-1', { maxConcurrentWorkStreams: null })
  })

  it('rejects non-integer and non-positive --max-concurrent-streams values', () => {
    expect(parseMaxConcurrentStreams('4')).toBe(4)
    expect(parseMaxConcurrentStreams('unlimited')).toBeNull()
    expect(() => parseMaxConcurrentStreams('0')).toThrow('positive integer')
    expect(() => parseMaxConcurrentStreams('2.5')).toThrow('positive integer')
    expect(() => parseMaxConcurrentStreams('lots')).toThrow('positive integer')
  })

  it('maps --host-workspace-path to hostWorkspacePath and none to null', async () => {
    ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({ id: 'squad-1', name: 'S' })
    await run(['squad', 'update', 'squad-1', '--host-workspace-path', '/srv/repo'])
    expect(apiPatch).toHaveBeenCalledWith('/api/squads/squad-1', { hostWorkspacePath: '/srv/repo' })
    await run(['squad', 'update', 'squad-1', '--host-workspace-path', 'none'])
    expect(apiPatch).toHaveBeenLastCalledWith('/api/squads/squad-1', { hostWorkspacePath: null })
  })

  // The CLI expands `~` itself (only this machine knows the home directory);
  // the help has to say so, or `~/repo` looks like it will reach the server
  // verbatim and be rejected as relative.
  it('documents that --host-workspace-path expands ~ on the CLI machine', () => {
    const program = new Command()
    registerSquadCommands(program)
    const update = program.commands
      .find((command) => command.name() === 'squad')
      ?.commands.find((command) => command.name() === 'update')
    const option = update?.options.find((opt) => opt.long === '--host-workspace-path')
    expect(option?.description).toContain('`~` is expanded on the machine running the CLI')
  })

  it('rejects relative or .. host workspace paths', () => {
    expect(parseHostWorkspacePath('/srv/x')).toBe('/srv/x')
    expect(parseHostWorkspacePath('none')).toBeNull()
    expect(() => parseHostWorkspacePath('repo')).toThrow('absolute')
    expect(() => parseHostWorkspacePath('/srv/../etc')).toThrow('absolute')
  })

  it('expands a leading ~ in a host workspace path', () => {
    // The server rightly insists on an absolute path — it has no idea what
    // the operator's home is. That makes expansion the CLIENT's job: only the
    // machine typing `~/repo` knows what it means.
    expect(parseHostWorkspacePath('~/repo')).toBe(join(homedir(), 'repo'))
    expect(parseHostWorkspacePath('~')).toBe(homedir())
  })

  it('still rejects ~user, which no client can expand', () => {
    expect(() => parseHostWorkspacePath('~someoneelse/repo')).toThrow('absolute')
  })

  it('rejects .. even after expansion', () => {
    expect(() => parseHostWorkspacePath('~/repo/../../etc')).toThrow('absolute')
  })

  describe('metadata commands', () => {
    it('sets and unsets exact nested deltas without a GET', async () => {
      ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({ id: 'squad-1' })

      await run(['squad', 'set-meta', 'squad-1', 'ledger.current.sequence', '7'])
      expect(apiGet).not.toHaveBeenCalled()
      expect(apiPatch).toHaveBeenLastCalledWith('/api/squads/squad-1', {
        metadata: { ledger: { current: { sequence: 7 } } },
      })

      await run(['squad', 'unset-meta', 'squad-1', 'ledger.current.sequence'])
      expect(apiGet).not.toHaveBeenCalled()
      expect(apiPatch).toHaveBeenLastCalledWith('/api/squads/squad-1', {
        metadata: { ledger: { current: { sequence: null } } },
      })
    })

    it('preserves concurrent unrelated writes with an observable request barrier', async () => {
      const arrived = Promise.withResolvers<void>()
      const requests: Record<string, unknown>[] = []
      let serverState: Record<string, unknown> = {
        ledger: { left: 0, right: 0, neighbor: 'keep' },
        obsolete: 'remove',
        labels: ['old'],
        outside: 'keep',
      }
      const merge = (target: Record<string, unknown>, delta: Record<string, unknown>): Record<string, unknown> => {
        const result = { ...target }
        for (const [key, value] of Object.entries(delta)) {
          if (value === null) delete result[key]
          else if (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            typeof result[key] === 'object' &&
            result[key] !== null &&
            !Array.isArray(result[key])
          ) {
            result[key] = merge(result[key] as Record<string, unknown>, value as Record<string, unknown>)
          } else result[key] = value
        }
        return result
      }
      ;(apiPatch as ReturnType<typeof mock>).mockImplementation(
        async (_path: string, body: Record<string, unknown>) => {
          requests.push(body)
          if (requests.length === 2) {
            serverState = merge(serverState, { obsolete: null, labels: ['external'] })
            arrived.resolve()
          }
          await arrived.promise
          serverState = merge(serverState, body.metadata as Record<string, unknown>)
          return { id: 'squad-1', metadata: serverState }
        }
      )

      await Promise.all([
        run(['squad', 'set-meta', 'squad-1', 'ledger.left', '1']),
        run(['squad', 'set-meta', 'squad-1', 'ledger.right', '2']),
      ])

      expect(apiGet).not.toHaveBeenCalled()
      expect(requests).toEqual([{ metadata: { ledger: { left: 1 } } }, { metadata: { ledger: { right: 2 } } }])
      expect(serverState).toEqual({
        ledger: { left: 1, right: 2, neighbor: 'keep' },
        labels: ['external'],
        outside: 'keep',
      })
    })

    it('gets only the selected metadata value', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: 'squad-1',
        metadata: { ledger: { current: { labels: ['a', 'b'] } }, outside: 'excluded' },
      })

      await run(['squad', 'get-meta', 'squad-1', 'ledger.current.labels'])

      expect(apiGet).toHaveBeenCalledTimes(1)
      expect(apiGet).toHaveBeenCalledWith('/api/squads/squad-1')
      expect(apiPatch).not.toHaveBeenCalled()
      expect(output).toHaveBeenCalledWith('[\n  "a",\n  "b"\n]')
    })

    it('outputs each raw JSON value with exactly one GET and no PATCH', async () => {
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
      const values: unknown[] = ['text', 7, false, { enabled: true }, ['a', 'b'], null]

      for (const value of values) {
        ;(apiGet as ReturnType<typeof mock>).mockClear()
        ;(apiPatch as ReturnType<typeof mock>).mockClear()
        ;(output as ReturnType<typeof mock>).mockClear()
        ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({ id: 'squad-1', metadata: { selected: value } })

        await run(['squad', 'get-meta', 'squad-1', 'selected'])

        expect(apiGet).toHaveBeenCalledTimes(1)
        expect(apiGet).toHaveBeenCalledWith('/api/squads/squad-1')
        expect(apiPatch).not.toHaveBeenCalled()
        expect(output).toHaveBeenCalledWith(value)
      }
    })

    it('rejects missing or malformed metadata paths', async () => {
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({ id: 'squad-1', metadata: {} })

      await run(['squad', 'get-meta', 'squad-1', 'missing'])
      expect(outputError).toHaveBeenLastCalledWith(new Error('Metadata path "missing" not found'))
      ;(apiGet as ReturnType<typeof mock>).mockClear()
      await run(['squad', 'get-meta', 'squad-1', 'bad..path'])
      expect(apiGet).not.toHaveBeenCalled()
      expect(outputError).toHaveBeenLastCalledWith(
        new Error('Invalid metadata path "bad..path": path segments cannot be empty')
      )
    })
  })
})
