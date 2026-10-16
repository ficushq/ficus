import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TrustTargetSpec } from '../../ssh-trust'
import { buildGitSshCommand, GitAdapter } from './GitAdapter'

const originalHome = process.env.HOME_DIR
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'git-adapter-test-'))
  process.env.HOME_DIR = home
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
})

const config = {
  type: 'git' as const,
  repoUrl: 'git@git.example.com:org/memory.git',
  branch: 'main',
  sshKeyName: 'deploy',
  autoPull: false,
  autoPush: false,
}

describe('GitAdapter host-key pinning', () => {
  it('builds an ssh command that checks strictly against the pin only, every word quoted', () => {
    const command = buildGitSshCommand("/keys/it's", { knownHostsPath: '/pins/kh', alias: 'ficus-trust.abc' })
    expect(command).toStartWith("'ssh' '-i' '/keys/it'\\''s'")
    expect(command).toContain("'-o' 'StrictHostKeyChecking=yes'")
    expect(command).toContain("'-o' 'UserKnownHostsFile=/pins/kh'")
    expect(command).toContain("'-o' 'HostKeyAlias=ficus-trust.abc'")
    expect(command).toContain("'-o' 'GlobalKnownHostsFile=/dev/null'")
    expect(command).not.toContain('accept-new')
  })

  it("never runs git when the remote's host key is not trusted, and pins per squad and host", async () => {
    const seen: TrustTargetSpec[] = []
    const adapter = new GitAdapter('squad-1', config, {
      resolveHostKeyPin: async (spec) => {
        seen.push(spec)
        throw new Error('ficus: SSH to Memory sync (git.example.com:22) refused')
      },
    })

    const result = await adapter.initialize()

    expect(result).toEqual({ success: false, error: 'ficus: SSH to Memory sync (git.example.com:22) refused' })
    expect(seen).toEqual([
      expect.objectContaining({ scope: 'memory-git:squad-1:git.example.com', kind: 'memory-git', squadId: 'squad-1' }),
    ])
    expect(existsSync(join(home, 'memory'))).toBe(true) // memory dir created, but nothing cloned into it
    expect(await adapter.isInitialized()).toBe(false)
  })
})
