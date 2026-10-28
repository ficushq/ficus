/** Retired private files must never be sourced by agent or shared Bash tools. */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'
import type { K8sSandboxManager } from '../services/sandbox/k8s/manager'
import { createK8sSandboxedBashTool, createK8sSandboxedCodingTools } from './sandbox-tools'

const AGENT_SANDBOX = 'agent_33333333-3333-4333-8333-333333333333'
const originalRuntime = process.env.FICUS_SANDBOX_RUNTIME
afterEach(() => {
  if (originalRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = originalRuntime
})

function recordingManager(commands: string[]): K8sSandboxManager {
  return {
    getClientForSandbox: mock(() => ({
      bash: (request: { command: string }) => {
        commands.push(request.command)
        const emitter = new EventEmitter()
        const stream = {
          invocationId: 'test',
          on: (event: string, listener: (...args: unknown[]) => void) => {
            emitter.on(event, listener)
            return stream
          },
          cancel: () => {},
          cancelAndWait: async () => {},
        }
        queueMicrotask(() => {
          emitter.emit('data', { exitCode: 0 })
          emitter.emit('end')
        })
        return stream
      },
    })),
    getSandboxStatus: mock(async () => ({ status: 'running' })),
    resolveToolApiUrl: () => 'http://127.0.0.1:1234',
  } as unknown as K8sSandboxManager
}

async function runBashTool(tool: { execute: (...args: unknown[]) => Promise<unknown> }, command: string) {
  await tool.execute('call-1', { command }, undefined, () => {})
}

describe('agent bash exposure retirement', () => {
  test('neither agent bash nor squad bash sources the retired file', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker'
    const commands: string[] = []
    const manager = recordingManager(commands)

    const agentTools = createK8sSandboxedCodingTools('/unused', AGENT_SANDBOX, manager, 'token', 'squad-1')
    await runBashTool(agentTools.find((tool) => tool.key === 'bash')! as never, 'echo "$SYNTH_KEY"')
    // squad_bash builds its tool for the squad box without a secrets path.
    const squadBash = createK8sSandboxedBashTool('/workspace/squad-1', 'squad_squad-1', manager, 'token')
    await runBashTool(squadBash as never, 'echo "$SYNTH_KEY"')

    expect(commands[0]).toBe('echo "$SYNTH_KEY"')
    expect(commands[1]).toBe('echo "$SYNTH_KEY"')
  })
})
