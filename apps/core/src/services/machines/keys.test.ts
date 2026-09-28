import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, statSync } from 'fs'
import { db, machines } from '../../db'
import { getSecretStore, resetSecretStore } from '../secrets'
import { generateMachineKeypair, generateRemoteHostKeypair, materializePrivateKey } from './keys'
import { insertMachine, deleteMachine } from './queries'

const prefix = `ktest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

describe('machine keys', () => {
  let priorKey: string | undefined
  // machine-ssh:* secrets minted by these tests, cleaned up so they don't leak
  // into the shared test DB.
  const createdSecretKeys: string[] = []

  beforeAll(async () => {
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64) // 32-byte hex test key
    resetSecretStore()
    await getSecretStore().initialize()
  })

  afterEach(async () => {
    const all = await db.select({ id: machines.id, name: machines.name }).from(machines)
    for (const m of all) {
      if (m.name.startsWith(prefix)) await deleteMachine(m.id)
    }
  })

  afterAll(async () => {
    for (const key of createdSecretKeys) await getSecretStore().delete(key)
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    resetSecretStore()
  })

  it('generates a keypair, stores the private key, and returns a public key', async () => {
    const machineId = crypto.randomUUID()
    const { publicKey, secretKeyId } = await generateMachineKeypair(machineId)
    createdSecretKeys.push(secretKeyId)

    expect(publicKey.startsWith('ssh-ed25519 ')).toBe(true)
    expect(secretKeyId).toBe(`machine-ssh:${machineId}`)

    const storedPrivateKey = getSecretStore().get(secretKeyId)
    expect(storedPrivateKey).toBeString()
    expect(storedPrivateKey).toContain('PRIVATE KEY')
  })

  it('materializes the private key to a 0600 file, and cleanup removes it', async () => {
    const machineId = crypto.randomUUID()
    const { secretKeyId } = await generateMachineKeypair(machineId)
    createdSecretKeys.push(secretKeyId)

    const machine = await insertMachine({
      name: `${prefix}-a`,
      provider: 'ssh',
      sshHost: '10.0.0.1',
      sshUser: 'tau',
      sshKeyId: secretKeyId,
      sshPublicKey: 'ssh-ed25519 AAAA test',
    })

    const { path, cleanup } = await materializePrivateKey(machine)

    expect(existsSync(path)).toBe(true)
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)

    cleanup()
    expect(existsSync(path)).toBe(false)
  })

  it('throws when the machine has no stored private key', async () => {
    const machine = await insertMachine({
      name: `${prefix}-b`,
      provider: 'ssh',
      sshHost: '10.0.0.1',
      sshUser: 'tau',
      sshKeyId: 'machine-ssh:does-not-exist',
      sshPublicKey: 'ssh-ed25519 AAAA test',
    })

    await expect(materializePrivateKey(machine)).rejects.toThrow(/no private key stored/)
  })

  it('generates a remote-host keypair in the remote-host-ssh namespace, stores it, and materializes it', async () => {
    const hostId = crypto.randomUUID()
    const { publicKey, secretKeyId } = await generateRemoteHostKeypair(hostId)
    createdSecretKeys.push(secretKeyId)

    expect(publicKey.startsWith('ssh-ed25519 ')).toBe(true)
    expect(secretKeyId).toBe(`remote-host-ssh:${hostId}`)

    const storedPrivateKey = getSecretStore().get(secretKeyId)
    expect(storedPrivateKey).toBeString()
    expect(storedPrivateKey).toContain('PRIVATE KEY')

    const { path, cleanup } = await materializePrivateKey({ id: hostId, sshKeyId: secretKeyId })
    expect(existsSync(path)).toBe(true)
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)

    cleanup()
    expect(existsSync(path)).toBe(false)
  })
})
