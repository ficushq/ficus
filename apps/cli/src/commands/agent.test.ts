import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Command } from 'commander'
import { apiGet, apiPatch } from '../client'
import { output, outputError, setOutputOptions } from '../output'
import { registerAgentCommands } from './agent'

describe('ficus agent model subcommand', () => {
  beforeEach(() => {
    ;(apiPatch as ReturnType<typeof mock>).mockClear()
    ;(outputError as ReturnType<typeof mock>).mockClear()
    ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({
      id: '33333333-3333-3333-3333-333333333333',
      modelOverride: null,
      configuredModel: 'anthropic:claude-sonnet-4-5',
    })
  })

  afterEach(() => {
    mock.restore()
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerAgentCommands(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }

  it('patches modelOverride with the spec for `ficus agent model <id> <spec>`', async () => {
    await run(['agent', 'model', 'agent-123', 'zai:glm-5.2:high'])

    expect(apiPatch).toHaveBeenCalledWith('/api/agents/agent-123', {
      modelOverride: 'zai:glm-5.2:high',
    })
  })

  it('accepts a comma-separated fallback priority list', async () => {
    await run(['agent', 'model', 'agent-123', 'zai:glm-5.2:high,anthropic:claude-sonnet-4-5'])

    expect(apiPatch).toHaveBeenCalledWith('/api/agents/agent-123', {
      modelOverride: 'zai:glm-5.2:high,anthropic:claude-sonnet-4-5',
    })
  })

  it('clears the override with --clear (modelOverride: null)', async () => {
    await run(['agent', 'model', 'agent-123', '--clear'])

    expect(apiPatch).toHaveBeenCalledWith('/api/agents/agent-123', { modelOverride: null })
  })

  it('supports the -c short flag for --clear', async () => {
    await run(['agent', 'model', 'agent-123', '-c'])

    expect(apiPatch).toHaveBeenCalledWith('/api/agents/agent-123', { modelOverride: null })
  })

  it('errors when neither a spec nor --clear is provided', async () => {
    await run(['agent', 'model', 'agent-123'])

    expect(outputError).toHaveBeenCalled()
    expect(apiPatch).not.toHaveBeenCalled()
  })

  it('errors when both a spec and --clear are provided', async () => {
    await run(['agent', 'model', 'agent-123', 'zai:glm-5.2:high', '--clear'])

    expect(outputError).toHaveBeenCalled()
    expect(apiPatch).not.toHaveBeenCalled()
  })
})

describe('ficus agent active subcommand', () => {
  afterEach(() => mock.restore())

  it('prints the generic waiting-sandbox API response including sanitized recovery status', async () => {
    const response = {
      active: true,
      executionId: 'exec-1',
      status: 'waiting-sandbox',
      sandboxRecovery: {
        reason: 'capacity',
        nextAttemptAt: '2026-08-09T00:00:05.000Z',
        deadlineAt: '2026-08-09T00:15:00.000Z',
        attemptCount: 1,
        maxAttempts: 8,
      },
    }
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(response)
    ;(output as ReturnType<typeof mock>).mockClear()
    const program = new Command()
    program.exitOverride()
    registerAgentCommands(program)

    await program.parseAsync(['agent', 'active', 'agent-1'], { from: 'user' })

    expect(apiGet).toHaveBeenCalledWith('/api/agents/agent-1/active')
    expect(output).toHaveBeenCalledWith(response)
  })
})

describe('ficus agent worker-log', () => {
  it('names each tool call by the toolName stored on the message block', async () => {
    const get = apiGet as ReturnType<typeof mock>
    get.mockReset().mockImplementation(async (path: string) =>
      path.startsWith('/api/agents/agent-1/messages')
        ? {
            messages: [
              {
                createdAt: '2026-09-29T04:53:35.000Z',
                content: '',
                metadata: {
                  content: [
                    {
                      type: 'tool_use',
                      toolCall: {
                        toolName: 'delegate_task',
                        args: '{"request":"audit"}',
                        result: '{"delivered":true}',
                      },
                    },
                  ],
                },
              },
            ],
            pagination: {},
          }
        : { metadata: { name: 'Assistant' }, agentTypeId: 'assistant' }
    )
    const lines: string[] = []
    const log = spyOn(console, 'log').mockImplementation((line?: unknown) => void lines.push(String(line ?? '')))
    try {
      const program = new Command().exitOverride()
      registerAgentCommands(program)
      await program.parseAsync(['agent', 'worker-log', 'agent-1'], { from: 'user' })
    } finally {
      log.mockRestore()
      get.mockReset().mockResolvedValue({})
    }
    expect(lines.some((line) => line.endsWith('🔧 delegate_task'))).toBe(true)
    expect(lines.some((line) => line.includes('undefined'))).toBe(false)
  })
})
