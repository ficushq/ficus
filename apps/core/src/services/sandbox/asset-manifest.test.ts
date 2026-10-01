/**
 * Tests for the shared per-sandbox asset manifest.
 *
 * `resolveSandboxAssets` scope rules (extracted from vm file-sync's
 * `syncBoxFiles`, the source of truth for the asset set):
 *   - solo AGENT:    skills + identity                      (no squad assets)
 *   - squad MEMBER:  skills + squad-env + identity + ssh    (NO memory — squad
 *                    memory lives only in the squad box)
 *   - squad BOX:     skills + squad-env + memory + ssh      (NO identity — a
 *                    shared box has no single agent identity)
 *
 * Sources are scope-pure (path computation only), so these tests never touch
 * the filesystem: `files()` is deliberately NOT called here.
 */

import { describe, expect, test } from 'bun:test'
import {
  SANDBOX_ASSETS,
  resolveSandboxAssets,
  sshFileMode,
  type AssetContext,
  type AssetSource,
  type SandboxAsset,
} from './asset-manifest'

const names = (resolved: Array<{ asset: SandboxAsset; source: AssetSource }>) => resolved.map((r) => r.asset.name)

describe('SANDBOX_ASSETS', () => {
  test('declares the 5 assets in vm push order (secrets-last convention)', () => {
    expect(SANDBOX_ASSETS.map((a) => a.name)).toEqual(['skills', 'squad-env', 'identity', 'memory', 'squad-ssh'])
  })

  test('secret-bearing assets are mode 0600', () => {
    const byName = new Map(SANDBOX_ASSETS.map((a) => [a.name, a]))
    expect(byName.get('squad-env')?.mode).toBe('0600')
    expect(byName.get('identity')?.mode).toBe('0600')
  })

  test('the squad env lands in the workspace .ficus dir', () => {
    const byName = new Map(SANDBOX_ASSETS.map((a) => [a.name, a]))
    expect(byName.get('squad-env')?.dest).toEqual({ base: 'workspace', relPath: '.ficus/.env' })
  })
})

describe('sshFileMode', () => {
  test('non-secret ssh metadata is 0644; private keys are 0600', () => {
    expect(sshFileMode('config')).toBe('0644')
    expect(sshFileMode('known_hosts')).toBe('0644')
    expect(sshFileMode('id_ed25519.pub')).toBe('0644')
    expect(sshFileMode('id_ed25519')).toBe('0600')
  })
})

describe('resolveSandboxAssets scope rules', () => {
  test('solo agent yields skills + identity, in manifest order', async () => {
    const ctx: AssetContext = { sandboxId: 'agent_a1', role: 'agent' }
    expect(names(await resolveSandboxAssets(ctx))).toEqual(['skills', 'identity'])
  })

  test('system-manager (no squad) yields skills + identity', async () => {
    const ctx: AssetContext = { sandboxId: 'system_manager_u1', role: 'system-manager' }
    expect(names(await resolveSandboxAssets(ctx))).toEqual(['skills', 'identity'])
  })

  test('squad member yields skills + squad-env + identity + ssh (no memory)', async () => {
    const ctx: AssetContext = { sandboxId: 'agent_a1', squadId: '11111111-1111-4111-8111-111111111111', role: 'agent' }
    expect(names(await resolveSandboxAssets(ctx))).toEqual(['skills', 'squad-env', 'identity', 'squad-ssh'])
  })

  test('squad box yields skills + squad-env + memory + ssh (no identity)', async () => {
    const ctx: AssetContext = {
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      squadId: '11111111-1111-4111-8111-111111111111',
      role: 'squad',
    }
    expect(names(await resolveSandboxAssets(ctx))).toEqual(['skills', 'squad-env', 'memory', 'squad-ssh'])
  })

  test('squad box derives squadId from the sandboxId prefix when ctx omits it (mirrors syncBoxFiles)', async () => {
    const ctx: AssetContext = { sandboxId: 'squad_11111111-1111-4111-8111-111111111111', role: 'squad' }
    expect(names(await resolveSandboxAssets(ctx))).toEqual(['skills', 'squad-env', 'memory', 'squad-ssh'])
  })
})

describe('resolveSandboxAssets mechanics (fake sources)', () => {
  const fakeSource: AssetSource = { hostPath: '/tmp/fake', files: async () => [] }
  const fakeAsset = (name: string, source: SandboxAsset['source']): SandboxAsset => ({
    name,
    dest: { base: 'home', relPath: name },
    mode: '0644',
    scope: 'agent',
    required: false,
    source,
  })

  test('an asset whose source returns null is dropped; order is preserved', async () => {
    const assets = [
      fakeAsset('first', async () => fakeSource),
      fakeAsset('dropped', async () => null),
      fakeAsset('last', async () => fakeSource),
    ]
    const resolved = await resolveSandboxAssets({ sandboxId: 'agent_a1', role: 'agent' }, assets)
    expect(names(resolved)).toEqual(['first', 'last'])
    expect(resolved[0]?.source).toBe(fakeSource)
  })
})

describe('resolved sources point at the materializer locations', () => {
  test('squad member: hostPaths and pvc subPath keys mirror file-sync/pod-spec', async () => {
    const ctx: AssetContext = { sandboxId: 'agent_a1', squadId: '11111111-1111-4111-8111-111111111111', role: 'agent' }
    const byName = new Map((await resolveSandboxAssets(ctx)).map((r) => [r.asset.name, r.source]))

    const skills = byName.get('skills')
    expect(skills?.hostPath.endsWith('skills/sandboxes/agent-a1')).toBe(true)
    expect(skills?.pvcSubPath).toBe('skills/sandboxes/agent-a1')

    const squadEnv = byName.get('squad-env')
    expect(squadEnv?.hostPath.endsWith('11111111-1111-4111-8111-111111111111/.ficus/.env')).toBe(true)
    expect(squadEnv?.pvcSubPath).toBeUndefined()

    const identity = byName.get('identity')
    expect(identity?.hostPath.endsWith('private/agent_a1/.ficus/identity.pem')).toBe(true)
    expect(identity?.pvcSubPath).toBeUndefined()

    const ssh = byName.get('squad-ssh')
    expect(ssh?.hostPath.endsWith('ssh/11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(ssh?.pvcSubPath).toBe('ssh/11111111-1111-4111-8111-111111111111')
  })

  test('squad box: memory source mirrors getSquadMemoryPath + pod-spec subPath', async () => {
    const ctx: AssetContext = {
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      squadId: '11111111-1111-4111-8111-111111111111',
      role: 'squad',
    }
    const byName = new Map((await resolveSandboxAssets(ctx)).map((r) => [r.asset.name, r.source]))
    const memory = byName.get('memory')
    expect(memory?.hostPath.endsWith('memory/11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(memory?.pvcSubPath).toBe('memory/11111111-1111-4111-8111-111111111111')
  })
})
