import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CADDY_CLIENT_DROPIN, coreAccountGid, installHostAssets, GATEWAY_ACCOUNT } from './host-assets'
import { validatePrivateCommand, type PrivateCommandRunner } from './process'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const D1 = `sha256:${'a'.repeat(64)}`
const D2 = `sha256:${'b'.repeat(64)}`

const CLIENT_GID = '991'

async function fixture(account: 'absent' | 'ours' | 'foreign' = 'absent', caddy: 'running' | 'stopped' = 'stopped') {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-assets-'))
  roots.push(outer)
  const etc = join(outer, 'etc')
  await mkdir(etc, { mode: 0o700 })
  const proc = join(outer, 'proc')
  const calls: string[][] = []
  const serving: string[] = []
  let exists = account !== 'absent'
  let clientGroup = false
  // A simulated Caddy: its MainPID and the supplementary groups /proc reports for it.
  const state = { pid: caddy === 'running' ? 4100 : 0, restartFails: false, restartKeepsGroups: false }
  const writeStatus = async (groups: string) => {
    await mkdir(join(proc, String(state.pid)), { recursive: true })
    await writeFile(join(proc, String(state.pid), 'status'), `Name:\tcaddy\nGroups:\t${groups}\n`)
  }
  if (state.pid) await writeStatus('998')
  const run: PrivateCommandRunner = async (argv, options) => {
    // The real runner's argument policy, so no caller can pass something it would refuse.
    validatePrivateCommand(argv, options)
    calls.push(argv)
    if (argv[0] === '/usr/bin/getent' && argv[1] === 'passwd') {
      if (!exists) return { code: 2, stdout: '' }
      const comment = account === 'foreign' ? 'Someone else' : 'Ficus managed BigBrain gateway'
      return { code: 0, stdout: `${GATEWAY_ACCOUNT}:x:990:990:${comment}:/nonexistent:/usr/sbin/nologin\n` }
    }
    if (argv[0] === '/usr/bin/getent' && argv[1] === 'group') {
      if (argv[2] === 'ficus-bigbrain-client' && clientGroup)
        return { code: 0, stdout: `ficus-bigbrain-client:x:${CLIENT_GID}:\n` }
      return { code: 2, stdout: '' }
    }
    if (argv[0] === '/usr/sbin/groupadd') clientGroup = true
    if (argv[0] === '/usr/sbin/useradd') exists = true
    if (argv.join(' ') === '/usr/bin/systemctl show -p MainPID --value caddy.service')
      return { code: 0, stdout: `${state.pid}\n` }
    if (argv.join(' ') === '/usr/bin/systemctl try-restart caddy.service') {
      if (state.restartFails) return { code: 1, stdout: '' }
      if (state.pid) {
        state.pid++
        await writeStatus(state.restartKeepsGroups ? '998' : `998 ${CLIENT_GID}`)
      }
    }
    return { code: 0, stdout: '' }
  }
  const opts = {
    etc,
    uid,
    run,
    unitDirectory: join(outer, 'units'),
    launcher: join(outer, 'libexec', 'ficus-bigbrainctl'),
    tmpfilesDirectory: join(outer, 'tmpfiles.d'),
    procDirectory: proc,
    gatewayServing: async () => void serving.push(String(calls.length)),
  }
  return { outer, opts, calls, serving, state }
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
    'd /run/ficus-bigbrain/gateway 2750 ficus-bb-gateway ficus-bigbrain-client -'
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

test('the gateway client group: created once, the Core account joins it, a running Caddy without it restarts once', async () => {
  const f = await fixture('absent', 'running')
  await installHostAssets(D1, { ...f.opts, coreAccount: 'ficus' })
  expect(f.calls).toContainEqual(['/usr/sbin/groupadd', '--system', 'ficus-bigbrain-client'])
  expect(f.calls).toContainEqual(['/usr/sbin/usermod', '-aG', 'ficus-bigbrain-client', 'ficus'])
  const dropIn = join(f.opts.unitDirectory, 'caddy.service.d', 'ficus-bigbrain-client.conf')
  expect(await readFile(dropIn, 'utf8')).toBe(CADDY_CLIENT_DROPIN)
  expect(CADDY_CLIENT_DROPIN).toContain('SupplementaryGroups=ficus-bigbrain-client')
  // A running Caddy picks the group up only by restarting: after the daemon-reload, before the gateway.
  const order = f.calls.map((c) => c.slice(0, 3).join(' '))
  const restart = order.indexOf('/usr/bin/systemctl try-restart caddy.service')
  expect(restart).toBeGreaterThan(order.indexOf('/usr/bin/systemctl daemon-reload'))
  expect(restart).toBeLessThan(order.indexOf('/usr/bin/systemctl restart ficus-bigbrain-gateway.service'))
  // The next install finds Caddy already in the group: it is not restarted again.
  const before = f.calls.length
  await installHostAssets(D2, f.opts)
  expect(f.calls.slice(before).some((c) => c[1] === 'try-restart')).toBe(false)
  // A root Core is never added; an invalid account name is refused before any change.
  expect(f.calls.slice(before).some((c) => c[0] === '/usr/sbin/usermod')).toBe(false)
  const g = await fixture()
  await expect(installHostAssets(D1, { ...g.opts, coreAccount: '../x' })).rejects.toThrow('invalid_request')
})

test('a stopped or absent Caddy is never restarted: the drop-in applies when it starts', async () => {
  const f = await fixture('absent', 'stopped')
  await installHostAssets(D1, f.opts)
  expect(f.calls.some((c) => c[1] === 'try-restart')).toBe(false)
})

test('a failed Caddy restart fails the install, and the next install restarts it (the drop-in is already there)', async () => {
  const f = await fixture('absent', 'running')
  f.state.restartFails = true
  await expect(installHostAssets(D1, f.opts)).rejects.toThrow('operation_failed')
  expect(f.serving).toHaveLength(0)
  f.state.restartFails = false
  const before = f.calls.length
  await installHostAssets(D1, f.opts)
  expect(f.calls.slice(before)).toContainEqual(['/usr/bin/systemctl', 'try-restart', 'caddy.service'])
  expect(f.serving).toHaveLength(1)
})

test('a restarted Caddy that still lacks the group fails the install', async () => {
  const f = await fixture('absent', 'running')
  f.state.restartKeepsGroups = true
  await expect(installHostAssets(D1, f.opts)).rejects.toThrow('operation_failed')
})

test('every command the installer runs passes the real runner policy (a 60 s timeout would be refused)', async () => {
  expect(() =>
    validatePrivateCommand(['/usr/bin/systemctl', 'try-restart', 'caddy.service'], { timeoutMs: 60000 })
  ).toThrow('invalid_request')
  const f = await fixture('absent', 'running')
  await installHostAssets(D1, { ...f.opts, coreAccount: 'ficus' })
  expect(f.calls.length).toBeGreaterThan(5) // each went through validatePrivateCommand in the fixture runner
})

test('the Core account resolves to its primary gid; root, unknown or odd records are refused', async () => {
  const passwd =
    (line: string, code = 0) =>
    async () => ({ code, stdout: `${line}\n` })
  expect(await coreAccountGid(passwd('ficus:x:998:997::/home/ficus:/usr/sbin/nologin'), 'ficus')).toBe(997)
  await expect(coreAccountGid(passwd('', 2), 'ficus')).rejects.toThrow('invalid_request')
  await expect(coreAccountGid(passwd('root:x:0:0::/root:/bin/bash'), 'root')).rejects.toThrow('invalid_request')
  await expect(coreAccountGid(passwd('ficus:x:998:0::/home/ficus:/bin/sh'), 'ficus')).rejects.toThrow(
    'identity_mismatch'
  )
  await expect(coreAccountGid(passwd('other:x:998:997::/home/o:/bin/sh'), 'ficus')).rejects.toThrow('identity_mismatch')
})
