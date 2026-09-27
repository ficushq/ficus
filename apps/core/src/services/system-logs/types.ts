/**
 * System Log Provider Abstraction
 *
 * Provides read-only streaming of Ficus's own system logs (API/core and worker
 * instances). Different runtimes (Kubernetes, PM2, bare-metal) implement the
 * same SystemLogProvider interface.
 *
 * Security: clients can ONLY request logical components ('api', 'worker',
 * 'all'). All concrete target resolution (pod names, process names, file paths,
 * namespaces, label selectors) is server-side only, driven by env config.
 */

/** Logical components a client may request — the ONLY values accepted from clients. */
export type SystemLogComponent = 'api' | 'worker'

export interface SystemLogStreamOptions {
  /** Number of recent lines to retrieve before following (if follow=true). Clamped [1, 5000]. */
  tailLines: number
  /** If true, keep streaming new lines after the initial tail. If false, stream ends after the tail. */
  follow: boolean
}

export interface SystemLogStreamResult {
  /** Cancel the active stream, killing any spawned processes or aborting requests. */
  cancel: () => void
}

export type SystemLogProviderId = 'k8s' | 'pm2' | 'systemd' | 'docker' | 'file' | 'unavailable'

export type SystemLogErrorCode =
  | 'CONFIG_INVALID'
  | 'PROVIDER_UNAVAILABLE'
  | 'TARGET_NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'STREAM_FAILED'

/** A stable, client-safe error from a system log provider. */
export class SystemLogProviderError extends Error {
  constructor(
    readonly code: SystemLogErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'SystemLogProviderError'
  }
}

/** Safe target metadata; concrete names, paths, and selectors are intentionally omitted. */
export interface SystemLogProviderDescriptor {
  provider: SystemLogProviderId
  targets: Array<{
    component: SystemLogComponent
    kind: 'pod' | 'process' | 'unit' | 'container' | 'file'
  }>
}

/**
 * A provider streams log lines for logical Ficus components.
 * Each provider maps logical component names to concrete targets using
 * server-side configuration only.
 */
export interface SystemLogProvider {
  /** Human-readable provider name for info messages (e.g. "kubernetes", "pm2", "file"). */
  readonly name: string

  /** Safe provider and target-kind metadata for authorized clients. */
  describe?: (components: SystemLogComponent[]) => SystemLogProviderDescriptor

  /**
   * Stream log lines for the given component(s).
   *
   * For a single component, lines are sent as-is.
   * For multiple components, each line is prefixed with `[api] ` or `[worker] `.
   *
   * @param components - Which logical components to stream (1 or 2 entries)
   * @param opts - Stream options (tailLines, follow)
   * @param onData - Called with each log chunk (Buffer)
   * @param onError - Called on fatal stream errors
   * @param onEnd - Called when all finite streams complete (primarily follow=false)
   * @returns A handle with a cancel() method
   */
  stream(
    components: SystemLogComponent[],
    opts: SystemLogStreamOptions,
    onData: (chunk: Buffer) => void,
    onError?: (err: Error) => void,
    onEnd?: () => void
  ): SystemLogStreamResult
}

/** Maximum tail lines accepted from clients. */
export const MAX_TAIL_LINES = 5000

/** Default tail lines when not specified. */
export const DEFAULT_TAIL_LINES = 500

export function clampTailLines(tailLines: number | undefined): number {
  return Math.min(Math.max(tailLines ?? DEFAULT_TAIL_LINES, 1), MAX_TAIL_LINES)
}
