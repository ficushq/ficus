/**
 * The workspace settings directory (`.ficus` at the workspace root) holds the
 * squad's environment file, shell rc file, toolchain state and other
 * per-feature files. Agents use it through their own shell; the workspace
 * browsing, download and search APIs never list, serve, archive or search it,
 * and the workspace upload API never creates or overwrites anything in it.
 *
 * Only the directory at the workspace ROOT is treated this way. Ficus writes
 * settings there alone, and a `.ficus` directory deeper in the tree is ordinary
 * project content (for example a cloned repository's committed config), which
 * these APIs keep serving like any other file.
 *
 * Every check runs on a resolved path: `..`, duplicate slashes and trailing
 * slashes are normalized away first, the name comparison ignores case and
 * trailing dots or spaces (which some filesystems drop), and callers resolve
 * symlinks to the real path before asking, so a link that points into the
 * settings directory is refused like the directory itself.
 */
import fs from 'fs'
import path from 'path'
import type { BashResponse } from '../sandbox/client/http-client'
import { isWorkspaceSettingsPath, WORKSPACE_DOT_DIR } from '../workspace/dot-dir'
import { isInsideWorkspaceRoot, resolveSandboxWorkspacePath } from './workspace'

export { isWorkspaceSettingsDirName, isWorkspaceSettingsPath } from '../workspace/dot-dir'

/**
 * The outcome of resolving a request path against a workspace. `invalid`
 * escapes the workspace (answered like the routes' existing 400) and
 * `not-found` is either missing or the settings directory (answered like the
 * routes' existing 404, so the two are indistinguishable).
 */
export type WorkspaceTargetResolution =
  | {
      ok: true
      /** The path to serve: the real path on the Core's filesystem, the checked lexical path in a sandbox. */
      path: string
      /** The target's real path is the workspace root, so its settings directory must be left out of listings and archives. */
      isRoot: boolean
    }
  | { ok: false; reason: 'invalid' | 'not-found' }

/**
 * Resolve a workspace-relative request path on the Core's own filesystem
 * (docker and host runtimes). The lexical path must stay inside the
 * workspace, and so must the real path after symlinks are followed; either
 * one naming the settings directory is `not-found`.
 */
export function resolveLocalWorkspaceTarget(workspacePath: string, relativePath: string): WorkspaceTargetResolution {
  const lexical = path.resolve(workspacePath, relativePath)
  if (!isInsideWorkspaceRoot(workspacePath, lexical)) return { ok: false, reason: 'invalid' }
  if (isWorkspaceSettingsPath(workspacePath, lexical)) return { ok: false, reason: 'not-found' }
  let root: string
  let real: string
  try {
    root = fs.realpathSync(workspacePath)
    real = fs.realpathSync(lexical)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return { ok: false, reason: 'not-found' }
    throw error
  }
  if (!isInsideWorkspaceRoot(root, real)) return { ok: false, reason: 'invalid' }
  if (isWorkspaceSettingsPath(root, real)) return { ok: false, reason: 'not-found' }
  return { ok: true, path: real, isRoot: real === root }
}

/** Symlink hops followed before a path counts as a loop (Linux's own limit). */
const MAX_SYMLINK_HOPS = 40

/**
 * The real path a write to `target` would land on: every existing component
 * is resolved through its symlinks (a dangling link is followed to where it
 * points), and the missing tail is appended as written.
 */
function realpathForWrite(target: string, hops = 0): string {
  try {
    return fs.realpathSync(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  const parent = path.dirname(target)
  if (parent === target) return target
  const candidate = path.join(realpathForWrite(parent, hops), path.basename(target))
  let link: string
  try {
    if (!fs.lstatSync(candidate).isSymbolicLink()) return candidate
    link = fs.readlinkSync(candidate)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return candidate
    throw error
  }
  if (hops >= MAX_SYMLINK_HOPS) throw Object.assign(new Error('Too many symbolic links'), { code: 'ELOOP' })
  return realpathForWrite(path.resolve(path.dirname(candidate), link), hops + 1)
}

/**
 * Resolve a workspace-relative write target on the Core's own filesystem
 * (docker and host runtimes). Unlike {@link resolveLocalWorkspaceTarget} the
 * target may not exist yet: the real path is taken through the deepest
 * existing ancestor, so a symlinked parent or a dangling link that points
 * into the settings directory is refused like the directory itself. The
 * returned path is the lexical one; the writer re-checks its own real path.
 */
export function resolveLocalWorkspaceWriteTarget(
  workspacePath: string,
  relativePath: string
): WorkspaceTargetResolution {
  const lexical = path.resolve(workspacePath, relativePath)
  if (!isInsideWorkspaceRoot(workspacePath, lexical)) return { ok: false, reason: 'invalid' }
  if (isWorkspaceSettingsPath(workspacePath, lexical)) return { ok: false, reason: 'not-found' }
  let root: string
  let real: string
  try {
    root = fs.realpathSync(workspacePath)
    real = realpathForWrite(lexical)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return { ok: false, reason: 'invalid' }
    throw error
  }
  if (!isInsideWorkspaceRoot(root, real)) return { ok: false, reason: 'invalid' }
  if (isWorkspaceSettingsPath(root, real)) return { ok: false, reason: 'not-found' }
  return { ok: true, path: lexical, isRoot: real === root }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/**
 * The box-side file-name search behind the workspace search route. The query is
 * one quoted `-name` pattern (never shell syntax), and the settings directory
 * at the workspace root is pruned so nothing below it is visited or printed.
 */
export function buildSandboxWorkspaceSearchCommand(workspaceMount: string, query: string): string {
  return [
    `find ${shellQuote(workspaceMount)} -maxdepth 5`,
    `-path ${shellQuote(`${workspaceMount}/${WORKSPACE_DOT_DIR}`)} -prune -o`,
    `-name ${shellQuote(`*${query}*`)}`,
    `-not -path '*/node_modules/*' -not -path '*/.git/*' -not -name '*.pyc' -print`,
    `2>/dev/null | head -20`,
  ].join(' ')
}

/** The minimal sandbox client surface {@link resolveSandboxWorkspaceTarget} needs. */
export interface SandboxPathClient {
  bash(request: { command: string; cwd?: string; sourceEnv?: boolean; activateDevbox?: boolean }): {
    on(event: 'data', listener: (data: BashResponse) => void): unknown
    on(event: 'end', listener: () => void): unknown
    on(event: 'error', listener: (error: Error) => void): unknown
  }
}

/**
 * The box-side command that prints the real workspace root and the real
 * target, each NUL-terminated. `realpath -m` resolves every existing symlink
 * and tolerates a missing tail, so a dangling link is still classified.
 */
export function buildSandboxRealpathCommand(workspaceMount: string, target: string): string {
  return [
    `w=$(realpath -m -- ${shellQuote(workspaceMount)}) || exit 3`,
    `r=$(realpath -m -- ${shellQuote(target)}) || exit 3`,
    `printf '%s\\0%s\\0' "$w" "$r"`,
  ].join('\n')
}

/** Why a box-side real-path check failed; every caller fails closed on it. */
const UNRESOLVED_MESSAGE = 'Could not resolve the workspace path'

/** Run a box-side path command and return its stdout, rejecting on a nonzero exit. */
function runSandboxPathCommand(client: SandboxPathClient, workspaceMount: string, command: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Decode once at the end: a multi-byte name may straddle two output chunks.
    const stdout: Buffer[] = []
    let exitCode: number | undefined
    const stream = client.bash({ command, cwd: workspaceMount, sourceEnv: false, activateDevbox: false })
    stream.on('data', (data) => {
      if (data.stdout) stdout.push(Buffer.from(data.stdout, 'base64'))
      if (data.exitCode !== undefined) exitCode = data.exitCode
    })
    stream.on('error', reject)
    stream.on('end', () => {
      if (exitCode !== undefined && exitCode !== 0) reject(new Error(UNRESOLVED_MESSAGE))
      else resolve(Buffer.concat(stdout).toString('utf-8'))
    })
  })
}

async function sandboxRealpaths(
  client: SandboxPathClient,
  workspaceMount: string,
  target: string
): Promise<{ root: string; real: string }> {
  const output = await runSandboxPathCommand(
    client,
    workspaceMount,
    buildSandboxRealpathCommand(workspaceMount, target)
  )
  const [root, real] = output.split('\0')
  if (!root || !real) throw new Error(UNRESOLVED_MESSAGE)
  return { root, real }
}

/** The lexical half of a sandbox check: a refusal, or the absolute path whose real path the box must resolve. */
function lexicalSandboxTarget(
  workspaceMount: string,
  relativePath: string
): { resolution: WorkspaceTargetResolution } | { lexical: string } {
  const lexical = resolveSandboxWorkspacePath(workspaceMount, relativePath)
  if (!lexical) return { resolution: { ok: false, reason: 'invalid' } }
  if (isWorkspaceSettingsPath(workspaceMount, lexical, path.posix)) {
    return { resolution: { ok: false, reason: 'not-found' } }
  }
  return { lexical }
}

/** Classify a target from the real paths the box reported for the workspace root and for the target. */
function classifySandboxRealpath(lexical: string, root: string, real: string): WorkspaceTargetResolution {
  if (!isInsideWorkspaceRoot(root, real)) return { ok: false, reason: 'invalid' }
  if (isWorkspaceSettingsPath(root, real, path.posix)) return { ok: false, reason: 'not-found' }
  return { ok: true, path: lexical, isRoot: real === root }
}

/**
 * Resolve a workspace-relative request path inside a remote sandbox (vm and
 * k8s runtimes). The lexical check needs no round trip; the real path is then
 * resolved in the box, because only the box can follow its own symlinks.
 * The lexical path is what gets served: the box's file routes allow-list
 * their logical roots, which a physical real path may not match.
 * Throws when the box cannot answer, so callers fail closed.
 */
export async function resolveSandboxWorkspaceTarget(
  client: SandboxPathClient,
  workspaceMount: string,
  relativePath: string
): Promise<WorkspaceTargetResolution> {
  const lexical = lexicalSandboxTarget(workspaceMount, relativePath)
  if ('resolution' in lexical) return lexical.resolution
  const { root, real } = await sandboxRealpaths(client, workspaceMount, lexical.lexical)
  return classifySandboxRealpath(lexical.lexical, root, real)
}

/**
 * Bounds on one batched box-side real-path command. Bash receives the command
 * as a single argument, which Linux caps at 128 KiB, so a chunk stays well
 * below that; the target cap keeps any one command's work small.
 */
export const SANDBOX_REALPATH_BATCH_MAX_TARGETS = 256
export const SANDBOX_REALPATH_BATCH_MAX_COMMAND_BYTES = 48 * 1024

/**
 * The box-side command that resolves several targets at once. It prints the
 * real workspace root and then one entry per target, in order, each
 * NUL-terminated. Each target is resolved exactly as
 * {@link buildSandboxRealpathCommand} resolves a single one; a target the box
 * cannot resolve prints an empty entry (a real path is never empty), so only
 * that target fails. Targets are single-quoted words, never shell syntax.
 */
export function buildSandboxRealpathBatchCommand(workspaceMount: string, targets: readonly string[]): string {
  return [
    `w=$(realpath -m -- ${shellQuote(workspaceMount)}) || exit 3`,
    `printf '%s\\0' "$w"`,
    `for t in ${targets.map(shellQuote).join(' ')}; do`,
    `if r=$(realpath -m -- "$t"); then printf '%s\\0' "$r"; else printf '\\0'; fi`,
    `done`,
  ].join('\n')
}

/**
 * Split targets into chunks whose batch command stays within the size and
 * count bounds. A target that cannot share a command (one too long for the
 * byte budget alone, or a name with a NUL byte, which a command cannot carry)
 * gets a chunk of its own, which is checked with the single-target command.
 */
function chunkSandboxRealpathTargets(workspaceMount: string, targets: readonly string[]): string[][] {
  const base = Buffer.byteLength(buildSandboxRealpathBatchCommand(workspaceMount, []))
  const chunks: string[][] = []
  let current: string[] = []
  let bytes = base
  for (const target of targets) {
    const size = Buffer.byteLength(shellQuote(target)) + 1
    if (target.includes('\0') || base + size > SANDBOX_REALPATH_BATCH_MAX_COMMAND_BYTES) {
      chunks.push([target])
      continue
    }
    if (
      current.length >= SANDBOX_REALPATH_BATCH_MAX_TARGETS ||
      bytes + size > SANDBOX_REALPATH_BATCH_MAX_COMMAND_BYTES
    ) {
      chunks.push(current)
      current = []
      bytes = base
    }
    current.push(target)
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** The real workspace root and per-target real paths (an Error where the box could not resolve one). */
async function sandboxRealpathBatch(
  client: SandboxPathClient,
  workspaceMount: string,
  targets: readonly string[]
): Promise<{ root: string; reals: Array<string | Error> }> {
  if (targets.length === 1) {
    const { root, real } = await sandboxRealpaths(client, workspaceMount, targets[0]!)
    return { root, reals: [real] }
  }
  const output = await runSandboxPathCommand(
    client,
    workspaceMount,
    buildSandboxRealpathBatchCommand(workspaceMount, targets)
  )
  // Exactly the root and one entry per target, each NUL-terminated; anything
  // else (a truncated or garbled answer) fails the whole chunk closed.
  const entries = output.split('\0')
  const root = entries[0]
  if (entries.length !== targets.length + 2 || entries.at(-1) !== '' || !root) {
    throw new Error(UNRESOLVED_MESSAGE)
  }
  return {
    root,
    reals: entries.slice(1, -1).map((real) => real || new Error(UNRESOLVED_MESSAGE)),
  }
}

/** One target's outcome from {@link resolveSandboxWorkspaceTargets}: a resolution, or the error that refuses it. */
export type SandboxTargetCheck = { resolution: WorkspaceTargetResolution } | { error: unknown }

/**
 * Resolve many workspace-relative paths inside a remote sandbox with as few
 * box round trips as possible. Each path gets exactly the answer
 * {@link resolveSandboxWorkspaceTarget} would give it: the same lexical
 * checks (answered without the box), the same in-box `realpath -m`, and the
 * same classification. Paths that need the box are deduplicated and resolved
 * in bounded chunks, one command per chunk. A chunk the box cannot answer
 * refuses every path in it with the error, and a single path the box cannot
 * resolve refuses only that path, so callers fail closed per path.
 */
export async function resolveSandboxWorkspaceTargets(
  client: SandboxPathClient,
  workspaceMount: string,
  relativePaths: readonly string[],
  signal?: AbortSignal
): Promise<SandboxTargetCheck[]> {
  const checks: Array<SandboxTargetCheck | undefined> = []
  const pending = new Map<string, number[]>()
  relativePaths.forEach((relativePath, index) => {
    const lexical = lexicalSandboxTarget(workspaceMount, relativePath)
    if ('resolution' in lexical) checks[index] = lexical
    else pending.set(lexical.lexical, [...(pending.get(lexical.lexical) ?? []), index])
  })
  for (const chunk of chunkSandboxRealpathTargets(workspaceMount, [...pending.keys()])) {
    let outcomes: SandboxTargetCheck[]
    try {
      signal?.throwIfAborted()
      const { root, reals } = await sandboxRealpathBatch(client, workspaceMount, chunk)
      outcomes = chunk.map((lexical, i) => {
        const real = reals[i]!
        return real instanceof Error ? { error: real } : { resolution: classifySandboxRealpath(lexical, root, real) }
      })
    } catch (error) {
      outcomes = chunk.map(() => ({ error }))
    }
    chunk.forEach((lexical, i) => {
      for (const index of pending.get(lexical)!) checks[index] = outcomes[i]!
    })
  }
  return checks.map((check) => check!)
}
