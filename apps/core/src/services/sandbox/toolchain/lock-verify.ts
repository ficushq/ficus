/**
 * Core-side verification of a managed-toolchain `devbox.lock` read back from a
 * box, before it becomes the squad's pin.
 *
 * The box is agent-writable, so nothing in the captured lock is trusted. Core
 * builds the pin itself and fails closed (no pin, so boxes keep resolving
 * afresh) on any doubt:
 *
 * 1. Each declared package entry must reference `github:NixOS/nixpkgs/<sha>`
 *    with no query. GitHub serves commits from every fork under the
 *    NixOS/nixpkgs path, so the shape proves nothing: each commit must be
 *    reported by the GitHub API as identical to or behind `nixpkgs-unstable`
 *    (an ancestor of the upstream branch). A `narHash` query is refused
 *    because Nix uses any store path with that hash without fetching, so it
 *    could name a tree the agent added to the store. Devbox writes such a
 *    query only for bare (unversioned) packages, which pinning cannot speed up
 *    anyway (see docs/wiki/sandbox-runtimes.md), so those toolchains are not
 *    pinned.
 * 2. Every store path the lock names, for every system, must have a narinfo on
 *    cache.nixos.org, i.e. it is a path the official cache serves.
 * 3. The captured nixpkgs entry Devbox uses for the shell (the stdenv) is
 *    discarded. Core substitutes the stdenv from its own comfort-set lock cache
 *    (the same nixpkgs every box's comfort shell already uses), after checking
 *    that commit too. Without one the pin has no stdenv entry and Devbox
 *    resolves it at install time, as it does without a pin.
 */

import { checkToolchainLock, TOOLCHAIN_STDENV_LOCK_KEY } from './lock-pin'

const NIXPKGS_API = 'https://api.github.com/repos/NixOS/nixpkgs'
const UPSTREAM_BRANCH = 'nixpkgs-unstable'
const BINARY_CACHE = 'https://cache.nixos.org'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_CONCURRENT_REQUESTS = 8
const MAX_REMEMBERED = 2_000

/** `github:NixOS/nixpkgs/<sha>#attr`, no query: the only package form accepted. */
const UNHASHED_PACKAGE_REF = /^github:NixOS\/nixpkgs\/([0-9a-f]{40})#[A-Za-z0-9._+-]+$/
const STDENV_REF =
  /^github:NixOS\/nixpkgs\/([0-9a-f]{40})\?[A-Za-z0-9=&%._-]*narHash=[A-Za-z0-9%._-]+[A-Za-z0-9=&%._-]*$/
const STORE_HASH = /^\/nix\/store\/([0-9a-df-np-sv-z]{32})-/

export type VerifiedPin = { ok: true; lock: string } | { ok: false; reason: string }

export interface LockVerifyDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

/**
 * Positive results only, so repeated pins do not spend the GitHub API's
 * unauthenticated rate limit: an upstream commit or cached path stays that way.
 */
const upstreamCommits = new Set<string>()
const cachedStoreHashes = new Set<string>()

function remember(set: Set<string>, value: string): void {
  if (set.size >= MAX_REMEMBERED) set.clear()
  set.add(value)
}

/** Test seam: forget remembered verification results. */
export function resetLockVerificationMemory(): void {
  upstreamCommits.clear()
  cachedStoreHashes.clear()
}

async function request(deps: LockVerifyDeps, url: string, init: RequestInit): Promise<Response> {
  const doFetch = deps.fetch ?? ((input: string, options: RequestInit) => fetch(input, options))
  return doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' })
}

async function isUpstreamCommit(sha: string, deps: LockVerifyDeps): Promise<boolean> {
  if (upstreamCommits.has(sha)) return true
  const response = await request(deps, `${NIXPKGS_API}/compare/${UPSTREAM_BRANCH}...${sha}?per_page=1`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'ficus-core' },
  })
  if (!response.ok) return false
  const body = (await response.json()) as { status?: unknown; merge_base_commit?: { sha?: unknown } }
  const upstream = (body.status === 'behind' || body.status === 'identical') && body.merge_base_commit?.sha === sha
  if (upstream) remember(upstreamCommits, sha)
  return upstream
}

async function isServedByOfficialCache(hash: string, deps: LockVerifyDeps): Promise<boolean> {
  if (cachedStoreHashes.has(hash)) return true
  const response = await request(deps, `${BINARY_CACHE}/${hash}.narinfo`, { method: 'HEAD' })
  if (response.ok) remember(cachedStoreHashes, hash)
  return response.ok
}

/** Run checks with bounded concurrency; resolves to the first failing item or undefined. */
async function firstFailure<T>(items: readonly T[], check: (item: T) => Promise<boolean>): Promise<T | undefined> {
  let failed: T | undefined
  let next = 0
  const worker = async () => {
    while (failed === undefined && next < items.length) {
      const item = items[next++]!
      if (!(await check(item))) failed ??= item
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, items.length) }, worker))
  return failed
}

function collectStoreHashes(entry: Record<string, unknown>, into: Set<string>): boolean {
  const systems = entry.systems
  if (systems === undefined) return true
  for (const info of Object.values(systems as Record<string, Record<string, unknown>>)) {
    const paths = [
      ...(typeof info.store_path === 'string' ? [info.store_path] : []),
      ...((info.outputs as Array<{ path: string }> | undefined) ?? []).map((output) => output.path),
    ]
    for (const path of paths) {
      const hash = STORE_HASH.exec(path)?.[1]
      if (!hash) return false
      into.add(hash)
    }
  }
  return true
}

/**
 * Build the pin Core stores from a lock captured on a box, or explain why it
 * cannot be pinned. Never throws: a network error is a failed verification.
 *
 * `trustedStdenv` is the stdenv `resolved` value from Core's own comfort-set
 * lock cache, if any.
 */
export async function buildVerifiedPin(
  captured: string,
  packages: readonly string[],
  trustedStdenv: string | undefined,
  deps: LockVerifyDeps = {}
): Promise<VerifiedPin> {
  const shape = checkToolchainLock(captured, packages)
  if (!shape.ok) return shape
  const parsed = JSON.parse(captured) as { lockfile_version: string; packages: Record<string, Record<string, unknown>> }

  const commits = new Set<string>()
  const storeHashes = new Set<string>()
  const pinned: Record<string, unknown> = {}
  for (const name of packages) {
    const entry = parsed.packages[name]!
    const commit = UNHASHED_PACKAGE_REF.exec(entry.resolved as string)?.[1]
    if (!commit) return { ok: false, reason: `${name}: not a versioned nixpkgs package without a content hash` }
    commits.add(commit)
    if (!collectStoreHashes(entry, storeHashes)) return { ok: false, reason: `${name}: invalid store path` }
    pinned[name] = entry
  }

  if (trustedStdenv !== undefined) {
    const commit = STDENV_REF.exec(trustedStdenv)?.[1]
    if (commit) {
      commits.add(commit)
      pinned[TOOLCHAIN_STDENV_LOCK_KEY] = { resolved: trustedStdenv }
    }
  }

  try {
    const foreign = await firstFailure([...commits], (sha) => isUpstreamCommit(sha, deps))
    if (foreign) return { ok: false, reason: `commit ${foreign} is not part of upstream ${UPSTREAM_BRANCH}` }
    const uncached = await firstFailure([...storeHashes], (hash) => isServedByOfficialCache(hash, deps))
    if (uncached) return { ok: false, reason: `store path ${uncached} is not served by ${BINARY_CACHE}` }
  } catch (error) {
    return { ok: false, reason: `verification failed: ${error instanceof Error ? error.message : String(error)}` }
  }

  return {
    ok: true,
    lock: `${JSON.stringify({ lockfile_version: parsed.lockfile_version, packages: pinned }, null, 2)}\n`,
  }
}

/**
 * The invariant every stored pin satisfies, checked again before reuse: the
 * shape check plus no content-hashed package entry. Stored pins are written
 * only by Core after {@link buildVerifiedPin}; this guards against a row that
 * predates that rule or was edited by hand.
 */
export function checkStoredPin(
  content: string,
  packages: readonly string[]
): { ok: true } | { ok: false; reason: string } {
  const shape = checkToolchainLock(content, packages)
  if (!shape.ok) return shape
  const parsed = JSON.parse(content) as { packages: Record<string, { resolved: string }> }
  for (const name of packages) {
    if (!UNHASHED_PACKAGE_REF.test(parsed.packages[name]!.resolved))
      return { ok: false, reason: `${name}: not a versioned nixpkgs package without a content hash` }
  }
  const stdenv = parsed.packages[TOOLCHAIN_STDENV_LOCK_KEY]
  if (stdenv && !STDENV_REF.test(stdenv.resolved)) return { ok: false, reason: 'invalid stdenv entry' }
  return { ok: true }
}
