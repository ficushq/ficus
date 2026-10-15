import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet, apiPost } from './client'
import { ApiRequestError } from './client-errors'
import { outputError } from './output'
import { registerAgentCommands } from './commands/agent'
import { registerInboxCommands } from './commands/inbox'
import { explainDormantRecipient } from './dormant-agent'

const AGENT_ID = '1da91e9c-0000-4000-8000-000000000001'
const post = apiPost as ReturnType<typeof mock>
const get = apiGet as ReturnType<typeof mock>
const fail = outputError as ReturnType<typeof mock>

const dormantError = () =>
  new ApiRequestError(`Agent ${AGENT_ID.slice(0, 8)} is dormant. Re-send with wake: true`, 409, 'AGENT_DORMANT')

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerAgentCommands(program)
  registerInboxCommands(program)
  await program.parseAsync(args, { from: 'user' })
}

const commands: Array<{ name: string; args: string[]; path: string }> = [
  { name: 'inbox send', args: ['inbox', 'send', AGENT_ID, 'PR merged'], path: '/api/inbox' },
  { name: 'agent message', args: ['agent', 'message', AGENT_ID, 'hello'], path: `/api/agents/${AGENT_ID}/message` },
  { name: 'agent steer', args: ['agent', 'steer', AGENT_ID, 'hello'], path: `/api/agents/${AGENT_ID}/steer` },
  {
    name: 'agent follow-up',
    args: ['agent', 'follow-up', AGENT_ID, 'hello'],
    path: `/api/agents/${AGENT_ID}/follow-up`,
  },
]

describe('sending to a dormant agent', () => {
  beforeEach(() => {
    post.mockReset()
    get.mockReset()
    fail.mockClear()
  })

  afterEach(() => {
    // Restore the preload defaults for later files.
    post.mockReset().mockImplementation(() => Promise.resolve({}))
    get.mockReset().mockImplementation(() => Promise.resolve({}))
  })

  for (const { name, args, path } of commands) {
    it(`${name} explains the refusal and points at --wake`, async () => {
      post.mockRejectedValue(dormantError())
      get.mockResolvedValue({ id: AGENT_ID, metadata: { name: 'Engineer 3' } })

      await run(args)

      expect(post.mock.calls[0]?.[0]).toBe(path)
      expect(post.mock.calls[0]?.[1]).not.toHaveProperty('wake')
      expect(get).toHaveBeenCalledWith(`/api/agents/${AGENT_ID}`)
      expect(fail).toHaveBeenCalledTimes(1)
      expect((fail.mock.calls[0]?.[0] as Error).message).toBe(
        'Agent 1da91e9c (Engineer 3) is dormant. Its work is finished; sending will wake it and restart its sandbox. ' +
          'Re-run with --wake to send anyway.'
      )
    })

    it(`${name} --wake asks the server to wake the agent`, async () => {
      post.mockResolvedValue({ id: 'message-12345678', success: true })

      await run([...args, '--wake'])

      expect(post.mock.calls[0]?.[0]).toBe(path)
      expect(post.mock.calls[0]?.[1]).toMatchObject({ wake: true })
      expect(fail).not.toHaveBeenCalled()
    })

    it(`${name} documents --wake in its help`, () => {
      const program = new Command()
      registerAgentCommands(program)
      registerInboxCommands(program)
      const [group, sub] = args
      const command = program.commands.find((c) => c.name() === group)?.commands.find((c) => c.name() === sub)
      expect(command?.options.find((option) => option.long === '--wake')?.description).toContain('dormant')
      expect(command?.description()).toContain('--wake')
    })
  }
})

describe('explainDormantRecipient', () => {
  beforeEach(() => get.mockReset())
  afterEach(() => get.mockReset().mockImplementation(() => Promise.resolve({})))

  it('falls back to the id when the caller cannot read the agent', async () => {
    get.mockRejectedValue(new ApiRequestError('Forbidden', 403))
    const explained = (await explainDormantRecipient(dormantError(), AGENT_ID)) as Error
    expect(explained.message).toStartWith('Agent 1da91e9c is dormant.')
    expect(explained.message).toContain('--wake')
  })

  it('passes other errors through unchanged', async () => {
    const terminated = new ApiRequestError('Agent is terminated', 409, 'AGENT_TERMINATED')
    const plain = new Error('network down')
    expect(await explainDormantRecipient(terminated, AGENT_ID)).toBe(terminated)
    expect(await explainDormantRecipient(plain, AGENT_ID)).toBe(plain)
    expect(get).not.toHaveBeenCalled()
  })
})
