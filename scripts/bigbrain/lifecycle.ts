import { lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { managedBigbrainReadHandoffSchema, type ManagedBigbrainHostRequest } from '@ficus/shared/managed-bigbrain'
import { escrowSchema, initializeVaultOwner, prepareReadCredential } from './bootstrap'
import type { InstalledHost } from './control-input'
import { gatewayManifestSchema, type GatewayManifest } from './gateway-policy'
import { verifyGatewayServes } from './gateway-probe'
import { cachedOwnerAppLink, ownerInviteCacheSchema } from './invite-cache'
import { initializeMemberInviteCache } from './member-invite-cache'
import { NativeVaultAdmin } from './native-admin'
import { BIGBRAIN_STATE_ROOT, managedPaths } from './paths'
import {
  assertHostnameFree,
  markReady,
  prepareStorage,
  readVaultRecord,
  reserveStorage,
  saveVaultRecord,
  startVaultService,
} from './provision'
import { admitVaultRequest, controlReceiptSchema, hashVaultRequest, type ControlReceipt } from './receipts'
import { ensureOwnedDirectory, readPrivateJson, writePrivateJson } from './secure-files'
import { runPrivateCommand, vaultCommand } from './process'
import { syncVaultName, writeVaultName, type VaultNameDeps } from './vault-name'

type Admin = Pick<
  NativeVaultAdmin,
  'initializeOwner' | 'listMembers' | 'listCredentials' | 'revokeCredential' | 'ensureReadMember' | 'mintReadCredential'
>
export interface LifecycleDeps extends VaultNameDeps {
  admin?: (record: ControlReceipt) => Admin
  ingress?: () => Promise<unknown>
  /** Owner app-link issuance as the vault UID (default: the release's owner-link bundle). */
  issueAppLink?: (
    record: ControlReceipt,
    window: { issuedAt: string; expiresAt: string }
  ) => Promise<{ secret: string; expiresAt: string }>
  /** Proof the RUNNING gateway serves this vault's published route (default: verifyGatewayServes). */
  gatewayServes?: (manifest: GatewayManifest, vaultId: string) => Promise<void>
  now?: () => number
}
type Request<A extends ManagedBigbrainHostRequest['action']> = Extract<ManagedBigbrainHostRequest, { action: A }>

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw new Error('storage_unavailable')
  }
}
const adminFor = (deps: LifecycleDeps) => (record: ControlReceipt) =>
  (deps.admin ?? ((r) => new NativeVaultAdmin(r, { root: deps.root, run: deps.run })))(record)
const publish = (deps: LifecycleDeps) => (deps.ingress ?? (async () => {}))()

/** Root-written read material for Core (never in a Platform reply). Kept root-private until the
 * hosted Core service identity is decided; Core access to this directory is part of that work. */
async function writeReadHandoff(record: ControlReceipt, host: InstalledHost, deps: LifecycleDeps): Promise<void> {
  const paths = managedPaths({ vaultId: record.receipt.vaultId, root: deps.root })
  const escrow = await readPrivateJson(paths.control, 'reader.json', escrowSchema, { uid: deps.uid })
  if (escrow.phase !== 'complete' || !escrow.token || !escrow.credentialId || record.receipt.upstreamVaultId === null)
    throw new Error('storage_unavailable')
  await ensureOwnedDirectory(join(deps.root ?? BIGBRAIN_STATE_ROOT, 'read-handoff'), 0o700, { uid: deps.uid })
  await writePrivateJson(
    join(deps.root ?? BIGBRAIN_STATE_ROOT, 'read-handoff'),
    `${record.receipt.vaultId}.json`,
    {
      contractVersion: 1,
      tenantId: record.receipt.tenantId,
      physicalHostBinding: record.receipt.physicalHostBinding,
      vaultId: record.receipt.vaultId,
      hostEpoch: host.hostEpoch,
      generation: record.receipt.generation,
      upstreamVaultId: record.receipt.upstreamVaultId,
      upstreamCommit: record.receipt.upstreamCommit,
      artifactDigest: record.receipt.artifactDigest,
      credentialId: escrow.credentialId,
      kind: 'agent',
      scopes: ['read'],
      followsMember: false,
      token: escrow.token,
    },
    managedBigbrainReadHandoffSchema,
    { uid: deps.uid }
  )
}
async function removeReadHandoff(vaultId: string, deps: LifecycleDeps): Promise<void> {
  const path = managedPaths({ vaultId, root: deps.root }).handoff
  if (await present(path)) await unlink(path)
}

/** create: reserve -> storage -> owner bootstrap (root escrow) -> one read-only Ficus credential
 * -> upstream server name -> service + identity -> read handoff -> ready + ingress. Every phase is durable and a replay
 * of the same request resumes it; nothing is ever re-initialized or re-minted. */
export async function createVault(request: Request<'create'>, host: InstalledHost, deps: LifecycleDeps) {
  const existing = await readVaultRecord(request.vaultId, deps)
  let record: ControlReceipt
  if (admitVaultRequest(request, existing) === 'create') {
    // Before anything exists: never two vaults behind one hostname (gateway/Caddy route by it).
    await assertHostnameFree(request.vaultId, request.origin, deps)
    const storage = await reserveStorage(request.vaultId, host, deps)
    record = await saveVaultRecord(
      controlReceiptSchema.parse({
        schema: 1,
        phase: 'reserved',
        displayName: request.displayName,
        owner: request.owner,
        operation: {
          requestId: request.requestId,
          action: 'create',
          inputHash: hashVaultRequest(request),
          expectedGeneration: request.expectedGeneration,
        },
        receipt: {
          receiptId: request.requestId,
          tenantId: host.tenantId,
          physicalHostBinding: host.physicalHostBinding,
          vaultId: request.vaultId,
          hostEpoch: request.hostEpoch,
          generation: request.generation,
          upstreamVaultId: null,
          displayName: request.displayName,
          state: 'provisioning',
          upstreamCommit: host.upstreamCommit,
          artifactDigest: host.artifactDigest,
          localPort: storage.port,
          origin: request.origin,
          readAccess: 'pending',
        },
        storage,
        os: null,
      }),
      deps
    )
    // The invite replay caches exist from the start: missing/corrupt never means empty.
    await writePrivateJson(
      managedPaths({ vaultId: request.vaultId, root: deps.root }).control,
      'owner-invites.json',
      { schema: 1, invites: [] },
      ownerInviteCacheSchema,
      { uid: deps.uid }
    )
    await initializeMemberInviteCache(request.vaultId, deps)
  } else {
    record = existing!
    if (record.operation.action !== 'create') throw new Error('request_conflict')
  }
  record = await prepareStorage(record, deps)
  const admin = adminFor(deps)
  if (record.phase === 'storage_ready')
    record = await initializeVaultOwner(record, { root: deps.root, uid: deps.uid, admin: admin(record) })
  if (record.phase === 'initialized')
    record = await prepareReadCredential(record, { root: deps.root, uid: deps.uid, admin: admin(record) })
  // Before the first serve: upstream creates the identity (its own id) with the Ficus name, so the
  // first app to connect already shows it. Idempotent on replay.
  if (record.phase === 'reader_ready') await writeVaultName(record, record.displayName, host, deps)
  record = await startVaultService(record, deps)
  if (record.phase === 'service_started') {
    await writeReadHandoff(record, host, deps)
    record = await saveVaultRecord({ ...record, receipt: { ...record.receipt, readAccess: 'active' } }, deps)
    record = await markReady(record, deps)
  }
  await publish(deps)
  return record
}

/** Record the admitted next generation/operation BEFORE any effect so a replay resumes it. */
async function advance(request: Request<'rename' | 'read-revoke' | 'read-reconnect'>, deps: LifecycleDeps) {
  const existing = await readVaultRecord(request.vaultId, deps)
  const admission = admitVaultRequest(request, existing)
  const record = existing!
  if (admission === 'replay') {
    if (record.operation.action !== request.action) throw new Error('request_conflict')
    return { record, replay: true }
  }
  if (record.phase !== 'ready' || record.receipt.state !== 'ready') throw new Error('generation_conflict')
  const next = await saveVaultRecord(
    {
      ...record,
      ...(request.action === 'rename' ? { displayName: request.displayName } : {}),
      receipt: {
        ...record.receipt,
        generation: request.generation,
        hostEpoch: request.hostEpoch,
        ...(request.action === 'rename' ? { displayName: request.displayName } : {}),
      },
      operation: {
        requestId: request.requestId,
        action: request.action,
        inputHash: hashVaultRequest(request),
        expectedGeneration: request.expectedGeneration,
      },
    },
    deps
  )
  return { record: next, replay: false }
}

/** rename: the Ficus name at the next generation, then the same name as the upstream server name
 * (stop this vault, write, start, verify; see syncVaultName). The upstream id, route, gateway and
 * credentials are unchanged. A replay resumes the name write; equal names restart nothing. */
export async function renameVault(request: Request<'rename'>, host: InstalledHost, deps: LifecycleDeps) {
  const { record } = await advance(request, deps)
  await syncVaultName(record, host, deps)
  return record
}

/** read-revoke: Core's handoff is removed first, then every live Ficus reader credential is
 * revoked natively. Human members and their contributions are untouched. */
export async function revokeRead(request: Request<'read-revoke'>, deps: LifecycleDeps) {
  const { record } = await advance(request, deps)
  await removeReadHandoff(request.vaultId, deps)
  const admin = adminFor(deps)(record)
  const reader = (await admin.listMembers()).find((m) => m.handle === 'ficus-reader')
  if (reader)
    for (const credential of await admin.listCredentials())
      if (credential.member_id === reader.id && credential.revoked === null) await admin.revokeCredential(credential.id)
  return saveVaultRecord({ ...record, receipt: { ...record.receipt, readAccess: 'revoked' } }, deps)
}

/** read-reconnect: an explicit human request for ONE new read-only Ficus credential. Pending
 * escrow is written before minting; a lost mint revokes reader credentials and refuses. */
export async function reconnectRead(request: Request<'read-reconnect'>, host: InstalledHost, deps: LifecycleDeps) {
  const { record } = await advance(request, deps)
  const paths = managedPaths({ vaultId: request.vaultId, root: deps.root })
  const key = {
    schema: 1 as const,
    tenantId: record.receipt.tenantId,
    physicalHostBinding: record.receipt.physicalHostBinding,
    vaultId: record.receipt.vaultId,
    requestId: request.requestId,
  }
  const admin = adminFor(deps)(record)
  const escrow = (await present(join(paths.control, 'reader.json')))
    ? await readPrivateJson(paths.control, 'reader.json', escrowSchema, { uid: deps.uid })
    : null
  if (escrow?.requestId === request.requestId && escrow.phase === 'pending') {
    const reader = (await admin.listMembers()).find((m) => m.handle === 'ficus-reader')
    if (reader)
      for (const credential of await admin.listCredentials())
        if (credential.member_id === reader.id && credential.revoked === null)
          await admin.revokeCredential(credential.id)
    throw new Error('operation_failed')
  }
  if (escrow?.requestId !== request.requestId) {
    if (record.receipt.readAccess === 'active') throw new Error('generation_conflict')
    const member = await admin.ensureReadMember()
    await writePrivateJson(
      paths.control,
      'reader.json',
      { ...key, phase: 'pending', memberId: member.id, credentialId: null, token: null },
      escrowSchema,
      { uid: deps.uid }
    )
    const minted = await admin.mintReadCredential(member)
    await writePrivateJson(
      paths.control,
      'reader.json',
      { ...key, phase: 'complete', memberId: member.id, credentialId: minted.credential.id, token: minted.token },
      escrowSchema,
      { uid: deps.uid }
    )
  }
  await writeReadHandoff(record, host, deps)
  return saveVaultRecord({ ...record, receipt: { ...record.receipt, readAccess: 'active' } }, deps)
}

/** A link is only useful if its origin actually reaches this vault: (re)publish the routes and
 * Caddy sites first, which fails closed when Caddy cannot serve them. Otherwise the app gets
 * Caddy's empty 200 for an unknown host and reports "null is not an object". */
export async function ensureVaultServed(vaultId: string, deps: LifecycleDeps): Promise<void> {
  // The real publisher always returns its manifest; only an injected no-op returns nothing.
  const result = await publish(deps)
  if (result === undefined) return
  const published = gatewayManifestSchema.safeParse(result)
  if (!published.success) throw new Error('operation_failed')
  if (!published.data.routes.some((route) => route.vaultId === vaultId && route.state === 'ready'))
    throw new Error('maintenance')
  // Published is not served: a gateway that cannot load this manifest answers 503 for the link.
  await (deps.gatewayServes ?? ((m, id) => verifyGatewayServes(m, { vaultIds: [id] })))(published.data, vaultId)
}

/** owner-invite: only the recorded owner, only for the current generation of a ready vault whose
 * public route and Caddy site are published and readable; the durable replay cache returns the
 * same unexpired link and never re-mints. */
export async function ownerInvite(request: Request<'owner-invite'>, deps: LifecycleDeps) {
  const paths = managedPaths({ vaultId: request.vaultId, root: deps.root })
  const authorize = async () => {
    const record = await readVaultRecord(request.vaultId, deps)
    if (
      !record ||
      record.receipt.tenantId !== request.tenantId ||
      record.receipt.physicalHostBinding !== request.physicalHostBinding
    )
      throw new Error('not_found')
    if (record.phase !== 'ready' || record.receipt.state !== 'ready') throw new Error('generation_conflict')
    if (record.receipt.generation !== request.expectedGeneration) throw new Error('generation_conflict')
    if (record.owner.userId !== request.actorUserId) throw new Error('forbidden')
    return record
  }
  const record = await authorize()
  await ensureVaultServed(request.vaultId, deps)
  const issue =
    deps.issueAppLink ??
    (async (r: ControlReceipt, window: { issuedAt: string; expiresAt: string }) => {
      const script = `/opt/ficus-bigbrain/releases/${r.receipt.artifactDigest.slice(7)}/bigbrain-owner-link.js`
      const result = await (deps.run ?? runPrivateCommand)(vaultCommand(r.os!, script, []), {
        input: JSON.stringify({ membersPath: paths.memberStore, handle: r.owner.handle, ...window }),
      })
      if (result.code !== 0) throw new Error('upstream_unavailable')
      return JSON.parse(result.stdout) as { secret: string; expiresAt: string }
    })
  const link = await cachedOwnerAppLink({
    directory: paths.control,
    uid: deps.uid,
    input: request,
    now: deps.now,
    authorize: async () => void (await authorize()),
    issue: () => issue(record, { issuedAt: request.issuedAt, expiresAt: request.expiresAt }),
  })
  return { inviteUrl: `${record.receipt.origin}/invite#${link.secret}`, expiresAt: link.expiresAt }
}
