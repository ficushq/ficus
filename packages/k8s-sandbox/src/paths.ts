/**
 * Path constants and validation for the sandbox environment.
 *
 * All file operations are restricted to allowed directory prefixes.
 * This prevents agents from accessing host filesystems or other pods.
 */

import * as path from 'path'

/** Workspace root — the primary working directory for agents */
export function getWorkspace(): string {
  return process.env.WORKSPACE_PATH || '/workspace'
}

/** Path to .tau/.env file for workspace environment variables */
export function getTauEnvPath(): string {
  return `${getWorkspace()}/.tau/.env`
}

/**
 * Devbox directory — where THIS box's own devbox.json lives.
 *
 * Mirrors the entrypoint's `WS=${FICUS_DEVBOX_DIR:-${WORKSPACE_PATH:-/workspace}}`.
 * Per-agent (light) boxes share the squad's WORKSPACE_PATH (a heavy toolchain
 * the light box never realizes) but keep their own minimal devbox in
 * FICUS_DEVBOX_DIR (e.g. /private). The executor MUST resolve the same dir the
 * entrypoint seeds — otherwise it points at the squad devbox, whose un-realized
 * packages make `devbox shellenv` hang ~30s, blocking the event loop and
 * freezing /healthz (see cacheDevboxShellEnv / devboxHasPackages).
 */
export function getDevboxDir(): string {
  return process.env.FICUS_DEVBOX_DIR || getWorkspace()
}

/** Path to devbox.json (indicates devbox is configured for this box) */
export function getDevboxJsonPath(): string {
  return `${getDevboxDir()}/devbox.json`
}

/** Path to .tau/.bashrc (devbox activation for interactive shells) */
export function getDevboxBashrcPath(): string {
  return `${getWorkspace()}/.tau/.bashrc`
}

/**
 * Allowed path prefixes for file operations.
 * Paths outside these directories are rejected.
 */
const ALLOWED_PREFIXES = ['/private', '/workspace', '/memory', '/home/tau', '/nix', '/opt/tau', '/tmp']

function getAllowedPrefixes(): string[] {
  const prefixes = [...ALLOWED_PREFIXES]

  const workspace = getWorkspace()
  if (workspace !== '/workspace' && !prefixes.includes(workspace)) {
    prefixes.push(workspace)
  }

  // VM "box" runtime only: a box works out of a per-user HOME (`/home/box_<hash>`),
  // and file-sync writes agent assets there (~/bin, ~/.tau/skills, ~/memory) — a
  // path that is NOT a static ALLOWED_PREFIX. box-manager bakes FICUS_BOX_HOME=<box
  // HOME> so the server permits writes under exactly that one box's home. k8s pods
  // NEVER set FICUS_BOX_HOME, so this widens nothing there; it is scoped per-box.
  const boxHome = process.env.FICUS_BOX_HOME
  if (boxHome && !prefixes.includes(boxHome)) {
    prefixes.push(boxHome)
  }

  return prefixes
}

/**
 * VM "box" runtime ONLY: rebase a k8s LOGICAL container root onto the box user's
 * physical HOME layout. This is the single source of truth used by BOTH
 * {@link resolvePath} (filesystem ops) and the bash `cwd` resolution.
 *
 * k8s pods and docker sandboxes NEVER set `FICUS_BOX_HOME`, so this is the
 * IDENTITY function there — their path handling stays byte-identical (see the
 * parity snapshot in paths.test.ts).
 *
 * The VM coding tools (`createK8sSandboxedCodingTools`, `squad_bash`) address the
 * same logical roots a k8s pod exposes — `/private`, `/workspace/<squadId>`,
 * `/memory[/<squadId>]` — but on a box those are literal, root-owned machine
 * paths the box user cannot touch. box-provision.sh + file-sync.ts instead lay
 * the box out under HOME, so we rebase:
 *   /private            → $FICUS_BOX_HOME/.private   (agent private scratch/key)
 *   /workspace[/<sq>]   → $FICUS_BOX_HOME/workspace  (squad working tree)
 *   /memory[/<sq>]      → $FICUS_BOX_HOME/memory     (memory replica)
 * These land EXACTLY where file-sync.ts writes (~/.private/identity.pem,
 * ~/workspace/.tau/.env, ~/memory/<tree>) and where box-provision.sh created the
 * dirs (~/.private, ~/workspace; ~/memory is materialized by file-sync's
 * create-dirs write).
 *
 * The namespaced roots collapse: a box holds exactly ONE squad's tree directly
 * under `~/workspace` / `~/memory` (file-sync writes `~/workspace/.tau/.env`, not
 * `~/workspace/<sq>/...`), so the `/<squadId>` segment is stripped. The box's own
 * squad id arrives as `FICUS_SQUAD_ID`; the namespaced rules are matched BEFORE the
 * bare ones so the segment is dropped rather than preserved.
 *
 * Security: callers normalize (`path.resolve`) before the prefix match, so no
 * `..` survives into the physical path — the rebased result is always contained
 * under HOME, and {@link resolvePath}'s allow-prefix check still rejects anything
 * else (sibling box homes included).
 */
export function rebaseLogicalRoot(p: string): string {
  const home = process.env.FICUS_BOX_HOME
  if (!home) return p
  const abs = path.isAbsolute(p) ? path.resolve(p) : p
  // Already-physical box paths must be idempotent. On macOS the canonical
  // temporary box home itself starts with /private, also a logical mount name.
  const physicalHome = path.resolve(home)
  if (abs === physicalHome || abs.startsWith(physicalHome + '/')) return abs
  for (const { logical, physical } of boxRebaseRules(home)) {
    if (abs === logical) return physical
    if (abs.startsWith(logical + '/')) return physical + abs.slice(logical.length)
  }
  return abs
}

/** Logical→physical rebase rules for a box, most-specific (namespaced) first. */
function boxRebaseRules(home: string): Array<{ logical: string; physical: string }> {
  const squadId = process.env.FICUS_SQUAD_ID
  const rules: Array<{ logical: string; physical: string }> = []
  if (squadId) {
    rules.push({ logical: `/workspace/${squadId}`, physical: `${home}/workspace` })
    rules.push({ logical: `/memory/${squadId}`, physical: `${home}/memory` })
  }
  rules.push({ logical: '/workspace', physical: `${home}/workspace` })
  rules.push({ logical: '/memory', physical: `${home}/memory` })
  rules.push({ logical: '/private', physical: `${home}/.private` })
  return rules
}

/**
 * Resolve a path and validate it against allowed prefixes.
 * If the path is relative, it's resolved against WORKSPACE.
 *
 * On a VM box (`FICUS_BOX_HOME` set) an absolute LOGICAL root is first rebased onto
 * the box HOME layout (see {@link rebaseLogicalRoot}); a no-op on k8s/docker.
 *
 * @throws Error if the resolved path is outside all allowed directories
 */
export function resolvePathPolicy(p: string): { path: string; allowedRoot: string } {
  const workspace = getWorkspace()
  // Resolve relative paths against workspace (already physical on a box); rebase
  // absolute logical roots onto the box HOME after normalizing away any `..`.
  const resolved = path.isAbsolute(p) ? rebaseLogicalRoot(path.resolve(p)) : path.resolve(workspace, p)
  const allowedRoot = getAllowedPrefixes()
    .filter((prefix) => resolved === prefix || resolved.startsWith(prefix + '/'))
    .sort((left, right) => right.length - left.length)[0]

  if (!allowedRoot) {
    throw new Error(`Path outside allowed directories: ${resolved}`)
  }

  return { path: resolved, allowedRoot }
}

export function resolvePath(p: string): string {
  return resolvePathPolicy(p).path
}
