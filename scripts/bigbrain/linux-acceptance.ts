#!/usr/bin/env bun
/**
 * Disposable-runner acceptance for managed BigBrain containment. Runs as ROOT on a throwaway CI
 * VM only (never a shared or production host): real install through the setup-toolkit hook, real
 * helper launcher, real accounts/loop mounts/systemd units/cgroups, and attacks executed from
 * inside vault A's own mount namespace, cgroup and UID.
 *
 * Usage (CI): sudo /usr/local/bin/bun scripts/bigbrain/linux-acceptance.ts <release-dir>
 * where <release-dir>/bigbrain is the built runtime artifact.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { MANAGED_BIGBRAIN_DEFAULT_LIMITS, MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'

const release = process.argv[2]
if (!release || process.getuid?.() !== 0 || process.platform !== 'linux') {
  console.error('usage: sudo bun scripts/bigbrain/linux-acceptance.ts <release-dir> (Linux, root, disposable VM only)')
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
const ZONE = 'bigbrain.example.test'
const OWNER = { userId: randomUUID(), handle: 'ada', display: 'Ada' }
const A = randomUUID()
const B = randomUUID()
const hex = (id: string) => id.replaceAll('-', '')
const config = { enabled: true, tenantId: TENANT, physicalHostBinding: BINDING, hostEpoch: 1, zone: ZONE }
let epoch = 1

function helper(fields: Record<string, unknown>) {
  const request = {
    contractVersion: 1,
    tenantId: TENANT,
    physicalHostBinding: BINDING,
    hostEpoch: epoch,
    requestId: randomUUID(),
    ...fields,
  }
  const out = sh(['/usr/local/libexec/ficus-bigbrainctl'], JSON.stringify(request))
  try {
    return JSON.parse(out.stdout.trim().split('\n').at(-1) ?? 'null') as Record<string, any>
  } catch {
    return { ok: false, code: 'unparseable', raw: out.stdout.slice(0, 200), stderr: out.stderr.slice(0, 400) }
  }
}
const create = (vaultId: string, name: string) =>
  helper({
    action: 'create',
    vaultId,
    expectedGeneration: 0,
    generation: 1,
    displayName: name,
    owner: OWNER,
    origin: `https://bb-${hex(vaultId)}.${ZONE}`,
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
async function gateway(vaultId: string, path: string, token?: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:34792${path}`, {
    ...init,
    headers: {
      Host: `bb-${hex(vaultId)}.${ZONE}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
    redirect: 'manual',
  })
}

/** Run a Bun snippet as a compromised vault process: inside that vault service's mount
 * namespace and cgroup (so its BPF socket-bind policy applies), as its UID/GID, no groups/caps. */
function asVault(vaultId: string, script: string) {
  const unit = `ficus-bigbrain@${vaultId}.service`
  const pid = unitProperty(unit, 'MainPID')
  const cgroup = unitProperty(unit, 'ControlGroup')
  const r = receipt(vaultId)
  const wrapper = `echo $$ > /sys/fs/cgroup${cgroup}/cgroup.procs && exec /usr/bin/nsenter --target ${pid} --mount -- /usr/bin/setpriv --reuid=${r.os.uid} --regid=${r.os.gid} --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all /usr/local/bin/bun --no-install --no-env-file -e "$0"`
  const result = sh(['/bin/sh', '-c', wrapper, script])
  try {
    return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, string>
  } catch {
    return { error: `${result.code}: ${result.stderr.slice(0, 300)}` }
  }
}

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
  must([
    '/bin/bash',
    '-c',
    `set -euo pipefail; source scripts/setup/lib.sh; bigbrain_install "$1" "$2"`,
    'install',
    release,
    JSON.stringify(config),
  ])
  check('toolkit install created the host record', host().hostEpoch === 1)
  const launcher = sh(['/usr/bin/stat', '-c', '%U:%G:%a', '/usr/local/libexec/ficus-bigbrainctl']).stdout.trim()
  check('launcher is root-only (root:root 750)', launcher === 'root:root:750', launcher)
  check('gateway service active', unitProperty('ficus-bigbrain-gateway.service', 'ActiveState') === 'active')

  const probe = helper({ action: 'probe' })
  check(
    'probe reports available',
    probe.ok === true && probe.capabilities?.available === true,
    JSON.stringify(probe.capabilities?.reasonCode ?? probe.code)
  )

  // ---------------------------------------------------------------- two vaults
  const a = create(A, 'Alpha')
  check('create A ready', a.ok === true && a.receipt?.state === 'ready', JSON.stringify(a.code ?? a.receipt?.state))
  const b = create(B, 'Beta')
  check('create B ready', b.ok === true && b.receipt?.state === 'ready', JSON.stringify(b.code ?? b.receipt?.state))
  const rA = receipt(A)
  const rB = receipt(B)
  check('vaults have distinct non-root UIDs', rA.os.uid !== rB.os.uid && rA.os.uid > 0 && rB.os.uid > 0)
  check('vaults have distinct loopback ports', rA.storage.port !== rB.storage.port)
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

  // ---------------------------------------------------------------- attacks from inside vault A
  const attack = asVault(
    A,
    `
    const net = require('node:net'); const fs = require('node:fs');
    const bind = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', (e) => resolve(e.code)); s.listen(port, '127.0.0.1', () => { s.close(); resolve('BOUND') }) });
    const read = (p) => { try { fs.readFileSync(p); return 'READ' } catch (e) { return e.code } };
    const list = (p) => { try { fs.readdirSync(p); return 'LISTED' } catch (e) { return e.code } };
    (async () => console.log(JSON.stringify({
      peerPort: await bind(${rB.storage.port}),
      gatewayPort: await bind(34792),
      anyPort: await bind(0),
      peerStore: list('${rB.storage.mount}'),
      hostRecord: read('/etc/ficus/bigbrain/host.json'),
      control: list('/var/lib/ficus-bigbrain/control'),
      handoff: read('/var/lib/ficus-bigbrain/read-handoff/${A}.json'),
      escrow: read('/var/lib/ficus-bigbrain/control/${A}/owner.json'),
      launcher: read('/usr/local/libexec/ficus-bigbrainctl'),
      coreEnv: list('/opt/ficus-core'),
      ownStore: list('${rA.storage.mount}/vault'),
    })))()
  `
  )
  console.log(`attack observations: ${JSON.stringify(attack)}`)
  const denied = (v: string | undefined) => v === 'EACCES' || v === 'EPERM' || v === 'ENOENT'
  check(
    'A cannot bind B’s port (policy denial, not collision)',
    attack.peerPort === 'EACCES' || attack.peerPort === 'EPERM',
    attack.peerPort
  )
  check(
    'A cannot bind the gateway port',
    attack.gatewayPort === 'EACCES' || attack.gatewayPort === 'EPERM',
    attack.gatewayPort
  )
  check('A cannot bind an arbitrary port', attack.anyPort === 'EACCES' || attack.anyPort === 'EPERM', attack.anyPort)
  check('A cannot read B’s store', denied(attack.peerStore), attack.peerStore)
  check('A cannot read the host record', denied(attack.hostRecord), attack.hostRecord)
  check('A cannot list root control state', denied(attack.control), attack.control)
  check('A cannot read its own Ficus read handoff', denied(attack.handoff), attack.handoff)
  check('A cannot read root owner escrow', denied(attack.escrow), attack.escrow)
  check('A cannot read the root helper launcher', denied(attack.launcher), attack.launcher)
  check('A can still use its own store', attack.ownStore === 'LISTED', attack.ownStore)

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

  // ---------------------------------------------------------------- read revoke keeps humans
  const revoke = helper({ action: 'read-revoke', vaultId: A, expectedGeneration: 1, generation: 2 })
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
    expectedGeneration: 2,
    generation: 3,
    confirmedVaultId: A,
    confirmedName: 'Alpha',
  })
  check('delete A', del.ok === true && del.receipt?.state === 'deleted', JSON.stringify(del.code))
  check('A account removed', sh(['/usr/bin/getent', 'passwd', `bbv_${hex(A).slice(0, 24)}`]).code === 2)
  check('A image removed', !existsSync(rA.storage.image))
  check('A unmounted', sh(['/usr/bin/findmnt', rA.storage.mount]).code !== 0)
  check('B still serves after A deleted', (await gateway(B, '/v1/whoami', handoffB.token)).status === 200)
  check('A host no longer routed', (await gateway(A, '/v1/whoami')).status === 404)
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
