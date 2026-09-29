import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { db, remoteHostGrants } from '../../db'
import { eq } from 'drizzle-orm'
import {
  deleteGrant,
  deleteRemoteHost,
  getRemoteHost,
  getRemoteHostByName,
  insertGrant,
  insertRemoteHost,
  listGrantsForHost,
  listHostsGrantedToSquad,
  listRemoteHosts,
  listSquadIdsGrantedHost,
} from './queries'

const prefix = `rhtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function hostValues(name: string) {
  return {
    name: `${prefix}-${name}`,
    sshHost: '10.0.0.1',
    sshUser: 'ficus',
    sshKeyId: 'secret-key-1',
    sshPublicKey: 'ssh-ed25519 AAAA test',
  }
}

async function cleanup() {
  // remote_host_grants cascade off remote_hosts, so deleting hosts is enough,
  // but be explicit in case a test left grants on hosts it did not create here.
  const all = await listRemoteHosts()
  for (const h of all) {
    if (h.name.startsWith(prefix)) await deleteRemoteHost(h.id)
  }
}

beforeEach(cleanup)
afterEach(cleanup)

describe('remote host queries', () => {
  it('round-trips insert / get / getByName / list / delete', async () => {
    const inserted = await insertRemoteHost(hostValues('a'))
    expect(inserted.id).toBeString()
    expect(inserted.name).toBe(`${prefix}-a`)
    // Defaults applied.
    expect(inserted.sshPort).toBe(22)
    expect(inserted.description).toBeNull()
    expect(inserted.createdAt).toBeInstanceOf(Date)
    expect(inserted.updatedAt).toBeInstanceOf(Date)

    const byId = await getRemoteHost(inserted.id)
    expect(byId?.id).toBe(inserted.id)

    const byName = await getRemoteHostByName(`${prefix}-a`)
    expect(byName?.id).toBe(inserted.id)

    const list = await listRemoteHosts()
    expect(list.some((h) => h.id === inserted.id)).toBe(true)

    await deleteRemoteHost(inserted.id)
    expect(await getRemoteHost(inserted.id)).toBeNull()
  })

  it('getRemoteHost / getRemoteHostByName return null when absent', async () => {
    expect(await getRemoteHost('00000000-0000-0000-0000-000000000000')).toBeNull()
    expect(await getRemoteHostByName(`${prefix}-nope`)).toBeNull()
  })

  it('surfaces a unique name violation', async () => {
    await insertRemoteHost(hostValues('dup'))
    await expect(insertRemoteHost(hostValues('dup'))).rejects.toThrow()
  })
})

describe('remote host grants', () => {
  it('inserts, lists, and deletes grants', async () => {
    const host = await insertRemoteHost(hostValues('grants'))
    const squadA = `${prefix}-squad-a`
    const squadB = `${prefix}-squad-b`

    await insertGrant({ hostId: host.id, squadId: squadA })
    await insertGrant({ hostId: host.id, squadId: squadB })

    const grants = await listGrantsForHost(host.id)
    expect(grants.length).toBe(2)
    expect(grants.map((g) => g.squadId).sort()).toEqual([squadA, squadB].sort())

    const squadIds = await listSquadIdsGrantedHost(host.id)
    expect(squadIds.sort()).toEqual([squadA, squadB].sort())

    await deleteGrant(host.id, squadA)
    expect(await listSquadIdsGrantedHost(host.id)).toEqual([squadB])
  })

  it('surfaces a unique (host_id, squad_id) violation', async () => {
    const host = await insertRemoteHost(hostValues('dup-grant'))
    const squadId = `${prefix}-squad-dup`

    await insertGrant({ hostId: host.id, squadId })
    await expect(insertGrant({ hostId: host.id, squadId })).rejects.toThrow()
  })

  it('listHostsGrantedToSquad returns only hosts granted to that squad', async () => {
    const granted = await insertRemoteHost(hostValues('granted'))
    const ungranted = await insertRemoteHost(hostValues('ungranted'))
    const squadId = `${prefix}-squad-scope`

    await insertGrant({ hostId: granted.id, squadId })

    const hosts = await listHostsGrantedToSquad(squadId)
    expect(hosts.map((h) => h.id)).toEqual([granted.id])
    expect(hosts.some((h) => h.id === ungranted.id)).toBe(false)
  })

  it('cascades grant deletion when the host is deleted', async () => {
    const host = await insertRemoteHost(hostValues('cascade'))
    const squadId = `${prefix}-squad-cascade`
    await insertGrant({ hostId: host.id, squadId })

    await deleteRemoteHost(host.id)

    const rows = await db.select().from(remoteHostGrants).where(eq(remoteHostGrants.hostId, host.id))
    expect(rows.length).toBe(0)
  })
})
