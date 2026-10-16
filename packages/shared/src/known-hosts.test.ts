import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { KNOWN_HOSTS_BLOCK_BEGIN, KNOWN_HOSTS_BLOCK_END, mergeManagedKnownHosts } from './known-hosts'

// Synthetic hosts and keys only.
const USER = 'user.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUSERKEY'
const MANAGED = 'managed.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMANAGEDKEY1'
const MANAGED_ROTATED = 'managed.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMANAGEDKEY2'
const OTHER_MANAGED = '[other.example]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHERKEY'

function block(...lines: string[]): string {
  return [KNOWN_HOSTS_BLOCK_BEGIN, ...lines, KNOWN_HOSTS_BLOCK_END].join('\n')
}

function hashedHost(host: string, salt = Buffer.from('0123456789abcdefghij')): string {
  const hash = createHmac('sha1', salt).update(host).digest('base64')
  return `|1|${salt.toString('base64')}|${hash}`
}

describe('mergeManagedKnownHosts', () => {
  test('keeps a pre-existing user entry and appends managed entries in a delimited block', () => {
    const result = mergeManagedKnownHosts(`${USER}\n`, `${MANAGED}\n`)
    expect(result.content).toBe(`${USER}\n${block(MANAGED)}\n`)
    expect(result.changed).toBe(true)
    expect(result.conflicts).toEqual([])
  })

  test('repeated materialization is idempotent (same bytes, no duplicates)', () => {
    const once = mergeManagedKnownHosts(`${USER}\n`, `${MANAGED}\n${OTHER_MANAGED}\n`)
    const twice = mergeManagedKnownHosts(once.content, `${MANAGED}\n${OTHER_MANAGED}\n`)
    expect(twice.content).toBe(once.content)
    expect(twice.changed).toBe(false)
    expect(twice.content.split(MANAGED).length - 1).toBe(1)
  })

  test('duplicate managed source lines are written once', () => {
    const result = mergeManagedKnownHosts('', `${MANAGED}\n${MANAGED}\n`)
    expect(result.content).toBe(`${block(MANAGED)}\n`)
  })

  test('managed key rotation replaces only the managed entry', () => {
    const before = mergeManagedKnownHosts(`${USER}\n`, `${MANAGED}\n${OTHER_MANAGED}\n`).content
    const after = mergeManagedKnownHosts(before, `${MANAGED_ROTATED}\n${OTHER_MANAGED}\n`)
    expect(after.content).toBe(`${USER}\n${block(MANAGED_ROTATED, OTHER_MANAGED)}\n`)
    expect(after.content).not.toContain(MANAGED)
    expect(after.conflicts).toEqual([])
  })

  test('removing a managed entry removes only that entry', () => {
    const before = mergeManagedKnownHosts(`${USER}\n`, `${MANAGED}\n${OTHER_MANAGED}\n`).content
    const after = mergeManagedKnownHosts(before, `${OTHER_MANAGED}\n`)
    expect(after.content).toBe(`${USER}\n${block(OTHER_MANAGED)}\n`)
  })

  test('removing every managed entry drops the block and keeps user entries', () => {
    const before = mergeManagedKnownHosts(`${USER}\n`, `${MANAGED}\n`).content
    const after = mergeManagedKnownHosts(before, '')
    expect(after.content).toBe(`${USER}\n`)
    expect(after.changed).toBe(true)
  })

  test('user entries added after the block survive and stay outside it', () => {
    const managed = mergeManagedKnownHosts('', `${MANAGED}\n`).content
    const appended = `${managed}${USER}\n`
    const result = mergeManagedKnownHosts(appended, `${MANAGED_ROTATED}\n`)
    expect(result.content).toBe(`${USER}\n${block(MANAGED_ROTATED)}\n`)
  })

  test('a user entry for a managed host with a different key is reported and never overwritten', () => {
    const userForManagedHost = 'managed.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUSERPINNED'
    const existing = `${userForManagedHost}\n`
    const result = mergeManagedKnownHosts(existing, `${MANAGED}\n${OTHER_MANAGED}\n`)
    expect(result.content).toBe(`${userForManagedHost}\n${block(OTHER_MANAGED)}\n`)
    expect(result.content).not.toContain(MANAGED)
    expect(result.conflicts).toEqual([{ host: 'managed.example', keyType: 'ssh-ed25519', line: 1 }])
  })

  test('a hashed user entry for a managed host with a different key is reported, not overwritten', () => {
    const hashedUser = `${hashedHost('managed.example')} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUSERPINNED`
    const result = mergeManagedKnownHosts(`# trusted by hand\n${hashedUser}\n`, `${MANAGED}\n`)
    expect(result.content).toBe(`# trusted by hand\n${hashedUser}\n`)
    expect(result.conflicts).toEqual([{ host: 'managed.example', keyType: 'ssh-ed25519', line: 2 }])
    expect(result.changed).toBe(false)
  })

  test('hashed user entries for other hosts are kept untouched', () => {
    const hashedOther = `${hashedHost('elsewhere.example')} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIELSEWHERE`
    const result = mergeManagedKnownHosts(`${hashedOther}\n`, `${MANAGED}\n`)
    expect(result.content).toBe(`${hashedOther}\n${block(MANAGED)}\n`)
    expect(result.conflicts).toEqual([])
  })

  test('a non-default port is a different host from the bare name', () => {
    const userBare = 'other.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUSERPINNED'
    const result = mergeManagedKnownHosts(`${userBare}\n`, `${OTHER_MANAGED}\n`)
    expect(result.conflicts).toEqual([])
    expect(result.content).toBe(`${userBare}\n${block(OTHER_MANAGED)}\n`)
  })

  test('a different key type for the same host is not a conflict', () => {
    const userRsa = 'managed.example ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQUSERRSA'
    const result = mergeManagedKnownHosts(`${userRsa}\n`, `${MANAGED}\n`)
    expect(result.conflicts).toEqual([])
    expect(result.content).toBe(`${userRsa}\n${block(MANAGED)}\n`)
  })

  test('a managed entry the user already trusts with the same key is not duplicated', () => {
    const result = mergeManagedKnownHosts(`${MANAGED}\n`, `${MANAGED}\n`)
    expect(result.content).toBe(`${MANAGED}\n`)
    expect(result.changed).toBe(false)
    expect(result.conflicts).toEqual([])
  })

  test('host matching is case-insensitive across comma-separated patterns', () => {
    const userMulti = 'alias.example,MANAGED.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUSERPINNED'
    const result = mergeManagedKnownHosts(`${userMulti}\n`, `${MANAGED}\n`)
    expect(result.conflicts).toEqual([{ host: 'managed.example', keyType: 'ssh-ed25519', line: 1 }])
  })

  test('existing content is returned byte-for-byte when there is nothing to manage', () => {
    const existing = `${USER}\n\n# comment\n|1|weird|entry ssh-ed25519 KEY`
    const result = mergeManagedKnownHosts(existing, '')
    expect(result.content).toBe(existing)
    expect(result.changed).toBe(false)
  })

  test('comments, blank lines and markers in the managed source are not copied', () => {
    const source = `# note\n\n${KNOWN_HOSTS_BLOCK_BEGIN}\n${MANAGED}\n${KNOWN_HOSTS_BLOCK_END}\nnot a valid line\n`
    const result = mergeManagedKnownHosts('', source)
    expect(result.content).toBe(`${block(MANAGED)}\n`)
  })

  test('marker entries (@cert-authority, @revoked) are carried in the block without conflict checks', () => {
    const revoked = '@revoked managed.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOLDKEY'
    const result = mergeManagedKnownHosts(`${USER}\n`, `${revoked}\n`)
    expect(result.content).toBe(`${USER}\n${block(revoked)}\n`)
    expect(result.conflicts).toEqual([])
  })

  test('an unterminated begin marker never deletes the user lines that follow it', () => {
    const existing = `${KNOWN_HOSTS_BLOCK_BEGIN}\n${USER}\n`
    const result = mergeManagedKnownHosts(existing, `${MANAGED}\n`)
    expect(result.content).toBe(`${USER}\n${block(MANAGED)}\n`)
  })

  test('CRLF managed sources are normalised', () => {
    const result = mergeManagedKnownHosts('', `${MANAGED}\r\n`)
    expect(result.content).toBe(`${block(MANAGED)}\n`)
  })
})
