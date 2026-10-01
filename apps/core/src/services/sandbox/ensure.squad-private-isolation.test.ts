// apps/core/src/services/sandbox/ensure.squad-private-isolation.test.ts
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getHomeDir } from '../../lib/utils/home'
import * as sandboxFactory from './factory'
import * as localDeploymentHealth from '../deploy/local-deployment-health'
import * as squadEnv from '../squad/env'
import * as squadWorkspace from '../squad/workspace'
import { buildSquadK8sSandboxOptions } from './ensure'

function dockerVolumeEndpoints(volume: string): { source: string; target: string } {
  const components = volume.split(':')
  const last = components.at(-1) ?? ''
  const targetIndex = last.startsWith('/') ? components.length - 1 : components.length - 2
  return {
    source: components.slice(0, targetIndex).join(':'),
    target: components[targetIndex] ?? '',
  }
}

function expectNoPrivateVolumeTargets(volumes: string[]): void {
  for (const volume of volumes) {
    const { source, target } = dockerVolumeEndpoints(volume)
    if (source === target) continue
    expect(target).not.toBe('/private')
    expect(target.startsWith('/private/')).toBe(false)
  }
}

describe('warm squad box never mounts /private', () => {
  const spies: Array<{ mockRestore: () => void }> = []
  const cleanupPaths: string[] = []
  afterEach(() => {
    spies.forEach((s) => s.mockRestore())
    spies.length = 0
    cleanupPaths.forEach((p) => rmSync(p, { recursive: true, force: true }))
    cleanupPaths.length = 0
  })

  /** Drive the docker warm-box ensure with a capturing manager; returns the
   *  captured ensureSandbox options. Uses the REAL asset-manifest host paths
   *  (HOME_DIR-based, cleaned up in afterEach). */
  async function runDockerSquadEnsure(squadId: string): Promise<any> {
    const wsDir = mkdtempSync(join(tmpdir(), 'ficus-ws-'))
    cleanupPaths.push(wsDir)
    const home = getHomeDir()
    cleanupPaths.push(join(home, 'skills', 'sandboxes', `squad-${squadId}`))
    cleanupPaths.push(join(home, 'ssh', squadId))
    cleanupPaths.push(join(home, 'memory', squadId))

    let captured: any
    const mockManager = {
      hasSandbox: () => false,
      ensureSandbox: async (_id: string, options: any) => {
        captured = options
      },
    }

    spies.push(spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(mockManager as any))
    spies.push(spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(false))
    spies.push(spyOn(squadEnv, 'regenerateEnvFileForSquad').mockResolvedValue())
    spies.push(spyOn(squadWorkspace, 'ensureSquadWorkspace').mockReturnValue(wsDir))
    spies.push(spyOn(localDeploymentHealth, 'restartManagedLocalDeploymentsForSandbox').mockResolvedValue())

    const { ensureSquadSandbox } = await import('./ensure')
    await ensureSquadSandbox(squadId)
    return captured
  }

  it('Docker squad volumes contain no /private mount', async () => {
    const squadId = randomUUID()
    const captured = await runDockerSquadEnsure(squadId)

    expect(captured).toBeDefined()
    expectNoPrivateVolumeTargets(captured.volumes as string[])

    // Memory must be mounted at /memory/<squadId>, not /memory
    expect((captured.volumes as string[]).find((v) => v.endsWith(`:/memory/${squadId}:ro`))).toBeDefined()
  })

  it('allows /private host sources and load-bearing source-target parity mounts', () => {
    expect(() =>
      expectNoPrivateVolumeTargets([
        '/private/tmp/build:cache/apps/cli/dist/ficus.js:/opt/ficus/ficus.js:ro',
        '/private/tmp/checkout/config/agent/extensions:/private/tmp/checkout/config/agent/extensions:ro',
      ])
    ).not.toThrow()
  })

  it('rejects an actual squad /private target with or without a mode', () => {
    const squadId = randomUUID()
    expect(() => expectNoPrivateVolumeTargets([`/tmp/source:/private/${squadId}`])).toThrow()
    expect(() => expectNoPrivateVolumeTargets([`/tmp/source:/private/${squadId}:ro`])).toThrow()
  })

  it('Docker warm squad box passes no privateVolumePath to ensureSandbox', async () => {
    const squadId = randomUUID()
    const captured = await runDockerSquadEnsure(squadId)

    expect(captured).toBeDefined()
    expect(captured.privateVolumePath).toBeUndefined()
  })

  it('K8s squad options set no privateStorageKey', () => {
    const squad = {
      id: randomUUID(),
      sandboxConfig: undefined,
    } as any
    const opts = buildSquadK8sSandboxOptions(squad)
    expect((opts.k8s as any)?.privateStorageKey).toBeUndefined()
    expect((opts as any).privateVolumePath).toBeUndefined()
    expect(opts.squadId).toBe(squad.id)
  })
})
