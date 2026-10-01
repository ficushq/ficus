import { describe, expect, it } from 'bun:test'
import { publishPrewarmedNixCache } from './nix-cache'
import { boxUnixUser } from './box-paths'
import type { Machine } from './queries'
import type { SshRunner } from './ssh'

describe('prewarmed Nix object publication', () => {
  const machine = { id: 'machine-test' } as Machine
  it('publishes only from the dedicated prewarmer with a bounded SSH call', async () => {
    const sandboxId = 'devbox-prewarm-agent-machine-test'
    const calls: unknown[] = []
    const runner: SshRunner = {
      run: async (...args) => {
        calls.push(args)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    await publishPrewarmedNixCache(machine, sandboxId, runner)
    expect(calls).toEqual([
      [
        machine,
        `sudo bash /opt/ficus/bin/box-provision.sh --publish-nix-cache --sandbox-id '${sandboxId}' --unix-user '${boxUnixUser(sandboxId)}'`,
        { timeoutMs: 180_000 },
      ],
    ])
  })
  it('rejects ordinary boxes and command injection before SSH', async () => {
    let calls = 0
    const runner: SshRunner = {
      run: async () => {
        calls++
        throw new Error('must not run')
      },
    }
    for (const id of ['agent_custom', 'squad_custom', "devbox-prewarm-agent-x'; echo bad", 'devbox-prewarm-agent-']) {
      await expect(publishPrewarmedNixCache(machine, id, runner)).rejects.toThrow('dedicated devbox prewarmer')
    }
    expect(calls).toBe(0)
  })
  it('reports publication failure so the prewarm lifecycle can clean up and retry', async () => {
    await expect(
      publishPrewarmedNixCache(machine, 'devbox-prewarm-squad-machine-test', {
        run: async () => ({ exitCode: 1, stdout: '', stderr: 'pack verification failed' }),
      })
    ).rejects.toThrow('pack verification failed')
  })
})
