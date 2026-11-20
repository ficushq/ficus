/**
 * Validation for the squad's pinned managed-toolchain `devbox.lock`.
 *
 * A box with no `devbox.lock` resolves bare and `@latest` packages against the
 * current `nixpkgs-unstable` tip, and Nix downloads that whole source tree into
 * the box's private cache (about 400 MB). Ficus therefore keeps the lock the
 * first successful install of a squad's toolchain fingerprint produced and
 * writes it into later boxes before `devbox install`, so they reuse a nixpkgs
 * commit the machine's `/nix/store` already holds.
 *
 * The lock is read back from a box an agent can write to, so it is accepted
 * only in the narrow shape Devbox produces for this exact configuration: one
 * entry per declared package (plus Devbox's own nixpkgs entry), every source
 * reference pinned to an exact `github:NixOS/nixpkgs` commit and every output a
 * plain `/nix/store` path. Anything else is ignored and the box resolves as it
 * did before pinning existed.
 */

/** Devbox's lock key for the nixpkgs revision its generated flake uses. */
export const TOOLCHAIN_STDENV_LOCK_KEY = 'github:NixOS/nixpkgs/nixpkgs-unstable'

/** Real toolchain locks are a few KB; a larger value is never stored or written. */
export const MAX_TOOLCHAIN_LOCK_BYTES = 256 * 1024

/** An exact nixpkgs commit, optionally with Nix's lock query and an attribute. */
const PINNED_NIXPKGS_REF = /^github:NixOS\/nixpkgs\/[0-9a-f]{40}(\?[A-Za-z0-9=&%._-]*)?(#[A-Za-z0-9._+-]+)?$/
const STORE_PATH = /^\/nix\/store\/[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]+$/

export type ToolchainLockCheck = { ok: true } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkSystems(name: string, systems: unknown): string | undefined {
  if (systems === undefined) return undefined
  if (!isRecord(systems)) return `${name}: systems is not an object`
  for (const [system, entry] of Object.entries(systems)) {
    if (!isRecord(entry)) return `${name}: ${system} is not an object`
    if (entry.store_path !== undefined && (typeof entry.store_path !== 'string' || !STORE_PATH.test(entry.store_path)))
      return `${name}: ${system} has an invalid store path`
    if (entry.outputs === undefined) continue
    if (!Array.isArray(entry.outputs)) return `${name}: ${system} outputs is not a list`
    for (const output of entry.outputs) {
      if (!isRecord(output) || typeof output.path !== 'string' || !STORE_PATH.test(output.path))
        return `${name}: ${system} has an invalid output path`
    }
  }
  return undefined
}

/**
 * Accept `content` only when it is a Devbox lock for exactly `packages` (the
 * normalized toolchain package list) whose every reference is an exact
 * official nixpkgs commit or a `/nix/store` path.
 */
export function checkToolchainLock(content: string, packages: readonly string[]): ToolchainLockCheck {
  if (Buffer.byteLength(content, 'utf8') > MAX_TOOLCHAIN_LOCK_BYTES) return { ok: false, reason: 'too large' }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { ok: false, reason: 'not JSON' }
  }
  if (!isRecord(parsed) || typeof parsed.lockfile_version !== 'string' || !isRecord(parsed.packages))
    return { ok: false, reason: 'not a Devbox lock' }

  const declared = new Set(packages)
  const entries = parsed.packages
  for (const name of declared) {
    if (!(name in entries)) return { ok: false, reason: `missing ${name}` }
  }
  for (const [name, entry] of Object.entries(entries)) {
    if (!declared.has(name) && name !== TOOLCHAIN_STDENV_LOCK_KEY)
      return { ok: false, reason: `undeclared entry ${name}` }
    if (!isRecord(entry)) return { ok: false, reason: `${name}: entry is not an object` }
    if (typeof entry.resolved !== 'string' || !PINNED_NIXPKGS_REF.test(entry.resolved))
      return { ok: false, reason: `${name}: not pinned to an exact nixpkgs commit` }
    const systems = checkSystems(name, entry.systems)
    if (systems) return { ok: false, reason: systems }
  }
  return { ok: true }
}
