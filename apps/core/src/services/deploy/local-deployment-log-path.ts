import { posix } from 'path'
import { resolveWorkspaceLayout } from '../sandbox/workspace-layout'
import { isWorkspaceSettingsPath } from '../workspace/dot-dir'

export const ATTACHED_LOG_PATH_MAX_LENGTH = 4096

/** Sanitized-message errors — never embed host paths or stderr in `message`. */
export class LocalDeploymentLogPathError extends Error {}
export class LocalDeploymentLogPathOutsideWorkspaceError extends LocalDeploymentLogPathError {}

export function shellQuote(value: string | number): string {
  if (typeof value === 'number') return String(value)
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

/**
 * Refuse a resolved `$r` inside the workspace settings directory (`$w/.ficus`,
 * any case), which attached logs never read.
 */
function refuseSettingsDir(refusal: string): string[] {
  const dir = '.[Ff][Ii][Cc][Uu][Ss]'
  return ['case "$r" in', `  "$w"/${dir}|"$w"/${dir}/*) ${refusal} ;;`, 'esac']
}

/** Resolve missing suffixes on BSD without trusting a lexical symlink prefix. */
function resolvePhysicalLogPath(): string[] {
  return [
    'r=$(realpath -m -- "$p" 2>/dev/null || readlink -f -- "$p" 2>/dev/null || true)',
    'if [ -z "$r" ]; then',
    '  a="$p"; suffix=""',
    '  while [ ! -e "$a" ] && [ ! -L "$a" ]; do',
    '    [ "$a" != "/" ] && [ -n "$a" ] || break',
    '    suffix="/${a##*/}$suffix"; a="${a%/*}"; [ -n "$a" ] || a="/"',
    '  done',
    '  r=$(realpath -m -- "$a" 2>/dev/null || readlink -f -- "$a" 2>/dev/null || true)',
    '  [ -z "$r" ] || r="$r$suffix"',
    'fi',
  ]
}

/**
 * Registration-time, host-side lexical validation of an attached deployment's
 * optional `logPath`. Returns the normalized absolute sandbox-side path, or
 * null when the field is absent.
 *
 * Relative inputs join the deployment's squad workspace mount
 * (`resolveWorkspaceLayout({ squadId }).workspaceMount` — `/workspace/<squadId>`
 * on containers, the squad box's `~/workspace` on vm, the squad workspace dir
 * on host), so every squad's accepted paths differ. The normalized result must
 * be strictly under `<workspaceMount>/`: this kills `..` traversal, absolute
 * escapes like `/etc/passwd`, and cross-squad paths (they normalize under a
 * different squad's mount) in one check, without executing anything.
 */
export function normalizeAttachedLogPathInput(raw: string | null | undefined, squadId: string): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') throw new LocalDeploymentLogPathError('logPath must be a string')
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.length > ATTACHED_LOG_PATH_MAX_LENGTH) {
    throw new LocalDeploymentLogPathError(`logPath is too long (max ${ATTACHED_LOG_PATH_MAX_LENGTH} characters)`)
  }
  // Newlines would corrupt the resolve command's line protocol; NUL breaks exec.
  // eslint-disable-next-line no-control-regex -- matching control bytes is the point
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new LocalDeploymentLogPathError('logPath must not contain control characters')
  }
  const { workspaceMount } = resolveWorkspaceLayout({ squadId })
  const absolute = posix.isAbsolute(trimmed) ? trimmed : `${workspaceMount}/${trimmed}`
  const normalized = posix.normalize(absolute)
  if (normalized === workspaceMount || !normalized.startsWith(`${workspaceMount}/`)) {
    throw new LocalDeploymentLogPathOutsideWorkspaceError('Attached log path must stay inside the squad workspace')
  }
  if (isWorkspaceSettingsPath(workspaceMount, normalized, posix)) {
    throw new LocalDeploymentLogPathOutsideWorkspaceError(
      'Attached log path must not be in the workspace settings directory'
    )
  }
  return normalized
}

/**
 * One exec: resolve `logPath` inside the sandbox (following symlinks when the
 * platform's tooling can), report OUTSIDE / EXISTS / MISSING plus the resolved
 * path. Always exits 0 so `manager.exec` never throws; the supervisor parses
 * stdout. This is the per-read second validation layer: it re-pins containment
 * against the deployment's own workspace mount at read time, so a symlink
 * created after registration cannot redirect the read outside the workspace.
 */
export function buildResolveAttachedLogPathCommand(workspaceMount: string, logPath: string): string {
  return [
    `w=${shellQuote(workspaceMount)}`,
    'original="$w"',
    `w=$(realpath -m -- "$w" 2>/dev/null || readlink -f -- "$w" 2>/dev/null) || { printf 'OUTSIDE\\n'; exit 0; }`,
    `p=${shellQuote(logPath)}`,
    // BSD readlink cannot resolve multiple missing suffix components. Rebase
    // the lexical workspace prefix first so its fallback still uses the same
    // canonical root; existing symlinks are resolved by the next command.
    'case "$p" in "$original"/*) p="$w/${p#"$original"/}" ;; esac',
    ...resolvePhysicalLogPath(),
    'case "$r" in',
    `  "$w"/*) ;;`,
    `  *) printf 'OUTSIDE\\n'; exit 0 ;;`,
    'esac',
    ...refuseSettingsDir("printf 'OUTSIDE\\n'; exit 0"),
    "if [ -f \"$r\" ]; then printf 'EXISTS\\n'; else printf 'MISSING\\n'; fi",
    'printf \'%s\\n\' "$r"',
  ].join('\n')
}

/**
 * Live tail of an ALREADY-RESOLVED path. The guard re-resolves the path
 * inside this same exec — realpath immediately before the open — and pins
 * containment on the re-resolved value, so a symlink swapped in at the
 * resolved location after the earlier resolve exec cannot redirect the open
 * outside the workspace (the window is within one exec, not across two).
 * `tail -F` follows rotation/truncation exactly like the managed-deployment
 * stream.
 */
export function buildStreamAttachedLogCommand(workspaceMount: string, resolvedLogPath: string, tail: number): string {
  return [
    `w=${shellQuote(workspaceMount)}`,
    'original="$w"',
    `w=$(realpath -m -- "$w" 2>/dev/null || readlink -f -- "$w" 2>/dev/null) || exit 3`,
    `p=${shellQuote(resolvedLogPath)}`,
    'case "$p" in "$original"/*) p="$w/${p#"$original"/}" ;; esac',
    ...resolvePhysicalLogPath(),
    'case "$r" in',
    `  "$w"/*) ;;`,
    "  *) printf 'attached log path is outside the squad workspace\\n' >&2; exit 3 ;;",
    'esac',
    ...refuseSettingsDir("printf 'attached log path is outside the squad workspace\\n' >&2; exit 3"),
    `tail -n ${shellQuote(tail)} -F "$r"`,
  ].join('\n')
}

/** Parse the resolve command's stdout. */
export function parseResolveAttachedLogPathOutput(output: string): { resolved: string; exists: boolean } {
  const lines = output.split('\n')
  const status = lines[0]
  if (status !== 'EXISTS' && status !== 'MISSING') {
    throw new LocalDeploymentLogPathError('Could not resolve the attached log path')
  }
  const resolved = lines.slice(1).join('\n').replace(/\n$/, '')
  if (!resolved) throw new LocalDeploymentLogPathError('Could not resolve the attached log path')
  return { resolved, exists: status === 'EXISTS' }
}
