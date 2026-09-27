/** Safe labels accepted for local Ficus instances and supervisor targets. */
export const LOCAL_INSTANCE_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$/
export const DEFAULT_LOCAL_INSTANCE = 'tau'

export interface LaunchdJobIdentity {
  program?: string
  workingDirectory?: string
  stderrPath?: string
}

/** Parse the full-line provenance fields emitted by `launchctl print`. */
export function parseLaunchdJobIdentity(stdout: string): LaunchdJobIdentity {
  const line = (match: RegExpExecArray | null) => match?.[1]?.trim()
  // Real `launchctl print` output names the binary on its own `program =` line
  // and lists argv separately in an `arguments = { ... }` block; the combined
  // `program arguments = {` form is kept only for older/alternative spellings.
  const program =
    line(/^\s*program\s*=\s*([^\r\n]+)/m.exec(stdout)) ??
    line(/program arguments\s*=\s*\{[^\S\r\n]*\r?\n[^\S\r\n]*([^\r\n]+)/.exec(stdout))
  return {
    program,
    workingDirectory: line(/^\s*working directory\s*=\s*([^\r\n]+)/m.exec(stdout)),
    stderrPath: line(/^\s*stderr path\s*=\s*([^\r\n]+)/m.exec(stdout)),
  }
}

/** Normalize and validate an operator- or environment-supplied instance label. */
export function normalizeLocalInstanceLabel(raw: string): string {
  const label = raw.trim().toLowerCase()
  if (!LOCAL_INSTANCE_LABEL_RE.test(label)) {
    throw new Error(`Invalid local instance label: "${raw}"`)
  }
  return label
}

/** Derive the only process names allowed for a local instance. */
export function localProcessNames(raw: string): { label: string; api: string; worker: string } {
  const label = normalizeLocalInstanceLabel(raw)
  return label === DEFAULT_LOCAL_INSTANCE
    ? { label, api: 'tau-api', worker: 'tau-worker' }
    : { label, api: `tau-${label}-api`, worker: `tau-${label}-worker` }
}
