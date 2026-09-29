import { describe, expect, it } from 'bun:test'
import type { Squad } from '../../entities/Squad'
import { fingerprintToolchain, type ManagedToolchainConfig } from './toolchain/config'
import type { ProvisionState } from './toolchain/state'
import { mergeSandboxStatus, resolveToolchainStatus, type ResolveToolchainStatusDeps } from './status'

describe('mergeSandboxStatus', () => {
  it('preserves physical readiness without a declaration', () => {
    expect(mergeSandboxStatus({ status: 'running', devboxReady: true })).toEqual({
      status: 'running',
      devboxReady: true,
    })
  })

  for (const status of ['pending', 'installing', 'running_setup', 'failed'] as const) {
    it(`gates compatibility readiness while toolchain is ${status}`, () => {
      expect(
        mergeSandboxStatus({ status: 'running', devboxReady: true }, { status, desiredFingerprint: 'a'.repeat(64) })
          .devboxReady
      ).toBe(false)
    })
  }

  it('reports ready only when physical and managed environments are ready', () => {
    expect(
      mergeSandboxStatus(
        { status: 'running', devboxReady: true },
        { status: 'ready', desiredFingerprint: 'a'.repeat(64) }
      ).devboxReady
    ).toBe(true)
    expect(
      mergeSandboxStatus(
        { status: 'running', devboxReady: false },
        { status: 'ready', desiredFingerprint: 'a'.repeat(64) }
      ).devboxReady
    ).toBe(false)
  })
})

describe('resolveToolchainStatus', () => {
  const squad = { id: 'squad-1', toolchainConfig: { packages: ['bun'] } } as unknown as Squad
  /** What the provisioner realizes: the squad's `bun` plus a GitHub integration's contribution. */
  const effective: ManagedToolchainConfig = {
    packages: ['bun', 'gh'],
    initHooks: ['export GH_TOKEN=$(ficus gh token)'],
    readiness: [{ id: 'gh', command: 'gh --version', expectedSubstring: 'gh version' }],
    integrationFingerprint: 'f'.repeat(64),
  }
  const readyRow = (desiredFingerprint: string): ProvisionState => ({
    sandboxId: 'squad_squad-1',
    squadId: 'squad-1',
    desiredFingerprint,
    appliedFingerprint: desiredFingerprint,
    status: 'ready',
    updatedAt: new Date(0),
  })
  const deps = (
    provision: ProvisionState | undefined,
    desired: ManagedToolchainConfig = effective
  ): ResolveToolchainStatusDeps & { asked: string[] } => {
    const asked: string[] = []
    return {
      asked,
      loadDesiredToolchain: async () => desired,
      getProvisionState: async (_sandboxId, fingerprint) => {
        asked.push(fingerprint)
        return provision && provision.desiredFingerprint === fingerprint ? provision : undefined
      },
    }
  }

  it('fingerprints the EFFECTIVE toolchain — the row the provisioner wrote is found, not reported pending', async () => {
    const provisionerFingerprint = fingerprintToolchain(effective)
    const d = deps(readyRow(provisionerFingerprint))

    const payload = await resolveToolchainStatus('squad_squad-1', squad, d)

    expect(d.asked).toEqual([provisionerFingerprint])
    expect(payload?.status).toBe('ready')
    expect(payload?.desiredFingerprint).toBe(provisionerFingerprint)
    // The regression: hashing only the squad's own declaration never matches.
    expect(fingerprintToolchain({ packages: ['bun'] })).not.toBe(provisionerFingerprint)
  })

  it('reports pending when no provision row carries the effective fingerprint yet', async () => {
    const payload = await resolveToolchainStatus('squad_squad-1', squad, deps(undefined))
    expect(payload).toEqual({ status: 'pending', desiredFingerprint: fingerprintToolchain(effective) })
  })

  it('an integration-only toolchain (empty squad declaration) still surfaces', async () => {
    const bare = { id: 'squad-1', toolchainConfig: undefined } as unknown as Squad
    const desired: ManagedToolchainConfig = { packages: ['gh'], integrationFingerprint: 'e'.repeat(64) }
    const payload = await resolveToolchainStatus(
      'squad_squad-1',
      bare,
      deps(readyRow(fingerprintToolchain(desired)), desired)
    )
    expect(payload?.status).toBe('ready')
  })

  it('returns undefined when the effective toolchain is empty or there is no squad', async () => {
    const empty: ManagedToolchainConfig = { packages: [], integrationFingerprint: '0'.repeat(64) }
    expect(await resolveToolchainStatus('squad_squad-1', squad, deps(undefined, empty))).toBeUndefined()
    expect(await resolveToolchainStatus('squad_squad-1', null, deps(undefined))).toBeUndefined()
  })
})
