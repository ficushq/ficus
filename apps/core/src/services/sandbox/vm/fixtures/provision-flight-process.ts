/** Separate API/worker VM managers: real DB/lease/first-contact cleanup, fake
 * physical install, tunnel and ready setup. Never opens SSH or touches a host. */
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { VmSandboxManager } from '../manager'
import { withVmSetupLease } from '../setup-state'
import type { Machine, MachineBox } from '../../../machines/queries'
import type { SandboxClient } from '../../client/http-client'

const [role, sandboxId, outcome] = process.argv.slice(2)
if (!role || !sandboxId) throw new Error('role and synthetic sandboxId required')
const emit = (event: string, extra = {}) => console.log(JSON.stringify({ role, pid: process.pid, event, ...extra }))
const release = Promise.withResolvers<void>()
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (line === 'release') release.resolve()
})
const machine = { id: 'synthetic-machine', name: 'synthetic-machine', status: 'ready' } as Machine
const box = {
  sandboxId,
  machineId: machine.id,
  unixUser: 'box_aaaaaaaaaaaa',
  port: 51234,
  status: 'ready',
  authToken: 'synthetic-only',
} as MachineBox
let provisioned = false
const manager = new VmSandboxManager({
  getBundleVersion: async () => 'synthetic-bundle',
  getBoxProvisionVersion: () => 'synthetic-script',
  getAppUrl: () => undefined,
  getSecret: () => undefined,
  resolveGitHubIdentity: async () => ({}),
  resolveMachine: async () => machine,
  resolveBoxApiUrl: async () => 'http://127.0.0.1:59999',
  ensureBox: async () => {
    provisioned = true
    emit('provision')
    await release.promise
    if (outcome === 'failure') throw new Error('synthetic owner failure')
    return { machine, box, endpoint: `http://127.0.0.1:${41000 + (process.pid % 10000)}` }
  },
  getMachineBox: async () => box,
  getMachine: async () => machine,
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
      bash() {
        const stream = new EventEmitter()
        queueMicrotask(() => {
          stream.emit('data', { exitCode: 0 })
          stream.emit('end')
        })
        return stream
      },
    }) as unknown as SandboxClient,
  syncBoxFiles: async () => {},
  // Ready setup avoids any command/tool installation; still runs the real
  // first-contact cleanup with the explicit client and durable acknowledgement.
  ensureSetupFingerprint: async (id, fingerprint) => ({
    sandboxId: id,
    desiredFingerprint: fingerprint,
    readiness: 'ready',
    reasons: [],
    attemptCount: 0,
    nextAttemptAt: null,
    pendingInvocationId: null,
    pendingInvocationKind: null,
    lastFailureClass: null,
    lastAttemptAt: null,
    updatedAt: new Date(),
  }),
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
  emit('result', { result: provisioned ? 'owner-ready' : 'joined-ready' })
} catch (error) {
  emit('failed', { error: error instanceof Error ? error.name : 'unknown' })
} finally {
  input.close()
  await manager.cleanup()
}
// Production helpers have awaited dedicated-session closure. Exit this synthetic
// process to close its remaining pooled clients; no child survives its test.
process.exit(0)
