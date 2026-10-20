import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANAGED_BIGBRAIN_DEFAULT_LIMITS, MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import { installedHostSchema } from './control-input'
import { dispatchHostRequest, GATEWAY_UNIT } from './control'
import { reservedVaultFixture } from './host-test-fixtures'
import { managedPaths } from './paths'
import { controlReceiptSchema } from './receipts'
import { ensureOwnedDirectory, readPrivateJson, writePrivateJson } from './secure-files'
import { imageJournalSchema, initializeStorageNamespace } from './volume-image'
import type { PrivateCommandRunner } from './process'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const TENANT = '11111111-1111-4111-8111-111111111111'
const BINDING = '33333333-3333-4333-8333-333333333333'
const A = '22222222-2222-4222-8222-222222222222'
const B = '44444444-4444-4444-8444-444444444444'
const REQ = '55555555-5555-4555-8555-555555555555'
const EFFECT = '66666666-6666-4666-8666-666666666666'
const envelope = (fields: object) => ({
  contractVersion: 1,
  tenantId: TENANT,
  physicalHostBinding: BINDING,
  hostEpoch: 1,
  requestId: REQ,
  ...fields,
})

async function fixture(options: { backupTimer?: boolean; gateway?: boolean; ready?: boolean } = {}) {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-control-'))
  roots.push(outer)
  const root = join(outer, 'state')
  const etc = join(outer, 'etc')
  await initializeStorageNamespace({ root, uid })
  await mkdir(etc, { mode: 0o700 })
  const base = reservedVaultFixture(root)
  await writePrivateJson(
    etc,
    'host.json',
    {
      contractVersion: 1,
      tenantId: TENANT,
      physicalHostBinding: BINDING,
      hostEpoch: 1,
      hostState: 'active',
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: base.receipt.artifactDigest,
      zone: 'example.com',
      limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
      effect: null,
    },
    installedHostSchema,
    { uid }
  )
  for (const [vaultId, phase] of [
    [A, 'ready'],
    [B, 'initialized'],
  ] as const) {
    const paths = managedPaths({ root, vaultId })
    await ensureOwnedDirectory(paths.control, 0o700, { uid })
    const image = await open(paths.image, 'wx', 0o600)
    await image.close()
    const info = await stat(paths.image)
    const record = controlReceiptSchema.parse({
      ...base,
      phase,
      receipt: {
        ...base.receipt,
        vaultId,
        upstreamVaultId: phase === 'ready' ? '77777777-7777-4777-8777-777777777777' : null,
        state: phase === 'ready' ? 'ready' : 'provisioning',
        origin: `https://bb-${vaultId.replaceAll('-', '')}.example.com`,
      },
      storage: {
        ...base.storage,
        vaultId,
        mount: paths.mount,
        image: paths.image,
        username: `bbv_${vaultId.replaceAll('-', '').slice(0, 24)}`,
      },
      os: { uid: 1200, gid: 1201, imageDevice: info.dev, imageInode: info.ino, mountDevice: '7:4' },
    })
    await writePrivateJson(paths.control, 'receipt.json', record, controlReceiptSchema, { uid })
    await writePrivateJson(
      paths.control,
      'image.json',
      {
        schema: 1,
        tenantId: TENANT,
        physicalHostBinding: BINDING,
        vaultId,
        creationRequestId: base.operation.requestId,
        creationHash: base.operation.inputHash,
        storage: record.storage,
        identity: { uid: 1200, gid: 1201 },
        image: { device: info.dev, inode: info.ino },
        formatted: true,
      },
      imageJournalSchema,
      { uid }
    )
  }
  const trace: string[] = []
  const run: PrivateCommandRunner = async (argv) => {
    if (argv[1] === 'is-enabled') return { code: options.backupTimer === false ? 1 : 0, stdout: '' }
    if (argv[1] === 'is-active') return { code: options.gateway === false ? 3 : 0, stdout: '' }
    if (argv[0] === '/usr/bin/systemctl' && (argv[1] === 'stop' || argv[1] === 'start'))
      trace.push(`${argv[1]}:${argv[2]}`)
    if (argv[0] === '/usr/sbin/losetup') return { code: 0, stdout: '{"loopdevices":[]}' }
    return { code: 0, stdout: '' }
  }
  const deps = {
    ingress: async () => void trace.push('ingress'),
    probeReady: async (socket: string) => {
      trace.push(`ready:${socket.split('/').at(-2)}`)
      return options.ready !== false
    },
    sleep: async () => {},
    root,
    etc,
    uid,
    run,
    now: () => Date.parse('2026-10-20T00:00:00Z'),
    mountinfo: async () => '',
    removeIdentity: async () => {},
    unitDirectory: join(outer, 'units'),
    tmpfilesDirectory: join(outer, 'tmpfiles.d'),
  }
  return { root, etc, deps, trace }
}
const host = (f: { etc: string }) => readPrivateJson(f.etc, 'host.json', installedHostSchema, { uid })

test('probe reports content-free availability and names the first unmet prerequisite', async () => {
  const ok = await fixture()
  const reply = await dispatchHostRequest(envelope({ action: 'probe' }), ok.deps)
  expect(reply).toMatchObject({
    ok: true,
    action: 'probe',
    capabilities: {
      available: true,
      reasonCode: null,
      installed: true,
      physicalHostBinding: BINDING,
      tenantLabel: null,
    },
  })
  expect(
    (await dispatchHostRequest(envelope({ action: 'probe' }), (await fixture({ backupTimer: false })).deps)) as object
  ).toMatchObject({ capabilities: { available: false, reasonCode: 'backup_unavailable' } })
  expect(
    (await dispatchHostRequest(envelope({ action: 'probe' }), (await fixture({ gateway: false })).deps)) as object
  ).toMatchObject({ capabilities: { available: false, reasonCode: 'upstream_unavailable' } })
  await rm(join(ok.etc, 'host.json'))
  expect(await dispatchHostRequest(envelope({ action: 'probe' }), ok.deps)).toMatchObject({
    ok: false,
    code: 'not_installed',
  })
})

test('foreign binding, stale epoch and malformed input fail closed with allowlisted codes only', async () => {
  const f = await fixture()
  expect(await dispatchHostRequest(envelope({ action: 'probe', physicalHostBinding: B }), f.deps)).toMatchObject({
    ok: false,
    code: 'identity_mismatch',
  })
  expect(await dispatchHostRequest(envelope({ action: 'probe', hostEpoch: 0 }), f.deps)).toMatchObject({
    ok: false,
    code: 'generation_conflict',
  })
  const bad = await dispatchHostRequest({ requestId: 'not-a-uuid', action: 'probe', path: '/etc/shadow' }, f.deps)
  expect(bad).toEqual({
    contractVersion: 1,
    requestId: '00000000-0000-4000-8000-000000000000',
    ok: false,
    code: 'invalid_request',
    retryable: false,
  })
})

test('suspend persists the new epoch/effect before stopping ingress and vaults; exact replay is a no-op; resume restarts only serving vaults', async () => {
  const f = await fixture()
  const suspend = envelope({ action: 'suspend-tenant', hostEpoch: 2, previousHostEpoch: 1, effectId: EFFECT })
  expect(await dispatchHostRequest(suspend, f.deps)).toMatchObject({ ok: true, hostEpoch: 2, completed: true })
  expect(f.trace).toEqual([
    'ingress',
    `stop:${GATEWAY_UNIT}`,
    `stop:ficus-bigbrain@${A}.service`,
    `stop:ficus-bigbrain@${B}.service`,
  ])
  expect(await host(f)).toMatchObject({
    hostEpoch: 2,
    hostState: 'suspended',
    effect: { effectId: EFFECT, completed: true },
  })
  f.trace.length = 0
  expect(await dispatchHostRequest(suspend, f.deps)).toMatchObject({ ok: true, hostEpoch: 2 })
  expect(f.trace).toEqual([])
  // While suspended, vault mutations are refused at admission.
  expect(await dispatchHostRequest(envelope({ action: 'probe', hostEpoch: 2 }), f.deps)).toMatchObject({
    capabilities: { available: false, reasonCode: 'forbidden' },
  })
  const resume = envelope({
    action: 'resume-tenant',
    hostEpoch: 3,
    previousHostEpoch: 2,
    effectId: '88888888-8888-4888-8888-888888888888',
  })
  expect(await dispatchHostRequest(resume, f.deps)).toMatchObject({ ok: true, hostEpoch: 3 })
  // Resume waits until each serving vault answers on its socket before republishing ingress.
  expect(f.trace).toEqual([`start:${GATEWAY_UNIT}`, `start:ficus-bigbrain@${A}.service`, `ready:${A}`, 'ingress'])
  expect(await host(f)).toMatchObject({ hostEpoch: 3, hostState: 'active' })
})

test('a resumed vault that never answers fails the effect, leaving it incomplete for a retry', async () => {
  const f = await fixture({ ready: false })
  const suspend = envelope({ action: 'suspend-tenant', hostEpoch: 2, previousHostEpoch: 1, effectId: EFFECT })
  expect(await dispatchHostRequest(suspend, f.deps)).toMatchObject({ ok: true })
  const resume = envelope({
    action: 'resume-tenant',
    hostEpoch: 3,
    previousHostEpoch: 2,
    effectId: '88888888-8888-4888-8888-888888888888',
  })
  expect(await dispatchHostRequest(resume, f.deps)).toMatchObject({ ok: false, code: 'upstream_unavailable' })
  expect(await host(f)).toMatchObject({ hostEpoch: 3, effect: { completed: false } })
})

test('delete is fenced by exact name and generation, then removes only that vault and replays', async () => {
  const f = await fixture()
  const request = envelope({
    action: 'delete',
    vaultId: A,
    expectedGeneration: 1,
    generation: 2,
    confirmedVaultId: A,
    confirmedName: 'Research',
  })
  expect(await dispatchHostRequest({ ...request, confirmedName: 'Other' }, f.deps)).toMatchObject({
    ok: false,
    code: 'identity_mismatch',
  })
  expect(await dispatchHostRequest({ ...request, expectedGeneration: 5, generation: 6 }, f.deps)).toMatchObject({
    ok: false,
    code: 'generation_conflict',
  })
  const reply = await dispatchHostRequest(request, f.deps)
  expect(reply).toMatchObject({
    ok: true,
    action: 'delete',
    receipt: { vaultId: A, state: 'deleted', generation: 2, readAccess: 'revoked' },
  })
  expect(await dispatchHostRequest(request, f.deps)).toEqual(reply)
  expect(await dispatchHostRequest(envelope({ action: 'status', vaultId: A }), f.deps)).toMatchObject({
    ok: true,
    receipt: { state: 'deleted' },
  })
  expect(await dispatchHostRequest(envelope({ action: 'status', vaultId: B }), f.deps)).toMatchObject({
    ok: true,
    receipt: { state: 'provisioning' },
  })
  await expect(stat(managedPaths({ root: f.root, vaultId: B }).image)).resolves.toBeDefined()
  expect(
    await dispatchHostRequest(envelope({ action: 'status', vaultId: '99999999-9999-4999-8999-999999999999' }), f.deps)
  ).toMatchObject({ ok: false, code: 'not_found' })
})

test('restore-fence closes ingress, advances the epoch and returns only the verified staged inventory', async () => {
  const f = await fixture()
  const fence = envelope({ action: 'restore-fence', hostEpoch: 2, previousHostEpoch: 1, effectId: EFFECT })
  // Nothing staged: the fence still closes ingress but cannot invent an inventory.
  expect(await dispatchHostRequest(fence, f.deps)).toMatchObject({ ok: false, code: 'storage_unavailable' })
  expect(f.trace.slice(0, 2)).toEqual(['ingress', `stop:${GATEWAY_UNIT}`])
  expect(await host(f)).toMatchObject({ hostEpoch: 2, effect: { action: 'restore-fence', completed: true } })
})

test('unknown actions and caller-supplied commands are refused by the strict request schema', async () => {
  const f = await fixture()
  expect(await dispatchHostRequest(envelope({ action: 'exec', command: 'id' }), f.deps)).toMatchObject({
    ok: false,
    code: 'invalid_request',
  })
  expect(await dispatchHostRequest(envelope({ action: 'status', vaultId: A, path: '/etc' }), f.deps)).toMatchObject({
    ok: false,
    code: 'invalid_request',
  })
})
