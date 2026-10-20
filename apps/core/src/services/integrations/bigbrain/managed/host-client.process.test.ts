import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANAGED_BIGBRAIN_DEFAULT_LIMITS, MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import { ManagedHostError, createManagedHostClient } from './host-client'
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
  origin: managedVaultOrigin(VAULT, 'example.com'),
  readAccess: 'active',
}
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
  const client = createManagedHostClient({ helperPath: fake.path })
  const result = await client.call(host, REQUEST, rename)
  expect('receipt' in result && result.receipt.vaultId).toBe(VAULT)
  expect(JSON.parse(await fake.stdin())).toEqual({ contractVersion: 1, requestId: REQUEST, ...host, ...rename })
})

test('an invalid request never starts the helper', async () => {
  const fake = await launcher('touch "$(dirname "$0")/started"')
  const client = createManagedHostClient({ helperPath: fake.path })
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
    expect(await code(createManagedHostClient({ helperPath: fake.path }).call(host, REQUEST, rename))).toEqual([
      ...expected,
    ])
  }
  expect(
    await code(createManagedHostClient({ helperPath: '/nonexistent/ficus-bigbrainctl' }).call(host, REQUEST, rename))
  ).toEqual(['not_installed', false])
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
      receipt: { ...receipt, vaultId: REQUEST, origin: managedVaultOrigin(REQUEST, 'example.com') },
    },
    { ok: true, action: 'rename', physicalHostBinding: BINDING, receipt: { ...receipt, tenantId: VAULT } },
    { ok: true, action: 'rename', physicalHostBinding: BINDING, receipt: { ...receipt, generation: 3 } },
    { ok: true, action: 'rename', physicalHostBinding: BINDING, receipt: { ...receipt, hostEpoch: 4 } },
  ]) {
    const fake = await launcher(
      `printf '%s\\n' '${JSON.stringify({ contractVersion: 1, requestId: REQUEST, ...bad })}'`
    )
    expect((await code(createManagedHostClient({ helperPath: fake.path }).call(host, REQUEST, rename)))[0]).toMatch(
      /identity_mismatch|invalid_response/
    )
  }
})

test('oversized output and deadlines kill the helper and report retryable codes', async () => {
  const big = await launcher('head -c 40000 /dev/zero | tr "\\0" "a"')
  expect(await code(createManagedHostClient({ helperPath: big.path }).call(host, REQUEST, rename))).toEqual([
    'output_limit',
    true,
  ])
  const slow = await launcher('sleep 5')
  const started = Date.now()
  expect(
    await code(createManagedHostClient({ helperPath: slow.path, timeoutMs: () => 200 }).call(host, REQUEST, rename))
  ).toEqual(['host_unreachable', true])
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
