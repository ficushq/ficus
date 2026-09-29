import { randomUUID } from 'crypto'
import { zValidator } from '@hono/zod-validator'
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
import type { Identity } from '../services/rbac'
import { getSecretStore } from '../services/secrets'
import { notifyOnboardingChanged } from '../services/onboarding/events'

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
  squadIds: z.array(z.string().min(1)).optional(),
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
 */
function toPublicRemoteHost(host: RemoteHost): Omit<RemoteHost, 'sshKeyId'> {
  const { sshKeyId: _sshKeyId, ...rest } = host
  return rest
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
  try {
    const result = await sshRunner.run(hostAsSshTarget(host), 'echo ficus-remote-check')
    if (result.exitCode === 0) {
      return { reachable: true }
    }
    return { reachable: false, error: result.stderr.trim() || `ssh exited ${result.exitCode}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // `materializePrivateKey`'s missing-secret error (keys.ts) embeds the
    // secret-store handle (`remote-host-ssh:<id>`) for operator-side
    // debugging — never return it to an API caller. Map it to a generic
    // message here instead.
    if (message.startsWith('no private key stored')) {
      return { reachable: false, error: 'no key available for this host' }
    }
    return { reachable: false, error: message }
  }
}

export function createRemoteHostsRouter(
  deps: {
    materialize?: typeof materializeSquadRemoteHostsDefault
    generateKeypair?: typeof generateRemoteHostKeypair
    sshRunner?: SshRunner
    pushSquadSshToBox?: typeof pushSquadSshToBoxDefault
    insert?: typeof insertRemoteHost
  } = {}
) {
  const app = new Hono()
  const materialize = deps.materialize ?? materializeSquadRemoteHostsDefault
  const generateKeypair = deps.generateKeypair ?? generateRemoteHostKeypair
  const sshRunner = deps.sshRunner ?? defaultSshRunner
  const pushSquadSsh = deps.pushSquadSshToBox ?? pushSquadSshToBoxDefault
  const insert = deps.insert ?? insertRemoteHost

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
    const withGrants = await Promise.all(
      hosts.map(async (host) => ({
        ...toPublicRemoteHost(host),
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
    for (const squadId of squadIds) {
      await materialize(squadId)
    }

    notifyOnboardingChanged()
    return c.json({ ...toPublicRemoteHost(host), squadIds }, 201)
  })

  // GET /api/remote-hosts/:id — host detail + its grants.
  app.get('/:id', requirePermission('remote-hosts:read'), async (c) => {
    const host = await getRemoteHost(c.req.param('id'))
    if (!host) return c.json({ error: 'Not found' }, 404)

    const grants = await listGrantsForHost(host.id)
    return c.json({ ...toPublicRemoteHost(host), squadIds: grants.map((g) => g.squadId) })
  })

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

    return c.json({ ...toPublicRemoteHost(host), squadIds: [...existing, squadId] }, 201)
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
    return c.json(hosts.map(toPublicRemoteHost))
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
      await materialize(squadId)

      return c.json({ ...toPublicRemoteHost(host), squadIds: [squadId] }, 201)
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

  return app
}

export default createRemoteHostsRouter()
