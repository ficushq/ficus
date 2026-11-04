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

async function sandboxRealpaths(
  client: SandboxPathClient,
  workspaceMount: string,
  target: string
): Promise<{ root: string; real: string }> {
  const output = await new Promise<string>((resolve, reject) => {
    let stdout = ''
    let exitCode: number | undefined
    const stream = client.bash({
      command: buildSandboxRealpathCommand(workspaceMount, target),
      cwd: workspaceMount,
      sourceEnv: false,
      activateDevbox: false,
    })
    stream.on('data', (data) => {
      if (data.stdout) stdout += Buffer.from(data.stdout, 'base64').toString('utf-8')
      if (data.exitCode !== undefined) exitCode = data.exitCode
    })
    stream.on('error', reject)
    stream.on('end', () => {
      if (exitCode !== undefined && exitCode !== 0) reject(new Error('Could not resolve the workspace path'))
      else resolve(stdout)
    })
  })
  const [root, real] = output.split('\0')
  if (!root || !real) throw new Error('Could not resolve the workspace path')
  return { root, real }
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
  const lexical = resolveSandboxWorkspacePath(workspaceMount, relativePath)
  if (!lexical) return { ok: false, reason: 'invalid' }
  if (isWorkspaceSettingsPath(workspaceMount, lexical, path.posix)) return { ok: false, reason: 'not-found' }
  const { root, real } = await sandboxRealpaths(client, workspaceMount, lexical)
  if (!isInsideWorkspaceRoot(root, real)) return { ok: false, reason: 'invalid' }
  if (isWorkspaceSettingsPath(root, real, path.posix)) return { ok: false, reason: 'not-found' }
  return { ok: true, path: lexical, isRoot: real === root }
}
