import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSecretStore, resetSecretStore } from '../secrets'
import { SandboxClient, type BashResponse } from '../sandbox/k8s/http-client'
import { bootstrapMachine } from './bootstrap'
import { boxUnixUser, parseBoxUid, stopBox } from './box-manager'
import { computeDevboxSeedHash, seedBoxDevbox } from './devbox-seed'
import { probeMachineHealth } from './machine-health'
import { registerBuiltinMachineProviders } from './providers/index'
import {
  bindMachineBox,
  deleteMachine,
  deleteMachineBox,
  getMachine,
  getMachineBox,
  insertMachine,
  upsertMachineBox,
  type Machine,
} from './queries'
import { ensureServerBundle, SERVER_LIB_REMOTE_PATH } from './server-bundle'
import { createSshRunner, type SshRunner } from './ssh'
import { MachineTunnelManager } from './tunnel-manager'

/**
 * ============================================================================
 * VM sandbox runtime — end-to-end integration test (GATED, SLOW)
 * ============================================================================
 *
 * Exercises the REAL slice-2 vm stack against a disposable Ubuntu 24.04 sshd
 * CONTAINER: bootstrap.sh (real apt + bun install) → the box-provision loud
 * failure mode (a plain container has no systemd, so the systemd/linger steps
 * fail — asserted) → a UNIT-FREE box (user + dirs + the real bundled
 * sandbox-server started directly) → the tunnel/exec/file/reverse paths that
 * `VmSandboxManager` drives in production: SSH ControlMaster forward → the k8s
 * `SandboxClient` /healthz → /write (mode 0600, perms verified) → /bash
 * round-trip → an SSH reverse tunnel the box curls back to an in-test Core-side
 * listener.
 *
 * WHAT THIS DOES NOT COVER (deferred to the tenant-zero VM smoke, see
 * docs/wiki/machines/runtime.md § "Known limitations"): the full systemd `--user`
 * path (linger, the `tau-sandbox-server.service` unit, `--machine=<user>@.host`
 * restart) only runs on a real VM with systemd as PID 1. This container test
 * validates everything AROUND that seam — the exact same ssh runner, tunnel
 * manager, server bundle, SandboxClient, and file/exec/reverse contracts.
 *
 * ----------------------------------------------------------------------------
 * Skipped by default (CI). To run it you provide the disposable container and
 * point the gate env at it. One-liner recipe (root SSH + forwarding + your key):
 *
 *   PUBKEY="$(cat ~/.ssh/id_ed25519.pub)"
 *   # --platform linux/amd64: the server bundle + bun install pin amd64; on an
 *   # arm64 host (Apple Silicon) the container must run under emulation to match.
 *   # --cap-add NET_ADMIN: lets the egress block (and the docker-path egress proof)
 *   # load the nftables ruleset. Harmless for the main flow; kept on the shared
 *   # recipe so one container can serve every gated block below.
 *   docker run -d --rm --platform linux/amd64 --cap-add NET_ADMIN --name tau-vm-int -p 2222:22 ubuntu:24.04 bash -c "
 *     apt-get update && apt-get install -y openssh-server sudo unzip &&
 *     mkdir -p /run/sshd /root/.ssh &&
 *     printf 'PermitRootLogin prohibit-password\nAllowTcpForwarding yes\n' >> /etc/ssh/sshd_config &&
 *     echo '$PUBKEY' > /root/.ssh/authorized_keys &&
 *     chmod 600 /root/.ssh/authorized_keys &&
 *     exec /usr/sbin/sshd -D -e"
 *   # wait ~15s for apt+sshd, then:
 *   FICUS_TEST_SSH_HOST=127.0.0.1 \
 *   FICUS_TEST_SSH_PORT=2222 \
 *   FICUS_TEST_SSH_USER=root \
 *   FICUS_TEST_SSH_KEY_PATH=$HOME/.ssh/id_ed25519 \
 *   FICUS_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) \
 *   bun test src/services/machines/integration-vm.test.ts
 *   # afterwards: docker rm -f tau-vm-int
 *
 * The container itself is operator-disposable (the recipe creates it with
 * `--rm`; `docker rm -f` tears it down). The test cleans up EVERYTHING it
 * creates ON that container — the box unix user + its processes — and closes all
 * SSH tunnels in afterAll, even on failure.
 *
 * The image MUST be Ubuntu-ish with `apt` (bootstrap.sh installs base packages
 * via apt and pins bun) and its sshd MUST set `AllowTcpForwarding yes` (the
 * tunnels are the whole point). `ubuntu:24.04` + openssh-server is the reference.
 * The recipe also installs `unzip`: the official bun installer bootstrap.sh runs
 * unzips its release, and a MINIMAL ubuntu:24.04 image ships without it. (Real
 * cloud images usually carry unzip — see the note in this slice's report about
 * adding unzip to bootstrap.sh's own apt list so a truly minimal VM is safe.)
 *
 * ----------------------------------------------------------------------------
 * SLICE-3 additions (rootless docker + egress + devbox). These layer onto the
 * same container but each need something the plain recipe lacks, so each is
 * behind its own extra gate — the standard integration run above is unaffected:
 *
 *  - `FICUS_TEST_EGRESS=1` (needs `--cap-add NET_ADMIN`, already on the recipe):
 *    the egress block loads the real nftables ruleset and proves the RFC1918 drop
 *    behaviorally. HOST-path only in the plain container.
 *  - `FICUS_TEST_SYSTEMD=1`: assert the SSH target runs systemd as PID 1 (a real VM
 *    or a systemd-enabled container — NOT the plain `ubuntu:24.04` recipe, which
 *    has no systemd). Enables the rootless-docker-per-box block and the docker-PATH
 *    egress proof, both of which need the box user's `--user` manager + linger +
 *    the rootless daemon. On a plain container these are correctly SKIPPED, and the
 *    systemd-dependent surface is validated by the tenant-zero VM smoke instead.
 *  - Devbox seeding is folded into the MAIN flow. bootstrap.sh now installs nix
 *    (multi-user daemon) + devbox, so `devbox` IS on the box PATH — but
 *    `devbox install` REALIZES packages through the nix DAEMON, which runs only
 *    on a real systemd VM (a plain container has no daemon; and on an amd64-
 *    EMULATED host the nix install itself dies under qemu). So the seed step
 *    self-gates on the nix daemon socket being present (or `FICUS_TEST_SYSTEMD`)
 *    and SKIPS honestly otherwise. Where it runs, it asserts the seed marker AND
 *    that a comfort tool resolves in a PLAIN `/bash` (via the server's cached
 *    shellenv, signalled by POST /devbox-ready) — NOT just `devbox run --`. The
 *    full main flow therefore needs a native-amd64 systemd host, aligned with the
 *    gated docker/egress blocks below.
 * ============================================================================
 */

/** Secret-store key the container's SSH private key is loaded under. */
const REAL_SECRET_KEY = 'machine-ssh:vm-integration'
/** The box's sandbox-server listen port (mirrors box-manager's FIRST_BOX_PORT). */
const BOX_PORT = 50100
/** Generous wall-clock bound for the one heavy phase (real apt + bun install). */
const SLOW_MS = 20 * 60 * 1000

/** Collect a `/bash` command's stdout to completion (rejects on stream error). */
function bashCollect(
  client: SandboxClient,
  command: string,
  cwd?: string
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let exitCode = 0
    const stream = client.bash({ command, ...(cwd ? { cwd } : {}) })
    stream.on('data', (r: BashResponse) => {
      if (r.stdout) chunks.push(Buffer.from(r.stdout, 'base64'))
      if (r.error) reject(new Error(r.error))
      if (r.exitCode !== undefined) exitCode = r.exitCode
    })
    stream.on('error', (err: Error) => reject(err))
    stream.on('end', () => resolve({ stdout: Buffer.concat(chunks).toString(), exitCode }))
  })
}

describe.skipIf(!process.env.FICUS_TEST_SSH_HOST)('vm runtime (integration, real ssh container)', () => {
  let priorKey: string | undefined
  let priorHome: string | undefined

  let runner: SshRunner
  let mgr: MachineTunnelManager
  let machine: Machine

  // Slice-4 lifecycle steps (12+ below) are the only part of this block that
  // touches the real database — steps 1-11 stay DB-free by design (stubbed
  // updateMachine). Track the rows they create so afterAll can clean them up
  // even if a mid-test assertion throws.
  let dbMachineId: string | undefined
  let deadMachineId: string | undefined

  const sandboxId = `agent_vmint_${Date.now()}`
  const unixUser = boxUnixUser(sandboxId)
  const home = `/home/${unixUser}`

  // A Core-side HTTP listener the box reaches back over the reverse tunnel.
  let coreListener: ReturnType<typeof Bun.serve> | undefined
  const REVERSE_MARKER = `core-reached-${randomUUID()}`

  beforeAll(async () => {
    priorHome = process.env.HOME_DIR
    process.env.HOME_DIR = mkdtempSync(join(tmpdir(), 'tau-vm-int-home-'))
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
    resetSecretStore()
    await getSecretStore().initialize()

    const keyPath = process.env.FICUS_TEST_SSH_KEY_PATH
    if (!keyPath) throw new Error('integration test requires FICUS_TEST_SSH_KEY_PATH')
    const privateKey = await Bun.file(keyPath).text()
    await getSecretStore().set(REAL_SECRET_KEY, privateKey, 'system')

    machine = {
      id: randomUUID(),
      name: 'vm-integration',
      provider: 'ssh',
      providerRef: null,
      sshHost: process.env.FICUS_TEST_SSH_HOST!,
      sshPort: Number(process.env.FICUS_TEST_SSH_PORT ?? 22),
      sshUser: process.env.FICUS_TEST_SSH_USER ?? 'root',
      sshKeyId: REAL_SECRET_KEY,
      sshPublicKey: 'ssh-ed25519 AAAA test',
      status: 'ready',
      capabilities: {},
      scope: 'shared',
      bootstrapVersion: null,
      artifactVersions: {},
      lastSeenAt: null,
      createdAt: new Date(),
    } as Machine

    // A long default timeout: bootstrap's apt + bun install run for many minutes.
    runner = createSshRunner({ defaultTimeoutMs: SLOW_MS })
    // Keep the control-socket path well under the 90-byte guard regardless of the
    // (long, /var/folders-style) HOME_DIR.
    mgr = new MachineTunnelManager({ controlDir: mkdtempSync(join('/tmp', 'tau-vmint-ctl-')) })

    coreListener = Bun.serve({
      port: 0,
      fetch: () => new Response(REVERSE_MARKER),
    })
  })

  afterAll(async () => {
    // Teardown runs even on failure. Each step is isolated so one failure can't
    // strand the rest (tunnels, container-side box user, secret, env).
    try {
      coreListener?.stop(true)
    } catch {
      /* best-effort */
    }
    try {
      await mgr?.stop()
    } catch {
      /* best-effort */
    }
    try {
      // machine_boxes FKs machines with ON DELETE CASCADE, so deleting the
      // machine row also drops any box row it owns.
      await deleteMachineBox(sandboxId)
    } catch {
      /* best-effort */
    }
    try {
      if (dbMachineId) await deleteMachine(dbMachineId)
    } catch {
      /* best-effort */
    }
    try {
      if (deadMachineId) await deleteMachine(deadMachineId)
    } catch {
      /* best-effort */
    }
    try {
      if (runner && machine) {
        // Kill the box's processes then remove the user + home from the container.
        await runner.run(
          machine,
          `pkill -KILL -u ${unixUser} 2>/dev/null; sleep 1; userdel -r ${unixUser} 2>/dev/null; ` +
            `rm -f /tmp/start-box.sh /tmp/box-server.log; true`,
          { timeoutMs: 60_000 }
        )
      }
    } catch {
      /* best-effort — container is disposable */
    }
    try {
      await getSecretStore().delete(REAL_SECRET_KEY)
    } catch {
      /* best-effort */
    }
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    if (priorHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = priorHome
    resetSecretStore()
  })

  it(
    'bootstraps, provisions unit-free, and drives the real tunnel/exec/file/reverse stack',
    async () => {
      // ── 1. Bootstrap the container for real (apt + bun). ──────────────────
      // updateMachine is stubbed: this test is DB-free and only needs the probed
      // capabilities, exactly as slice-1's gated tunnel test builds its Machine
      // in memory rather than persisting a row.
      const caps = await bootstrapMachine(machine, {
        runner,
        updateMachine: async () => machine,
      })
      // The recipe's sshd sets AllowTcpForwarding yes → the caps probe must see it.
      // (A `no` here would make box-manager reject the machine as unusable.)
      expect(caps.forwarding).toBe('yes')

      // ── 2. box-provision.sh fails LOUDLY at the first systemd step. ───────
      // A plain container has no systemd-as-PID-1, so neither the slice-limit
      // `systemctl daemon-reload` (both unit modes) nor `loginctl enable-linger`
      // (user mode) can succeed. The script is `set -euo pipefail`, so this
      // surfaces as a non-zero exit with a diagnostic on stderr — never a silent
      // partial success.
      const prov = await runner.run(
        machine,
        `bash /opt/tau/bin/box-provision.sh --sandbox-id ${sandboxId} --unix-user ${unixUser} --port ${BOX_PORT}`
      )
      expect(prov.exitCode).not.toBe(0)
      expect(prov.stderr.trim().length).toBeGreaterThan(0)

      // ── 3. Complete the box unit-free: user + dirs (idempotent — the failed
      //       provision may already have created the user via --create-home). ──
      const mkbox =
        `id -u ${unixUser} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${unixUser}; ` +
        `install -d -o ${unixUser} -g ${unixUser} -m 0700 ${home}/.private ${home}/.tau; ` +
        `install -d -o ${unixUser} -g ${unixUser} -m 0755 ${home}/workspace ${home}/bin`
      const mk = await runner.run(machine, mkbox)
      expect(mk.exitCode).toBe(0)

      // ── 4. Ship the REAL sandbox-server via the PRODUCTION bundle path. ────
      // ensureServerBundle pushes BOTH /opt/tau/server/server.js AND the native
      // bun-pty lib (librust_pty.so) that the bundled shell/PTY path dlopens at
      // boot — if that lib is absent the server crashes on startup before
      // /healthz ever comes up. This exercises the exact production push (no
      // test-side lib scaffolding); the stamp is stubbed (this test is DB-free)
      // and artifactVersions has no 'server' entry, so both files push.
      await ensureServerBundle(machine, { runner, stampArtifactVersion: async () => {} })

      // ── 5. Start the server as the box user, unit-free (no systemd). ───────
      const startScript = [
        '#!/usr/bin/env bash',
        'set -e',
        `export EXECUTOR_PORT=${BOX_PORT}`,
        'export WORKSPACE_PATH="$HOME/.private"',
        'export FICUS_BOX_HOME="$HOME"',
        // 'agent' role skips the docker bring-up the server would otherwise do.
        'export FICUS_SANDBOX_ROLE=agent',
        // Point the bundle's PTY loader at the lib ensureServerBundle pushed in
        // step 4 (SERVER_LIB_REMOTE_PATH). In production the box's server.env sets
        // this same var (box-manager derivedBoxEnv); this unit-free start mirrors it.
        `export BUN_PTY_LIB=${SERVER_LIB_REMOTE_PATH}`,
        'exec /opt/tau/bin/bun /opt/tau/server/server.js',
        '',
      ].join('\n')
      const putScript = await runner.run(machine, `install -m 0755 /dev/stdin /tmp/start-box.sh`, {
        stdin: startScript,
      })
      expect(putScript.exitCode).toBe(0)

      // Detach fully (setsid + nohup + redirect + </dev/null) so the server
      // survives the one-shot ssh session that launches it.
      const start = await runner.run(
        machine,
        `nohup setsid su - ${unixUser} -s /bin/bash /tmp/start-box.sh >/tmp/box-server.log 2>&1 </dev/null & sleep 1; echo started`
      )
      expect(start.exitCode).toBe(0)

      // ── 6. Reach the box over a REAL SSH ControlMaster forward. ────────────
      await mgr.ensureMaster(machine)
      expect(await mgr.checkHealth(machine.id)).toBe(true)
      const localPort = await mgr.addForward(machine, BOX_PORT)
      expect(localPort).toBeGreaterThan(0)

      const client = new SandboxClient(`127.0.0.1:${localPort}`)
      try {
        await client.waitForReady(60_000)
      } catch (err) {
        // Surface the server's own log to make a real-run failure diagnosable.
        const logRes = await runner.run(machine, 'cat /tmp/box-server.log 2>/dev/null | tail -40').catch(() => null)
        throw new Error(
          `box server never became healthy: ${(err as Error).message}\n--- box-server.log ---\n${logRes?.stdout ?? '(unavailable)'}`
        )
      }

      // ── 7. /healthz over the tunnel. ───────────────────────────────────────
      const health = await client.health()
      expect(health.healthy).toBe(true)

      // ── 8. /write with mode 0600, then verify the on-disk perms via /bash. ─
      const secretPath = `${home}/.private/secret.txt`
      await client.write({
        path: secretPath,
        content: Buffer.from('sekret').toString('base64'),
        createDirs: true,
        mode: '0600',
      })
      const perms = await bashCollect(client, `stat -c %a ${secretPath}`)
      expect(perms.exitCode).toBe(0)
      expect(perms.stdout.trim()).toBe('600')

      // ── 8b. LOGICAL-root rebasing (the crux for vm session tools). ─────────
      // The vm coding tools address k8s LOGICAL roots (/private, /workspace/<sq>),
      // never box-native paths. The start script sets WORKSPACE_PATH + FICUS_BOX_HOME
      // exactly as box-manager's server.env does, so the server must rebase
      // /private → $HOME/.private. Write to the LOGICAL path, then read it back at
      // the PHYSICAL path to prove the server landed it under HOME.
      const logicalNonce = randomUUID()
      await client.write({
        path: '/private/rebased.txt',
        content: Buffer.from(logicalNonce).toString('base64'),
        createDirs: true,
      })
      const readback = await bashCollect(client, `cat ${home}/.private/rebased.txt`)
      expect(readback.exitCode).toBe(0)
      expect(readback.stdout.trim()).toBe(logicalNonce)

      // A /bash with a LOGICAL cwd must run in the rebased physical dir.
      const pwd = await bashCollect(client, 'pwd', '/private')
      expect(pwd.exitCode).toBe(0)
      expect(pwd.stdout.trim()).toBe(`${home}/.private`)

      // ── 9. /bash round-trip (echo through the box). ────────────────────────
      const nonce = randomUUID()
      const echo = await bashCollect(client, `echo box-echo-${nonce}`)
      expect(echo.exitCode).toBe(0)
      expect(echo.stdout).toContain(`box-echo-${nonce}`)

      // ── 10. Reverse tunnel: the box curls back to the in-test Core listener. ─
      const corePort = coreListener!.port
      if (!corePort) throw new Error('core listener has no port')
      const remotePort = await mgr.addReverse(machine, corePort)
      expect(remotePort).toBeGreaterThan(0)
      const curled = await bashCollect(client, `curl -s --max-time 5 http://127.0.0.1:${remotePort}/`)
      expect(curled.exitCode).toBe(0)
      expect(curled.stdout).toBe(REVERSE_MARKER)

      // ── 11. Devbox comfort-set seeding (VM-smoke: needs a LIVE nix daemon). ──
      // seedBoxDevbox is the EXACT call the manager makes at ensure (writes
      // ~/.tau/devbox/devbox.json AS THE BOX USER, runs `devbox install`, records
      // the content-hash marker). bootstrap.sh installs nix + devbox, so `devbox`
      // is on PATH — but `devbox install` REALIZES packages through the nix
      // DAEMON, which runs only on a real systemd VM (a plain container has no
      // daemon socket; on an amd64-emulated host the nix install itself dies under
      // qemu). So gate on the daemon socket (or FICUS_TEST_SYSTEMD) and SKIP
      // honestly otherwise — the seeder's logic (content, marker skip, non-fatal)
      // is unit-covered in devbox-seed.test.ts; this is the live behavioral layer.
      const nixDaemon = await bashCollect(client, '[ -S /nix/var/nix/daemon-socket/socket ] && echo yes || echo no')
      const canSeed = nixDaemon.stdout.trim() === 'yes' || !!process.env.FICUS_TEST_SYSTEMD
      if (canSeed) {
        // Agent-role box → the LIGHT comfort set. Seeding is idempotent; a marker
        // matching this role's content-hash proves the install completed.
        await seedBoxDevbox(client, sandboxId, 'agent', { installTimeoutSeconds: 10 * 60 })
        const marker = await bashCollect(client, `cat ${home}/.tau/devbox/.seeded`)
        expect(marker.exitCode).toBe(0)
        expect(marker.stdout.trim()).toBe(computeDevboxSeedHash('agent'))
        // Signal /devbox-ready so the box server caches the devbox shellenv — the
        // exact post-seed step the manager runs, and what makes the comfort tools
        // reach a PLAIN /bash PATH (inlined into every command's preamble).
        await client.devboxReady()
        // The comfort tool must resolve in a PLAIN /bash — NOT `devbox run -- rg`.
        // This is the assertion that would have caught the "seeded devbox env never
        // reaches box shells" bug: a `devbox run` probe passed while plain `/bash`
        // still said "rg: command not found".
        const rg = await bashCollect(client, 'rg --version')
        expect(rg.exitCode).toBe(0)
        expect(rg.stdout).toContain('ripgrep')
      } else {
        console.warn(
          '[vm-int] no nix daemon (not a systemd VM) — comfort-set seed assertion skipped ' +
            '(VM-smoke-deferred; seeder logic covered by devbox-seed.test.ts)'
        )
      }

      // ── 12. Slice-4 lifecycle: give this box a REAL DB row. ────────────────
      // Steps 1-11 above deliberately stayed DB-free (stubbed updateMachine),
      // mirroring the original slice-2 gated test's scope. The slice-4
      // lifecycle loop (idle reap / machine health / orphan reconcile) is
      // DB-driven — it reads `machines`/`machine_boxes`, not process state —
      // so exercising it for real needs an actual row, pointed at the SAME
      // container/box this test already stood up. `bindMachineBox` allocates
      // the next free port on an empty machine starting at 50100 (`FIRST_BOX_PORT`,
      // which equals this test's `BOX_PORT`), so no manual port override is
      // needed for the box to line up with the server already listening there.
      const dbMachine = await insertMachine({
        name: `vm-integration-lifecycle-${randomUUID()}`,
        provider: 'ssh',
        providerRef: null,
        sshHost: machine.sshHost,
        sshPort: machine.sshPort,
        sshUser: machine.sshUser,
        sshKeyId: machine.sshKeyId,
        sshPublicKey: machine.sshPublicKey,
        status: 'ready',
        capabilities: {},
        scope: 'shared',
      })
      dbMachineId = dbMachine.id
      const boundBox = await bindMachineBox({ sandboxId, machineId: dbMachine.id, unixUser })
      expect(boundBox.port).toBe(BOX_PORT)
      await upsertMachineBox({
        sandboxId,
        machineId: dbMachine.id,
        unixUser,
        port: BOX_PORT,
        status: 'ready',
      })

      // A tunnel keyed on `dbMachine.id` (steps 1-11's forward is keyed on the
      // original in-memory `machine.id`) — box-manager's real functions below
      // resolve the box's machine by DB id, so the lifecycle checks need their
      // own forward keyed the same way.
      await mgr.ensureMaster(dbMachine)
      const lifecyclePort = await mgr.addForward(dbMachine, BOX_PORT)
      const lifecycleClient = new SandboxClient(`127.0.0.1:${lifecyclePort}`)
      expect((await lifecycleClient.health()).healthy).toBe(true)

      // ── 13. Park: box-manager.stopBox flips the row to 'stopped' and cancels
      //        the forward. Honest degrade: this container has NO systemd (step 2
      //        already asserts that loudly), so stopBox's
      //        `systemctl --user stop` is a harmless best-effort no-op here — it
      //        cannot make this container's unit-free server process actually
      //        stop, so "the systemd unit stopped" is VM-smoke-only (see
      //        runtime.md § Known limitations). What IS real and asserted here:
      //        the DB row flip, and the tunnel forward's real teardown (a
      //        request through the torn-down forward fails).
      await stopBox(sandboxId, { tunnels: mgr })
      const stoppedRow = await getMachineBox(sandboxId)
      expect(stoppedRow?.status).toBe('stopped')
      await expect(lifecycleClient.health()).rejects.toThrow()

      // ── 14. Resume: re-add the forward and confirm /healthz answers again in
      //        seconds. The box server PROCESS itself never stopped (nothing here
      //        can kill it without systemd), so this proves the tunnel/DB side of
      //        a resume — re-provisioning through a real systemd unit restart is,
      //        again, VM-smoke-only.
      const resumedPort = await mgr.addForward(dbMachine, BOX_PORT)
      const resumedClient = new SandboxClient(`127.0.0.1:${resumedPort}`)
      await resumedClient.waitForReady(10_000)
      expect((await resumedClient.health()).healthy).toBe(true)
      await upsertMachineBox({
        sandboxId,
        machineId: dbMachine.id,
        unixUser,
        port: BOX_PORT,
        status: 'ready',
      })
      expect((await getMachineBox(sandboxId))?.status).toBe('ready')
      resumedClient.close()

      // ── 15. Machine health: a probe against an unreachable machine flips its
      //        row to 'unreachable'. Point a SEPARATE machine row at a closed
      //        port on the SAME host (fast ECONNREFUSED, no hang) rather than
      //        killing the shared container the rest of this file's blocks still
      //        need — still a REAL unreachable-target probe, not a mock.
      await registerBuiltinMachineProviders() // idempotent
      const deadMachine = await insertMachine({
        name: `vm-integration-dead-${randomUUID()}`,
        provider: 'ssh',
        providerRef: null,
        sshHost: machine.sshHost,
        sshPort: machine.sshPort + 1, // nothing listens here
        sshUser: machine.sshUser,
        sshKeyId: machine.sshKeyId,
        sshPublicKey: machine.sshPublicKey,
        status: 'ready',
        capabilities: {},
        scope: 'shared',
      })
      deadMachineId = deadMachine.id
      const probed = await probeMachineHealth(deadMachine, { tunnels: mgr })
      expect(probed).toBe('unreachable')
      expect((await getMachine(deadMachine.id))?.status).toBe('unreachable')

      lifecycleClient.close()
      client.close()
    },
    SLOW_MS
  )
})

/**
 * ============================================================================
 * Egress lockdown — behavioral security proof (GATED, needs NET_ADMIN)
 * ============================================================================
 *
 * Separate from the main flow because it needs privileges the default recipe
 * container does NOT have: applying the nftables ruleset requires the container
 * run with `--cap-add NET_ADMIN` and have `nftables` installed. It is therefore
 * double-gated on FICUS_TEST_SSH_HOST **and** FICUS_TEST_EGRESS so the standard
 * integration recipe above is unaffected.
 *
 * Recipe delta (add to the `docker run` in the main header):
 *   docker run -d --rm --platform linux/amd64 --cap-add NET_ADMIN \
 *     --name tau-vm-int -p 2222:22 ubuntu:24.04 bash -c "... same as above ..."
 * then set FICUS_TEST_EGRESS=1 alongside the FICUS_TEST_SSH_* vars.
 *
 * What this proves behaviorally: after loading the EXACT production ruleset
 * (rendered by `bootstrap.sh --print-egress-ruleset`, no apt/bun cost), an
 * outbound connection to an RFC1918 address is DROPPED while the public internet
 * still egresses. The --core-cidr allow-exception and the reverse-tunnel
 * (loopback + established/related) paths are proven STRUCTURALLY here — asserting
 * their accept rules precede the drop in the loaded table — because standing up a
 * reachable listener inside a dropped range in a throwaway container is out of
 * scope; the unit `nft -c -f` + rule-render assertions in bootstrap.test.ts cover
 * the ruleset's syntax + shape. Honest split: DROP behavior is proven live here;
 * ALLOW behavior is proven by rule presence + ordering.
 *
 * The DOCKER-PATH proof (a T2-review ask): that a CONTAINER's egress inside a
 * `--with-docker` box is ALSO subject to tau_egress — its slirp4netns userspace
 * NAT does the real outbound socket() in the HOST netns as the box user, so its
 * packets traverse the same output hook. This needs the box user's rootless
 * daemon (systemd `--user` + linger), which the plain container lacks, so it
 * lives in the `egress docker-path` block below, additionally gated on
 * `FICUS_TEST_SYSTEMD`. In the plain container the HOST-path RFC1918 drop asserted
 * here is the minimum; the docker-path is VM-smoke-deferred.
 * ============================================================================
 */
describe.skipIf(!process.env.FICUS_TEST_SSH_HOST || !process.env.FICUS_TEST_EGRESS)(
  'egress lockdown (integration, NET_ADMIN container)',
  () => {
    let priorKey: string | undefined
    let priorHome: string | undefined
    let runner: SshRunner
    let machine: Machine

    beforeAll(async () => {
      priorHome = process.env.HOME_DIR
      process.env.HOME_DIR = mkdtempSync(join(tmpdir(), 'tau-vm-egr-home-'))
      priorKey = process.env.FICUS_ENCRYPTION_KEY
      process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
      resetSecretStore()
      await getSecretStore().initialize()

      const keyPath = process.env.FICUS_TEST_SSH_KEY_PATH
      if (!keyPath) throw new Error('egress integration test requires FICUS_TEST_SSH_KEY_PATH')
      await getSecretStore().set(REAL_SECRET_KEY, await Bun.file(keyPath).text(), 'system')

      machine = {
        id: randomUUID(),
        name: 'vm-egress',
        provider: 'ssh',
        providerRef: null,
        sshHost: process.env.FICUS_TEST_SSH_HOST!,
        sshPort: Number(process.env.FICUS_TEST_SSH_PORT ?? 22),
        sshUser: process.env.FICUS_TEST_SSH_USER ?? 'root',
        sshKeyId: REAL_SECRET_KEY,
        sshPublicKey: 'ssh-ed25519 AAAA test',
        status: 'ready',
        capabilities: {},
        scope: 'shared',
        egressPolicy: true,
        bootstrapVersion: null,
        artifactVersions: {},
        lastSeenAt: null,
        createdAt: new Date(),
      } as Machine

      runner = createSshRunner({ defaultTimeoutMs: 5 * 60 * 1000 })
    })

    afterAll(async () => {
      try {
        // Tear the table down so a re-run on a persistent container starts clean.
        if (runner && machine) await runner.run(machine, 'nft delete table inet tau_egress 2>/dev/null; true')
      } catch {
        /* best-effort — container is disposable */
      }
      try {
        await getSecretStore().delete(REAL_SECRET_KEY)
      } catch {
        /* best-effort */
      }
      if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
      else process.env.FICUS_ENCRYPTION_KEY = priorKey
      if (priorHome === undefined) delete process.env.HOME_DIR
      else process.env.HOME_DIR = priorHome
      resetSecretStore()
    })

    it(
      'drops RFC1918 egress while the public internet + loopback stay reachable',
      async () => {
        const bootstrapSh = readFileSync(join(import.meta.dir, '../../../../../scripts/machine/bootstrap.sh'), 'utf8')

        // Push the real script, ensure nftables, then load the EXACT production
        // ruleset the script renders (a --core-cidr allow-exception included so we
        // can assert it lands ahead of the drop). No apt/bun bootstrap — just the
        // rules. The SSH control connection is inbound + established, so loading an
        // output-hook drop for RFC1918 never severs our own session.
        const push = await runner.run(machine, 'install -m 0755 /dev/stdin /tmp/tau-egress.sh', { stdin: bootstrapSh })
        expect(push.exitCode).toBe(0)

        const apply = await runner.run(
          machine,
          'command -v nft >/dev/null 2>&1 || (apt-get update -y && apt-get install -y --no-install-recommends nftables) >/dev/null 2>&1; ' +
            'nft delete table inet tau_egress 2>/dev/null; ' +
            'bash /tmp/tau-egress.sh --print-egress-ruleset --core-cidr 10.99.0.0/16 | nft -f -'
        )
        expect(apply.exitCode).toBe(0)

        // The loaded table carries the deny-list, the DNS/loopback/established
        // allows, the --core-cidr allow-exception, AND the v6 drop — and the
        // accepts precede the drop (structural proof of the allow paths).
        const listed = await runner.run(machine, 'nft list table inet tau_egress')
        expect(listed.exitCode).toBe(0)
        const ruleset = listed.stdout
        expect(ruleset).toContain('ct state established,related accept')
        expect(ruleset).toContain('10.99.0.0/16')
        expect(ruleset).toMatch(/accept[\s\S]*ip daddr @denied4 drop/)
        expect(ruleset).toContain('ip6 daddr @denied6 drop')

        // Behavioral: an RFC1918 dest (NOT in the allow-exception) is dropped →
        // the connect hangs to the timeout, curl exits non-zero.
        const blocked = await runner.run(machine, 'curl -sS --max-time 4 http://10.255.255.1/ >/dev/null; echo rc=$?')
        expect(blocked.stdout).toContain('rc=')
        expect(blocked.stdout.trim()).not.toBe('rc=0')

        // Behavioral: the public internet still egresses (http, so no TLS-verify
        // noise). Operator-provided network; 1.1.1.1 answers with a redirect.
        const allowed = await runner.run(machine, 'curl -sS -o /dev/null --max-time 12 http://1.1.1.1/; echo rc=$?')
        expect(allowed.stdout.trim()).toBe('rc=0')
      },
      5 * 60 * 1000
    )
  }
)

/**
 * Build an in-memory `Machine` for the ssh runner (DB-free, like the blocks
 * above). `egressPolicy` is opt-in per block. Pure — no module-level state.
 */
function buildIntegrationMachine(name: string, egressPolicy: boolean): Machine {
  return {
    id: randomUUID(),
    name,
    provider: 'ssh',
    providerRef: null,
    sshHost: process.env.FICUS_TEST_SSH_HOST!,
    sshPort: Number(process.env.FICUS_TEST_SSH_PORT ?? 22),
    sshUser: process.env.FICUS_TEST_SSH_USER ?? 'root',
    sshKeyId: REAL_SECRET_KEY,
    sshPublicKey: 'ssh-ed25519 AAAA test',
    status: 'ready',
    capabilities: {},
    scope: 'shared',
    egressPolicy,
    bootstrapVersion: null,
    artifactVersions: {},
    lastSeenAt: null,
    createdAt: new Date(),
  } as Machine
}

/**
 * ============================================================================
 * Rootless docker per box — the closed root hole (GATED, needs a systemd host)
 * ============================================================================
 *
 * Triple-precondition, hence its own gate: this exercises box-provision.sh's
 * `--with-docker` path, which stands up the BOX USER's OWN rootless dockerd as a
 * systemd `--user` service (linger + `/run/user/<uid>`). A plain container has no
 * systemd as PID 1, so `loginctl enable-linger` fails and provision aborts BEFORE
 * the docker step (the main flow asserts exactly that loud failure). It therefore
 * runs ONLY when `FICUS_TEST_SYSTEMD=1` asserts the SSH target is a real systemd VM
 * (or systemd-enabled container) on which bootstrap.sh has ALREADY run (docker
 * engine + rootless launcher installed, the system daemon masked, box-provision
 * installed at /opt/tau/bin). On a plain container it is SKIPPED and the path is
 * covered by the tenant-zero VM smoke + the unit tests (docker.ts, bootstrap.ts).
 *
 * What it proves: (1) `--with-docker` provisions cleanly and REPORTS the box uid;
 * (2) `docker info` answers over the box user's rootless socket AS THE BOX USER
 * (never root); (3) the root hole is CLOSED — the shared rootful daemon is masked
 * and its `/var/run/docker.sock` is not world-writable 666 (the pre-slice-3 hole).
 * ============================================================================
 */
describe.skipIf(!process.env.FICUS_TEST_SSH_HOST || !process.env.FICUS_TEST_SYSTEMD)(
  'rootless docker per box (integration, systemd host)',
  () => {
    let priorKey: string | undefined
    let priorHome: string | undefined
    let runner: SshRunner
    let machine: Machine

    // squad_ prefix: --with-docker is a SQUAD/system-manager capability, and the
    // prefix now also decides the unit mode — an `agent_*` id derives the
    // system unit, which box-provision rejects together with --with-docker
    // (rootless docker needs the box user's own systemd --user manager).
    const sandboxId = `squad_vmdock_${Date.now()}`
    const unixUser = boxUnixUser(sandboxId)
    const home = `/home/${unixUser}`

    beforeAll(async () => {
      priorHome = process.env.HOME_DIR
      process.env.HOME_DIR = mkdtempSync(join(tmpdir(), 'tau-vm-dock-home-'))
      priorKey = process.env.FICUS_ENCRYPTION_KEY
      process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
      resetSecretStore()
      await getSecretStore().initialize()

      const keyPath = process.env.FICUS_TEST_SSH_KEY_PATH
      if (!keyPath) throw new Error('docker integration test requires FICUS_TEST_SSH_KEY_PATH')
      await getSecretStore().set(REAL_SECRET_KEY, await Bun.file(keyPath).text(), 'system')

      machine = buildIntegrationMachine('vm-docker', false)
      runner = createSshRunner({ defaultTimeoutMs: 5 * 60 * 1000 })
    })

    afterAll(async () => {
      try {
        // Remove the box user (archives + userdel), even on failure.
        if (runner && machine) {
          await runner.run(
            machine,
            `bash /opt/tau/bin/box-provision.sh --unix-user ${unixUser} --remove 2>/dev/null; ` +
              `pkill -KILL -u ${unixUser} 2>/dev/null; userdel -r ${unixUser} 2>/dev/null; true`,
            { timeoutMs: 60_000 }
          )
        }
      } catch {
        /* best-effort — container is disposable */
      }
      try {
        await getSecretStore().delete(REAL_SECRET_KEY)
      } catch {
        /* best-effort */
      }
      if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
      else process.env.FICUS_ENCRYPTION_KEY = priorKey
      if (priorHome === undefined) delete process.env.HOME_DIR
      else process.env.HOME_DIR = priorHome
      resetSecretStore()
    })

    it(
      'provisions a --with-docker box whose rootless docker answers as the box user, rootful daemon masked',
      async () => {
        // 1. Provision --with-docker. On a real systemd host box-provision runs the
        //    rootless setup and prints the box uid on its sole stdout line.
        const prov = await runner.run(
          machine,
          `bash /opt/tau/bin/box-provision.sh --sandbox-id ${sandboxId} --unix-user ${unixUser} --port ${BOX_PORT} --with-docker`,
          { timeoutMs: 5 * 60 * 1000 }
        )
        expect(prov.exitCode).toBe(0)
        const uid = parseBoxUid(prov.stdout)
        expect(uid).not.toBeNull()

        // 2. `docker info` over the box user's OWN rootless socket, AS THE BOX USER
        //    (mirrors box-provision's run_as_box env: HOME + XDG_RUNTIME_DIR + the
        //    rootless DOCKER_HOST). Success here means the per-box daemon is live.
        const dockerHost = `unix:///run/user/${uid}/docker.sock`
        const info = await runner.run(
          machine,
          `sudo -u ${unixUser} env HOME=${home} XDG_RUNTIME_DIR=/run/user/${uid} ` +
            `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus DOCKER_HOST=${dockerHost} ` +
            `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin docker info`,
          { timeoutMs: 60_000 }
        )
        expect(info.exitCode).toBe(0)

        // 3. The root hole is CLOSED: bootstrap masks the shared rootful daemon, so
        //    `systemctl is-enabled docker.service` is `masked` and there is no
        //    world-writable /var/run/docker.sock (pre-slice-3 the sandbox-server
        //    chmod'd it 666, root-equivalent for every box). Absent socket → `none`.
        const hole = await runner.run(
          machine,
          'systemctl is-enabled docker.service 2>&1 | tr -d "\\n"; ' +
            'echo " sockmode=$(stat -c %a /var/run/docker.sock 2>/dev/null || echo none)"'
        )
        expect(hole.stdout).toContain('masked')
        expect(hole.stdout).not.toContain('sockmode=666')
      },
      6 * 60 * 1000
    )
  }
)

/**
 * ============================================================================
 * Egress DOCKER-PATH — container traffic is subject to tau_egress (GATED)
 * ============================================================================
 *
 * The T2-review ask: prove that a CONTAINER launched inside a `--with-docker` box
 * cannot bypass the machine's egress lockdown. Rootless docker egresses via
 * slirp4netns userspace NAT, which performs the real outbound socket() in the
 * HOST network namespace as the box user — so container packets traverse the same
 * `table inet tau_egress` output hook as host traffic. This needs BOTH the
 * NET_ADMIN nftables path (FICUS_TEST_EGRESS) AND the box user's rootless daemon
 * (FICUS_TEST_SYSTEMD), so it is triple-gated. In the plain NET_ADMIN container the
 * host-path RFC1918 drop (asserted in the block above) is the minimum; this
 * docker-path proof is VM-smoke-deferred.
 * ============================================================================
 */
describe.skipIf(!process.env.FICUS_TEST_SSH_HOST || !process.env.FICUS_TEST_EGRESS || !process.env.FICUS_TEST_SYSTEMD)(
  'egress docker-path (integration, systemd + NET_ADMIN)',
  () => {
    let priorKey: string | undefined
    let priorHome: string | undefined
    let runner: SshRunner
    let machine: Machine

    const sandboxId = `squad_vmegrdock_${Date.now()}`
    const unixUser = boxUnixUser(sandboxId)
    const home = `/home/${unixUser}`

    beforeAll(async () => {
      priorHome = process.env.HOME_DIR
      process.env.HOME_DIR = mkdtempSync(join(tmpdir(), 'tau-vm-egrdock-home-'))
      priorKey = process.env.FICUS_ENCRYPTION_KEY
      process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
      resetSecretStore()
      await getSecretStore().initialize()

      const keyPath = process.env.FICUS_TEST_SSH_KEY_PATH
      if (!keyPath) throw new Error('egress docker-path test requires FICUS_TEST_SSH_KEY_PATH')
      await getSecretStore().set(REAL_SECRET_KEY, await Bun.file(keyPath).text(), 'system')

      machine = buildIntegrationMachine('vm-egress-docker', true)
      runner = createSshRunner({ defaultTimeoutMs: 5 * 60 * 1000 })
    })

    afterAll(async () => {
      try {
        if (runner && machine) {
          await runner.run(
            machine,
            `bash /opt/tau/bin/box-provision.sh --unix-user ${unixUser} --remove 2>/dev/null; ` +
              `pkill -KILL -u ${unixUser} 2>/dev/null; userdel -r ${unixUser} 2>/dev/null; ` +
              `nft delete table inet tau_egress 2>/dev/null; true`,
            { timeoutMs: 60_000 }
          )
        }
      } catch {
        /* best-effort — container is disposable */
      }
      try {
        await getSecretStore().delete(REAL_SECRET_KEY)
      } catch {
        /* best-effort */
      }
      if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
      else process.env.FICUS_ENCRYPTION_KEY = priorKey
      if (priorHome === undefined) delete process.env.HOME_DIR
      else process.env.HOME_DIR = priorHome
      resetSecretStore()
    })

    it(
      'drops a container egress to RFC1918 while public egress + the image pull succeed',
      async () => {
        const bootstrapSh = readFileSync(join(import.meta.dir, '../../../../../scripts/machine/bootstrap.sh'), 'utf8')

        // 1. Load the egress ruleset on the HOST (a --core-cidr keeps our own SSH /
        //    reverse path clear; established+loopback already do too).
        const push = await runner.run(machine, 'install -m 0755 /dev/stdin /tmp/tau-egress.sh', { stdin: bootstrapSh })
        expect(push.exitCode).toBe(0)
        const apply = await runner.run(
          machine,
          'command -v nft >/dev/null 2>&1 || (apt-get update -y && apt-get install -y --no-install-recommends nftables) >/dev/null 2>&1; ' +
            'nft delete table inet tau_egress 2>/dev/null; ' +
            'bash /tmp/tau-egress.sh --print-egress-ruleset --core-cidr 10.99.0.0/16 | nft -f -'
        )
        expect(apply.exitCode).toBe(0)

        // 2. Provision a --with-docker box (squad role) with a live rootless daemon.
        const prov = await runner.run(
          machine,
          `bash /opt/tau/bin/box-provision.sh --sandbox-id ${sandboxId} --unix-user ${unixUser} --port ${BOX_PORT} --with-docker`,
          { timeoutMs: 5 * 60 * 1000 }
        )
        expect(prov.exitCode).toBe(0)
        const uid = parseBoxUid(prov.stdout)
        expect(uid).not.toBeNull()

        // 3. Run a throwaway container AS THE BOX USER over its rootless socket. The
        //    image pull needs PUBLIC egress (allowed → proves egress isn't globally
        //    off); then inside the container a wget to RFC1918 is DROPPED (slirp4netns
        //    egresses through the host output hook) while a public wget succeeds.
        const dockerEnv =
          `sudo -u ${unixUser} env HOME=${home} XDG_RUNTIME_DIR=/run/user/${uid} ` +
          `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus DOCKER_HOST=unix:///run/user/${uid}/docker.sock ` +
          `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
        const run = await runner.run(
          machine,
          `${dockerEnv} docker run --rm busybox sh -c ` +
            `'wget -T 4 -q -O /dev/null http://10.255.255.1/; echo rc1918=$?; ` +
            `wget -T 10 -q -O /dev/null http://1.1.1.1/; echo rcpub=$?'`,
          { timeoutMs: 4 * 60 * 1000 }
        )
        // The pull itself required public egress; a non-zero here from a pull failure
        // would surface as neither marker present, caught below.
        expect(run.stdout).toContain('rc1918=')
        expect(run.stdout).toContain('rcpub=0')
        expect(run.stdout).not.toContain('rc1918=0')
      },
      6 * 60 * 1000
    )
  }
)
