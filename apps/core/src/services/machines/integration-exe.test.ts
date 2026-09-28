import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { expandTilde } from '@ficus/shared/node'
import { randomUUID } from 'crypto'
import { mkdtempSync, readFileSync } from 'fs'
import { Hono } from 'hono'
import { tmpdir } from 'os'
import { join } from 'path'
import { identityMiddleware } from '../../middleware/identity'
import { createMachinesRouter } from '../../routes/machines'
import { authHeaders, cleanupTestRbac, createTestAdmin, type TestUser } from '../../test-utils'
import { SandboxClient, type BashResponse } from '../sandbox/k8s/http-client'
import { bootstrapMachine } from './bootstrap'
import { ensureBox, removeBox } from './box-manager'
import { getMachineProvider } from './provider'
import { EXE_PROVIDER_SSH_KEY } from './provider-credentials'
import { registerBuiltinMachineProviders } from './providers/index'
import { getMachine, type Machine } from './queries'
import { getSecretStore, resetSecretStore } from '../secrets'
import { createSshRunner, type SshRunner } from './ssh'
import { MachineTunnelManager } from './tunnel-manager'

/**
 * ============================================================================
 * exe.dev provider — end-to-end integration test (GATED, SLOW, REAL MONEY/VM)
 * ============================================================================
 *
 * Exercises the REAL exe.dev lobby (`providers/exe-api.ts`'s `defaultExeExec`)
 * against a live exe.dev account: POST /api/machines with `provider:'exe'` →
 * SSH into the freshly-provisioned VM using the ACCOUNT SSH key (materialized
 * from the row's `sshKeyId`, which points at the shared `EXE_PROVIDER_SSH_KEY`
 * secret — exe rejects per-VM keys, so the account key is every VM's identity) →
 * bootstrap it for real → one `box-manager.ensureBox` + a `/bash` round-trip
 * (the SAME production box flow the SSH-gated `integration-vm.test.ts` exercises
 * against a disposable container, here against a real systemd VM) → tear the box
 * down → DELETE /api/machines/:id (which calls `provider.terminate` →
 * `destroyVm`) → assert the VM is genuinely gone via `provider.status`.
 *
 * This is the ONLY validation of exe.dev's real wire format anywhere in the
 * codebase — every other exe test (exe-api.test.ts, exe.test.ts,
 * placement.test.ts) runs against a FAKE `ExeApi`/`ExeExec`.
 *
 * ----------------------------------------------------------------------------
 * Separate gate from `integration-vm.test.ts`'s `FICUS_TEST_SSH_HOST`: this test
 * needs a real exe.dev account. The credential is the account's SSH PRIVATE key
 * (Settings → SSH keys on exe.dev), supplied as a FILE PATH. To run:
 *
 *   FICUS_TEST_EXE_SSH_KEY=~/.ssh/tau-exe-test \
 *   FICUS_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) \
 *   bun test src/services/machines/integration-exe.test.ts
 *
 * The test provisions ONE real VM, uses it for the whole flow, and destroys it
 * in the same `it()` (best-effort cleanup in `afterAll` too, in case an
 * assertion throws mid-flow). It costs real exe.dev usage; do not run it in CI.
 * Skipped-mode collection (no `FICUS_TEST_EXE_SSH_KEY`) does ZERO exe.dev network
 * calls and creates ZERO DB rows — `describe.skipIf` skips `beforeAll`/`afterAll`
 * too, so nothing in this file executes without the gate.
 *
 * ----------------------------------------------------------------------------
 * VERIFIED-API checklist (apps/core/src/services/machines/providers/exe-api.ts,
 * cited `// VERIFIED (live recon 2026-07-13)`). What THIS test re-validates
 * end-to-end against a live account:
 *
 *   1. Lobby host + subcommand grammar (`ssh exe.dev new|ls|rm --json`)
 *      → EXERCISED: every step below only succeeds if `new`, `ls` (via
 *        provider.status), and `rm` (via terminate) all resolve.
 *   2. `new --name <name> --json` output shape (`vm_name`/`ssh_dest`/`ssh_port`)
 *      → EXERCISED: step 1 asserts the response carries a usable SSH endpoint.
 *   3. SSH host fallback `<vm_name>.exe.xyz` when `ssh_dest` is absent, port 22
 *      default → exercised IFF the real response omits them (assert the connect
 *      works either way).
 *   4. SSH user is always `exedev`                                   → EXERCISED: the
 *      SSH-in step connects as the row's `sshUser` (provider hardcodes `exedev`).
 *   5. Account-key auth (per-VM keys REJECTED; account key reaches every VM)
 *      → THE CRUX: step 2 SSHes in using the account key materialized from the
 *        row's `sshKeyId` (the shared `EXE_PROVIDER_SSH_KEY`). No pubkey was
 *        injected at create; if the account-key model were wrong this fails with
 *        an SSH auth error.
 *   6. `ls --json` `.vms` object/array shape                         → EXERCISED at
 *      teardown: `provider.status` after `destroyVm` must observe the VM absent.
 *   7. `rm <vm_name>` destroys the VM (happy path)                    → EXERCISED via
 *      the DELETE route → terminate.
 * ============================================================================
 */

/** Generous wall-clock bound: real VM boot + apt + bun install can take minutes. */
const SLOW_MS = 15 * 60 * 1000

const prefix = `mach-exe-int-${Date.now()}`

/** Collect a `/bash` command's stdout to completion (rejects on stream error). */
function bashCollect(client: SandboxClient, command: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let exitCode = 0
    const stream = client.bash({ command })
    stream.on('data', (r: BashResponse) => {
      if (r.stdout) chunks.push(Buffer.from(r.stdout, 'base64'))
      if (r.error) reject(new Error(r.error))
      if (r.exitCode !== undefined) exitCode = r.exitCode
    })
    stream.on('error', (err: Error) => reject(err))
    stream.on('end', () => resolve({ stdout: Buffer.concat(chunks).toString(), exitCode }))
  })
}

describe.skipIf(!process.env.FICUS_TEST_EXE_SSH_KEY)('exe.dev provider (integration, real exe.dev VM)', () => {
  let priorKey: string | undefined
  let priorHome: string | undefined
  let admin: TestUser
  let runner: SshRunner
  let mgr: MachineTunnelManager
  let router: Hono

  /** The provisioned machine row (populated once step 1 succeeds), for best-effort teardown. */
  let machine: Machine | undefined
  const sandboxId = `agent_exeint_${Date.now()}`

  beforeAll(async () => {
    priorHome = process.env.HOME_DIR
    process.env.HOME_DIR = mkdtempSync(join(tmpdir(), 'tau-exe-int-home-'))
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
    resetSecretStore()
    await getSecretStore().initialize()

    // Configure the exe.dev account SSH private key in the secret store — the same
    // key production reads (provider-credentials.ts's EXE_PROVIDER_SSH_KEY) — by
    // reading the key FILE the gate points at, then register the real exe provider
    // (real defaultExeExec, real network).
    const accountKey = readFileSync(expandTilde(process.env.FICUS_TEST_EXE_SSH_KEY!), 'utf8')
    await getSecretStore().set(EXE_PROVIDER_SSH_KEY, accountKey, 'system')
    await registerBuiltinMachineProviders()

    admin = await createTestAdmin({ prefix })
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.route('/', createMachinesRouter())
    router = app

    runner = createSshRunner({ defaultTimeoutMs: SLOW_MS })
    mgr = new MachineTunnelManager({ controlDir: mkdtempSync(join('/tmp', 'tau-exeint-ctl-')) })
  })

  afterAll(async () => {
    // Best-effort teardown in case a mid-test assertion threw before the
    // in-test DELETE ran — a stray real exe.dev VM left behind is exactly the
    // failure mode a "gated, real money" integration test must guard against.
    try {
      await mgr?.stop()
    } catch {
      /* best-effort */
    }
    try {
      if (machine) await removeBox(sandboxId, { archivePrivate: false }, { runner, tunnels: mgr })
    } catch {
      /* best-effort — box may already be torn down by the main flow */
    }
    try {
      if (machine) await getMachineProvider('exe').terminate(machine)
    } catch {
      /* best-effort — VM may already be destroyed by the main flow's DELETE */
    }
    // The account key is shared across every exe machine; drop it only here in
    // teardown (the DELETE route deliberately never deletes it — see machines.ts).
    try {
      await getSecretStore().delete(EXE_PROVIDER_SSH_KEY)
    } catch {
      /* best-effort */
    }
    await cleanupTestRbac(prefix)
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    if (priorHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = priorHome
    resetSecretStore()
  })

  it(
    'provisions a real exe VM, SSHes in with the account key, bootstraps, ensures a box, execs, and DELETE destroys the VM',
    async () => {
      // ── 1. Provision via the REAL route: POST /api/machines provider:'exe'. ──
      // Validates checklist #1 (lobby grammar), #2 (new --json shape), #3
      // (host/port defaults), #4 (exedev user) — the whole call only succeeds if
      // the real lobby round-trip works end to end.
      const createRes = await router.request('/', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${prefix}-vm`, provider: 'exe' }),
      })
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()) as { id: string; provider: string; providerRef: string | null }
      expect(created.provider).toBe('exe')
      expect(created.providerRef).toBeTruthy()

      // Re-fetch the full row directly (the route strips sshKeyId from the
      // response), and hang onto it for afterAll's best-effort teardown.
      const fetched = await getMachine(created.id)
      if (!fetched) throw new Error('provisioned machine row vanished immediately after insert')
      machine = fetched
      expect(machine.sshHost).toBeTruthy()
      expect(machine.sshPort).toBeGreaterThan(0)
      expect(machine.sshUser).toBe('exedev')
      // The row references the SHARED account-key secret, not a per-machine one.
      expect(machine.sshKeyId).toBe(EXE_PROVIDER_SSH_KEY)

      // ── 2. SSH in with the ACCOUNT key (materialized from sshKeyId) — the crux. ─
      // Validates checklist #5 (account-key auth). No pubkey was injected at
      // create; if the account key did NOT reach the VM this throws (SSH auth
      // failure) rather than silently succeeding.
      const echo = await runner.run(machine, 'echo account-key-ok')
      expect(echo.exitCode).toBe(0)
      expect(echo.stdout).toContain('account-key-ok')

      // ── 3. Bootstrap for real (production defaults — real DB row updates). ──
      const caps = await bootstrapMachine(machine, { runner })
      expect(caps).toBeTruthy()
      const bootstrapped = await getMachine(machine.id)
      if (!bootstrapped) throw new Error('machine row vanished after bootstrap')
      machine = bootstrapped
      expect(machine.status).toBe('ready')

      // ── 4. One box ensure + exec round-trip — the SAME production box flow
      //       integration-vm.test.ts exercises against a container, here against
      //       a real systemd VM (so, unlike that file, the FULL box-provision.sh
      //       systemd path runs for real, not just the unit-free workaround). ──
      const { endpoint } = await ensureBox(
        { sandboxId, machineId: machine.id, env: {}, role: 'agent' },
        { runner, tunnels: mgr }
      )
      const client = new SandboxClient(endpoint.replace(/^https?:\/\//, ''))
      await client.waitForReady(60_000)
      const health = await client.health()
      expect(health.healthy).toBe(true)

      const nonce = randomUUID()
      const exec = await bashCollect(client, `echo box-echo-${nonce}`)
      expect(exec.exitCode).toBe(0)
      expect(exec.stdout).toContain(`box-echo-${nonce}`)
      client.close()

      // ── 5. Tear the box down so DELETE's "no active boxes" guard passes. ────
      await removeBox(sandboxId, { archivePrivate: false }, { runner, tunnels: mgr })

      // ── 6. DELETE /api/machines/:id → provider.terminate → destroyVm. ───────
      // Validates checklist #7 (rm grammar/happy path).
      const deleteRes = await router.request(`/${machine.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })
      expect(deleteRes.status).toBe(204)

      // ── 7. getVm → gone: the VM is genuinely destroyed, not just forgotten. ──
      // Validates checklist #6 (ls --json `.vms` shape) and the "absent ⇒ gone" map.
      const status = await getMachineProvider('exe').status(machine)
      expect(status).toBe('gone')

      // The DELETE guard must NOT have deleted the shared account key — other exe
      // VMs depend on it. It should still be present after the delete.
      expect(getSecretStore().get(EXE_PROVIDER_SSH_KEY)).toBeTruthy()

      // Machine row itself is gone too (DELETE route's own contract).
      expect(await getMachine(machine.id)).toBeNull()
      // Clear so afterAll's best-effort teardown doesn't try to re-terminate.
      machine = undefined
    },
    SLOW_MS
  )
})
