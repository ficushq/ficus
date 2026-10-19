import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Command } from 'commander'
import { apiDelete, apiGet, apiPost, apiPut } from '../client'
import { output, setOutputOptions } from '../output'
import { commitSigningLines, readCredentialFromStdin, registerIntegrationCommands } from './integration'

type AnyMock = ReturnType<typeof mock>

async function run(args: string[], credential = 'stdin-secret'): Promise<void> {
  const program = new Command().exitOverride()
  program.option('--quiet')
  program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
  registerIntegrationCommands(program, { readCredential: async () => credential })
  await program.parseAsync(['--quiet', ...args], { from: 'user' })
}

beforeEach(() => {
  for (const fn of [apiGet, apiPost, apiPut, apiDelete] as AnyMock[]) {
    fn.mockClear()
    fn.mockResolvedValue({})
  }
})

test('help selects a local binding without tokens or transcript controls', () => {
  const program = new Command().exitOverride()
  registerIntegrationCommands(program)
  const integration = program.commands.find((command) => command.name() === 'integration')!
  const create = integration.commands.find((command) => command.name() === 'create')!.helpInformation()
  expect(create).toContain('--local-binding')
  expect(create).not.toContain('--api-base')
  expect(create).not.toContain('--credential-stdin')
  expect(integration.commands.some((command) => command.name().startsWith('export-'))).toBe(false)
})

describe('commit signing visibility', () => {
  const on = {
    state: 'on',
    login: 'octo',
    signsFor: ['7+octo@users.noreply.github.com', 'octo@example.com'],
    fingerprint: 'SHA256:abc',
  }

  test('list --squad reads the accounts attached to that squad', async () => {
    await run(['integration', 'list', '--provider', 'github', '--squad', 'squad-1'])
    expect(apiGet).toHaveBeenCalledWith('/api/squads/squad-1/integrations/github')
  })

  test('list and get print each GitHub account’s signing state and the emails it signs for', async () => {
    const connections = [
      { id: 'c1', commitSigning: on },
      { id: 'c2', commitSigning: { state: 'needs_attention', login: 'hubot', signsFor: [] } },
      { id: 'c3', commitSigning: { state: 'off', login: 'idle', signsFor: [] } },
    ]
    ;(apiGet as AnyMock).mockResolvedValue(connections)
    ;(output as AnyMock).mockClear()
    await run(['integration', 'list', '--provider', 'github'])
    const lines = [
      'Commit signing:',
      '  @octo: on, signs commits committed as 7+octo@users.noreply.github.com, octo@example.com [connection c1]',
      '  @hubot: needs attention [connection c2]',
      '  @idle: off [connection c3]',
    ]
    expect((output as AnyMock).mock.calls).toEqual([[connections], [lines, lines.join('\n')]])
    expect(commitSigningLines(connections[0])).toEqual(lines.slice(0, 2))
    expect(commitSigningLines([{ id: 'b1', providerKey: 'bigbrain' }])).toEqual([])
  })

  test('a squad shows which attached accounts it signs as and which is the default', () => {
    expect(
      commitSigningLines({
        providerKey: 'github',
        commitSigning: {
          defaultConnectionId: 'c1',
          accounts: [
            { ...on, connectionId: 'c1', isDefault: true },
            { state: 'off', login: 'hubot', signsFor: [], connectionId: 'c2', isDefault: false },
          ],
        },
      })
    ).toEqual([
      'Commit signing (the committer email chooses the account; an account that is off leaves its commits unsigned; emails of no attached account are refused):',
      '  @octo (squad default): on, signs commits committed as 7+octo@users.noreply.github.com, octo@example.com [connection c1]',
      '  @hubot: off [connection c2]',
    ])
    expect(
      commitSigningLines({ providerKey: 'github', commitSigning: { defaultConnectionId: null, accounts: [] } })
    ).toEqual(['Commit signing: no GitHub account is attached to this squad.'])
  })
})

describe('global connection lifecycle paths', () => {
  test('list is provider-filtered and get is global', async () => {
    await run(['integration', 'list', '--provider', 'bigbrain'])
    expect(apiGet).toHaveBeenCalledWith('/api/integrations/connections?provider=bigbrain')
    await run(['integration', 'get', 'connection-1'])
    expect(apiGet).toHaveBeenCalledWith('/api/integrations/connections/connection-1')
  })

  test('local selection and unrelated credential rotation use explicit endpoints', async () => {
    await run(['integration', 'local-bindings', 'bigbrain'])
    expect(apiGet).toHaveBeenCalledWith('/api/integrations/providers/bigbrain/local-bindings')
    await run(['integration', 'create', 'bigbrain', '--local-binding', 'personal', '--display-name', 'Memory'])
    expect(apiPost).toHaveBeenCalledWith('/api/integrations/providers/bigbrain/local-connections', {
      bindingId: 'personal',
      displayName: 'Memory',
    })

    await run(
      ['integration', 'credential', 'connection-1', '--credential-stdin', '--confirm-assigned'],
      'rotate-secret'
    )
    expect(apiPut).toHaveBeenCalledWith('/api/integrations/connections/connection-1/credential', {
      credential: 'rotate-secret',
      confirmAssigned: true,
    })
  })

  test.each(['validate', 'enable'] as const)('%s uses the global lifecycle route', async (action) => {
    await run(['integration', action, 'connection-1'])
    expect(apiPost).toHaveBeenCalledWith(`/api/integrations/connections/connection-1/${action}`, {})
  })

  test('used disable and removal require an explicit confirmation flag', async () => {
    await run(['integration', 'disable', 'connection-1', '--confirm-assigned'])
    expect(apiPost).toHaveBeenCalledWith('/api/integrations/connections/connection-1/disable', {
      confirmAssigned: true,
    })
    await run(['integration', 'remove', 'connection-1', '--confirm-assigned'])
    expect(apiDelete).toHaveBeenCalledWith('/api/integrations/connections/connection-1?confirmAssigned=true')
  })
})

test('stdin credential reader enforces a bounded payload and trims only trailing line endings', async () => {
  const bytes = (value: string) => new TextEncoder().encode(value)
  async function* stream(...chunks: Uint8Array[]) {
    yield* chunks
  }

  await expect(readCredentialFromStdin(stream(bytes('secret'), bytes('\r\n')))).resolves.toBe('secret')
  await expect(readCredentialFromStdin(stream(new Uint8Array(16 * 1024)))).resolves.toHaveLength(16 * 1024)
  await expect(readCredentialFromStdin(stream(new Uint8Array(16 * 1024 + 1)))).rejects.toThrow(
    'Credential exceeds maximum length'
  )
})

test('assign and unassign use explicit squad assignment routes', async () => {
  await run([
    'integration',
    'assign',
    'bigbrain',
    '--squad',
    'squad-1',
    '--connection',
    '00000000-0000-4000-8000-000000000001',
  ])
  expect(apiPut).toHaveBeenCalledWith('/api/squads/squad-1/integrations/bigbrain/assignment', {
    connectionId: '00000000-0000-4000-8000-000000000001',
  })
  await run(['integration', 'unassign', 'bigbrain', '--squad', 'squad-1'])
  expect(apiDelete).toHaveBeenCalledWith('/api/squads/squad-1/integrations/bigbrain/assignment')
})

test('outputs lists the provider event catalog', async () => {
  await run(['integration', 'outputs'])
  expect(apiGet).toHaveBeenCalledWith('/api/integrations/outputs')
})
