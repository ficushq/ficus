#!/usr/bin/env bun
/**
 * Disposable-runner acceptance for managed BigBrain containment. Runs as ROOT on a throwaway CI
 * VM only (never a shared or production host): real install through the setup-toolkit hook, real
 * helper launcher, real accounts/loop mounts/systemd units/cgroups, and attacks executed from
 * inside vault A's own mount namespace, cgroup and UID.
 *
 * Usage (CI): sudo /usr/local/bin/bun scripts/bigbrain/linux-acceptance.ts <release-dir> <previous-release-dir> <native-deps>
 * where <release-dir>/bigbrain is the built runtime artifact, <previous-release-dir>/bigbrain an
 * older released runtime the host is first installed with (the upgrade regression), and
 * <native-deps> the pinned upstream source with its locked dependencies (prepare-native-smoke).
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  managedBigbrainVaultOrigin,
} from '@ficus/shared/managed-bigbrain'

const [release, previousRelease, nativeDeps] = process.argv.slice(2)
if (!release || !previousRelease || !nativeDeps || process.getuid?.() !== 0 || process.platform !== 'linux') {
  console.error(
    'usage: sudo bun scripts/bigbrain/linux-acceptance.ts <release-dir> <previous-release-dir> <native-deps> (Linux, root, disposable VM only)'
  )
  process.exit(64)
}
const results: { check: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string) {
  results.push({ check: name, ok, ...(detail ? { detail } : {}) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
function sh(argv: string[], input?: string) {
  const proc = Bun.spawnSync(argv, {
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}
function must(argv: string[], input?: string) {
  const result = sh(argv, input)
  if (result.code !== 0)
    throw new Error(`${argv[0]} ${argv[1] ?? ''} failed (${result.code}): ${result.stderr.slice(0, 400)}`)
  return result.stdout
}

const TENANT = randomUUID()
const BINDING = randomUUID()
/** The rebuilt machine in the disaster-recovery scenario gets a new physical host binding. */
const REBUILT_BINDING = randomUUID()
let binding = BINDING
const ZONE = 'bigbrain.example.test'
const OWNER = { userId: randomUUID(), handle: 'ada', display: 'Ada' }
const A = randomUUID()
const B = randomUUID()
const hex = (id: string) => id.replaceAll('-', '')
const TENANT_LABEL = 'acme'
const config = {
  enabled: true,
  tenantId: TENANT,
  physicalHostBinding: BINDING,
  hostEpoch: 1,
  zone: ZONE,
  tenantLabel: TENANT_LABEL,
}
/** Both hostname forms are exercised end to end: A is a new tenant-prefixed vault
 * (acme-bb-<12 hex>), B keeps the bb-<32 hex> form an existing vault has. */
const ORIGINS: Record<string, string> = {
  [A]: managedBigbrainVaultOrigin({ vaultId: A, zone: ZONE, tenantLabel: TENANT_LABEL }),
  [B]: managedBigbrainVaultOrigin({ vaultId: B, zone: ZONE, tenantLabel: null }),
}
const originOf = (vaultId: string) => ORIGINS[vaultId] ?? `https://bb-${hex(vaultId)}.${ZONE}`
let epoch = 1

function helper(fields: Record<string, unknown>) {
  const request = {
    contractVersion: 1,
    tenantId: TENANT,
    physicalHostBinding: binding,
    hostEpoch: epoch,
    requestId: randomUUID(),
    ...fields,
  }
  const out = sh(['/usr/local/libexec/ficus-bigbrainctl'], JSON.stringify(request))
  try {
    const reply = JSON.parse(out.stdout.trim().split('\n').at(-1) ?? 'null') as Record<string, any>
    // Control's own fixed stage tokens and command trail (no secrets) explain a refusal.
    if (reply?.ok === false)
      reply.stderr = [
        out.stderr.trim().split('\n').slice(-3).join(' | '),
        sh(['/bin/cat', '/var/lib/ficus-bigbrain/control/last-failure']).stdout.trim(),
      ].join(' || ')
    return reply
  } catch {
    return { ok: false, code: 'unparseable', raw: out.stdout.slice(0, 200), stderr: out.stderr.slice(0, 400) }
  }
}
const create = (vaultId: string, name: string, origin = originOf(vaultId)) =>
  helper({
    action: 'create',
    vaultId,
    expectedGeneration: 0,
    generation: 1,
    displayName: name,
    owner: OWNER,
    origin,
    limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
    upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
    artifactDigest: host().artifactDigest,
  })
function host() {
  return JSON.parse(readFileSync('/etc/ficus/bigbrain/host.json', 'utf8')) as {
    artifactDigest: string
    hostEpoch: number
  }
}
function unitProperty(unit: string, property: string) {
  return must(['/usr/bin/systemctl', 'show', '--property', property, '--value', unit]).trim()
}
function receipt(vaultId: string) {
  return JSON.parse(readFileSync(`/var/lib/ficus-bigbrain/control/${vaultId}/receipt.json`, 'utf8'))
}
/** After a restart the service needs a moment: poll a gateway status briefly, never assume. */
async function eventually(read: () => Promise<number>, want: number, attempts = 30): Promise<number> {
  let status = 0
  for (let i = 0; i < attempts; i++) {
    status = await read().catch(() => 0)
    if (status === want) return status
    await Bun.sleep(500)
  }
  return status
}
const GATEWAY_SOCKET = '/run/ficus-bigbrain/gateway/http.sock'
/** Production path minus Caddy/TLS: the gateway's Unix socket, routed by Host. */
async function gateway(vaultId: string, path: string, token?: string, init: RequestInit = {}) {
  return fetch(`http://${new URL(originOf(vaultId)).host}${path}`, {
    ...init,
    unix: GATEWAY_SOCKET,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    redirect: 'manual',
  })
}

/** Production path WITH Caddy/TLS: HTTPS to 127.0.0.1:443 under the vault's host name, through the
 * Caddy service and its imported vault site. Never sends a credential. */
function viaCaddy(vaultId: string, path: string, method: 'GET' | 'POST') {
  const host = new URL(originOf(vaultId)).host
  const out = sh([
    '/usr/bin/curl',
    '-sk',
    '--max-time',
    '10',
    '--resolve',
    `${host}:443:127.0.0.1`,
    '-X',
    method,
    '-o',
    '/dev/null',
    '-D',
    '-',
    '-w',
    '\n%{http_code} %{size_download}',
    `https://${host}${path}`,
  ]).stdout
  const [status, bytes] = (out.trim().split('\n').pop() ?? '').split(' ').map(Number)
  const protocol = /^bigbrain-protocol:\s*(\S+)/im.exec(out)?.[1]
  return { status: status ?? 0, bytes: bytes ?? 0, protocol }
}

/** Run a script AS a compromised vault: a transient clone of that vault's real unit file (same
 * User/Group, seccomp address families, capability set, mount namespace and read/write paths,
 * same slice) whose only change is ExecStart; output goes to a root-only file. */
function asVault(vaultId: string, script: string): Record<string, string> {
  const source = readFileSync(`/etc/systemd/system/ficus-bigbrain@${vaultId}.service`, 'utf8')
  const name = `ficus-bigbrain-attack-${hex(vaultId).slice(0, 12)}`
  const scriptPath = `/opt/ficus-bigbrain/${name}.js`
  const outPath = `/run/${name}.json`
  writeFileSync(scriptPath, script, { mode: 0o644 })
  const lines = source
    .split('\n')
    .filter(
      (line) => !line.startsWith('ExecStartPre=') && !line.startsWith('Restart=') && !line.startsWith('StandardOutput=')
    )
    .map((line) =>
      line.startsWith('Type=')
        ? 'Type=oneshot'
        : line.startsWith('ExecStart=')
          ? `ExecStart=/usr/local/bin/bun --no-install --no-env-file ${scriptPath}`
          : line.startsWith('Description=')
            ? 'Description=containment attack clone'
            : line
    )
  const unit = lines.join('\n').replace('[Service]', `[Service]\nStandardOutput=file:${outPath}`)
  writeFileSync(`/etc/systemd/system/${name}.service`, unit, { mode: 0o644 })
  must(['/usr/bin/systemctl', 'daemon-reload'])
  sh(['/usr/bin/systemctl', 'start', `${name}.service`])
  const out = sh(['/bin/cat', outPath]).stdout
  sh(['/bin/rm', '-f', `/etc/systemd/system/${name}.service`, scriptPath, outPath])
  must(['/usr/bin/systemctl', 'daemon-reload'])
  try {
    return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as Record<string, string>
  } catch {
    return { error: out.slice(0, 300) }
  }
}
const ATTACK_PRELUDE = `
  const net = require('node:net'); const dgram = require('node:dgram'); const fs = require('node:fs');
  const errName = (e) => e?.code ?? ('NOCODE_' + String(e?.errno ?? e?.name ?? 'unknown')).slice(0, 40);
  const listenTcp = (host) => new Promise((resolve) => { try { const s = net.createServer(); s.once('error', (e) => resolve(errName(e))); s.listen(0, host, () => { s.close(); resolve('BOUND') }) } catch (e) { resolve(errName(e)) } });
  // Kernel truth independent of the runtime's error mapping: socket(2) itself, errno via libc.
  const ffi = require('bun:ffi');
  const libc = ffi.dlopen('libc.so.6', { socket: { args: ['i32', 'i32', 'i32'], returns: 'i32' }, close: { args: ['i32'], returns: 'i32' }, __errno_location: { args: [], returns: 'ptr' } });
  const rawSocket = (family, type) => { const fd = libc.symbols.socket(family, type, 0); if (fd >= 0) { libc.symbols.close(fd); return 'OPENED' } const errno = ffi.read.i32(libc.symbols.__errno_location(), 0); return errno === 97 ? 'EAFNOSUPPORT' : errno === 1 ? 'EPERM' : 'ERRNO_' + errno };
  const listenUdp = () => new Promise((resolve) => { try { const s = dgram.createSocket('udp4'); s.once('error', (e) => resolve(e.code)); s.bind(0, '127.0.0.1', () => { s.close(); resolve('BOUND') }) } catch (e) { resolve(e.code ?? 'THROWN') } });
  const listenUnix = (path) => new Promise((resolve) => { try { const s = net.createServer(); s.once('error', (e) => resolve(e.code)); s.listen(path, () => { s.close(); resolve('BOUND') }) } catch (e) { resolve(e.code ?? 'THROWN') } });
  const connectUnix = (path) => new Promise((resolve) => { const c = net.connect(path); c.once('error', (e) => resolve(e.code)); c.once('connect', () => { c.destroy(); resolve('CONNECTED') }) });
  const read = (p) => { try { fs.readFileSync(p); return 'READ' } catch (e) { return e.code } };
  const list = (p) => { try { fs.readdirSync(p); return 'LISTED' } catch (e) { return e.code } };
  const write = (p) => { try { fs.writeFileSync(p, 'x'); return 'WROTE' } catch (e) { return e.code } };
  const unshare = () => { try { const r = require('node:child_process').spawnSync('/usr/bin/unshare', ['-r', '-n', '/bin/true']); return r.status === 0 ? 'UNSHARED' : 'REFUSED_' + String(r.status ?? r.error?.code ?? 'signal') } catch (e) { return 'REFUSED_' + errName(e) } };
  const interfaces = () => { try { return fs.readFileSync('/proc/self/net/dev', 'utf8').split('\\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean).join(',') } catch (e) { return e.code } };
`
const HOST_ABSTRACT = 'ficus-bigbrain-acceptance-host-probe'

try {
  // ---------------------------------------------------------------- prerequisites, named
  const { probeSupportedHost } = await import('./install')
  const { verifyHostBun } = await import('./host-bun')
  const { verifyBigbrainArtifact } = await import('./artifact')
  const provenance = await verifyBigbrainArtifact(`${release}/bigbrain`).catch((e) => {
    check('artifact verifies', false, String(e?.message))
    throw e
  })
  check('artifact verifies', true, provenance.digest)
  await probeSupportedHost().then(
    () => check('host support probe', true),
    (e) => check('host support probe', false, String(e?.message))
  )
  const chain = ['/usr/local/bin/bun', '/usr/local/bin', '/usr/local', '/usr', '/']
    .map((p) => sh(['/usr/bin/stat', '-L', '-c', '%U:%G:%a %n', p]).stdout.trim())
    .join('; ')
  await verifyHostBun(provenance.bunVersion).then(
    () => check('host Bun verified', true, chain),
    (e) =>
      check(
        'host Bun verified',
        false,
        `${String(e?.message)}; ${chain}; version=${sh(['/usr/local/bin/bun', '--version']).stdout.trim()}`
      )
  )

  // ---------------------------------------------------------------- install through the toolkit
  // Upgrade regression (the tenant-prefixed outage): the host is first installed with an OLDER
  // released runtime whose gateway accepts only bb-<32 hex> origins, and that gateway is RUNNING
  // when the current release is installed over it, exactly like an upgrade of a live host. The
  // old installer predates tenant labels, so its config has none.
  const toolkitInstall = (dir: string, input: object) =>
    must([
      '/bin/bash',
      '-c',
      `set -euo pipefail; source scripts/setup/lib.sh; bigbrain_install "$1" "$2"`,
      'install',
      dir,
      JSON.stringify(input),
    ])
  const { tenantLabel: _label, ...previousConfig } = config
  toolkitInstall(previousRelease, previousConfig)
  // The old installer verified its own artifact and recorded its digest.
  const previousDigest = host().artifactDigest
  const gatewayPid = () => unitProperty('ficus-bigbrain-gateway.service', 'MainPID')
  const gatewayArgv = () =>
    sh(['/bin/cat', `/proc/${gatewayPid()}/cmdline`])
      .stdout.split('\0')
      .filter((part) => part !== '')
  const scriptOf = (digest: string) => `/opt/ficus-bigbrain/releases/${digest.slice(7)}/ficus-bigbrain-host.js`
  // The old installer returns right after `enable --now` (Type=simple): give its gateway a moment
  // to exec before reading what it runs.
  for (let i = 0; i < 30 && !gatewayArgv().includes(scriptOf(previousDigest)); i++) await Bun.sleep(500)
  const oldPid = gatewayPid()
  check(
    'the previous release is installed and its gateway runs',
    previousDigest !== provenance.digest &&
      unitProperty('ficus-bigbrain-gateway.service', 'ActiveState') === 'active' &&
      gatewayArgv().includes(scriptOf(previousDigest)),
    `${previousDigest.slice(7, 19)} pid=${oldPid} argv=${gatewayArgv()
      .map((a) => a.replace(/^\/opt\/ficus-bigbrain\/releases\/([0-9a-f]{12})[0-9a-f]+/, '<release $1>'))
      .join(' ')
      .slice(0, 200)}`
  )
  toolkitInstall(release, config)
  check('toolkit install created the host record', host().hostEpoch === 1)
  check(
    'upgrade replaced the running gateway with the installed release (not just its unit file)',
    host().artifactDigest === provenance.digest &&
      gatewayPid() !== oldPid &&
      gatewayArgv().includes(scriptOf(provenance.digest)),
    `pid ${oldPid} -> ${gatewayPid()}`
  )
  const launcher = sh(['/usr/bin/stat', '-c', '%U:%G:%a', '/usr/local/libexec/ficus-bigbrainctl']).stdout.trim()
  check('launcher is root-only (root:root 750)', launcher === 'root:root:750', launcher)
  const reason = (target: string) =>
    [
      sh(['/bin/cat', `/run/ficus-bigbrain/preflight-${target}.reason`]).stdout.trim(),
      sh([
        '/bin/cat',
        target === 'gateway'
          ? '/run/ficus-bigbrain/gateway/sandbox.reason'
          : `/run/ficus-bigbrain/vaults/${target}/sandbox.reason`,
      ]).stdout.trim(),
      target === 'gateway' ? sh(['/bin/cat', '/run/ficus-bigbrain/gateway/start.reason']).stdout.trim() : '',
      unitProperty(
        target === 'gateway' ? 'ficus-bigbrain-gateway.service' : `ficus-bigbrain@${target}.service`,
        'Result'
      ),
    ].join(' | ')
  check(
    'gateway service active',
    unitProperty('ficus-bigbrain-gateway.service', 'ActiveState') === 'active',
    reason('gateway')
  )

  const probe = helper({ action: 'probe' })
  check(
    'probe reports available',
    probe.ok === true && probe.capabilities?.available === true,
    JSON.stringify(probe.capabilities?.reasonCode ?? [probe.code, probe.stderr])
  )

  // ---------------------------------------------------------------- two vaults
  const a = create(A, 'Alpha')
  check(
    'create A ready',
    a.ok === true && a.receipt?.state === 'ready',
    JSON.stringify(a.ok ? a.receipt?.state : [a.code, a.stderr, reason(A)])
  )
  const b = create(B, 'Beta')
  check(
    'create B ready',
    b.ok === true && b.receipt?.state === 'ready',
    JSON.stringify(b.ok ? b.receipt?.state : [b.code, b.stderr, reason(B)])
  )
  const rA = receipt(A)
  const rB = receipt(B)
  check(
    'A has the tenant-prefixed origin, B the bb-<32 hex> origin',
    rA.receipt.origin === `https://${TENANT_LABEL}-bb-${hex(A).slice(0, 12)}.${ZONE}` &&
      rB.receipt.origin === `https://bb-${hex(B)}.${ZONE}`,
    JSON.stringify([rA.receipt.origin, rB.receipt.origin])
  )
  check('probe reports the installed tenant label', probe.capabilities?.tenantLabel === TENANT_LABEL)
  const foreign = randomUUID()
  const spoofed = create(foreign, 'Spoofed', `https://other-bb-${hex(foreign).slice(0, 12)}.${ZONE}`)
  check(
    "create with another tenant's label is refused before anything exists",
    spoofed.ok === false &&
      spoofed.code === 'identity_mismatch' &&
      !existsSync(`/var/lib/ficus-bigbrain/control/${foreign}`),
    JSON.stringify([spoofed.code])
  )
  // Same 12-hex short id as A: the host itself refuses a second vault behind A's hostname.
  const twin = `${A.slice(0, 13)}-4999-8999-999999999999`
  const doubled = create(twin, 'Twin', ORIGINS[A]!)
  check(
    "create of another vault behind A's hostname is refused before anything exists",
    doubled.ok === false &&
      doubled.code === 'identity_mismatch' &&
      !existsSync(`/var/lib/ficus-bigbrain/control/${twin}`),
    JSON.stringify([doubled.code])
  )
  check('vaults have distinct non-root UIDs', rA.os.uid !== rB.os.uid && rA.os.uid > 0 && rB.os.uid > 0)
  const mountA = sh(['/usr/bin/findmnt', '-n', '-o', 'FSTYPE,OPTIONS', rA.storage.mount]).stdout.trim()
  check(
    'A is a separate ext4 loop mount with nodev,nosuid,noexec',
    /^ext4 .*nosuid.*nodev.*noexec|^ext4 .*nodev.*nosuid.*noexec/.test(mountA) ||
      (mountA.startsWith('ext4') && ['nodev', 'nosuid', 'noexec'].every((o) => mountA.includes(o))),
    mountA
  )

  // cgroup limits actually in force (kernel values, not unit text)
  const cgA = unitProperty(`ficus-bigbrain@${A}.service`, 'ControlGroup')
  const memA = readFileSync(`/sys/fs/cgroup${cgA}/memory.max`, 'utf8').trim()
  check(
    'vault memory.max enforced by the kernel',
    memA === String(MANAGED_BIGBRAIN_DEFAULT_LIMITS.perVaultMemoryBytes),
    memA
  )
  // `ficus-bigbrain.slice` nests under `ficus.slice` (systemd dash hierarchy): use the real parent.
  const sliceDir = `/sys/fs/cgroup${cgA.slice(0, cgA.lastIndexOf('/'))}`
  const slice = readFileSync(`${sliceDir}/memory.max`, 'utf8').trim()
  check(
    'aggregate slice memory.max enforced',
    slice === String(MANAGED_BIGBRAIN_DEFAULT_LIMITS.aggregateMemoryBytes),
    slice
  )
  const cpu = readFileSync(`${sliceDir}/cpu.max`, 'utf8').trim()
  check('aggregate slice CPU quota enforced (50%)', cpu === '50000 100000', cpu)

  // scratch inside the RUNNING vault process
  const pidA = unitProperty(`ficus-bigbrain@${A}.service`, 'MainPID')
  const mounts = readFileSync(`/proc/${pidA}/mountinfo`, 'utf8').split('\n')
  for (const path of ['/tmp', '/var/tmp']) {
    const line = mounts.find((l) => l.split(' ')[4] === path) ?? ''
    check(
      `${path} in the running vault is bounded tmpfs (noexec,nosuid,nodev)`,
      / - tmpfs /.test(line) && /size=16384k/.test(line) && /noexec/.test(line),
      line.slice(0, 200)
    )
  }

  // ---------------------------------------------------------------- wire through the real gateway
  const handoffA = JSON.parse(readFileSync(`/var/lib/ficus-bigbrain/read-handoff/${A}.json`, 'utf8'))
  const handoffB = JSON.parse(readFileSync(`/var/lib/ficus-bigbrain/read-handoff/${B}.json`, 'utf8'))
  const who = await gateway(A, '/v1/whoami', handoffA.token)
  const actor = (await who.json().catch(() => ({}))) as Record<string, any>
  check(
    'Ficus read credential authenticates as read-only agent via gateway',
    who.status === 200 && actor.kind === 'agent' && JSON.stringify(actor.permissions) === '["read"]',
    `${who.status}`
  )
  const write = await gateway(A, '/v1/evidence', handoffA.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', body: 'y' }),
  })
  check('Ficus read credential cannot write (403)', write.status === 403, `${write.status}`)
  const cross = await gateway(A, '/v1/whoami', handoffB.token)
  check("B's credential is rejected by A (401)", cross.status === 401, `${cross.status}`)
  const unknown = await gateway(randomUUID(), '/v1/whoami', handoffA.token)
  check('unknown vault host never reaches a vault (404)', unknown.status === 404, `${unknown.status}`)

  // ---------------------------------------------------------------- the real public path: Caddy
  // Regression for owner device links failing with "null is not an object (evaluating
  // 'result.vault')": the sites were published where the caddy user could not read them, so real
  // Caddy (reloaded as caddy) answered every vault host with its empty 200 fallback. No credential.
  check(
    'the caddy user can read the published vault sites',
    sh(['/usr/sbin/runuser', '-u', 'caddy', '--', '/bin/ls', '/etc/ficus/bigbrain-caddy']).stdout.includes(`${A}.caddy`)
  )
  for (const [label, path, method] of [
    ['whoami', '/v1/whoami', 'GET'],
    ['invite redeem', '/v1/invites/redeem', 'POST'],
  ] as const) {
    const edge = viaCaddy(A, path, method)
    check(
      `real Caddy routes the vault host to the vault (${label}: 401 with the BigBrain protocol, not an empty 200)`,
      edge.status === 401 && edge.protocol === '1' && edge.bytes > 0,
      `${edge.status} protocol=${edge.protocol ?? 'none'} bytes=${edge.bytes}`
    )
  }

  // ---------------------------------------------------------------- probe proves the serving path
  // With ready vaults the probe checks the running gateway/vault releases and every route end to
  // end on this real host (procfs from the control unit, the real gateway socket).
  const serving = helper({ action: 'probe' })
  check(
    'probe with ready vaults reports available (running releases and every route verified)',
    serving.ok === true && serving.capabilities?.available === true,
    JSON.stringify(serving.capabilities?.reasonCode ?? [serving.code, serving.stderr])
  )

  // ---------------------------------------------------------------- owner device link, real client
  // A Ficus-created owner link for the tenant-prefixed vault, redeemed by the PINNED native client
  // (lib/sharedConnections.ts connectInvite) over HTTPS through real Caddy -> gateway -> vault. The
  // link secret travels only on the child's stdin and is never printed.
  const issuedAt = new Date(Date.now() - 5000)
  const ownerInvite = helper({
    action: 'owner-invite',
    vaultId: A,
    expectedGeneration: receipt(A).receipt.generation,
    actorUserId: OWNER.userId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS).toISOString(),
  })
  check(
    'owner-invite issues a link on the tenant-prefixed origin',
    ownerInvite.ok === true && String(ownerInvite.invite?.inviteUrl).startsWith(`${ORIGINS[A]}/invite#`),
    JSON.stringify(ownerInvite.ok ? 'issued' : [ownerInvite.code, ownerInvite.stderr])
  )
  // Disposable VM: the vault hostname resolves to this host's Caddy, as Cloudflare would route it.
  writeFileSync('/etc/hosts', `${readFileSync('/etc/hosts', 'utf8')}\n127.0.0.1 ${new URL(ORIGINS[A]!).hostname}\n`)
  // The PINNED native client in a child with a clean environment and its own HOME; links travel
  // only on its stdin. TLS is the runner's self-signed stand-in for the origin certificate; routing
  // is what is tested. `body` runs with `m` (lib/sharedConnections.ts), `path` (the connection
  // store), `input` (stdin) and `connect(link)`.
  //
  // The shipped gateway refuses bursts per vault (429 'busy', never forwarded) and these checks
  // run back to back. A join (upstream connectInvite) is TWO requests: the redeem, which spends
  // the single-use link and returns the new credential, then saveConnection's whoami. A refused
  // redeem spent nothing, so the child is run again. A refused whoami after a successful redeem
  // must never send the spent link again (that is the redeem's 401 "already used", which is how
  // this lane used to flake): `connect` finishes the join exactly as connectInvite does, with
  // upstream's own saveConnection and the credential the redeem returned, once the bucket refills.
  // Every request's method, path and status (never a header or body) is reported on failure.
  const nativeClientOnce = (home: string, body: string, input: string) => {
    const script = `(async () => {
      const trail = [];
      let redeemed = null;
      try {
        const m = await import(${JSON.stringify(`${nativeDeps}/lib/sharedConnections.ts`)});
        const path = ${JSON.stringify(`${home}/shared-connections.json`)};
        const input = (await Bun.stdin.text()).trim();
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          const at = new URL(String(url instanceof Request ? url.url : url)).pathname;
          const method = init?.method ?? (url instanceof Request ? url.method : 'GET');
          let response;
          try {
            response = await nativeFetch(url, init);
          } catch (e) {
            trail.push(method + ' ' + at + ' unreachable');
            throw e;
          }
          trail.push(method + ' ' + at + ' ' + response.status);
          if (at === '/v1/invites/redeem' && response.ok) redeemed = await response.clone().json();
          return response;
        };
        const connect = async (link) => {
          try {
            return await m.connectInvite(path, link);
          } catch (e) {
            if (redeemed === null || e?.status !== 429) throw e;
            const endpoint = m.endpointURL(new URL(link).origin);
            for (let attempt = 0; ; attempt++) {
              await Bun.sleep(2500);
              try {
                return await m.saveConnection(path, { name: redeemed.vault.name, endpoint, token: redeemed.token });
              } catch (again) {
                if (again?.status !== 429 || attempt >= 10) throw again;
              }
            }
          }
        };
        ${body}
      } catch (e) {
        console.log(JSON.stringify({ ok: false, status: e?.status ?? null, message: String(e?.message ?? e).slice(0, 120),
          spent: redeemed !== null, trail }));
      }
    })()`
    const out = sh(
      [
        '/usr/bin/env',
        '-i',
        `HOME=${home}`,
        'PATH=/usr/bin:/bin',
        'NODE_TLS_REJECT_UNAUTHORIZED=0',
        '/usr/local/bin/bun',
        '--no-install',
        '--no-env-file',
        '-e',
        script,
      ],
      input
    )
    try {
      return JSON.parse(out.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, any>
    } catch {
      return { ok: false, message: out.stderr.slice(0, 200) }
    }
  }
  /** Runs the child again only while the gateway refused a request before any link was spent. */
  const nativeClient = async (home: string, body: string, input = '') => {
    for (let attempt = 0; ; attempt++) {
      const result = nativeClientOnce(home, body, input)
      if (result.ok !== false || result.status !== 429 || result.spent === true || attempt >= 10) return result
      await Bun.sleep(2500)
    }
  }
  const clientHome = mkdtempSync('/tmp/bigbrain-native-client-')
  const redeem = await nativeClient(
    clientHome,
    `const saved = await connect(input);
     console.log(JSON.stringify({ ok: true, vault: saved.identity?.vault?.id ?? null, role: saved.identity?.role ?? null,
       permissions: saved.identity?.permissions ?? [], name: saved.name ?? null }));`,
    ownerInvite.ok ? String(ownerInvite.invite.inviteUrl) : ''
  )
  check(
    'the owner link redeems in the pinned native client through real Caddy and the gateway',
    redeem.ok === true &&
      redeem.vault === receipt(A).receipt.upstreamVaultId &&
      Array.isArray(redeem.permissions) &&
      redeem.permissions.includes('read'),
    JSON.stringify(redeem.ok ? { role: redeem.role, permissions: redeem.permissions } : redeem)
  )
  check(
    "the app names the connection after the vault's Ficus name (written at create), not upstream's default",
    redeem.ok === true && redeem.name === 'Alpha',
    JSON.stringify(redeem.ok ? redeem.name : null)
  )
  sh(['/bin/rm', '-rf', clientHome])

  // ---------------------------------------------------------------- members through Ficus, real client
  // A member invite created through the helper (shipped member adapter as the vault's UID, root
  // replay cache) is redeemed by the PINNED native client through real Caddy -> gateway -> vault as
  // a NEW member; the member writes under their own handle; Core's read adapter shows that author;
  // narrowing to read blocks the member's writes; removal revokes the member. Links travel only on
  // a child's stdin and are never printed.
  const memberHome = mkdtempSync('/tmp/bigbrain-native-member-')
  const memberClient = (body: string, input = '') => nativeClient(memberHome, body, input)
  const readPaced = async (id: string): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await reader.readRecord({ id })
      } catch (e) {
        if (attempt >= 10) return `error ${(e as Error).message}`
        await Bun.sleep(2500)
      }
    }
  }
  const redeemMember = (link: string) =>
    memberClient(
      `const saved = await connect(input);
       console.log(JSON.stringify({ ok: true, handle: saved.identity.handle, role: saved.identity.role, permissions: saved.identity.permissions }));`,
      link
    )
  const memberWrite = () =>
    memberClient(
      `const [c] = m.readConnections(path);
       const r = await m.sharedRequest(c, '/v1/evidence', { title: 'Lane member note', body: 'Written by an invited member through Caddy.' });
       console.log(JSON.stringify({ ok: true, id: r.id, submittedBy: r.submitted_by }));`
    )
  const memberWhoami = () =>
    memberClient(
      `const [c] = m.readConnections(path);
       const r = await m.sharedRequest(c, '/v1/whoami');
       console.log(JSON.stringify({ ok: true, handle: r.handle, permissions: r.permissions }));`
    )
  const fenceA = () => ({ vaultId: A, expectedGeneration: receipt(A).receipt.generation })
  const memberInviteRequest = {
    requestId: randomUUID(),
    action: 'member-invite',
    ...fenceA(),
    displayName: 'Grace Hopper',
    access: 'write',
  }
  const memberInvite = helper(memberInviteRequest)
  const memberLink = memberInvite.ok ? String(memberInvite.invite.inviteUrl) : ''
  check(
    'member-invite issues a single-use link on the vault origin',
    memberInvite.ok === true &&
      memberLink.startsWith(`${ORIGINS[A]}/invite#`) &&
      memberInvite.invite.access === 'write',
    JSON.stringify(memberInvite.ok ? 'issued' : [memberInvite.code, memberInvite.stderr])
  )
  const memberReplay = helper(memberInviteRequest)
  check(
    'a retried member-invite returns the same link and mints no second invite',
    memberReplay.ok === true && memberReplay.invite?.inviteUrl === memberLink,
    JSON.stringify(memberReplay.ok ? 'replayed' : [memberReplay.code])
  )
  const pending = helper({ requestId: randomUUID(), action: 'member-list', vaultId: A })
  check(
    'member-list shows exactly one pending invite and never its link',
    pending.ok === true &&
      pending.roster.invites.length === 1 &&
      pending.roster.invites[0].inviteId === memberInvite.invite?.inviteId &&
      !JSON.stringify(pending).includes(memberLink.split('#')[1] ?? 'unset'),
    JSON.stringify(pending.ok ? pending.roster.invites.map((i: { access: string }) => i.access) : [pending.code])
  )
  const memberHandle = `invite-${memberInvite.invite?.inviteId}`
  const joined = await redeemMember(memberLink)
  check(
    'the member link redeems in the pinned native client as a NEW member through real Caddy',
    joined.ok === true &&
      joined.handle === memberHandle &&
      joined.role === 'member' &&
      JSON.stringify(joined.permissions) === '["read","write"]',
    JSON.stringify(joined.ok ? { role: joined.role, permissions: joined.permissions } : joined)
  )
  const contributed = await memberWrite()
  check(
    'the member writes under their own handle',
    contributed.ok === true && contributed.submittedBy === memberHandle,
    JSON.stringify(contributed.ok ? contributed.submittedBy : contributed)
  )
  // Core's own read adapter over Ficus's read-only credential, through the shipped gateway.
  const { BigbrainSharedClient } = await import('../../apps/core/src/services/integrations/bigbrain/shared-client')
  const handoff = JSON.parse(readFileSync(`/var/lib/ficus-bigbrain/read-handoff/${A}.json`, 'utf8'))
  const reader = new BigbrainSharedClient({
    capabilities: {
      contractVersion: 1,
      tenantId: handoff.tenantId,
      physicalHostBinding: handoff.physicalHostBinding,
      hostEpoch: handoff.hostEpoch,
      available: true,
      reasonCode: null,
      installed: true,
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: handoff.artifactDigest,
      sharedProtocol: 1,
      hostState: 'active',
      zone: ZONE,
      tenantLabel: TENANT_LABEL,
      limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
      observedAt: new Date().toISOString(),
    },
    material: handoff,
    vault: {
      vaultId: A,
      upstreamVaultId: handoff.upstreamVaultId,
      origin: ORIGINS[A]!,
      appliedGeneration: handoff.generation,
      state: 'ready',
      readAccess: 'active',
    },
    beforeCall: async () => {},
    fetch: (url, init) =>
      fetch(`http://${new URL(ORIGINS[A]!).host}${new URL(url).pathname}`, { ...init, unix: GATEWAY_SOCKET }),
  })
  const shown = contributed.ok ? await readPaced(contributed.id) : ''
  check(
    "Ficus's read adapter shows the member as the author",
    shown.includes(`Grace Hopper (@${memberHandle})`),
    shown.startsWith('error') ? shown : undefined
  )
  const listed = helper({ requestId: randomUUID(), action: 'member-list', vaultId: A })
  const roleOf = (handle: string) =>
    listed.ok ? listed.roster.members.find((m: { handle: string }) => m.handle === handle) : undefined
  check(
    'member-list shows the owner, the Ficus reader and the new member with write access',
    roleOf(OWNER.handle)?.role === 'owner' &&
      roleOf('ficus-reader')?.access === 'read' &&
      roleOf(memberHandle)?.access === 'write' &&
      listed.roster.invites.length === 0,
    JSON.stringify(
      listed.ok ? listed.roster.members.map((m: { handle: string; access: string }) => m.access) : [listed.code]
    )
  )
  const narrowed = helper({
    requestId: randomUUID(),
    action: 'member-set-access',
    ...fenceA(),
    handle: memberHandle,
    access: 'read',
  })
  const memberBlocked = await memberWrite()
  const stillReads = await memberWhoami()
  check(
    "changing the member's access to read blocks their next write; reads continue",
    narrowed.ok === true &&
      narrowed.member.access === 'read' &&
      memberBlocked.ok === false &&
      memberBlocked.status === 403 &&
      stillReads.ok === true &&
      JSON.stringify(stillReads.permissions) === '["read"]',
    JSON.stringify([narrowed.ok ? 'narrowed' : narrowed.code, memberBlocked.status, stillReads.permissions])
  )
  const protectedReader = helper({
    requestId: randomUUID(),
    action: 'member-remove',
    ...fenceA(),
    handle: 'ficus-reader',
  })
  const protectedOwner = helper({
    requestId: randomUUID(),
    action: 'member-set-access',
    ...fenceA(),
    handle: OWNER.handle,
    access: 'read',
  })
  check(
    'the Ficus reader and the owner (any handle) are never changed or removed',
    protectedReader.ok === false &&
      protectedReader.code === 'invalid_request' &&
      protectedOwner.ok === false &&
      protectedOwner.code === 'forbidden' &&
      (await eventually(async () => (await gateway(A, '/v1/whoami', handoffA.token)).status, 200)) === 200,
    JSON.stringify([protectedReader.code, protectedOwner.code])
  )
  const removed = helper({ requestId: randomUUID(), action: 'member-remove', ...fenceA(), handle: memberHandle })
  const gone = await memberWhoami()
  check(
    'removing the member revokes their access; what they wrote stays theirs',
    removed.ok === true &&
      removed.member.status === 'removed' &&
      gone.ok === false &&
      gone.status === 401 &&
      (contributed.ok ? (await readPaced(contributed.id)).includes(`@${memberHandle}`) : false),
    JSON.stringify([removed.ok ? 'removed' : removed.code, gone.status])
  )
  const second = helper({
    requestId: randomUUID(),
    action: 'member-invite',
    ...fenceA(),
    displayName: 'Lin',
    access: 'read',
  })
  const cancelled = second.ok
    ? helper({ requestId: randomUUID(), action: 'invite-cancel', ...fenceA(), inviteId: second.invite.inviteId })
    : second
  sh(['/bin/rm', '-f', `${memberHome}/shared-connections.json`])
  const refused = await redeemMember(second.ok ? String(second.invite.inviteUrl) : '')
  check(
    'a cancelled member invite no longer redeems',
    cancelled.ok === true && refused.ok === false && refused.status === 401 && refused.spent === false,
    JSON.stringify([cancelled.ok ? 'cancelled' : cancelled.code, refused.status, refused.trail])
  )

  // ---------------------------------------------------------------- the BigBrain app's server name
  // The upstream name (.shared-identity.json) follows the Ficus name: rename stops only A, writes
  // the name as A's UID and starts A again; the upgrade repairs a vault still on upstream's default.
  const identityPath = (vaultId: string) => `${receipt(vaultId).storage.mount}/vault/.shared-identity.json`
  const identityOf = (vaultId: string) =>
    JSON.parse(readFileSync(identityPath(vaultId), 'utf8')) as { id: string; name: string }
  const ownerMode = (vaultId: string) => sh(['/usr/bin/stat', '-c', '%u:%a', identityPath(vaultId)]).stdout.trim()
  check(
    'create wrote the Ficus names as upstream server names, keeping upstream ids',
    identityOf(A).name === 'Alpha' &&
      identityOf(A).id === rA.receipt.upstreamVaultId &&
      identityOf(B).name === 'Beta' &&
      identityOf(B).id === rB.receipt.upstreamVaultId,
    JSON.stringify([identityOf(A).name, identityOf(B).name])
  )
  const pidB = unitProperty(`ficus-bigbrain@${B}.service`, 'MainPID')
  const renamed = helper({
    requestId: randomUUID(),
    action: 'rename',
    ...fenceA(),
    generation: receipt(A).receipt.generation + 1,
    displayName: 'Alpha notes',
  })
  check(
    'rename writes the upstream name as the vault UID (0600), keeps the id and restarts only that vault',
    renamed.ok === true &&
      renamed.receipt.displayName === 'Alpha notes' &&
      identityOf(A).name === 'Alpha notes' &&
      identityOf(A).id === rA.receipt.upstreamVaultId &&
      ownerMode(A) === `${rA.os.uid}:600` &&
      unitProperty(`ficus-bigbrain@${A}.service`, 'ActiveState') === 'active' &&
      unitProperty(`ficus-bigbrain@${B}.service`, 'MainPID') === pidB,
    JSON.stringify(renamed.ok ? [identityOf(A).name, ownerMode(A)] : [renamed.code, renamed.stderr])
  )
  const third = helper({
    requestId: randomUUID(),
    action: 'member-invite',
    ...fenceA(),
    displayName: 'Ada',
    access: 'read',
  })
  sh(['/bin/rm', '-f', `${memberHome}/shared-connections.json`])
  const renamedJoin = await memberClient(
    `const saved = await connect(input);
     console.log(JSON.stringify({ ok: true, name: saved.name, vault: saved.identity.vault.id }));`,
    third.ok ? String(third.invite.inviteUrl) : ''
  )
  check(
    'after a rename the vault redeems in the pinned native client under its new name',
    third.ok === true &&
      renamedJoin.ok === true &&
      renamedJoin.name === 'Alpha notes' &&
      renamedJoin.vault === rA.receipt.upstreamVaultId,
    JSON.stringify(renamedJoin.ok ? renamedJoin.name : { invite: third.ok ? 'issued' : third.code, ...renamedJoin })
  )
  // A real join under load: the child first fills A's read bucket (credential-free whoamis until
  // the gateway answers 429), then joins with upstream connectInvite itself, never the harness's
  // spent-link fallback. Only a refused redeem (nothing spent, e.g. the global bucket) runs the
  // child again; a refused whoami after the redeem fails the check with its trail.
  const loaded = helper({
    requestId: randomUUID(),
    action: 'member-invite',
    ...fenceA(),
    displayName: 'Katherine',
    access: 'read',
  })
  sh(['/bin/rm', '-f', `${memberHome}/shared-connections.json`])
  const loadedJoin = await nativeClient(
    memberHome,
    `const endpoint = m.endpointURL(new URL(input).origin);
     let refused = 0;
     for (let i = 0; i < 40 && refused === 0; i++) {
       const r = await nativeFetch(endpoint + '/v1/whoami');
       await r.arrayBuffer();
       if (r.status === 429) refused++;
     }
     const saved = await m.connectInvite(path, input);
     console.log(JSON.stringify({ ok: true, loaded: refused === 1, role: saved.identity.role, trail }));`,
    loaded.ok ? String(loaded.invite.inviteUrl) : ''
  )
  check(
    "a join while the vault's read bucket is full completes: the whoami after the redeem is served",
    loaded.ok === true &&
      loadedJoin.ok === true &&
      loadedJoin.loaded === true &&
      loadedJoin.role === 'member' &&
      JSON.stringify(loadedJoin.trail) === JSON.stringify(['POST /v1/invites/redeem 200', 'GET /v1/whoami 200']),
    JSON.stringify(loadedJoin.ok ? loadedJoin.trail : { invite: loaded.ok ? 'issued' : loaded.code, ...loadedJoin })
  )
  sh(['/bin/rm', '-rf', memberHome])
  // A vault created before Ficus wrote names: upstream's default, as the vault UID left it.
  writeFileSync(identityPath(B), JSON.stringify({ id: rB.receipt.upstreamVaultId, name: 'Shared BigBrain' }), {
    mode: 0o600,
  })
  must(['/usr/bin/chown', `${rB.os.uid}:${rB.os.gid}`, identityPath(B)])
  const pidBeforeUpgrade = unitProperty(`ficus-bigbrain@${A}.service`, 'MainPID')
  toolkitInstall(release, config)
  check(
    'the upgrade repairs a vault still named "Shared BigBrain" once, keeping its id, and leaves the others running',
    identityOf(B).name === 'Beta' &&
      identityOf(B).id === rB.receipt.upstreamVaultId &&
      ownerMode(B) === `${rB.os.uid}:600` &&
      unitProperty(`ficus-bigbrain@${A}.service`, 'MainPID') === pidBeforeUpgrade &&
      (await eventually(async () => (await gateway(B, '/v1/whoami', handoffB.token)).status, 200)) === 200,
    JSON.stringify([identityOf(B).name, ownerMode(B)])
  )

  // ---------------------------------------------------------------- probe reports a gateway that cannot serve
  // Same failure class as the outage (an active gateway unit that cannot load its manifest): make
  // the published manifest unreadable to the gateway's UID only. Root still reads it.
  must(['/bin/chmod', '0700', '/etc/ficus/bigbrain/public'])
  const blocked = viaCaddy(A, '/v1/whoami', 'GET')
  const unserved = helper({ action: 'probe' })
  must(['/bin/chmod', '0755', '/etc/ficus/bigbrain/public'])
  check(
    'a gateway that cannot read its manifest answers 503 and the probe reports it unavailable',
    blocked.status === 503 &&
      unserved.ok === true &&
      unserved.capabilities?.available === false &&
      unserved.capabilities?.reasonCode === 'upstream_unavailable',
    JSON.stringify([blocked.status, unserved.capabilities?.reasonCode ?? unserved.code])
  )
  const recovered = helper({ action: 'probe' })
  check(
    'the probe reports available again once the gateway serves',
    recovered.ok === true && recovered.capabilities?.available === true,
    JSON.stringify(recovered.capabilities?.reasonCode ?? recovered.code)
  )

  // ---------------------------------------------------------------- attacks from inside vault A
  const sockA = `/run/ficus-bigbrain/vaults/${A}`
  const sockB = `/run/ficus-bigbrain/vaults/${B}`
  const gatewayGid = Number(must(['/usr/bin/getent', 'group', 'ficus-bb-gateway']).split(':')[2])
  const dirA = sh(['/usr/bin/stat', '-c', '%u:%g:%a', sockA]).stdout.trim()
  check('A socket directory is owner A, group gateway, setgid 2750', dirA === `${rA.os.uid}:${gatewayGid}:2750`, dirA)
  const socketMode = sh(['/usr/bin/stat', '-c', '%a', `${sockA}/http.sock`]).stdout.trim()
  check('A socket is 0660 (gateway group only)', socketMode === '660', socketMode)
  const attackScript = (phase: string) => `${ATTACK_PRELUDE}
    (async () => console.log(JSON.stringify({
      phase: '${phase}',
      tcp4: await listenTcp('127.0.0.1'),
      tcp6: await listenTcp('::1'),
      tcp4Raw: rawSocket(2, 1),
      tcp6Raw: rawSocket(10, 1),
      udp6Raw: rawSocket(10, 2),
      udp4: await listenUdp(),
      peerSocketDir: write('${sockB}/http.sock'),
      peerSocketBind: await listenUnix('${sockB}/evil.sock'),
      peerConnect: await connectUnix('${sockB}/http.sock'),
      gatewaySocketBind: await listenUnix('/run/ficus-bigbrain/gateway/evil.sock'),
      gatewayReplace: write('/run/ficus-bigbrain/gateway/http.sock'),
      peerStore: list('${rB.storage.mount}'),
      hostRecord: read('/etc/ficus/bigbrain/host.json'),
      control: list('/var/lib/ficus-bigbrain/control'),
      handoff: read('/var/lib/ficus-bigbrain/read-handoff/${A}.json'),
      escrow: read('/var/lib/ficus-bigbrain/control/${A}/owner.json'),
      memberInvites: read('/var/lib/ficus-bigbrain/control/${A}/member-invites.json'),
      launcher: read('/usr/local/libexec/ficus-bigbrainctl'),
      ownStore: list('${rA.storage.mount}/vault'),
      hostAbstract: await connectUnix('\\0${HOST_ABSTRACT}'),
      unshare: unshare(),
      interfaces: interfaces(),
    })))()
  `
  const denied = (v: string | undefined) => !!v && ['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'EAFNOSUPPORT'].includes(v)
  const verdicts = (attack: Record<string, string>, when: string) => {
    console.log(`attack observations (${when}): ${JSON.stringify(attack)}`)
    const refused = (v: string | undefined) => v === 'EAFNOSUPPORT' || v === 'EPERM'
    check(`${when}: A cannot open any udp4 socket`, refused(attack.udp4), attack.udp4)
    // socket(2) is the kernel verdict; the runtime listener must also never have bound.
    for (const [key, raw] of [
      ['tcp4', 'tcp4Raw'],
      ['tcp6', 'tcp6Raw'],
    ] as const)
      check(
        `${when}: A cannot open any ${key} socket`,
        refused(attack[raw]) && !!attack[key] && attack[key] !== 'BOUND',
        `${attack[raw]} / ${attack[key]}`
      )
    check(`${when}: A cannot open any udp6 socket`, refused(attack.udp6Raw), attack.udp6Raw)
    check(`${when}: A cannot create files in B's socket directory`, denied(attack.peerSocketDir), attack.peerSocketDir)
    check(
      `${when}: A cannot bind a socket in B's socket directory`,
      denied(attack.peerSocketBind),
      attack.peerSocketBind
    )
    check(`${when}: A cannot connect to B's socket`, denied(attack.peerConnect), attack.peerConnect)
    check(
      `${when}: A cannot bind in the gateway's socket directory`,
      denied(attack.gatewaySocketBind),
      attack.gatewaySocketBind
    )
    check(`${when}: A cannot replace the gateway socket`, denied(attack.gatewayReplace), attack.gatewayReplace)
    check(`${when}: A cannot read B's store`, denied(attack.peerStore), attack.peerStore)
    check(`${when}: A cannot read the host record`, denied(attack.hostRecord), attack.hostRecord)
    check(`${when}: A cannot list root control state`, denied(attack.control), attack.control)
    check(`${when}: A cannot read its own Ficus read handoff`, denied(attack.handoff), attack.handoff)
    check(`${when}: A cannot read root owner escrow`, denied(attack.escrow), attack.escrow)
    check(
      `${when}: A cannot read the root member invite replay cache`,
      denied(attack.memberInvites),
      attack.memberInvites
    )
    check(`${when}: A cannot read the root helper launcher`, denied(attack.launcher), attack.launcher)
    check(`${when}: A can still use its own store`, attack.ownStore === 'LISTED', attack.ownStore)
    check(
      `${when}: A cannot reach an abstract socket bound in the host network namespace`,
      !!attack.hostAbstract && attack.hostAbstract !== 'CONNECTED',
      attack.hostAbstract
    )
    check(
      `${when}: A cannot create a new namespace (unshare)`,
      attack.unshare?.startsWith('REFUSED_') === true,
      attack.unshare
    )
    check(`${when}: A sees only its own loopback interface`, attack.interfaces === 'lo', attack.interfaces)
  }
  // A root listener in the HOST network namespace: proof the vault's namespace is private.
  const { createServer } = await import('node:net')
  const hostProbe = createServer((socket) => socket.end())
  await new Promise<void>((resolve, reject) => {
    hostProbe.once('error', reject)
    hostProbe.listen(`\0${HOST_ABSTRACT}`, () => resolve())
  })
  const { connect } = await import('node:net')
  check(
    'the host abstract probe is reachable from the host namespace',
    await new Promise<boolean>((resolve) => {
      const c = connect(`\0${HOST_ABSTRACT}`)
      c.once('connect', () => (c.destroy(), resolve(true)))
      c.once('error', () => resolve(false))
    })
  )
  verdicts(asVault(A, attackScript('B running')), 'B running')
  // B stopped: its socket path is the prize. A still cannot take it.
  must(['/usr/bin/systemctl', 'stop', `ficus-bigbrain@${B}.service`])
  verdicts(asVault(A, attackScript('B stopped')), 'B stopped')
  must(['/usr/bin/systemctl', 'start', `ficus-bigbrain@${B}.service`])
  check(
    'B restarts on a root-reprepared socket and serves again',
    (await eventually(async () => (await gateway(B, '/v1/whoami', handoffB.token)).status, 200)) === 200
  )
  // After a restart of B and of the gateway, the boundary still holds.
  must(['/usr/bin/systemctl', 'restart', 'ficus-bigbrain-gateway.service'])
  verdicts(asVault(A, attackScript('after restarts')), 'after restarts')
  check(
    'gateway serves after restart',
    (await eventually(async () => (await gateway(B, '/v1/whoami', handoffB.token)).status, 200)) === 200
  )
  hostProbe.close()

  // ---------------------------------------------------------------- crash restart (SIGKILL)
  const killedPid = unitProperty(`ficus-bigbrain@${B}.service`, 'MainPID')
  must(['/bin/kill', '-KILL', killedPid])
  const revived = await eventually(async () => (await gateway(B, '/v1/whoami', handoffB.token)).status, 200, 60)
  check(
    'a SIGKILLed vault is restarted by systemd and serves its data again',
    revived === 200 && unitProperty(`ficus-bigbrain@${B}.service`, 'MainPID') !== killedPid,
    `${revived}`
  )

  // ---------------------------------------------------------------- disk bound
  const fill = asVault(
    A,
    `
    const fs = require('node:fs'); const block = Buffer.alloc(1 << 20); let written = 0; let code = 'NONE';
    try { const fd = fs.openSync('${rA.storage.mount}/vault/fill.bin', 'w'); for (let i = 0; i < 1024; i++) { fs.writeSync(fd, block); written++ } fs.closeSync(fd) } catch (e) { code = e.code }
    try { fs.unlinkSync('${rA.storage.mount}/vault/fill.bin') } catch {}
    console.log(JSON.stringify({ code, written: String(written) }))
  `
  )
  check(
    'A’s writes stop at its own bounded filesystem (ENOSPC)',
    fill.code === 'ENOSPC' && Number(fill.written) <= 512,
    JSON.stringify(fill)
  )
  check('B unaffected by A filling its disk', (await gateway(B, '/v1/whoami', handoffB.token)).status === 200)

  // ---------------------------------------------------------------- backup role
  const lock = '/var/lib/ficus-bigbrain/control/host.lock'
  const stage = must([
    '/usr/bin/flock',
    '-x',
    lock,
    '/usr/local/bin/bun',
    '--no-install',
    '--no-env-file',
    `/opt/ficus-bigbrain/releases/${host().artifactDigest.slice(7)}/ficus-bigbrain-host.js`,
    'backup-stage',
  ])
  const staged = JSON.parse(stage.trim().split('\n').at(-1)!)
  check(
    'backup stages both vaults quiescently',
    staged.ok === true && staged.inventory?.vaults?.length === 2,
    JSON.stringify(staged.code ?? staged.inventory?.vaults?.length)
  )
  // Keep the staged copy as "the backup" for the disaster-recovery scenario below.
  const backupCopy = mkdtempSync('/var/tmp/bigbrain-dr-')
  must(['/bin/cp', '-a', '/var/lib/ficus-bigbrain/backup/managed-bigbrain', `${backupCopy}/managed-bigbrain`])
  check(
    'vaults restarted after staging',
    unitProperty(`ficus-bigbrain@${A}.service`, 'ActiveState') === 'active' &&
      unitProperty(`ficus-bigbrain@${B}.service`, 'ActiveState') === 'active'
  )
  must([
    '/usr/bin/flock',
    '-x',
    lock,
    '/usr/local/bin/bun',
    '--no-install',
    '--no-env-file',
    `/opt/ficus-bigbrain/releases/${host().artifactDigest.slice(7)}/ficus-bigbrain-host.js`,
    'backup-release',
  ])
  check('staging released', !existsSync('/var/lib/ficus-bigbrain/backup'))

  // ---------------------------------------------------------------- nightly partial backup
  // B's storage is unavailable (mount stopped): a nightly run excludes B, stages A and says so;
  // a termination run (FICUS_BACKUP_REQUIRE_COMPLETE=1) refuses instead.
  const bbHost = (role: string, extra: string[] = []) =>
    sh([
      '/usr/bin/flock',
      '-x',
      lock,
      '/usr/bin/env',
      ...extra,
      '/usr/local/bin/bun',
      '--no-install',
      '--no-env-file',
      `/opt/ficus-bigbrain/releases/${host().artifactDigest.slice(7)}/ficus-bigbrain-host.js`,
      role,
    ])
  const mountB = must(['/usr/bin/systemd-escape', '-p', '--suffix=mount', rB.storage.mount]).trim()
  must(['/usr/bin/systemctl', 'stop', mountB])
  const strict = JSON.parse(
    bbHost('backup-stage', ['FICUS_BACKUP_REQUIRE_COMPLETE=1']).stdout.trim().split('\n').at(-1)!
  )
  check('a termination backup refuses when one vault is unavailable', strict.ok === false, JSON.stringify(strict.code))
  bbHost('backup-release')
  const partial = JSON.parse(bbHost('backup-stage').stdout.trim().split('\n').at(-1)!)
  check(
    'a nightly backup stages A and excludes the unavailable B',
    partial.ok === true &&
      partial.partial === true &&
      partial.inventory?.vaults?.map((v: { vaultId: string }) => v.vaultId).join() === A &&
      partial.excluded?.[0]?.vaultId === B,
    JSON.stringify({ code: partial.code, excluded: partial.excluded?.length })
  )
  check('the excluded vault is marked in its receipt', receipt(B).receipt.backup === 'excluded')
  bbHost('backup-release')
  must(['/usr/bin/systemctl', 'start', `ficus-bigbrain@${B}.service`])
  check(
    'B serves again after its storage returns',
    (await eventually(async () => (await gateway(B, '/v1/whoami', handoffB.token)).status, 200)) === 200
  )

  // ---------------------------------------------------------------- read revoke keeps humans
  const revoke = helper({
    action: 'read-revoke',
    vaultId: A,
    expectedGeneration: receipt(A).receipt.generation,
    generation: receipt(A).receipt.generation + 1,
  })
  check(
    'read-revoke succeeds',
    revoke.ok === true && revoke.receipt?.readAccess === 'revoked',
    JSON.stringify(revoke.code)
  )
  check('revoked read token rejected (401)', (await gateway(A, '/v1/whoami', handoffA.token)).status === 401)
  check('handoff removed on revoke', !existsSync(`/var/lib/ficus-bigbrain/read-handoff/${A}.json`))

  // ---------------------------------------------------------------- suspend / resume
  const suspend = helper({ action: 'suspend-tenant', hostEpoch: 2, previousHostEpoch: 1, effectId: randomUUID() })
  epoch = 2
  check(
    'suspend closes ingress and stops vaults',
    suspend.ok === true &&
      unitProperty('ficus-bigbrain-gateway.service', 'ActiveState') !== 'active' &&
      unitProperty(`ficus-bigbrain@${B}.service`, 'ActiveState') !== 'active'
  )
  const resume = helper({ action: 'resume-tenant', hostEpoch: 3, previousHostEpoch: 2, effectId: randomUUID() })
  epoch = 3
  check(
    'resume restarts gateway and vaults',
    resume.ok === true && (await gateway(B, '/v1/whoami', handoffB.token)).status === 200
  )

  // ---------------------------------------------------------------- delete A, B untouched
  const del = helper({
    action: 'delete',
    vaultId: A,
    expectedGeneration: receipt(A).receipt.generation,
    generation: receipt(A).receipt.generation + 1,
    confirmedVaultId: A,
    confirmedName: 'Alpha notes',
  })
  check('delete A', del.ok === true && del.receipt?.state === 'deleted', JSON.stringify(del.code))
  check('A account removed', sh(['/usr/bin/getent', 'passwd', `bbv_${hex(A).slice(0, 24)}`]).code === 2)
  check('A image removed', !existsSync(rA.storage.image))
  check('A unmounted', sh(['/usr/bin/findmnt', rA.storage.mount]).code !== 0)
  check('B still serves after A deleted', (await gateway(B, '/v1/whoami', handoffB.token)).status === 200)
  check('A host no longer routed', (await gateway(A, '/v1/whoami')).status === 404)

  // ---------------------------------------------------------------- disaster recovery
  // The machine is lost and rebuilt (new physical host binding). Setup stages the backup's
  // vault data before installing; Platform fences the host epoch, then sends authoritative
  // grants: A was deleted after the backup (excluded), B is restored under its current name.
  const rebuild = sh([
    '/bin/bash',
    '-c',
    [
      'set -u',
      `systemctl stop ficus-bigbrain-gateway.service 'ficus-bigbrain@*.service'`,
      `systemctl stop "$(systemd-escape -p --suffix=mount ${rB.storage.mount})"`,
      `for loop in $(losetup -j ${rB.storage.image} | cut -d: -f1); do losetup -d "$loop"; done`,
      `userdel bbv_${hex(B).slice(0, 24)}`,
      `rm -rf /var/lib/ficus-bigbrain /etc/ficus/bigbrain /run/ficus-bigbrain`,
      `rm -f /etc/systemd/system/ficus-bigbrain@*.service /etc/systemd/system/*ficus*bigbrain*.mount /etc/tmpfiles.d/ficus-bigbrain*.conf`,
      'systemctl daemon-reload',
    ].join('\n'),
  ])
  check('the machine is rebuilt without any managed vault state', rebuild.code === 0, rebuild.stderr.slice(0, 300))
  const rebuilt = { ...config, physicalHostBinding: REBUILT_BINDING }
  must([
    '/bin/bash',
    '-c',
    `set -euo pipefail; source scripts/setup/lib.sh; bigbrain_restore_stage "$1" "$2"; bigbrain_install "$3" "$2"`,
    'restore',
    backupCopy,
    JSON.stringify(rebuilt),
    release,
  ])
  binding = REBUILT_BINDING
  epoch = 1
  check('setup staged the backup and installed the rebuilt host', host().hostEpoch === 1)
  const fenced = helper({ action: 'restore-fence', hostEpoch: 2, previousHostEpoch: 1, effectId: randomUUID() })
  epoch = 2
  const inventory = fenced.archive as {
    manifestDigest: string
    vaults: { vaultId: string; upstreamVaultId: string; generation: number }[]
  }
  check(
    'restore fence reports the backup inventory (both vaults)',
    fenced.ok === true && inventory?.vaults?.length === 2,
    JSON.stringify(fenced.code ?? fenced.stderr ?? null)
  )
  const archivedA = inventory.vaults.find((v) => v.vaultId === A)!
  const archivedB = inventory.vaults.find((v) => v.vaultId === B)!
  // No grants: the host restores exactly the archive (Core's restored DB is the vault authority).
  const restored = helper({
    action: 'restore',
    effectId: randomUUID(),
    archiveManifestDigest: inventory.manifestDigest,
  })
  check('restore restores the archive', restored.ok === true, JSON.stringify(restored.code ?? restored.stderr ?? null))
  check(
    'both archived vaults come back, read-revoked, at a newer generation',
    [A, B].every((v) => receipt(v).receipt.readAccess === 'revoked' && receipt(v).receipt.state === 'ready') &&
      receipt(A).receipt.generation === archivedA.generation + 1 &&
      receipt(B).receipt.generation === archivedB.generation + 1
  )
  check(
    'restored vaults keep their recorded hostname forms',
    receipt(A).receipt.origin === ORIGINS[A] && receipt(B).receipt.origin === ORIGINS[B],
    JSON.stringify([receipt(A).receipt.origin, receipt(B).receipt.origin])
  )
  check(
    'restored vaults keep their archived names, also as their upstream server names (ids kept)',
    receipt(B).displayName === 'Beta' &&
      receipt(A).displayName === 'Alpha notes' &&
      identityOf(B).name === 'Beta' &&
      identityOf(B).id === archivedB.upstreamVaultId &&
      identityOf(A).name === 'Alpha notes' &&
      identityOf(A).id === archivedA.upstreamVaultId,
    JSON.stringify([identityOf(A).name, identityOf(B).name])
  )
  check(
    'restored B rotated every credential: the pre-backup Ficus token is rejected',
    (await eventually(async () => (await gateway(B, '/v1/whoami', handoffB.token)).status, 401)) === 401
  )
  const reconnected = helper({
    action: 'read-reconnect',
    vaultId: B,
    expectedGeneration: archivedB.generation + 1,
    generation: archivedB.generation + 2,
  })
  const freshB = JSON.parse(readFileSync(`/var/lib/ficus-bigbrain/read-handoff/${B}.json`, 'utf8'))
  const restoredIdentity = await gateway(B, '/v1/whoami', freshB.token)
  const restoredActor = (await restoredIdentity.json().catch(() => ({}))) as Record<string, any>
  check(
    'after an explicit reconnect B serves its original upstream vault read-only',
    reconnected.ok === true &&
      restoredIdentity.status === 200 &&
      restoredActor.vault?.id === handoffB.upstreamVaultId &&
      JSON.stringify(restoredActor.permissions) === '["read"]',
    `${restoredIdentity.status}`
  )
  // Core-style reconciliation: A was deleted in Core after this backup was taken, so Core's
  // tombstone wins: status, then delete fenced on the host's receipt generation and name.
  const statusA = helper({ action: 'status', vaultId: A })
  const redeleted = helper({
    action: 'delete',
    vaultId: A,
    expectedGeneration: statusA.receipt.generation,
    generation: statusA.receipt.generation + 1,
    confirmedVaultId: A,
    confirmedName: statusA.receipt.displayName,
  })
  check(
    'Core reconciliation deletes the restored-but-tombstoned vault A',
    statusA.ok === true && redeleted.ok === true && redeleted.receipt?.state === 'deleted',
    JSON.stringify(redeleted.code ?? null)
  )
  check('A is not routed after the reconcile delete', (await gateway(A, '/v1/whoami')).status === 404)
  check('B still serves after A is reconciled away', (await gateway(B, '/v1/whoami', freshB.token)).status === 200)
} catch (error) {
  check(
    'acceptance run completed without an unexpected error',
    false,
    error instanceof Error ? error.message : String(error)
  )
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
