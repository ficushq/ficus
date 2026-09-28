import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { expandTilde } from '@ficus/shared/node'
import { randomUUID } from 'crypto'
import { mkdtempSync } from 'fs'
import { Hono } from 'hono'
import { tmpdir } from 'os'
import { join } from 'path'
import { identityMiddleware } from '../../middleware/identity'
import { createMachinesRouter } from '../../routes/machines'
import { authHeaders, cleanupTestRbac, createTestAdmin, type TestUser } from '../../test-utils'
import { SandboxClient, type BashResponse } from '../sandbox/k8s/http-client'
import { boxUnixUser, ensureBox, removeBox } from './box-manager'
import { getMachine, getMachineBox, type Machine } from './queries'
import { getSecretStore, resetSecretStore } from '../secrets'
import { createSshRunner, type SshRunner } from './ssh'
import { MachineTunnelManager } from './tunnel-manager'

/**
 * ============================================================================
 * BYO-SSH provider — end-to-end integration test (GATED, SLOW, REAL VM)
 * ============================================================================
 *
 * The BYO complement to `integration-exe.test.ts`: exercises the full OPERATOR
 * flow against a real cloud VM the operator already controls (a fresh Ubuntu
 * 24.04 droplet/instance — anything with root-or-sudoer SSH):
 *
 *   POST /api/machines (BYO: tau MINTS a per-machine ed25519 keypair) →
 *   operator installs the returned public key by hand (simulated here over the
 *   operator's own key) → SSH in using tau's MINTED key (the BYO crux —
 *   integration-vm.test.ts always used the operator's key directly, so the
 *   minted-key round-trip had never run against a real VM) →
 *   POST /:id/bootstrap (the FULL install path: apt + docker-ce + bun + nix +
 *   devbox — a bare BYO host has no /opt/tau/prebaked marker, so this is the
 *   multi-minute path every BYO customer actually hits; the exe test only
 *   covers the prebaked fast-path) →
 *   MULTI-USER: two boxes on the ONE machine — an `agent` (light) box and a
 *   `squad` box (--with-docker, its own rootless dockerd) — asserting the
 *   boxes-as-users isolation model for real: distinct unix users/ports, box A
 *   cannot read box B's ~/.private, per-box docker with working container
 *   egress, and removing one box leaves the other healthy →
 *   DELETE /api/machines/:id — which for BYO does NOT touch the VM (the
 *   operator owns it) but DOES delete the per-machine key secret (the exact
 *   opposite of the exe path's shared-account-key guard).
 *
 * ----------------------------------------------------------------------------
 * Separate gate from integration-vm.test.ts's FICUS_TEST_SSH_HOST (a disposable
 * CONTAINER, no systemd) and integration-exe.test.ts's FICUS_TEST_EXE_SSH_KEY (a
 * tau-provisioned exe VM): this needs a real systemd VM the operator supplies.
 * To run (host = a FRESH Ubuntu 24.04 VM you can root-SSH; the test installs
 * real packages on it and creates/removes box users — treat it as disposable):
 *
 *   FICUS_TEST_BYO_SSH_HOST=<ip> \
 *   FICUS_TEST_BYO_SSH_KEY=~/.ssh/<key with root access to it> \
 *   FICUS_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) \
 *   bun test src/services/machines/integration-byo.test.ts
 *
 * Optional: FICUS_TEST_BYO_SSH_PORT (default 22), FICUS_TEST_BYO_SSH_USER (default
 * root — a passwordless sudoer works too, mirroring bootstrap.sh's contract).
 *
 * The VM itself is NOT destroyed (BYO semantics — the operator owns it); the
 * test removes everything it creates ON the VM (both box users, archives stay
 * under /opt/tau/archive) and deletes the machine row + minted secret. Skipped-
 * mode collection (no gate) runs nothing: describe.skipIf skips beforeAll too.
 * ============================================================================
 */

/** Full install on a small cloud VM (apt+docker+bun+nix+devbox) takes minutes. */
const SLOW_MS = 30 * 60 * 1000

const prefix = `mach-byo-int-${Date.now()}`

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

describe.skipIf(!process.env.FICUS_TEST_BYO_SSH_HOST)('BYO-SSH provider (integration, real VM)', () => {
  const host = process.env.FICUS_TEST_BYO_SSH_HOST!
  const port = Number(process.env.FICUS_TEST_BYO_SSH_PORT ?? 22)
  const user = process.env.FICUS_TEST_BYO_SSH_USER ?? 'root'

  let priorKey: string | undefined
  let priorHome: string | undefined
  let admin: TestUser
  let runner: SshRunner
  let mgr: MachineTunnelManager
  let router: Hono

  /** Populated once registration succeeds, for best-effort teardown. */
  let machine: Machine | undefined
  const agentSandboxId = `agent_byoint_${Date.now()}`
  const squadSandboxId = `squad_byoint_${Date.now()}`

  /**
   * Run a command on the VM as the OPERATOR (their own key) — the one thing a
   * BYO operator does out-of-band: installing tau's minted public key. Every
   * other SSH in this test goes through tau's runner with tau's MINTED key.
   */
  function operatorSsh(command: string, stdin?: string): { exitCode: number; stderr: string } {
    const keyPath = expandTilde(process.env.FICUS_TEST_BYO_SSH_KEY!)
    const proc = Bun.spawnSync(
      [
        'ssh',
        '-i',
        keyPath,
        '-p',
        String(port),
        '-o',
        'IdentityAgent=none',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=15',
        `${user}@${host}`,
        command,
      ],
      { stdin: stdin ? Buffer.from(stdin) : undefined }
    )
    return { exitCode: proc.exitCode, stderr: proc.stderr.toString() }
  }

  beforeAll(async () => {
    priorHome = process.env.HOME_DIR
    process.env.HOME_DIR = mkdtempSync(join(tmpdir(), 'tau-byo-int-home-'))
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
    resetSecretStore()
    await getSecretStore().initialize()

    admin = await createTestAdmin({ prefix })
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.route('/', createMachinesRouter())
    router = app

    runner = createSshRunner({ defaultTimeoutMs: SLOW_MS })
    mgr = new MachineTunnelManager({ controlDir: mkdtempSync(join('/tmp', 'tau-byoint-ctl-')) })
  })

  afterAll(async () => {
    // Best-effort teardown in case an assertion threw mid-flow: box users left
    // on the operator's VM and an orphaned minted secret are the failure modes
    // to guard. The VM itself is never touched (BYO — the operator owns it).
    try {
      await mgr?.stop()
    } catch {
      /* best-effort */
    }
    for (const sandboxId of [agentSandboxId, squadSandboxId]) {
      try {
        if (machine) await removeBox(sandboxId, { archivePrivate: false }, { runner, tunnels: mgr })
      } catch {
        /* best-effort — may already be removed by the main flow */
      }
    }
    try {
      if (machine) {
        await router.request(`/${machine.id}`, { method: 'DELETE', headers: authHeaders(admin.token) })
      }
    } catch {
      /* best-effort — may already be deleted by the main flow */
    }
    await cleanupTestRbac(prefix)
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    if (priorHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = priorHome
    resetSecretStore()
  })

  it(
    'proves BYO bootstrap, box isolation, foreground idle safety, detached cleanup, and socket restart',
    async () => {
      // ── 1. Register via the REAL route. BYO mints a per-machine keypair and
      //       returns the PUBLIC key for the operator to install. ─────────────
      const createRes = await router.request('/', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${prefix}-vm`, sshHost: host, sshPort: port, sshUser: user }),
      })
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()) as { id: string; provider: string; sshPublicKey: string; status: string }
      expect(created.provider).toBe('ssh')
      expect(created.status).toBe('registered')
      expect(created.sshPublicKey).toStartWith('ssh-ed25519 ')

      const fetched = await getMachine(created.id)
      if (!fetched) throw new Error('registered machine row vanished immediately after insert')
      machine = fetched
      // The row references the MINTED per-machine secret (BYO), not a shared key
      // (`machine-ssh:<machineId>` — keys.ts's naming convention).
      expect(machine.sshKeyId).toBe(`machine-ssh:${machine.id}`)
      expect(getSecretStore().get(machine.sshKeyId)).toBeTruthy()

      // ── 2. OPERATOR STEP (the by-hand part of BYO): install tau's minted
      //       public key into the VM's authorized_keys, using the operator's
      //       own key. This is the only operator-key SSH in the test. ─────────
      const install = operatorSsh(
        'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys',
        `${created.sshPublicKey}\n`
      )
      expect(install.exitCode).toBe(0)

      // ── 3. SSH in with tau's MINTED key (materialized from the machine row's
      //       sshKeyId) — the BYO crux no other test covers on a real VM. ─────
      const echo = await runner.run(machine, 'echo minted-key-ok')
      expect(echo.exitCode).toBe(0)
      expect(echo.stdout).toContain('minted-key-ok')

      // A bare BYO host must NOT carry the prebaked marker — the point of this
      // test is the FULL install path (the exe test covers the fast-path).
      const marker = await runner.run(machine, 'test -f /opt/tau/prebaked && echo yes || echo no')
      expect(marker.stdout).toContain('no')

      // ── 4. Bootstrap via the REAL route: the full multi-minute install. ────
      const bootRes = await router.request(`/${machine.id}/bootstrap`, {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(bootRes.status).toBe(200)
      const booted = (await bootRes.json()) as {
        status: string
        capabilities: { docker: string; forwarding: string; arch: string } | null
      }
      expect(booted.status).toBe('ready')
      expect(booted.capabilities?.docker).toBe('rootless')
      expect(booted.capabilities?.forwarding).toBe('yes')
      machine = (await getMachine(machine.id)) as Machine

      // ── 5. MULTI-USER: two boxes on the one machine — a light agent box and
      //       a squad box with its own rootless dockerd. ──────────────────────
      const agentBox = await ensureBox(
        {
          sandboxId: agentSandboxId,
          machineId: machine.id,
          env: { EXECUTOR_IDLE_EXIT_MS: '35000' },
          role: 'agent',
        },
        { runner, tunnels: mgr }
      )
      const squadBox = await ensureBox(
        { sandboxId: squadSandboxId, machineId: machine.id, env: {}, role: 'squad' },
        { runner, tunnels: mgr }
      )
      // Same machine, different unix users, different ports.
      expect(agentBox.machine.id).toBe(machine.id)
      expect(squadBox.machine.id).toBe(machine.id)
      expect(agentBox.box.port).not.toBe(squadBox.box.port)
      const agentUser = boxUnixUser(agentSandboxId)
      const squadUser = boxUnixUser(squadSandboxId)
      expect(agentUser).not.toBe(squadUser)

      const agentClient = new SandboxClient(agentBox.endpoint.replace(/^https?:\/\//, ''))
      const squadClient = new SandboxClient(squadBox.endpoint.replace(/^https?:\/\//, ''))
      await agentClient.waitForReady(60_000)
      await squadClient.waitForReady(60_000)
      expect((await agentClient.health()).healthy).toBe(true)
      expect((await squadClient.health()).healthy).toBe(true)

      // Each server runs AS its own box user.
      const agentNonce = randomUUID()
      const agentExec = await bashCollect(agentClient, `id -un && echo box-echo-${agentNonce}`)
      expect(agentExec.exitCode).toBe(0)
      expect(agentExec.stdout).toContain(agentUser)
      expect(agentExec.stdout).toContain(`box-echo-${agentNonce}`)
      const squadWho = await bashCollect(squadClient, 'id -un')
      expect(squadWho.stdout).toContain(squadUser)

      // ── 6. ISOLATION: box A cannot read box B's private tree (0700). ───────
      const ownPerms = await bashCollect(agentClient, 'stat -c %a "$HOME/.private"')
      expect(ownPerms.stdout.trim()).toBe('700')
      const cross = await bashCollect(agentClient, `ls /home/${squadUser}/.private 2>&1; echo exit=$?`)
      expect(cross.stdout).toContain('Permission denied')
      expect(cross.stdout).not.toContain('exit=0')
      // Box users are NOT sudoers — the privilege boundary that makes 0700 real.
      const sudoTry = await bashCollect(agentClient, 'sudo -n true 2>&1; echo exit=$?')
      expect(sudoTry.stdout).not.toContain('exit=0')

      // ── 7. Squad box docker: its OWN rootless daemon answers, and a container
      //       has working egress (regression net for the nf_tables/--skip-
      //       iptables handling — must be a no-op on a stock Ubuntu kernel). ──
      const dockerInfo = await bashCollect(squadClient, 'docker info >/dev/null 2>&1 && echo DOCKER_OK')
      expect(dockerInfo.stdout).toContain('DOCKER_OK')
      const egress = await bashCollect(
        squadClient,
        `docker run --rm alpine sh -c 'nc -z -w8 1.1.1.1 443 && echo NET_OK' 2>&1 | tail -1`
      )
      expect(egress.stdout).toContain('NET_OK')
      // The light agent box got NO docker daemon (roleWantsDocker excludes it).
      const agentDocker = await bashCollect(agentClient, 'docker info >/dev/null 2>&1 && echo YES || echo NO_DAEMON')
      expect(agentDocker.stdout).toContain('NO_DAEMON')

      // ── 8. REAL SOCKET/CGROUP CONTRACT: foreground work needs no probes;
      //       detached work is warned, killed by systemd, and not recovered. ──
      const unit = `tau-box-${agentUser}.service`
      const proxy = `tau-box-${agentUser}-proxy.service`
      const waitForUnitState = async (name: string, expected: string, timeoutMs = 60_000) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const state = await runner.run(machine!, `systemctl is-active ${name} 2>/dev/null || true`)
          if (state.stdout.trim() === expected) return
          await Bun.sleep(1_000)
        }
        throw new Error(`test box unit did not reach ${expected}`)
      }

      const foreground = bashCollect(agentClient, 'sleep 40; echo FOREGROUND_DONE')
      await Bun.sleep(37_000)
      await waitForUnitState(unit, 'active', 5_000)
      expect((await foreground).stdout).toContain('FOREGROUND_DONE')
      agentClient.close()
      await waitForUnitState(unit, 'inactive')

      const restartedClient = new SandboxClient(agentBox.endpoint.replace(/^https?:\/\//, ''))
      await restartedClient.waitForReady(30_000)
      expect((await bashCollect(restartedClient, 'echo SOCKET_RESTARTED')).stdout).toContain('SOCKET_RESTARTED')

      const canary = `SECRET_${randomUUID()}`
      const detachedMarker = `idle-cgroup-${randomUUID()}`
      const detached = await bashCollect(
        restartedClient,
        `setsid env ${canary}=present sh -c 'sleep 120' >/dev/null 2>&1 & echo $! > "$HOME/.tau/${detachedMarker}.pid"`
      )
      expect(detached.exitCode).toBe(0)
      restartedClient.close()
      await waitForUnitState(unit, 'inactive')
      await waitForUnitState(proxy, 'inactive')

      const cleanupProof = await runner.run(
        machine,
        `pid=$(cat /home/${agentUser}/.tau/${detachedMarker}.pid); if kill -0 "$pid" 2>/dev/null; then echo alive; else echo gone; fi`
      )
      expect(cleanupProof.stdout.trim()).toBe('gone')
      const journal = await runner.run(machine, `journalctl -u ${unit} --since '-3 minutes' --no-pager -o cat`)
      expect(journal.stdout).toMatch(/idle exit will terminate [1-9][0-9]* unsupported background process/)
      expect(journal.stdout).not.toContain(canary)
      expect(journal.stdout).not.toContain(detachedMarker)

      const finalClient = new SandboxClient(agentBox.endpoint.replace(/^https?:\/\//, ''))
      await finalClient.waitForReady(30_000)
      expect((await bashCollect(finalClient, 'echo FINAL_SOCKET_RESTART')).stdout).toContain('FINAL_SOCKET_RESTART')
      finalClient.close()

      // ── 9. Removing one box leaves the other healthy. ──────────────────────
      await removeBox(agentSandboxId, { archivePrivate: false }, { runner, tunnels: mgr })
      expect(await getMachineBox(agentSandboxId)).toBeNull()
      const agentUserGone = await runner.run(machine, `id -u ${agentUser} >/dev/null 2>&1 && echo present || echo gone`)
      expect(agentUserGone.stdout).toContain('gone')
      expect((await squadClient.health()).healthy).toBe(true)

      // ── 9. Full teardown: DELETE deletes the row AND the minted secret, but
      //       never touches the operator's VM (the opposite of exe). ──────────
      await removeBox(squadSandboxId, { archivePrivate: false }, { runner, tunnels: mgr })
      squadClient.close()
      const deleteRes = await router.request(`/${machine.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })
      expect(deleteRes.status).toBe(204)
      expect(await getMachine(machine.id)).toBeNull()
      // BYO's minted per-machine secret is deleted with the machine…
      expect(getSecretStore().get(`machine-ssh:${machine.id}`)).toBeUndefined()
      // …and the VM is still the operator's: it remains reachable afterwards.
      const stillUp = operatorSsh('echo still-mine')
      expect(stillUp.exitCode).toBe(0)
      machine = undefined
    },
    SLOW_MS
  )
})
