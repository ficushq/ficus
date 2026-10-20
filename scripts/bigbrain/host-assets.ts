import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { MANAGED_BIGBRAIN_HELPER } from '@ficus/shared/managed-bigbrain'
import { runPrivateCommand, startServiceDeliberately, type PrivateCommandRunner } from './process'
import { GATEWAY_UNIT } from './paths'
import { gatewayScript, readPublishedManifest, verifyRunningRelease, waitForGatewayServing } from './gateway-probe'
import {
  ensureOwnedDirectory,
  readPrivateJson,
  readPublicText,
  writeOwnerExecutable,
  writePrivateJson,
  writePublicText,
} from './secure-files'
import { renderAggregateUnit, renderControlLauncher, renderGatewayUnit } from './units'

export const GATEWAY_ACCOUNT = 'ficus-bb-gateway'
const GATEWAY_COMMENT = 'Ficus managed BigBrain gateway'
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
export const hostAssetsSchema = z
  .object({ schema: z.literal(1), launcher: digest, slice: digest, gateway: digest, tmpfiles: digest })
  .strict()
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

export interface HostAssetOptions {
  etc: string
  uid?: number
  run?: PrivateCommandRunner
  /** Fixture-only overrides of the fixed install locations. */
  unitDirectory?: string
  launcher?: string
  tmpfilesDirectory?: string
  /** Proof the restarted gateway process loaded the published manifest and runs this release
   * (default: a bounded wait on its socket, then verifyRunningRelease). */
  gatewayServing?: () => Promise<void>
}
/** Root-owned socket parents exist at boot (before any unit starts) and survive Restart=. The
 * per-vault directories are declared next to each vault's units (unit-assets). */
export const SOCKET_TMPFILES = [
  'd /run/ficus-bigbrain 0755 root root -',
  'd /run/ficus-bigbrain/vaults 0755 root root -',
  'd /run/ficus-bigbrain/gateway 2750 ficus-bb-gateway caddy -',
  '',
].join('\n')

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw new Error('storage_unavailable')
  }
}

/** The one shared gateway account: created once with a fixed marker, never adopted otherwise. */
export async function ensureGatewayAccount(run: PrivateCommandRunner): Promise<void> {
  const lookup = await run(['/usr/bin/getent', 'passwd', GATEWAY_ACCOUNT])
  if (lookup.code === 0) {
    const fields = lookup.stdout.trim().split(':')
    if (
      fields.length !== 7 ||
      fields[0] !== GATEWAY_ACCOUNT ||
      fields[4] !== GATEWAY_COMMENT ||
      fields[6] !== '/usr/sbin/nologin'
    )
      throw new Error('identity_mismatch')
    return
  }
  if (lookup.code !== 2) throw new Error('operation_failed')
  if ((await run(['/usr/bin/getent', 'group', GATEWAY_ACCOUNT])).code !== 2) throw new Error('identity_mismatch')
  const created = await run([
    '/usr/sbin/useradd',
    '--system',
    '--user-group',
    '--no-create-home',
    '--no-log-init',
    '--home-dir',
    '/nonexistent',
    '--shell',
    '/usr/sbin/nologin',
    '--comment',
    GATEWAY_COMMENT,
    '--',
    GATEWAY_ACCOUNT,
  ])
  if (created.code !== 0) throw new Error('operation_failed')
}

/** Fixed root launcher, aggregate slice and gateway unit for the CURRENT release, under the
 * host lifecycle lock. Every target must be absent, already exact, or carry the hash this
 * installer recorded last time: a foreign/edited file is never overwritten. Then the gateway
 * (credential-free; empty routes until a vault is ready) is enabled and RESTARTED, and must
 * answer from the published manifest before install succeeds. A plain start left a gateway that
 * was already running on the previous release's code: its stricter route schema rejected the
 * current manifest, so it answered every vault host 503 `not_installed` while the unit was active.
 */
export async function installHostAssets(artifactDigest: string, options: HostAssetOptions): Promise<void> {
  const uid = options.uid ?? 0
  const run = options.run ?? runPrivateCommand
  const units = options.unitDirectory ?? '/etc/systemd/system'
  const launcher = options.launcher ?? MANAGED_BIGBRAIN_HELPER
  const launcherDir = launcher.slice(0, launcher.lastIndexOf('/'))
  const launcherName = launcher.slice(launcher.lastIndexOf('/') + 1)
  const tmpfiles = options.tmpfilesDirectory ?? '/etc/tmpfiles.d'
  const assets = [
    { key: 'launcher', dir: launcherDir, name: launcherName, text: await renderControlLauncher(artifactDigest) },
    { key: 'slice', dir: units, name: 'ficus-bigbrain.slice', text: await renderAggregateUnit() },
    {
      key: 'gateway',
      dir: units,
      name: 'ficus-bigbrain-gateway.service',
      text: await renderGatewayUnit(artifactDigest),
    },
    { key: 'tmpfiles', dir: tmpfiles, name: 'ficus-bigbrain.conf', text: SOCKET_TMPFILES },
  ] as const
  const recorded = (await present(join(options.etc, 'host-assets.json')))
    ? await readPrivateJson(options.etc, 'host-assets.json', hostAssetsSchema, { uid })
    : null
  await ensureOwnedDirectory(launcherDir, 0o755, { uid })
  await ensureOwnedDirectory(units, 0o755, { uid })
  await ensureOwnedDirectory(tmpfiles, 0o755, { uid })
  for (const asset of assets) {
    if (!(await present(join(asset.dir, asset.name)))) continue
    const current = await readPublicText(asset.dir, asset.name, { uid }).catch(async () => {
      // The launcher is 0750, not a public file: read it through the same owner checks.
      const { readFile } = await import('node:fs/promises')
      const info = await lstat(join(asset.dir, asset.name))
      if (!info.isFile() || info.nlink !== 1 || info.uid !== uid || (info.mode & 0o777) !== 0o750)
        throw new Error('identity_mismatch')
      return readFile(join(asset.dir, asset.name), 'utf8')
    })
    if (current !== asset.text && sha(current) !== recorded?.[asset.key]) throw new Error('identity_mismatch')
  }
  await ensureGatewayAccount(run)
  for (const asset of assets)
    if (asset.key === 'launcher') await writeOwnerExecutable(asset.dir, asset.name, asset.text, { uid })
    else await writePublicText(asset.dir, asset.name, asset.text, { uid })
  await writePrivateJson(
    options.etc,
    'host-assets.json',
    {
      schema: 1,
      launcher: sha(assets[0].text),
      slice: sha(assets[1].text),
      gateway: sha(assets[2].text),
      tmpfiles: sha(assets[3].text),
    },
    hostAssetsSchema,
    { uid }
  )
  if ((await run(['/usr/bin/systemd-tmpfiles', '--create', join(tmpfiles, 'ficus-bigbrain.conf')])).code !== 0)
    throw new Error('operation_failed')
  if ((await run(['/usr/bin/systemctl', 'daemon-reload'])).code !== 0) throw new Error('operation_failed')
  if (!(await startServiceDeliberately(run, GATEWAY_UNIT, { enable: true, restart: true })))
    throw new Error('operation_failed')
  await (
    options.gatewayServing ??
    (async () => {
      // Serving first: until Bun binds its socket, the main PID may not have exec'd yet.
      await waitForGatewayServing(await readPublishedManifest(options.etc, uid))
      await verifyRunningRelease(GATEWAY_UNIT, gatewayScript(artifactDigest), { run })
    })
  )()
}
