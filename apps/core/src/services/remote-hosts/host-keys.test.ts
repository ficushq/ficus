import { afterEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
import { db, remoteHosts } from '../../db'
import {
  createHostKeyScanner,
  hostKeyState,
  listHostKeys,
  parseKeyscanOutput,
  recordPresentedKeys,
  refreshHostKeys,
  rejectHostKey,
  trustHostKey,
  type RemoteHostKey,
} from './host-keys'
import { adoptHostKeys, adoptPendingHostKeys, type AdoptionSource } from './host-key-adoption'
import { deleteRemoteHost, insertGrant, insertRemoteHost, listRemoteHosts } from './queries'

// Synthetic hosts and keys only; nothing here connects anywhere.
const prefix = `hktest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function syntheticKey(seed: string, keyType = 'ssh-ed25519'): string {
  const type = Buffer.from(keyType)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(type.length)
  return Buffer.concat([len, type, Buffer.from(`synthetic-${seed}`)]).toString('base64')
}
const ED_A = syntheticKey('a')
const ED_B = syntheticKey('b')
const RSA = syntheticKey('rsa', 'ssh-rsa')

async function createHost(name: string, opts: { adopting?: boolean; port?: number } = {}) {
  return insertRemoteHost({
    name: `${prefix}-${name}`,
    sshHost: 'box.example',
    sshPort: opts.port ?? 22,
    sshUser: 'ficus',
    sshKeyId: `${prefix}-secret-${name}`,
    sshPublicKey: 'ssh-ed25519 AAAA test',
    hostKeyAdoptionPending: opts.adopting ?? false,
  })
}

afterEach(async () => {
  for (const h of await listRemoteHosts()) if (h.name.startsWith(prefix)) await deleteRemoteHost(h.id)
})

const key = (status: string, keyType = 'ssh-ed25519') => ({ status, keyType }) as RemoteHostKey

describe('hostKeyState', () => {
  it('derives each state', () => {
    expect(hostKeyState({ hostKeyAdoptionPending: true }, [])).toBe('adopting')
    expect(hostKeyState({ hostKeyAdoptionPending: false }, [])).toBe('unverified')
    expect(hostKeyState({ hostKeyAdoptionPending: false }, [key('rejected')])).toBe('unverified')
    expect(hostKeyState({ hostKeyAdoptionPending: false }, [key('pending')])).toBe('pending')
    expect(hostKeyState({ hostKeyAdoptionPending: false }, [key('trusted')])).toBe('trusted')
    // A new key TYPE is not a key change; a different key of a pinned type is.
    expect(hostKeyState({ hostKeyAdoptionPending: false }, [key('trusted'), key('pending', 'ssh-rsa')])).toBe('trusted')
    expect(hostKeyState({ hostKeyAdoptionPending: false }, [key('trusted'), key('pending')])).toBe('changed')
  })
})

describe('parseKeyscanOutput', () => {
  it('parses keys, skips comments, malformed lines and blobs that do not carry their declared type', () => {
    const out = [
      '# box.example:22 SSH-2.0-OpenSSH',
      `box.example ssh-ed25519 ${ED_A}`,
      `box.example ssh-rsa ${RSA}`,
      `box.example ssh-ed25519 ${ED_A}`,
      `box.example ssh-ed25519 ${RSA}`,
      'box.example ssh-ed25519 not-base64!',
      'garbage',
    ].join('\n')
    expect(parseKeyscanOutput(out)).toEqual([
      { keyType: 'ssh-ed25519', publicKey: ED_A },
      { keyType: 'ssh-rsa', publicKey: RSA },
    ])
  })
})

describe('createHostKeyScanner', () => {
  function fakeSpawn(stdout: string, stderr = '', hang = false) {
    const calls: string[][] = []
    const spawn = ((args: string[]) => {
      calls.push(args)
      return {
        stdout: new Response(stdout).body,
        stderr: new Response(stderr).body,
        exited: hang ? new Promise(() => {}) : Promise.resolve(0),
        kill: () => {},
      }
    }) as unknown as typeof Bun.spawn
    return { spawn, calls }
  }

  it('runs ssh-keyscan with an argument array, port and bounded timeout (no login, no shell)', async () => {
    const { spawn, calls } = fakeSpawn(`[box.example]:2222 ssh-ed25519 ${ED_A}\n`)
    const keys = await createHostKeyScanner({ spawn })({ sshHost: 'box.example', sshPort: 2222 })
    expect(keys).toEqual([{ keyType: 'ssh-ed25519', publicKey: ED_A }])
    expect(calls).toEqual([['ssh-keyscan', '-T', '5', '-p', '2222', '-t', 'ed25519,ecdsa,rsa', 'box.example']])
  })

  it('refuses a host name that would be read as an option', async () => {
    const { spawn, calls } = fakeSpawn('')
    await expect(createHostKeyScanner({ spawn })({ sshHost: '-oProxyCommand=x', sshPort: 22 })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('reports no key and a wall-clock timeout as errors', async () => {
    const empty = fakeSpawn('', 'connect to box.example port 22: Connection refused\n')
    await expect(createHostKeyScanner({ spawn: empty.spawn })({ sshHost: 'box.example', sshPort: 22 })).rejects.toThrow(
      'Connection refused'
    )
    const hang = fakeSpawn('', '', true)
    await expect(
      createHostKeyScanner({ spawn: hang.spawn, timeoutMs: 20 })({ sshHost: 'box.example', sshPort: 22 })
    ).rejects.toThrow('timed out')
  })
})

describe('recording and deciding keys', () => {
  it('a scan only ever records pending keys; a rejected key stays rejected', async () => {
    const host = await createHost('record')
    await refreshHostKeys(host, async () => [{ keyType: 'ssh-ed25519', publicKey: ED_A }])
    let [k] = await listHostKeys(host.id)
    expect(k).toMatchObject({ status: 'pending', origin: 'scan', decidedByUserId: null })
    expect(k.fingerprint).toMatch(/^SHA256:/)

    await rejectHostKey(host.id, k.id, 'user-1')
    await recordPresentedKeys(host.id, [{ keyType: 'ssh-ed25519', publicKey: ED_A }])
    ;[k] = await listHostKeys(host.id)
    expect(k).toMatchObject({ status: 'rejected', decidedByUserId: 'user-1' })
  })

  it('trusting a key replaces the pinned key of its type and rejects the other candidates', async () => {
    const host = await createHost('trust')
    await recordPresentedKeys(host.id, [{ keyType: 'ssh-ed25519', publicKey: ED_A }])
    const [a] = await listHostKeys(host.id)
    await trustHostKey(host.id, a.id, 'user-1')
    await recordPresentedKeys(host.id, [
      { keyType: 'ssh-ed25519', publicKey: ED_B },
      { keyType: 'ssh-rsa', publicKey: RSA },
    ])
    const b = (await listHostKeys(host.id)).find((k) => k.publicKey === ED_B)!
    await trustHostKey(host.id, b.id, 'user-2')

    const byKey = new Map((await listHostKeys(host.id)).map((k) => [k.publicKey, k]))
    expect(byKey.get(ED_A)).toMatchObject({ status: 'replaced', decidedByUserId: 'user-2' })
    expect(byKey.get(ED_B)).toMatchObject({ status: 'trusted', decidedByUserId: 'user-2' })
    expect(byKey.get(RSA)).toMatchObject({ status: 'pending' }) // other types are untouched
    await expect(trustHostKey(host.id, b.id, 'user-2')).rejects.toThrow('already trusted')
  })
})

describe('rollout adoption', () => {
  const source = (label: string, content: string | null): AdoptionSource => ({ label, read: async () => content })

  async function adopt(host: Awaited<ReturnType<typeof createHost>>, sources: AdoptionSource[], scanned = ED_A) {
    let scans = 0
    const outcome = await adoptHostKeys(host, {
      listSources: async () => sources,
      scanner: async () => {
        scans++
        return [{ keyType: 'ssh-ed25519', publicKey: scanned }]
      },
    })
    const [row] = await db.select().from(remoteHosts).where(eq(remoteHosts.id, host.id))
    return { outcome, scans, keys: await listHostKeys(host.id), row }
  }

  it('an existing host with a learned key is adopted as trusted, with no prompt, recorded as adopted', async () => {
    const host = await createHost('adopt', { adopting: true })
    const { outcome, scans, keys, row } = await adopt(host, [
      source('box agent_1', `box.example ssh-ed25519 ${ED_A}\nother.example ssh-ed25519 ${ED_B}\n`),
      source('squad s1 ssh directory', `box.example ssh-ed25519 ${ED_A}\n`),
      source('box agent_2', null),
    ])
    expect(outcome).toBe('adopted')
    expect(scans).toBe(0)
    expect(row.hostKeyAdoptionPending).toBe(false)
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ publicKey: ED_A, status: 'trusted', origin: 'adopted', decidedByUserId: null })
    expect(keys[0].decisionNote).toBe('adopted from existing trust (box agent_1, squad s1 ssh directory)')
    expect(hostKeyState(row, keys)).toBe('trusted')
  })

  it('matches the bracketed name off port 22 and hashed entries', async () => {
    const host = await createHost('adopt-port', { adopting: true, port: 2222 })
    const salt = Buffer.from('0123456789abcdefghij')
    const hashedName = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update('[box.example]:2222').digest('base64')}`
    const { outcome, keys } = await adopt(host, [
      source('box agent_1', `box.example ssh-ed25519 ${ED_B}\n${hashedName} ssh-ed25519 ${ED_A}\n`),
    ])
    expect(outcome).toBe('adopted')
    expect(keys.map((k) => k.publicKey)).toEqual([ED_A])
  })

  it('conflicting learned keys are not picked: every candidate waits for a person', async () => {
    const host = await createHost('adopt-conflict', { adopting: true })
    const { outcome, keys, row } = await adopt(host, [
      source('box agent_1', `box.example ssh-ed25519 ${ED_A}\n`),
      source('box agent_2', `box.example ssh-ed25519 ${ED_B}\nbox.example ssh-rsa ${RSA}\n`),
    ])
    expect(outcome).toBe('conflict')
    expect(keys.map((k) => k.status)).toEqual(['pending', 'pending', 'pending'])
    expect(keys.every((k) => k.origin === 'adoption-conflict')).toBe(true)
    expect(keys.find((k) => k.publicKey === ED_B)!.decisionNote).toContain('box agent_2')
    expect(hostKeyState(row, keys)).toBe('pending')
  })

  it('no learned key and every source read: fetched and held for confirmation', async () => {
    const host = await createHost('adopt-none', { adopting: true })
    const { outcome, scans, keys, row } = await adopt(host, [source('box agent_1', '')])
    expect(outcome).toBe('needs-confirmation')
    expect(scans).toBe(1)
    expect(keys).toHaveLength(1)
    expect(keys[0].status).toBe('pending')
    expect(hostKeyState(row, keys)).toBe('pending')
  })

  it('no learned key but an unreadable box: stays adopting (keeps working strictly) for a later retry', async () => {
    const host = await createHost('adopt-deferred', { adopting: true })
    const { outcome, scans, keys, row } = await adopt(host, [source('box agent_1', null), source('squad', '')])
    expect(outcome).toBe('deferred')
    expect(scans).toBe(0)
    expect(keys).toEqual([])
    expect(hostKeyState(row, keys)).toBe('adopting')
  })

  it('adoptPendingHostKeys re-materializes the granted squads of hosts it resolved', async () => {
    const host = await createHost('adopt-all', { adopting: true })
    await insertGrant({ hostId: host.id, squadId: `${prefix}-squad` })
    const materialized: string[] = []
    const counts = await adoptPendingHostKeys({
      listSources: async () => [source('box agent_1', `box.example ssh-ed25519 ${ED_A}\n`)],
      scanner: async () => {
        throw new Error('must not scan')
      },
      materialize: async (squadId) => void materialized.push(squadId),
    })
    expect(counts.adopted).toBeGreaterThanOrEqual(1)
    expect(materialized).toContain(`${prefix}-squad`)
  })
})
