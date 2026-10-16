import * as fs from 'fs'
import { join } from 'path'
import { eq, inArray } from 'drizzle-orm'
import { findKnownHostKeys, hostKeyFingerprint, knownHostsName } from '@ficus/shared/known-hosts'
import { agents, db, remoteHostKeys, remoteHosts } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { getHomeDir } from '../../lib/utils/home'
import { getSquadIdFromSandbox } from '../sandbox/types'
import { getSquadSshPath } from '../squad/ssh'
import { defaultHostKeyScanner, recordPresentedKeys, refreshHostKeys, type HostKeyScanner } from './host-keys'
import { listSquadIdsGrantedHost, type RemoteHost } from './queries'

/**
 * Rollout adoption: remote hosts registered while ssh used `accept-new` keep
 * working without anyone re-confirming them. Their already-trusted keys are
 * adopted as pinned, recorded as "adopted from existing trust" (no person).
 *
 * Evidence is read at runtime through Core's normal access only:
 * - Core's own connectivity-check known_hosts (`<HOME_DIR>/machines/known_hosts`),
 * - each granted squad's Core ssh dir `known_hosts` (docker mounts it as the
 *   box's `~/.ssh`, and the host runtime points ssh at it, so keys those boxes
 *   learned are there),
 * - the `~/.ssh/known_hosts` of each ready vm box of a granted squad, through
 *   the box's sandbox client.
 * Only plain or hashed entries for the host's exact known_hosts name count
 * (`[host]:port` off port 22), never wildcard lines.
 *
 * Outcomes per host:
 * - keys found, at most one per key type: adopted as trusted.
 * - two different keys of the same type anywhere: nothing is picked. Every
 *   candidate becomes a pending key and the host waits for a person.
 * - no key found and every source was read: the host is fetched and its keys
 *   wait for a person, like a new host.
 * - no key found but some box could not be read: left adopting (retried at the
 *   next boot or when a person asks to fetch the key). Connections meanwhile
 *   use strict checking against what each box already trusts.
 */

const log = createLogger('remote-hosts-adoption')

/** A place an existing trusted key may be recorded. `read` returns null when the source could not be read. */
export interface AdoptionSource {
  label: string
  read: () => Promise<string | null>
}

export interface AdoptionDeps {
  listSources?: (squadIds: string[]) => Promise<AdoptionSource[]>
  scanner?: HostKeyScanner
}

export type AdoptionOutcome = 'adopted' | 'conflict' | 'needs-confirmation' | 'deferred'

function readLocalFile(path: string): () => Promise<string | null> {
  return async () => {
    try {
      return fs.readFileSync(path, 'utf-8')
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null
    }
  }
}

/** Ready vm boxes belonging to one of `squadIds` (squad boxes and their agents' boxes). */
async function vmBoxSources(squadIds: string[]): Promise<AdoptionSource[]> {
  const { listAllMachineBoxes } = await import('../machines/queries')
  const boxes = (await listAllMachineBoxes()).filter((b) => b.status === 'ready')
  if (!boxes.length) return []

  const agentIds = boxes.map((b) => b.sandboxId.match(/^agent_(.+)$/)?.[1]).filter((id): id is string => !!id)
  const agentSquads = new Map<string, string | null>()
  if (agentIds.length) {
    const rows = await db
      .select({ id: agents.id, squadId: agents.squadId })
      .from(agents)
      .where(inArray(agents.id, agentIds))
    for (const row of rows) agentSquads.set(row.id, row.squadId)
  }
  const squadOf = (sandboxId: string) =>
    getSquadIdFromSandbox(sandboxId) ?? agentSquads.get(sandboxId.replace(/^agent_/, '')) ?? null

  const { defaultGetClient, defaultBoxHome, readBoxFile } = await import('../sandbox/vm/file-sync')
  return boxes
    .filter((b) => {
      const squadId = squadOf(b.sandboxId)
      return squadId !== null && squadIds.includes(squadId)
    })
    .map((b) => ({
      label: `box ${b.sandboxId}`,
      read: async () => {
        try {
          const client = await defaultGetClient(b.sandboxId)
          if (!client) return null
          const bytes = await readBoxFile(client, `${defaultBoxHome(b.sandboxId)}/.ssh/known_hosts`)
          return bytes ? bytes.toString('utf8') : ''
        } catch (err) {
          log.warn(`could not read known_hosts on box ${b.sandboxId}: ${(err as Error).message}`)
          return null
        }
      },
    }))
}

async function defaultListSources(squadIds: string[]): Promise<AdoptionSource[]> {
  return [
    { label: 'Core connectivity checks', read: readLocalFile(join(getHomeDir(), 'machines', 'known_hosts')) },
    ...squadIds.map((squadId) => ({
      label: `squad ${squadId} ssh directory`,
      read: readLocalFile(join(getSquadSshPath(squadId), 'known_hosts')),
    })),
    ...(await vmBoxSources(squadIds)),
  ]
}

/** Adopt one host's existing trust (see module doc). Does not re-materialize squads. */
export async function adoptHostKeys(host: RemoteHost, deps: AdoptionDeps = {}): Promise<AdoptionOutcome> {
  const squadIds = await listSquadIdsGrantedHost(host.id)
  const sources = await (deps.listSources ?? defaultListSources)(squadIds)
  const name = knownHostsName(host.sshHost, host.sshPort)

  const found = new Map<string, { keyType: string; publicKey: string; sources: Set<string> }>()
  let unreadable = 0
  for (const source of sources) {
    const content = await source.read()
    if (content === null) {
      unreadable++
      continue
    }
    for (const k of findKnownHostKeys(content, name)) {
      const id = `${k.keyType} ${k.key}`
      const entry = found.get(id) ?? { keyType: k.keyType, publicKey: k.key, sources: new Set<string>() }
      entry.sources.add(source.label)
      found.set(id, entry)
    }
  }

  const candidates = [...found.values()]
  if (!candidates.length) {
    if (unreadable) {
      log.info(`remote host ${host.name}: no existing trusted key found yet (${unreadable} source(s) unreadable)`)
      return 'deferred'
    }
    await db.update(remoteHosts).set({ hostKeyAdoptionPending: false }).where(eq(remoteHosts.id, host.id))
    await refreshHostKeys({ ...host, hostKeyAdoptionPending: false }, deps.scanner ?? defaultHostKeyScanner)
    return 'needs-confirmation'
  }

  const types = new Map<string, number>()
  for (const c of candidates) types.set(c.keyType, (types.get(c.keyType) ?? 0) + 1)
  const conflicting = [...types.values()].some((n) => n > 1)
  const note = (c: (typeof candidates)[number]) => [...c.sources].sort().join(', ')

  if (conflicting) {
    for (const c of candidates) {
      await recordPresentedKeys(
        host.id,
        [{ keyType: c.keyType, publicKey: c.publicKey }],
        'adoption-conflict',
        `conflicting existing trust; seen in: ${note(c)}`
      )
    }
    await db.update(remoteHosts).set({ hostKeyAdoptionPending: false }).where(eq(remoteHosts.id, host.id))
    log.warn(`remote host ${host.name}: conflicting existing host keys; a person must choose`)
    return 'conflict'
  }

  const now = new Date()
  await db.transaction(async (tx) => {
    for (const c of candidates) {
      const decision = {
        status: 'trusted',
        origin: 'adopted',
        decisionNote: `adopted from existing trust (${note(c)})`,
        decidedByUserId: null,
        decidedAt: now,
        lastSeenAt: now,
      }
      await tx
        .insert(remoteHostKeys)
        .values({
          hostId: host.id,
          keyType: c.keyType,
          publicKey: c.publicKey,
          fingerprint: hostKeyFingerprint(c.publicKey),
          firstSeenAt: now,
          ...decision,
        })
        // A key a scan already recorded as pending is the same evidence; never
        // overrides a person's rejection.
        .onConflictDoUpdate({
          target: [remoteHostKeys.hostId, remoteHostKeys.keyType, remoteHostKeys.publicKey],
          set: decision,
          setWhere: eq(remoteHostKeys.status, 'pending'),
        })
    }
    await tx.update(remoteHosts).set({ hostKeyAdoptionPending: false }).where(eq(remoteHosts.id, host.id))
  })
  log.info(`remote host ${host.name}: adopted ${candidates.length} existing trusted host key(s)`)
  return 'adopted'
}

/**
 * Adopt every host still awaiting adoption, then re-materialize the squads
 * granted each host whose state changed. Failure-isolated per host.
 */
export async function adoptPendingHostKeys(
  deps: AdoptionDeps & { materialize?: (squadId: string) => Promise<void> } = {}
): Promise<Record<AdoptionOutcome, number>> {
  const counts: Record<AdoptionOutcome, number> = { adopted: 0, conflict: 0, 'needs-confirmation': 0, deferred: 0 }
  const hosts = await db.select().from(remoteHosts).where(eq(remoteHosts.hostKeyAdoptionPending, true))
  const materialize = deps.materialize ?? (await import('./materialize')).materializeSquadRemoteHosts
  for (const host of hosts) {
    try {
      const outcome = await adoptHostKeys(host, deps)
      counts[outcome]++
      if (outcome === 'deferred') continue
      for (const squadId of await listSquadIdsGrantedHost(host.id)) {
        await materialize(squadId).catch((err) => log.warn(`re-materialize failed for squad ${squadId}:`, err))
      }
    } catch (err) {
      log.warn(`host key adoption failed for remote host ${host.id} (${host.name}):`, err)
    }
  }
  return counts
}
