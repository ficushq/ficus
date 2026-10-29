import { apiGet } from '../client'
import { isJsonMode, output } from '../output'
import { describe, it, expect, beforeAll, mock, spyOn } from 'bun:test'
import { Command } from 'commander'
import { registerMemoryCommands } from './memory'

describe('memory CLI commands', () => {
  let program: Command
  let memoryCommand: Command | undefined

  beforeAll(() => {
    program = new Command()
    program.exitOverride() // Prevent process.exit during tests
    registerMemoryCommands(program)
    memoryCommand = program.commands.find((c) => c.name() === 'memory')
  })

  describe('command registration', () => {
    it('registers the memory command', () => {
      expect(memoryCommand).toBeDefined()
    })

    it('registers search subcommand', () => {
      const cmd = memoryCommand?.commands.find((c) => c.name() === 'search')
      expect(cmd).toBeDefined()
      expect(cmd?.description()).toContain('Search')
    })

    it('registers get subcommand', () => {
      const cmd = memoryCommand?.commands.find((c) => c.name() === 'get')
      expect(cmd).toBeDefined()
      expect(cmd?.description()).toContain('Read')
    })

    it('registers write subcommand', () => {
      const cmd = memoryCommand?.commands.find((c) => c.name() === 'write')
      expect(cmd).toBeDefined()
      expect(cmd?.description()).toContain('Write')
    })

    it('registers patch subcommand', () => {
      const cmd = memoryCommand?.commands.find((c) => c.name() === 'patch')
      expect(cmd).toBeDefined()
      expect(cmd?.description()).toContain('Patch')
    })

    it('registers append subcommand', () => {
      const cmd = memoryCommand?.commands.find((c) => c.name() === 'append')
      expect(cmd).toBeDefined()
      expect(cmd?.description()).toContain('Append')
    })

    it('registers backlinks subcommand', () => {
      const cmd = memoryCommand?.commands.find((c) => c.name() === 'backlinks')
      expect(cmd).toBeDefined()
      expect(cmd?.description()).toContain('link')
    })

    it('registers sync subcommand with pull/push/status', () => {
      const syncCmd = memoryCommand?.commands.find((c) => c.name() === 'sync')
      expect(syncCmd).toBeDefined()

      const pullCmd = syncCmd?.commands.find((c) => c.name() === 'pull')
      expect(pullCmd).toBeDefined()

      const pushCmd = syncCmd?.commands.find((c) => c.name() === 'push')
      expect(pushCmd).toBeDefined()

      const statusCmd = syncCmd?.commands.find((c) => c.name() === 'status')
      expect(statusCmd).toBeDefined()
    })

    it('registers reindex subcommand', () => {
      const cmd = memoryCommand?.commands.find((c) => c.name() === 'reindex')
      expect(cmd).toBeDefined()
      expect(cmd?.description()).toContain('Reindex')
    })
  })

  describe('option validation', () => {
    it('search requires --squad option', () => {
      const cmd = memoryCommand?.commands.find((c) => c.name() === 'search')
      const opts = cmd?.options ?? []
      const squadOpt = opts.find((o) => o.long === '--squad')
      expect(squadOpt).toBeDefined()
      expect(squadOpt?.required).toBe(true)
    })

    it('patch requires --match and --replace options', () => {
      const cmd = memoryCommand?.commands.find((c) => c.name() === 'patch')
      const opts = cmd?.options ?? []

      const matchOpt = opts.find((o) => o.long === '--match')
      expect(matchOpt).toBeDefined()
      expect(matchOpt?.required).toBe(true)

      const replaceOpt = opts.find((o) => o.long === '--replace')
      expect(replaceOpt).toBeDefined()
      expect(replaceOpt?.required).toBe(true)
    })
  })
})

describe('managed memory status output', () => {
  it.each([false, true])('preserves hidden-pending counts and reasons (JSON=%s)', async (json) => {
    const status = { managedGitHub: { hiddenPendingReindex: 3, reasons: { stale: 1, legacy: 2 } } }
    const get = apiGet as ReturnType<typeof mock>
    const mode = isJsonMode as ReturnType<typeof mock>
    const print = output as ReturnType<typeof mock>
    const log = spyOn(console, 'log').mockImplementation(() => {})
    get.mockResolvedValue(status)
    mode.mockReturnValue(json)
    print.mockClear()
    try {
      const program = new Command()
      registerMemoryCommands(program)
      await program.parseAsync(['memory', 'sync', 'status', '--squad', 'synthetic-squad'], { from: 'user' })
      expect(get).toHaveBeenCalledWith('/api/memory/synthetic-squad/sync/status')
      if (json) expect(print).toHaveBeenCalledWith(status)
      else {
        expect(log).toHaveBeenCalledWith('GitHub documents hidden pending reindex: 3')
        expect(log).toHaveBeenCalledWith('  stale: 1')
        expect(log).toHaveBeenCalledWith('  legacy: 2')
      }
    } finally {
      get.mockReset().mockResolvedValue({})
      mode.mockReset().mockReturnValue(false)
      log.mockRestore()
    }
  })
})
