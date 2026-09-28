import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { SecretStore } from '../secrets'
import {
  DEFAULT_EXE_MACHINE_IMAGE,
  EXE_PROVIDER_SSH_KEY,
  getExeMachineImage,
  getExeSshKey,
  isExeBacked,
} from './provider-credentials'

/**
 * getExeSshKey reads the single per-instance exe.dev account SSH private key from
 * the secret store. The store handle is injectable so these tests never touch the
 * real DB-backed singleton.
 */
function fakeStore(values: Record<string, string>): Pick<SecretStore, 'get'> {
  return { get: (key: string) => values[key] }
}

describe('getExeSshKey', () => {
  it('returns the key stored under the exe-provider-ssh-key key', async () => {
    const key = await getExeSshKey({ getStore: () => fakeStore({ [EXE_PROVIDER_SSH_KEY]: 'sekret' }) })
    expect(key).toBe('sekret')
  })

  it('returns null when the key is not configured', async () => {
    const key = await getExeSshKey({ getStore: () => fakeStore({}) })
    expect(key).toBeNull()
  })

  it("treats an empty-string stored value as not configured (null), matching isSecretSet's trimmed-length check", async () => {
    const key = await getExeSshKey({ getStore: () => fakeStore({ [EXE_PROVIDER_SSH_KEY]: '' }) })
    expect(key).toBeNull()
  })

  it('treats a whitespace-only stored value as not configured (null)', async () => {
    const key = await getExeSshKey({ getStore: () => fakeStore({ [EXE_PROVIDER_SSH_KEY]: '   ' }) })
    expect(key).toBeNull()
  })

  it('exposes the secret-store key name', () => {
    expect(EXE_PROVIDER_SSH_KEY).toBe('exe-provider-ssh-key')
  })
})

describe('isExeBacked', () => {
  it('is true when the exe account key is configured', async () => {
    const backed = await isExeBacked({
      getStore: () => fakeStore({ [EXE_PROVIDER_SSH_KEY]: 'sekret' }),
      hasExeMachine: async () => {
        throw new Error('must short-circuit — a configured key already answers the question')
      },
    })
    expect(backed).toBe(true)
  })

  it('is true when no key is configured but an exe-provider machine is registered', async () => {
    const backed = await isExeBacked({
      getStore: () => fakeStore({}),
      hasExeMachine: async () => true,
    })
    expect(backed).toBe(true)
  })

  it('is false when neither a key nor an exe-provider machine exists — the do_droplet default', async () => {
    const backed = await isExeBacked({
      getStore: () => fakeStore({}),
      hasExeMachine: async () => false,
    })
    expect(backed).toBe(false)
  })

  it('an empty-string stored key does not count as configured — falls through to the machine-existence check', async () => {
    const backed = await isExeBacked({
      getStore: () => fakeStore({ [EXE_PROVIDER_SSH_KEY]: '' }),
      hasExeMachine: async () => false,
    })
    expect(backed).toBe(false)
  })
})

describe('getExeMachineImage', () => {
  let prior: string | undefined

  beforeEach(() => {
    prior = process.env.FICUS_EXE_MACHINE_IMAGE
  })

  afterEach(() => {
    if (prior === undefined) delete process.env.FICUS_EXE_MACHINE_IMAGE
    else process.env.FICUS_EXE_MACHINE_IMAGE = prior
  })

  it('defaults to the ficus-machine image when FICUS_EXE_MACHINE_IMAGE is unset', () => {
    delete process.env.FICUS_EXE_MACHINE_IMAGE
    expect(getExeMachineImage()).toBe(DEFAULT_EXE_MACHINE_IMAGE)
    expect(DEFAULT_EXE_MACHINE_IMAGE).toBe('ghcr.io/ficushq/ficus-machine:latest')
  })

  it('returns the configured value when FICUS_EXE_MACHINE_IMAGE is set', () => {
    process.env.FICUS_EXE_MACHINE_IMAGE = 'ghcr.io/ficushq/ficus-machine:v9'
    expect(getExeMachineImage()).toBe('ghcr.io/ficushq/ficus-machine:v9')
  })

  it("returns undefined when FICUS_EXE_MACHINE_IMAGE is empty (use exe's default image)", () => {
    process.env.FICUS_EXE_MACHINE_IMAGE = ''
    expect(getExeMachineImage()).toBeUndefined()
  })
})
