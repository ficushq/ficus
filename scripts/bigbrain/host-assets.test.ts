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
  }
  return { outer, opts, calls }
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
  expect(f.calls.at(-1)).toEqual(['/usr/bin/systemctl', 'enable', '--now', 'ficus-bigbrain-gateway.service'])
  // Upgrade to a new release replaces exactly the recorded files; the account is not recreated.
  await installHostAssets(D2, f.opts)
  expect(await readFile(f.opts.launcher, 'utf8')).toContain('b'.repeat(64))
  expect(f.calls.filter((c) => c[0] === '/usr/sbin/useradd')).toHaveLength(1)
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
