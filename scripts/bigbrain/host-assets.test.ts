import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHostAssets, GATEWAY_ACCOUNT } from './host-assets'
import type { PrivateCommandRunner } from './process'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const D1 = `sha256:${'a'.repeat(64)}`
const D2 = `sha256:${'b'.repeat(64)}`

async function fixture(account: 'absent' | 'ours' | 'foreign' = 'absent') {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-assets-'))
  roots.push(outer)
  const etc = join(outer, 'etc')
  await mkdir(etc, { mode: 0o700 })
  const calls: string[][] = []
  const serving: string[] = []
  let exists = account !== 'absent'
  const run: PrivateCommandRunner = async (argv) => {
    calls.push(argv)
    if (argv[0] === '/usr/bin/getent' && argv[1] === 'passwd') {
      if (!exists) return { code: 2, stdout: '' }
      const comment = account === 'foreign' ? 'Someone else' : 'Ficus managed BigBrain gateway'
      return { code: 0, stdout: `${GATEWAY_ACCOUNT}:x:990:990:${comment}:/nonexistent:/usr/sbin/nologin\n` }
    }
    if (argv[0] === '/usr/bin/getent' && argv[1] === 'group') return { code: 2, stdout: '' }
    if (argv[0] === '/usr/sbin/useradd') exists = true
    return { code: 0, stdout: '' }
  }
  const opts = {
    etc,
    uid,
    run,
    unitDirectory: join(outer, 'units'),
    launcher: join(outer, 'libexec', 'ficus-bigbrainctl'),
    tmpfilesDirectory: join(outer, 'tmpfiles.d'),
    gatewayServing: async () => void serving.push(String(calls.length)),
  }
  return { outer, opts, calls, serving }
}

test('installs the release-bound root launcher (0750), slice and gateway unit, creates the gateway account once and starts the gateway', async () => {
  const f = await fixture()
  await installHostAssets(D1, f.opts)
  const launcher = await stat(f.opts.launcher)
  expect(launcher.mode & 0o777).toBe(0o750)
  expect(await readFile(f.opts.launcher, 'utf8')).toContain(
    `/opt/ficus-bigbrain/releases/${'a'.repeat(64)}/ficus-bigbrain-host.js control`
  )
  expect((await stat(join(f.opts.unitDirectory, 'ficus-bigbrain-gateway.service'))).mode & 0o777).toBe(0o644)
  expect((await stat(join(f.opts.unitDirectory, 'ficus-bigbrain.slice'))).mode & 0o777).toBe(0o644)
  expect(f.calls.filter((c) => c[0] === '/usr/sbin/useradd')).toHaveLength(1)
  // Restarted, not `enable --now`: a gateway already running the previous release must be replaced.
  expect(f.calls.slice(-2)).toEqual([
    ['/usr/bin/systemctl', 'enable', 'ficus-bigbrain-gateway.service'],
    ['/usr/bin/systemctl', 'restart', 'ficus-bigbrain-gateway.service'],
  ])
  // ...and install succeeds only after the restarted process proved it serves (after the restart).
  expect(f.serving).toEqual([String(f.calls.length)])
  // Socket parents are declared for boot and created before the gateway first starts.
  expect(await readFile(join(f.opts.tmpfilesDirectory, 'ficus-bigbrain.conf'), 'utf8')).toContain(
    'd /run/ficus-bigbrain/gateway 2750 ficus-bb-gateway caddy -'
  )
  const order = f.calls.map((c) => c.slice(0, 2).join(' '))
  expect(order.indexOf('/usr/bin/systemd-tmpfiles --create')).toBeLessThan(order.indexOf('/usr/bin/systemctl enable'))
  // Upgrade to a new release replaces exactly the recorded files; the account is not recreated.
  const before = f.calls.length
  await installHostAssets(D2, f.opts)
  expect(await readFile(f.opts.launcher, 'utf8')).toContain('b'.repeat(64))
  expect(f.calls.filter((c) => c[0] === '/usr/sbin/useradd')).toHaveLength(1)
  // The upgrade restarts the RUNNING gateway onto release B.
  expect(f.calls.slice(before).at(-1)).toEqual(['/usr/bin/systemctl', 'restart', 'ficus-bigbrain-gateway.service'])
  expect(f.serving).toHaveLength(2)
})

test('install fails closed when the restarted gateway does not serve the published manifest', async () => {
  const f = await fixture()
  f.opts.gatewayServing = async () => {
    throw new Error('upstream_unavailable')
  }
  await expect(installHostAssets(D1, f.opts)).rejects.toThrow('upstream_unavailable')
  const g = await fixture()
  const run = g.opts.run
  g.opts.run = async (argv, options) => (argv[1] === 'restart' ? { code: 1, stdout: '' } : run(argv, options))
  await expect(installHostAssets(D1, g.opts)).rejects.toThrow('operation_failed')
  expect(g.serving).toHaveLength(0)
})

test('a foreign or edited launcher/unit is never overwritten', async () => {
  const f = await fixture()
  await installHostAssets(D1, f.opts)
  await writeFile(join(f.opts.unitDirectory, 'ficus-bigbrain-gateway.service'), 'EDITED', { mode: 0o644 })
  await expect(installHostAssets(D2, f.opts)).rejects.toThrow('identity_mismatch')
  expect(await readFile(join(f.opts.unitDirectory, 'ficus-bigbrain-gateway.service'), 'utf8')).toBe('EDITED')
  const g = await fixture()
  await mkdir(join(g.outer, 'libexec'), { mode: 0o755 })
  await writeFile(g.opts.launcher, '#!/bin/sh\nexec evil\n', { mode: 0o750 })
  await expect(installHostAssets(D1, g.opts)).rejects.toThrow('identity_mismatch')
})

test('an existing account without the gateway marker is never adopted', async () => {
  const f = await fixture('foreign')
  await expect(installHostAssets(D1, f.opts)).rejects.toThrow('identity_mismatch')
  expect(f.calls.some((c) => c[1] === 'enable')).toBe(false)
  const ours = await fixture('ours')
  await installHostAssets(D1, ours.opts)
  expect(ours.calls.some((c) => c[0] === '/usr/sbin/useradd')).toBe(false)
})
