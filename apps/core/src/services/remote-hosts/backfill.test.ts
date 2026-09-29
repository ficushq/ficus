import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { eq } from 'drizzle-orm'
import { db, squads } from '../../db'
import { getSecretStore, resetSecretStore } from '../secrets'
import { deleteRemoteHost, insertGrant, insertRemoteHost, listRemoteHosts, type RemoteHost } from './queries'
import { remoteHosts } from '../../db'
import { backfillSquadSshConfigs } from './backfill'
import { MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END } from './materialize'
import { getSquadSshPath } from '../squad/ssh'

const prefix = `btest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const originalHomeDir = process.env.HOME_DIR
let tempDir: string
let priorEncryptionKey: string | undefined
let priorRuntime: string | undefined

function hostValues(name: string): typeof remoteHosts.$inferInsert {
  return {
    name: `${prefix}-${name}`,
    sshHost: '10.0.0.1',
    sshUser: 'ficus',
    sshKeyId: `${prefix}-secret-${name}`,
    sshPublicKey: 'ssh-ed25519 AAAA test',
  }
}

const createdSquadIds: string[] = []

async function createSquad(name: string): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(squads).values({ id, name: `${prefix}-${name}`, purpose: 'backfill test' })
  createdSquadIds.push(id)
  return id
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
  // Squad rows this suite created: grants (plain-text squadId, no FK) are
  // gone with their hosts above; the rows themselves must go too, or the
  // next test's innerJoin would still see them and skew the counts.
  while (createdSquadIds.length > 0) {
    const id = createdSquadIds.pop()!
    await db.delete(squads).where(eq(squads.id, id))
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
  tempDir = mkdtempSync(join(tmpdir(), 'remote-hosts-backfill-test-'))
  process.env.HOME_DIR = tempDir
  priorRuntime = process.env.FICUS_SANDBOX_RUNTIME
  await cleanupHosts()
})

afterEach(async () => {
  if (originalHomeDir === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHomeDir
  if (priorRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = priorRuntime
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  await cleanupHosts()
})

describe('backfillSquadSshConfigs', () => {
  it('re-materializes a stale ~/.ssh-style block to absolute host-runtime paths, preserving user content', async () => {
    // The gap this closes (issue #1331): a squad granted before host-mode
    // support still carries a managed block naming ~/.ssh/... paths, which
    // on host expand to the OPERATOR's home where the keys do not exist.
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    const squadId = await createSquad('stale')
    const host: RemoteHost = await createGrantedHost('stale', squadId)

    // Seed the stale shape: user stanza + old-style managed block.
    const sshDir = getSquadSshPath(squadId)
    mkdirSync(sshDir, { recursive: true })
    const staleConfig = [
      'Host mine',
      '  HostName my.example.com',
      '  User me',
      '',
      MANAGED_BLOCK_BEGIN,
      `  Host ${host.name}`,
      `    HostName ${host.sshHost}`,
      '    Port 22',
      `    User ${host.sshUser}`,
      `    IdentityFile ~/.ssh/ficus_remote_${host.name}`,
      '    IdentitiesOnly yes',
      '    StrictHostKeyChecking accept-new',
      MANAGED_BLOCK_END,
      '',
    ].join('\n')
    writeFileSync(join(sshDir, 'config'), staleConfig)

    expect(await backfillSquadSshConfigs()).toBe(1)

    const config = readFileSync(join(sshDir, 'config'), 'utf-8')
    expect(config).toContain(`IdentityFile ${join(sshDir, `ficus_remote_${host.name}`)}`)
    expect(config).toContain(`UserKnownHostsFile ${join(sshDir, 'known_hosts')}`)
    expect(config).not.toContain('~/.ssh/')
    // The user's own stanza survives byte-for-byte outside the markers.
    expect(config.startsWith('Host mine\n  HostName my.example.com\n  User me\n')).toBe(true)
    // The key file the absolute path names was (re)written too.
    expect(existsSync(join(sshDir, `ficus_remote_${host.name}`))).toBe(true)
  })

  it('is idempotent: a second run rewrites nothing (byte-identical config)', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    const squadId = await createSquad('idem')
    await createGrantedHost('idem', squadId)
    mkdirSync(getSquadSshPath(squadId), { recursive: true })
    writeFileSync(join(getSquadSshPath(squadId), 'config'), `Host mine\n  User me\n`)

    expect(await backfillSquadSshConfigs()).toBe(1)
    const once = readFileSync(join(getSquadSshPath(squadId), 'config'), 'utf-8')
    expect(await backfillSquadSshConfigs()).toBe(1)
    expect(readFileSync(join(getSquadSshPath(squadId), 'config'), 'utf-8')).toBe(once)
  })

  it('never creates an ssh dir for squads without grants', async () => {
    const squadId = await createSquad('nogrants')
    expect(await backfillSquadSshConfigs()).toBe(0)
    expect(existsSync(getSquadSshPath(squadId))).toBe(false)
  })

  it('skips archived squads and grants without a live squad row', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    // Archived squad with a grant: excluded by the query's archivedAt filter.
    const archivedId = await createSquad('archived')
    await db.update(squads).set({ archivedAt: new Date() }).where(eq(squads.id, archivedId))
    await createGrantedHost('archived', archivedId)
    // Grant whose squadId has no squads row at all (squad_id is plain text):
    // excluded by the inner join.
    await createGrantedHost('orphan', `${prefix}-no-such-squad`)

    expect(await backfillSquadSshConfigs()).toBe(0)
    expect(existsSync(getSquadSshPath(archivedId))).toBe(false)
  })

  it('materializes multiple granted squads and isolates per-squad failures', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    const squadA = await createSquad('multi-a')
    const squadB = await createSquad('multi-b')
    await createGrantedHost('multi-a', squadA)
    await createGrantedHost('multi-b', squadB)

    expect(await backfillSquadSshConfigs()).toBe(2)
    for (const id of [squadA, squadB]) {
      const config = readFileSync(join(getSquadSshPath(id), 'config'), 'utf-8')
      expect(config).toContain(MANAGED_BLOCK_BEGIN)
      expect(config).toContain(`UserKnownHostsFile ${join(getSquadSshPath(id), 'known_hosts')}`)
    }

    // A squad whose materialization throws (ssh dir replaced by a file) must
    // not block the others: the count drops by one, the healthy squad still
    // gets its config, and the function does not reject.
    rmSync(getSquadSshPath(squadB), { recursive: true, force: true })
    writeFileSync(getSquadSshPath(squadB), 'not a directory')
    expect(await backfillSquadSshConfigs()).toBe(1)
    expect(existsSync(join(getSquadSshPath(squadA), 'config'))).toBe(true)
  })
})
