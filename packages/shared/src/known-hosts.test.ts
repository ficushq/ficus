import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import {
  findKnownHostKeys,
  hostKeyFingerprint,
  removeConflictingHostKeys,
  KNOWN_HOSTS_BLOCK_BEGIN,
  KNOWN_HOSTS_BLOCK_END,
  knownHostsName,
  mergeManagedKnownHosts,
} from './known-hosts'

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
    expect(result.conflicts).toEqual([
      {
        host: 'managed.example',
        keyType: 'ssh-ed25519',
        line: 1,
        key: 'AAAAC3NzaC1lZDI1NTE5AAAAIMANAGEDKEY1',
        boxKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIUSERPINNED',
        wildcard: false,
      },
    ])
  })

  test('a hashed user entry for a managed host with a different key is reported, not overwritten', () => {
    const hashedUser = `${hashedHost('managed.example')} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUSERPINNED`
    const result = mergeManagedKnownHosts(`# trusted by hand\n${hashedUser}\n`, `${MANAGED}\n`)
    expect(result.content).toBe(`# trusted by hand\n${hashedUser}\n`)
    expect(result.conflicts).toMatchObject([
      { host: 'managed.example', keyType: 'ssh-ed25519', line: 2, wildcard: false },
    ])
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
    expect(result.conflicts).toMatchObject([{ host: 'managed.example', keyType: 'ssh-ed25519', line: 1 }])
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

describe('knownHostsName', () => {
  test('bare lowercased host on port 22, bracketed host:port otherwise', () => {
    expect(knownHostsName('Box.Example', 22)).toBe('box.example')
    expect(knownHostsName('box.example', 2222)).toBe('[box.example]:2222')
  })
})

describe('findKnownHostKeys', () => {
  const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIKEYA'
  const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIKEYB'
  const RSA = 'AAAAB3NzaC1yc2EAAAADAQABAAABAQCRSA'

  test('finds plain, comma-listed and hashed entries for the exact name only', () => {
    const content = [
      `[box.example]:2222 ssh-ed25519 ${KEY_A}`,
      `other.example,[box.example]:2222 ssh-rsa ${RSA}`,
      `${hashedHost('[box.example]:2222')} ssh-ed25519 ${KEY_B}`,
      `box.example ssh-ed25519 ${KEY_B}`,
      `*.example ssh-ed25519 ${KEY_B}`,
      '# comment',
    ].join('\n')
    expect(findKnownHostKeys(content, '[box.example]:2222')).toEqual([
      { keyType: 'ssh-ed25519', key: KEY_A, line: 1 },
      { keyType: 'ssh-rsa', key: RSA, line: 2 },
      { keyType: 'ssh-ed25519', key: KEY_B, line: 3 },
    ])
  })

  test('skips negated matches, cert authorities and revoked keys', () => {
    const content = [
      `box.example,!box.example ssh-ed25519 ${KEY_A}`,
      `@cert-authority box.example ssh-ed25519 ${KEY_A}`,
      `box.example ssh-ed25519 ${KEY_B}`,
      `@revoked box.example ssh-ed25519 ${KEY_B}`,
    ].join('\n')
    expect(findKnownHostKeys(content, 'box.example')).toEqual([])
  })
})

describe('wildcard and negated user patterns', () => {
  const PINNED = 'AAAAC3NzaC1lZDI1NTE5AAAAIUSERPINNED'

  test('a wildcard user line pinning a different key is a conflict flagged as wildcard', () => {
    const wildcardLine = `*.example ssh-ed25519 ${PINNED}`
    const result = mergeManagedKnownHosts(`${wildcardLine}\n`, `${MANAGED}\n`)
    expect(result.conflicts).toMatchObject([{ host: 'managed.example', line: 1, boxKey: PINNED, wildcard: true }])
    expect(result.content).toBe(`${wildcardLine}\n`)
  })

  test('? patterns match a single character', () => {
    const result = mergeManagedKnownHosts(`managed.exampl? ssh-ed25519 ${PINNED}\n`, `${MANAGED}\n`)
    expect(result.conflicts).toMatchObject([{ wildcard: true }])
    expect(mergeManagedKnownHosts(`managed.exam? ssh-ed25519 ${PINNED}\n`, `${MANAGED}\n`).conflicts).toEqual([])
  })

  test('a negated pattern naming the host excludes the line', () => {
    const result = mergeManagedKnownHosts(`*.example,!managed.example ssh-ed25519 ${PINNED}\n`, `${MANAGED}\n`)
    expect(result.conflicts).toEqual([])
    expect(result.content).toContain(KNOWN_HOSTS_BLOCK_BEGIN)
  })

  test('a wildcard does not match a bracketed non-default-port name', () => {
    const result = mergeManagedKnownHosts(`*.example ssh-ed25519 ${PINNED}\n`, `${OTHER_MANAGED}\n`)
    expect(result.conflicts).toEqual([])
  })
})

describe('hostKeyFingerprint', () => {
  test('matches OpenSSH SHA256 formatting (unpadded base64 of the decoded blob)', () => {
    const blob = Buffer.from('synthetic key blob').toString('base64')
    const expected = createHash('sha256').update('synthetic key blob').digest('base64').replace(/=+$/, '')
    expect(hostKeyFingerprint(blob)).toBe(`SHA256:${expected}`)
  })
})

describe('removeConflictingHostKeys', () => {
  const CORE = 'AAAAC3NzaC1lZDI1NTE5AAAAIMANAGEDKEY1'
  const BOX = 'AAAAC3NzaC1lZDI1NTE5AAAAIUSERPINNED'

  test('removes plain and hashed conflicting lines and keeps every other line byte-for-byte', () => {
    const existing = [
      '# my hosts',
      `managed.example ssh-ed25519 ${BOX} comment here`,
      `  ${USER}`,
      `${hashedHost('managed.example')} ssh-ed25519 ${BOX}`,
      `managed.example ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQUSERRSA`,
      `managed.example ssh-ed25519 ${CORE}`,
      '',
    ].join('\n')
    const result = removeConflictingHostKeys(existing, 'managed.example', 'ssh-ed25519', CORE)
    expect(result.editedLines).toEqual([2, 4])
    expect(result.wildcardLines).toEqual([])
    expect(result.content).toBe(
      [
        '# my hosts',
        `  ${USER}`,
        `managed.example ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQUSERRSA`,
        `managed.example ssh-ed25519 ${CORE}`,
        '',
      ].join('\n')
    )
    // Once removed, the managed entry merges in without a conflict.
    expect(mergeManagedKnownHosts(result.content, `${MANAGED}\n`).conflicts).toEqual([])
  })

  test('a comma-listed line keeps its other hosts', () => {
    const existing = `alias.example,managed.example,!x.example ssh-ed25519 ${BOX} c\n`
    const result = removeConflictingHostKeys(existing, 'managed.example', 'ssh-ed25519', CORE)
    expect(result.content).toBe(`alias.example,!x.example ssh-ed25519 ${BOX} c\n`)
  })

  test('never edits a wildcard line (or anything else when one is present)', () => {
    const existing = `*.example ssh-ed25519 ${BOX}\nmanaged.example ssh-ed25519 ${BOX}\n`
    const result = removeConflictingHostKeys(existing, 'managed.example', 'ssh-ed25519', CORE)
    expect(result.wildcardLines).toEqual([1])
    expect(result.editedLines).toEqual([])
    expect(result.content).toBe(existing)
  })

  test('a line naming the host both exactly and by wildcard counts as a wildcard line', () => {
    const existing = `managed.example,*.example ssh-ed25519 ${BOX}\n`
    const result = removeConflictingHostKeys(existing, 'managed.example', 'ssh-ed25519', CORE)
    expect(result.wildcardLines).toEqual([1])
    expect(result.content).toBe(existing)
  })

  test('leaves managed-block lines alone', () => {
    const existing = `${block(`managed.example ssh-ed25519 ${BOX}`)}\n`
    const result = removeConflictingHostKeys(existing, 'managed.example', 'ssh-ed25519', CORE)
    expect(result.editedLines).toEqual([])
    expect(result.content).toBe(existing)
  })
})
