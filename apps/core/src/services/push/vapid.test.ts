import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getVapidKeysPath, loadOrGenerateVapidKeys } from './vapid'
import { resetSecretStore } from '../secrets'

describe('vapid', () => {
  const testDir = join(__dirname, '__test_vapid__')
  const testPath = join(testDir, 'vapid.json')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
    // Reset SecretStore so VAPID keys aren't cached from other tests.
    // Without FICUS_ENCRYPTION_KEY, SecretStore falls back to process.env
    // which won't have VAPID keys, so the file path is used.
    resetSecretStore()
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('should generate keys if file does not exist, and never write a key file', async () => {
    const keys = await loadOrGenerateVapidKeys(testPath)

    expect(keys.publicKey).toBeDefined()
    expect(keys.privateKey).toBeDefined()
    expect(keys.publicKey.length).toBeGreaterThan(50)

    // SecretStore is the only store: no compatibility copy lands on disk.
    await expect(readFile(testPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('should load existing keys from file', async () => {
    const existingKeys = {
      publicKey: 'test-public-key',
      privateKey: 'test-private-key',
    }
    await writeFile(testPath, JSON.stringify(existingKeys))

    const keys = await loadOrGenerateVapidKeys(testPath)

    expect(keys.publicKey).toBe('test-public-key')
    expect(keys.privateKey).toBe('test-private-key')
  })

  it('never creates the key file directory', async () => {
    const nestedPath = join(testDir, 'nested', 'deep', 'vapid.json')

    const keys = await loadOrGenerateVapidKeys(nestedPath)

    expect(keys.publicKey).toBeDefined()
    await expect(readFile(nestedPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('an unreadable legacy file does not stop startup: it is skipped and keys are generated', async () => {
    // A directory where the file should be: EISDIR, like the EACCES a non-root Core gets on a
    // root-owned copy.
    await mkdir(testPath, { recursive: true })
    const keys = await loadOrGenerateVapidKeys(testPath)
    expect(keys.publicKey.length).toBeGreaterThan(50)
  })
})

describe('getVapidKeysPath', () => {
  const original = process.env.VAPID_KEYS_PATH

  afterEach(() => {
    if (original === undefined) delete process.env.VAPID_KEYS_PATH
    else process.env.VAPID_KEYS_PATH = original
  })

  it('expands a leading ~ in VAPID_KEYS_PATH', () => {
    process.env.VAPID_KEYS_PATH = '~/.tau/vapid.json'
    expect(getVapidKeysPath()).toBe(join(homedir(), '.tau/vapid.json'))
  })

  it('leaves an absolute VAPID_KEYS_PATH untouched', () => {
    process.env.VAPID_KEYS_PATH = '/etc/tau/vapid.json'
    expect(getVapidKeysPath()).toBe('/etc/tau/vapid.json')
  })
})
