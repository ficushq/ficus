import { constants as C } from 'node:fs'
import { lstat, open, readdir, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { installedHostSchema, type InstalledHost } from './control-input'
import { BIGBRAIN_ETC } from './install'
import { mountPreparedVolume } from './mount'
import { BIGBRAIN_STATE_ROOT, managedPaths } from './paths'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import { ensureOwnedDirectory, readPrivateJson, writePrivateJson } from './secure-files'
import { linuxDeviceId, planVaultStorage } from './storage'
import { runPrivateCommand, type PrivateCommandRunner } from './process'
import { prepareVaultImage } from './volume-image'
import type { ManagedIdentity } from './accounts'
import { escrowSchema } from './bootstrap'
import { prepareSocketDirectory } from './preflight'
import { vaultSocketPath } from './gateway-policy'

export interface ProvisionDeps {
  root?: string
  etc?: string
  uid?: number
  run?: PrivateCommandRunner
  unitDirectory?: string
  tmpfilesDirectory?: string
  /** Root-side socket directory preparation (default: prepareSocketDirectory). */
  prepareSocket?: (vaultId: string, uid: number) => Promise<void>
  mountinfo?: () => Promise<string>
  prepareLayout?: (path: string, identity: ManagedIdentity, device: string) => Promise<void>
  freeBytes?: (path: string) => Promise<number>
  /** Readiness of the native server on its socket (default: unauthenticated whoami answers 401). */
  probeReady?: (socket: string) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  /** Authenticated whoami over the vault socket with the escrowed read credential (default: fetch). */
  whoami?: (socket: string, token: string) => Promise<unknown>
  /** Read the upstream identity file from the mounted store (default: no-follow root read). */
  readUpstreamIdentity?: (record: ControlReceipt) => Promise<string>
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw new Error('storage_unavailable')
  }
}
export async function vaultRecords(deps: ProvisionDeps): Promise<ControlReceipt[]> {
  const control = join(deps.root ?? BIGBRAIN_STATE_ROOT, 'control')
  const ids = (await readdir(control)).sort().filter((n) => UUID.test(n))
  return Promise.all(
    ids.map((id) => readPrivateJson(join(control, id), 'receipt.json', controlReceiptSchema, { uid: deps.uid }))
  )
}
export async function readVaultRecord(vaultId: string, deps: ProvisionDeps): Promise<ControlReceipt | null> {
  const paths = managedPaths({ vaultId, root: deps.root })
  if (!(await present(join(paths.control, 'receipt.json')))) return null
  return readPrivateJson(paths.control, 'receipt.json', controlReceiptSchema, { uid: deps.uid })
}
export async function saveVaultRecord(record: ControlReceipt, deps: ProvisionDeps): Promise<ControlReceipt> {
  const parsed = controlReceiptSchema.parse(record)
  const paths = managedPaths({ vaultId: parsed.receipt.vaultId, root: deps.root })
  // First write for a new vault creates its private control directory (verified, never adopted).
  await ensureOwnedDirectory(paths.control, 0o700, { uid: deps.uid })
  await writePrivateJson(paths.control, 'receipt.json', parsed, controlReceiptSchema, { uid: deps.uid })
  return parsed
}
export async function readHost(deps: ProvisionDeps): Promise<InstalledHost> {
  return readPrivateJson(deps.etc ?? BIGBRAIN_ETC, 'host.json', installedHostSchema, { uid: deps.uid })
}

/** Reservation against every non-deleted vault's recorded storage (failed/partial creates keep
 * theirs until removed) and the host's admission policy, with staging headroom for backups. */
export async function reserveStorage(vaultId: string, host: InstalledHost, deps: ProvisionDeps) {
  const root = deps.root ?? BIGBRAIN_STATE_ROOT
  const existing = (await vaultRecords(deps)).filter((r) => r.phase !== 'deleted').map((r) => r.storage)
  const free = await (
    deps.freeBytes ??
    (async (path: string) => {
      const s = await statfs(path)
      return s.bavail * s.bsize
    })
  )(root)
  return planVaultStorage({
    vaultId,
    existing,
    root: deps.root,
    freeDiskBytes: free,
    policy: {
      maxVaults: host.limits.maxVaults,
      perVaultDiskBytes: host.limits.perVaultDiskBytes,
      minCoreFreeDiskBytes: host.limits.minCoreFreeDiskBytes,
    },
  })
}

/** reserved -> storage_ready: owned identity, preallocated ext4 image and verified mount. A
 * storage_ready replay re-verifies/adopts only the recorded mount; nothing is reformatted. */
export async function prepareStorage(input: ControlReceipt, deps: ProvisionDeps): Promise<ControlReceipt> {
  const record = controlReceiptSchema.parse(input)
  if (record.phase !== 'reserved' && record.phase !== 'storage_ready') return record
  if (record.phase === 'reserved') await prepareVaultImage(record, deps)
  const os = await mountPreparedVolume(record, deps)
  if (record.os && JSON.stringify(record.os) !== JSON.stringify(os)) throw new Error('identity_mismatch')
  return saveVaultRecord({ ...record, phase: 'storage_ready', os }, deps)
}

const identitySchema = z.object({ id: z.string().uuid() }).passthrough()
const whoamiSchema = z
  .object({
    vault: z.object({ id: z.string().uuid() }).passthrough(),
    handle: z.string(),
    role: z.string(),
    kind: z.string(),
    permissions: z.array(z.string()),
    credential: z.object({ id: z.string() }).passthrough(),
  })
  .passthrough()
/** The native vault's own identity file (`.shared-identity.json`), read by root without
 * following links from the verified mount. This is what Ficus later binds read access to. */
export async function readUpstreamIdentity(record: ControlReceipt, deps: ProvisionDeps): Promise<string> {
  if (deps.readUpstreamIdentity) return deps.readUpstreamIdentity(record)
  const paths = managedPaths({ vaultId: record.receipt.vaultId, root: deps.root })
  if (!record.os) throw new Error('storage_unavailable')
  return readStoreIdentity(paths.mount, record.os.mountDevice)
}
export async function readStoreIdentity(mountPath: string, device: string): Promise<string> {
  // Descriptor-relative, no-follow walk: the vault UID owns these directories and must not be
  // able to redirect a root read with a substituted symlink at any component.
  const DIR = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK
  const mount = await open(mountPath, DIR)
  try {
    const mountInfo = await mount.stat()
    if (linuxDeviceId(mountInfo.dev) !== device) throw new Error('storage_unavailable')
    const vault = await open(`/proc/self/fd/${mount.fd}/vault`, DIR)
    try {
      if ((await vault.stat()).dev !== mountInfo.dev) throw new Error('storage_unavailable')
      const file = await open(
        `/proc/self/fd/${vault.fd}/.shared-identity.json`,
        C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK
      )
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > 65536 || info.nlink !== 1 || info.dev !== mountInfo.dev)
          throw new Error('storage_unavailable')
        const parsed = identitySchema.safeParse(JSON.parse(await file.readFile('utf8')))
        if (!parsed.success) throw new Error('upstream_protocol')
        return parsed.data.id
      } finally {
        await file.close()
      }
    } finally {
      await vault.close()
    }
  } finally {
    await mount.close()
  }
}

/** Start the recorded unit and wait for the loopback server, then require the store's upstream
 * identity to equal the recorded one. Phase service_started; the caller decides readiness. */
export async function startVaultService(input: ControlReceipt, deps: ProvisionDeps): Promise<ControlReceipt> {
  const record = controlReceiptSchema.parse(input)
  const run = deps.run ?? runPrivateCommand
  const paths = managedPaths({ vaultId: record.receipt.vaultId, root: deps.root })
  if (!record.os || !['reader_ready', 'initialized', 'service_started', 'ready'].includes(record.phase))
    throw new Error('generation_conflict')
  if (!record.receipt.origin) throw new Error('storage_unavailable')
  const socket = vaultSocketPath(record.receipt.vaultId)
  // The socket directory exists (owner/group/mode) before the unit's namespace is set up; the
  // boot-time tmpfiles declaration covers reboots, the root preflight re-asserts every start.
  await (
    deps.prepareSocket ??
    (async (id: string, uid: number) => {
      const gateway = await run(['/usr/bin/getent', 'group', 'ficus-bb-gateway'])
      const gid = Number(gateway.stdout.split(':')[2])
      if (gateway.code !== 0 || !Number.isSafeInteger(gid) || gid <= 0) throw new Error('storage_unavailable')
      await prepareSocketDirectory(id, uid, gid)
    })
  )(record.receipt.vaultId, record.os.uid)
  if ((await run(['/usr/bin/systemctl', 'enable', '--now', paths.unit], { timeoutMs: 45000 })).code !== 0)
    throw new Error('upstream_unavailable')
  const probe =
    deps.probeReady ??
    (async (socket: string) => {
      try {
        const response = await fetch(`http://${new URL(record.receipt.origin!).host}/v1/whoami`, {
          unix: socket,
          redirect: 'manual',
          signal: AbortSignal.timeout(2000),
        })
        await response.body?.cancel()
        return response.status === 401
      } catch {
        return false
      }
    })
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  let ready = false
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    ready = await probe(socket)
    if (!ready) await sleep(500)
  }
  if (!ready) throw new Error('upstream_unavailable')
  if (record.phase === 'reader_ready') {
    // The escrowed Ficus credential must authenticate as exactly the read-only agent reader of
    // THIS store (this first authenticated call also materializes the store's identity file).
    const escrow = await readPrivateJson(paths.control, 'reader.json', escrowSchema, { uid: deps.uid })
    if (escrow.phase !== 'complete' || !escrow.token) throw new Error('storage_unavailable')
    const actor = whoamiSchema.safeParse(
      await (
        deps.whoami ??
        (async (path: string, token: string) => {
          const response = await fetch(`http://${new URL(record.receipt.origin!).host}/v1/whoami`, {
            unix: path,
            headers: { Authorization: `Bearer ${token}` },
            redirect: 'manual',
            signal: AbortSignal.timeout(5000),
          })
          if (response.status !== 200) throw new Error('upstream_unavailable')
          return response.json()
        })
      )(socket, escrow.token)
    )
    if (
      !actor.success ||
      actor.data.handle !== 'ficus-reader' ||
      actor.data.role !== 'member' ||
      actor.data.kind !== 'agent' ||
      actor.data.permissions.length !== 1 ||
      actor.data.permissions[0] !== 'read' ||
      actor.data.credential.id !== escrow.credentialId
    )
      throw new Error('scope_mismatch')
    if ((await readUpstreamIdentity(record, deps)) !== actor.data.vault.id) throw new Error('identity_mismatch')
  }
  const upstream = await readUpstreamIdentity(record, deps)
  if (record.receipt.upstreamVaultId !== null && upstream !== record.receipt.upstreamVaultId)
    throw new Error('identity_mismatch')
  if (record.phase === 'service_started' || record.phase === 'ready') return record
  return saveVaultRecord(
    { ...record, phase: 'service_started', receipt: { ...record.receipt, upstreamVaultId: upstream } },
    deps
  )
}

export async function markReady(input: ControlReceipt, deps: ProvisionDeps): Promise<ControlReceipt> {
  const record = controlReceiptSchema.parse(input)
  if (record.phase === 'ready') return record
  if (record.phase !== 'service_started' || record.receipt.upstreamVaultId === null)
    throw new Error('generation_conflict')
  return saveVaultRecord({ ...record, phase: 'ready', receipt: { ...record.receipt, state: 'ready' } }, deps)
}
