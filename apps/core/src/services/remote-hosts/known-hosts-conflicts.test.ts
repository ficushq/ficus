import { afterEach, describe, expect, it } from 'bun:test'
import { createHash, createHmac } from 'crypto'
import { EventEmitter } from 'events'
import { eq, like } from 'drizzle-orm'
import { KNOWN_HOSTS_BLOCK_BEGIN, KNOWN_HOSTS_BLOCK_END, mergeManagedKnownHosts } from '@ficus/shared/known-hosts'
import { db, knownHostsConflicts } from '../../db'
import { SandboxHttpError } from '../sandbox/client/http-client'
import {
  ConflictResolutionError,
  keepBoxKey,
  listSquadKnownHostsConflicts,
  recordBoxKnownHostsConflicts,
  useCoreKey,
} from './known-hosts-conflicts'

// Synthetic hosts, keys and boxes only.
const prefix = `khc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SQUAD = `${prefix}-squad`
const HOME = '/home/box_test'
const KH = `${HOME}/.ssh/known_hosts`
const CORE_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAICOREKEY'
const BOX_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIBOXKEY'
const MANAGED = `git.example ssh-ed25519 ${CORE_KEY}`
const USER = `other.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHER`
let boxSeq = 0
const nextBox = () => `${prefix}-box-${++boxSeq}`

function hashed(host: string): string {
  const salt = Buffer.from('0123456789abcdefghij')
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(host).digest('base64')}`
}

/** Minimal sandbox client: /read, /write-verified (compare-and-swap) and bash (chmod). */
class FakeBox {
  files = new Map<string, Buffer>()
  bashes: string[] = []
  async read(req: { path: string; limit?: number }) {
    const bytes = this.files.get(req.path)
    if (!bytes) throw new SandboxHttpError(`ENOENT: ${req.path}`, 404)
    return { content: bytes.subarray(0, req.limit).toString('base64'), totalSize: bytes.length, isBinary: false }
  }
  async write(req: { path: string; content: string }) {
    this.files.set(req.path, Buffer.from(req.content, 'base64'))
    return { bytesWritten: 0 }
  }
  async writeVerified(req: { path: string; content: string; expectedOriginal: { bytes: number; sha256: string } }) {
    const current = this.files.get(req.path)
    const sha = current ? createHash('sha256').update(current).digest('hex') : ''
    if (!current || sha !== req.expectedOriginal.sha256) {
      throw new SandboxHttpError('Edit conflict', 409, 'edit-conflict', 'pre-publication')
    }
    const bytes = Buffer.from(req.content, 'base64')
    this.files.set(req.path, bytes)
    return { bytesWritten: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  bash(req: { command: string }) {
    this.bashes.push(req.command)
    const stream = new EventEmitter() as EventEmitter & { cancel: () => void }
    stream.cancel = () => {}
    queueMicrotask(() => {
      stream.emit('data', { exitCode: 0 })
      stream.emit('end')
    })
    return stream
  }
  text() {
    return this.files.get(KH)?.toString('utf8')
  }
}

/** Run Core's merge against the box's file and record the conflicts, as a vm sync does. */
async function syncBox(sandboxId: string, box: FakeBox) {
  const { conflicts } = mergeManagedKnownHosts(box.text() ?? '', `${MANAGED}\n`)
  await recordBoxKnownHostsConflicts(sandboxId, SQUAD, conflicts)
}

function deps(box: FakeBox | null) {
  return {
    getClient: async () => box as never,
    boxHome: () => HOME,
    managedKnownHosts: () => `${MANAGED}\n`,
  }
}

afterEach(async () => {
  await db.delete(knownHostsConflicts).where(like(knownHostsConflicts.squadId, `${prefix}%`))
})

describe('known_hosts conflicts', () => {
  it('a conflict is persisted with both fingerprints and cleared when it disappears', async () => {
    const sandboxId = nextBox()
    const box = new FakeBox()
    box.files.set(KH, Buffer.from(`git.example ssh-ed25519 ${BOX_KEY}\n`))
    await syncBox(sandboxId, box)

    const [row] = await listSquadKnownHostsConflicts(SQUAD)
    expect(row).toMatchObject({ sandboxId, host: 'git.example', keyType: 'ssh-ed25519', status: 'open', boxLine: 1 })
    expect(row.boxFingerprint).toMatch(/^SHA256:/)
    expect(row.coreFingerprint).toMatch(/^SHA256:/)
    expect(row.boxFingerprint).not.toBe(row.coreFingerprint)

    // Someone fixes the box by hand; the next merge reports nothing.
    box.files.set(KH, Buffer.from(`${USER}\n`))
    await syncBox(sandboxId, box)
    expect(await listSquadKnownHostsConflicts(SQUAD)).toEqual([])
  })

  it('keeping the box key stops re-reporting that exact pair, but a changed key is reported again', async () => {
    const sandboxId = nextBox()
    const box = new FakeBox()
    box.files.set(KH, Buffer.from(`git.example ssh-ed25519 ${BOX_KEY}\n`))
    await syncBox(sandboxId, box)
    const [open] = await listSquadKnownHostsConflicts(SQUAD)

    const kept = await keepBoxKey(SQUAD, open.id, 'user-1')
    expect(kept).toMatchObject({ status: 'kept-box', resolvedByUserId: 'user-1' })
    expect(kept.resolvedAt).toBeInstanceOf(Date)

    await syncBox(sandboxId, box)
    let rows = await listSquadKnownHostsConflicts(SQUAD)
    expect(rows.map((r) => r.status)).toEqual(['kept-box'])

    // The box key changes: a new pair, reported again.
    box.files.set(KH, Buffer.from(`git.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHERBOX\n`))
    await syncBox(sandboxId, box)
    rows = await listSquadKnownHostsConflicts(SQUAD)
    expect(rows.map((r) => r.status).sort()).toEqual(['kept-box', 'open'])
  })

  it('use Core key removes only the matching plain and hashed box lines, keeps the rest byte-for-byte, writes 0600', async () => {
    const sandboxId = nextBox()
    const box = new FakeBox()
    const before = [
      '# hand-written',
      USER,
      `git.example ssh-ed25519 ${BOX_KEY}`,
      `${hashed('git.example')} ssh-ed25519 ${BOX_KEY}`,
      'git.example ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQRSA',
      `alias.example,git.example ssh-ed25519 ${BOX_KEY} shared line`,
      '',
    ].join('\n')
    box.files.set(KH, Buffer.from(before))
    await syncBox(sandboxId, box)
    const [open] = await listSquadKnownHostsConflicts(SQUAD)

    const resolved = await useCoreKey(SQUAD, open.id, 'user-2', deps(box))
    expect(resolved).toMatchObject({ status: 'resolved-core', resolvedByUserId: 'user-2' })

    expect(box.text()).toBe(
      [
        '# hand-written',
        USER,
        'git.example ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQRSA',
        `alias.example ssh-ed25519 ${BOX_KEY} shared line`,
        KNOWN_HOSTS_BLOCK_BEGIN,
        MANAGED,
        KNOWN_HOSTS_BLOCK_END,
        '',
      ].join('\n')
    )
    expect(box.bashes).toContain(`chmod 600 '${KH}'`)
    // Resolved conflicts are no longer listed, and a re-sync reports nothing.
    await syncBox(sandboxId, box)
    expect(await listSquadKnownHostsConflicts(SQUAD)).toEqual([])
    const [audit] = await db.select().from(knownHostsConflicts).where(eq(knownHostsConflicts.id, open.id))
    expect(audit).toMatchObject({ status: 'resolved-core', resolvedByUserId: 'user-2' })
  })

  it('a wildcard conflict is detected but never auto-deleted; use Core key is refused, keep box key works', async () => {
    const sandboxId = nextBox()
    const box = new FakeBox()
    const before = `*.example ssh-ed25519 ${BOX_KEY}\n`
    box.files.set(KH, Buffer.from(before))
    await syncBox(sandboxId, box)
    const [open] = await listSquadKnownHostsConflicts(SQUAD)
    expect(open).toMatchObject({ wildcard: true, status: 'open' })

    await expect(useCoreKey(SQUAD, open.id, 'user-3', deps(box))).rejects.toThrow('wildcard')
    expect(box.text()).toBe(before)
    expect((await keepBoxKey(SQUAD, open.id, 'user-3')).status).toBe('kept-box')
  })

  it('refuses when a concrete conflict is also covered by a wildcard line found at resolution time', async () => {
    const sandboxId = nextBox()
    const box = new FakeBox()
    box.files.set(KH, Buffer.from(`git.example ssh-ed25519 ${BOX_KEY}\n`))
    await syncBox(sandboxId, box)
    const [open] = await listSquadKnownHostsConflicts(SQUAD)
    const now = `git.example ssh-ed25519 ${BOX_KEY}\ngit.* ssh-ed25519 ${BOX_KEY}\n`
    box.files.set(KH, Buffer.from(now))

    const err = await useCoreKey(SQUAD, open.id, 'user-4', deps(box)).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictResolutionError)
    expect(err.status).toBe(409)
    expect(box.text()).toBe(now)
    expect((await listSquadKnownHostsConflicts(SQUAD))[0].status).toBe('open')
  })

  it('an unreachable box refuses use Core key without changing anything', async () => {
    const sandboxId = nextBox()
    const box = new FakeBox()
    box.files.set(KH, Buffer.from(`git.example ssh-ed25519 ${BOX_KEY}\n`))
    await syncBox(sandboxId, box)
    const [open] = await listSquadKnownHostsConflicts(SQUAD)
    await expect(useCoreKey(SQUAD, open.id, 'user-5', deps(null))).rejects.toThrow('not reachable')
    expect((await listSquadKnownHostsConflicts(SQUAD))[0].status).toBe('open')
  })

  it('a conflict cannot be resolved twice or through another squad', async () => {
    const sandboxId = nextBox()
    const box = new FakeBox()
    box.files.set(KH, Buffer.from(`git.example ssh-ed25519 ${BOX_KEY}\n`))
    await syncBox(sandboxId, box)
    const [open] = await listSquadKnownHostsConflicts(SQUAD)
    await expect(keepBoxKey(`${prefix}-other-squad`, open.id, 'u')).rejects.toThrow('not found')
    await keepBoxKey(SQUAD, open.id, 'u')
    await expect(keepBoxKey(SQUAD, open.id, 'u')).rejects.toThrow('already resolved')
  })
})
