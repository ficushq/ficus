import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANAGED_BIGBRAIN_DEFAULT_LIMITS, MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import { ManagedHostError, createManagedHostClient, managedHelperArgv } from './host-client'
import { managedVaultOrigin, readInstalledHost } from './host-identity'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const TENANT = '11111111-1111-4111-8111-111111111111'
const BINDING = '77777777-7777-4777-8777-777777777777'
const VAULT = '22222222-2222-4222-8222-222222222222'
const REQUEST = '55555555-5555-4555-8555-555555555555'
const host = { tenantId: TENANT, physicalHostBinding: BINDING, hostEpoch: 3 }
const installed = {
  contractVersion: 1,
  ...host,
  hostState: 'active',
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  zone: 'example.com',
  tenantLabel: 'acme',
  limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  effect: null,
}
const receipt = {
  receiptId: REQUEST,
  ...host,
  vaultId: VAULT,
  generation: 2,
  upstreamVaultId: '33333333-3333-4333-8333-333333333333',
  displayName: 'Research',
  state: 'ready',
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: installed.artifactDigest,
  localPort: null,
  origin: managedVaultOrigin(VAULT, { zone: 'example.com', tenantLabel: null }),
  readAccess: 'active',
} as const
/** A client for a Core running as root: the helper is spawned directly. */
const rootClient = (options: Parameters<typeof createManagedHostClient>[0]) =>
  createManagedHostClient({ euid: () => 0, ...options })
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'bigbrain-host-client-'))
  roots.push(dir)
  return dir
}
/** A fake launcher: records stdin, then runs `body` (bash). */
async function launcher(body: string) {
  const dir = await scratch()
  const path = join(dir, 'ficus-bigbrainctl')
  await writeFile(path, `#!/bin/bash\ncat >"${dir}/stdin.json"\n${body}\n`)
  await chmod(path, 0o755)
  return { path, stdin: () => readFile(join(dir, 'stdin.json'), 'utf8') }
}
const reply = (value: object) =>
  `printf '%s\\n' '${JSON.stringify({ contractVersion: 1, requestId: REQUEST, ...value })}'`
async function code(promise: Promise<unknown>): Promise<[string, boolean]> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedHostError)
    expect(String((error as Error).message)).not.toMatch(/secret|stderr|sv_/)
    return [(error as ManagedHostError).code, (error as ManagedHostError).retryable]
  }
  throw new Error('expected a refusal')
}
const rename = {
  action: 'rename' as const,
  vaultId: VAULT,
  expectedGeneration: 1,
  generation: 2,
  displayName: 'Research',
}

test('sends one validated envelope from the installed host and returns the verified receipt', async () => {
  const fake = await launcher(reply({ ok: true, action: 'rename', physicalHostBinding: BINDING, receipt }))
  const client = rootClient({ helperPath: fake.path })
  const result = await client.call(host, REQUEST, rename)
  expect('receipt' in result && result.receipt.vaultId).toBe(VAULT)
  expect(JSON.parse(await fake.stdin())).toEqual({ contractVersion: 1, requestId: REQUEST, ...host, ...rename })
})

test('an invalid request never starts the helper', async () => {
  const fake = await launcher('touch "$(dirname "$0")/started"')
  const client = rootClient({ helperPath: fake.path })
  expect(await code(client.call(host, REQUEST, { ...rename, displayName: ' bad ' }))).toEqual([
    'invalid_request',
    false,
  ])
  expect(await code(client.call(host, 'not-a-uuid', rename))).toEqual(['invalid_request', false])
  await expect(readFile(join(fake.path, '..', 'started'))).rejects.toThrow()
})

test('helper refusals keep only contract codes; busy is retryable; exit 78 is not installed', async () => {
  for (const [body, expected] of [
    [reply({ ok: false, code: 'busy', retryable: true }), ['busy', true]],
    [reply({ ok: false, code: 'generation_conflict', retryable: false }), ['generation_conflict', false]],
    ['echo "secret stderr" >&2; exit 78', ['not_installed', false]],
    ['echo "sv_secret"; exit 1', ['operation_failed', true]],
    ['echo "{not json"', ['invalid_response', false]],
  ] as const) {
    const fake = await launcher(body)
    expect(await code(rootClient({ helperPath: fake.path }).call(host, REQUEST, rename))).toEqual([...expected])
  }
  expect(await code(rootClient({ helperPath: '/nonexistent/ficus-bigbrainctl' }).call(host, REQUEST, rename))).toEqual([
    'not_installed',
    false,
  ])
})

test('replies about another request, binding, vault, tenant, generation or origin are refused', async () => {
  for (const bad of [
    { requestId: VAULT, ok: true, action: 'rename', physicalHostBinding: BINDING, receipt },
    { ok: true, action: 'status', physicalHostBinding: BINDING, receipt },
    { ok: true, action: 'rename', physicalHostBinding: VAULT, receipt: { ...receipt, physicalHostBinding: VAULT } },
    {
      ok: true,
      action: 'rename',
      physicalHostBinding: BINDING,
      receipt: {
        ...receipt,
        vaultId: REQUEST,
        origin: managedVaultOrigin(REQUEST, { zone: 'example.com', tenantLabel: 'acme' }),
      },
    },
    { ok: true, action: 'rename', physicalHostBinding: BINDING, receipt: { ...receipt, tenantId: VAULT } },
    { ok: true, action: 'rename', physicalHostBinding: BINDING, receipt: { ...receipt, generation: 3 } },
    { ok: true, action: 'rename', physicalHostBinding: BINDING, receipt: { ...receipt, hostEpoch: 4 } },
  ]) {
    const fake = await launcher(
      `printf '%s\\n' '${JSON.stringify({ contractVersion: 1, requestId: REQUEST, ...bad })}'`
    )
    expect((await code(rootClient({ helperPath: fake.path }).call(host, REQUEST, rename)))[0]).toMatch(
      /identity_mismatch|invalid_response/
    )
  }
})

test('member replies must name the requested vault, invitation and member', async () => {
  const member = {
    handle: 'grace',
    displayName: 'Grace',
    role: 'member',
    access: 'read',
    status: 'active',
    createdAt: null,
  }
  const ok = { ok: true, physicalHostBinding: BINDING }
  for (const [request, bad] of [
    [
      { action: 'member-set-access', vaultId: VAULT, expectedGeneration: 2, handle: 'grace', access: 'read' },
      { ...ok, action: 'member-set-access', vaultId: VAULT, member: { ...member, handle: 'mallory' } },
    ],
    [
      { action: 'member-remove', vaultId: VAULT, expectedGeneration: 2, handle: 'grace' },
      { ...ok, action: 'member-remove', vaultId: REQUEST, member: { ...member, status: 'removed' } },
    ],
    [
      { action: 'invite-cancel', vaultId: VAULT, expectedGeneration: 2, inviteId: 'c'.repeat(24) },
      { ...ok, action: 'invite-cancel', vaultId: VAULT, inviteId: 'd'.repeat(24) },
    ],
    [
      { action: 'member-list', vaultId: VAULT },
      {
        ...ok,
        action: 'member-list',
        vaultId: REQUEST,
        roster: { members: [], invites: [], membersTruncated: false, invitesTruncated: false },
      },
    ],
  ] as const) {
    const fake = await launcher(reply(bad))
    expect(await code(rootClient({ helperPath: fake.path }).call(host, REQUEST, request as never))).toEqual([
      'identity_mismatch',
      false,
    ])
  }
  const good = await launcher(reply({ ...ok, action: 'member-set-access', vaultId: VAULT, member }))
  const result = await rootClient({ helperPath: good.path }).call(host, REQUEST, {
    action: 'member-set-access',
    vaultId: VAULT,
    expectedGeneration: 2,
    handle: 'grace',
    access: 'read',
  })
  expect('member' in result && result.member.handle).toBe('grace')
})

test('oversized output and deadlines kill the helper and report retryable codes', async () => {
  const big = await launcher('head -c 140000 /dev/zero | tr "\\0" "a"')
  expect(await code(rootClient({ helperPath: big.path }).call(host, REQUEST, rename))).toEqual(['output_limit', true])
  const slow = await launcher('exec sleep 5')
  const started = Date.now()
  expect(await code(rootClient({ helperPath: slow.path, timeoutMs: () => 200 }).call(host, REQUEST, rename))).toEqual([
    'host_unreachable',
    true,
  ])
  expect(Date.now() - started).toBeLessThan(3000)
})

test('the installed host record is read only from a root-style owned, non-writable regular file', async () => {
  const dir = await scratch()
  const owner = process.getuid!()
  const path = join(dir, 'host.json')
  expect(await code(readInstalledHost({ path, owner }))).toEqual(['not_installed', false])
  await writeFile(path, JSON.stringify(installed), { mode: 0o600 })
  expect(await readInstalledHost({ path, owner })).toEqual(installed as never)
  expect(await code(readInstalledHost({ path, owner: owner + 1 }))).toEqual(['storage_unavailable', false])
  await chmod(path, 0o666)
  expect(await code(readInstalledHost({ path, owner }))).toEqual(['storage_unavailable', false])
  await chmod(path, 0o600)
  const link = join(dir, 'link.json')
  await symlink(path, link)
  expect(await code(readInstalledHost({ path: link, owner }))).toEqual(['storage_unavailable', false])
  await writeFile(path, JSON.stringify({ ...installed, token: 'x' }), { mode: 0o600 })
  expect(await code(readInstalledHost({ path, owner }))).toEqual(['not_installed', false])
  await writeFile(path, JSON.stringify({ ...installed, pad: 'x'.repeat(17000) }), { mode: 0o600 })
  expect(await code(readInstalledHost({ path, owner }))).toEqual(['storage_unavailable', false])
})

test('a non-root Core reaches the helper through sudo -n; root spawns it directly', async () => {
  expect(managedHelperArgv('/usr/local/libexec/ficus-bigbrainctl', 0)).toEqual(['/usr/local/libexec/ficus-bigbrainctl'])
  expect(managedHelperArgv('/usr/local/libexec/ficus-bigbrainctl', 998)).toEqual([
    '/usr/bin/sudo',
    '-n',
    '/usr/local/libexec/ficus-bigbrainctl',
  ])
  for (const [euid, expected] of [
    [0, ['/usr/local/libexec/ficus-bigbrainctl']],
    [998, ['/usr/bin/sudo', '-n', '/usr/local/libexec/ficus-bigbrainctl']],
  ] as const) {
    const seen: string[][] = []
    const spawn = ((argv: string[]) => {
      seen.push(argv)
      throw Object.assign(new Error('stub'), { code: 'ENOENT' })
    }) as unknown as typeof Bun.spawn
    const client = createManagedHostClient({ euid: () => euid, spawn })
    expect(await code(client.call(host, REQUEST, rename))).toEqual(['not_installed', false])
    expect(seen).toEqual([[...expected]])
  }
})

test('through sudo: the reply passes through, and a sudo refusal is not installed (not retryable)', async () => {
  const fake = await launcher(reply({ ok: true, action: 'rename', physicalHostBinding: BINDING, receipt }))
  const dir = await scratch()
  const sudoPath = join(dir, 'sudo')
  // Like sudo -n with a matching NOPASSWD rule: requires -n, then runs the helper with no arguments.
  await writeFile(sudoPath, `#!/bin/bash\n[ "$1" = -n ] && [ $# -eq 2 ] || exit 2\nexec "$2"\n`)
  await chmod(sudoPath, 0o755)
  const viaSudo = createManagedHostClient({ helperPath: fake.path, euid: () => 998, sudoPath })
  const result = await viaSudo.call(host, REQUEST, rename)
  expect('receipt' in result && result.receipt.vaultId).toBe(VAULT)
  expect(JSON.parse(await fake.stdin()).requestId).toBe(REQUEST)

  const refusing = join(dir, 'sudo-refusing')
  await writeFile(refusing, '#!/bin/bash\necho "sudo: a password is required" >&2\nexit 1\n')
  await chmod(refusing, 0o755)
  expect(
    await code(
      createManagedHostClient({ helperPath: fake.path, euid: () => 998, sudoPath: refusing }).call(
        host,
        REQUEST,
        rename
      )
    )
  ).toEqual(['not_installed', false])

  // A helper failure that does print through sudo keeps its own classification.
  const failing = await launcher('echo "sv_secret"; exit 1')
  expect(
    await code(
      createManagedHostClient({ helperPath: failing.path, euid: () => 998, sudoPath }).call(host, REQUEST, rename)
    )
  ).toEqual(['operation_failed', true])
})

// Bun can turn writes to an already-reaped child's sink into no-ops. Inject the
// failing sink boundary deterministically, but keep real exit/stdout/stderr and
// synchronize on the owned child's exit before the client receives it.
const stdinFailures = ['write', 'flush', 'closed'] as const
async function exitedChild(body: string, failure?: (typeof stdinFailures)[number]) {
  const child = Bun.spawn(['/bin/bash', '-c', body], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await child.exited
  return withStdinFailure(child, failure)
}

function withStdinFailure(
  child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>,
  failure?: (typeof stdinFailures)[number]
) {
  let failed = false
  const fail = () => {
    failed = true
    throw Object.assign(new Error('secret stdin diagnostics'), {
      code: failure === 'write' ? 'EPIPE' : failure === 'flush' ? 'ECONNRESET' : 'ERR_STREAM_DESTROYED',
    })
  }
  const stdin = {
    write: (body: Uint8Array) => (failure === 'write' ? fail() : child.stdin.write(body)),
    end: () => (failure === 'flush' ? Promise.resolve().then(fail) : failure === 'closed' ? fail() : child.stdin.end()),
  }
  return {
    spawn: (() => ({
      stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      kill: child.kill.bind(child),
    })) as unknown as typeof Bun.spawn,
    failed: () => failed,
  }
}

test.each([undefined, ...stdinFailures])(
  'a sudo refusal already exited before stdin stays non-retryable (%s)',
  async (failure) => {
    for (let iteration = 0; iteration < 32; iteration++) {
      const child = await exitedChild('echo "sudo: secret stderr" >&2; exit 1', failure)
      const client = createManagedHostClient({ euid: () => 998, spawn: child.spawn })
      expect(await code(client.call(host, REQUEST, rename))).toEqual(['not_installed', false])
      expect(child.failed()).toBe(failure !== undefined)
    }
  }
)

test('stdin failures preserve other early exits and never replace a valid reply or its verification', async () => {
  for (const failure of stdinFailures) {
    for (const [body, euid, expected] of [
      ['echo "secret stderr" >&2; exit 78', 0, ['not_installed', false]],
      ['echo "secret stderr" >&2; exit 1', 0, ['operation_failed', true]],
      ['echo "secret stderr" >&2; exit 2', 998, ['operation_failed', true]],
      ['echo "sv_secret"; exit 1', 998, ['operation_failed', true]],
      ['exit 0', 0, ['invalid_response', false]],
      [reply({ ok: false, code: 'busy', retryable: true }), 998, ['busy', true]],
      [
        reply({ requestId: VAULT, ok: true, action: 'rename', physicalHostBinding: BINDING, receipt }),
        998,
        ['identity_mismatch', false],
      ],
    ] as const) {
      const child = await exitedChild(body, failure)
      expect(
        await code(createManagedHostClient({ euid: () => euid, spawn: child.spawn }).call(host, REQUEST, rename))
      ).toEqual([...expected])
      expect(child.failed()).toBe(true)
    }
    const child = await exitedChild(
      reply({ ok: true, action: 'rename', physicalHostBinding: BINDING, receipt }),
      failure
    )
    const result = await createManagedHostClient({ euid: () => 998, spawn: child.spawn }).call(host, REQUEST, rename)
    expect('receipt' in result && result.receipt).toEqual(receipt)
    expect(child.failed()).toBe(true)
  }
})

test.each(stdinFailures)('a stdin failure still waits for exit under the existing deadline (%s)', async (failure) => {
  // cat cannot finish until stdin closes; the injected failure prevents that.
  const child = Bun.spawn(['/bin/cat'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  try {
    const failing = withStdinFailure(child, failure)
    expect(await code(rootClient({ spawn: failing.spawn, timeoutMs: () => 200 }).call(host, REQUEST, rename))).toEqual([
      'host_unreachable',
      true,
    ])
    expect(failing.failed()).toBe(true)
    await child.exited
    expect(child.signalCode).toBe('SIGKILL')
  } finally {
    child.kill('SIGKILL')
    await child.exited
  }
})
