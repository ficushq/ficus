import { constants as C } from 'node:fs'
import { mkdir, open, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { managedPaths } from './paths'
import { noteStage, refuse } from './diagnostics'
import { type ControlReceipt } from './receipts'
import { imageJournalSchema } from './volume-image'
import { installVaultUnitAssets } from './unit-assets'
import { ensureOwnedDirectory, openPrivateFile, readPrivateJson } from './secure-files'
import { verifyVaultMount, linuxDeviceId } from './storage'
import { verifyLoopBacking } from './preflight'
import { runPrivateCommand, type PrivateCommandRunner } from './process'
import type { ManagedIdentity } from './accounts'
interface Options {
  root?: string
  uid?: number
  unitDirectory?: string
  run?: PrivateCommandRunner
  mountinfo?: () => Promise<string>
  prepareLayout?: (path: string, identity: ManagedIdentity, device: string) => Promise<void>
}
const DIRECTORY_FLAGS = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK
export function assertVolumeRootDevice(
  info: { dev: number; uid: number },
  device: string,
  identity: ManagedIdentity,
  ownerUid = 0
): void {
  if (linuxDeviceId(info.dev) !== device || (info.uid !== ownerUid && info.uid !== identity.uid))
    throw new Error('storage_unavailable')
}
/** Hold the real mounted filesystem descriptor before modifying ownership. A pathname
 * mountinfo check alone has an unmount race and could chown/write the underlying Core disk.
 */
async function prepareLayout(path: string, identity: ManagedIdentity, device: string, ownerUid = 0): Promise<void> {
  const root = await open(path, DIRECTORY_FLAGS)
  try {
    const info = await root.stat()
    assertVolumeRootDevice(info, device, identity, ownerUid)
    await root.chown(identity.uid, identity.gid)
    await root.chmod(0o700)
    for (const name of ['auth', 'vault']) {
      const target = `/proc/self/fd/${root.fd}/${name}`
      try {
        await mkdir(target, { mode: 0o700 })
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
      }
      const child = await open(target, DIRECTORY_FLAGS)
      try {
        const data = await child.stat()
        if (data.dev !== info.dev || (data.uid !== ownerUid && data.uid !== identity.uid))
          throw new Error('storage_unavailable')
        await child.chown(identity.uid, identity.gid)
        await child.chmod(0o700)
        await child.sync()
      } finally {
        await child.close()
      }
    }
    await root.sync()
  } finally {
    await root.close()
  }
}
function mountFields(path: string, text: string): string[] | null {
  const matches = text
    .split('\n')
    .map((line) => line.split(' '))
    .filter((fields) => fields[4] === path)
  if (matches.length > 1) throw new Error('storage_unavailable')
  return matches[0] ?? null
}
/** Root lifecycle lock required. Caller first prepares the image, and persists returned
 * os/phase=storage_ready BEFORE native init. This starts ONLY a verified owned mount, never
 * the native service; no route/material/readiness is published by this stage.
 */
export async function mountPreparedVolume(
  record: ControlReceipt,
  options: Options = {}
): Promise<NonNullable<ControlReceipt['os']>> {
  const paths = managedPaths({ vaultId: record.receipt.vaultId, root: options.root })
  const journal = await readPrivateJson(paths.control, 'image.json', imageJournalSchema, options)
  if (!journal.image || !journal.identity || !journal.formatted) refuse('storage_unavailable', 'mount_image_unprepared')
  // Asset installer verifies persisted current receipt, complete physical binding, storage
  // recipe and old/new unit hashes before any systemd operation can begin.
  const units = await installVaultUnitAssets(record, options)
  const raw = await openPrivateFile(dirname(paths.image), basename(paths.image), options)
  try {
    const info = await raw.stat()
    if (
      info.dev !== journal.image.device ||
      info.ino !== journal.image.inode ||
      info.size !== record.storage.diskBytes ||
      info.blocks * 512 < record.storage.diskBytes
    )
      refuse('storage_unavailable', 'mount_image_changed')
  } finally {
    await raw.close()
  }
  const run = options.run ?? runPrivateCommand
  // The HOST mount table (PID 1): the control worker runs in a private mount namespace.
  const mountinfo = options.mountinfo ?? (() => readFile('/proc/1/mountinfo', 'utf8'))
  let fields = mountFields(paths.mount, await mountinfo())
  if (!fields) {
    await ensureOwnedDirectory(paths.mount, 0o700, options)
    if ((await run(['/usr/bin/systemctl', 'daemon-reload'])).code !== 0) throw new Error('operation_failed')
    const properties = await run([
      '/usr/bin/systemctl',
      'show',
      '--property=FragmentPath,DropInPaths,LoadState',
      units.mountUnitName,
    ])
    const values = new Map(
      properties.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const at = line.indexOf('=')
          return [line.slice(0, at), line.slice(at + 1)]
        })
    )
    if (
      properties.code !== 0 ||
      values.get('LoadState') !== 'loaded' ||
      values.get('DropInPaths') !== '' ||
      values.get('FragmentPath') !== join(options.unitDirectory ?? '/etc/systemd/system', units.mountUnitName)
    )
      throw new Error('identity_mismatch')
    if ((await run(['/usr/bin/systemctl', 'start', units.mountUnitName])).code !== 0)
      throw new Error('operation_failed')
    fields = mountFields(paths.mount, await mountinfo())
  }
  const device = fields?.[2]
  if (!device || !/^7:\d+$/.test(device)) refuse('storage_unavailable', device ? 'mount_not_loop' : 'mount_not_visible')
  noteStage('mount_visible')
  verifyVaultMount({ mount: paths.mount, device, filesystem: 'ext4' }, await mountinfo())
  noteStage('mount_verified')
  const loop = await run([
    '/usr/sbin/losetup',
    '--list',
    '--json',
    '--output',
    'NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN',
    `/dev/loop${device.slice(2)}`,
  ])
  if (loop.code !== 0) refuse('storage_unavailable', 'loop_list_failed')
  let loopValue: unknown
  try {
    loopValue = JSON.parse(loop.stdout)
  } catch {
    throw new Error('storage_unavailable')
  }
  verifyLoopBacking(
    { device, image: paths.image, inode: journal.image.inode, imageDevice: journal.image.device },
    loopValue
  )
  noteStage('loop_verified')
  await (
    options.prepareLayout ?? ((path, identity, expected) => prepareLayout(path, identity, expected, options.uid ?? 0))
  )(paths.mount, journal.identity, device)
  return {
    uid: journal.identity.uid,
    gid: journal.identity.gid,
    imageDevice: journal.image.device,
    imageInode: journal.image.inode,
    mountDevice: device,
  }
}
