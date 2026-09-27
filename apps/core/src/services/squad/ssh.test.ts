import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import * as fs from 'fs'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'

// Mock the home module to use a temp directory
const originalEnv = process.env.HOME_DIR
let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'squad-ssh-test-'))
  process.env.HOME_DIR = tempDir
})

afterEach(async () => {
  if (originalEnv === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalEnv
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

// Re-import after setting env
async function getModule() {
  // Clear module cache
  delete require.cache[require.resolve('./ssh')]
  delete require.cache[require.resolve('../../lib/utils/home')]
  return await import('./ssh')
}

// Valid OpenSSH-format key for tests (minimal base64 between headers)
const VALID_TEST_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
dGVzdA==
-----END OPENSSH PRIVATE KEY-----`

describe('squad-ssh', () => {
  describe('ensureSquadSshDir', () => {
    it('creates SSH directory with correct permissions', async () => {
      const { ensureSquadSshDir, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'

      const sshPath = ensureSquadSshDir(squadId)

      expect(existsSync(sshPath)).toBe(true)
      expect(sshPath).toBe(getSquadSshPath(squadId))

      // Check directory permissions (700)
      const stats = statSync(sshPath)
      expect(stats.mode & 0o777).toBe(0o700)
    })

    it('repairs existing too-open SSH directory permissions', async () => {
      const { ensureSquadSshDir, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'
      const sshPath = getSquadSshPath(squadId)

      mkdirSync(sshPath, { recursive: true, mode: 0o770 })
      chmodSync(sshPath, 0o770)

      ensureSquadSshDir(squadId)

      expect(statSync(sshPath).mode & 0o777).toBe(0o700)
    })
  })

  describe('SSH directory failures', () => {
    function expectedOwnerMessage(path: string): string {
      return `SSH directory "${path}" requires owner UID ${process.geteuid!()} (GID ${process.getegid!()}) and permissions 0700`
    }

    it('rejects a legacy directory owned by another user before changing its permissions', async () => {
      const { ensureSquadSshDir, getSquadSshPath } = await getModule()
      const squadId = 'legacy-owner'
      const sshPath = getSquadSshPath(squadId)
      mkdirSync(sshPath, { mode: 0o755 })
      chmodSync(sshPath, 0o755)
      const stats = statSync(sshPath)
      const originalStatSync = fs.statSync
      // Simulate foreign ownership without requiring root/chown privileges in CI.
      const statSpy = spyOn(fs, 'statSync').mockImplementation(((path, options) => {
        if (path === sshPath) return Object.assign(stats, { uid: process.geteuid!() + 1 })
        return originalStatSync(path, options)
      }) as typeof fs.statSync)

      try {
        expect(() => ensureSquadSshDir(squadId)).toThrow(expectedOwnerMessage(sshPath))
        expect(originalStatSync(sshPath).mode & 0o777).toBe(0o755)
      } finally {
        statSpy.mockRestore()
      }
    })

    for (const code of ['EACCES', 'EPERM']) {
      for (const directory of ['base', 'squad']) {
        it(`reports an actionable error when ${directory} directory chmod fails with ${code}`, async () => {
          const { ensureSquadSshDir } = await getModule()
          const squadId = 'legacy-permissions'
          const sshPath = ensureSquadSshDir(squadId)
          const deniedPath = directory === 'base' ? join(tempDir, 'ssh') : sshPath
          const originalChmodSync = fs.chmodSync
          const chmodSpy = spyOn(fs, 'chmodSync').mockImplementation((path, mode) => {
            if (path === deniedPath) throw Object.assign(new Error('permission denied'), { code })
            return originalChmodSync(path, mode)
          })

          try {
            expect(() => ensureSquadSshDir(squadId)).toThrow(expectedOwnerMessage(deniedPath))
            expect(() => ensureSquadSshDir(squadId)).toThrow('administrator')
          } finally {
            chmodSpy.mockRestore()
          }
        })
      }
    }

    it('reports access denied even when directory chmod succeeds', async () => {
      const { ensureSquadSshDir } = await getModule()
      const squadId = 'inaccessible-directory'
      const sshPath = ensureSquadSshDir(squadId)
      const originalAccessSync = fs.accessSync
      const accessSpy = spyOn(fs, 'accessSync').mockImplementation((path, mode) => {
        if (path === sshPath) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        return originalAccessSync(path, mode)
      })

      try {
        expect(() => ensureSquadSshDir(squadId)).toThrow(expectedOwnerMessage(sshPath))
      } finally {
        accessSpy.mockRestore()
      }
    })

    it('reports denied creation of a squad directory instead of a raw filesystem error', async () => {
      const { ensureSquadSshDir, getSquadSshPath } = await getModule()
      const squadId = 'denied-creation'
      const sshPath = getSquadSshPath(squadId)
      const originalMkdirSync = fs.mkdirSync
      const mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation(((path, options) => {
        if (path === sshPath) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        return originalMkdirSync(path, options)
      }) as typeof fs.mkdirSync)

      try {
        expect(() => ensureSquadSshDir(squadId)).toThrow(expectedOwnerMessage(sshPath))
      } finally {
        mkdirSpy.mockRestore()
      }
    })

    it('does not relabel unrelated filesystem errors as permission failures', async () => {
      const { ensureSquadSshDir } = await getModule()
      const squadId = 'io-error'
      const sshPath = ensureSquadSshDir(squadId)
      const failure = Object.assign(new Error('input/output error'), { code: 'EIO' })
      const originalChmodSync = fs.chmodSync
      const chmodSpy = spyOn(fs, 'chmodSync').mockImplementation((path, mode) => {
        if (path === sshPath) throw failure
        return originalChmodSync(path, mode)
      })

      try {
        expect(() => ensureSquadSshDir(squadId)).toThrow(failure)
      } finally {
        chmodSpy.mockRestore()
      }
    })

    it('checks a legacy directory before listing its keys', async () => {
      const { ensureSquadSshDir, listSshKeys } = await getModule()
      const squadId = 'legacy-list'
      const sshPath = ensureSquadSshDir(squadId)
      const originalChmodSync = fs.chmodSync
      const chmodSpy = spyOn(fs, 'chmodSync').mockImplementation((path, mode) => {
        if (path === sshPath) throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
        return originalChmodSync(path, mode)
      })

      try {
        await expect(listSshKeys(squadId)).rejects.toThrow(expectedOwnerMessage(sshPath))
      } finally {
        chmodSpy.mockRestore()
      }
    })
  })

  describe('addSshKey', () => {
    it('adds a private key with correct permissions', async () => {
      const { addSshKey, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'
      const keyName = 'test-key'

      await addSshKey(squadId, keyName, VALID_TEST_KEY)

      const keyPath = join(getSquadSshPath(squadId), keyName)
      expect(existsSync(keyPath)).toBe(true)
      // normalizeKey adds trailing newline
      expect(readFileSync(keyPath, 'utf-8')).toBe(VALID_TEST_KEY + '\n')

      // Check key permissions (600)
      const stats = statSync(keyPath)
      expect(stats.mode & 0o777).toBe(0o600)
    })

    it('repairs permissions when overwriting an existing private key', async () => {
      const { addSshKey, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'
      const keyName = 'test-key'
      const keyPath = join(getSquadSshPath(squadId), keyName)

      mkdirSync(getSquadSshPath(squadId), { recursive: true })
      writeFileSync(keyPath, VALID_TEST_KEY)
      chmodSync(keyPath, 0o660)

      await addSshKey(squadId, keyName, VALID_TEST_KEY)

      expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    })

    it('adds both private and public keys', async () => {
      const { addSshKey, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'
      const keyName = 'test-key'
      const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest test@test'

      await addSshKey(squadId, keyName, VALID_TEST_KEY, publicKey)

      const sshPath = getSquadSshPath(squadId)
      expect(existsSync(join(sshPath, keyName))).toBe(true)
      expect(existsSync(join(sshPath, `${keyName}.pub`))).toBe(true)

      // Check public key permissions (644)
      const stats = statSync(join(sshPath, `${keyName}.pub`))
      expect(stats.mode & 0o777).toBe(0o644)
    })

    it('rejects invalid key names', async () => {
      const { addSshKey } = await getModule()
      const squadId = 'test-squad-123'

      await expect(addSshKey(squadId, 'invalid key', 'key')).rejects.toThrow('alphanumeric')
      await expect(addSshKey(squadId, 'config', VALID_TEST_KEY)).rejects.toThrow('reserved')
      await expect(addSshKey(squadId, 'known_hosts', VALID_TEST_KEY)).rejects.toThrow('reserved')
    })

    it('rejects the reserved ficus_remote_ prefix (materialize.ts stale-sweep would otherwise destroy it)', async () => {
      const { addSshKey, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'

      // Without the fix this succeeds, and the file it writes is
      // indistinguishable from a materialized remote-host key file — the
      // next materializeSquadRemoteHosts stale-sweep (materialize.ts's
      // KEY_FILE_PREFIX cleanup loop) unlinks it because it isn't in the
      // current grant set.
      await expect(addSshKey(squadId, 'ficus_remote_mykey', VALID_TEST_KEY)).rejects.toThrow('ficus_remote_')

      expect(existsSync(join(getSquadSshPath(squadId), 'ficus_remote_mykey'))).toBe(false)
    })

    it('reserves both the ficus_remote_ prefix and the pre-rename tau_remote_ prefix (K2)', async () => {
      const { addSshKey, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'

      await expect(addSshKey(squadId, 'ficus_remote_x', VALID_TEST_KEY)).rejects.toThrow('reserved')
      await expect(addSshKey(squadId, 'tau_remote_x', VALID_TEST_KEY)).rejects.toThrow('reserved')
      expect(existsSync(join(getSquadSshPath(squadId), 'ficus_remote_x'))).toBe(false)
      expect(existsSync(join(getSquadSshPath(squadId), 'tau_remote_x'))).toBe(false)
    })

    it('rejects invalid key format', async () => {
      const { addSshKey } = await getModule()
      const squadId = 'test-squad-123'

      await expect(addSshKey(squadId, 'key1', 'not a key')).rejects.toThrow('Invalid SSH private key format')
      await expect(addSshKey(squadId, 'key2', 'plain text content')).rejects.toThrow('Invalid SSH private key format')
    })

    it('rejects OpenSSH key missing END boundary', async () => {
      const { addSshKey } = await getModule()
      const squadId = 'test-squad-123'
      const malformedKey = `-----BEGIN OPENSSH PRIVATE KEY-----
dGVzdA==`

      await expect(addSshKey(squadId, 'key1', malformedKey)).rejects.toThrow(
        'Malformed SSH key: missing or corrupted END boundary'
      )
    })

    it('rejects PEM key missing END boundary', async () => {
      const { addSshKey } = await getModule()
      const squadId = 'test-squad-123'
      const malformedKey = `-----BEGIN RSA PRIVATE KEY-----
dGVzdA==`

      await expect(addSshKey(squadId, 'key1', malformedKey)).rejects.toThrow(
        'Malformed SSH key: missing or corrupted END RSA PRIVATE KEY boundary'
      )
    })

    it('rejects encrypted/passphrase-protected keys', async () => {
      const { addSshKey } = await getModule()
      const squadId = 'test-squad-123'
      const encryptedKey = `-----BEGIN OPENSSH PRIVATE KEY-----
ENCRYPTED
-----END OPENSSH PRIVATE KEY-----`

      await expect(addSshKey(squadId, 'key1', encryptedKey)).rejects.toThrow('passphrase-protected')
    })

    it('accepts PEM RSA format', async () => {
      const { addSshKey, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'
      const pemRsaKey = `-----BEGIN RSA PRIVATE KEY-----
dGVzdA==
-----END RSA PRIVATE KEY-----`

      await addSshKey(squadId, 'pem-key', pemRsaKey)

      const keyPath = join(getSquadSshPath(squadId), 'pem-key')
      expect(existsSync(keyPath)).toBe(true)
      expect(readFileSync(keyPath, 'utf-8')).toContain('-----BEGIN RSA PRIVATE KEY-----')
      expect(readFileSync(keyPath, 'utf-8')).toContain('-----END RSA PRIVATE KEY-----')
    })
  })

  describe('ensurePrivateSshKeyPermissions', () => {
    it('repairs an existing too-open private key before use', async () => {
      const { ensurePrivateSshKeyPermissions, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'
      const keyName = 'legacy-key'
      const sshPath = getSquadSshPath(squadId)
      const keyPath = join(sshPath, keyName)

      mkdirSync(sshPath, { recursive: true, mode: 0o770 })
      chmodSync(sshPath, 0o770)
      writeFileSync(keyPath, VALID_TEST_KEY)
      chmodSync(keyPath, 0o660)

      expect(ensurePrivateSshKeyPermissions(squadId, keyName)).toBe(keyPath)
      expect(statSync(sshPath).mode & 0o777).toBe(0o700)
      expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    })

    it('throws an actionable error for a missing private key', async () => {
      const { ensurePrivateSshKeyPermissions } = await getModule()

      expect(() => ensurePrivateSshKeyPermissions('test-squad-123', 'missing-key')).toThrow(
        'SSH private key "missing-key" does not exist'
      )
    })

    it('rejects inaccessible squad directories before using a private key', async () => {
      const { ensurePrivateSshKeyPermissions, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'
      const keyName = 'legacy-key'
      const sshPath = getSquadSshPath(squadId)
      const keyPath = join(sshPath, keyName)

      mkdirSync(sshPath, { recursive: true, mode: 0o770 })
      chmodSync(sshPath, 0o770)
      writeFileSync(keyPath, VALID_TEST_KEY)
      chmodSync(keyPath, 0o660)

      const originalChmodSync = fs.chmodSync
      const chmodSpy = spyOn(fs, 'chmodSync').mockImplementation((path, mode) => {
        if (path === sshPath) {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        }
        return originalChmodSync(path, mode)
      })

      try {
        expect(() => ensurePrivateSshKeyPermissions(squadId, keyName)).toThrow(`SSH directory "${sshPath}"`)
        expect(statSync(keyPath).mode & 0o777).toBe(0o660)
      } finally {
        chmodSpy.mockRestore()
      }
    })

    it('propagates private key chmod failures', async () => {
      const { ensurePrivateSshKeyPermissions, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'
      const keyName = 'legacy-key'
      const sshPath = getSquadSshPath(squadId)
      const keyPath = join(sshPath, keyName)

      mkdirSync(sshPath, { recursive: true })
      writeFileSync(keyPath, VALID_TEST_KEY)

      const originalChmodSync = fs.chmodSync
      const chmodSpy = spyOn(fs, 'chmodSync').mockImplementation((path, mode) => {
        if (path === keyPath) {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        }
        return originalChmodSync(path, mode)
      })

      try {
        expect(() => ensurePrivateSshKeyPermissions(squadId, keyName)).toThrow('operation not permitted')
      } finally {
        chmodSpy.mockRestore()
      }
    })
  })

  describe('listSshKeys', () => {
    it('returns empty array when no keys', async () => {
      const { listSshKeys } = await getModule()
      const keys = await listSshKeys('nonexistent-squad')
      expect(keys).toEqual([])
    })

    it('lists keys with metadata', async () => {
      const { addSshKey, listSshKeys } = await getModule()
      const squadId = 'test-squad-123'

      await addSshKey(squadId, 'key1', VALID_TEST_KEY)
      await addSshKey(squadId, 'key2', VALID_TEST_KEY, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest test@test')

      const keys = await listSshKeys(squadId)

      expect(keys.length).toBe(2)
      expect(keys.map((k) => k.name).sort()).toEqual(['key1', 'key2'])

      const key2 = keys.find((k) => k.name === 'key2')
      expect(key2?.hasPublicKey).toBe(true)

      const key1 = keys.find((k) => k.name === 'key1')
      expect(key1?.hasPublicKey).toBe(false)
    })
  })

  describe('removeSshKey', () => {
    it('removes key and public key', async () => {
      const { addSshKey, removeSshKey, listSshKeys } = await getModule()
      const squadId = 'test-squad-123'

      await addSshKey(squadId, 'test-key', VALID_TEST_KEY, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest test@test')
      expect((await listSshKeys(squadId)).length).toBe(1)

      await removeSshKey(squadId, 'test-key')
      expect((await listSshKeys(squadId)).length).toBe(0)
    })
  })

  describe('SSH config', () => {
    it('sets and gets SSH config', async () => {
      const { setSshConfig, getSshConfig, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'
      const config = 'Host github.com\n  IdentityFile ~/.ssh/deploy-key'

      await setSshConfig(squadId, config)

      // setSshConfig re-appends the current remote-hosts managed block via
      // composeManagedConfig. This squad has no granted hosts, so the block
      // is empty and the round-trip must be byte-exact (no normalization,
      // no appended newline).
      expect(getSshConfig(squadId)).toBe(config)

      // Check config permissions (644)
      const stats = statSync(join(getSquadSshPath(squadId), 'config'))
      expect(stats.mode & 0o777).toBe(0o644)
    })

    it('returns null when no config', async () => {
      const { getSshConfig } = await getModule()
      expect(getSshConfig('nonexistent')).toBeNull()
    })

    it('round-trips intentional blank-line runs byte-exact when no managed block is involved', async () => {
      const { setSshConfig, getSshConfig } = await getModule()
      const squadId = 'test-squad-123'
      // Three intentional blank lines in a row (a run of 4 consecutive '\n's).
      // stripManagedBlock must not touch this just because it scans the
      // whole document for *some* config with a managed block elsewhere —
      // there is no managed block here at all, and this squad has no
      // granted remote hosts, so the block re-appended by setSshConfig is
      // also empty. The write must be byte-exact.
      const config = 'Host a\n  User git\n\n\n\nHost b\n  User git'

      await setSshConfig(squadId, config)

      expect(getSshConfig(squadId)).toBe(config)
    })
  })

  describe('known_hosts', () => {
    it('adds and gets known hosts', async () => {
      const { addKnownHost, getKnownHosts } = await getModule()
      const squadId = 'test-squad-123'

      await addKnownHost(squadId, 'github.com ssh-rsa AAAA...')
      await addKnownHost(squadId, 'gitlab.com ssh-rsa BBBB...')

      const knownHosts = getKnownHosts(squadId)
      expect(knownHosts).toContain('github.com')
      expect(knownHosts).toContain('gitlab.com')
    })

    it('avoids duplicate entries', async () => {
      const { addKnownHost, getKnownHosts } = await getModule()
      const squadId = 'test-squad-123'

      await addKnownHost(squadId, 'github.com ssh-rsa AAAA...')
      await addKnownHost(squadId, 'github.com ssh-rsa AAAA...')

      const knownHosts = getKnownHosts(squadId)
      const matches = knownHosts!.match(/github\.com/g)
      expect(matches?.length).toBe(1)
    })
  })

  describe('removeSquadSsh', () => {
    it('removes entire SSH directory', async () => {
      const { addSshKey, setSshConfig, removeSquadSsh, getSquadSshPath } = await getModule()
      const squadId = 'test-squad-123'

      await addSshKey(squadId, 'key1', VALID_TEST_KEY)
      await setSshConfig(squadId, 'config')

      expect(existsSync(getSquadSshPath(squadId))).toBe(true)

      await removeSquadSsh(squadId)

      expect(existsSync(getSquadSshPath(squadId))).toBe(false)
    })
  })
})
