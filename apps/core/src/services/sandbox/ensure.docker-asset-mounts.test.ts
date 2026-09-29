/**
 * Golden master: the EXACT docker per-asset `-v` volume lists ensure.ts hands
 * the docker manager, for the three sandbox kinds (solo agent, squad member,
 * squad warm box).
 *
 * The pre-refactor capture (per-skill identity mounts, member memory mount,
 * hardcoded squad volume list) is pinned in git history at the commit that
 * introduced this file. This version pins the manifest-driven construction;
 * every difference from the original capture is a DELIBERATE behavior change,
 * marked below:
 *   1. skills single-mount migration — ONE read-only mount of the materializer
 *      parent dir (host path == container path, matching the k8s skills
 *      anchor) replaces the N per-skill identity mounts.
 *   2. member memory drop — squad MEMBERS no longer mount /memory/<squadId>
 *      (squad memory lives only on the squad box; Option B, matching k8s).
 *   3. box skills addition — the squad warm box now gets the skills mount
 *      (manifest scope: skills for every kind, matching k8s/vm delivery).
 * The working volumes (workspacePath / privateVolumePath) and env are pinned
 * elsewhere (ensure.test.ts); THIS file pins the `volumes` array — full
 * contents, exact order.
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getHomeDir } from '../../lib/utils/home'
import { EXTENSIONS_DIR } from '../../lib/paths'
import * as cliHelp from '../../lib/utils/cli-help'
import * as sandboxFactory from './factory'
import * as localDeploymentHealth from '../deploy/local-deployment-health'
import * as squadEnv from '../squad/env'
import * as squadWorkspace from '../squad/workspace'
import { ensureWorkspaceSandbox, ensureSquadSandbox } from './ensure'

/** Captures the options handed to manager.ensureSandbox. */
function captureManager() {
  const captured: { options?: any } = {}
  const manager = {
    ensureSandbox: async (_id: string, options: any) => {
      captured.options = options
      return 'container-id'
    },
    hasSandbox: (_id: string) => false,
  }
  return { captured, manager }
}

describe('docker per-asset volume golden master', () => {
  // Real HOME_DIR-based paths (skill materializer binds its base dir at module
  // load, so a per-test HOME_DIR override cannot apply). Every created dir is
  // removed in afterEach.
  const home = getHomeDir()
  const cleanupPaths: string[] = []
  const restore: Array<{ mockRestore: () => void }> = []

  afterEach(() => {
    restore.forEach((s) => s.mockRestore())
    restore.length = 0
    cleanupPaths.forEach((p) => rmSync(p, { recursive: true, force: true }))
    cleanupPaths.length = 0
  })

  it('solo agent: CLI mount + ONE ro skills-parent mount (host path == container path)', async () => {
    const sandboxId = 'agent_gm_solo'
    // Change 1 (skills single-mount migration): the materializer PARENT dir in
    // one identity mount, instead of a per-skill mount per enabled skill.
    const skillsParent = join(home, 'skills', 'sandboxes', 'agent-gm-solo')
    cleanupPaths.push(skillsParent)

    const tmp = mkdtempSync(join(tmpdir(), 'ficus-gm-solo-'))
    cleanupPaths.push(tmp)
    const { captured, manager } = captureManager()

    await ensureWorkspaceSandbox(
      { sandboxId, workspaceId: sandboxId },
      {
        isK8sRuntime: () => false,
        getSandboxManager: () => manager as any,
        getCliHostPath: () => '/tmp/ficus.js',
        getHomeDir: () => tmp,
        ensureSquadWorkspace: () => '/unused',
        isSessionActive: () => false,
      }
    )

    expect(captured.options.volumes).toEqual([
      '/tmp/ficus.js:/usr/local/bin/ficus:ro',
      `${skillsParent}:${skillsParent}:ro`,
    ])
    // The mount source is pre-created so docker never auto-creates it root-owned.
    expect(existsSync(skillsParent)).toBe(true)
  })

  it('squad member: CLI + extensions + ro skills-parent + writable ssh at /home/tau/.ssh; NO memory mount', async () => {
    const sandboxId = 'agent_gm_member'
    const squadId = randomUUID()
    const skillsParent = join(home, 'skills', 'sandboxes', 'agent-gm-member')
    cleanupPaths.push(skillsParent)
    cleanupPaths.push(join(home, 'ssh', squadId))

    const tmp = mkdtempSync(join(tmpdir(), 'ficus-gm-member-'))
    cleanupPaths.push(tmp)
    const { captured, manager } = captureManager()

    await ensureWorkspaceSandbox(
      { sandboxId, workspaceId: sandboxId, squadId },
      {
        isK8sRuntime: () => false,
        getSandboxManager: () => manager as any,
        getCliHostPath: () => '/tmp/ficus.js',
        getHomeDir: () => tmp,
        ensureSquadWorkspace: () => `/mock/workspace/${squadId}`,
        isSessionActive: () => false,
      }
    )

    // Change 1 (skills single-mount) + change 2 (member memory drop): no
    // `${home}/memory/${squadId}:/memory/${squadId}:ro` entry anymore — squad
    // memory is delivered only to the squad box, per the manifest scope.
    expect(captured.options.volumes).toEqual([
      '/tmp/ficus.js:/usr/local/bin/ficus:ro',
      `${EXTENSIONS_DIR}:${EXTENSIONS_DIR}:ro`,
      `${skillsParent}:${skillsParent}:ro`,
      `${home}/ssh/${squadId}:/home/tau/.ssh`,
    ])
    // Host-side ssh prep: known_hosts is pre-seeded into the mounted dir.
    expect(existsSync(join(home, 'ssh', squadId, 'known_hosts'))).toBe(true)
  })

  it('squad warm box: CLI + extensions + ro skills-parent + memory ro + writable ssh', async () => {
    const squadId = randomUUID()
    // Change 3 (box skills addition): the warm box now mounts its own
    // materializer parent dir (sandboxId squad_<id> → storage key squad-<id>).
    const skillsParent = join(home, 'skills', 'sandboxes', `squad-${squadId}`)
    cleanupPaths.push(skillsParent)
    cleanupPaths.push(join(home, 'ssh', squadId))
    cleanupPaths.push(join(home, 'memory', squadId))

    const wsDir = mkdtempSync(join(tmpdir(), 'ficus-gm-box-'))
    cleanupPaths.push(wsDir)
    const { captured, manager } = captureManager()

    restore.push(spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(manager as any))
    restore.push(spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(false))
    restore.push(spyOn(squadEnv, 'regenerateEnvFileForSquad').mockResolvedValue())
    restore.push(spyOn(squadWorkspace, 'ensureSquadWorkspace').mockReturnValue(wsDir))
    restore.push(spyOn(localDeploymentHealth, 'restartManagedLocalDeploymentsForSandbox').mockResolvedValue())

    await ensureSquadSandbox(squadId)

    const cliHostPath = cliHelp.getCliHostPath()
    expect(captured.options.volumes).toEqual([
      `${cliHostPath}:/usr/local/bin/ficus:ro`,
      `${EXTENSIONS_DIR}:${EXTENSIONS_DIR}:ro`,
      `${skillsParent}:${skillsParent}:ro`,
      // Manifest order: memory before squad-ssh (secrets last), previously
      // ssh-then-memory — order-only difference, same mounts.
      `${home}/memory/${squadId}:/memory/${squadId}:ro`,
      `${home}/ssh/${squadId}:/home/tau/.ssh`,
    ])
    expect(existsSync(join(home, 'ssh', squadId, 'known_hosts'))).toBe(true)
    expect(existsSync(skillsParent)).toBe(true)
  })
})
