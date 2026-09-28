/**
 * HTTP client for the Tool Executor service.
 *
 * Replaces the gRPC client with plain HTTP + JSON.
 * - Unary RPCs → POST with JSON body/response
 * - Server streaming (bash) → POST returning SSE stream
 * - Bidirectional streaming (shell) → WebSocket
 *
 * No TLS/mTLS — pod-to-pod traffic stays within the cluster VPC.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import type { SandboxPressure, SandboxProcesses, SandboxProcessSignal } from '@ficus/shared'
import { withLegacyEnvAliases } from '@ficus/shared/legacy-env'

export type SandboxTransportKind = 'connection_refused' | 'connection_reset' | 'timeout' | 'network' | 'socket_closed'

export type SandboxTransportPhase = 'connect' | 'response'

/** A secret-safe transport failure suitable for recovery decisions. */
export class SandboxTransportError extends Error {
  readonly code = 'SANDBOX_TRANSPORT'

  constructor(
    readonly kind: SandboxTransportKind,
    readonly phase: SandboxTransportPhase,
    cause: unknown
  ) {
    super(`Sandbox transport ${kind.replaceAll('_', ' ')}`, { cause })
    this.name = 'SandboxTransportError'
  }
}

/**
 * Classify Bun and Node transport errors, including their nested `cause` chain.
 * The returned error intentionally omits endpoints and raw transport messages.
 */
export function classifySandboxTransportError(
  error: unknown,
  phase: SandboxTransportPhase = 'connect'
): SandboxTransportError | null {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    const value = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }
    if (value.name === 'AbortError') return null
    const code = typeof value.code === 'string' ? value.code.toUpperCase() : ''
    const message = typeof value.message === 'string' ? value.message.toLowerCase() : ''
    let kind: SandboxTransportKind | undefined
    if (code === 'ECONNREFUSED') kind = 'connection_refused'
    else if (code === 'ECONNRESET' || code === 'EPIPE') kind = 'connection_reset'
    else if (code === 'ETIMEDOUT' || message.includes('timed out') || message.includes('timeout')) kind = 'timeout'
    else if (message.includes('socket connection was closed unexpectedly')) kind = 'socket_closed'
    else if (
      ['ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND'].includes(code) ||
      message.includes('unable to connect') ||
      message.includes('dns lookup failed')
    )
      kind = 'network'
    if (kind) return new SandboxTransportError(kind, phase, error)
    current = value.cause
  }
  return null
}

/**
 * Error thrown by {@link SandboxClient} unary RPCs when the box server answers
 * with a non-2xx status. Carries the HTTP status so callers can distinguish
 * e.g. a 404 (route absent — stale server bundle during a rollout) from a 400
 * (path-guard rejection) or a 500 (fs failure).
 */
export class SandboxHttpError extends Error {
  readonly status: number
  readonly code?: string
  readonly phase?: string
  readonly errno?: string
  readonly filesystemClass?: string

  constructor(
    message: string,
    status: number,
    code?: string,
    phase?: string,
    errno?: string,
    filesystemClass?: string
  ) {
    super(message)
    this.name = 'SandboxHttpError'
    this.status = status
    this.code = code
    this.phase = phase
    this.errno = errno
    this.filesystemClass = filesystemClass
  }
}

function boundUtf8(value: string, maxBytes = 512): string {
  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

function sanitizeHttpErrorBody(body: string): string {
  return body.replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
}

async function formatHttpError(resp: Response): Promise<string> {
  const body = sanitizeHttpErrorBody((await resp.text().catch(() => '')).trim())
  const detail = body ? ` ${body.slice(0, 1000)}` : resp.statusText ? ` ${resp.statusText}` : ''
  return `${resp.status}${detail}`
}

export type SandboxFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const BASH_CANCEL_TIMEOUT_MS = 12_000
export class BashCleanupUnprovenError extends Error {
  readonly code = 'BASH_CLEANUP_UNPROVEN'
  constructor(
    message: string,
    readonly invocationId?: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'BashCleanupUnprovenError'
  }
}

export class BashOutcomeUnknownError extends Error {
  readonly code = 'BASH_OUTCOME_UNKNOWN'

  constructor(
    readonly invocationId: string,
    readonly failureClass: SandboxTransportKind | 'protocol_truncated',
    cause?: unknown
  ) {
    super('Bash invocation outcome is unknown; cleanup proof is required', { cause })
    this.name = 'BashOutcomeUnknownError'
  }
}

/**
 * One release (Ficus rename): per-command env overrides also carry the TAU_
 * spelling of every FICUS_ name. An executor started before the upgrade (an
 * existing pod or box) neither bridges nor aliases, and its user scripts and
 * `tau` CLI still read TAU_API_URL / TAU_TOKEN.
 */
function withLegacyEnvOverrides<T extends { env?: Record<string, string> }>(request: T): T {
  return request.env ? { ...request, env: withLegacyEnvAliases(request.env) } : request
}

// ---------------------------------------------------------------------------
// Request/Response types
// ---------------------------------------------------------------------------

export interface BashRequest {
  command: string
  invocationId?: string
  cwd?: string
  env?: Record<string, string>
  timeoutSeconds?: number
  sourceEnv?: boolean
  activateDevbox?: boolean
}

export interface BashResponse {
  stdout?: string // base64
  invocation?: {
    id: string
    generation: number
    pid: number
    pgid: number
    sid: number
    commandDigest: string
    startedAt: string
    terminalAt?: string
  }
  stderr?: string // base64
  exitCode?: number
  error?: string
}

export interface ReadRequest {
  path: string
  offset?: number
  limit?: number
}

export interface ReadResponse {
  content: string // base64
  totalSize: number
  isBinary: boolean
}

export interface WriteRequest {
  path: string
  content: string // base64
  createDirs?: boolean
  /** Optional octal permission string (e.g. "0600") applied AT file creation by
   *  the sandbox server, so secrets never briefly land at the umask default.
   *  Validated server-side against `^0[0-7]{3}$`. */
  mode?: string
}

export interface WriteResponse {
  bytesWritten: number
}

export interface FileIdentity {
  bytes: number
  sha256: string
}

export interface VerifiedWriteRequest {
  path: string
  content: string
  expectedOriginal: FileIdentity
  expectedResult: FileIdentity
}

export interface VerifiedWriteResponse {
  bytesWritten: number
  sha256: string
}

export interface MaterializeAttachmentRequest {
  privateRoot: string
  attachmentId: string
  storedName: string
  content: string
}

export type DeleteMaterializedAttachmentRequest = Omit<MaterializeAttachmentRequest, 'content'>

export interface MkdirRequest {
  /** Absolute path to create (recursive), validated by the box server's
   *  allow-prefix guard. Passed as structured JSON — never through a shell. */
  path: string
}

export interface MkdirResponse {
  ok: boolean
}

export interface ListRequest {
  path: string
  recursive?: boolean
  maxDepth?: number
}

export interface FileInfo {
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
}

export interface ListResponse {
  files: FileInfo[]
}

export interface StatRequest {
  path: string
}

export interface StatResponse {
  exists: boolean
  isDirectory: boolean
  isReadable: boolean
  isWritable: boolean
  size: number
}

export interface ShellSpawn {
  cols: number
  rows: number
  cwd?: string
  useDevboxRc?: boolean
  /** Per-session env overrides (applied last, over the pod's baked env). Used to
   *  inject the live Core URL so the terminal's `tau` CLI survives a port change. */
  env?: Record<string, string>
}

export interface ShellMessage {
  spawn?: ShellSpawn
  data?: string // base64
  resize?: { cols: number; rows: number }
  kill?: boolean
}

export interface ShellOutput {
  data?: string // base64
  exitCode?: number
  error?: string
}

export interface HealthResponse {
  healthy: boolean
  devboxReady: boolean
  version: string
  uptimeSeconds: number
  /** Load and memory; absent from servers that predate it or off Linux. */
  pressure?: SandboxPressure
  runtimeContract?: {
    runtime: 'docker'
    version: 1
    executorProtocol: 1
    capabilities: Array<'bash' | 'bash-cancel' | 'command-identity' | 'socket-proxy'>
    commandIdentity: {
      user: string
      home: string
      uid: number
      gid: number
      source: 'host' | 'image'
      contractDigest: string
    }
  }
}

export interface BrowserOpenResult {
  title: string
  screenshotBase64: string
}

export interface BrowserActionResult {
  ok?: boolean
  deltaPx?: number
  screenshotBase64?: string
}

export interface BrowserScreenshotResult {
  screenshotBase64: string
}

export interface BrowserReadResult {
  text: string
}

export interface BrowserConsoleEntry {
  type: string
  text: string
}

export interface BrowserConsoleResult {
  entries: BrowserConsoleEntry[]
}

export class SandboxClientClosedError extends Error {
  readonly name = 'SandboxClientClosedError'
  readonly code = 'SANDBOX_CLIENT_CLOSED'

  constructor() {
    super('Sandbox client is closed')
  }
}

// ---------------------------------------------------------------------------
// Stream interfaces (compatible with existing consumer code)
// ---------------------------------------------------------------------------

export interface ClientReadableStream<T> extends EventEmitter {
  readonly invocationId: string
  on(event: 'data', listener: (data: T) => void): this
  on(event: 'end', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: string, listener: (...args: any[]) => void): this
  cancel(): void
  cancelAndWait(reason: 'tool-abort' | 'worker-stop' | 'transport-loss'): Promise<void>
}

export interface ClientDuplexStream<TWrite, TRead> extends EventEmitter {
  on(event: 'data', listener: (data: TRead) => void): this
  on(event: 'end', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: string, listener: (...args: any[]) => void): this
  write(message: TWrite): boolean
  end(): void
  cancel(): void
}

// ---------------------------------------------------------------------------
// SandboxClient
// ---------------------------------------------------------------------------

/** Unary budget for raw-body uploads: tens of MB over an SSH-tunneled hop can
 *  legitimately outlive the default 30s unary timeout. */
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000

export class SandboxClient {
  private readonly baseUrl: string
  /** Auth headers sent on every request; empty when no token is configured. */
  private readonly authHeaders: Record<string, string>
  private closed = false
  private abortControllers = new Set<AbortController>()
  private requestControllers = new Set<AbortController>()
  private shellClosers = new Set<() => void>()
  private readonly requestFetch: SandboxFetch
  private readonly cancelFetch: SandboxFetch
  private readonly cancelTimeoutMs: number
  private readonly healthTimeoutMs: number
  private readonly unaryTimeoutMs: number
  private readonly webSocketFactory: (url: string, headers: Record<string, string>) => WebSocket

  /**
   * @param endpoint bare `host:port` (the client prepends the scheme).
   * @param authToken the box's per-box executor token (VM runtime). Sent as
   *   `Authorization: Bearer <token>` on every HTTP request and on the /shell
   *   WS upgrade. Omitted for k8s pods (no enforcement there); an old server
   *   that does not enforce simply ignores the header.
   */
  constructor(
    endpoint: string,
    authToken?: string,
    options: {
      fetch?: SandboxFetch
      cancelTimeoutMs?: number
      healthTimeoutMs?: number
      unaryTimeoutMs?: number
      webSocketFactory?: (url: string, headers: Record<string, string>) => WebSocket
    } = {}
  ) {
    this.baseUrl = `http://${endpoint}`
    this.authHeaders = authToken ? { authorization: `Bearer ${authToken}` } : {}
    this.requestFetch = options.fetch ?? fetch
    this.cancelFetch = this.requestFetch
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? BASH_CANCEL_TIMEOUT_MS
    this.healthTimeoutMs = options.healthTimeoutMs ?? 3_000
    this.unaryTimeoutMs = options.unaryTimeoutMs ?? 30_000
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url, headers) =>
        Object.keys(headers).length ? new WebSocket(url, { headers } as unknown as string[]) : new WebSocket(url))
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Wait for the executor to be ready.
   */
  async waitForReady(timeoutMs: number): Promise<void> {
    this.assertOpen()
    const deadline = Date.now() + timeoutMs
    const interval = 200

    while (Date.now() < deadline) {
      try {
        const resp = await this.withUnary(
          '/healthz',
          { headers: this.authHeaders },
          async (response) => response,
          2_000
        )
        if (resp.ok) return
      } catch {
        if (this.closed) throw new SandboxClientClosedError()
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, interval))
    }

    throw new Error('Failed to connect before the deadline')
  }

  /** Prove that no process from a stable invocation remains on the server. */
  async cancelBashInvocation(
    invocationId: string,
    reason: 'tool-abort' | 'worker-stop' | 'transport-loss'
  ): Promise<void> {
    let response: Response
    try {
      response = await this.cancelFetch(`${this.baseUrl}/bash/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders },
        body: JSON.stringify({ invocationId, reason }),
        signal: AbortSignal.timeout(this.cancelTimeoutMs),
      })
    } catch (error) {
      throw new BashCleanupUnprovenError('Bash cancellation cleanup did not settle before its deadline', invocationId, {
        cause: error,
      })
    }
    if (!response.ok) {
      throw new BashCleanupUnprovenError(`Bash cancellation failed: ${await formatHttpError(response)}`, invocationId)
    }
    const proof = (await response.json()) as { remainingPids?: number[] }
    if (!Array.isArray(proof.remainingPids) || proof.remainingPids.length !== 0) {
      throw new BashCleanupUnprovenError('Bash cancellation cleanup was not proven', invocationId)
    }
  }

  /**
   * Execute a bash command with streaming output.
   */
  bash(request: BashRequest): ClientReadableStream<BashResponse> {
    this.assertOpen()
    const emitter = new EventEmitter() as ClientReadableStream<BashResponse>
    const ac = new AbortController()
    const invocationId = request.invocationId ?? randomUUID()
    Object.defineProperty(emitter, 'invocationId', { value: invocationId, enumerable: true })
    let cancellation: Promise<void> | undefined
    let cancellationRequested = false
    this.abortControllers.add(ac)

    const run = async () => {
      let terminalObserved = false
      try {
        const resp = await this.requestFetch(`${this.baseUrl}/bash`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.authHeaders },
          body: JSON.stringify({ ...withLegacyEnvOverrides(request), invocationId }),
          signal: ac.signal,
        })

        if (!resp.ok || !resp.body) {
          const text = await resp.text()
          emitter.emit('error', new Error(`Bash request failed: ${resp.status} ${text}`))
          return
        }

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6)) as BashResponse
              if (typeof data.exitCode === 'number') terminalObserved = true
              emitter.emit('data', data)
            }
          }
        }
        if (!terminalObserved) {
          emitter.emit('error', new BashOutcomeUnknownError(invocationId, 'protocol_truncated'))
        }
      } catch (error) {
        const abortedForCleanup = cancellationRequested && (error as { name?: string })?.name === 'AbortError'
        if (!abortedForCleanup) {
          const transport = classifySandboxTransportError(error, 'response')
          emitter.emit(
            'error',
            new BashOutcomeUnknownError(invocationId, transport?.kind ?? 'protocol_truncated', transport ?? error)
          )
        }
      } finally {
        this.abortControllers.delete(ac)
        // `end` remains a lifecycle notification, never proof of success.
        emitter.emit('end')
      }
    }

    run()

    emitter.cancelAndWait = (reason) => {
      cancellation ??= (async () => {
        cancellationRequested = true
        ac.abort()
        this.abortControllers.delete(ac)
        await this.cancelBashInvocation(invocationId, reason)
      })()
      return cancellation
    }

    emitter.cancel = () => {
      void emitter.cancelAndWait('transport-loss').catch(() => {})
    }

    return emitter
  }

  async read(request: ReadRequest): Promise<ReadResponse> {
    return this.post('/read', request)
  }

  async write(request: WriteRequest): Promise<WriteResponse> {
    return this.post('/write', request)
  }

  /**
   * Raw-body upload — the large-file transport. Sends the bytes as
   * application/octet-stream to `/upload` (params in the query string), so
   * nothing is base64-inflated (+33%) or materialized as a multi-megabyte
   * JSON string on either side. Same path policy + atomic publication as
   * `write()`. Throws SandboxHttpError 404 on a box bundle that predates the
   * endpoint — callers that must work mid-rollout fall back to `write()`.
   */
  async upload(request: {
    path: string
    content: Uint8Array
    createDirs?: boolean
    mode?: string
  }): Promise<WriteResponse> {
    const params = new URLSearchParams({ path: request.path })
    if (request.createDirs) params.set('createDirs', 'true')
    if (request.mode !== undefined) params.set('mode', request.mode)
    return this.withUnary(
      `/upload?${params.toString()}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...this.authHeaders },
        // The project's lib.dom BodyInit shadows Bun's (same clash as the
        // WebSocket constructor above); Bun's fetch accepts a Uint8Array body.
        body: request.content as unknown as BodyInit,
      },
      (resp) => this.consumeJsonResponse<WriteResponse>(resp),
      // Large payloads over an SSH-tunneled hop can legitimately outlive the
      // default 30s unary budget.
      UPLOAD_TIMEOUT_MS
    )
  }

  async writeVerified(request: VerifiedWriteRequest): Promise<VerifiedWriteResponse> {
    const uncertainResponse = () =>
      new Error(
        'Verified write response identity mismatch; candidate may have been published; success was not reported'
      )

    let response: VerifiedWriteResponse
    try {
      response = await this.post<VerifiedWriteResponse>('/write-verified', request)
    } catch (error) {
      if (error instanceof SandboxHttpError && error.status === 404) {
        throw new SandboxHttpError(
          "Sandbox executor is outdated. Restart this agent's sandbox from the agent page, or recreate the squad sandbox, then retry; the verified edit was not attempted",
          404,
          error.code,
          error.phase
        )
      }
      if (error instanceof SyntaxError) throw uncertainResponse()
      throw error
    }

    if (
      response === null ||
      typeof response !== 'object' ||
      response.bytesWritten !== request.expectedResult.bytes ||
      response.sha256 !== request.expectedResult.sha256
    ) {
      throw uncertainResponse()
    }
    return response
  }

  async materializeAttachment(request: MaterializeAttachmentRequest): Promise<WriteResponse> {
    return this.post<WriteResponse>('/materialize-attachment', request)
  }

  async deleteMaterializedAttachment(request: DeleteMaterializedAttachmentRequest): Promise<void> {
    await this.post('/delete-materialized-attachment', request)
  }

  async mkdir(request: MkdirRequest): Promise<MkdirResponse> {
    return this.post('/mkdir', request)
  }

  async list(request: ListRequest): Promise<ListResponse> {
    return this.post('/list', request)
  }

  async stat(request: StatRequest): Promise<StatResponse> {
    return this.post('/stat', request)
  }

  /**
   * Start an interactive PTY shell session via WebSocket.
   */
  shell(): ClientDuplexStream<ShellMessage, ShellOutput> {
    this.assertOpen()
    const emitter = new EventEmitter() as ClientDuplexStream<ShellMessage, ShellOutput>
    const wsUrl = `${this.baseUrl.replace('http://', 'ws://')}/shell`

    // Bun's WebSocket client supports custom upgrade headers ({ headers } as
    // the second arg — a Bun extension; see Bun.WebSocketOptions). The server's
    // auth gate checks them before server.upgrade. The cast is needed because
    // this project's lib.dom types shadow Bun's constructor overload, which
    // only admits the standard `protocols` shape.
    const ws = this.webSocketFactory(wsUrl, this.authHeaders)
    let isOpen = false
    let closing = false
    let endEmitted = false
    const pendingMessages: ShellMessage[] = []
    const closeShell = () => {
      if (closing) return
      closing = true
      isOpen = false
      pendingMessages.length = 0
      ws.close()
    }
    this.shellClosers.add(closeShell)

    ws.onopen = () => {
      if (closing) return
      isOpen = true
      // Flush any messages that were queued before the connection opened
      for (const msg of pendingMessages) {
        ws.send(JSON.stringify(msg))
      }
      pendingMessages.length = 0
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()) as ShellOutput
        emitter.emit('data', data)
      } catch (err: any) {
        emitter.emit('error', new Error(`Failed to parse shell output: ${err.message}`))
      }
    }

    ws.onclose = () => {
      closing = true
      isOpen = false
      pendingMessages.length = 0
      this.shellClosers.delete(closeShell)
      if (!endEmitted) {
        endEmitted = true
        emitter.emit('end')
      }
    }

    ws.onerror = (_event) => {
      emitter.emit('error', new Error('WebSocket error'))
    }

    emitter.write = (rawMessage: ShellMessage): boolean => {
      if (closing) return false
      const message = rawMessage.spawn ? { ...rawMessage, spawn: withLegacyEnvOverrides(rawMessage.spawn) } : rawMessage
      if (isOpen) {
        ws.send(JSON.stringify(message))
      } else {
        pendingMessages.push(message)
      }
      return true
    }

    emitter.end = closeShell
    emitter.cancel = closeShell

    return emitter
  }

  /**
   * Signal that devbox is realized so the server caches its shellenv (the same
   * work the k8s entrypoint triggers by POSTing this after `devbox install`).
   * On a vm box nothing else posts it, so the manager calls this right after
   * seeding — otherwise the seeded comfort tools reach only `devbox run --`, not
   * a plain `/bash` PATH, until the next unit restart. Throws on a non-2xx.
   */
  async devboxReady(): Promise<void> {
    await this.withUnary('/devbox-ready', { method: 'POST', headers: this.authHeaders }, async (resp) => {
      if (!resp.ok) throw new Error(`Failed to signal /devbox-ready: ${await formatHttpError(resp)}`)
    })
  }

  /**
   * Refresh or clear the server's managed toolchain activation cache. With a
   * fingerprint, a server already activated for it answers from its cache.
   * Throws {@link SandboxHttpError} on a non-2xx (504 when activation timed out).
   */
  async toolchainReady(active = true, fingerprint?: string): Promise<void> {
    await this.withUnary(
      '/toolchain-ready',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders },
        body: JSON.stringify(fingerprint ? { active, fingerprint } : { active }),
      },
      async (resp) => {
        if (!resp.ok) await this.consumeJsonResponse(resp)
      }
    )
  }

  /** What the box is running: load, the box user's processes by current CPU, and its containers. */
  async listProcesses(): Promise<SandboxProcesses> {
    return this.post<SandboxProcesses>('/processes', {})
  }

  /** Signal one process the box user owns; the server refuses anything else (403). */
  async signalProcess(
    pid: number,
    signal: SandboxProcessSignal
  ): Promise<{ pid: number; signal: SandboxProcessSignal; command: string }> {
    return this.post('/processes/signal', { pid, signal })
  }

  /** Stop one of the box's containers by id or name. */
  async stopContainer(id: string): Promise<{ id: string }> {
    return this.post('/containers/stop', { id })
  }

  async health(): Promise<HealthResponse> {
    return this.withUnary(
      '/healthz',
      { headers: this.authHeaders },
      async (resp) => {
        if (!resp.ok) throw new Error(`Health check failed: ${resp.status}`)
        return resp.json()
      },
      this.healthTimeoutMs
    )
  }

  async getWatchStatus(): Promise<{
    active: boolean
    config: { include: string[]; exclude: string[]; squadId: string } | null
  }> {
    return this.withUnary('/watch', { method: 'GET', headers: this.authHeaders }, async (resp) => {
      if (!resp.ok) throw new Error(`Failed to get watch status: ${await formatHttpError(resp)}`)
      return resp.json()
    })
  }

  async startWatch(config: {
    include: string[]
    exclude: string[]
    squadId: string
  }): Promise<{ ok: boolean; fileCount?: number }> {
    return this.withUnary(
      '/watch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders },
        body: JSON.stringify(config),
      },
      async (resp) => {
        if (!resp.ok) throw new Error(`Failed to start watch: ${await formatHttpError(resp)}`)
        return resp.json()
      }
    )
  }

  async stopWatch(): Promise<void> {
    await this.withUnary('/watch', { method: 'DELETE', headers: this.authHeaders }, async (resp) => {
      if (!resp.ok) throw new Error(`Failed to stop watch: ${await formatHttpError(resp)}`)
    })
  }

  async rescanWatch(): Promise<{ ok: boolean; fileCount?: number }> {
    return this.withUnary('/watch/rescan', { method: 'POST', headers: this.authHeaders }, async (resp) => {
      if (!resp.ok) throw new Error(`Failed to rescan: ${await formatHttpError(resp)}`)
      return resp.json()
    })
  }

  async browserOpen(runId: string, url: string): Promise<BrowserOpenResult> {
    return this.post('/browser/open', { runId, url })
  }

  async browserClick(
    runId: string,
    opts: { selector?: string; x?: number; y?: number; returnScreenshot?: boolean }
  ): Promise<BrowserActionResult> {
    return this.post('/browser/click', { runId, ...opts })
  }

  async browserType(
    runId: string,
    opts: { text: string; selector?: string; returnScreenshot?: boolean }
  ): Promise<BrowserActionResult> {
    return this.post('/browser/type', { runId, ...opts })
  }

  async browserScroll(
    runId: string,
    opts: { direction: 'up' | 'down'; amount?: number; returnScreenshot?: boolean }
  ): Promise<BrowserActionResult> {
    return this.post('/browser/scroll', { runId, ...opts })
  }

  async browserScreenshot(runId: string): Promise<BrowserScreenshotResult> {
    return this.post('/browser/screenshot', { runId })
  }

  async browserRead(runId: string, selector?: string): Promise<BrowserReadResult> {
    return this.post('/browser/read', { runId, ...(selector ? { selector } : {}) })
  }

  async browserConsole(runId: string): Promise<BrowserConsoleResult> {
    return this.post('/browser/console', { runId })
  }

  async browserClose(runId: string): Promise<{ ok: boolean }> {
    return this.post('/browser/close', { runId })
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      for (const ac of this.abortControllers) ac.abort()
      for (const ac of this.requestControllers) ac.abort()
      for (const closeShell of this.shellClosers) closeShell()
      this.abortControllers.clear()
      this.requestControllers.clear()
      this.shellClosers.clear()
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new SandboxClientClosedError()
  }

  private async withUnary<T>(
    path: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    timeoutMs = this.unaryTimeoutMs
  ): Promise<T> {
    this.assertOpen()
    const controller = new AbortController()
    this.requestControllers.add(controller)
    try {
      const signals = [controller.signal, AbortSignal.timeout(timeoutMs)]
      if (init.signal) signals.push(init.signal)
      const response = await this.requestFetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.any(signals),
      })
      const result = await consume(response)
      if (this.closed) throw new SandboxClientClosedError()
      return result
    } catch (error) {
      if (this.closed) throw new SandboxClientClosedError()
      throw classifySandboxTransportError(error, 'connect') ?? error
    } finally {
      this.requestControllers.delete(controller)
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.withUnary(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders },
        body: JSON.stringify(body),
      },
      (resp) => this.consumeJsonResponse<T>(resp)
    )
  }

  private async consumeJsonResponse<T>(resp: Response): Promise<T> {
    if (!resp.ok) {
      // The error body is usually `{ error }` JSON, but not always — an old
      // server bundle answers an unknown route with plain-text `Not found`
      // (404). Guard the parse so a non-JSON body surfaces as the status-coded
      // error instead of a confusing SyntaxError.
      let message = `Request failed: ${resp.status}`
      let code: string | undefined
      let phase: string | undefined
      let errno: string | undefined
      let filesystemClass: string | undefined
      try {
        const json = (await resp.json()) as {
          error?: unknown
          code?: unknown
          phase?: unknown
          errno?: unknown
          filesystemClass?: unknown
        }
        if (typeof json?.error === 'string' && json.error) {
          message = boundUtf8(sanitizeHttpErrorBody(json.error))
        }
        if (typeof json?.code === 'string') code = boundUtf8(sanitizeHttpErrorBody(json.code), 128)
        if (typeof json?.phase === 'string') phase = boundUtf8(sanitizeHttpErrorBody(json.phase), 128)
        if (['EACCES', 'EROFS', 'ENOSPC'].includes(String(json?.errno))) errno = String(json.errno)
        if (['permission-denied', 'read-only-filesystem', 'no-space'].includes(String(json?.filesystemClass))) {
          filesystemClass = String(json.filesystemClass)
        }
      } catch {
        // Non-JSON error body — keep the status-based message.
      }
      throw new SandboxHttpError(message, resp.status, code, phase, errno, filesystemClass)
    }

    return (await resp.json()) as T
  }
}
