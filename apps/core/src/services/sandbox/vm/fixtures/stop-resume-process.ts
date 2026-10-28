/** Real cross-process lifecycle lease, stop orchestration and persisted proof;
 * only SSH unit readbacks and physical provisioning are synthetic. */
import { createInterface } from 'node:readline'
import { eq } from 'drizzle-orm'
import { db, machineBoxes } from '../../../../db'
import { getMachine, getMachineBox } from '../../../machines/queries'
import { stopBox } from '../../../machines/box-manager'
import { startupRetryCode } from '../../../execution/startup-retry'
import { VmSandboxManager } from '../manager'
import { withVmSetupLease, type VmSetupState } from '../setup-state'
import type { SandboxClient } from '../../client/http-client'

const [role, sandboxId] = process.argv.slice(2)
if (!role || !sandboxId) throw new Error('role and synthetic sandboxId required')
const emit = (event: string, extra = {}) => console.log(JSON.stringify({ role, pid: process.pid, event, ...extra }))
const release = Promise.withResolvers<void>()
const retry = Promise.withResolvers<void>()
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (line === 'release') release.resolve()
  if (line === 'release-setup') retry.resolve()
})
let stopCalls = 0
const readyState = (fingerprint = 'synthetic'): VmSetupState => ({
  sandboxId,
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
})
const manager = new VmSandboxManager({
  getMachineBox,
  getMachine,
  stopBox: (id) =>
    stopBox(id, {
      runner: {
        run: async (_machine, command) => {
          stopCalls++
          // The production operation must still use the host lock and both kinds
          // of unit readback. A synthetic exit 1 means no authoritative stop proof.
          if (!command.includes('flock') || !command.includes('UnitFileState') || !command.includes('ActiveState'))
            throw new Error('stop lost its authoritative fences')
          emit('stop-proof', { attempt: stopCalls })
          if (role === 'preempt') await release.promise
          const verified = role.startsWith('resume') && stopCalls > 1
          return { exitCode: verified ? 0 : 1, stdout: '', stderr: '' }
        },
      },
      tunnels: {
        ensureMaster: async () => {},
        addForward: async () => 41000,
        removeForward: async () => {},
        endpointFor: () => null,
        checkHealth: async () => true,
      },
    }),
  withSetupLease: (id, fn, wait) =>
    withVmSetupLease(id, fn, {
      ...wait,
      sleep: async (ms) => {
        emit('waiting')
        await Bun.sleep(ms)
      },
    }),
  getBundleVersion: async () => 'synthetic',
  getBoxProvisionVersion: () => 'synthetic',
  getAppUrl: () => undefined,
  getSecret: () => undefined,
  resolveGitHubIdentity: async () => ({}),
  resolveBoxApiUrl: async () => 'http://127.0.0.1:59999',
  resolveMachine: async () => {
    const box = await getMachineBox(sandboxId)
    return (await getMachine(box!.machineId))!
  },
  ensureBox: async () => {
    const box = (await getMachineBox(sandboxId))!
    if (box.status !== 'stopped') throw new Error(`Provision attempted without stop proof: ${box.status}`)
    emit('provision')
    const [ready] = await db
      .update(machineBoxes)
      .set({ status: 'ready' })
      .where(eq(machineBoxes.sandboxId, sandboxId))
      .returning()
    return { machine: (await getMachine(box.machineId))!, box: ready!, endpoint: 'http://127.0.0.1:41000', timings: {} }
  },
  createClient: () => ({ close() {} }) as SandboxClient,
  cleanupExposure: async () => {},
  persistBoxActivity: async () => {},
  releaseMachineForwards: async () => {},
  syncBoxFiles: async () => {},
  getSetupState: async () => readyState(),
  ensureSetupFingerprint: async (_id, fingerprint) => readyState(fingerprint),
})
try {
  if (role === 'preempt') {
    const result = await manager.stopSandbox(sandboxId)
    emit('stopped', { result: result.kind })
  } else {
    const options = { workspacePath: '', k8s: { sandboxType: 'agent' as const } }
    const ensure = () =>
      role === 'resume-ensure' ? manager.ensureSandbox(sandboxId, options) : manager.recreateSandbox(sandboxId, options)
    const error = await ensure().catch((error) => error)
    const code = startupRetryCode(error)
    if (code !== 'box_stop_unverified') throw new Error(`Expected bounded startup retry, received ${code}`)
    emit('startup-retry', { code })
    await retry.promise
    await ensure()
    emit('result', { result: 'resumed' })
  }
} catch (error) {
  emit('failed', { error: String(error) })
  process.exitCode = 1
} finally {
  input.close()
  await manager.cleanup()
}
process.exit(process.exitCode ?? 0)
