import { expect, test } from 'bun:test'
import { renderVaultUnits, renderAggregateUnit, renderGatewayUnit, renderControlLauncher } from './units'
import { planVaultStorage } from './storage'

const id = '11111111-1111-4111-8111-111111111111'
const reservation = planVaultStorage({
  vaultId: id,
  existing: [],
  policy: { maxVaults: 2, perVaultDiskBytes: 512 * 1024 ** 2, minCoreFreeDiskBytes: 2 * 1024 ** 3 },
  freeDiskBytes: 6 * 1024 ** 3,
})
const artifactDigest = `sha256:${'a'.repeat(64)}`
const input = { reservation, artifactDigest, origin: `https://bb-${id.replaceAll('-', '')}.example.com` }

test('renders shipped hardened service with private identity, filesystem and bounded restart/egress/logs', async () => {
  const units = await renderVaultUnits(input)
  expect(units.service).toContain(`User=${reservation.username}`)
  // Unix socket only: no IP families at all, no port, root-prepared socket directory.
  expect(units.service).toContain('RestrictAddressFamilies=AF_UNIX\n')
  expect(units.service).not.toContain('SocketBindAllow')
  expect(units.service).not.toMatch(/--port|--host/)
  expect(units.service).toContain(`--socket /run/ficus-bigbrain/vaults/${id}/http.sock`)
  expect(units.service).toContain(`ReadWritePaths=-/run/ficus-bigbrain/vaults/${id}\n`)
  expect(units.service).toMatch(/^ExecStartPre=\/usr\/bin\/env -i .* sandbox [0-9a-f-]{36}$/m)
  expect(units.service).toContain('SocketBindDeny=any')
  expect(units.service).toContain(`BindsTo=${units.mountUnitName}`)
  expect(units.service).toContain(
    `ExecStartPre=+/usr/bin/nsenter --mount=/proc/1/ns/mnt -- /usr/local/bin/bun --no-install --no-env-file /opt/ficus-bigbrain/releases/${'a'.repeat(64)}/ficus-bigbrain-host.js preflight ${id}`
  )
  expect(units.service).not.toContain('libexec')
  // Font assets resolve relative to the immutable release directory, never a writable cwd.
  expect(units.service).toContain(`WorkingDirectory=/opt/ficus-bigbrain/releases/${'a'.repeat(64)}\n`)
  expect(units.service).toMatch(
    /^ExecStart=.* \/usr\/local\/bin\/bun --no-install --no-env-file \S+\/bigbrain-serve\.js --vault /m
  )
  for (const setting of [
    'NoNewPrivileges=yes',
    'PrivateMounts=yes',
    'TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=16M,mode=1777',
    'TemporaryFileSystem=/var/tmp:rw,nosuid,nodev,noexec,size=16M,mode=1777',
    'PrivateDevices=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'ProtectProc=invisible',
    'ProtectControlGroups=yes',
    'CapabilityBoundingSet=',
    'UMask=0077',
    'IPAddressDeny=any',
    'MemoryMax=268435456',
    'TasksMax=64',
    'StandardOutput=null',
    'StandardError=null',
    'Slice=ficus-bigbrain.slice',
    'Restart=on-failure',
    'StartLimitBurst=3',
  ])
    expect(units.service).toContain(setting)
  expect(units.service).toContain('TemporaryFileSystem=/var/lib/ficus-bigbrain:ro')
  expect(units.service).toContain(`BindPaths=${reservation.mount}`)
  expect(units.service).toContain('/usr/bin/env -i HOME=/nonexistent PATH=/usr/bin:/bin LANG=C.UTF-8')
  expect(units.service).not.toContain('EnvironmentFile')
  expect(units.service).not.toContain('{{')
  expect(units.mount).toContain(`What=${reservation.image}`)
  expect(units.mount).toContain('Options=loop,rw,nodev,nosuid,noexec')
  expect(units.mount).toContain('Type=ext4')
})
test('aggregate cgroup includes gateway and caps combined CPU/memory; gateway cannot access private controls', async () => {
  const aggregate = await renderAggregateUnit()
  expect(aggregate).toContain('CPUQuota=50%')
  expect(aggregate).toContain('MemoryMax=671088640')
  expect(aggregate).toContain('MemoryHigh=536870912')
  const gateway = await renderGatewayUnit(artifactDigest)
  expect(gateway).toContain('Slice=ficus-bigbrain.slice')
  expect(gateway).toContain('TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=16M,mode=1777')
  expect(gateway).toContain('TemporaryFileSystem=/var/tmp:rw,nosuid,nodev,noexec,size=16M,mode=1777')
  expect(gateway).toContain('User=ficus-bb-gateway')
  expect(gateway).toContain(
    `ExecStartPre=+/usr/local/bin/bun --no-install --no-env-file /opt/ficus-bigbrain/releases/${'a'.repeat(64)}/ficus-bigbrain-host.js preflight gateway`
  )
  expect(gateway).toMatch(
    /ExecStart=.*\/usr\/local\/bin\/bun --no-install --no-env-file \S+\/ficus-bigbrain-host\.js gateway$/m
  )
  expect(gateway).toContain('RestrictAddressFamilies=AF_UNIX\n')
  expect(gateway).not.toContain('SocketBindAllow')
  expect(gateway).toContain('ReadWritePaths=-/run/ficus-bigbrain/gateway\n')
  expect(gateway).toMatch(/^ExecStartPre=\/usr\/bin\/env -i .* sandbox gateway$/m)
  expect(gateway).toContain('SocketBindDeny=any')
  expect(gateway).toContain('InaccessiblePaths=-/var/lib/ficus-bigbrain')
  // Binding a file pins its old inode: atomic route updates would never be visible.
  expect(gateway).toContain('BindReadOnlyPaths=/etc/ficus/bigbrain/public\n')
  expect(gateway).not.toContain('BindReadOnlyPaths=/etc/ficus/bigbrain/public/routes.json')
  expect(gateway).not.toContain('{{')
})
test('fixed root launcher serializes across SSH interruption and bounds every descendant in a transient unit', async () => {
  const launcher = await renderControlLauncher(artifactDigest)
  expect(launcher).toStartWith('#!/bin/bash -p')
  for (const setting of [
    'flock --nonblock',
    'ficus-bigbrain-control.service',
    '--wait',
    '--pipe',
    '--collect',
    'RuntimeMaxSec=180',
    'KillMode=control-group',
    'OOMPolicy=kill',
    'MemoryMax=134217728',
    'MemorySwapMax=0',
    'CPUQuota=50%',
    'Slice=ficus-bigbrain.slice',
    'TasksMax=64',
    'NoNewPrivileges=yes',
    'SocketBindDeny=any',
    'PrivateMounts=yes',
    'TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=16M,mode=1777 /var/tmp:rw,nosuid,nodev,noexec,size=16M,mode=1777',
    'ProtectSystem=strict',
    'ReadWritePaths=/etc /var/lib/ficus-bigbrain -/run/ficus-bigbrain',
    '/usr/bin/env -i',
    '/usr/local/bin/bun --no-install --no-env-file',
    '/ficus-bigbrain-host.js control',
    'head -c 8193',
    'code:"busy"',
  ])
    expect(launcher).toContain(setting)
  expect(launcher).not.toContain('$@')
  const child = Bun.spawn(['/bin/bash', '-n'], { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' })
  child.stdin.write(launcher)
  child.stdin.end()
  expect(await child.exited).toBe(0)
  await new Response(child.stderr).text()
})

test('rejects unit specifier/newline injection, foreign vault origins, tampered account/path/port and digest', async () => {
  for (const bad of [
    { ...input, origin: 'https://evil.example.com' },
    { ...input, artifactDigest: 'sha256:' + '%n'.repeat(32) },
    { ...input, reservation: { ...reservation, username: 'root' } },
    { ...input, reservation: { ...reservation, mount: '/etc\nUser=root' } },
  ])
    await expect(renderVaultUnits(bad)).rejects.toThrow('invalid_request')
})

// Only internal fixture mapping; the external helper request schema has no path field.
test('fixture namespace is explicit and remains bound to its own recorded reservation', async () => {
  const root = '/tmp/ficus-bigbrain-fixture'
  const mapped = { ...reservation, mount: `${root}/vaults/${id}`, image: `${root}/volumes/${id}.img` }
  await expect(renderVaultUnits({ ...input, reservation: mapped })).rejects.toThrow('invalid_request')
  const units = await renderVaultUnits({ ...input, reservation: mapped, root })
  expect(units.mount).toContain(`Where=${mapped.mount}`)
  await expect(renderVaultUnits({ ...input, reservation: mapped, root: '/tmp/other' })).rejects.toThrow(
    'invalid_request'
  )
})

const HARDENING = [
  'PrivateNetwork=yes',
  'PrivateIPC=yes',
  'RemoveIPC=yes',
  'RestrictNamespaces=yes',
  'SystemCallArchitectures=native',
  'SystemCallFilter=@system-service',
  'SystemCallFilter=~@privileged @resources',
  'SystemCallErrorNumber=EPERM',
  'ProtectClock=yes',
  'ProtectHostname=yes',
]
test('vault and gateway units get private network/IPC namespaces, a syscall filter and clock/hostname protection', async () => {
  const units = await renderVaultUnits(input)
  const gateway = await renderGatewayUnit(artifactDigest)
  for (const line of HARDENING) {
    expect(units.service).toContain(`\n${line}\n`)
    expect(gateway).toContain(`\n${line}\n`)
  }
})
