/** Separate API/worker VM managers: real DB/lease/first-contact cleanup, fake
 * physical install, tunnel and ready setup. Never opens SSH or touches a host. */
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { VmSandboxManager } from '../manager'
import { withVmSetupLease } from '../setup-state'
import { vmProvisionLifecycle } from '../provision-flight'
import { getMachine, getMachineBox } from '../../../machines/queries'
import { boxUnixUser } from '../../../machines/box-manager'
import { db, machines, machineBoxes } from '../../../../db'
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { startupRetryCode } from '../../../execution/startup-retry'
import type { SandboxClient } from '../../client/http-client'

const [role, sandboxId, outcome] = process.argv.slice(2)
if (!role || !sandboxId) throw new Error('role and synthetic sandboxId required')
const emit = (event: string, extra = {}) => console.log(JSON.stringify({ role, pid: process.pid, event, ...extra }))
const release = Promise.withResolvers<void>()
const releaseSetup = Promise.withResolvers<void>()
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (line === 'release') release.resolve()
  if (line === 'release-setup') releaseSetup.resolve()
  if (line === 'shutdown') {
    void vmProvisionLifecycle
      .interrupt()
      .then(() => {
        emit('interrupted')
        release.resolve()
        releaseSetup.resolve()
      })
      .catch((error) => {
        emit('shutdown-failed', { detail: String(error) })
        process.exitCode = 1
      })
  }
})
// Real durable setup rows need a physical-row fixture. Derive a unique synthetic
// machine key from this test's random sandbox id, so two processes share it.
const key = createHash('sha256').update(sandboxId).digest('hex')
const machineId = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`
await db
  .insert(machines)
  .values({
    id: machineId,
    name: machineId,
    provider: 'ssh',
    status: 'ready',
    sshHost: '127.0.0.1',
    sshUser: 'test',
    sshKeyId: 'test',
    sshPublicKey: 'test',
  })
  .onConflictDoNothing()
await db
  .insert(machineBoxes)
  .values({
    sandboxId,
    machineId,
    unixUser: boxUnixUser(sandboxId),
    port: 51234,
    status: 'ensuring',
    authToken: 'synthetic-only',
  })
  .onConflictDoNothing()
const box = (await getMachineBox(sandboxId))!
const machine = (await getMachine(box.machineId))!
let provisioned = false
const manager = new VmSandboxManager({
  getBundleVersion: async () => 'synthetic-bundle',
  getBoxProvisionVersion: () => 'synthetic-script',
  getAppUrl: () => undefined,
  getSecret: () => undefined,
  resolveGitHubIdentity: async () => ({}),
  resolveMachine: async () => machine,
  resolveBoxApiUrl: async () => 'http://127.0.0.1:59999',
  ensureBox: async (opts) => {
    provisioned = true
    emit('provision')
    await release.promise
    if (outcome === 'failure') throw new Error('synthetic owner failure')
    const [ready] = await db
      .update(machineBoxes)
      .set({
        status: 'ready',
        authToken: 'synthetic-only',
        provisionedSpecHash: opts.specHash,
        // Success/fresh followers model truthful old-runtime publication. Keep
        // the existing unstamped legacy setup-failure fixture's repair contract.
        reconcilableSpecHash:
          outcome === 'setup-failure'
            ? null
            : opts.env.FICUS_BOX_SPEC_HASH!.replace(/:bun:\d+_\d+_\d+$/, ':bun:1_2_23'),
      })
      .where(eq(machineBoxes.sandboxId, sandboxId))
      .returning()
    return { machine, box: ready!, endpoint: `http://127.0.0.1:${41000 + (process.pid % 10000)}` }
  },
  getMachineBox,
  getMachine,
  ensureMaster: async () => {},
  addForward: async () => {
    emit('local-forward')
    return 41000 + (process.pid % 10000)
  },
  persistBoxActivity: async () => {},
  releaseMachineForwards: async () => {},
  createClient: () =>
    ({
      close() {},
      write: async () => {},
      devboxReady: async () => {},
      health: async () => ({ healthy: true, devboxReady: true }),
      bash() {
        const stream = new EventEmitter()
        queueMicrotask(() => {
          stream.emit('data', { exitCode: 0 })
          stream.emit('end')
        })
        return stream
      },
    }) as unknown as SandboxClient,
  syncBoxFiles: async () => {
    if (outcome === 'setup-failure') throw new Error('synthetic required-asset failure')
    emit('assets')
  },
  seedBoxDevbox: async () => {
    if (outcome === 'fresh') {
      emit('setup')
      await releaseSetup.promise
      emit('setup-complete', { at: Date.now() })
    }
    return {}
  },
  withSetupLease: (id, fn, wait) =>
    withVmSetupLease(id, fn, {
      ...wait,
      sleep: async (ms) => {
        emit('waiting')
        await Bun.sleep(ms)
      },
    }),
})
try {
  await manager.ensureSandbox(sandboxId, { workspacePath: '', k8s: { sandboxType: 'agent' } })
  if (outcome === 'fresh') {
    await manager.exec(sandboxId, ['bash', '-lc', 'true'])
    emit('first-bash', { at: Date.now() })
  }
  emit('result', { result: provisioned ? 'owner-ready' : 'joined-ready' })
} catch (error) {
  emit('failed', {
    error: error instanceof Error ? error.name : 'unknown',
    code: startupRetryCode(error),
    detail: String(error),
  })
} finally {
  input.close()
  await manager.cleanup()
}
// Production helpers have awaited dedicated-session closure. Exit this synthetic
// process to close its remaining pooled clients; no child survives its test.
process.exit(0)
