import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MANAGED_BIGBRAIN_CONTRACT_VERSION,
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_SHARED_PROTOCOL,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  managedBigbrainErrorCodeSchema,
  managedBigbrainHostReplySchema,
  type ManagedBigbrainErrorCode,
  type ManagedBigbrainHostReply,
  type ManagedBigbrainHostRequest,
} from '@ficus/shared/managed-bigbrain'
import { installedHostSchema, validateHostAdmission, type InstalledHost } from './control-input'
import { BIGBRAIN_ETC } from './install'
import { BIGBRAIN_STATE_ROOT, GATEWAY_UNIT, managedPaths } from './paths'
import { admitVaultRequest, controlReceiptSchema, hashVaultRequest, type ControlReceipt } from './receipts'
import { readPrivateJson, writePrivateJson } from './secure-files'
import { runPrivateCommand, startServiceDeliberately, type PrivateCommandRunner } from './process'
import { reconcileMaintenance, releaseManagedBackup, stageManagedBackup } from './backup'
import { deleteVaultResources, type DeleteOptions } from './delete'
import { readStagedArchive } from './restore'
import { publishIngress } from './ingress'
import { drainStages } from './diagnostics'
import { executeRestore, type RestoreDeps } from './restore-exec'
import { createVault, ownerInvite, reconnectRead, renameVault, revokeRead, type LifecycleDeps } from './lifecycle'
import { waitForVaultReady } from './provision'

export { GATEWAY_UNIT }
const ingress = (deps: ControlDeps) =>
  (deps.ingress ?? (() => publishIngress({ root: deps.root, etc: deps.etc, uid: deps.uid, run: deps.run })))()
const RETRYABLE = new Set<ManagedBigbrainErrorCode>(['busy', 'maintenance', 'upstream_unavailable', 'operation_failed'])

export interface ControlDeps
  extends
    Omit<DeleteOptions, 'root' | 'uid' | 'run' | 'mountinfo'>,
    Omit<RestoreDeps, 'ingress' | 'admin'>,
    Omit<LifecycleDeps, 'ingress'> {
  root?: string
  etc?: string
  uid?: number
  run?: PrivateCommandRunner
  now?: () => number
  verifyStorage?: (record: ControlReceipt) => Promise<void>
  /** Re-derive routes + Caddy sites from current state (default publishIngress). */
  ingress?: () => Promise<unknown>
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw new Error('storage_unavailable')
  }
}
function code(error: unknown): ManagedBigbrainErrorCode {
  const parsed = managedBigbrainErrorCodeSchema.safeParse(error instanceof Error ? error.message : '')
  return parsed.success ? parsed.data : 'operation_failed'
}
/** Bounded, allowlisted failure: never stdout/stderr, paths or secret material. */
export function failure(requestId: string, error: unknown): ManagedBigbrainHostReply {
  const c = code(error)
  return {
    contractVersion: MANAGED_BIGBRAIN_CONTRACT_VERSION,
    requestId,
    ok: false,
    code: c,
    retryable: RETRYABLE.has(c),
  }
}
async function records(root: string, uid: number): Promise<ControlReceipt[]> {
  const control = join(root, 'control')
  const ids = (await readdir(control))
    .sort()
    .filter((n) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(n))
  return Promise.all(ids.map((id) => readPrivateJson(join(control, id), 'receipt.json', controlReceiptSchema, { uid })))
}
const serving = (r: ControlReceipt) =>
  r.receipt.state !== 'deleted' && ['service_started', 'ready'].includes(r.phase) && r.receipt.upstreamVaultId !== null

async function capabilities(host: InstalledHost | null, tenantId: string, deps: ControlDeps) {
  const run = deps.run ?? runPrivateCommand
  const now = new Date((deps.now ?? Date.now)()).toISOString()
  const base = {
    contractVersion: MANAGED_BIGBRAIN_CONTRACT_VERSION,
    tenantId,
    upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
    sharedProtocol: MANAGED_BIGBRAIN_SHARED_PROTOCOL,
    observedAt: now,
  }
  if (!host)
    return {
      ...base,
      physicalHostBinding: null,
      available: false,
      reasonCode: 'not_installed' as const,
      installed: false,
      artifactDigest: null,
      hostEpoch: 0,
      hostState: 'active' as const,
      zone: null,
      limits: { ...MANAGED_BIGBRAIN_DEFAULT_LIMITS },
    }
  // Content-free observations; each one that fails names why the feature is unavailable.
  let reasonCode: ManagedBigbrainErrorCode | null = null
  if (host.hostState !== 'active') reasonCode = 'forbidden'
  else if (await present(join(deps.root ?? BIGBRAIN_STATE_ROOT, 'control', 'maintenance.json')))
    reasonCode = 'maintenance'
  else if ((await run(['/usr/bin/systemctl', 'is-enabled', '--quiet', 'ficus-backup.timer'])).code !== 0)
    reasonCode = 'backup_unavailable'
  else if ((await run(['/usr/bin/systemctl', 'is-active', '--quiet', GATEWAY_UNIT])).code !== 0)
    reasonCode = 'upstream_unavailable'
  return {
    ...base,
    physicalHostBinding: host.physicalHostBinding,
    available: reasonCode === null,
    reasonCode,
    installed: true,
    artifactDigest: host.artifactDigest,
    hostEpoch: host.hostEpoch,
    hostState: host.hostState,
    zone: host.zone,
    limits: host.limits,
  }
}

/** Host-wide lifecycle effects. Admission already proved the epoch transition (or an exact
 * replay of the recorded effect). The new epoch and pending effect are persisted BEFORE any
 * unit is touched, so a lost reply or crash replays the same effect instead of a fresh one.
 */
async function hostEffect(
  request: Extract<ManagedBigbrainHostRequest, { previousHostEpoch: number }>,
  host: InstalledHost,
  deps: ControlDeps
) {
  const etc = deps.etc ?? BIGBRAIN_ETC
  const root = deps.root ?? BIGBRAIN_STATE_ROOT
  const uid = deps.uid ?? 0
  const run = deps.run ?? runPrivateCommand
  const replay = host.effect?.effectId === request.effectId && host.hostEpoch === request.hostEpoch
  if (replay && host.effect!.completed && request.action !== 'restore-fence') return host
  if (host.hostState === 'deleted' && !replay) throw new Error('forbidden')
  const hostState =
    request.action === 'suspend-tenant'
      ? 'suspended'
      : request.action === 'resume-tenant'
        ? 'active'
        : request.action === 'destroy-tenant'
          ? 'terminated'
          : host.hostState
  const pending = installedHostSchema.parse({
    ...host,
    hostEpoch: request.hostEpoch,
    hostState,
    effect: {
      action: request.action,
      effectId: request.effectId,
      previousHostEpoch: request.previousHostEpoch,
      completed: false,
    },
  })
  if (!replay || !host.effect!.completed)
    await writePrivateJson(etc, 'host.json', pending, installedHostSchema, { uid })
  // Public sites/routes follow the new host state first: nothing new is admitted while stopping.
  if (request.action !== 'resume-tenant') await ingress(deps)
  const vaults = await records(root, uid)
  const unit = (r: ControlReceipt) => managedPaths({ vaultId: r.receipt.vaultId }).unit
  if (request.action === 'resume-tenant') {
    if (!(await startServiceDeliberately(run, GATEWAY_UNIT))) throw new Error('operation_failed')
    const resumed = vaults.filter(serving)
    for (const r of resumed) if (!(await startServiceDeliberately(run, unit(r)))) throw new Error('operation_failed')
    // Resume promises serving vaults, exactly like create: wait until each answers on its socket.
    for (const r of resumed) await waitForVaultReady(r, deps)
  } else {
    // Close ingress first, then every vault service; storage and identities stay for resume/restore.
    for (const target of [GATEWAY_UNIT, ...vaults.map(unit)]) {
      const c = (await run(['/usr/bin/systemctl', 'stop', target], { timeoutMs: 45000 })).code
      if (c !== 0 && c !== 5) throw new Error('operation_failed')
    }
  }
  if (request.action === 'resume-tenant') await ingress(deps)
  const done = installedHostSchema.parse({ ...pending, effect: { ...pending.effect!, completed: true } })
  await writePrivateJson(etc, 'host.json', done, installedHostSchema, { uid })
  return done
}

async function currentReceipt(vaultId: string, deps: ControlDeps): Promise<ControlReceipt | null> {
  const paths = managedPaths({ vaultId, root: deps.root })
  if (!(await present(join(paths.control, 'receipt.json')))) return null
  return readPrivateJson(paths.control, 'receipt.json', controlReceiptSchema, { uid: deps.uid })
}

/** Exact-ID/name/generation fenced deletion. The new generation and operation are recorded
 * before any effect; a replay of the same request resumes the recorded deletion.
 */
async function deleteVault(request: Extract<ManagedBigbrainHostRequest, { action: 'delete' }>, deps: ControlDeps) {
  const existing = await currentReceipt(request.vaultId, deps)
  const admission = admitVaultRequest(request, existing)
  let record = existing!
  if (admission === 'advance') {
    if (request.confirmedName !== record.displayName) throw new Error('identity_mismatch')
    record = controlReceiptSchema.parse({
      ...record,
      receipt: { ...record.receipt, generation: request.generation, hostEpoch: request.hostEpoch },
      operation: {
        requestId: request.requestId,
        action: 'delete',
        inputHash: hashVaultRequest(request),
        expectedGeneration: request.expectedGeneration,
      },
    })
    const paths = managedPaths({ vaultId: request.vaultId, root: deps.root })
    await writePrivateJson(paths.control, 'receipt.json', record, controlReceiptSchema, { uid: deps.uid })
  } else if (record.operation.action !== 'delete') throw new Error('request_conflict')
  // Unpublish first (route/site derive from the now-deleting receipt), then remove resources.
  const tombstone = await deleteVaultResources(record, { ...deps, beforeStop: () => ingress(deps) })
  await ingress(deps)
  return tombstone
}

/** One admitted request -> one bounded reply. The caller (fixed root launcher) holds the host
 * lifecycle flock for the whole call; nothing here reads caller paths, ports or commands.
 */
export async function dispatchHostRequest(input: unknown, deps: ControlDeps = {}): Promise<ManagedBigbrainHostReply> {
  const claimed = typeof input === 'object' && input !== null ? (input as { requestId?: unknown }).requestId : null
  const requestId =
    typeof claimed === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(claimed)
      ? claimed
      : '00000000-0000-4000-8000-000000000000'
  try {
    const etc = deps.etc ?? BIGBRAIN_ETC
    const uid = deps.uid ?? 0
    const installed = (await present(join(etc, 'host.json')))
      ? await readPrivateJson(etc, 'host.json', installedHostSchema, { uid })
      : null
    // No incarnation: a probe reports not_installed (a success reply needs a binding).
    if (!installed) throw new Error('not_installed')
    const request = validateHostAdmission(input, installed)
    const success = {
      contractVersion: MANAGED_BIGBRAIN_CONTRACT_VERSION,
      requestId: request.requestId,
      ok: true as const,
      physicalHostBinding: installed.physicalHostBinding,
    }
    const reply = async (): Promise<unknown> => {
      switch (request.action) {
        case 'probe':
          return { ...success, action: 'probe', capabilities: await capabilities(installed, request.tenantId, deps) }
        case 'status': {
          const record = await currentReceipt(request.vaultId, deps)
          if (!record) throw new Error('not_found')
          return { ...success, action: 'status', receipt: record.receipt }
        }
        case 'delete':
          return { ...success, action: 'delete', receipt: (await deleteVault(request, deps)).receipt }
        case 'suspend-tenant':
        case 'resume-tenant':
        case 'destroy-tenant': {
          const host = await hostEffect(request, installed, deps)
          return {
            ...success,
            action: request.action,
            hostEpoch: host.hostEpoch,
            effectId: request.effectId,
            completed: true,
            code: null,
          }
        }
        case 'restore-fence': {
          const host = await hostEffect(request, installed, deps)
          const { inventory } = await readStagedArchive({ root: deps.root, etc: deps.etc, uid })
          return {
            ...success,
            action: 'restore-fence',
            hostEpoch: host.hostEpoch,
            effectId: request.effectId,
            archive: inventory,
          }
        }
        case 'reconcile-maintenance': {
          await reconcileMaintenance({ root: deps.root, etc: deps.etc, uid, run: deps.run })
          return {
            ...success,
            action: request.action,
            hostEpoch: installed.hostEpoch,
            effectId: null,
            completed: true,
            code: null,
          }
        }
        case 'backup-release': {
          await releaseManagedBackup({ root: deps.root, uid })
          return {
            ...success,
            action: request.action,
            hostEpoch: installed.hostEpoch,
            effectId: request.effectId,
            completed: true,
            code: null,
          }
        }
        case 'backup-stage': {
          // Staging is only meaningful inside the local backup tool's envelope run.
          if (!deps.verifyStorage) throw new Error('forbidden')
          await stageManagedBackup({
            root: deps.root,
            etc: deps.etc,
            uid,
            run: deps.run,
            leaseId: request.effectId,
            verifyStorage: deps.verifyStorage,
          })
          return {
            ...success,
            action: request.action,
            hostEpoch: installed.hostEpoch,
            effectId: request.effectId,
            completed: true,
            code: null,
          }
        }
        case 'restore': {
          // Authoritative current grants; excluded IDs are never mounted. Vaults arrive read-revoked.
          await executeRestore(request, { ...deps, ingress: () => ingress(deps) })
          return {
            ...success,
            action: 'restore',
            hostEpoch: installed.hostEpoch,
            effectId: request.effectId,
            completed: true,
            code: null,
          }
        }
        case 'create':
        case 'rename':
        case 'read-revoke':
        case 'read-reconnect': {
          const lifecycle = { ...deps, ingress: () => ingress(deps) }
          const record =
            request.action === 'create'
              ? await createVault(request, installed, lifecycle)
              : request.action === 'rename'
                ? await renameVault(request, lifecycle)
                : request.action === 'read-revoke'
                  ? await revokeRead(request, lifecycle)
                  : await reconnectRead(request, installed, lifecycle)
          return { ...success, action: request.action, receipt: record.receipt }
        }
        case 'owner-invite':
          return {
            ...success,
            action: 'owner-invite',
            invite: await ownerInvite(request, { ...deps, ingress: () => ingress(deps) }),
          }
        default:
          throw new Error('invalid_request')
      }
    }
    return managedBigbrainHostReplySchema.parse(await reply())
  } catch (error) {
    return failure(requestId, error)
  }
}

/** `ficus-bigbrain-host control`: only ever started by the fixed root launcher inside its bounded
 * transient unit, with the host lifecycle flock held. One bounded JSON request on stdin, one
 * bounded JSON reply on stdout; never argv, environment or caller-chosen paths.
 */
export async function controlMain(args: string[]): Promise<void> {
  const { readBoundedControlBytes } = await import('./control-input')
  const { runIsolationChecks } = await import('./preflight')
  const { MANAGED_BIGBRAIN_HOST_REPLY_BYTES } = await import('@ficus/shared/managed-bigbrain')
  let reply: ManagedBigbrainHostReply
  try {
    if (process.getuid?.() !== 0 || args.length !== 0) throw new Error('invalid_request')
    const stage = { name: 'arguments' }
    try {
      await runIsolationChecks('control', stage)
    } catch (error) {
      const reason = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'unexpected'
      console.error(`Managed BigBrain control isolation refused at ${stage.name} (${reason})`)
      throw new Error('unsupported_host')
    }
    const bytes = await readBoundedControlBytes(Bun.stdin.stream())
    let input: unknown
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new Error('invalid_request')
    }
    // Operator diagnostics (root-only file): the last commands' fixed verbs and exit codes plus
    // the failing function names. Never argv values, names, paths or any secret.
    const trail: string[] = []
    const run: PrivateCommandRunner = async (argv, options) => {
      const verb = (value: string | undefined) =>
        (value ?? '')
          .split('/')
          .at(-1)!
          .replace(/[^\w.-]/g, '')
          .slice(0, 40)
      const script = argv.find((a) => a.endsWith('.js'))
      const label = [
        verb(argv[0]),
        verb(argv[1]?.startsWith('-') ? '' : argv[1]),
        script ? verb(script) : '',
        script ? verb(argv[argv.indexOf(script) + 1]) : '',
      ]
        .filter(Boolean)
        .join(' ')
      try {
        const result = await runPrivateCommand(argv, options)
        trail.push(`${label}=${result.code}`)
        return result
      } catch (error) {
        trail.push(`${label}=${error instanceof Error ? error.message : 'error'}`)
        throw error
      }
    }
    reply = await dispatchHostRequest(input, { run })
    if (!reply.ok) {
      const { writeFile } = await import('node:fs/promises')
      // The control unit's only writable state is /etc and /var/lib/ficus-bigbrain (root-only).
      await writeFile(
        '/var/lib/ficus-bigbrain/control/last-failure',
        `${reply.code}: ${trail.slice(-8).join(' | ')} :: ${drainStages().join(' > ')}\n`,
        {
          mode: 0o600,
        }
      ).catch(() => {})
    }
  } catch (error) {
    reply = failure('00000000-0000-4000-8000-000000000000', error)
  }
  const text = JSON.stringify(reply)
  console.log(
    Buffer.byteLength(text) <= MANAGED_BIGBRAIN_HOST_REPLY_BYTES
      ? text
      : JSON.stringify(failure(reply.requestId, new Error('output_limit')))
  )
}
