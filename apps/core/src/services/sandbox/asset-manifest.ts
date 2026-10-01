/**
 * The shared per-sandbox asset manifest — the single source of truth for WHICH
 * assets a sandbox needs, where each COMES FROM (the materializer output on the
 * core host), where each GOES (a logical destination each runtime resolves to
 * an absolute path), its mode, and its scope.
 *
 * Ficus delivers these assets to sandboxes over three transports — vm push
 * (`vm/file-sync.ts`), k8s subPath mounts (`k8s/pod-spec.ts`), docker bind
 * mounts (`ensure.ts`). The asset PRODUCTION (materializers) is already
 * shared; this module dedupes the DECLARATION so adding a per-sandbox asset is
 * a one-line manifest change all three transports pick up. See
 * docs/history/superpowers/specs/2026-07-17-sandbox-asset-manifest-design.md.
 *
 * ## The asset set (extracted verbatim from file-sync's `syncBoxFiles`)
 *
 * `SANDBOX_ASSETS` order IS the vm push order (secrets last, per file-sync's
 * partial-secret-cleanup convention):
 *   1. `skills`    — materialized skills tree → `<skills anchor>/…` (all roles)
 *   2. `squad-env` — squad `.env`  → `<workspace>/.ficus/.env`  (0600, squad-scoped)
 *   3. `identity`  — identity key  → `<private>/identity.pem` (0600, per-agent;
 *                    a shared squad box has no single agent identity)
 *   4. `memory`    — memory replica → `<memory>/…` (SQUAD box only — squad
 *                    memory lives only where the workspace layout points)
 *   5. `squad-ssh` — squad ssh dir → `<ssh anchor>/…` (keys 0600;
 *                    `config`/`known_hosts`/`*.pub` 0644; squad-scoped)
 *
 * ## Scope rules (who gets what)
 *
 * `source(ctx)` returns null when an asset does not APPLY to the sandbox —
 * the same role logic `syncBoxFiles` applies:
 *   - solo agent / system-manager: skills + identity
 *   - squad MEMBER (agent with a squadId): skills + squad-env + identity + ssh
 *   - squad BOX (role 'squad'): skills + squad-env + memory + ssh
 *
 * Applicability is decided here; content EXISTENCE is not — sources are pure
 * path computation, and a missing/empty materializer output surfaces as
 * `files()` yielding nothing (the transports' existing skip-cleanly behavior).
 *
 * This module only DECLARES; the transports still deliver.
 */

import { existsSync, readFileSync } from 'fs'
import { readdir } from 'fs/promises'
import { join, relative } from 'path'
import { getHomeDir } from '../../lib/utils/home'
import { getSandboxSkillsDir, getSandboxSkillsStorageKey } from '../agent/skill-materializer'
import { getSquadMemoryPath } from '../memory/paths'
import { getSquadSshPath } from '../squad/ssh'
import { getSquadWorkspacePath } from '../squad/workspace'
import { materializeSquadRemoteHosts } from '../remote-hosts/materialize'
import { getSquadIdFromSandbox } from './types'
import { prepareWorkspaceDotDir, WORKSPACE_DOT_DIR, workspaceDotPath } from '../workspace/dot-dir'

/** Whether an asset is per-agent material or squad-shared material. */
export type AssetScope = 'agent' | 'squad'

/**
 * Runtime-agnostic destination: an anchor point + a path relative to it. Each
 * runtime resolves `base` to an absolute sandbox-side path — `private` /
 * `workspace` / `memory` via `resolveWorkspaceLayout` (privateMount /
 * workspaceMount / memoryMount), plus the anchors the layout doesn't expose:
 * `home` (the sandbox user's HOME), `skills` (`~/.ficus/skills` on vm — the
 * materializer-layout skills root), and `ssh` (`~/.ssh` on vm; the k8s
 * entrypoint mirrors its ssh-source mount there itself).
 */
export interface AssetDest {
  base: 'private' | 'workspace' | 'memory' | 'home' | 'skills' | 'ssh'
  /** Path under `base`: a file path for single-file assets (e.g. `.ficus/.env`),
   *  `''` for directory-tree assets (the tree's `files()` relPaths apply). */
  relPath: string
}

/** One file of an asset: path relative to the asset's dest, raw bytes, and the
 *  octal mode to create it with. Single-file assets use `relPath: ''` (the
 *  dest's own `relPath` already names the file). */
export interface AssetFile {
  relPath: string
  bytes: Uint8Array
  mode: string
}

/**
 * An applicable asset's source on the core host: the materializer output.
 * k8s/docker mount `hostPath` (k8s via `pvcSubPath`); the vm transport streams
 * `files()` over the box's `/write` endpoint.
 */
export interface AssetSource {
  /** Absolute core-host path the materializer wrote (mount source for
   *  k8s/docker; read source for vm push). */
  hostPath: string
  /** k8s subPath key of `hostPath` relative to the core-data PVC (HOME_DIR),
   *  e.g. `skills/sandboxes/<storageKey>` — exactly the keys pod-spec mounts
   *  today. Undefined where the current pod-spec has no dedicated subPath for
   *  the asset (squad-env rides the workspace mount; identity rides the
   *  private mount). */
  pvcSubPath?: string
  /** The asset's content, read lazily (sorted by relPath for determinism;
   *  empty when the materializer has produced nothing yet). Only the vm push
   *  transport calls this — mount-based runtimes never read bytes here. */
  files: () => Promise<AssetFile[]>
}

/** The sandbox the manifest is being resolved for. `role` mirrors file-sync's
 *  `BoxRole` / pod-spec's `sandboxType`. */
export interface AssetContext {
  sandboxId: string
  squadId?: string
  role: 'squad' | 'agent' | 'system-manager'
}

export interface SandboxAsset {
  /** Stable id for logs/tests. */
  name: string
  dest: AssetDest
  /** Default file mode (octal string). `files()` entries may refine per file
   *  (squad-ssh: `config`/`known_hosts`/`*.pub` are 0644, keys 0600). */
  mode: string
  scope: AssetScope
  /** Only a transport/WRITE failure of a required asset is fatal (delivering
   *  broken skills/identity would leave the sandbox broken). An ABSENT source —
   *  `files()` yielding nothing — is ALWAYS skipped cleanly, even for required
   *  assets, matching file-sync's skip-when-reader-yields-nothing behavior.
   *  NOTE: no consumer reads this today — vm treats EVERY write failure as
   *  fatal and mount runtimes have no write step — so it is declarative
   *  metadata until a consumer needs it. */
  required: boolean
  /** The asset's source for a concrete sandbox, or null when the asset does
   *  not apply to that sandbox's role/scope (see the scope rules above). */
  source: (ctx: AssetContext) => Promise<AssetSource | null>
}

/** Walk a directory into a sorted flat list of {relPath, bytes, mode}; empty
 *  when the directory is missing (mirrors file-sync's `listTree`). */
async function listTree(root: string, modeFor: (relPath: string) => string): Promise<AssetFile[]> {
  const out: AssetFile[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) {
        const relPath = relative(root, abs)
        out.push({ relPath, bytes: readFileSync(abs), mode: modeFor(relPath) })
      }
    }
  }
  await walk(root)
  // Sort here so `files()` order is deterministic for every consumer (the vm
  // push re-sorts at push time — a harmless double-sort).
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  return out
}

/** A single-file asset's `files()`: one entry at `relPath: ''`, or empty when
 *  the materializer hasn't produced the file (transports skip cleanly). */
function singleFile(path: string, mode: string): () => Promise<AssetFile[]> {
  return async () => (existsSync(path) ? [{ relPath: '', bytes: readFileSync(path), mode }] : [])
}

/**
 * {@link singleFile} for a file in a work root's dot dir. Reading first moves a legacy dot dir and
 * FAILS CLOSED (WorkspaceDotDirConflictError) on one that needs a manual fix: a key or env still in
 * an unmoved legacy dir must never read as "absent", which would make a vm sync prune the box copy.
 */
function dotDirFile(workRoot: string, name: string, mode: string): () => Promise<AssetFile[]> {
  const read = singleFile(workspaceDotPath(workRoot, name), mode)
  return async () => {
    prepareWorkspaceDotDir(workRoot)
    return read()
  }
}

/** Mode for one squad-ssh file: `config`/`known_hosts`/`*.pub` are non-secret
 *  ssh metadata (0644); everything else is a private key (0600). Mirrors
 *  file-sync's `sshArtifactMode`. */
export function sshFileMode(relPath: string): string {
  if (relPath === 'config' || relPath === 'known_hosts' || relPath.endsWith('.pub')) return '0644'
  return '0600'
}

/**
 * The per-sandbox asset set — order is the vm push order (secrets last).
 * Sources delegate to the EXISTING materializer/path helpers; nothing is
 * produced here.
 */
export const SANDBOX_ASSETS: SandboxAsset[] = [
  {
    name: 'skills',
    dest: { base: 'skills', relPath: '' },
    mode: '0644',
    scope: 'agent',
    required: true,
    source: async ({ sandboxId }) => {
      const hostPath = getSandboxSkillsDir(sandboxId)
      return {
        hostPath,
        pvcSubPath: `skills/sandboxes/${getSandboxSkillsStorageKey(sandboxId)}`,
        files: () => listTree(hostPath, () => '0644'),
      }
    },
  },
  {
    name: 'squad-env',
    dest: { base: 'workspace', relPath: `${WORKSPACE_DOT_DIR}/.env` },
    mode: '0600',
    scope: 'squad',
    required: false,
    source: async ({ squadId }) => {
      // Squad-scoped only; a solo agent has no shared squad workspace. The FULL
      // generated `.env` (user content + rendered Secret Store exports) — NOT
      // env.ts's `getEnvFile`, which masks secrets for the API/UI surface.
      if (!squadId) return null
      const workRoot = getSquadWorkspacePath(squadId)
      return { hostPath: workspaceDotPath(workRoot, '.env'), files: dotDirFile(workRoot, '.env', '0600') }
    },
  },
  {
    name: 'identity',
    dest: { base: 'private', relPath: 'identity.pem' },
    mode: '0600',
    scope: 'agent',
    required: true,
    source: async ({ sandboxId, role }) => {
      // Per-agent key material only; a shared squad box has no single agent
      // identity. Path mirrors services/amtp/agent-identity.ts:
      // <HOME_DIR>/private/<sandboxId>/.ficus/identity.pem.
      if (role === 'squad') return null
      const workRoot = join(getHomeDir(), 'private', sandboxId)
      return {
        hostPath: workspaceDotPath(workRoot, 'identity.pem'),
        files: dotDirFile(workRoot, 'identity.pem', '0600'),
      }
    },
  },
  {
    name: 'memory',
    dest: { base: 'memory', relPath: '' },
    mode: '0644',
    scope: 'squad',
    required: false,
    source: async ({ squadId, role }) => {
      // SQUAD box only: the workspace layout canonicalizes squad memory as the
      // squad box's memory root — a replica on a member (light) box would be
      // an orphan no path resolution accepts.
      if (!squadId || role !== 'squad') return null
      const hostPath = getSquadMemoryPath(squadId)
      return {
        hostPath,
        pvcSubPath: `memory/${squadId}`,
        files: () => listTree(hostPath, () => '0644'),
      }
    },
  },
  {
    name: 'squad-ssh',
    dest: { base: 'ssh', relPath: '' },
    mode: '0600',
    scope: 'squad',
    required: false,
    source: async ({ squadId }) => {
      // Squad-scoped only. `files()` re-materializes granted remote hosts
      // immediately before reading — cheap and idempotent — so an out-of-band
      // grant/revoke is reflected (mirrors file-sync's pushSquadSshFiles).
      if (!squadId) return null
      const hostPath = getSquadSshPath(squadId)
      return {
        hostPath,
        pvcSubPath: `ssh/${squadId}`,
        files: async () => {
          await materializeSquadRemoteHosts(squadId)
          return listTree(hostPath, sshFileMode)
        },
      }
    },
  },
]

/**
 * Resolve the manifest for a concrete sandbox: run each asset's `source`, drop
 * the ones that don't apply, preserve manifest order. `squadId` falls back to
 * the sandboxId prefix (mirrors `syncBoxFiles`' squadId derivation). Dests are
 * still logical — each transport resolves them against its own layout.
 *
 * `assets` is injectable for tests only; production callers use the default
 * `SANDBOX_ASSETS`.
 */
export async function resolveSandboxAssets(
  ctx: AssetContext,
  assets: SandboxAsset[] = SANDBOX_ASSETS
): Promise<Array<{ asset: SandboxAsset; source: AssetSource }>> {
  const resolvedCtx: AssetContext = {
    ...ctx,
    squadId: ctx.squadId ?? getSquadIdFromSandbox(ctx.sandboxId) ?? undefined,
  }
  const out: Array<{ asset: SandboxAsset; source: AssetSource }> = []
  for (const asset of assets) {
    const source = await asset.source(resolvedCtx)
    if (source) out.push({ asset, source })
  }
  return out
}
