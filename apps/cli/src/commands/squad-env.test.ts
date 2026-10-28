import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet } from '../client'
import { setOutputOptions } from '../output'
import { registerSquadEnvCommands } from './squad-env'

describe('squad-env CLI commands', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockClear()
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerSquadEnvCommands(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }

  it('reads custom environment content without any exposure metadata', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({ content: 'CUSTOM=synthetic' })
    await run(['squad-env', 'get', 'squad-1'])
    expect(apiGet).toHaveBeenCalledWith('/api/squads/workspace/squad-1/env')
  })
})
