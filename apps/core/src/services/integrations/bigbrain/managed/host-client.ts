/**
 * Local bounded invocation of the fixed root helper `/usr/local/libexec/ficus-bigbrainctl`.
 * Only hosted Core on a managed deployment calls it. The helper refuses any caller that is not
 * euid 0, so a Core running as its unprivileged service user goes through `sudo -n` and the
 * single NOPASSWD rule the installer writes (`<user> ALL=(root) NOPASSWD: <helper> ""`: the
 * helper, with no arguments). A sudo refusal (exit 1, no reply) means that rule is missing.
 * One strict JSON request goes in on stdin; one strict reply comes back on stdout, capped and
 * validated against the request (ID, action, binding, receipt identity). stderr is drained and
 * discarded, never logged. Errors carry only fixed contract codes. The launcher runs the work in
 * its own transient unit, so a timeout here never kills a half-done host operation: the same
 * request ID replays it.
 */
import {
  MANAGED_BIGBRAIN_CONTRACT_VERSION,
  MANAGED_BIGBRAIN_HELPER,
  MANAGED_BIGBRAIN_HOST_REPLY_BYTES,
  managedBigbrainErrorCodeSchema,
  managedBigbrainHostRequestSchema,
  parseManagedBigbrainHostReply,
  type ManagedBigbrainErrorCode,
  type ManagedBigbrainHostReply,
  type ManagedBigbrainHostRequest,
  type ManagedBigbrainInstalledHost,
} from '@ficus/shared/managed-bigbrain'

export class ManagedHostError extends Error {
  constructor(
    readonly code: ManagedBigbrainErrorCode,
    readonly retryable: boolean
  ) {
    super(code)
    this.name = 'ManagedHostError'
  }
}

type Request = ManagedBigbrainHostRequest
type Action = Request['action']
/** Request body for an action, without the envelope Core fills in from the installed host. */
export type ManagedHostCall = Request extends infer R
  ? R extends Request
    ? Omit<R, 'contractVersion' | 'requestId' | 'tenantId' | 'physicalHostBinding' | 'hostEpoch'>
    : never
  : never

const SLOW = new Set<Action>(['create', 'delete'])
const SUDO = '/usr/bin/sudo'
const STDERR_BYTES = 4096

export interface ManagedHostClientOptions {
  helperPath?: string
  /** Deadline per call; defaults to 200 s for create/delete (launcher RuntimeMaxSec=180) and 30 s otherwise. */
  timeoutMs?: (action: Action) => number
  spawn?: typeof Bun.spawn
  /** The calling process's effective uid; defaults to `process.geteuid()`. */
  euid?: () => number
  sudoPath?: string
}

/** The argv that reaches the root helper: directly as root, through `sudo -n` otherwise. */
export function managedHelperArgv(helper: string, euid: number, sudo = SUDO): string[] {
  return euid === 0 ? [helper] : [sudo, '-n', helper]
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number
): Promise<{ bytes: Uint8Array; over: boolean }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let over = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) {
        over = true
        await reader.cancel().catch(() => {})
        break
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return { bytes: Buffer.concat(chunks), over }
}

export function createManagedHostClient(options: ManagedHostClientOptions = {}) {
  const helper = options.helperPath ?? MANAGED_BIGBRAIN_HELPER
  const spawn = options.spawn ?? Bun.spawn
  const euid = options.euid ?? (() => process.geteuid?.() ?? 0)
  const sudo = options.sudoPath ?? SUDO
  const deadline = options.timeoutMs ?? ((action: Action) => (SLOW.has(action) ? 200_000 : 30_000))
  // One call at a time from this process; across processes the launcher's flock answers `busy`.
  let queue: Promise<unknown> = Promise.resolve()

  async function invoke(request: Request): Promise<ManagedBigbrainHostReply> {
    const body = new TextEncoder().encode(JSON.stringify(request))
    const argv = managedHelperArgv(helper, euid(), sudo)
    const viaSudo = argv.length > 1
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = spawn(argv, {
        cwd: '/',
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') throw new ManagedHostError('not_installed', false)
      throw new ManagedHostError('host_unreachable', true)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    // The deadline wins even if a descendant still holds the pipes open after the kill.
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already exited.
        }
        reject(new ManagedHostError('host_unreachable', true))
      }, deadline(request.action))
    })
    try {
      const stdin = child.stdin as import('bun').FileSink
      stdin.write(body)
      await stdin.end()
      const [stdout, , exitCode] = await Promise.race([
        Promise.all([
          readCapped(child.stdout as ReadableStream<Uint8Array>, MANAGED_BIGBRAIN_HOST_REPLY_BYTES),
          // Drained so the child never blocks on a full pipe; never kept or logged.
          readCapped(child.stderr as ReadableStream<Uint8Array>, STDERR_BYTES),
          child.exited,
        ]),
        expired,
      ])
      if (stdout.over) {
        child.kill('SIGKILL')
        throw new ManagedHostError('output_limit', true)
      }
      if (exitCode === 78) throw new ManagedHostError('not_installed', false)
      const text = new TextDecoder().decode(stdout.bytes).trim()
      // sudo refused (no NOPASSWD rule for this account): nothing to retry until it is installed.
      if (viaSudo && exitCode === 1 && text === '') throw new ManagedHostError('not_installed', false)
      const line = text.split('\n').at(-1) ?? ''
      try {
        return parseManagedBigbrainHostReply(line)
      } catch {
        throw new ManagedHostError(exitCode === 0 ? 'invalid_response' : 'operation_failed', exitCode !== 0)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  function verify(request: Request, reply: ManagedBigbrainHostReply): ManagedBigbrainHostReply {
    if (reply.requestId !== request.requestId) throw new ManagedHostError('identity_mismatch', false)
    if (!reply.ok) {
      const code = managedBigbrainErrorCodeSchema.safeParse(reply.code)
      throw new ManagedHostError(code.success ? code.data : 'operation_failed', reply.retryable)
    }
    if (reply.action !== request.action || reply.physicalHostBinding !== request.physicalHostBinding)
      throw new ManagedHostError('identity_mismatch', false)
    if ('receipt' in reply) {
      const r = reply.receipt
      if (
        !('vaultId' in request) ||
        r.vaultId !== request.vaultId ||
        r.tenantId !== request.tenantId ||
        r.physicalHostBinding !== request.physicalHostBinding ||
        r.hostEpoch > request.hostEpoch ||
        ('generation' in request && request.action !== 'delete' && r.generation !== request.generation) ||
        ('origin' in request && r.origin !== request.origin)
      )
        throw new ManagedHostError('identity_mismatch', false)
    }
    if ('capabilities' in reply && reply.capabilities.tenantId !== request.tenantId)
      throw new ManagedHostError('identity_mismatch', false)
    // Member replies name the vault, invitation and member they acted on: exactly the request's.
    if (
      ('vaultId' in reply && (!('vaultId' in request) || reply.vaultId !== request.vaultId)) ||
      ('inviteId' in reply && (!('inviteId' in request) || reply.inviteId !== request.inviteId)) ||
      ('member' in reply && (!('handle' in request) || reply.member.handle !== request.handle))
    )
      throw new ManagedHostError('identity_mismatch', false)
    return reply
  }

  return {
    /** Send one helper request for `host` (the installed record supplies the envelope). */
    async call(
      host: Pick<ManagedBigbrainInstalledHost, 'tenantId' | 'physicalHostBinding' | 'hostEpoch'>,
      requestId: string,
      call: ManagedHostCall
    ): Promise<Extract<ManagedBigbrainHostReply, { ok: true }>> {
      const parsed = managedBigbrainHostRequestSchema.safeParse({
        contractVersion: MANAGED_BIGBRAIN_CONTRACT_VERSION,
        requestId,
        tenantId: host.tenantId,
        physicalHostBinding: host.physicalHostBinding,
        hostEpoch: host.hostEpoch,
        ...call,
      })
      // Validated before any process starts: an invalid request never reaches root.
      if (!parsed.success) throw new ManagedHostError('invalid_request', false)
      const request = parsed.data
      const run = queue.then(async () => verify(request, await invoke(request)))
      queue = run.catch(() => {})
      return (await run) as Extract<ManagedBigbrainHostReply, { ok: true }>
    },
  }
}
export type ManagedHostClient = ReturnType<typeof createManagedHostClient>
