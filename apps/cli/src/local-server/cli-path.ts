import { realpathSync } from 'fs'
import { join } from 'path'
import { expandTilde } from '@ficus/shared/node'

const BIN_NAME = 'ficus'

/**
 * Mirrors scripts/install.sh's INSTALL_DIR: `$FICUS_INSTALL_DIR`, else
 * `$HOME/.tau/bin`. This is the one other place the CLI's own install
 * location is decided — keep it in sync with the installer rather than
 * re-deriving it.
 */
export function cliInstallDir(env: Record<string, string | undefined>, home: string): string {
  return env.FICUS_INSTALL_DIR ? expandTilde(env.FICUS_INSTALL_DIR, home) : join(home, '.tau', 'bin')
}

/** Best-effort realpath: a path that cannot be resolved (missing, EPERM, ...) resolves to itself. */
export function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export interface CliPathDeps {
  env: Record<string, string | undefined>
  home: string
  /** Resolve a command on PATH; null when not found. Injected so tests never touch the real PATH. */
  which(cmd: string): string | null
  /** Resolve symlinks so a shim still compares equal to the real installed binary. Injected for the same reason. */
  realpath(path: string): string
}

export interface CliPathStatus {
  /** `ficus` on PATH resolves to the binary setup itself installed — not just *some* `ficus`. */
  onPath: boolean
  installDir: string
  installedBinary: string
  /** What `which ficus` resolved to (realpath'd), or null when nothing on PATH answers to `ficus`. */
  resolvedBinary: string | null
}

/**
 * Whether the CLI's own installed binary (~/.tau/bin/ficus, the install.sh
 * default) is what `ficus` on the current PATH actually resolves to. A
 * `ficus` on PATH that resolves elsewhere (a stale install, an unrelated
 * shim) does not count — the operator needs to know about *this* one.
 */
export function checkCliOnPath(deps: CliPathDeps): CliPathStatus {
  const installDir = cliInstallDir(deps.env, deps.home)
  const installedBinary = join(installDir, BIN_NAME)
  const resolved = deps.which(BIN_NAME)
  const resolvedBinary = resolved ? deps.realpath(resolved) : null
  const onPath = resolvedBinary !== null && resolvedBinary === deps.realpath(installedBinary)
  return { onPath, installDir, installedBinary, resolvedBinary }
}

export type ShellKind = 'zsh' | 'bash' | 'fish' | 'other'

/** The current interactive shell, from `$SHELL` — the same signal a login shell itself relies on. */
export function detectShell(env: Record<string, string | undefined>): ShellKind {
  const name = (env.SHELL ?? '').split('/').pop() ?? ''
  return name === 'zsh' || name === 'bash' || name === 'fish' ? name : 'other'
}

/**
 * The copy-pasteable fix when `ficus` is not usable yet, in the installer's
 * own voice (see the "Next steps" section of scripts/install.sh) but aimed at
 * THIS terminal's shell instead of printing every shell's profile line
 * unconditionally. Empty when already on PATH — nothing extra to say.
 */
export function cliPathHintLines(status: CliPathStatus, shell: ShellKind): string[] {
  if (status.onPath) return []
  const dir = status.installDir
  const exportLine = shell === 'fish' ? `set -gx PATH "${dir}" $PATH` : `export PATH="${dir}:$PATH"`
  const lines = [
    `ficus is not on PATH yet (installed at ${status.installedBinary}).`,
    `  Use it in this terminal:  ${exportLine}`,
  ]
  if (shell === 'zsh') lines.push(`  Or add it permanently:     echo 'export PATH="${dir}:$PATH"' >> ~/.zshrc`)
  else if (shell === 'bash') lines.push(`  Or add it permanently:     echo 'export PATH="${dir}:$PATH"' >> ~/.bashrc`)
  else if (shell === 'fish') lines.push(`  Or add it permanently:     fish_add_path ${dir}`)
  lines.push('  ...or open a new terminal.')
  return lines
}
