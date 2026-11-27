import { describe, expect, it, mock } from 'bun:test'
import type { Squad } from '../../entities/Squad'
import { fingerprintToolchain, normalizeToolchain } from './toolchain/config'
import type { ToolchainReconcileSnapshot } from './toolchain/state'
import type { ISandboxManager } from './types'
import {
  ensureSquadSandboxForCommands,
  isToolchainSettled,
  type SquadSandboxFastPathDeps,
} from './squad-sandbox-fast-path'

const SQUAD_ID = 'squad-1'
const SANDBOX_ID = `squad_${SQUAD_ID}`
const WORKSPACE = '/home/box/workspace'

function harness(overrides: Partial<SquadSandboxFastPathDeps> = {}, managerOverrides: Partial<ISandboxManager> = {}) {
  const exec = mock(async () => Buffer.from(`${WORKSPACE}\n`))
  const manager = {
    hasSandbox: mock(() => true),
    isSandboxSpecDrifted: mock(() => false),
    getWorkspaceLayout: mock(() => ({ workspaceMount: WORKSPACE, privateMount: '/private' })),
    exec,
    ...managerOverrides,
  } as unknown as ISandboxManager
  const fullEnsure = mock(async () => '/full/workspace')
  const assertAdmissionOpen = mock(async () => {})
  const deps: SquadSandboxFastPathDeps = {
    findSquad: async () => ({ id: SQUAD_ID, isArchived: false }) as Squad,
    getSandboxId: () => SANDBOX_ID,
    getManager: () => manager,
    isRemoteRuntime: () => true,
    buildSandboxOptions: () => ({ workspacePath: '/w', squadId: SQUAD_ID }),
    isToolchainInstalling: () => false,
    readToolchainSnapshot: async () => ({ config: undefined, provision: undefined, activation: undefined }),
    assertAdmissionOpen,
    fullEnsure,
    probeTimeoutMs: 50,
    ...overrides,
  }
  return { deps, manager, exec, fullEnsure, assertAdmissionOpen }
}

describe('squad sandbox fast path for repository setup', () => {
  it('skips the full ensure on a tracked, healthy box after one quick command', async () => {
    const { deps, exec, fullEnsure, assertAdmissionOpen } = harness()
    expect(await ensureSquadSandboxForCommands(SQUAD_ID, deps)).toEqual({ workspacePath: WORKSPACE, path: 'fast' })
    expect(fullEnsure).not.toHaveBeenCalled()
    expect(assertAdmissionOpen).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledTimes(1)
    expect((exec.mock.calls[0] as unknown[])[0]).toBe(SANDBOX_ID)
  })

  const fallbacks: Array<[string, () => ReturnType<typeof harness>]> = [
    ['untracked', () => harness({}, { hasSandbox: mock(() => false) })],
    ['spec-drift', () => harness({}, { isSandboxSpecDrifted: mock(() => true) })],
    ['local-runtime', () => harness({ isRemoteRuntime: () => false })],
    ['archived', () => harness({ findSquad: async () => ({ id: SQUAD_ID, isArchived: true }) as Squad })],
    ['toolchain-installing', () => harness({ isToolchainInstalling: () => true })],
    [
      'toolchain-unsettled',
      () =>
        harness({
          readToolchainSnapshot: async () => ({
            config: { packages: ['jq'] },
            provision: undefined,
            activation: undefined,
          }),
        }),
    ],
    [
      'probe-failed',
      () =>
        harness(
          {},
          {
            exec: mock(async () => {
              throw new Error('connection refused')
            }),
          }
        ),
    ],
    ['probe-failed', () => harness({}, { exec: mock(() => new Promise<Buffer>(() => {})) })],
  ]
  for (const [reason, make] of fallbacks)
    it(`falls back to the full ensure when the box is ${reason}`, async () => {
      const { deps, fullEnsure } = make()
      expect(await ensureSquadSandboxForCommands(SQUAD_ID, deps)).toEqual({
        workspacePath: '/full/workspace',
        path: 'full',
        reason,
      })
      expect(fullEnsure).toHaveBeenCalledWith(SQUAD_ID)
    })

  it('falls back to the full ensure (which refuses or creates it) when the squad row is missing', async () => {
    const { deps, fullEnsure } = harness({ findSquad: async () => null })
    expect((await ensureSquadSandboxForCommands(SQUAD_ID, deps)).reason).toBe('squad-missing')
    expect(fullEnsure).toHaveBeenCalledTimes(1)
  })

  it('keeps the archived-squad refusal of the full ensure', async () => {
    const { deps } = harness({
      findSquad: async () => ({ id: SQUAD_ID, isArchived: true }) as Squad,
      fullEnsure: async () => {
        throw new Error(`Cannot ensure sandbox for archived squad ${SQUAD_ID}`)
      },
    })
    await expect(ensureSquadSandboxForCommands(SQUAD_ID, deps)).rejects.toThrow('archived squad')
  })

  it('keeps the maintenance pause on the fast path', async () => {
    const { deps, exec, fullEnsure } = harness({
      assertAdmissionOpen: async () => {
        throw new Error('maintenance paused')
      },
    })
    await expect(ensureSquadSandboxForCommands(SQUAD_ID, deps)).rejects.toThrow('maintenance paused')
    expect(exec).not.toHaveBeenCalled()
    expect(fullEnsure).not.toHaveBeenCalled()
  })
})

describe('isToolchainSettled', () => {
  const config = { packages: ['jq', 'ripgrep'] }
  const fingerprint = fingerprintToolchain(normalizeToolchain(config))
  const ready = (applied: string, activated: string | undefined): ToolchainReconcileSnapshot => ({
    config,
    provision: {
      sandboxId: SANDBOX_ID,
      squadId: SQUAD_ID,
      desiredFingerprint: applied,
      appliedFingerprint: applied,
      status: 'ready',
      updatedAt: new Date(),
    },
    activation: activated
      ? { sandboxId: SANDBOX_ID, squadId: SQUAD_ID, appliedFingerprint: activated, updatedAt: new Date() }
      : undefined,
  })

  it('accepts no declaration with no state, and the current declaration applied and activated', () => {
    expect(isToolchainSettled({})).toBe(true)
    expect(isToolchainSettled(ready(fingerprint, fingerprint))).toBe(true)
  })

  it('rejects a stale, unactivated, failed or leftover toolchain', () => {
    expect(isToolchainSettled(ready('old', 'old'))).toBe(false)
    expect(isToolchainSettled(ready(fingerprint, undefined))).toBe(false)
    expect(
      isToolchainSettled({
        ...ready(fingerprint, fingerprint),
        provision: { ...ready(fingerprint, fingerprint).provision!, status: 'failed' },
      })
    ).toBe(false)
    expect(isToolchainSettled({ ...ready(fingerprint, fingerprint), config: undefined })).toBe(false)
  })
})
