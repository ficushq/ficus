import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { remoteHosts } from '../../db'
import { getSecretStore, resetSecretStore } from '../secrets'
import {
  deleteGrant,
  deleteRemoteHost,
  insertGrant,
  insertRemoteHost,
  listRemoteHosts,
  type RemoteHost,
} from './queries'
import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  composeManagedConfig,
  getManagedBlockForSquad,
  materializeSquadRemoteHosts,
  renderManagedBlock,
  stripManagedBlock,
} from './materialize'
import { addSshKey, ensureSquadSshDir, getSquadSshPath, listSshKeys, setSshConfig } from '../squad/ssh'

const prefix = `mtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// Valid OpenSSH-format key for tests (minimal base64 between headers) — mirrors squad/ssh.test.ts.
const VALID_TEST_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
dGVzdA==
-----END OPENSSH PRIVATE KEY-----`

const originalHomeDir = process.env.HOME_DIR
let tempDir: string
let priorEncryptionKey: string | undefined

function hostValues(name: string): typeof remoteHosts.$inferInsert {
  return {
    name: `${prefix}-${name}`,
    sshHost: '10.0.0.1',
    sshUser: 'tau',
    sshKeyId: `${prefix}-secret-${name}`,
    sshPublicKey: 'ssh-ed25519 AAAA test',
  }
}

async function createGrantedHost(name: string, squadId: string, privateKey = 'fake-private-key-material') {
  const host = await insertRemoteHost(hostValues(name))
  await getSecretStore().set(host.sshKeyId, privateKey, 'system')
  await insertGrant({ hostId: host.id, squadId })
  return host
}

async function cleanupHosts() {
  const all = await listRemoteHosts()
  for (const h of all) {
    if (h.name.startsWith(prefix)) {
      await getSecretStore()
        .delete(h.sshKeyId)
        .catch(() => {})
      await deleteRemoteHost(h.id)
    }
  }
}

beforeAll(async () => {
  priorEncryptionKey = process.env.FICUS_ENCRYPTION_KEY
  process.env.FICUS_ENCRYPTION_KEY = priorEncryptionKey ?? '0'.repeat(64)
  resetSecretStore()
  await getSecretStore().initialize()
})

afterAll(async () => {
  if (priorEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
  else process.env.FICUS_ENCRYPTION_KEY = priorEncryptionKey
  resetSecretStore()
})

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'remote-hosts-materialize-test-'))
  process.env.HOME_DIR = tempDir
  await cleanupHosts()
})

afterEach(async () => {
  if (originalHomeDir === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHomeDir
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  await cleanupHosts()
})

describe('renderManagedBlock', () => {
  it('renders one Host entry per host between the markers', () => {
    const hosts = [
      {
        id: '1',
        name: 'staging',
        sshHost: 'staging.example.com',
        sshPort: 2222,
        sshUser: 'deploy',
      } as RemoteHost,
    ]

    const block = renderManagedBlock(hosts)
    expect(block.startsWith(MANAGED_BLOCK_BEGIN)).toBe(true)
    expect(block.endsWith(MANAGED_BLOCK_END)).toBe(true)
    expect(block).toContain('Host staging')
    expect(block).toContain('  HostName staging.example.com')
    expect(block).toContain('  Port 2222')
    expect(block).toContain('  User deploy')
    expect(block).toContain('  IdentityFile ~/.ssh/ficus_remote_staging')
    expect(block).toContain('  IdentitiesOnly yes')
    expect(block).toContain('  StrictHostKeyChecking accept-new')
  })

  it('renders ABSOLUTE IdentityFile + UserKnownHostsFile when given an absolute ssh dir', () => {
    // The host runtime has no `~/.ssh` mount: `ssh -F <squadSshDir>/config`
    // resolves `~` to the OPERATOR's real home, where the squad's key does not
    // exist. The caller therefore threads the squad's real ssh dir in.
    const hosts = [
      { id: '1', name: 'staging', sshHost: 'staging.example.com', sshPort: 2222, sshUser: 'deploy' } as RemoteHost,
    ]

    const block = renderManagedBlock(hosts, { absoluteSshDir: '/tau/ssh/squad-1' })
    expect(block).toContain('  IdentityFile /tau/ssh/squad-1/ficus_remote_staging')
    expect(block).toContain('  UserKnownHostsFile /tau/ssh/squad-1/known_hosts')
    expect(block).not.toContain('~/.ssh/')
    // Everything else is unchanged.
    expect(block).toContain('  IdentitiesOnly yes')
    expect(block).toContain('  StrictHostKeyChecking accept-new')
  })

  it('keeps the ~/.ssh rendering and adds no UserKnownHostsFile without an absolute ssh dir', () => {
    const hosts = [{ id: '1', name: 'staging', sshHost: 'h', sshPort: 22, sshUser: 'u' } as RemoteHost]
    const block = renderManagedBlock(hosts)
    expect(block).toContain('  IdentityFile ~/.ssh/ficus_remote_staging')
    expect(block).not.toContain('UserKnownHostsFile')
  })

  it('returns an empty string for no hosts', () => {
    expect(renderManagedBlock([])).toBe('')
  })

  it('skips a host with an invalid name (directive-injection guard) and renders the rest', () => {
    const hosts = [
      { id: '1', name: 'evil\nHost *\n  ProxyCommand rm -rf /', sshHost: 'x', sshPort: 22, sshUser: 'u' } as RemoteHost,
      { id: '2', name: 'good-host', sshHost: 'good.example.com', sshPort: 22, sshUser: 'u' } as RemoteHost,
    ]

    const block = renderManagedBlock(hosts)
    expect(block).not.toContain('evil')
    expect(block).not.toContain('ProxyCommand')
    expect(block).toContain('Host good-host')
  })

  it('skips a host with whitespace in sshHost or sshUser', () => {
    const hosts = [
      { id: '1', name: 'a', sshHost: 'evil host\nBadDirective yes', sshPort: 22, sshUser: 'u' } as RemoteHost,
      { id: '2', name: 'b', sshHost: 'ok.example.com', sshPort: 22, sshUser: 'bad user' } as RemoteHost,
    ]

    const block = renderManagedBlock(hosts)
    expect(block).toBe('')
  })
})

describe('stripManagedBlock', () => {
  it('removes the block and preserves surrounding user content', () => {
    const config = `Host github.com\n  User git\n\n${MANAGED_BLOCK_BEGIN}\nHost x\n  HostName y\n${MANAGED_BLOCK_END}\n\nHost after\n  User z`

    const stripped = stripManagedBlock(config)
    expect(stripped).toContain('Host github.com')
    expect(stripped).toContain('Host after')
    expect(stripped).not.toContain(MANAGED_BLOCK_BEGIN)
    expect(stripped).not.toContain('Host x')
  })

  it('is a no-op when there is no managed block', () => {
    const config = 'Host github.com\n  User git'
    expect(stripManagedBlock(config)).toBe(config)
  })

  it('strips everything from an unclosed BEGIN to end-of-file', () => {
    const config = `Host github.com\n  User git\n\n${MANAGED_BLOCK_BEGIN}\nHost x\n  HostName y`

    const stripped = stripManagedBlock(config)
    expect(stripped).toContain('Host github.com')
    expect(stripped).not.toContain(MANAGED_BLOCK_BEGIN)
    expect(stripped).not.toContain('Host x')
    expect(stripped).not.toContain('HostName y')
  })

  it('drops a lone END line with no preceding BEGIN', () => {
    const config = `Host github.com\n  User git\n${MANAGED_BLOCK_END}\nHost after\n  User z`

    const stripped = stripManagedBlock(config)
    expect(stripped).not.toContain(MANAGED_BLOCK_END)
    expect(stripped).toContain('Host github.com')
    expect(stripped).toContain('Host after')
  })

  it('is a no-op (byte-exact) on a document with an intentional blank-line run and no managed block', () => {
    // Regression for the bug where `.replace(/\n{3,}/g, '\n\n')` was applied
    // globally and unconditionally: a user's intentional 3-blank-line run
    // got silently collapsed to 1 even though no managed block was present
    // anywhere in the document.
    const config = 'Host a\n  User git\n\n\n\nHost b\n  User git'
    expect(stripManagedBlock(config)).toBe(config)
  })

  it('collapses blank lines only at the seam where a block was removed, leaving an unrelated blank-line run elsewhere byte-exact', () => {
    // "Host early" ... a 3-blank-line run untouched by the block ... "Host mid",
    // then a single blank line on each side of the managed block (the
    // realistic shape materialize.ts/setSshConfig produce), then "Host late".
    const config =
      'Host early\n\n\n\nHost mid\n\n' +
      `${MANAGED_BLOCK_BEGIN}\nHost x\n  HostName y\n${MANAGED_BLOCK_END}` +
      '\n\nHost late'

    const stripped = stripManagedBlock(config)

    // The seam (where the block sat, with one blank line on each side)
    // collapses to a single blank line, same as before the fix.
    expect(stripped).toBe('Host early\n\n\n\nHost mid\n\nHost late')
  })
})

describe('composeManagedConfig', () => {
  it('appends the block after user content with a single-newline boundary, preserving user content exactly', () => {
    expect(composeManagedConfig('Host github.com\n  User git', 'BLOCK')).toBe('Host github.com\n  User git\nBLOCK\n')
  })

  it('reuses an existing trailing newline as the boundary instead of adding another', () => {
    expect(composeManagedConfig('Host github.com\n  User git\n', 'BLOCK')).toBe('Host github.com\n  User git\nBLOCK\n')
  })

  it('omits the separator when user content is empty', () => {
    expect(composeManagedConfig('', 'BLOCK')).toBe('BLOCK\n')
  })

  it('returns user content byte-exact (no normalization, no appended newline) when block is empty', () => {
    expect(composeManagedConfig('Host github.com', '')).toBe('Host github.com')
    expect(composeManagedConfig('Host github.com\n', '')).toBe('Host github.com\n')
    expect(composeManagedConfig('', '')).toBe('')
  })
})

describe('materializeSquadRemoteHosts', () => {
  it('writes a key file and config block for each granted host on a fresh squad dir', async () => {
    const squadId = `${prefix}-squad-fresh`
    const host = await createGrantedHost('fresh', squadId, 'PRIVATE-KEY-CONTENT')

    await materializeSquadRemoteHosts(squadId)

    const sshPath = getSquadSshPath(squadId)
    const keyPath = join(sshPath, `ficus_remote_${host.name}`)
    expect(existsSync(keyPath)).toBe(true)
    expect(readFileSync(keyPath, 'utf-8')).toBe('PRIVATE-KEY-CONTENT')
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)

    const config = readFileSync(join(sshPath, 'config'), 'utf-8')
    expect(config).toContain(MANAGED_BLOCK_BEGIN)
    expect(config).toContain(`Host ${host.name}`)
    expect(config).toContain(`IdentityFile ~/.ssh/ficus_remote_${host.name}`)
  })

  it('host runtime: the written block points at the squad ssh dir by absolute path', async () => {
    const prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    try {
      const squadId = `${prefix}-squad-hostrt`
      const host = await createGrantedHost('hostrt', squadId, 'PRIVATE-KEY-CONTENT')

      await materializeSquadRemoteHosts(squadId)

      const sshPath = getSquadSshPath(squadId)
      const config = readFileSync(join(sshPath, 'config'), 'utf-8')
      expect(config).toContain(`IdentityFile ${join(sshPath, `ficus_remote_${host.name}`)}`)
      expect(config).toContain(`UserKnownHostsFile ${join(sshPath, 'known_hosts')}`)
      expect(config).not.toContain('~/.ssh/')
      // The recomputed block (used by setSshConfig's re-append) must match.
      expect(await getManagedBlockForSquad(squadId)).toContain(
        `IdentityFile ${join(sshPath, `ficus_remote_${host.name}`)}`
      )
    } finally {
      if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    }
  })

  it('is idempotent: materializing twice produces the same result', async () => {
    const squadId = `${prefix}-squad-idempotent`
    // Multiple hosts so this assertion actually exercises stanza ordering
    // (`listHostsGrantedToSquad` has a deterministic ORDER BY name) rather
    // than trivially passing with a single-entry block.
    await createGrantedHost('idem-c', squadId)
    await createGrantedHost('idem-a', squadId)
    await createGrantedHost('idem-b', squadId)

    await materializeSquadRemoteHosts(squadId)
    const configAfterFirst = readFileSync(join(getSquadSshPath(squadId), 'config'), 'utf-8')

    await materializeSquadRemoteHosts(squadId)
    const configAfterSecond = readFileSync(join(getSquadSshPath(squadId), 'config'), 'utf-8')

    expect(configAfterSecond).toBe(configAfterFirst)
  })

  it('revoking a grant removes the stale key file and drops its config entry on re-materialize', async () => {
    const squadId = `${prefix}-squad-revoke`
    const keep = await createGrantedHost('keep', squadId)
    const revoke = await createGrantedHost('revoke', squadId)

    await materializeSquadRemoteHosts(squadId)
    const sshPath = getSquadSshPath(squadId)
    expect(existsSync(join(sshPath, `ficus_remote_${keep.name}`))).toBe(true)
    expect(existsSync(join(sshPath, `ficus_remote_${revoke.name}`))).toBe(true)

    // Simulate revocation: delete the revoked host (grants cascade off it).
    await deleteRemoteHost(revoke.id)

    await materializeSquadRemoteHosts(squadId)

    expect(existsSync(join(sshPath, `ficus_remote_${keep.name}`))).toBe(true)
    expect(existsSync(join(sshPath, `ficus_remote_${revoke.name}`))).toBe(false)

    const config = readFileSync(join(sshPath, 'config'), 'utf-8')
    expect(config).toContain(`Host ${keep.name}`)
    expect(config).not.toContain(`Host ${revoke.name}`)
  })

  it('revoking only this squad grant (host stays in the registry) removes just its key file', async () => {
    const squadId = `${prefix}-squad-revoke-grant`
    const host = await createGrantedHost('revoke-grant-only', squadId)

    await materializeSquadRemoteHosts(squadId)
    const sshPath = getSquadSshPath(squadId)
    expect(existsSync(join(sshPath, `ficus_remote_${host.name}`))).toBe(true)

    // Revoke this squad's grant without deleting the host itself.
    await deleteGrant(host.id, squadId)

    await materializeSquadRemoteHosts(squadId)

    expect(existsSync(join(sshPath, `ficus_remote_${host.name}`))).toBe(false)
    const config = readFileSync(join(sshPath, 'config'), 'utf-8')
    expect(config).not.toContain(`Host ${host.name}`)

    // Host row itself is untouched by the revoke.
    expect((await listRemoteHosts()).some((h) => h.id === host.id)).toBe(true)
  })

  it('preserves user content above and below the managed block across rewrites', async () => {
    const squadId = `${prefix}-squad-user-content`
    ensureSquadSshDir(squadId)
    const configPath = join(getSquadSshPath(squadId), 'config')
    const userConfig = 'Host github.com\n  User git\n  IdentityFile ~/.ssh/deploy-key'
    // Write directly (bypassing setSshConfig) to seed pre-existing user config.
    writeFileSync(configPath, userConfig, { mode: 0o644 })

    await createGrantedHost('withuser', squadId)
    await materializeSquadRemoteHosts(squadId)

    const config = readFileSync(configPath, 'utf-8')
    expect(config).toContain('Host github.com')
    expect(config).toContain('IdentityFile ~/.ssh/deploy-key')
    expect(config).toContain(MANAGED_BLOCK_BEGIN)

    // Re-materializing again shouldn't drop or duplicate the user content.
    await materializeSquadRemoteHosts(squadId)
    const configAgain = readFileSync(configPath, 'utf-8')
    expect(configAgain.match(/Host github\.com/g)?.length).toBe(1)
    expect(configAgain).toContain('IdentityFile ~/.ssh/deploy-key')
  })

  it('skips (and does not write a key file for) a host with no private key in the secret store', async () => {
    const squadId = `${prefix}-squad-missing-secret`
    const host = await insertRemoteHost(hostValues('missing-secret'))
    await insertGrant({ hostId: host.id, squadId })
    // Note: no getSecretStore().set() call — the secret is absent.

    await materializeSquadRemoteHosts(squadId)

    const sshPath = getSquadSshPath(squadId)
    expect(existsSync(join(sshPath, `ficus_remote_${host.name}`))).toBe(false)
    const config = existsSync(join(sshPath, 'config')) ? readFileSync(join(sshPath, 'config'), 'utf-8') : ''
    expect(config).not.toContain(`Host ${host.name}`)
  })

  it('listSshKeys excludes the materialized ficus_remote_ key file but still lists a genuinely uploaded key', async () => {
    const squadId = `${prefix}-squad-listkeys`
    const host = await createGrantedHost('listkeys', squadId)

    await materializeSquadRemoteHosts(squadId)
    await addSshKey(squadId, 'my-real-key', VALID_TEST_KEY)

    const keys = await listSshKeys(squadId)
    expect(keys.map((k) => k.name)).toEqual(['my-real-key'])
    expect(keys.map((k) => k.name)).not.toContain(`ficus_remote_${host.name}`)
  })
})

describe('getManagedBlockForSquad', () => {
  it('reflects current DB grants', async () => {
    const squadId = `${prefix}-squad-getblock`
    expect(await getManagedBlockForSquad(squadId)).toBe('')

    const host = await createGrantedHost('getblock', squadId)
    const block = await getManagedBlockForSquad(squadId)
    expect(block).toContain(`Host ${host.name}`)
  })

  it('excludes a granted host whose secret has been deleted from the store, same as materializeSquadRemoteHosts', async () => {
    const squadId = `${prefix}-squad-getblock-missing-secret`
    const host = await createGrantedHost('getblock-missing-secret', squadId)
    // Materialize once (secret present), then delete the secret out from
    // under the grant without revoking it — mirrors a secret-store
    // eviction/rotation-gone-wrong scenario.
    await materializeSquadRemoteHosts(squadId)
    await getSecretStore().delete(host.sshKeyId)

    const block = await getManagedBlockForSquad(squadId)
    expect(block).not.toContain(`Host ${host.name}`)
  })
})

describe('setSshConfig managed-block preservation', () => {
  it('round-trips: re-appends the current managed block after a user overwrite', async () => {
    const squadId = `${prefix}-squad-setconfig`
    const host = await createGrantedHost('setconfig', squadId)
    await materializeSquadRemoteHosts(squadId)

    await setSshConfig(squadId, 'Host github.com\n  User git')

    const config = readFileSync(join(getSquadSshPath(squadId), 'config'), 'utf-8')
    expect(config).toContain('Host github.com')
    expect(config).toContain(MANAGED_BLOCK_BEGIN)
    expect(config).toContain(`Host ${host.name}`)
  })

  it('does not re-inject a stanza for a host whose secret was deleted after materialization', async () => {
    const squadId = `${prefix}-squad-setconfig-missing-secret`
    const host = await createGrantedHost('setconfig-missing-secret', squadId)
    await materializeSquadRemoteHosts(squadId)
    // Secret disappears from the store without the grant being revoked
    // (e.g. eviction). The grant is still valid, so a naive
    // getManagedBlockForSquad that renders ALL granted hosts (rather than
    // applying the same secret-presence eligibility as materialize) would
    // re-append a `Host` stanza pointing at a key file that no longer
    // exists on disk.
    await getSecretStore().delete(host.sshKeyId)

    await setSshConfig(squadId, 'Host github.com\n  User git')

    // setSshConfig only rewrites `config`, not key files (stale key-file
    // cleanup is materializeSquadRemoteHosts's job on its next run) — the
    // bug under test is specifically that the *stanza* must not reappear.
    const config = readFileSync(join(getSquadSshPath(squadId), 'config'), 'utf-8')
    expect(config).toContain('Host github.com')
    expect(config).not.toContain(`Host ${host.name}`)
  })

  it('strips a forged managed block from user-supplied content', async () => {
    const squadId = `${prefix}-squad-forged`
    const host = await createGrantedHost('forged', squadId)

    const forged = `Host github.com\n  User git\n\n${MANAGED_BLOCK_BEGIN}\nHost evil\n  HostName attacker.example.com\n${MANAGED_BLOCK_END}\n`
    await setSshConfig(squadId, forged)

    const config = readFileSync(join(getSquadSshPath(squadId), 'config'), 'utf-8')
    expect(config).not.toContain('Host evil')
    expect(config).not.toContain('attacker.example.com')
    expect(config).toContain('Host github.com')
    expect(config).toContain(`Host ${host.name}`)
    // Exactly one pair of markers survives (the real, recomputed block).
    expect(config.match(new RegExp(MANAGED_BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(1)
  })
})
