/**
 * Core → box file sync + callback URL resolution.
 *
 * In the k8s runtime the shared PVC carries the per-box artifacts a sandbox
 * needs (materialized skills, the squad `.env`, the agent identity key, and a
 * read-only memory replica) into the pod via subPath mounts. A vm box has no
 * shared volume, so Core pushes those same artifacts over the box's own
 * sandbox-server `/write` endpoint AT ENSURE TIME. Pushing through the server
 * (rather than ssh/root) matters: the box's unix user must OWN the files, and
 * the server writes as that user. The `ficus` CLI is NOT pushed here: on vm it is
 * a MACHINE-level artifact (`/usr/local/bin/ficus` → `/opt/tau/cli/ficus.js`,
 * delivered + drift-updated by machine-artifact delivery), shared by every box
 * on the machine.
 *
 * ## `/write` contract (read from packages/sandbox-server/src/services/filesystem.ts)
 * `POST /write { path, content /* base64 *\/, createDirs?, mode? }`. Two consequences:
 *  1. **Binary-safe.** The server base64-DECODES `content` before writing, so
 *     raw bytes round-trip losslessly — no `/bash`-decode dance needed.
 *  2. **Mode-at-creation.** `mode` (octal string, e.g. "0600") makes the server
 *     CREATE the file with those bits. This closes a security window: without it a
 *     secret would land at the umask default (0644) and be readable by sibling box
 *     users (co-tenants on a shared VM with 0755 homes) until a follow-up chmod.
 *     We pass "0600" for the secret-bearing `.env` and identity key, so no
 *     `/bash` chmod is needed. VERSION COUPLING: the `mode`
 *     param is honored only by a sandbox server from this branch — Core and the
 *     server ship together, so we rely on it unconditionally (no legacy fallback).
 *
 * ## push order (deterministic)
 *   0. best-effort `rm -f ~/bin/tau` — an earlier revision pushed a per-box copy
 *      of the pre-ficus CLI there (`~/bin` precedes `/usr/local/bin` on the box
 *      PATH); removing it keeps that stale copy off the box PATH. Idempotent when absent
 *   1. materialized skills tree → `~/.tau/skills/<materializer layout>`
 *   2. squad `.env` → `~/workspace/.tau/.env`   (mode 0600; squad-scoped only)
 *   3. identity key → `~/.private/identity.pem`  (mode 0600; per-agent only)
 *   4. memory replica → `~/memory/<tree>`   (content only — read-only convention;
 *      SQUAD box only — the layout's canonical memory root on vm)
 *   5. squad ssh dir tree → `~/.ssh/<tree>` (key files mode 0600; `config`/
 *      `known_hosts`/`*.pub` mode 0644; `~/.ssh` dir 0700; squad-scoped only)
 * A failure once a secret push has started best-effort removes the partial
 * secret files of the FAILING asset (per-asset cleanup, see
 * {@link pushAssetFiles}) so a half-provisioned box never lingers with key
 * material — while a sibling asset that already pushed (and stamped) completely
 * is left intact. Each artifact is skipped cleanly when its reader yields
 * nothing for the role (a solo agent has no squad `.env`/memory/ssh; a shared
 * squad box has no per-agent identity key; a squad MEMBER box gets no memory
 * replica — squad memory lives only in the squad box, where the workspace
 * layout points), so the same function serves every box role.
 *
 * ## content-hash skip (per box, per asset)
 * Each asset is hashed over its resolved dest root plus the ordered
 * `(relPath, mode-as-pushed, bytes)` of every file; when the box row's
 * `syncedHashes[asset]` already matches, the whole asset's push is SKIPPED (no
 * `/write`, no `/bash`) — a multi-MB skills/memory tree is not re-pushed on
 * every ensure. Otherwise ALL the asset's files are pushed and THEN the hash is
 * stamped (all-or-nothing, mirroring machine-artifacts' `ensureArtifact`): a
 * failure mid-asset leaves no stamp, so the next ensure re-pushes that asset.
 * The stamp is a DB-side jsonb merge ({@link stampBoxSyncedHash}), independent
 * of the in-memory box snapshot's age. The `rm -f ~/bin/tau` shadow removal is
 * NOT an asset (one cheap idempotent bash call) and stays UNCONDITIONAL.
 *
 * ## squad ssh delivery (step 5) + on-demand refresh
 * The squad ssh dir (`services/squad/ssh.ts` `getSquadSshPath`) is where
 * `services/remote-hosts/materialize.ts` renders granted remote hosts as
 * `ficus_remote_<name>` key files + a managed `config` block (see the remote-hosts
 * design doc § Delivery). Step 5 re-runs `materializeSquadRemoteHosts(squadId)`
 * immediately before reading the dir — cheap (a handful of local fs read/writes)
 * and idempotent, so it's unconditional here rather than trusting that every
 * grant/revoke mutation elsewhere already re-materialized before this ensure
 * runs. The materialize runs FIRST and its OUTPUT feeds the content hash, so a
 * just-granted/-revoked host always re-pushes despite a matching prior stamp.
 * The same push logic (materialize → list → mkdir+chmod `~/.ssh` → write each
 * file with its mode) is shared with {@link pushSquadSshToBox}, the on-demand
 * refresh a running box's agent can trigger via
 * `POST /api/remote-hosts/squad/:squadId/sync` without a full re-ensure — the
 * on-demand path FORCES the push (never consults the stamp) and re-stamps.
 */

import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { readdir } from 'fs/promises'
import { join, relative } from 'path'
import { BashOutcomeUnknownError, type BashResponse, type SandboxClient } from '../client/http-client'
import { getSquadIdFromSandbox, type SandboxOptions } from '../types'
import { boxUnixUser } from '../../machines/box-manager'
import { machineTunnels } from '../../machines/tunnel-manager'
import {
  getMachineBox as getMachineBoxReal,
  stampBoxSyncedHash as stampBoxSyncedHashReal,
} from '../../machines/queries'
import type { Machine, MachineBox } from '../../machines/queries'
import { getSquadSshPath, RESERVED_REMOTE_HOST_KEY_PREFIXES } from '../../squad/ssh'
import { materializeSquadRemoteHosts as materializeSquadRemoteHostsReal } from '../../remote-hosts/materialize'
import { createLogger } from '../../../lib/infra/logger'
import {
  resolveSandboxAssets,
  SANDBOX_ASSETS,
  type AssetContext,
  type AssetDest,
  type AssetFile,
} from '../asset-manifest'

const log = createLogger('vm-file-sync')

// ---------------------------------------------------------------------------
// syncBoxFiles
// ---------------------------------------------------------------------------

/** Role of a box, mirroring `EnsureBoxOpts['role']` / pod-spec's `sandboxType`. */
type BoxRole = 'squad' | 'agent' | 'system-manager'

/** One artifact file: a path relative to its tree root plus its raw bytes. */
export interface ArtifactFile {
  relPath: string
  content: Uint8Array
}

/**
 * The box's `machine_boxes` row fields file-sync needs to skip unchanged assets:
 * the machine it lives on (the stamp's guard) and the per-asset content-hash map
 * ({@link machineBoxes.syncedHashes}). Threaded IN from the caller — the vm
 * manager already holds the row after `ensureBox` — so file-sync never does a
 * per-asset DB read. Null ⇒ nothing is skipped and nothing is stamped.
 */
export interface SyncBoxTarget {
  machineId: string
  syncedHashes: Record<string, unknown> | null
}

/** Readers for every pushed artifact, injectable for tests; each defaults to production. */
export interface SetupBashFence {
  before(invocationId: string, kind: string): Promise<void>
  after(invocationId: string): Promise<void>
}

export interface SyncBoxFilesDeps {
  bashFence?: SetupBashFence
  /** The box row (its machine + per-asset content-hash stamps) driving the
   *  skip-unchanged-asset optimization; null/absent ⇒ push everything, stamp
   *  nothing (legacy call shape). */
  box?: SyncBoxTarget | null
  /** Persist an asset's content hash after ALL its files pushed (DB-side jsonb
   *  merge). Defaults to queries.ts's `stampBoxSyncedHash`. */
  stampBoxSyncedHash?: (
    machineId: string,
    sandboxId: string,
    name: string,
    hash: string,
    files?: string[]
  ) => Promise<void>
  /** The box user's HOME (`/home/box_<hash>`). */
  boxHome?: (sandboxId: string) => string
  /** Materialized skill files for this sandbox (paths relative to the skills root). */
  listSkillFiles?: (sandboxId: string) => Promise<ArtifactFile[]>
  /** The squad's generated `.env` content (with rendered secrets), or null. */
  readSquadEnv?: (squadId: string) => string | null
  /** The agent's identity private key PEM, or null. */
  readIdentityPem?: (sandboxId: string) => string | null
  /** The squad's memory files (paths relative to the memory root). */
  listMemoryFiles?: (squadId: string) => Promise<ArtifactFile[]>
  /**
   * Re-materialize (idempotent) a squad's granted remote hosts into its ssh
   * dir immediately before {@link listSquadSshFiles} reads it. Defaults to
   * `remote-hosts/materialize.ts`'s `materializeSquadRemoteHosts`. Shared
   * with {@link pushSquadSshToBox}.
   */
  materializeSquadRemoteHosts?: (squadId: string) => Promise<void>
  /** The squad's `~/.ssh` material (keys, `config`, `known_hosts`), paths
   *  relative to the ssh dir root; empty when the squad has no ssh dir yet. */
  listSquadSshFiles?: (squadId: string) => Promise<ArtifactFile[]>
  /** Wraps one selected asset-mutation branch in setup progress. */
  trackSetupWork?: <T>(operation: () => Promise<T>) => Promise<T>
}

/**
 * Derive a box role from the sandboxId prefix. The prefix is authoritative —
 * mirrors manager.ts's resolveRole: honoring a caller's `opts.k8s.sandboxType`
 * here let two callers disagree about the same box's role (the runner path
 * hardcodes 'agent' for system_manager_ boxes) and diverge the asset set the
 * sync delivers from the role the manager provisioned.
 */
function resolveRole(sandboxId: string, _opts?: SandboxOptions): BoxRole {
  if (sandboxId.startsWith('squad_')) return 'squad'
  if (sandboxId.startsWith('system_manager_')) return 'system-manager'
  return 'agent'
}

function defaultBoxHome(sandboxId: string): string {
  return `/home/${boxUnixUser(sandboxId)}`
}

/** Walk a directory into a flat list of {relPath, bytes}; empty when it's missing. */
async function listTree(root: string): Promise<ArtifactFile[]> {
  const out: ArtifactFile[] = []
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
      else if (entry.isFile()) out.push({ relPath: relative(root, abs), content: readFileSync(abs) })
    }
  }
  await walk(root)
  return out
}

function defaultListSquadSshFiles(squadId: string): Promise<ArtifactFile[]> {
  return listTree(getSquadSshPath(squadId))
}

/** Single-quote a path for safe interpolation into a remote `chmod` command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function toBase64(content: string | Uint8Array): string {
  return (typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)).toString('base64')
}

/**
 * Push a file's bytes via `/write` (base64, always creating parent dirs). When
 * `mode` is given the server CREATES the file with those bits — no chmod window.
 */
async function pushFile(
  client: SandboxClient,
  path: string,
  content: string | Uint8Array,
  mode?: string
): Promise<void> {
  await client.write({ path, content: toBase64(content), createDirs: true, ...(mode ? { mode } : {}) })
}

/**
 * Run a `/bash` command to completion; reject on stream error or non-zero exit.
 *
 * A stream that ends WITHOUT ever delivering an exit code is treated as a
 * FAILURE (not success): the server sends an explicit exit code on every path
 * (including timeout/spawn-failure), so a missing code means the stream was
 * truncated or the server regressed. Defaulting the missing code to 0 could mask
 * a failure. See packages/sandbox-server/src/services/bash.ts.
 *
 * Exported for the vm manager's post-ensure box setup (git credential helper).
 */
export function stableSetupInvocationId(kind: string, command: string): string {
  return createHash('sha256').update(`vm-setup\0${kind}\0${command}`).digest('hex')
}

export async function runBash(
  client: SandboxClient,
  command: string,
  kind = 'file_sync',
  invocationId = stableSetupInvocationId(kind, command),
  fence?: SetupBashFence
): Promise<void> {
  await fence?.before(invocationId, kind)
  try {
    await new Promise<void>((resolve, reject) => {
      let exitCode: number | undefined
      let errText = ''
      const stream = client.bash({ command, invocationId })
      stream.on('data', (r: BashResponse) => {
        if (r.error) errText = r.error
        if (r.stderr) errText += Buffer.from(r.stderr, 'base64').toString()
        if (r.exitCode !== undefined) exitCode = r.exitCode
      })
      stream.on('error', reject)
      stream.on('end', () => {
        if (exitCode === undefined)
          reject(new Error(`Command ended without an exit code${errText ? `: ${errText.trim()}` : ''}`))
        else if (exitCode !== 0)
          reject(new Error(`Command failed (exit ${exitCode})${errText ? `: ${errText.trim()}` : ''}`))
        else resolve()
      })
    })
    await fence?.after(invocationId)
  } catch (error) {
    if (!(error instanceof BashOutcomeUnknownError)) await fence?.after(invocationId)
    throw error
  }
}

/** Best-effort remove a file on the box (used to purge a partial secret after a
 *  failed sync); swallows errors — the box may already be gone. */
async function bestEffortRemove(client: SandboxClient, path: string, fence?: SetupBashFence): Promise<void> {
  try {
    await runBash(client, `rm -f ${shellQuote(path)}`, 'file_sync', undefined, fence)
  } catch (error) {
    // An ambiguous Bash outcome carries a durable fence and must stop all later
    // effects; known failures remain best-effort.
    if (error instanceof BashOutcomeUnknownError) throw error
  }
}

/** Deterministic order regardless of readdir/reader ordering. */
function sortByRelPath<T extends { relPath: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
}

/** Mode for one squad-ssh artifact: `config`/`known_hosts`/`*.pub` are
 *  non-secret ssh metadata (0644); everything else is a private key (0600). */
function sshArtifactMode(relPath: string): string {
  if (relPath === 'config' || relPath === 'known_hosts' || relPath.endsWith('.pub')) return '0644'
  return '0600'
}

// ---------------------------------------------------------------------------
// Content-hash skip (mirrors the machine-artifacts drift pattern, per asset)
// ---------------------------------------------------------------------------

/** One file about to be pushed under an asset's dest root, with the octal mode
 *  it will be CREATED with (undefined ⇒ server umask default; tree assets like
 *  skills/memory push no mode). `relPath` is the full path suffix under the
 *  resolved dest root (for single-file assets it includes the dest's own
 *  relPath, e.g. `.tau/.env`). */
interface PushableFile {
  relPath: string
  bytes: Uint8Array
  mode?: string
}

/**
 * Content hash of one asset: sha256 over the resolved dest root plus the ordered
 * `(relPath, mode, bytes)` of every file AS PUSHED. `files` MUST already be
 * sorted ({@link sortByRelPath}) so the hash is independent of readdir/reader
 * ordering, and `mode` is the mode-as-pushed (undefined for tree assets) folded
 * in so a permission-only change still re-pushes. Every field is
 * length-delimited so no `(relPath, mode, content)` triple can alias another (a
 * NUL-in-content ambiguity a bare separator would allow). The dest root is
 * included so the SAME bytes landing at a different HOME re-push.
 */
function computeAssetHash(destRoot: string, files: PushableFile[]): string {
  const h = createHash('sha256')
  h.update(`root:${destRoot.length}:${destRoot}`)
  for (const f of files) {
    h.update(`\nf:${f.relPath.length}:${f.relPath}:${f.mode ?? ''}:${f.bytes.length}:`)
    h.update(Buffer.from(f.bytes))
  }
  return h.digest('hex')
}

/**
 * Push a flat list of files under `root` (`${root}/${relPath}`, each created
 * with its own `mode`). Self-contained secret cleanup SCOPED to this one asset:
 * on failure, best-effort remove whichever private-key files (mode 0600) it had
 * already started writing before rethrowing, so a half-pushed asset leaves no
 * readable key material — and a SIBLING asset that already pushed+stamped is
 * untouched (it is complete, not partial; removing a complete stamped secret
 * would skip-starve the next ensure). `config`/`known_hosts`/`*.pub` and
 * mode-less files are not secret and are not tracked for cleanup.
 */
async function pushAssetFiles(
  client: SandboxClient,
  root: string,
  files: PushableFile[],
  fence?: SetupBashFence
): Promise<void> {
  const writtenKeys: string[] = []
  try {
    for (const file of files) {
      const path = `${root}/${file.relPath}`
      if (file.mode === '0600') writtenKeys.push(path)
      await pushFile(client, path, file.bytes, file.mode)
    }
  } catch (err) {
    for (const path of writtenKeys) await bestEffortRemove(client, path, fence)
    throw err
  }
}

/**
 * Re-materialize (idempotent) a squad's granted remote hosts, then list its
 * `~/.ssh` material sorted, each tagged with its push mode. The materialize runs
 * FIRST and unconditionally so the returned files (and therefore the asset hash)
 * reflect a just-granted/-revoked host — the whole reason the ssh asset is
 * hashed on its post-materialize OUTPUT. Empty when the squad has no ssh dir yet.
 * The list phase of the historical `pushSquadSshFiles` helper; its push phase is
 * {@link writeSshFiles}. Split so {@link syncBoxFiles} can hash the listed
 * output BEFORE deciding to push (and so materialize+list runs exactly once).
 * Shared with {@link pushSquadSshToBox}.
 */
async function materializeAndListSshFiles(
  squadId: string,
  deps: Pick<SyncBoxFilesDeps, 'materializeSquadRemoteHosts' | 'listSquadSshFiles'>
): Promise<PushableFile[]> {
  await (deps.materializeSquadRemoteHosts ?? materializeSquadRemoteHostsReal)(squadId)
  const files = await (deps.listSquadSshFiles ?? defaultListSquadSshFiles)(squadId)
  return sortByRelPath(files).map((f) => ({ relPath: f.relPath, bytes: f.content, mode: sshArtifactMode(f.relPath) }))
}

/** Write a squad's `~/.ssh` material to a box: create the dir 0700, then push
 *  each (already sorted, mode-tagged) file with self-contained key cleanup.
 *  Shared by {@link syncBoxFiles}'s squad-ssh step and {@link pushSquadSshToBox}. */
async function writeSshFiles(
  client: SandboxClient,
  home: string,
  files: PushableFile[],
  fence?: SetupBashFence
): Promise<void> {
  const sshDir = `${home}/.ssh`
  await runBash(
    client,
    `mkdir -p ${shellQuote(sshDir)} && chmod 700 ${shellQuote(sshDir)}`,
    'file_sync',
    undefined,
    fence
  )
  await pushAssetFiles(client, sshDir, files, fence)
}

/**
 * Resolve an {@link AssetDest} anchor to its box-native absolute directory.
 * These are the box's literal layout paths the push list has always used — the
 * manifest keeps them logical so k8s/docker can anchor them differently. `ssh`
 * and `home` are here for completeness; the vm transport reaches ssh through
 * {@link materializeAndListSshFiles}/{@link writeSshFiles} (which own the
 * `~/.ssh` mkdir/chmod + key cleanup) and never anchors a `home` asset today.
 */
function resolveBoxDest(home: string, base: AssetDest['base']): string {
  switch (base) {
    case 'skills':
      return `${home}/.tau/skills`
    case 'workspace':
      return `${home}/workspace`
    case 'private':
      return `${home}/.private`
    case 'memory':
      return `${home}/memory`
    case 'ssh':
      return `${home}/.ssh`
    case 'home':
      return home
  }
}

/**
 * Bridge the test-injectable {@link SyncBoxFilesDeps} readers onto a manifest
 * asset's `files()`. Returns an override reader when a matching dep is provided
 * (tests), or `undefined` to keep the manifest's own materializer-backed source
 * (production). The bytes/paths/modes an override yields are byte-identical to
 * what the manifest source would have produced. `squad-ssh` is intentionally
 * absent — its push runs through {@link materializeAndListSshFiles}, so its
 * manifest `files()` is never read here (avoiding a double re-materialize).
 *
 * `ctx.squadId` is the resolved squad id; it is defined whenever a squad-scoped
 * asset's source returned non-null (the manifest dropped it otherwise).
 */
function bridgeAssetFiles(
  assetName: string,
  ctx: AssetContext,
  deps: SyncBoxFilesDeps
): (() => Promise<AssetFile[]>) | undefined {
  switch (assetName) {
    case 'skills': {
      const read = deps.listSkillFiles
      if (!read) return undefined
      return async () =>
        (await read(ctx.sandboxId)).map((f) => ({ relPath: f.relPath, bytes: f.content, mode: '0644' }))
    }
    case 'squad-env': {
      const read = deps.readSquadEnv
      if (!read) return undefined
      return async () => {
        const content = read(ctx.squadId!)
        return content === null ? [] : [{ relPath: '', bytes: Buffer.from(content, 'utf8'), mode: '0600' }]
      }
    }
    case 'identity': {
      const read = deps.readIdentityPem
      if (!read) return undefined
      return async () => {
        const pem = read(ctx.sandboxId)
        return pem === null ? [] : [{ relPath: '', bytes: Buffer.from(pem, 'utf8'), mode: '0600' }]
      }
    }
    case 'memory': {
      const read = deps.listMemoryFiles
      if (!read) return undefined
      return async () => (await read(ctx.squadId!)).map((f) => ({ relPath: f.relPath, bytes: f.content, mode: '0644' }))
    }
    default:
      return undefined
  }
}

/**
 * Push the k8s-PVC-equivalent artifacts into a box over its `/write` endpoint.
 * Called at ensure time once the box's {@link SandboxClient} is reachable.
 *
 * Driven by the shared per-sandbox {@link SANDBOX_ASSETS} manifest: the push
 * ORDER, the per-role SCOPE (which assets apply), and each asset's DEST are the
 * manifest's, so adding a per-sandbox asset is a one-line manifest change this
 * transport picks up. The manifest order is secrets-last, and each asset owns
 * its all-or-nothing push + partial-secret cleanup ({@link pushAssetFiles}), so
 * a mid-push failure best-effort removes the failing asset's own secret files
 * (a half-provisioned box never lingers with readable key material) while
 * complete sibling assets stay intact. First-push order/paths/modes are
 * byte-for-byte identical to the previous hardcoded push list — see the
 * golden-master test.
 *
 * Each asset is skipped entirely when the box row's stamped content hash
 * matches (see the module header's content-hash-skip section); an ABSENT asset
 * (its `files()` yields nothing) is skipped cleanly and NEVER stamped, so its
 * later appearance always pushes. With no `deps.box` threaded (legacy call
 * shape) everything pushes and nothing stamps.
 */
interface SyncedAssetState {
  hash: string
  files?: string[]
}

function parseSyncedAssetState(value: unknown): SyncedAssetState | null {
  if (typeof value === 'string') return { hash: value }
  if (!value || typeof value !== 'object') return null
  const candidate = value as { hash?: unknown; files?: unknown }
  if (typeof candidate.hash !== 'string' || !Array.isArray(candidate.files)) return null
  const files = candidate.files.filter((path): path is string => typeof path === 'string')
  return files.length === candidate.files.length ? { hash: candidate.hash, files } : null
}

function validatedManagedPath(root: string, relPath: string): string {
  if (!relPath || relPath.startsWith('/') || relPath.includes('\\')) throw new Error('invalid managed asset path')
  const segments = relPath.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    throw new Error('invalid managed asset path')
  return `${root}/${relPath}`
}

/**
 * Clears a box's squad ssh dir that was stamped before per-file manifests: every
 * materialized remote-host key file, plus the managed `config`. Uploaded keys and `known_hosts` are untouched.
 */
function legacySquadSshCleanupCommand(root: string): string {
  const names = RESERVED_REMOTE_HOST_KEY_PREFIXES.map((prefix) => `-name ${shellQuote(`${prefix}*`)}`).join(' -o ')
  return `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -maxdepth 1 -type f \\( ${names} \\) -delete && rm -f -- ${shellQuote(`${root}/config`)}; fi`
}

async function removeManagedFiles(
  client: SandboxClient,
  root: string,
  relPaths: string[],
  fence?: SetupBashFence
): Promise<void> {
  if (!relPaths.length) return
  const paths = [...new Set(relPaths)].sort().map((relPath) => shellQuote(validatedManagedPath(root, relPath)))
  await runBash(client, `rm -f -- ${paths.join(' ')}`, 'asset_prune', undefined, fence)
}

export async function syncBoxFiles(
  client: SandboxClient,
  sandboxId: string,
  opts: SandboxOptions,
  deps: SyncBoxFilesDeps = {}
): Promise<void> {
  const home = (deps.boxHome ?? defaultBoxHome)(sandboxId)
  const role = resolveRole(sandboxId, opts)
  const squadId = opts.squadId ?? getSquadIdFromSandbox(sandboxId) ?? undefined
  const box = deps.box ?? null
  const stamp = deps.stampBoxSyncedHash ?? stampBoxSyncedHashReal

  const clearLegacyTree = async (name: string, root: string): Promise<void> => {
    if (name === 'squad-ssh') {
      await runBash(client, legacySquadSshCleanupCommand(root), 'asset_prune', undefined, deps.bashFence)
    } else if (name === 'skills' || name === 'memory') {
      await runBash(client, `find ${shellQuote(root)} -mindepth 1 -delete`, 'asset_prune', undefined, deps.bashFence)
    }
  }

  // Sync ONE asset: skip when its hash already matches the box's stamp, else
  // push every file (via `push`) and stamp the new hash. `push` owns any
  // per-asset secret cleanup on its own failure (so a mid-asset throw never
  // stamps, and the next ensure re-pushes just that asset). Assets with no
  // files are handled by the caller (skipped entirely, never stamped).
  const syncAsset = async (
    name: string,
    destRoot: string,
    files: PushableFile[],
    push: () => Promise<void>,
    legacyFilesWhenEmpty: string[] = [],
    clearLegacy?: () => Promise<void>
  ) => {
    const hash = computeAssetHash(destRoot, files)
    const previous = parseSyncedAssetState(box?.syncedHashes?.[name])
    const currentFiles = files.map((file) => file.relPath).sort()
    if (previous?.hash === hash) {
      // Upgrade legacy hash-only stamps while the source is still present, so
      // a later revoke has an exact bounded deletion manifest.
      if (box && !previous.files) await stamp(box.machineId, sandboxId, name, hash, currentFiles)
      return
    }
    if (files.length === 0 && !previous) return
    // Validate source paths before any write/delete so a malformed materializer
    // cannot escape the declared managed destination.
    currentFiles.forEach((relPath) => validatedManagedPath(destRoot, relPath))
    const mutate = async () => {
      if (previous && !previous.files && clearLegacy) await clearLegacy()
      if (files.length) await push()
      const current = new Set(currentFiles)
      await removeManagedFiles(
        client,
        destRoot,
        (previous?.files ?? (previous ? legacyFilesWhenEmpty : [])).filter((path) => !current.has(path)),
        deps.bashFence
      )
      if (box) await stamp(box.machineId, sandboxId, name, hash, currentFiles)
    }
    await (deps.trackSetupWork ? deps.trackSetupWork(mutate) : mutate())
  }

  // 0. Best-effort remove the legacy per-box CLI at ~/bin/tau. The CLI is now a
  //    machine-level artifact (/usr/local/bin/ficus); a stale per-box copy from an
  //    earlier revision (~/bin precedes /usr/local/bin on the box PATH) would be a
  //    second, outdated CLI. `rm -f` is idempotent when the file is absent,
  //    and a removal failure never fails the sync. Not an asset — unconditional.
  await bestEffortRemove(client, `${home}/bin/tau`, deps.bashFence)

  // Resolve the applicable assets for this box (manifest order, scope-filtered).
  // `squadId` matches the manifest's own derivation, so passing opts.squadId
  // through yields the same resolved id inside each source.
  const ctx: AssetContext = { sandboxId, squadId, role }
  const assets = SANDBOX_ASSETS.map((asset) => ({
    ...asset,
    source: async (assetCtx: AssetContext) => {
      const source = await asset.source(assetCtx)
      if (!source) return null
      const override = bridgeAssetFiles(asset.name, assetCtx, deps)
      return override ? { ...source, files: override } : source
    },
  }))
  const resolved = await resolveSandboxAssets(ctx, assets)
  const resolvedNames = new Set(resolved.map(({ asset }) => asset.name))

  for (const { asset, source } of resolved) {
    // The squad ssh dir is delivered by {@link materializeAndListSshFiles} +
    // {@link writeSshFiles} (shared with the on-demand refresh): they own the
    // re-materialize, the `~/.ssh` mkdir/chmod 0700, the per-file mode split,
    // and the private-key cleanup. The materialize+list runs exactly ONCE, its
    // output feeds the hash, and only a stamp miss runs the write phase. Route
    // it there rather than through the generic file loop (also avoiding a
    // double re-materialize via the manifest source's own files()).
    if (asset.name === 'squad-ssh') {
      const sshFiles = await materializeAndListSshFiles(squadId!, deps)
      const root = `${home}/.ssh`
      await syncAsset(
        asset.name,
        root,
        sshFiles,
        () => writeSshFiles(client, home, sshFiles, deps.bashFence),
        [],
        () => clearLegacyTree(asset.name, root)
      )
      continue
    }

    const baseDir = resolveBoxDest(home, asset.dest.base)
    // Single-file assets (dest.relPath names the file, e.g. `.tau/.env`) carry
    // an explicit creation mode — the secrets. Directory-tree assets
    // (dest.relPath === '') are content-only and push at the umask default; the
    // mode-as-pushed (undefined for trees) is also what the hash folds in.
    const isSingleFile = asset.dest.relPath !== ''
    const files: PushableFile[] = sortByRelPath(await source.files()).map((f) => ({
      relPath: [asset.dest.relPath, f.relPath].filter((seg) => seg.length > 0).join('/'),
      bytes: f.bytes,
      mode: isSingleFile ? f.mode : undefined,
    }))
    await syncAsset(
      asset.name,
      baseDir,
      files,
      () => pushAssetFiles(client, baseDir, files, deps.bashFence),
      isSingleFile ? [asset.dest.relPath] : [],
      !isSingleFile ? () => clearLegacyTree(asset.name, baseDir) : undefined
    )
  }

  if (box) {
    for (const asset of SANDBOX_ASSETS) {
      if (resolvedNames.has(asset.name) || box.syncedHashes?.[asset.name] === undefined) continue
      const root = asset.name === 'squad-ssh' ? `${home}/.ssh` : resolveBoxDest(home, asset.dest.base)
      await syncAsset(
        asset.name,
        root,
        [],
        async () => {},
        asset.dest.relPath ? [asset.dest.relPath] : [],
        () => clearLegacyTree(asset.name, root)
      )
    }
  }
}

// ---------------------------------------------------------------------------
// pushSquadSshToBox — on-demand refresh (no re-ensure)
// ---------------------------------------------------------------------------

/** Injectable seams for {@link pushSquadSshToBox}; each defaults to production. */
export interface PushSquadSshToBoxDeps {
  /** The box's `machine_boxes` row, or null when this sandboxId has none (the
   *  docker/k8s runtimes never write one — that table is vm-only — and a vm
   *  box that was never ensured has none either). */
  getMachineBox?: (sandboxId: string) => Promise<MachineBox | null>
  /** A live {@link SandboxClient} for an already-ensured box, or null if this
   *  Core process isn't currently tracking one (e.g. it restarted since the
   *  box was last ensured). Defaults to the vm sandbox manager's tracked
   *  client (`getClientForSandbox`). */
  getClient?: (sandboxId: string) => Promise<SandboxClient | null>
  /** The box user's HOME (`/home/box_<hash>`). */
  boxHome?: (sandboxId: string) => string
  bashFence?: SetupBashFence
  materializeSquadRemoteHosts?: (squadId: string) => Promise<void>
  listSquadSshFiles?: (squadId: string) => Promise<ArtifactFile[]>
  /** Re-stamp the squad-ssh content hash after a forced push. Defaults to
   *  queries.ts's `stampBoxSyncedHash`. */
  stampBoxSyncedHash?: (
    machineId: string,
    sandboxId: string,
    name: string,
    hash: string,
    files?: string[]
  ) => Promise<void>
}

/**
 * Lazily resolve a client for `sandboxId`, preferring the vm manager's
 * `getOrAttachClient`: the api and worker processes each hold their own
 * in-memory client map, so the tracked-only lookup misses (and this module
 * would report a healthy box "unreachable") for any box the OTHER process
 * ensured — attach-on-miss reads the ready `machine_boxes` row and tunnels in
 * instead. Dynamic import avoids a hard cycle: `factory.ts` → `vm/manager.ts` →
 * `file-sync.ts` (this module) already runs at module-load time, so a static
 * import back to `factory.ts` here would loop. Reached only in production —
 * tests inject `getClient` directly.
 */
async function defaultGetClient(sandboxId: string): Promise<SandboxClient | null> {
  const { getSandboxManager } = await import('../factory')
  const manager = getSandboxManager() as unknown as {
    getOrAttachClient?: (id: string) => Promise<SandboxClient | null>
    getClientForSandbox?: (id: string) => SandboxClient | null
  }
  if (manager.getOrAttachClient) return manager.getOrAttachClient(sandboxId)
  return manager.getClientForSandbox?.(sandboxId) ?? null
}

/**
 * On-demand refresh: re-push a squad's `~/.ssh` material to ONE already-
 * ensured box — the calling agent's own — without a full re-ensure. Backs
 * `POST /api/remote-hosts/squad/:squadId/sync` (design doc § Delivery), so a
 * long-lived vm box picks up a newly granted host or a newly uploaded key
 * right away.
 *
 * The `machine_boxes` row IS the vm-runtime check: docker/k8s sandboxes are
 * reached over a live mount (materialized changes just appear), so they have
 * no row and nothing to push here — reported as `live-mount`, not an error. The
 * client lookup attaches on-miss (see {@link defaultGetClient}), so a box the
 * WORKER ensured is still reachable from the api serving this sync; only a box
 * with no ready row/machine (parked, mid-provision, machine down) resolves no
 * client. That is a normal, recoverable state — the next warmup/ensure
 * re-establishes it — so it is reported as `box-unreachable` rather than thrown.
 */
export async function pushSquadSshToBox(
  squadId: string,
  sandboxId: string,
  deps: PushSquadSshToBoxDeps = {}
): Promise<{ pushed: boolean; reason?: string }> {
  const box = await (deps.getMachineBox ?? getMachineBoxReal)(sandboxId)
  if (!box) return { pushed: false, reason: 'live-mount' }

  const client = await (deps.getClient ?? defaultGetClient)(sandboxId)
  if (!client) return { pushed: false, reason: 'box-unreachable' }

  const home = (deps.boxHome ?? defaultBoxHome)(sandboxId)
  const files = await materializeAndListSshFiles(squadId, deps)
  const root = `${home}/.ssh`
  const previous = parseSyncedAssetState(box.syncedHashes?.['squad-ssh'])
  const currentFiles = files.map((file) => file.relPath).sort()
  // Reject malformed materializer paths before mkdir or any /write effect.
  currentFiles.forEach((relPath) => validatedManagedPath(root, relPath))
  if (previous && !previous.files) {
    await runBash(client, legacySquadSshCleanupCommand(root), 'asset_prune', undefined, deps.bashFence)
  }
  if (files.length) await writeSshFiles(client, home, files, deps.bashFence)
  const current = new Set(currentFiles)
  await removeManagedFiles(
    client,
    root,
    (previous?.files ?? []).filter((path) => !current.has(path))
  )
  if (files.length || previous) {
    const stamp = deps.stampBoxSyncedHash ?? stampBoxSyncedHashReal
    await stamp(box.machineId, sandboxId, 'squad-ssh', computeAssetHash(root, files), currentFiles)
  }
  return { pushed: true }
}

// ---------------------------------------------------------------------------
// resolveBoxApiUrl — the box's callback URL (BoxEnv.FICUS_API_URL)
// ---------------------------------------------------------------------------

/** Injectable seams for {@link resolveBoxApiUrl}; each defaults to production. */
export interface ResolveBoxApiUrlDeps {
  getAppUrl?: () => string | undefined
  /** Core's HTTP port (the reverse tunnel's local target). */
  getCorePort?: () => number
  tunnels?: {
    addReverse: (machine: Machine, localPort: number) => Promise<number>
    ensureReverseDetailed?: (
      machine: Machine,
      localPort: number
    ) => Promise<{ remotePort: number; binding: 'reused' | 'bound'; allocation: 'pinned' | 'dynamic' }>
  }
  /** Pause before the single addReverse retry (default: real setTimeout); injected so tests don't sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Sink for the degraded-fallback warning (default: this module's logger). */
  warn?: (message: string) => void
}

/**
 * Whether `url` is a syntactically valid `http:`/`https:` URL — the sanity
 * check on {@link resolveBoxApiUrl}'s degraded direct-`APP_URL` fallback.
 *
 * Deliberately NOT a reachability guess. A predecessor (`isPubliclyReachable`)
 * inferred box-side reachability from the hostname shape (non-loopback ⇒
 * reachable) and used it to PREFER a direct APP_URL over the reverse tunnel —
 * a footgun: a public-LOOKING but gated/unreachable host (e.g. a login-gated
 * proxy) made boxes fail their callbacks silently. Reachability cannot be
 * derived from URL text, so no such judgment is attempted here.
 */
export function isValidHttpUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

function defaultCorePort(): number {
  const p = Number(process.env.PORT)
  return Number.isInteger(p) && p > 0 ? p : 3000
}

/**
 * The URL a box should call Core back on (baked into `BoxEnv.FICUS_API_URL`).
 *
 * The SSH **reverse tunnel is the DEFAULT** path: allocate one
 * (`machineTunnels.addReverse(machine, corePort)` → the box's sshd picks a
 * remote port that forwards back to Core) and return
 * `http://127.0.0.1:<remotePort>`, which the box resolves to that listener.
 * The tunnel rides the SAME SSH connection Core already uses to reach the box,
 * so it works whenever the box is reachable at all — immune to the box's
 * egress/firewall/NAT and to hosts that merely LOOK public (a gated proxy in
 * front of APP_URL 401s box callbacks silently). And a machine that disallows
 * TCP forwarding can't host tunnel-reached boxes at all (Core's `-L` forward to
 * the box's server needs forwarding too), so a functioning VM box's machine
 * always supports the reverse tunnel.
 *
 * A direct `APP_URL` is only the DEGRADED FALLBACK when establishing the
 * reverse tunnel fails; {@link isValidHttpUrl} is a mere validity check on it,
 * never a reachability guess. No usable fallback either ⇒ throw, naming both
 * failures.
 *
 * ## why retry once before degrading
 * `addReverse` throws not only for "forwarding administratively disabled" but
 * also for TRANSIENT conditions (nonzero `ssh -O forward` exit under
 * MaxSessions/port pressure, remote-port parse hiccup) under which the rest of
 * the ensure can still succeed. On a gated-proxy deployment a single transient
 * hiccup would otherwise silently bake the gated `APP_URL` — every box
 * callback 401s and the healthy fast-path never re-bakes it. So: one retry
 * (addReverse is idempotent, so retrying after a partial success is safe), and
 * if the fallback IS taken, warn loudly so an operator sees the degradation.
 */
const ADD_REVERSE_RETRY_DELAY_MS = 250

export type BoxApiTransportResult =
  | { url: string; reverse: 'reused' | 'bound'; allocation: 'pinned' | 'dynamic' }
  | { url: string; reverse: 'lost'; allocation: 'direct_fallback' }

export async function resolveBoxApiTransport(
  machine: Machine,
  deps: ResolveBoxApiUrlDeps = {}
): Promise<BoxApiTransportResult> {
  const getAppUrl = deps.getAppUrl ?? (() => process.env.APP_URL)
  const getCorePort = deps.getCorePort ?? defaultCorePort
  const tunnels = deps.tunnels ?? machineTunnels
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const warn = deps.warn ?? ((message: string) => log.warn(message))
  const bind = async (): Promise<BoxApiTransportResult> => {
    if (tunnels.ensureReverseDetailed) {
      const result = await tunnels.ensureReverseDetailed(machine, getCorePort())
      return { url: `http://127.0.0.1:${result.remotePort}`, reverse: result.binding, allocation: result.allocation }
    }
    const remotePort = await tunnels.addReverse(machine, getCorePort())
    return { url: `http://127.0.0.1:${remotePort}`, reverse: 'bound', allocation: 'pinned' }
  }
  try {
    return await bind()
  } catch {
    /* one bounded retry below */
  }
  try {
    await sleep(ADD_REVERSE_RETRY_DELAY_MS)
    return await bind()
  } catch {
    /* safe degraded fallback below */
  }
  const appUrl = getAppUrl()
  if (appUrl && isValidHttpUrl(appUrl)) {
    warn('reverse tunnel failed twice; using degraded direct callback fallback')
    return { url: appUrl, reverse: 'lost', allocation: 'direct_fallback' }
  }
  throw new Error('cannot resolve a core callback URL after bounded reverse-tunnel recovery')
}

export async function resolveBoxApiUrl(machine: Machine, deps: ResolveBoxApiUrlDeps = {}): Promise<string> {
  return (await resolveBoxApiTransport(machine, deps)).url
}
