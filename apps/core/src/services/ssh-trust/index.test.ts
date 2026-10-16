import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { like } from 'drizzle-orm'
import { db, sshTrustTargets } from '../../db'
import type { HostKeyScanner, ScannedHostKey } from '../remote-hosts/host-keys'
import {
  ensureTrustTarget,
  hostKeyPinFor,
  HostKeyNotTrustedError,
  listTrustKeys,
  machineTrustSpec,
  memoryGitTrustSpec,
  refreshTrustTarget,
  rejectTrustKey,
  strictHostKeyArgs,
  toPublicTrustTargets,
  trustAlias,
  TrustDecisionError,
  trustTrustKey,
  type TrustTargetSpec,
} from './index'

const run = `sshtrust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const PERSON = `${run}-person`

// Synthetic host key blob (4-byte length + type + payload). Never a real host's key.
function syntheticKey(seed: string, keyType = 'ssh-ed25519'): string {
  const type = Buffer.from(keyType)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(type.length)
  return Buffer.concat([len, type, Buffer.from(`synthetic-${seed}`)]).toString('base64')
}

function key(seed: string, keyType = 'ssh-ed25519'): ScannedHostKey {
  return { keyType, publicKey: syntheticKey(seed, keyType) }
}

function scannerReturning(keys: ScannedHostKey[]): HostKeyScanner & { calls: number } {
  const scanner = (async () => {
    scanner.calls++
    return keys
  }) as HostKeyScanner & { calls: number }
  scanner.calls = 0
  return scanner
}

function spec(name: string, overrides: Partial<TrustTargetSpec> = {}): TrustTargetSpec {
  return {
    scope: `${run}:${name}`,
    kind: 'machine',
    label: `Machine ${name}`,
    sshHost: '10.0.0.9',
    sshPort: 2222,
    ...overrides,
  }
}

async function adoptingTarget(s: TrustTargetSpec) {
  await db.insert(sshTrustTargets).values({ ...s, adoptionPending: true })
  return ensureTrustTarget(s)
}

const originalHome = process.env.HOME_DIR
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ssh-trust-test-'))
  process.env.HOME_DIR = home
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
})

afterAll(async () => {
  await db.delete(sshTrustTargets).where(like(sshTrustTargets.scope, `${run}%`))
})

describe('specs', () => {
  it('memory git remotes are pinned per squad and host; HTTPS remotes have no SSH endpoint', () => {
    expect(memoryGitTrustSpec('sq1', 'git@GitHub.com:org/repo.git')).toMatchObject({
      scope: 'memory-git:sq1:github.com',
      kind: 'memory-git',
      sshHost: 'github.com',
      sshPort: 22,
      squadId: 'sq1',
    })
    expect(memoryGitTrustSpec('sq1', 'ssh://git.example.com/org/repo.git')?.sshHost).toBe('git.example.com')
    expect(memoryGitTrustSpec('sq1', 'https://github.com/org/repo.git')).toBeNull()
  })

  it('machines are pinned per machine; exe.dev VMs are their own kind', () => {
    const m = { id: 'm1', name: 'box', sshHost: 'h', sshPort: 22 }
    expect(machineTrustSpec({ ...m, provider: 'ssh' })).toMatchObject({ scope: 'machine:m1', kind: 'machine' })
    expect(machineTrustSpec({ ...m, provider: 'exe' })).toMatchObject({ scope: 'machine:m1', kind: 'exe-machine' })
  })

  it('aliases are shell-safe and distinct per endpoint', () => {
    expect(trustAlias('memory-git:a:b')).toMatch(/^ficus-trust\.[0-9a-f]+$/)
    expect(trustAlias('machine:1')).not.toBe(trustAlias('machine:2'))
  })

  it('strict args check only the pinned file and never learn a key', () => {
    const args = strictHostKeyArgs({ knownHostsPath: '/p/kh', alias: 'ficus-trust.x' }).join(' ')
    expect(args).toContain('-o StrictHostKeyChecking=yes')
    expect(args).toContain('-o UserKnownHostsFile=/p/kh')
    expect(args).toContain('-o GlobalKnownHostsFile=/dev/null')
    expect(args).toContain('-o HostKeyAlias=ficus-trust.x')
    expect(args).toContain('-o UpdateHostKeys=no')
    expect(args).not.toContain('accept-new')
  })
})

describe('hostKeyPinFor', () => {
  it('a new endpoint is fetched once, held pending and refused until a person trusts its key', async () => {
    const s = spec('new')
    const scanner = scannerReturning([key('new')])

    const refusal = await hostKeyPinFor(s, { scanner }).catch((e) => e)
    expect(refusal).toBeInstanceOf(HostKeyNotTrustedError)
    expect((refusal as HostKeyNotTrustedError).state).toBe('pending')
    expect((refusal as Error).message).toContain('A signed-in person must trust')
    await expect(hostKeyPinFor(s, { scanner })).rejects.toBeInstanceOf(HostKeyNotTrustedError)
    expect(scanner.calls).toBe(1)

    const target = await ensureTrustTarget(s)
    const [pending] = await listTrustKeys(target.id)
    expect(pending).toMatchObject({ status: 'pending', origin: 'scan', decidedByUserId: null })

    await trustTrustKey(target.id, pending.id, PERSON)
    const pin = await hostKeyPinFor(s, { scanner })
    expect(pin.alias).toBe(trustAlias(s.scope))
    expect(readFileSync(pin.knownHostsPath, 'utf8')).toBe(`${pin.alias} ssh-ed25519 ${syntheticKey('new')}\n`)
    expect(statSync(pin.knownHostsPath).mode & 0o777).toBe(0o600)
    expect((await listTrustKeys(target.id))[0]).toMatchObject({ status: 'trusted', decidedByUserId: PERSON })
  })

  it('an endpoint that existed under accept-new adopts the key Core already trusted, without a person', async () => {
    const s = spec('adopt')
    const target = await adoptingTarget(s)
    const scanner = scannerReturning([key('other')])
    const sources = [{ label: 'old known_hosts', read: () => `[10.0.0.9]:2222 ssh-ed25519 ${syntheticKey('adopt')}\n` }]

    const pin = await hostKeyPinFor(s, { scanner, sources })

    expect(readFileSync(pin.knownHostsPath, 'utf8')).toContain(syntheticKey('adopt'))
    expect(scanner.calls).toBe(0)
    const [adopted] = await listTrustKeys(target.id)
    expect(adopted).toMatchObject({ status: 'trusted', origin: 'adopted', decidedByUserId: null })
    expect(adopted.decisionNote).toContain('old known_hosts')
  })

  it('conflicting existing keys are not picked: each waits for a person', async () => {
    const s = spec('conflict')
    const target = await adoptingTarget(s)
    const sources = [
      { label: 'a', read: () => `[10.0.0.9]:2222 ssh-ed25519 ${syntheticKey('c1')}\n` },
      { label: 'b', read: () => `[10.0.0.9]:2222 ssh-ed25519 ${syntheticKey('c2')}\n` },
    ]

    await expect(hostKeyPinFor(s, { sources })).rejects.toBeInstanceOf(HostKeyNotTrustedError)
    const keys = await listTrustKeys(target.id)
    expect(keys.map((k) => [k.status, k.origin])).toEqual([
      ['pending', 'adoption-conflict'],
      ['pending', 'adoption-conflict'],
    ])
  })

  it('no existing key: fetched like a new endpoint, never trusted on first use', async () => {
    const s = spec('noevidence')
    await adoptingTarget(s)
    const scanner = scannerReturning([key('fresh')])
    await expect(hostKeyPinFor(s, { scanner, sources: [{ label: 'empty', read: () => '' }] })).rejects.toBeInstanceOf(
      HostKeyNotTrustedError
    )
    expect(scanner.calls).toBe(1)
  })

  it('an unreadable source defers adoption and refuses meanwhile', async () => {
    const s = spec('unreadable')
    const target = await adoptingTarget(s)
    await expect(hostKeyPinFor(s, { sources: [{ label: 'x', read: () => null }] })).rejects.toBeInstanceOf(
      HostKeyNotTrustedError
    )
    expect((await ensureTrustTarget(s)).adoptionPending).toBe(true)
    expect(await listTrustKeys(target.id)).toEqual([])
  })

  it('an exe.dev VM presenting the exe.dev key already trusted is trusted as that key; any other key waits', async () => {
    const api = await ensureTrustTarget(spec('exe-api', { kind: 'exe-api', label: 'exe.dev API' }))
    await refreshTrustTarget(api, scannerReturning([key('exe-proxy')]))
    const [apiKey] = await listTrustKeys(api.id)
    await trustTrustKey(api.id, apiKey.id, PERSON)

    const vm = spec('exe-vm', { kind: 'exe-machine' })
    const pin = await hostKeyPinFor(vm, { scanner: scannerReturning([key('exe-proxy'), key('vm-rsa', 'ssh-rsa')]) })
    expect(readFileSync(pin.knownHostsPath, 'utf8')).toBe(`${pin.alias} ssh-ed25519 ${syntheticKey('exe-proxy')}\n`)
    const keys = await listTrustKeys((await ensureTrustTarget(vm)).id)
    expect(keys.find((k) => k.keyType === 'ssh-ed25519')).toMatchObject({ status: 'trusted', origin: 'provider-key' })
    expect(keys.find((k) => k.keyType === 'ssh-rsa')).toMatchObject({ status: 'pending' })

    // A BYO machine presenting the same key gets no such shortcut.
    const byo = spec('byo-same-key')
    await expect(hostKeyPinFor(byo, { scanner: scannerReturning([key('exe-proxy')]) })).rejects.toBeInstanceOf(
      HostKeyNotTrustedError
    )
  })

  it('a changed key is shown as a change and never pinned; the trusted key stays the only pin', async () => {
    const s = spec('changed')
    const target = await ensureTrustTarget(s)
    await refreshTrustTarget(target, scannerReturning([key('k1')]))
    await trustTrustKey(target.id, (await listTrustKeys(target.id))[0].id, PERSON)
    await refreshTrustTarget(target, scannerReturning([key('k2')]))

    const [view] = await toPublicTrustTargets([target])
    expect(view.hostKeyState).toBe('changed')
    expect(view.hostKeys.find((k) => k.status === 'pending')?.replacesFingerprints).toHaveLength(1)
    const pin = await hostKeyPinFor(s)
    expect(readFileSync(pin.knownHostsPath, 'utf8')).toBe(`${pin.alias} ssh-ed25519 ${syntheticKey('k1')}\n`)
  })

  it('a rejected key is never pinned, and decisions are not repeatable', async () => {
    const s = spec('reject')
    const target = await ensureTrustTarget(s)
    await refreshTrustTarget(target, scannerReturning([key('bad')]))
    const [bad] = await listTrustKeys(target.id)
    await rejectTrustKey(target.id, bad.id, PERSON)

    await expect(hostKeyPinFor(s)).rejects.toBeInstanceOf(HostKeyNotTrustedError)
    expect(existsSync(join(home, 'ssh-trust'))).toBe(false)
    await expect(rejectTrustKey(target.id, bad.id, PERSON)).rejects.toBeInstanceOf(TrustDecisionError)
    await trustTrustKey(target.id, bad.id, PERSON) // a person may still change their mind
    await expect(trustTrustKey(target.id, bad.id, PERSON)).rejects.toBeInstanceOf(TrustDecisionError)
  })
})
