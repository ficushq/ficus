import { createLogger } from '../../../lib/infra/logger'
import { MachineProviderError } from '../provider'

const log = createLogger('exe-api')

/**
 * exe-api.ts — the ONLY module in tau that knows exe.dev's wire format.
 *
 * The wire format below is VERIFIED against a real exe.dev account (live recon
 * 2026-07-13) plus the official docs (https://exe.dev/docs/api.md, /proxy.md),
 * except where explicitly tagged UNVERIFIED. The adapter (`exe.ts`) and the
 * placement policy depend on the {@link ExeApi} interface, never on the wire
 * format, so future corrections stay local to this module.
 *
 * Design: exe.dev exposes an SSH "lobby" — you `ssh exe.dev <subcommand> --json`
 * and it provisions/lists/removes persistent KVM VMs, each reachable at
 * `<vm_name>.exe.xyz` as user `exedev`. We drive that lobby through an injected
 * {@link ExeExec} so tests use a fake (no network) and the real network path is
 * isolated to {@link defaultExeExec}.
 *
 * Auth model (VERIFIED, critical): exe.dev's proxy authenticates SSH against
 * ACCOUNT-registered keys ONLY. A key placed in a VM's own authorized_keys is
 * REJECTED, and one account key reaches EVERY VM under the account (and the
 * lobby itself). So there are no per-machine keys and no pubkey injection at
 * create — the SAME account SSH private key (the `token` below) is every VM's
 * identity. See {@link defaultExeExec} and provider-credentials.ts.
 *
 * VERIFIED API inventory (live recon 2026-07-13):
 *   - Lobby host is `exe.dev`; subcommands are positional argv:
 *       create : `new --name <name> [--image <OWNER/IMAGE:TAG>] --json`
 *       list   : `ls --json`
 *       remove : `rm <vm_name>`
 *   - `new --name <name> --json` echoes `--name` back as `vm_name` and emits a
 *     JSON OBJECT: `{ vm_name, ssh_dest, ssh_port, https_url, proxy_port, ... }`.
 *     There is NO `--ssh-key` flag; sizing is `--cpu/--memory/--disk` (defaults
 *     2cpu/8gb — we omit them). Missing `ssh_dest` ⇒ derive `<vm_name>.exe.xyz`;
 *     missing `ssh_port` ⇒ 22. SSH user is ALWAYS `exedev` (not in the JSON).
 *   - `new --image <OWNER/IMAGE:TAG>` (VERIFIED, live recon 2026-07-13) boots a
 *     custom OCI image as the VM instead of the default exeuntu; PUBLIC images
 *     pull with no `--registry-auth`. Optional — omitted ⇒ exe's default image.
 *   - `ls --json` emits `{ "vms": [ { vm_name, ssh_dest, ssh_port, status, ... } ] }`
 *     — an OBJECT with a `.vms` ARRAY. exe VMs are persistent: `status` is
 *     `running`; there is no `stopped` in the lobby (restart exists, no stop).
 *   - `rm <vm_name>` destroys the VM (disk included); `ref === vm_name`.
 *   - Token = the account SSH PRIVATE key, offered via `-i` to the lobby.
 *
 * UNVERIFIED (not recon'd 2026-07-13):
 *   - `cp <src> <newName> --json` (CoW clone) — command and response shape are
 *     assumed to mirror `new`; unused this slice ({@link ExeApi.cloneVm}).
 *   - `rm`/`cp` failure semantics (non-zero exit + human stderr) — assumed.
 */

/** Result of one lobby invocation. Mirrors the SSH runner's result shape. */
export interface ExeExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Runs one exe.dev lobby subcommand. `args` is the positional argv AFTER the
 * `ssh exe.dev` prefix (e.g. `['new', '--name', 'x', '--json']`). Injected so
 * tests supply a fake and the only real-network path is {@link defaultExeExec}.
 */
export type ExeExec = (args: string[]) => Promise<ExeExecResult>

/** A provisioned/cloned VM's SSH endpoint, as the machine row needs it. */
export interface ExeVm {
  name: string
  sshHost: string
  sshPort: number
  sshUser: string
  ref: string
}

/**
 * The isolation boundary. `exe.ts` (the MachineProvider adapter) depends ONLY
 * on this interface, never on the wire format above. No `publicKey`: exe rejects
 * per-VM keys, so nothing is injected at create (see the auth model above).
 */
export interface ExeApi {
  /**
   * Provision a VM. `image` (optional) selects the OCI image the VM boots from
   * (exe `new --image <image>`); when omitted/empty, exe boots its default
   * exeuntu image. See {@link createExeApi} for the argv details.
   */
  createVm(opts: { name: string; image?: string }): Promise<ExeVm>
  destroyVm(ref: string): Promise<void>
  getVm(ref: string): Promise<{ state: 'running' | 'stopped' | 'gone' } | null>
  /** CoW clone (future — squad fan-out). Optional per the interface. UNVERIFIED shape. */
  cloneVm?(ref: string, newName: string): Promise<ExeVm>
}

function parseJson(stdout: string, context: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new MachineProviderError(`exe.dev ${context}: malformed JSON response`)
  }
}

/**
 * Turn a `new`/`cp` JSON object into an {@link ExeVm}. Requires `vm_name` (the
 * VM reference); tolerant of a missing `ssh_dest`/`ssh_port` (derives the host
 * and defaults the port). The SSH user is ALWAYS `exedev` — it is not in the
 * JSON (VERIFIED, live recon 2026-07-13).
 */
function toExeVm(raw: unknown, context: string): ExeVm {
  if (typeof raw !== 'object' || raw === null) {
    throw new MachineProviderError(`exe.dev ${context}: expected a JSON object`)
  }
  const obj = raw as Record<string, unknown>
  const vmName = obj.vm_name
  if (typeof vmName !== 'string' || vmName.length === 0) {
    throw new MachineProviderError(`exe.dev ${context}: response missing vm_name`)
  }
  const sshHost = typeof obj.ssh_dest === 'string' && obj.ssh_dest.length > 0 ? obj.ssh_dest : `${vmName}.exe.xyz`
  const sshPort = typeof obj.ssh_port === 'number' ? obj.ssh_port : 22
  return { name: vmName, sshHost, sshPort, sshUser: 'exedev', ref: vmName }
}

/**
 * Build an {@link ExeApi} over the injected lobby exec (or the default SSH-lobby
 * runner). `token` is the account SSH private key retained for the default
 * runner's auth; when `exec` is injected (tests) the token is that runner's
 * concern.
 */
export function createExeApi(deps: { token: string; exec?: ExeExec }): ExeApi {
  const exec = deps.exec ?? defaultExeExec(deps.token)

  async function run(args: string[], context: string): Promise<ExeExecResult> {
    const result = await exec(args)
    if (result.exitCode !== 0) {
      throw new MachineProviderError(
        `exe.dev ${context} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`
      )
    }
    return result
  }

  return {
    async createVm(opts): Promise<ExeVm> {
      // VERIFIED (live recon 2026-07-13): `new --name <name> --json` provisions a
      // persistent VM and echoes `--name` back as `vm_name` in the endpoint JSON.
      // No `--ssh-key` (exe rejects per-VM keys — the account key already reaches
      // it); no `--size` (sizing is --cpu/--memory/--disk; defaults are fine).
      const args = ['new', '--name', opts.name]
      // VERIFIED (live recon 2026-07-13): `new --image <OWNER/IMAGE:TAG>` boots a
      // custom OCI image as the VM. When `image` is unset/empty we omit the flag
      // and exe boots its default exeuntu image. The ficus-machine image is PUBLIC
      // on ghcr, so no `--registry-auth` is needed.
      //
      // FUTURE HOOK (do not build now): a PRIVATE image would additionally need
      // `--registry-auth <token>` threaded here from a secret. Left intentionally
      // unimplemented — the current image is public.
      if (opts.image) args.push('--image', opts.image)
      args.push('--json')
      const result = await run(args, 'createVm')
      return toExeVm(parseJson(result.stdout, 'createVm'), 'createVm')
    },

    async destroyVm(ref): Promise<void> {
      // VERIFIED (live recon 2026-07-13): `rm <vm_name>` destroys the VM (disk
      // included). `ref === vm_name`.
      await run(['rm', ref], 'destroyVm')
    },

    async getVm(ref): Promise<{ state: 'running' | 'stopped' | 'gone' } | null> {
      // VERIFIED (live recon 2026-07-13): `ls --json` emits `{ "vms": [...] }` —
      // an object with a `.vms` array, entries keyed by `vm_name`. There is no
      // per-VM status endpoint, so we filter the listing by ref.
      const result = await run(['ls', '--json'], 'getVm')
      const parsed = parseJson(result.stdout, 'getVm')
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).vms)) {
        throw new MachineProviderError('exe.dev getVm: expected a JSON object with a `.vms` array')
      }
      const vms = (parsed as { vms: unknown[] }).vms
      const entry = vms.find(
        (e): e is Record<string, unknown> =>
          typeof e === 'object' && e !== null && (e as Record<string, unknown>).vm_name === ref
      )
      // Absent from the listing ⇒ destroyed / never existed ⇒ gone (null).
      if (!entry) return null
      // VERIFIED: exe VMs are persistent — `status` is `running` in practice; the
      // lobby has no `stopped` (restart exists, no stop), but we keep the mapping.
      //
      // Fail-safe default: ONLY the known-good values map to running/stopped. ANY
      // unrecognized value (e.g. a live 'error'/'crashed'/'provisioning') maps to
      // `gone` — a machine reporting an unknown state is treated as unreachable so
      // the lifecycle machine-health sweep can act on it, rather than being
      // silently reported healthy (the wrong direction for a health signal).
      const status = entry.status
      if (status === undefined || status === 'running') return { state: 'running' }
      if (status === 'stopped') return { state: 'stopped' }
      return { state: 'gone' }
    },

    async cloneVm(ref, newName): Promise<ExeVm> {
      // UNVERIFIED (not recon'd 2026-07-13): `cp <src> <newName> --json` is
      // ASSUMED to CoW-clone a VM and emit the clone's endpoint JSON (same shape
      // as `new`). Unused this slice; confirm before relying on it.
      const result = await run(['cp', ref, newName, '--json'], 'cloneVm')
      return toExeVm(parseJson(result.stdout, 'cloneVm'), 'cloneVm')
    },
  }
}

/**
 * Default lobby runner: `ssh exe.dev <args...>`, authenticating with the account
 * SSH private key (`token`) offered via `-i`.
 *
 * VERIFIED (live recon 2026-07-13): the token IS the account SSH private key;
 * exe.dev's proxy accepts it for the lobby AND for every VM under the account.
 * We materialize it 0600 and offer it with `IdentitiesOnly=yes` so only that key
 * is presented, plus `IdentityAgent=none` to bypass any ssh-agent / 1Password
 * agent on the deploy host (a live-recon gotcha — an agent-held key would be
 * tried first and rejected). This path is exercised only by the gated
 * integration test, never by the unit tests (which inject a fake exec).
 */
const EXE_EXEC_DEFAULT_TIMEOUT_MS = 20_000
/** Node/Bun timers clamp or overflow above a signed 32-bit millisecond delay. */
export const EXE_EXEC_MAX_TIMEOUT_MS = 2_147_483_647

/** Typed even while values remain equal: live calibration must justify changing them. */
export const EXE_EXEC_OPERATION_TIMEOUT_MS = {
  create: EXE_EXEC_DEFAULT_TIMEOUT_MS,
  destroy: EXE_EXEC_DEFAULT_TIMEOUT_MS,
  list: EXE_EXEC_DEFAULT_TIMEOUT_MS,
  clone: EXE_EXEC_DEFAULT_TIMEOUT_MS,
} as const

export type ExeOperation = keyof typeof EXE_EXEC_OPERATION_TIMEOUT_MS | 'unknown'
export type ExeExecOutcome = 'success' | 'error' | 'timeout' | 'abort'
export interface ExeExecObservation {
  operation: ExeOperation
  outcome: ExeExecOutcome
  durationMs: number
  timeoutMs: number
}

/**
 * Operator overrides for each class's runtime deadline, in milliseconds.
 *
 * These exist because the budgets above are a BOUND, not a measurement: nobody
 * has ever timed `ssh exe.dev new` against a live account, and whether
 * `new --image` returns before or after the OCI image pull is undocumented.
 * Without an env seam, discovering that 20s is too short for real provisioning
 * would require a code change and a redeploy of every tenant instance — during
 * an outage in which no VM can be created. `defaultExeExec` reads these, and
 * `createExeApi` builds its executor from it, so an operator can widen
 * `create` on a running instance and confirm the theory in minutes.
 */
export const EXE_EXEC_TIMEOUT_ENV_VARS = {
  create: 'FICUS_EXE_EXEC_CREATE_TIMEOUT_MS',
  destroy: 'FICUS_EXE_EXEC_DESTROY_TIMEOUT_MS',
  list: 'FICUS_EXE_EXEC_LIST_TIMEOUT_MS',
  clone: 'FICUS_EXE_EXEC_CLONE_TIMEOUT_MS',
} as const

/**
 * Parse override env vars as positive safe-integer milliseconds no greater
 * than {@link EXE_EXEC_MAX_TIMEOUT_MS}.
 *
 * Ignore-and-warn rather than throw: a typo in a deploy's environment must not
 * take provisioning down. It must also NEVER silently become `0` or `NaN` —
 * `Number('')` is 0 and `Number('20s')` is NaN, which would turn the deadline
 * into "time out instantly" or "never time out" without a word in the log.
 *
 * `env` is a parameter rather than a direct `process.env` read so tests inject
 * their cases explicitly. Bun auto-loads `./.env` into `process.env` before
 * user code runs, so a test that asserted the default by relying on a variable
 * being ABSENT from the ambient environment would be at the mercy of whatever
 * `.env` happens to sit beside it.
 */
export function resolveExeExecTimeoutOverrides(
  env: Record<string, string | undefined>
): Partial<Record<Exclude<ExeOperation, 'unknown'>, number>> {
  const overrides: Partial<Record<Exclude<ExeOperation, 'unknown'>, number>> = {}
  for (const [operation, name] of Object.entries(EXE_EXEC_TIMEOUT_ENV_VARS) as Array<
    [Exclude<ExeOperation, 'unknown'>, string]
  >) {
    const raw = env[name]
    if (raw === undefined) continue
    const parsed = Number(raw)
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(parsed) || parsed > EXE_EXEC_MAX_TIMEOUT_MS) {
      log.warn(`Ignoring invalid ${name}; expected integer milliseconds within the supported timer range`, {
        operation,
        fallbackMs: EXE_EXEC_OPERATION_TIMEOUT_MS[operation],
        valueLength: Math.min(raw.length, 1_024),
        valueLengthTruncated: raw.length > 1_024,
      })
      continue
    }
    overrides[operation] = parsed
  }
  return overrides
}

function classifyExeOperation(args: readonly string[]): ExeOperation {
  switch (args[0]) {
    case 'new':
      return 'create'
    case 'rm':
      return 'destroy'
    case 'ls':
      return 'list'
    case 'cp':
      return 'clone'
    default:
      return 'unknown'
  }
}
const EXE_EXEC_OUTPUT_CAPTURE_BYTES = 1024 * 1024
const EXE_EXEC_CLEANUP_GRACE_MS = 250

export interface DefaultExeExecOptions {
  /**
   * Subprocess runtime deadline, starting immediately after spawn. Defaults to
   * 20 seconds; local temp-file setup happens before this runtime deadline.
   */
  timeoutMs?: number
  /**
   * Per-operation runtime deadlines. Defaults remain equal until live
   * calibration supplies evidence. Takes precedence over
   * {@link EXE_EXEC_TIMEOUT_ENV_VARS} so a test's explicit budget can never be
   * moved by a stray `.env` in the process's cwd.
   */
  operationTimeoutMs?: Partial<Record<Exclude<ExeOperation, 'unknown'>, number>>
  /** Environment the operator overrides are read from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Secret-safe completion telemetry. Raw argv and credential material are never included. */
  onObservation?: (observation: ExeExecObservation) => void
  /** Cancels every invocation created by this executor. */
  signal?: AbortSignal
  /** Override used by hermetic real-process tests. */
  sshBin?: string
}

type ExeProcess = {
  readonly pid: number
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}

type ExeCompletion = { kind: 'exit'; exitCode: number } | { kind: 'timeout' } | { kind: 'abort' }

function drainBoundedOutput(stream: ReadableStream<Uint8Array>, label: 'stdout' | 'stderr') {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let captured = ''
  let capturedBytes = 0
  let truncated = false

  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        const remaining = Math.max(0, EXE_EXEC_OUTPUT_CAPTURE_BYTES - capturedBytes)
        const prefix = chunk.value.subarray(0, remaining)
        if (prefix.byteLength > 0) {
          captured += decoder.decode(prefix, { stream: true })
          capturedBytes += prefix.byteLength
        }
        if (chunk.value.byteLength > remaining) truncated = true
      }
    } catch {
      // Cancellation and pipe closure are expected during bounded cleanup.
    } finally {
      captured += decoder.decode()
    }
  })()

  let cancelPromise: Promise<void> | undefined
  return {
    done,
    text: () => captured + (truncated ? `\n[${label} truncated]` : ''),
    cancel: () => {
      cancelPromise ??= Promise.resolve()
        .then(() => reader.cancel())
        .catch(() => {})
      return cancelPromise
    },
  }
}

async function settleExeWithin(promises: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = Promise.allSettled(promises).then(() => true)
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([settled, expired])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function terminateExeProcessTree(proc: ExeProcess): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      try {
        proc.kill('SIGKILL')
      } catch {
        // The direct child and its private process group have already exited.
      }
    }
    return
  }

  try {
    const killer = Bun.spawn(['taskkill.exe', '/PID', String(proc.pid), '/T', '/F'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
      timeout: EXE_EXEC_CLEANUP_GRACE_MS,
      killSignal: 'SIGKILL',
    })
    await settleExeWithin([killer.exited], EXE_EXEC_CLEANUP_GRACE_MS)
  } catch {
    // Fall through to the direct-child best effort.
  }
  try {
    proc.kill('SIGKILL')
  } catch {
    // The direct child has already exited.
  }
}

export function supportsExePosixIdentityCleaner(platform: NodeJS.Platform): boolean {
  return platform === 'linux' || platform === 'darwin'
}

function startPosixIdentityCleaner(dir: string) {
  return Bun.spawn(['/bin/sh', '-c', 'IFS= read -r _ || true\nrm -f -- id'], {
    cwd: dir,
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  })
}

function exeLifecycleError(name: 'TimeoutError' | 'AbortError', message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

export function defaultExeExec(token: string, options: DefaultExeExecOptions = {}): ExeExec {
  const fallbackTimeoutMs = options.timeoutMs ?? EXE_EXEC_DEFAULT_TIMEOUT_MS
  const operationTimeoutMs = {
    ...EXE_EXEC_OPERATION_TIMEOUT_MS,
    ...resolveExeExecTimeoutOverrides(options.env ?? process.env),
    ...options.operationTimeoutMs,
  }
  for (const timeoutMs of [fallbackTimeoutMs, ...Object.values(operationTimeoutMs)]) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > EXE_EXEC_MAX_TIMEOUT_MS) {
      throw new RangeError(`defaultExeExec timeoutMs must be an integer from 1 to ${EXE_EXEC_MAX_TIMEOUT_MS}`)
    }
  }

  return async (args) => {
    const operation = classifyExeOperation(args)
    const timeoutMs = operation === 'unknown' ? fallbackTimeoutMs : operationTimeoutMs[operation]
    const startedAt = performance.now()
    let outcome: ExeExecOutcome = 'error'
    const observe = () => {
      const observation: ExeExecObservation = {
        operation,
        outcome,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        timeoutMs,
      }
      try {
        options.onObservation?.(observation)
      } catch {
        // Observability must never alter provider behavior.
      }
      log.debug('lobby invocation', observation)
    }
    try {
      if (options.signal?.aborted) throw exeLifecycleError('AbortError', 'exe.dev ssh invocation aborted')

      const { mkdtemp, open, lstat, unlink, rmdir } = await import('fs/promises')
      const { tmpdir } = await import('os')
      const { join } = await import('path')
      const dir = await mkdtemp(join(tmpdir(), 'exe-lobby-'))
      const ownedDir = await lstat(dir)
      const identityPath = join(dir, 'id')
      let identityCleaner: ReturnType<typeof startPosixIdentityCleaner> | undefined
      let cleanupProcess: (() => Promise<void>) | undefined
      let removeAbortListener: (() => void) | undefined

      try {
        // Account SSH private key materialized 0600 as an SSH identity (VERIFIED).
        const identity = await open(identityPath, 'wx', 0o600)
        try {
          await identity.writeFile(token.endsWith('\n') ? token : `${token}\n`)
        } finally {
          await identity.close()
        }
        // Pin the owned directory as the helper's cwd before the SSH child learns
        // its pathname. EOF (including a parent crash) releases the helper to
        // unlink cwd/id, so later renames cannot redirect credential deletion.
        if (supportsExePosixIdentityCleaner(process.platform)) identityCleaner = startPosixIdentityCleaner(dir)
        // Cancellation during local setup must not launch a subprocess afterward.
        if (options.signal?.aborted) throw exeLifecycleError('AbortError', 'exe.dev ssh invocation aborted')

        const proc = Bun.spawn(
          [
            options.sshBin ?? 'ssh',
            '-o',
            'BatchMode=yes',
            '-o',
            'StrictHostKeyChecking=accept-new',
            '-o',
            'IdentitiesOnly=yes',
            '-o',
            'IdentityAgent=none',
            '-i',
            identityPath,
            'exe.dev',
            ...args,
          ],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            stdin: 'ignore',
            ...(process.platform === 'win32' ? {} : { detached: true }),
          }
        )
        const lifecycle: {
          stdoutDrain?: ReturnType<typeof drainBoundedOutput>
          stderrDrain?: ReturnType<typeof drainBoundedOutput>
          completion?: ExeCompletion
        } = {}
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined
        let cleanupPromise: Promise<void> | undefined

        // Register ownership immediately after spawn: every later setup failure
        // still terminates/reaps the tree before the temp identity is removed.
        cleanupProcess = () => {
          cleanupPromise ??= (async () => {
            if (timeoutTimer) clearTimeout(timeoutTimer)
            removeAbortListener?.()
            // This is load-bearing even after direct exit because descendants can
            // retain either pipe. POSIX group-ID reuse is a narrow residual risk;
            // Bun exposes no group handle that can eliminate it.
            await terminateExeProcessTree(proc)

            const drains = [lifecycle.stdoutDrain, lifecycle.stderrDrain].filter(
              (drain): drain is ReturnType<typeof drainBoundedOutput> => drain !== undefined
            )
            const drainPromises = drains.map((drain) => drain.done)
            if (lifecycle.completion?.kind === 'exit') {
              const drained = await settleExeWithin(drainPromises, EXE_EXEC_CLEANUP_GRACE_MS)
              if (!drained) {
                await settleExeWithin(
                  drains.map((drain) => drain.cancel()),
                  EXE_EXEC_CLEANUP_GRACE_MS
                )
              }
            } else {
              await settleExeWithin(
                drains.map((drain) => drain.cancel()),
                EXE_EXEC_CLEANUP_GRACE_MS
              )
            }
            await settleExeWithin([proc.exited, ...drainPromises], EXE_EXEC_CLEANUP_GRACE_MS)
          })()
          return cleanupPromise
        }

        lifecycle.stdoutDrain = drainBoundedOutput(proc.stdout, 'stdout')
        lifecycle.stderrDrain = drainBoundedOutput(proc.stderr, 'stderr')

        const exit = proc.exited.then((exitCode): ExeCompletion => ({ kind: 'exit', exitCode }))
        const deadline = new Promise<ExeCompletion>((resolve) => {
          timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
        })
        const aborted = new Promise<ExeCompletion>((resolve) => {
          if (!options.signal) return
          const onAbort = () => resolve({ kind: 'abort' })
          options.signal.addEventListener('abort', onAbort, { once: true })
          removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
          // Abort may have happened between the preflight check and listener setup.
          if (options.signal.aborted) onAbort()
        })
        const completion = await Promise.race([exit, deadline, aborted])
        lifecycle.completion = completion
        await cleanupProcess()

        const stdout = lifecycle.stdoutDrain.text()
        const stderr = lifecycle.stderrDrain.text()
        if (completion.kind === 'timeout') {
          outcome = 'timeout'
          const detail = stderr.trim()
          throw exeLifecycleError(
            'TimeoutError',
            `exe.dev ssh invocation timed out after ${timeoutMs}ms${detail ? `: ${detail}` : ''}`
          )
        }
        if (completion.kind === 'abort') {
          outcome = 'abort'
          const detail = stderr.trim()
          throw exeLifecycleError('AbortError', `exe.dev ssh invocation aborted${detail ? `: ${detail}` : ''}`)
        }
        outcome = completion.exitCode === 0 ? 'success' : 'error'
        return { exitCode: completion.exitCode, stdout, stderr }
      } finally {
        removeAbortListener?.()
        await cleanupProcess?.()
        // Delete only the identity owned by this invocation. On POSIX the
        // cleaner's cwd remains bound to the directory inode across renames;
        // Windows retains its pre-existing pathname cleanup behavior.
        try {
          if (identityCleaner) {
            identityCleaner.stdin.end()
            const cleaned = await settleExeWithin([identityCleaner.exited], EXE_EXEC_CLEANUP_GRACE_MS)
            if (!cleaned) log.error('temp identity cleaner did not exit', { operation })
          } else {
            await unlink(identityPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') log.error('failed to unlink temp identity', { operation, code: error.code })
            })
          }
          const currentDir = await lstat(dir)
          if (currentDir.dev === ownedDir.dev && currentDir.ino === ownedDir.ino && currentDir.isDirectory()) {
            await rmdir(dir).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') {
                log.error('failed to remove temp identity directory', { operation, code: error.code })
              }
            })
          } else {
            log.warn('refusing cleanup of replaced temp identity path', { operation })
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT') log.error('failed to inspect temp identity directory', { operation, code })
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') outcome = 'abort'
      else if ((error as Error).name === 'TimeoutError') outcome = 'timeout'
      throw error
    } finally {
      observe()
    }
  }
}
