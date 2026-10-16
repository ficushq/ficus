import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KNOWN_HOSTS_BLOCK_BEGIN, KNOWN_HOSTS_BLOCK_END } from '@ficus/shared/known-hosts'
import { syncKnownHostsFile } from './known-hosts-sync'

// Synthetic hosts and keys only; every file lives in a throwaway temp dir.
const USER = 'user.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUSERKEY'
const MANAGED = 'managed.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMANAGEDKEY1'
const ROTATED = 'managed.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMANAGEDKEY2'
const block = (...lines: string[]) => `${KNOWN_HOSTS_BLOCK_BEGIN}\n${lines.join('\n')}\n${KNOWN_HOSTS_BLOCK_END}\n`

let dir: string
let source: string
let dest: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'known-hosts-sync-'))
  source = join(dir, 'source_known_hosts')
  dest = join(dir, 'known_hosts')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('syncKnownHostsFile', () => {
  test('keeps sandbox-trusted entries and adds the managed block (0600)', async () => {
    writeFileSync(dest, `${USER}\n`, { mode: 0o644 })
    writeFileSync(source, `${MANAGED}\n`)
    const result = await syncKnownHostsFile(source, dest)
    expect(result).toEqual({ written: true, conflicts: [] })
    expect(readFileSync(dest, 'utf8')).toBe(`${USER}\n${block(MANAGED)}`)
    expect(statSync(dest).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  test('is idempotent: a second run does not rewrite the file', async () => {
    writeFileSync(dest, `${USER}\n`)
    writeFileSync(source, `${MANAGED}\n`)
    await syncKnownHostsFile(source, dest)
    const inode = statSync(dest).ino
    expect(await syncKnownHostsFile(source, dest)).toEqual({ written: false, conflicts: [] })
    expect(statSync(dest).ino).toBe(inode)
  })

  test('rotates only the managed entry, and a missing source drops only the block', async () => {
    writeFileSync(dest, `${USER}\n${block(MANAGED)}`)
    writeFileSync(source, `${ROTATED}\n`)
    await syncKnownHostsFile(source, dest)
    expect(readFileSync(dest, 'utf8')).toBe(`${USER}\n${block(ROTATED)}`)
    rmSync(source)
    await syncKnownHostsFile(source, dest)
    expect(readFileSync(dest, 'utf8')).toBe(`${USER}\n`)
  })

  test('reports a conflicting sandbox entry and leaves it in place', async () => {
    const pinned = 'managed.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUSERPINNED'
    writeFileSync(dest, `${pinned}\n`)
    writeFileSync(source, `${MANAGED}\n`)
    const result = await syncKnownHostsFile(source, dest)
    expect(result.conflicts).toEqual([{ host: 'managed.example', keyType: 'ssh-ed25519', line: 1 }])
    expect(readFileSync(dest, 'utf8')).toBe(`${pinned}\n`)
  })

  test('creates nothing when neither file exists', async () => {
    expect(await syncKnownHostsFile(source, dest)).toEqual({ written: false, conflicts: [] })
    expect(readdirSync(dir)).toEqual([])
  })
})
