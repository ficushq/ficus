import type { ScenarioOperation, ScenarioScope } from './node-conformance-scenario'

interface ScopedCliProcessOptions<T> {
  scope?: ScenarioScope
  operation?: ScenarioOperation
  signal?: AbortSignal
  run(signal?: AbortSignal): Promise<T>
}

const MAX_RAW_CAPTURE_CHARS = 8_192

function rawCapture(label: string, value: string): string {
  const bytes = Buffer.byteLength(value)
  const shown = value.length > MAX_RAW_CAPTURE_CHARS ? value.slice(-MAX_RAW_CAPTURE_CHARS) : value
  const size = shown === value ? `${bytes} bytes` : `${bytes} bytes, last ${MAX_RAW_CAPTURE_CHARS} shown`
  return `${label} (${size})=${JSON.stringify(shown)}`
}

/**
 * Parses one `amtp --json` result. A parse failure names the command and shows
 * the raw captures JSON-quoted, so trailing bytes or a second document are
 * visible in CI logs (Bun drops the helper frame from async stack traces).
 */
export function parseAmtpCliJson<T = unknown>(
  args: readonly string[],
  result: { stdout: string; stderr: string; exitCode: number | null }
): T {
  try {
    return JSON.parse(result.stdout) as T
  } catch (error) {
    throw new Error(
      `amtp ${args.join(' ')} printed stdout that is not one JSON document (exit ${String(result.exitCode)}): ` +
        `${error instanceof Error ? error.message : String(error)}; ` +
        `${rawCapture('raw stdout', result.stdout)}; ${rawCapture('stderr', result.stderr)}`,
      { cause: error }
    )
  }
}

/** Propagates scenario cancellation and keeps the operation owned until the child settles. */
export function runScopedCliProcess<T>({ scope, operation, signal, run }: ScopedCliProcessOptions<T>): Promise<T> {
  const scopeSignal = scope?.signal
  const effectiveSignal = signal && scopeSignal ? AbortSignal.any([signal, scopeSignal]) : (signal ?? scopeSignal)
  const process = run(effectiveSignal)
  return scope && operation ? scope.track(operation, process) : process
}
