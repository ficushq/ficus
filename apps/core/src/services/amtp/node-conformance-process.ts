import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { terminateProcess } from './subprocess-lifecycle'

const MAX_DIAGNOSTIC_BYTES = 16_384
const DIAGNOSTIC_TIMEOUT_MS = 250

export type AmtpUploadPhase =
  | 'process:start'
  | 'sqlite-open:start'
  | 'sqlite-open:done'
  | 'source-read:start'
  | 'source-read:done'
  | 'digest:done'
  | 'blob-file-fsync:start'
  | 'blob-file-fsync:done'
  | 'blob-rename:done'
  | 'blob-dir-fsync:start'
  | 'blob-dir-fsync:done'
  | 'attachment-row-insert:start'
  | 'attachment-row-insert:done'
  | 'response-write:start'
  | 'response-write:done'
  | 'sqlite-close:start'
  | 'sqlite-close:done'

const AMTP_UPLOAD_PHASES = new Set<AmtpUploadPhase>([
  'process:start',
  'sqlite-open:start',
  'sqlite-open:done',
  'source-read:start',
  'source-read:done',
  'digest:done',
  'blob-file-fsync:start',
  'blob-file-fsync:done',
  'blob-rename:done',
  'blob-dir-fsync:start',
  'blob-dir-fsync:done',
  'attachment-row-insert:start',
  'attachment-row-insert:done',
  'response-write:start',
  'response-write:done',
  'sqlite-close:start',
  'sqlite-close:done',
])

const COMMON_PROCESS_PHASES = [
  'process:start',
  'sqlite-open:start',
  'sqlite-open:done',
  'response-write:start',
  'response-write:done',
  'sqlite-close:start',
  'sqlite-close:done',
] as const

const CONFORMANCE_PHASES_BY_OPERATION: Readonly<Record<string, ReadonlySet<string>>> = {
  upload: AMTP_UPLOAD_PHASES,
  'card-set': new Set([
    ...COMMON_PROCESS_PHASES,
    'card-validate:done',
    'card-sign:done',
    'registration-update:start',
    'registration-update:done',
  ]),
  'card-fetch': new Set([...COMMON_PROCESS_PHASES, 'request:start', 'result:verified', 'result:absent-or-rejected']),
  'serve-start': new Set([
    'process:start',
    'sqlite-open:start',
    'sqlite-open:done',
    'identity-read:done',
    'engine-built:done',
    'bind:start',
    'bind:done',
    'listening-write:start',
    'listening-write:done',
  ]),
  register: new Set([
    ...COMMON_PROCESS_PHASES,
    'identity-read:done',
    'registration-read:done',
    'key-generate:start',
    'key-generate:done',
    'registration-write:start',
    'registration-write:done',
  ]),
  entrypoint: new Set(['module-loaded']),
  whoami: new Set([
    ...COMMON_PROCESS_PHASES,
    'identity-read:start',
    'identity-read:done',
    'registrations-read:start',
    'registrations-read:done',
  ]),
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PHASE_RECORD_KEYS = ['kind', 'operation', 'operationId', 'phase']

function parseAmtpConformancePhase(
  line: string,
  operationId: string
): { operation: string; phase: string } | undefined {
  if (!UUID_PATTERN.test(operationId)) return undefined
  try {
    const record = JSON.parse(line) as Record<string, unknown>
    if (
      typeof record !== 'object' ||
      record === null ||
      Object.keys(record).sort().join(',') !== PHASE_RECORD_KEYS.join(',') ||
      record.kind !== 'amtp-conformance-phase' ||
      record.operationId !== operationId ||
      typeof record.operation !== 'string' ||
      typeof record.phase !== 'string' ||
      !CONFORMANCE_PHASES_BY_OPERATION[record.operation]?.has(record.phase)
    )
      return undefined
    return { operation: record.operation, phase: record.phase }
  } catch {
    return undefined
  }
}

export function amtpConformancePhases(
  stderr: string,
  operationId: string
): Array<{ operation: string; phase: string }> {
  return stderr
    .split('\n')
    .map((line) => parseAmtpConformancePhase(line, operationId))
    .filter((record): record is { operation: string; phase: string } => record !== undefined)
}

export function stripAmtpConformancePhases(stderr: string, operationId: string): string {
  return stderr
    .match(/.*(?:\n|$)/g)!
    .filter((line) => {
      const content = line.endsWith('\n') ? line.slice(0, -1) : line
      return !parseAmtpConformancePhase(content, operationId)
    })
    .join('')
}

export function lastAmtpUploadPhase(stderr: string): AmtpUploadPhase | undefined {
  let lastPhase: AmtpUploadPhase | undefined
  for (const line of stderr.split('\n')) {
    try {
      const record: unknown = JSON.parse(line)
      if (
        typeof record === 'object' &&
        record !== null &&
        (record as { kind?: unknown }).kind === 'amtp-upload-phase' &&
        typeof (record as { phase?: unknown }).phase === 'string' &&
        AMTP_UPLOAD_PHASES.has((record as { phase: string }).phase as AmtpUploadPhase)
      ) {
        lastPhase = (record as { phase: AmtpUploadPhase }).phase
      }
    } catch {
      // Arbitrary diagnostics never become a structured phase value.
    }
  }
  return lastPhase
}

export interface FileCapturedProcessResult {
  readonly command?: readonly string[]
  readonly capturePaths?: readonly [string, string]
  pid: number
  exitCode: number
  signalCode: string | null
  stdout: string
  stderr: string
}

export interface BuiltAmtpConformanceEntrypoint {
  readonly sourcePath: string
  readonly path: string
  readonly sha256: string
  readonly exitCode: number
  readonly signalCode: string | null
}

export async function buildAmtpConformanceEntrypoint(options: {
  sourcePath: string
  artifactDir: string
  captureDir: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<BuiltAmtpConformanceEntrypoint> {
  if ((await readdir(options.artifactDir)).length !== 0) throw new Error('amtp-cli-build:artifact-directory-not-empty')
  const path = join(options.artifactDir, 'amtp-node-conformance.mjs')
  const result = await runFileCapturedProcess(
    [process.execPath, 'build', options.sourcePath, '--target=bun', '--outfile', path],
    {
      phase: 'amtp-cli-build',
      timeoutMs: options.timeoutMs,
      captureDir: options.captureDir,
      signal: options.signal,
    }
  )
  if (result.exitCode !== 0 || result.signalCode !== null) throw new Error('amtp-cli-build:child-exit')
  const artifacts = await readdir(options.artifactDir)
  if (artifacts.length !== 1 || artifacts[0] !== 'amtp-node-conformance.mjs')
    throw new Error('amtp-cli-build:unexpected-artifacts')
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size === 0) throw new Error('amtp-cli-build:invalid-artifact')
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
  return Object.freeze({
    sourcePath: options.sourcePath,
    path,
    sha256,
    exitCode: result.exitCode,
    signalCode: result.signalCode,
  })
}

export interface FileCapturedChild {
  proc: Bun.Subprocess
  stdoutPath: string
  stderrPath: string
}

interface FileCapturedProcessOptions {
  phase: string
  timeoutMs: number
  captureDir: string
  entrypointReady?: (stdout: string, stderr: string) => boolean
  terminalOutput?: (stdout: string, stderr: string) => boolean
  diagnostics?: (captures: { stdout: string; stderr: string }) => string | Promise<string>
  signal?: AbortSignal
  env?: Record<string, string | undefined>
}

export class CleanupPhaseTimeoutError extends Error {
  readonly code = 'CLEANUP_PHASE_TIMEOUT'

  constructor(
    readonly phase: string,
    timeoutMs: number
  ) {
    super(`Cleanup phase ${phase} timed out after ${timeoutMs}ms`)
    this.name = 'CleanupPhaseTimeoutError'
  }
}

export async function runBoundedCleanupPhases(
  phases: Array<{ phase: string; operation: (signal: AbortSignal) => void | Promise<unknown> }>,
  timeoutMs: number,
  joinGraceMs = Math.min(timeoutMs, 250)
): Promise<void> {
  const errors: Error[] = []
  for (const { phase, operation } of phases) {
    let timer: Timer | undefined
    const controller = new AbortController()
    const timeout = Symbol('cleanup-timeout')
    try {
      const operationPromise = Promise.resolve().then(() => operation(controller.signal))
      const outcome = await Promise.race([
        operationPromise,
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), timeoutMs)
        }),
      ])
      if (outcome === timeout) {
        controller.abort(`cleanup phase ${phase} timed out`)
        let joinTimer: Timer | undefined
        try {
          await Promise.race([
            operationPromise.catch(() => {}),
            new Promise<void>((resolve) => {
              joinTimer = setTimeout(resolve, joinGraceMs)
            }),
          ])
        } finally {
          if (joinTimer) clearTimeout(joinTimer)
        }
        errors.push(new CleanupPhaseTimeoutError(phase, timeoutMs))
      }
    } catch (error) {
      errors.push(new Error(`Cleanup phase ${phase} failed`, { cause: error }))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'AMTP conformance cleanup was incomplete')
}

export class SubprocessPhaseTimeoutError extends Error {
  readonly code = 'SUBPROCESS_PHASE_TIMEOUT'
  declare readonly capturePaths?: readonly [string, string]
  declare readonly terminal?: { exitCode: number | null; signalCode: string | null }

  constructor(
    readonly phase: string,
    readonly command: string[],
    readonly pid: number,
    stdout: string,
    stderr: string,
    cleanupError?: unknown,
    diagnostics?: string
  ) {
    super(
      `Subprocess phase ${phase} timed out: command=${JSON.stringify(command)} pid=${pid}; ` +
        `stdout tail=${tailUtf8(stdout)}; stderr tail=${tailUtf8(stderr)}` +
        (diagnostics ? `; diagnostics=${tailUtf8(diagnostics)}` : '') +
        (cleanupError
          ? `; cleanup=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          : ''),
      cleanupError ? { cause: cleanupError } : undefined
    )
    this.name = 'SubprocessPhaseTimeoutError'
  }
}

function attachProcessOwnership(
  error: SubprocessPhaseTimeoutError | SubprocessPhaseCancelledError,
  child: FileCapturedChild
): void {
  Object.defineProperties(error, {
    capturePaths: { value: Object.freeze([child.stdoutPath, child.stderrPath]) },
    terminal: {
      value: Object.freeze({ exitCode: child.proc.exitCode, signalCode: child.proc.signalCode }),
    },
  })
}

function tailUtf8(value: string, maxBytes = MAX_DIAGNOSTIC_BYTES): string {
  const bytes = Buffer.from(value)
  return bytes.subarray(Math.max(0, bytes.byteLength - maxBytes)).toString('utf8')
}

async function readCapture(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '')
}

export function spawnFileCapturedChild(
  command: string[],
  captureDir: string,
  env?: Record<string, string | undefined>
): FileCapturedChild {
  const captureId = randomUUID()
  const stdoutPath = join(captureDir, `${captureId}.stdout`)
  const stderrPath = join(captureDir, `${captureId}.stderr`)
  const proc = Bun.spawn(command, {
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
    env: env ? { ...process.env, ...env } : undefined,
  })
  return { proc, stdoutPath, stderrPath }
}

export async function cleanupFileCapturedChild(child: FileCapturedChild): Promise<void> {
  await Promise.all([rm(child.stdoutPath, { force: true }), rm(child.stderrPath, { force: true })])
}

export async function readFileCapturedChild(child: FileCapturedChild): Promise<{ stdout: string; stderr: string }> {
  const [stdout, stderr] = await Promise.all([readCapture(child.stdoutPath), readCapture(child.stderrPath)])
  return { stdout, stderr }
}

async function readCaptureTail(path: string, maxBytes: number): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, 'r')
    const { size } = await file.stat()
    const length = Math.min(size, maxBytes)
    const bytes = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await file.read(bytes, offset, length - offset, Math.max(0, size - length) + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return tailUtf8(bytes.subarray(0, offset).toString('utf8'), maxBytes)
  } catch {
    return ''
  } finally {
    await file?.close().catch(() => {})
  }
}

export async function readFileCapturedChildTails(
  child: FileCapturedChild,
  maxBytes = MAX_DIAGNOSTIC_BYTES
): Promise<{ stdout: string; stderr: string }> {
  const [stdout, stderr] = await Promise.all([
    readCaptureTail(child.stdoutPath, maxBytes),
    readCaptureTail(child.stderrPath, maxBytes),
  ])
  return { stdout, stderr }
}

export class SubprocessPhaseCancelledError extends Error {
  readonly code = 'SUBPROCESS_PHASE_CANCELLED'
  declare readonly capturePaths?: readonly [string, string]
  declare readonly terminal?: { exitCode: number | null; signalCode: string | null }

  constructor(
    readonly phase: string,
    readonly command: string[],
    readonly pid: number,
    cleanupError?: unknown
  ) {
    super(
      `Subprocess phase ${phase} cancelled: command=${JSON.stringify(command)} pid=${pid}` +
        (cleanupError
          ? `; cleanup=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          : ''),
      cleanupError ? { cause: cleanupError } : undefined
    )
    this.name = 'SubprocessPhaseCancelledError'
  }
}

export class SubprocessPhaseError extends Error {
  readonly code = 'SUBPROCESS_PHASE_FAILED'

  constructor(
    readonly phase: string,
    message: string
  ) {
    super(`${phase}: ${message}`)
    this.name = 'SubprocessPhaseError'
  }
}

export async function waitForCapturedJsonLine<T>(
  child: FileCapturedChild,
  options: {
    phase: string
    timeoutMs: number
    match: (value: unknown) => boolean
    signal?: AbortSignal
    readCaptures?: typeof readFileCapturedChild
  }
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new SubprocessPhaseCancelledError(options.phase, [], child.proc.pid)
    }
    // Capture exit BEFORE reading. If the child writes its final record and
    // exits during this async read, this snapshot may still contain only the
    // prefix. Only a read started after observing exit proves no record exists.
    const exitedBeforeRead = child.proc.exitCode !== null || child.proc.signalCode !== null
    const { stdout, stderr } = await (options.readCaptures ?? readFileCapturedChild)(child)
    for (const line of stdout.split('\n').slice(0, -1)) {
      try {
        const value: unknown = JSON.parse(line)
        if (options.match(value)) return value as T
      } catch {
        // Non-JSON diagnostic lines cannot satisfy the explicit record barrier.
      }
    }
    if (exitedBeforeRead) {
      throw new SubprocessPhaseError(
        options.phase,
        `child exited before matching record (pid=${child.proc.pid}, exit=${String(child.proc.exitCode)}, ` +
          `signal=${String(child.proc.signalCode)}, stdout tail=${tailUtf8(stdout)}, stderr tail=${tailUtf8(stderr)})`
      )
    }
    const waitMs = Math.min(20, Math.max(1, deadline - Date.now()))
    if (options.signal) {
      await new Promise<void>((resolve) => {
        const signal = options.signal!
        const timer = setTimeout(finish, waitMs)
        function finish() {
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          resolve()
        }
        signal.addEventListener('abort', finish, { once: true })
      })
    } else {
      await Bun.sleep(waitMs)
    }
  }
  const { stdout, stderr } = await readFileCapturedChild(child)
  throw new SubprocessPhaseError(
    options.phase,
    `timed out after ${options.timeoutMs}ms (pid=${child.proc.pid}, exit=${String(child.proc.exitCode)}, ` +
      `signal=${String(child.proc.signalCode)}, stdout tail=${tailUtf8(stdout)}, stderr tail=${tailUtf8(stderr)})`
  )
}

/** Runs a subprocess whose output is captured without pipe-backed readers. */
export async function runFileCapturedProcess(
  command: string[],
  options: FileCapturedProcessOptions
): Promise<FileCapturedProcessResult> {
  let child: FileCapturedChild | undefined
  const deadline = Date.now() + options.timeoutMs
  try {
    if (options.signal?.aborted) {
      throw new SubprocessPhaseCancelledError(options.phase, command, 0)
    }
    child = spawnFileCapturedChild(command, options.captureDir, options.env)
    const { proc, stdoutPath, stderrPath } = child
    let entrypointReadySeen = options.entrypointReady === undefined
    let terminalOutputSeen = options.terminalOutput === undefined

    while (proc.exitCode === null && proc.signalCode === null) {
      if (options.signal?.aborted) {
        let cleanupError: unknown
        try {
          await terminateProcess(proc)
        } catch (error) {
          cleanupError = error
        }
        const error = new SubprocessPhaseCancelledError(options.phase, command, proc.pid, cleanupError)
        attachProcessOwnership(error, child)
        throw error
      }

      if ((!entrypointReadySeen && options.entrypointReady) || (!terminalOutputSeen && options.terminalOutput)) {
        const [stdout, stderr] = await Promise.all([readCapture(stdoutPath), readCapture(stderrPath)])
        if (!entrypointReadySeen && options.entrypointReady) {
          try {
            entrypointReadySeen = options.entrypointReady(stdout, stderr)
          } catch {
            entrypointReadySeen = false
          }
        }
        if (!terminalOutputSeen && options.terminalOutput) {
          try {
            terminalOutputSeen = options.terminalOutput(stdout, stderr)
          } catch {
            terminalOutputSeen = false
          }
        }
      }

      if (Date.now() >= deadline) {
        // The child may have exited while its captures were being inspected.
        // Recheck before classifying the absolute deadline as a timeout.
        if (proc.exitCode !== null || proc.signalCode !== null) break
        const timeoutPhase = options.entrypointReady
          ? `${options.phase}:${!entrypointReadySeen ? 'child-entrypoint' : !terminalOutputSeen ? 'terminal-output' : 'process-exit'}`
          : options.terminalOutput
            ? `${options.phase}:${terminalOutputSeen ? 'process-exit' : 'terminal-output'}`
            : options.phase
        let cleanupError: unknown
        try {
          await terminateProcess(proc)
        } catch (error) {
          cleanupError = error
        }
        const [stdout, stderr] = await Promise.all([readCapture(stdoutPath), readCapture(stderrPath)])
        let diagnostics: string | undefined
        if (options.diagnostics) {
          let diagnosticTimer: Timer | undefined
          const diagnosticTimeout = Symbol('diagnostic-timeout')
          try {
            const outcome = await Promise.race([
              Promise.resolve().then(() => options.diagnostics!({ stdout, stderr })),
              new Promise<typeof diagnosticTimeout>((resolve) => {
                diagnosticTimer = setTimeout(() => resolve(diagnosticTimeout), DIAGNOSTIC_TIMEOUT_MS)
              }),
            ])
            diagnostics = outcome === diagnosticTimeout ? 'diagnostic timed out' : outcome
          } catch {
            diagnostics = 'diagnostic failed'
          } finally {
            if (diagnosticTimer) clearTimeout(diagnosticTimer)
          }
        }
        const error = new SubprocessPhaseTimeoutError(
          timeoutPhase,
          command,
          proc.pid,
          stdout,
          stderr,
          cleanupError,
          diagnostics
        )
        attachProcessOwnership(error, child)
        throw error
      }

      const waitMs = Math.min(20, Math.max(1, deadline - Date.now()))
      if (options.signal) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, waitMs)
          const signal = options.signal!
          function finish() {
            clearTimeout(timer)
            signal.removeEventListener('abort', finish)
            resolve()
          }
          signal.addEventListener('abort', finish, { once: true })
        })
      } else {
        await Bun.sleep(waitMs)
      }
    }

    const outcome = await proc.exited
    const [stdout, stderr] = await Promise.all([readCapture(stdoutPath), readCapture(stderrPath)])
    if (options.entrypointReady && !entrypointReadySeen) {
      try {
        entrypointReadySeen = options.entrypointReady(stdout, stderr)
      } catch {
        entrypointReadySeen = false
      }
      if (!entrypointReadySeen) {
        throw new SubprocessPhaseError(
          `${options.phase}:child-entrypoint`,
          `child exited before entrypoint readiness (pid=${proc.pid}, exit=${String(outcome)}, ` +
            `signal=${String(proc.signalCode)}, stdout tail=${tailUtf8(stdout)}, stderr tail=${tailUtf8(stderr)})`
        )
      }
    }
    if (options.terminalOutput && !terminalOutputSeen) {
      try {
        terminalOutputSeen = options.terminalOutput(stdout, stderr)
      } catch {
        terminalOutputSeen = false
      }
      if (!terminalOutputSeen) {
        throw new SubprocessPhaseError(
          `${options.phase}:terminal-output`,
          `child exited before terminal output (pid=${proc.pid}, exit=${String(outcome)}, ` +
            `signal=${String(proc.signalCode)}, stdout tail=${tailUtf8(stdout)}, stderr tail=${tailUtf8(stderr)})`
        )
      }
    }
    return {
      command: Object.freeze([...command]),
      capturePaths: Object.freeze([stdoutPath, stderrPath]),
      pid: proc.pid,
      exitCode: outcome,
      signalCode: proc.signalCode === null ? null : String(proc.signalCode),
      stdout,
      stderr,
    }
  } finally {
    if (child) await cleanupFileCapturedChild(child)
  }
}
