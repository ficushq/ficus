import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DockerSandboxManager } from './manager'

const squad = '11111111-2222-4333-8444-555555555555'
for (const [sandboxId, owner] of [
  [`squad_${squad}`, undefined],
  ['agent_worker_fixture', squad],
] as const) {
  test(`Docker command env supplies squad context for ${sandboxId}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'docker-squad-context-'))
    try {
      const manager = {
        sandboxes: new Map([
          [sandboxId, { workspacePath: root, workspaceMount: root, containerId: 'fixture', squadId: owner }],
        ]),
        getSandboxUserArgs: () => [],
      }
      const hook = DockerSandboxManager.prototype.getSpawnHook.call(manager as any, sandboxId, root, 'synthetic-agent')!
      const result = hook({ command: 'ficus integration exec vercel -- npm run deploy', cwd: root, env: {} })
      expect(result.command).toContain(`-e FICUS_SQUAD_ID=${squad}`)
      expect(result.command).toContain('-e FICUS_TOKEN=synthetic-agent')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('Docker solo command context never invents a squad or identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'docker-solo-context-'))
  try {
    const manager = {
      sandboxes: new Map([['solo', { workspacePath: root, workspaceMount: root, containerId: 'fixture' }]]),
      getSandboxUserArgs: () => [],
    }
    const hook = DockerSandboxManager.prototype.getSpawnHook.call(manager as any, 'solo', root)!
    const result = hook({ command: 'true', cwd: root, env: {} })
    expect(result.command).not.toContain('FICUS_SQUAD_ID=')
    expect(result.command).not.toContain('FICUS_TOKEN=')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
