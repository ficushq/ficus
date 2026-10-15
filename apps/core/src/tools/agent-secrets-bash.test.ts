/**
 * Per-agent secrets reach ONLY the agent's own bash: its sandbox's secrets file
 * is sourced per command, squad_bash (the squad box) never sources one, and a
 * revoked (deleted) file leaves the next command without the variable.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { K8sSandboxManager } from '../services/sandbox/k8s/manager'
import { withAgentSecretsSourced } from '../services/sandbox/agent-secrets-file'
import { agentOwnBashSecretsPath, createK8sSandboxedBashTool, createK8sSandboxedCodingTools } from './sandbox-tools'

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

describe('agent bash and per-agent secrets', () => {
  test('only an agent’s own box sources a secrets file', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker'
    expect(agentOwnBashSecretsPath(AGENT_SANDBOX)).toBe('/private/.ficus/agent-secrets.env')
    expect(agentOwnBashSecretsPath('agent_not-a-uuid')).toBeUndefined()
    expect(agentOwnBashSecretsPath('squad_s1')).toBeUndefined()
    expect(agentOwnBashSecretsPath('system_manager_u1')).toBeUndefined()
    expect(agentOwnBashSecretsPath('consultants_s1')).toBeUndefined()
  })

  test('on vm the path is the agent box user’s own private dir', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    expect(agentOwnBashSecretsPath(AGENT_SANDBOX)).toMatch(/^\/home\/[^/]+\/\.private\/\.ficus\/agent-secrets\.env$/)
  })

  test('the agent’s bash tool sources its file; a squad_bash-style tool does not', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker'
    const commands: string[] = []
    const manager = recordingManager(commands)

    const agentTools = createK8sSandboxedCodingTools('/unused', AGENT_SANDBOX, manager, 'token', 'squad-1')
    await runBashTool(agentTools.find((tool) => tool.key === 'bash')! as never, 'echo "$SYNTH_KEY"')
    // squad_bash builds its tool for the squad box without a secrets path.
    const squadBash = createK8sSandboxedBashTool('/workspace/squad-1', 'squad_squad-1', manager, 'token')
    await runBashTool(squadBash as never, 'echo "$SYNTH_KEY"')

    expect(commands[0]).toBe(withAgentSecretsSourced('echo "$SYNTH_KEY"', '/private/.ficus/agent-secrets.env'))
    expect(commands[1]).toBe('echo "$SYNTH_KEY"')
  })

  test('the sourced file sets variables for that command only, and a removed file sets none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-secrets-bash-'))
    try {
      const file = join(dir, 'agent-secrets.env')
      writeFileSync(file, "export SYNTH_KEY='synthetic it'\"'\"'s value'\n", { mode: 0o600 })
      const run = (command: string) => {
        const result = Bun.spawnSync(['bash', '-c', withAgentSecretsSourced(command, file)], {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        })
        return { stdout: result.stdout.toString(), exitCode: result.exitCode }
      }
      expect(run('printf %s "$SYNTH_KEY"')).toEqual({ stdout: "synthetic it's value", exitCode: 0 })
      // Exported for child processes too.
      expect(run('bash -c \'printf %s "$SYNTH_KEY"\'').stdout).toBe("synthetic it's value")

      rmSync(file)
      // Revoked: the next command has no value and the prefix leaves $? at 0.
      expect(run('printf %s:%s "${SYNTH_KEY:-unset}" "$?"')).toEqual({ stdout: 'unset:0', exitCode: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
