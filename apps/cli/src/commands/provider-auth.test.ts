import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiPost } from '../client'
import { output } from '../output'
import { registerProviderAuthCommands } from './provider-auth'

type AnyMock = ReturnType<typeof mock>

function makeRunner(register: (program: Command) => void) {
  return async (args: string[]): Promise<void> => {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    register(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }
}

const run = makeRunner(registerProviderAuthCommands)

describe('ficus provider-auth reset', () => {
  const summary = { provider: 'anthropic', health: 'available', retryAt: undefined, accounts: [] }

  beforeEach(() => {
    ;(apiPost as AnyMock).mockClear()
    ;(apiPost as AnyMock).mockResolvedValue(summary)
    ;(output as AnyMock).mockClear()
  })

  it('clears a whole provider and prints the refreshed health', async () => {
    await run(['provider-auth', 'reset', 'anthropic'])
    expect(apiPost).toHaveBeenCalledWith('/api/provider-auth/anthropic/health/reset')
    expect(output).toHaveBeenCalledWith(summary, expect.stringContaining('anthropic'))
  })

  it('scopes the reset to one account with --account', async () => {
    await run(['provider-auth', 'reset', 'anthropic', '--account', 'acct_1'])
    expect(apiPost).toHaveBeenCalledWith('/api/provider-auth/anthropic/accounts/acct_1/health/reset')
  })
})
