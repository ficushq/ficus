import { publicErrorMessage } from '../db/errors'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Context } from 'hono'
import { zValidator } from '../lib/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { agentWorkspaceSandboxId } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { createLogger } from '../lib/infra/logger'
import { requirePermission, requireSquadPermission } from '../middleware'
import { generateRemoteHostKeypair } from '../services/machines/keys'
import type { Machine } from '../services/machines/queries'
import { defaultSshRunner, type SshRunner } from '../services/machines/ssh'
import { materializeSquadRemoteHosts as materializeSquadRemoteHostsDefault } from '../services/remote-hosts/materialize'
import { pushSquadSshToBox as pushSquadSshToBoxDefault } from '../services/sandbox/vm/file-sync'
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
  updateRemoteHostPublicKey,
  type RemoteHost,
} from '../services/remote-hosts/queries'
import { hasPermission, type Identity } from '../services/rbac'
import { getSecretStore } from '../services/secrets'
import { notifyOnboardingChanged } from '../services/onboarding/events'
import { userSessionRequired } from '../services/auth/user-session-required'
import {
  defaultHostKeyScanner,
  hostKeyAlias,
  hostKeyState,
  HostKeyDecisionError,
  listHostKeys,
  listHostKeysForHosts,
  refreshHostKeys,
  rejectHostKey,
  toPublicHostKeys,
  trustedHostKeys,
  trustHostKey,
  type HostKeyScanner,
  type RemoteHostKey,
} from '../services/remote-hosts/host-keys'
import { adoptHostKeys } from '../services/remote-hosts/host-key-adoption'
import {
  ConflictResolutionError,
  keepBoxKey,
  listSquadKnownHostsConflicts,
  toPublicKnownHostsConflict,
  useCoreKey as useCoreKeyDefault,
} from '../services/remote-hosts/known-hosts-conflicts'

/**
 * Remote hosts API: a global registry of team-owned SSH targets (§ API in
 * docs/history/superpowers/specs/2026-07-14-remote-hosts-design.md) plus per-squad
 * grants. Two surfaces mounted on one router (distinct path shapes, no
 * collisions): the global registry (`requirePermission`, admin-managed) and
 * the squad surface (`requireSquadPermission`, squad-manager add-and-grant +
 * revoke-own-grant).
 */

const log = createLogger('routes/remote-hosts')

// Mirrors `remote_hosts.name`'s intended constraint (also re-checked, independently,
// by `remote-hosts/materialize.ts` as a directive-injection guard immediately before
// a name is interpolated into ssh_config — defense in depth, not a shared import).
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
// "No whitespace/newlines" per the design's § Security validation rules.
const NO_WHITESPACE_RE = /^\S+$/

const createHostSchema = z.object({
  name: z.string().regex(NAME_RE, 'name must match ^[a-z0-9][a-z0-9-]{0,62}$'),
  sshHost: z.string().min(1).regex(NO_WHITESPACE_RE, 'sshHost must not contain whitespace/newlines'),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().min(1).regex(NO_WHITESPACE_RE, 'sshUser must not contain whitespace/newlines'),
  description: z.string().optional(),
  squadIds: z.array(z.string().min(1)).max(100).optional(),
})

// Squad-surface add-and-grant: same host fields, minus `squadIds` (the target
// squad comes from the path param, not the body).
const squadCreateHostSchema = createHostSchema.omit({ squadIds: true })

const addGrantSchema = z.object({
  squadId: z.string().min(1),
})

/**
 * Strip the secret-store handle before returning a host over the API. Private
 * key material is never returnable by design (keys.ts only yields a
 * secret-store id) — but we also omit that id itself, an internal plumbing
 * detail rather than something a caller needs (mirrors `toPublicMachine`).
 * The host's SSH host-key state and key fingerprints are included so every
 * reader (agents included) can see why a host is blocked.
 */
function toPublicRemoteHost(host: RemoteHost, keys: RemoteHostKey[]) {
  const { sshKeyId: _sshKeyId, ...rest } = host
  return { ...rest, hostKeyState: hostKeyState(host, keys), hostKeys: toPublicHostKeys(keys) }
}

async function toPublicRemoteHosts(hosts: RemoteHost[]) {
  const keys = await listHostKeysForHosts(hosts.map((h) => h.id))
  return hosts.map((host) => toPublicRemoteHost(host, keys.get(host.id) ?? []))
}

/**
 * Trusting or rejecting a host key, and resolving a known_hosts conflict, are
 * decisions only a signed-in PERSON may make — never an agent, a system token
 * or the ownerless bootstrap session, whatever permissions they hold. Returns
 * the person's user id, or the 403 response to send.
 */
async function requirePerson(c: Context, action: string): Promise<{ userId: string } | { response: Response }> {
  const identity = c.get('identity') as Identity | undefined
  if (identity?.type === 'user') return { userId: identity.userId }
  return { response: await userSessionRequired(c, identity, action) }
}

/**
 * `createSshRunner`'s `run()` / `materializePrivateKey` only ever touch
 * `id`/`sshHost`/`sshPort`/`sshUser`/`sshKeyId` on the `Machine` they're
 * given (see `services/machines/ssh.ts`). Adapt a `RemoteHost` row into a
 * `Machine`-shaped object carrying those five fields plus inert defaults for
 * the rest, so the `/check` probe can reuse the machines SSH runner without a
 * `getMachineProvider`-style abstraction (mirrors `ssh.test.ts`'s `makeMachine`
 * test helper).
 */
function hostAsSshTarget(host: RemoteHost): Machine {
  return {
    id: host.id,
    name: host.name,
    provider: 'ssh',
    providerRef: null,
    sshHost: host.sshHost,
    sshPort: host.sshPort,
    sshUser: host.sshUser,
    sshKeyId: host.sshKeyId,
    sshPublicKey: host.sshPublicKey,
    status: 'registered',
    capabilities: {},
    scope: 'shared',
    bootstrapVersion: null,
    lastSeenAt: null,
    createdAt: host.createdAt,
  } as Machine
}

/** Resolve and validate a squad ID from a route param (mirrors `squad-ssh.ts`). */
async function getValidSquadId(squadIdParam: string): Promise<string | null> {
  const squad = await Squad.find(squadIdParam)
  return squad ? squad.id : null
}

/**
 * Shared connectivity-probe logic for both the global `/:id/check` and squad
 * `/squad/:squadId/check/:hostId` routes: `ssh echo` with the host's minted
 * key. Never throws to the caller: a failed probe is a `{reachable: false}`
 * result, matching the machines `/check` idiom.
 */
async function probeHost(sshRunner: SshRunner, host: RemoteHost): Promise<{ reachable: boolean; error?: string }> {
  // The probe connects with the host's pinned keys only (strict, nothing
  // learned): an unconfirmed host is never probed with trust-on-first-use.
  const trusted = trustedHostKeys(await listHostKeys(host.id))
  if (!trusted.length) {
    return { reachable: false, error: 'The host key has not been confirmed yet; a person must trust it first.' }
  }
  const dir = mkdtempSync(join(tmpdir(), 'ficus-remote-check-'))
  try {
    const alias = hostKeyAlias(host.name)
    const knownHostsPath = join(dir, 'known_hosts')
    writeFileSync(knownHostsPath, trusted.map((k) => `${alias} ${k.keyType} ${k.publicKey}\n`).join(''), {
      mode: 0o600,
    })
    const result = await sshRunner.run(hostAsSshTarget(host), 'echo ficus-remote-check', {
      hostKeyPin: { knownHostsPath, alias },
    })
    if (result.exitCode === 0) {
      return { reachable: true }
    }
    return { reachable: false, error: result.stderr.trim() || `ssh exited ${result.exitCode}` }
  } catch (err) {
    const message = publicErrorMessage(err)
    // `materializePrivateKey`'s missing-secret error (keys.ts) embeds the
    // secret-store handle (`remote-host-ssh:<id>`) for operator-side
    // debugging — never return it to an API caller. Map it to a generic
    // message here instead.
    if (message.startsWith('no private key stored')) {
      return { reachable: false, error: 'no key available for this host' }
    }
    return { reachable: false, error: message }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function createRemoteHostsRouter(
  deps: {
    materialize?: typeof materializeSquadRemoteHostsDefault
    generateKeypair?: typeof generateRemoteHostKeypair
    sshRunner?: SshRunner
    pushSquadSshToBox?: typeof pushSquadSshToBoxDefault
    insert?: typeof insertRemoteHost
    hostKeyScanner?: HostKeyScanner
    useCoreKey?: typeof useCoreKeyDefault
  } = {}
) {
  const app = new Hono()
  const materialize = deps.materialize ?? materializeSquadRemoteHostsDefault
  const generateKeypair = deps.generateKeypair ?? generateRemoteHostKeypair
  const sshRunner = deps.sshRunner ?? defaultSshRunner
  const pushSquadSsh = deps.pushSquadSshToBox ?? pushSquadSshToBoxDefault
  const insert = deps.insert ?? insertRemoteHost
  const hostKeyScanner = deps.hostKeyScanner ?? defaultHostKeyScanner
  const useCoreKey = deps.useCoreKey ?? useCoreKeyDefault

  /** Re-materialize every squad granted `hostId` (its stanza and pinned keys may have changed). */
  async function materializeGrantedSquads(hostId: string): Promise<void> {
    for (const squadId of await listSquadIdsGrantedHost(hostId)) {
      try {
        await materialize(squadId)
      } catch (err) {
        log.error(`re-materialize failed for squad ${squadId} after a host-key change on ${hostId}`, err)
      }
    }
  }

  /** The host as returned after a host-key action, plus its grants. */
  async function hostView(hostId: string) {
    const host = await getRemoteHost(hostId)
    if (!host) return null
    return {
      ...toPublicRemoteHost(host, await listHostKeys(host.id)),
      squadIds: await listSquadIdsGrantedHost(host.id),
    }
  }

  /**
   * Fetch a host's keys now. A host still adopting existing trust tries that
   * first (it may find the keys already trusted); otherwise the keys the host
   * presents are recorded as pending. Never trusts a key. Callers re-materialize.
   */
  async function fetchHostKeys(host: RemoteHost): Promise<{ fetchError?: string }> {
    if (host.hostKeyAdoptionPending) {
      const outcome = await adoptHostKeys(host, { scanner: hostKeyScanner })
      if (outcome !== 'deferred') return {}
    }
    const result = await refreshHostKeys(host, hostKeyScanner)
    return result.ok ? {} : { fetchError: result.error }
  }

  /** Apply a person's trust/reject decision and re-materialize the host's squads. */
  async function decideHostKey(c: Context, hostId: string, keyId: string, decision: 'trust' | 'reject') {
    const person = await requirePerson(c, 'confirm SSH host keys')
    if ('response' in person) return person.response
    try {
      if (decision === 'trust') await trustHostKey(hostId, keyId, person.userId)
      else await rejectHostKey(hostId, keyId, person.userId)
    } catch (err) {
      if (err instanceof HostKeyDecisionError) return c.json({ error: err.message }, err.status)
      throw err
    }
    log.info(`host key ${keyId} on remote host ${hostId}: ${decision} by user ${person.userId}`)
    await materializeGrantedSquads(hostId)
    return c.json(await hostView(hostId))
  }

  /**
   * Revoke `squadId`'s grant on `host`, then ROTATE the host's minted keypair
   * (spec §7). Removing a squad's ssh config is not enough: the revoked squad
   * may have copied the private key, which stays valid against the remote host
   * until the key material itself changes.
   *
   * Ordering is load-bearing — the grant row is deleted (and the revoked squad
   * re-materialized to drop its stanza + stale key file, reusing the existing
   * revoke mechanism) BEFORE rotation is attempted. A rotation failure must
   * therefore never leave the squad still granted: the revoke stands and the
   * response carries a warning that the previous key remains valid (the
   * operator can simply retry the revoke to rotate again).
   *
   * `rotated` reflects ONLY the mint + `updateRemoteHostPublicKey` — the two
   * steps that decide whether the new key material actually replaced the old.
   * Once the pubkey is persisted, rotation is a fact (`rotated:true`), and the
   * response carries the new pubkey + install guidance. Delivering that key to
   * the remaining granted squads runs AFTER, best-effort per squad: a
   * materialize failure there must NOT flip `rotated` back to false, which would
   * tell the operator the previous key still works while the secret store + row
   * already hold the new one — silently locking those squads out. Any squad
   * whose re-materialize fails self-heals on its box's next vm file-sync (which
   * re-materializes and hashes the output, so delivery converges regardless);
   * the failed squad ids are surfaced in the message for visibility.
   *
   * Re-minting under the same `hostId` overwrites the existing
   * `remote-host-ssh:<hostId>` secret in place — `sshKeyId` is unchanged; only
   * the key material rotates. The remote host is NEVER touched (Ficus may have no
   * access) — the new public key is returned so the operator can install it in
   * the host's ~/.ssh/authorized_keys.
   */
  async function revokeAndRotate(host: RemoteHost, squadId: string) {
    await deleteGrant(host.id, squadId)
    await materialize(squadId)

    let publicKey: string
    try {
      const minted = await generateKeypair(host.id)
      publicKey = minted.publicKey
      await updateRemoteHostPublicKey(host.id, publicKey)
    } catch (err) {
      log.error(`host-key rotation failed after revoking squad ${squadId} on host ${host.id} (${host.name})`, err)
      return {
        revoked: true,
        rotated: false,
        warning:
          'Grant revoked, but rotating the host key failed — the previous key remains valid until you retry. Re-run the revoke to rotate the key again.',
      }
    }

    // The new key material is now persisted (secret store + host row): rotation
    // is done. Re-materializing each remaining granted squad delivers the new
    // key, but is best-effort — a failure here does not un-rotate the key, and
    // the box self-heals on its next file-sync — so it must never flip
    // `rotated` to false.
    const remaining = await listSquadIdsGrantedHost(host.id)
    const failedSquadIds: string[] = []
    for (const remainingSquadId of remaining) {
      try {
        await materialize(remainingSquadId)
      } catch (err) {
        failedSquadIds.push(remainingSquadId)
        log.error(
          `re-materialize failed for squad ${remainingSquadId} after rotating host ${host.id} (${host.name}) — box self-heals on next file-sync`,
          err
        )
      }
    }

    const message =
      `Host key rotated. Append this public key to ~/.ssh/authorized_keys on ${host.sshHost} for user ${host.sshUser} — ` +
      `the remaining granted squads can only reconnect once you do, and any private key the revoked squad copied stops working after you remove the old one.` +
      (failedSquadIds.length > 0
        ? ` (Re-delivering the new key to squad(s) ${failedSquadIds.join(', ')} did not complete now; their boxes self-heal on the next file-sync.)`
        : '')

    return {
      revoked: true,
      rotated: true,
      sshPublicKey: publicKey,
      message,
    }
  }

  // ── Global registry surface ─────────────────────────────────────────────

  // GET /api/remote-hosts — list all hosts + their grants.
  app.get('/', requirePermission('remote-hosts:read'), async (c) => {
    const hosts = await listRemoteHosts()
    const publicHosts = await toPublicRemoteHosts(hosts)
    const withGrants = await Promise.all(
      publicHosts.map(async (host) => ({
        ...host,
        squadIds: await listSquadIdsGrantedHost(host.id),
      }))
    )
    return c.json(withGrants)
  })

  // POST /api/remote-hosts — register a remote host (+ optional initial grants).
  app.post('/', requirePermission('remote-hosts:write'), zValidator('json', createHostSchema), async (c) => {
    const body = c.req.valid('json')

    if (await getRemoteHostByName(body.name)) {
      return c.json({ error: `Remote host '${body.name}' already exists` }, 409)
    }

    // Validate every requested squad BEFORE minting a keypair or inserting the
    // row, so an unknown squad never leaves a partially-created host behind.
    const squadIds = body.squadIds ?? []
    for (const squadId of squadIds) {
      if (!(await getValidSquadId(squadId))) {
        return c.json({ error: `Squad '${squadId}' not found` }, 404)
      }
    }

    const hostId = randomUUID()
    const { publicKey, secretKeyId } = await generateKeypair(hostId)

    let host: RemoteHost
    try {
      host = await insert({
        id: hostId,
        name: body.name,
        sshHost: body.sshHost,
        sshUser: body.sshUser,
        sshKeyId: secretKeyId,
        sshPublicKey: publicKey,
        ...(body.sshPort !== undefined ? { sshPort: body.sshPort } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      })
    } catch (err) {
      // Best-effort rollback before rethrowing (mirrors routes/machines.ts's
      // M1 compensation): the keypair is minted and persisted to the secret
      // store BEFORE the row insert, so a failed insert (e.g. a dup-name race
      // between the pre-check and the insert) must not orphan it.
      await getSecretStore()
        .delete(secretKeyId)
        .catch(() => {})
      throw err
    }

    for (const squadId of squadIds) {
      await insertGrant({ hostId: host.id, squadId })
    }
    // Fetch the host key now so a person can confirm it right away. Until they
    // do, every granted squad gets a stanza that refuses connections.
    const { fetchError } = await fetchHostKeys(host)
    for (const squadId of squadIds) {
      await materialize(squadId)
    }

    notifyOnboardingChanged()
    return c.json({ ...(await hostView(host.id)), ...(fetchError ? { fetchError } : {}) }, 201)
  })

  // GET /api/remote-hosts/:id — host detail + its grants.
  app.get('/:id', requirePermission('remote-hosts:read'), async (c) => {
    const host = await getRemoteHost(c.req.param('id'))
    if (!host) return c.json({ error: 'Not found' }, 404)

    const grants = await listGrantsForHost(host.id)
    return c.json({ ...toPublicRemoteHost(host, await listHostKeys(host.id)), squadIds: grants.map((g) => g.squadId) })
  })

  // POST /api/remote-hosts/:id/host-keys/scan — fetch the host's SSH host keys
  // (ssh-keyscan, no login) and record new ones as pending. Never trusts a key.
  app.post('/:id/host-keys/scan', requirePermission('remote-hosts:write'), async (c) => {
    const host = await getRemoteHost(c.req.param('id'))
    if (!host) return c.json({ error: 'Not found' }, 404)
    const { fetchError } = await fetchHostKeys(host)
    await materializeGrantedSquads(host.id)
    return c.json({ ...(await hostView(host.id)), ...(fetchError ? { fetchError } : {}) })
  })

  // POST /api/remote-hosts/:id/host-keys/:keyId/trust|reject — a PERSON's
  // decision on a fetched key (agents and tokens are refused, whatever their
  // permissions). Trusting pins the key for every granted squad.
  app.post('/:id/host-keys/:keyId/trust', requirePermission('remote-hosts:write'), (c) =>
    decideHostKey(c, c.req.param('id'), c.req.param('keyId'), 'trust')
  )
  app.post('/:id/host-keys/:keyId/reject', requirePermission('remote-hosts:write'), (c) =>
    decideHostKey(c, c.req.param('id'), c.req.param('keyId'), 'reject')
  )

  // DELETE /api/remote-hosts/:id — delete the host + its secret; re-materialize
  // every squad that had it granted (their key file + config stanza must go away).
  app.delete('/:id', requirePermission('remote-hosts:write'), async (c) => {
    const host = await getRemoteHost(c.req.param('id'))
    if (!host) return c.json({ error: 'Not found' }, 404)

    const affectedSquadIds = await listSquadIdsGrantedHost(host.id)

    await getSecretStore().delete(host.sshKeyId)
    await deleteRemoteHost(host.id) // cascades remote_host_grants

    for (const squadId of affectedSquadIds) {
      await materialize(squadId)
    }

    notifyOnboardingChanged()
    return c.body(null, 204)
  })

  // POST /api/remote-hosts/:id/grants — grant a squad access to a host.
  app.post('/:id/grants', requirePermission('remote-hosts:write'), zValidator('json', addGrantSchema), async (c) => {
    const host = await getRemoteHost(c.req.param('id'))
    if (!host) return c.json({ error: 'Not found' }, 404)

    const { squadId } = c.req.valid('json')
    if (!(await getValidSquadId(squadId))) {
      return c.json({ error: `Squad '${squadId}' not found` }, 404)
    }

    // Duplicate grant → 409 (mirrors the duplicate-name idiom above; a
    // pre-check keeps this readable instead of sniffing a DB unique-violation).
    const existing = await listSquadIdsGrantedHost(host.id)
    if (existing.includes(squadId)) {
      return c.json({ error: `Squad '${squadId}' already has access to '${host.name}'` }, 409)
    }

    await insertGrant({ hostId: host.id, squadId })
    await materialize(squadId)

    return c.json({ ...toPublicRemoteHost(host, await listHostKeys(host.id)), squadIds: [...existing, squadId] }, 201)
  })

  // DELETE /api/remote-hosts/:id/grants/:squadId — revoke a squad's grant and
  // ROTATE the host key (spec §7). Idempotent: revoking an already-absent grant
  // still succeeds (never 404s on the grant itself — only a missing HOST is a
  // 404) and still rotates. Returns 200 with the new public key + operator
  // guidance (or a warning if rotation failed), not a bare 204.
  app.delete('/:id/grants/:squadId', requirePermission('remote-hosts:write'), async (c) => {
    const host = await getRemoteHost(c.req.param('id'))
    if (!host) return c.json({ error: 'Not found' }, 404)

    return c.json(await revokeAndRotate(host, c.req.param('squadId')))
  })

  // POST /api/remote-hosts/:id/check — connectivity probe (ssh echo) with the
  // host's minted key. Never throws to the client: a failed probe is a 200
  // with `reachable: false`, matching the machines `/check` idiom.
  app.post('/:id/check', requirePermission('remote-hosts:write'), async (c) => {
    const host = await getRemoteHost(c.req.param('id'))
    if (!host) return c.json({ error: 'Not found' }, 404)

    return c.json(await probeHost(sshRunner, host))
  })

  // ── Squad surface ────────────────────────────────────────────────────────

  // GET /api/remote-hosts/squad/:squadId — hosts granted to this squad.
  app.get('/squad/:squadId', requireSquadPermission('remote-hosts:read', 'squadId'), async (c) => {
    const squadId = await getValidSquadId(c.req.param('squadId'))
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)

    const hosts = await listHostsGrantedToSquad(squadId)
    return c.json(await toPublicRemoteHosts(hosts))
  })

  // POST /api/remote-hosts/squad/:squadId — add-and-grant: create a host and
  // grant it to this squad in one step.
  app.post(
    '/squad/:squadId',
    requireSquadPermission('remote-hosts:write', 'squadId'),
    zValidator('json', squadCreateHostSchema),
    async (c) => {
      const squadId = await getValidSquadId(c.req.param('squadId'))
      if (!squadId) return c.json({ error: 'Squad not found' }, 404)

      const body = c.req.valid('json')
      if (await getRemoteHostByName(body.name)) {
        return c.json({ error: `Remote host '${body.name}' already exists` }, 409)
      }

      const hostId = randomUUID()
      const { publicKey, secretKeyId } = await generateKeypair(hostId)

      let host: RemoteHost
      try {
        host = await insert({
          id: hostId,
          name: body.name,
          sshHost: body.sshHost,
          sshUser: body.sshUser,
          sshKeyId: secretKeyId,
          sshPublicKey: publicKey,
          ...(body.sshPort !== undefined ? { sshPort: body.sshPort } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
        })
      } catch (err) {
        // Same best-effort rollback as the global create path above.
        await getSecretStore()
          .delete(secretKeyId)
          .catch(() => {})
        throw err
      }

      await insertGrant({ hostId: host.id, squadId })
      const { fetchError } = await fetchHostKeys(host)
      await materialize(squadId)

      return c.json({ ...(await hostView(host.id)), ...(fetchError ? { fetchError } : {}) }, 201)
    }
  )

  // DELETE /api/remote-hosts/squad/:squadId/:hostId — revoke THIS squad's grant
  // and ROTATE the host key (spec §7). Never deletes the host row itself, even
  // if this was the last grant. Returns 200 with the rotated public key +
  // operator guidance (mirrors the global revoke surface).
  app.delete('/squad/:squadId/:hostId', requireSquadPermission('remote-hosts:write', 'squadId'), async (c) => {
    const squadId = await getValidSquadId(c.req.param('squadId'))
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)

    const host = await getRemoteHost(c.req.param('hostId'))
    if (!host) {
      // Host already gone: the revoke is an idempotent no-op grant delete with
      // no key material left to rotate. Carry a `message` (not a `warning`) so
      // this is distinguishable from a genuine rotation failure — nothing needs
      // installing on any host.
      await deleteGrant(c.req.param('hostId'), squadId)
      await materialize(squadId)
      return c.json({ revoked: true, rotated: false, message: 'Host already deleted; nothing to rotate.' })
    }

    return c.json(await revokeAndRotate(host, squadId))
  })

  // POST /api/remote-hosts/squad/:squadId/check/:hostId — connectivity probe
  // for a host GRANTED to this squad, so a squad manager (squad-scoped write
  // only) can verify their own add→install-pubkey flow without global write.
  // 404s both when the host doesn't exist AND when it exists but isn't
  // granted to this squad — the two cases are indistinguishable in the
  // response so an ungranted host's existence is never leaked.
  app.post('/squad/:squadId/check/:hostId', requireSquadPermission('remote-hosts:write', 'squadId'), async (c) => {
    const squadId = await getValidSquadId(c.req.param('squadId'))
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)

    const hostId = c.req.param('hostId')
    const host = await getRemoteHost(hostId)
    const grantedSquadIds = host ? await listSquadIdsGrantedHost(hostId) : []
    if (!host || !grantedSquadIds.includes(squadId)) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json(await probeHost(sshRunner, host))
  })

  // POST /api/remote-hosts/squad/:squadId/sync — re-push ~/.ssh artifacts to
  // the CALLING AGENT's box. Agent identities only (an interactive user has no
  // "own box" to push to); the calling agent must belong to :squadId.
  //
  // Docker/k8s sandboxes need no sync (their materialized changes appear via
  // a live mount) — pushSquadSshToBox reports that as `{pushed:false,
  // reason:'live-mount'}` rather than an error; the CLI's `ficus remote-hosts
  // sync` surfaces the reason as a no-op hint.
  app.post('/squad/:squadId/sync', requireSquadPermission('remote-hosts:read', 'squadId'), async (c) => {
    const squadId = await getValidSquadId(c.req.param('squadId'))
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)

    const identity = c.get('identity') as Identity | undefined
    if (!identity || identity.type !== 'agent') {
      return c.json({ error: 'sync requires an agent identity' }, 400)
    }
    if (identity.squadId !== squadId) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const sandboxId = agentWorkspaceSandboxId(identity.agentId)
    const result = await pushSquadSsh(squadId, sandboxId)
    return c.json(result)
  })

  // ── Squad surface: host keys ─────────────────────────────────────────────

  /** The host, when it exists AND is granted to `squadId` (indistinguishable 404 otherwise). */
  async function grantedHost(squadId: string, hostId: string): Promise<RemoteHost | null> {
    const host = await getRemoteHost(hostId)
    if (!host) return null
    return (await listSquadIdsGrantedHost(hostId)).includes(squadId) ? host : null
  }

  // POST /api/remote-hosts/squad/:squadId/host-keys/:hostId/scan — fetch the
  // keys of a host granted to this squad. Records pending keys only.
  app.post(
    '/squad/:squadId/host-keys/:hostId/scan',
    requireSquadPermission('remote-hosts:write', 'squadId'),
    async (c) => {
      const squadId = await getValidSquadId(c.req.param('squadId'))
      if (!squadId) return c.json({ error: 'Squad not found' }, 404)
      const host = await grantedHost(squadId, c.req.param('hostId'))
      if (!host) return c.json({ error: 'Not found' }, 404)
      const { fetchError } = await fetchHostKeys(host)
      await materializeGrantedSquads(host.id)
      const view = await hostView(host.id)
      return c.json({ ...view, squadIds: undefined, ...(fetchError ? { fetchError } : {}) })
    }
  )

  // POST /api/remote-hosts/squad/:squadId/host-keys/:hostId/:keyId/trust|reject
  // — a PERSON's decision, from the squad's settings. A host key is the same
  // for every squad, so for a host shared with other squads this needs global
  // remote-hosts:write: one squad must not pin a key for another squad's host.
  const squadDecision = (decision: 'trust' | 'reject') => async (c: Context) => {
    const squadId = await getValidSquadId(c.req.param('squadId')!)
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)
    const hostId = c.req.param('hostId')!
    const host = await grantedHost(squadId, hostId)
    if (!host) return c.json({ error: 'Not found' }, 404)
    const granted = await listSquadIdsGrantedHost(hostId)
    const identity = c.get('identity') as Identity
    if (granted.length > 1 && !(await hasPermission(identity, 'remote-hosts:write'))) {
      return c.json(
        { error: 'This host is shared with other squads; an administrator must confirm its host key in Settings.' },
        403
      )
    }
    const response = await decideHostKey(c, hostId, c.req.param('keyId')!, decision)
    if (response.status !== 200) return response
    const view = await hostView(hostId)
    return c.json({ ...view, squadIds: undefined })
  }
  app.post(
    '/squad/:squadId/host-keys/:hostId/:keyId/trust',
    requireSquadPermission('remote-hosts:write', 'squadId'),
    squadDecision('trust')
  )
  app.post(
    '/squad/:squadId/host-keys/:hostId/:keyId/reject',
    requireSquadPermission('remote-hosts:write', 'squadId'),
    squadDecision('reject')
  )

  // ── Squad surface: box known_hosts conflicts ─────────────────────────────

  // GET /api/remote-hosts/squad/:squadId/known-hosts-conflicts — where a box
  // pins a different key than a Core-managed entry (read-only for agents, so
  // one hitting "Host key verification failed" can see a person must decide).
  app.get(
    '/squad/:squadId/known-hosts-conflicts',
    requireSquadPermission('remote-hosts:read', 'squadId'),
    async (c) => {
      const squadId = await getValidSquadId(c.req.param('squadId'))
      if (!squadId) return c.json({ error: 'Squad not found' }, 404)
      return c.json((await listSquadKnownHostsConflicts(squadId)).map(toPublicKnownHostsConflict))
    }
  )

  // POST /api/remote-hosts/squad/:squadId/known-hosts-conflicts/:id/keep-box|use-core
  // — a PERSON's resolution (agents and tokens are refused). Editing a box's
  // known_hosts needs the squad's ssh:write.
  const resolveConflict = (choice: 'keep-box' | 'use-core') => async (c: Context) => {
    const squadId = await getValidSquadId(c.req.param('squadId')!)
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)
    const person = await requirePerson(c, 'resolve known_hosts conflicts')
    if ('response' in person) return person.response
    try {
      const row =
        choice === 'keep-box'
          ? await keepBoxKey(squadId, c.req.param('conflictId')!, person.userId)
          : await useCoreKey(squadId, c.req.param('conflictId')!, person.userId)
      return c.json(toPublicKnownHostsConflict(row))
    } catch (err) {
      if (err instanceof ConflictResolutionError) return c.json({ error: err.message }, err.status)
      throw err
    }
  }
  app.post(
    '/squad/:squadId/known-hosts-conflicts/:conflictId/keep-box',
    requireSquadPermission('ssh:write', 'squadId'),
    resolveConflict('keep-box')
  )
  app.post(
    '/squad/:squadId/known-hosts-conflicts/:conflictId/use-core',
    requireSquadPermission('ssh:write', 'squadId'),
    resolveConflict('use-core')
  )

  return app
}

export default createRemoteHostsRouter()
