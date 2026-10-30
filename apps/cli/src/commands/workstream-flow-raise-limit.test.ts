import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { registerWorkstreamFlowCommands } from './workstream-flow'

/** A synthetic flow paused at its attempt limit for step build (one of one attempts used). */
const pausedFlow = {
  version: 4,
  state: {
    status: 'paused',
    pauseReason: { type: 'attempt-limit', stepId: 'build' },
    activeAttemptId: null,
    attempts: [{ id: 1, stepId: 'build', status: 'completed' }],
    definition: { steps: [{ id: 'build', name: 'Build' }], limits: { maxStepAttempts: 1 } },
  },
}

async function runCli(args: string[], flow: unknown = pausedFlow) {
  const calls: Array<{ path: string; body: unknown }> = []
  const messages: Array<string | undefined> = []
  const program = new Command().exitOverride()
  registerWorkstreamFlowCommands(program.command('workstream').alias('ws'), {
    apiGet: async () => flow as never,
    apiPost: async (path, body) => {
      calls.push({ path, body })
      return { version: 5, stateStatus: 'running', activeAttemptId: 2 } as never
    },
    output: (_data, message) => messages.push(message),
    outputError: (error) => {
      throw error
    },
  })
  await program.parseAsync(['ws', 'raise-limit', '974', ...args], { from: 'user' })
  return { calls, messages }
}

test('raise-limit sends a typed raise-limit command at the current flow version', async () => {
  const { calls, messages } = await runCli(['--max-step-attempts', '5', '-m', 'More review rounds'])
  expect(calls).toHaveLength(1)
  expect(calls[0]!.path).toBe('/api/workflows/runs/974/advance')
  expect(calls[0]!.body).toMatchObject({
    command: { action: 'raise-limit', expectedVersion: 4, maxStepAttempts: 5, reason: 'More review rounds' },
  })
  expect(messages).toEqual(['Raised the attempt limit for step build to 5; its next attempt is starting'])
})

test('raise-limit --remove sends null to remove the limit, at an explicit version', async () => {
  const { calls, messages } = await runCli(['--remove', '--version', '4'])
  expect(calls[0]!.body).toMatchObject({
    command: { action: 'raise-limit', expectedVersion: 4, maxStepAttempts: null },
  })
  expect(messages).toEqual(['Removed the attempt limit for step build; its next attempt is starting'])
})

test('raise-limit needs exactly one choice and a paused flow', async () => {
  await expect(runCli([])).rejects.toThrow('exactly one of --max-step-attempts')
  await expect(runCli(['--remove', '--max-step-attempts', '3'])).rejects.toThrow('exactly one')
  await expect(runCli(['--max-step-attempts', 'many'])).rejects.toThrow('positive whole number')
  await expect(
    runCli(['--max-step-attempts', '3'], { ...pausedFlow, state: { ...pausedFlow.state, status: 'running' } })
  ).rejects.toThrow('not paused at an attempt limit')
})
