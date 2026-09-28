import { createHash } from 'crypto'
import type { MachineCapabilities } from '../../db/schema'
import { effectiveMachineScripts, type PrebuiltReadOpts } from './machine-prebuilt'
// The remote path comes from the ARTIFACT definition — the other pusher of this
// same file. A second copy of the literal here could drift, leaving a machine
// carrying two divergent box-provision.sh copies.
import { BOX_PROVISION_REMOTE_PATH } from './box-provision-artifact'
import type { Machine } from './queries'
import { updateMachine as updateMachineDefault } from './queries'
import { buildPushFileCommand, defaultSshRunner } from './ssh'
import type { SshRunner } from './ssh'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('machine-bootstrap')

/**
 * Machine bootstrap: push + run `scripts/machine/bootstrap.sh` over SSH, parse
 * the capabilities it reports, and stamp the machine row `ready` with the probed
 * capabilities and a `bootstrapVersion` (the sha256 of the script content — the
 * drift detector a future reconciler compares against). `box-provision.sh` is
 * pushed into `/opt/tau/bin/` for slice 2 to invoke per-box; it is NOT run here.
 * That push covers a machine's FIRST delivery only — thereafter the script is
 * kept current by the machine-artifact registry (see box-provision-artifact.ts),
 * so a script change reaches the existing fleet without a re-bootstrap.
 *
 * On any SSH/exec failure the machine is marked `unreachable`, its `lastError`
 * is stamped with the same message (capped — see {@link capLastError}), and the
 * error is rethrown with the FULL, uncapped message. A subsequent SUCCESSFUL
 * bootstrap clears `lastError` back to null when it stamps `ready`.
 */

/** Scratch path the bootstrap script is streamed to before being run. */
const BOOTSTRAP_REMOTE_PATH = '/tmp/tau-bootstrap.sh'
/**
 * Wall-clock bound for the `bootstrap.sh` run (apt + bun + multi-user nix +
 * devbox on a fresh VM). Minutes, not the SSH runner's 30s default. 15 min
 * matches the gated integration test's per-flow budget.
 */
const BOOTSTRAP_RUN_TIMEOUT_MS = 15 * 60_000
const CAPS_PREFIX = 'FICUS_CAPS_JSON:'
/** One release (Ficus rename): a pre-rename bootstrap.sh prints the legacy spelling. */
const LEGACY_CAPS_PREFIX = 'TAU_CAPS_JSON:'
/**
 * Cap on the `lastError` bytes persisted to the row. `machines.lastError` is
 * returned on every list/detail fetch, and the message is built from raw
 * apt/nix stderr — unbounded on a sufficiently chatty failure. Keeps the TAIL
 * (the most diagnostic part of a build log is the end, not the start).
 */
const MAX_LAST_ERROR_LENGTH = 4096

/**
 * Bound a persisted lastError to {@link MAX_LAST_ERROR_LENGTH}, keeping the
 * tail. Only used for what gets WRITTEN to the row — `bootstrapMachine` still
 * rethrows the full, uncapped message (callers/logs get the whole thing).
 *
 * Exported so every OTHER `machines.lastError` writer caps too — the bound is
 * meant to be a real invariant on the column, not a convention this module
 * alone happens to follow. See `routes/machines.ts`'s bootstrap guard-catch and
 * `machine-health.ts`'s probe writes.
 */
export function capLastError(message: string): string {
  if (message.length <= MAX_LAST_ERROR_LENGTH) return message
  return `…(truncated)…${message.slice(-MAX_LAST_ERROR_LENGTH)}`
}

// Both machine scripts resolve through {@link effectiveMachineScripts} — the
// ONE prebuilt-preferring source, shared with box-provision-artifact.ts. A
// shipped core artifact carries them prebuilt under `<root>/machine/` and those
// bytes win; a dev/source run falls back to the copies inlined at build time (a
// runtime read of scripts/ would ENOENT in the shipped bundle, which never
// carries scripts/). Because the version stamp, the boot-time reconciler's
// target and every pushed byte come from that one function, they cannot
// disagree — two independent derivations is exactly the fleet-wide
// re-bootstrap-storm bug (#1155 x #1163).

/** Single-quote a value for safe interpolation into a remote shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export type UpdateMachineFn = (id: string, updates: Partial<Machine>) => Promise<Machine | null>

export interface BootstrapDeps {
  runner?: SshRunner
  /**
   * Injected so the row-stamping (and the failure `unreachable` write) is
   * observable in tests without a live DB. Defaults to Task 1's `updateMachine`.
   */
  updateMachine?: UpdateMachineFn
  /**
   * Wait for the machine's SSH to answer before the first push. Defaults to
   * {@link waitForSshReady}; tests inject a no-op. See waitForSshReady for why.
   */
  waitForSshReady?: (runner: SshRunner, machine: Machine) => Promise<void>
  /**
   * The Core-reachable CIDR(s) allowed through the egress lockdown when the
   * machine opts in (`machine.egressPolicy`). Defaults to
   * {@link parseCoreEgressCidrs} of `FICUS_CORE_EGRESS_CIDR`. Each is passed as a
   * `--core-cidr` to bootstrap.sh, which re-validates it (strict IPv4 CIDR)
   * before interpolating it into the root nft ruleset.
   */
  coreEgressCidrs?: string[]
  /**
   * Fire-and-forget devbox pre-warm, invoked with the machine id RIGHT AFTER the
   * row flips `ready`. Its job: realize the common-role devbox on the machine in
   * the BACKGROUND so the machine's `/nix` store + the shared devbox.lock cache
   * are populated before the first user execution lands — eliminating the
   * cold-first-box realization tax (resolve+realize ~100s) that used to blow the
   * 60s box-health timeout (see devbox-prewarm.ts).
   *
   * MUST be non-blocking and fault-isolated: it returns void (never awaited), and
   * the call site swallows even a synchronous throw so a pre-warm can never fail
   * or delay the ready transition. Injected so a unit test can spy on the kick
   * without pulling in the (heavy, cyclic) devbox-prewarm module. Defaults to a
   * dynamic-import background realize that is itself a no-op under
   * `FICUS_TEST_MODE=1`.
   */
  prewarmDevbox?: (machineId: string) => void
  /**
   * Where the machine scripts are read from ({@link effectiveMachineScripts}).
   * Defaults to the process's own resolution (artifact prebuilt → inlined); a
   * test seam so a fixture artifact root can be injected. Whatever is passed
   * feeds BOTH the stamped version and the pushed bytes.
   */
  prebuilt?: PrebuiltReadOpts
}

/**
 * Default {@link BootstrapDeps.prewarmDevbox}: kick the machine-scoped devbox
 * pre-warm in the background. Dynamically imported so bootstrap.ts (pulled in by
 * placement.ts → box-manager.ts) does not statically depend on box-manager.ts —
 * that back-edge would be an import cycle. No-op under `FICUS_TEST_MODE=1` (the
 * background wrapper re-checks too); any import/kick error is swallowed.
 */
function defaultPrewarmDevbox(machineId: string): void {
  if (process.env.FICUS_TEST_MODE === '1') return
  void import('./devbox-prewarm')
    .then((m) => m.prewarmMachineDevboxBackground(machineId))
    .catch((err) => log.warn(`devbox pre-warm kick failed to load for machine ${machineId} (non-fatal):`, err))
}

/**
 * Where the Core's reachable CIDR(s) come from: the `FICUS_CORE_EGRESS_CIDR`
 * env/config, a comma- or whitespace-separated list of IPv4 CIDRs (e.g.
 * `"10.20.0.0/16, 203.0.113.7/32"`). Empty/unset ⇒ no allow-exceptions: the
 * lockdown still applies and the box→core REVERSE tunnel keeps working, since it
 * rides the inbound SSH connection (ct established/related) and reaches Core over
 * loopback — neither needs a --core-cidr. Direct-reach Core deployments must set
 * it to the Core endpoint's CIDR.
 */
export function parseCoreEgressCidrs(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Extract the machine capabilities from bootstrap stdout. The script prints
 * exactly one `FICUS_CAPS_JSON: {...}` marker (legacy `TAU_CAPS_JSON:` accepted for one
 * release) as its final line, but this scans
 * from the end and tolerates arbitrary preceding chatter (and a malformed
 * earlier marker), returning the LAST valid one. Throws if none is present.
 */
export function parseCapabilities(stdout: string): MachineCapabilities {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    const prefix = [CAPS_PREFIX, LEGACY_CAPS_PREFIX].find((p) => line.startsWith(p))
    if (!prefix) continue
    const jsonPart = line.slice(prefix.length).trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonPart)
    } catch {
      continue // malformed marker — keep scanning upward for a valid one
    }
    if (!parsed || typeof parsed !== 'object') continue
    const p = parsed as Record<string, unknown>
    const caps: MachineCapabilities = {}
    if (typeof p.arch === 'string') caps.arch = p.arch
    if (typeof p.cpus === 'number') caps.cpus = p.cpus
    if (typeof p.memMb === 'number') caps.memMb = p.memMb
    if (typeof p.diskGb === 'number') caps.diskGb = p.diskGb
    if (typeof p.kernel === 'string') caps.kernel = p.kernel
    if (p.docker === 'rootless' || p.docker === 'rootful' || p.docker === 'none') caps.docker = p.docker
    if (p.forwarding === 'yes' || p.forwarding === 'no' || p.forwarding === 'unknown') caps.forwarding = p.forwarding
    if (p.browser === 'available' || p.browser === 'unavailable') caps.browser = p.browser
    // Only meaningful alongside browser=unavailable; keep it whenever present.
    if (typeof p.browserReason === 'string') caps.browserReason = p.browserReason
    return caps
  }
  throw new Error(`no ${CAPS_PREFIX} line found in bootstrap output`)
}

/**
 * sha256 hex over BOTH machine scripts — the stored `bootstrapVersion` a future
 * reconciler diffs to decide whether to re-bootstrap. It covers bootstrap.sh AND
 * box-provision.sh (concatenated in that fixed order) so a change to either
 * script content shifts the hash and re-triggers a push; hashing bootstrap.sh
 * alone would silently miss box-provision.sh edits.
 */
export function computeBootstrapVersion(bootstrapScript: string, boxProvisionScript: string): string {
  return createHash('sha256').update(bootstrapScript).update(boxProvisionScript).digest('hex')
}

/**
 * The bootstrap version the RUNNING core would produce — sha256 over the
 * bootstrap.sh + box-provision.sh {@link effectiveMachineScripts} resolves (the
 * artifact's prebuilt copies when running from a release, else the inlined
 * ones). A machine whose stored `bootstrapVersion` differs from this has a stale
 * on-host bootstrap (e.g. it predates a bootstrap.sh change like
 * install_browser) and should be re-bootstrapped. This is the yardstick the
 * boot-time bootstrap-drift reconciler diffs against, and it MUST be the same
 * derivation `bootstrapMachine` stamps — hence the shared resolution. Callable
 * with zero args (the worker's call site); `opts` is a test seam.
 */
export function currentBootstrapVersion(opts: PrebuiltReadOpts = {}): string {
  const { bootstrapScript, boxProvisionScript } = effectiveMachineScripts(opts)
  return computeBootstrapVersion(bootstrapScript, boxProvisionScript)
}

/**
 * Probe a trivial SSH command until the machine answers with exit 0. A freshly
 * provisioned exe VM accepts the TCP connection (through the proxy) before sshd
 * completes its handshake, so the first real push fails with "Connection closed
 * by remote host" (exit 255); this closes that race. `attempts`/`intervalMs` are
 * parameterized only so the retry is unit-testable without real sleeps.
 */
export async function waitForSshReady(
  runner: SshRunner,
  machine: Machine,
  { attempts = 40, intervalMs = 3000 }: { attempts?: number; intervalMs?: number } = {}
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await runner.run(machine, 'true', { timeoutMs: 15_000 })
      if (res.exitCode === 0) return
    } catch {
      // Connection refused/closed/timed out while the VM boots — treat as not
      // ready and retry.
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`machine ${machine.name} SSH did not become ready after ${attempts} attempts`)
}

async function pushFile(
  runner: SshRunner,
  machine: Machine,
  content: string,
  remotePath: string,
  mode: string
): Promise<void> {
  const command = buildPushFileCommand(remotePath, mode)
  const result = await runner.run(machine, command, { stdin: content })
  if (result.exitCode !== 0) {
    throw new Error(`push to ${remotePath} failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
}

export async function bootstrapMachine(machine: Machine, deps: BootstrapDeps = {}): Promise<MachineCapabilities> {
  const runner = deps.runner ?? defaultSshRunner
  const updateMachine = deps.updateMachine ?? (updateMachineDefault as UpdateMachineFn)
  const waitReady = deps.waitForSshReady ?? waitForSshReady
  const prewarmDevbox = deps.prewarmDevbox ?? defaultPrewarmDevbox

  // Prefer prebuilt scripts shipped in a core artifact; fall back to the copies
  // inlined into the bundle at build time. The version stamp, the pushed bytes
  // and `currentBootstrapVersion` all read from this one function so they can
  // never disagree.
  const { bootstrapScript: effectiveBootstrapScript, boxProvisionScript: effectiveBoxProvisionScript } =
    effectiveMachineScripts(deps.prebuilt)

  const bootstrapVersion = computeBootstrapVersion(effectiveBootstrapScript, effectiveBoxProvisionScript)

  try {
    // 0. A freshly PROVISIONED VM (exe auto-provision) can return its SSH
    //    endpoint before sshd is actually accepting, so the very first push
    //    fails with "Connection closed by remote host" (exit 255) — observed on
    //    the tight background warmup path, which provisions and bootstraps within
    //    seconds. Wait for SSH to answer first. A BYO machine that is already up
    //    passes on the first probe (negligible).
    await waitReady(runner, machine)

    // 1. Push bootstrap.sh (executable) to a scratch path.
    await pushFile(runner, machine, effectiveBootstrapScript, BOOTSTRAP_REMOTE_PATH, '0755')

    // 2. Run it: creates /opt/tau, installs base packages + bun, writes the
    //    manifest, and prints the capabilities marker on its final stdout line.
    //    When the machine opts into the egress lockdown, append the activation
    //    flag + one --core-cidr per configured Core CIDR. bootstrap.sh
    //    re-validates each CIDR before it reaches root nft, so shellQuote here is
    //    defence-in-depth, not the sole guard.
    let runCommand = `bash ${shellQuote(BOOTSTRAP_REMOTE_PATH)} --version ${shellQuote(bootstrapVersion)}`
    if (machine.egressPolicy) {
      const coreEgressCidrs = deps.coreEgressCidrs ?? parseCoreEgressCidrs(process.env.FICUS_CORE_EGRESS_CIDR)
      runCommand += ' --egress-lockdown'
      for (const cidr of coreEgressCidrs) {
        runCommand += ` --core-cidr ${shellQuote(cidr)}`
      }
    }
    // bootstrap.sh installs apt base packages + bun + multi-user nix + devbox;
    // on a fresh VM that is minutes, far past the SSH runner's 30s default, so
    // give it a generous wall-clock bound (validated against a live exe.dev VM
    // 2026-07-13, where the default 30s timed out mid-nix-install).
    const result = await runner.run(machine, runCommand, { timeoutMs: BOOTSTRAP_RUN_TIMEOUT_MS })
    if (result.exitCode !== 0) {
      throw new Error(
        `bootstrap.sh failed on ${machine.name} (exit ${result.exitCode}): ` +
          (result.stderr.trim() || result.stdout.trim())
      )
    }
    const capabilities = parseCapabilities(result.stdout)

    // 3. Push box-provision.sh into /opt/tau/bin (root-owned, created by
    //    bootstrap.sh) for slice 2 to invoke per box. It is intentionally NOT
    //    invoked here. Unlike the world-writable /tmp bootstrap push, this
    //    target requires privilege, so stream it through `sudo install` — this
    //    assumes the SSH user is a passwordless sudoer, exactly as bootstrap.sh
    //    itself already assumes for its own (root-included) `sudo` steps.
    //    BOX_PROVISION_REMOTE_PATH is a compile-time constant, so single-quoting
    //    it is sufficient (no interpolated user input).
    const boxProvisionPush = `sudo install -m 0755 /dev/stdin '${BOX_PROVISION_REMOTE_PATH}'`
    const pushResult = await runner.run(machine, boxProvisionPush, { stdin: effectiveBoxProvisionScript })
    if (pushResult.exitCode !== 0) {
      throw new Error(
        `push to ${BOX_PROVISION_REMOTE_PATH} failed (exit ${pushResult.exitCode}): ${pushResult.stderr.trim()}`
      )
    }

    await updateMachine(machine.id, {
      status: 'ready',
      bootstrapVersion,
      capabilities,
      // Clear any stale error from a prior failed run — a recovered machine
      // should not keep showing an error that no longer applies.
      lastError: null,
    })

    // The machine is now `ready`. Kick a background devbox pre-warm so its
    // `/nix` store + the shared devbox.lock cache are populated before the first
    // user execution lands — eliminating the cold-first-box realization that
    // used to blow the box-health timeout. Fire-and-forget and fault-isolated:
    // wrapped so even a synchronous throw is swallowed here and never reaches
    // the outer catch (which would wrongly mark this ready machine unreachable).
    try {
      prewarmDevbox(machine.id)
    } catch (err) {
      log.warn(`devbox pre-warm kick failed for machine ${machine.id} (non-fatal):`, err)
    }

    return capabilities
  } catch (err) {
    // Persist the SAME message this function throws (the stderr tail for a
    // failed run, or the underlying SSH/push error) so the row itself can tell
    // an operator — or platform provisioning, which only ever polls the row —
    // WHY the bootstrap failed, not just that it did.
    const message = err instanceof Error ? err.message : String(err)
    try {
      await updateMachine(machine.id, { status: 'unreachable', lastError: capLastError(message) })
    } catch {
      // Preserve the original failure even if the status write also fails.
    }
    throw err
  }
}
