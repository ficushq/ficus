/**
 * Sandbox Manager
 *
 * Manages Docker container sandboxes for agent execution.
 * Each sandbox is identified by an opaque ID (taskId today, squadId in the future).
 * Containers are long-lived — shared between agent bash tools and terminal sessions.
 *
 * Supports two container runtimes for Docker-in-Docker, chosen EXPLICITLY by
 * FICUS_SANDBOX_RUNTIME (there is no default and no auto-detection):
 * - docker-sysbox: Secure, unprivileged DinD via sysbox-runc (Linux only)
 * - docker-socket: Docker socket mounting (macOS, Windows, Linux)
 */

import { spawn as ptySpawn, type IPty } from 'bun-pty'
import { randomBytes } from 'node:crypto'
import * as fs from 'fs'
import * as path from 'path'
import { MONOREPO_ROOT } from '../../../lib/paths'
import { createLogger } from '../../../lib/infra/logger'
import { getHomeDir } from '../../../lib/utils/home'
import { getSquadIdFromSandbox } from '../types'
import type { ISandboxManager, ManagedToolchainRequest, SandboxOptions, SandboxRuntime } from '../types'
import { requireSandboxRuntime } from '../runtime'
import { buildBashrcContent } from '../bashrc'
import { WORKSPACE_DOT_DIR, workspaceDotPath } from '../../workspace/dot-dir'
import { ToolchainAdapterError } from '../toolchain/provision'
import {
  containerWorkspaceLayout,
  containerWorkRoot,
  type WorkspaceLayout,
  type WorkspaceLayoutContext,
} from '../workspace-layout'
import { gitIdentityEnv, resolveGitHubIdentity } from '../github-identity'
import { terminationIntentRegistry } from '../death/intent-registry'
import { beginSandboxSetupWork, trackSandboxSetupWork, type SandboxSetupWorkReason } from '../setup-progress'
import {
  dockerExecIdentityForSet,
  DOCKER_EXEC_IDENTITY_NEW,
  identitySetForLabels,
  readSandboxLabel,
  SANDBOX_IDENTITY_WRITE,
  sandboxContainerNames,
  type DockerExecIdentity,
  type SandboxIdentitySet,
} from '../identity-names'
import { parseDockerImageContract, type DockerImageContract } from './runtime-contract'
import { DockerSandboxLifecycleError } from './errors'
import { classifyDockerContainerOwnership, classifyDockerInspectStatus } from './lifecycle-contract'
import {
  activeDriftError,
  cleanupFailedInitialization,
  cleanupTrackedSandboxes,
  dockerExecWithStdinArgs,
  immutableLifecycleTarget,
  releaseTrackedState,
  runDestructiveLifecycle,
  runWithPrimaryCleanup,
} from './lifecycle-runtime'
export { classifyDockerContainerOwnership, classifyDockerInspectStatus, SPEC_HASH_LABEL } from './lifecycle-contract'
import { SandboxClient } from '../client/http-client'
import {
  LEGACY_DOCKER_COMMAND_IDENTITY_CONTRACT,
  parseDockerCommandIdentity,
  resolveDockerCommandIdentity,
} from './command-identity'
import { computeDockerSpecDigest, validateDockerHealthContract } from './runtime-contract'

// Re-export types for backwards compatibility
export type { SandboxOptions, SandboxRuntime } from '../types'

const log = createLogger('sandbox')

/** Append `-e KEY=value` pairs for a container env (undefined values are skipped). */
function pushEnvArgs(args: string[], env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) if (value !== undefined) args.push('-e', `${key}=${value}`)
}

/** The interactive terminal's `docker exec` env flags: the live Core URL. */
export function terminalApiUrlArgs(apiUrl: string): string {
  const args: string[] = []
  pushEnvArgs(args, { FICUS_API_URL: apiUrl })
  return args.join(' ')
}

/**
 * `docker exec` args for running as a container's sandbox user, from its OWN
 * resolved {@link DockerExecIdentity} — pure, so callers that already resolved
 * the identity (e.g. to also build an `addgroup`/`adduser` fallback) need only
 * one `docker inspect` round trip, not one per use.
 */
export function buildSandboxUserArgs(identity: DockerExecIdentity): string[] {
  return [
    '--user',
    identity.user,
    '-e',
    `HOME=${identity.home}`,
    '-e',
    `USER=${identity.user}`,
    '-e',
    `LOGNAME=${identity.user}`,
    '-e',
    `DOCKER_HOST=unix://${identity.dockerProxySocketPath}`,
  ]
}

const SANDBOX_IMAGE = process.env.FICUS_SANDBOX_IMAGE || 'ficus-sandbox:latest'
const DOCKER_SANDBOX_MEMORY_LIMIT = '2g'
// Chromium (the in-container ficus-browser service, dev parity with VM machines)
// needs far more shared memory than Docker's 64 MB /dev/shm default. A create
// arg, so it folds into computeDockerSpecHash → existing containers without it
// drift-recreate.
export const DOCKER_SANDBOX_SHM_SIZE = '512m'
/** The prefix new containers are named with; lookups also try every read prefix ({@link sandboxContainerNames}). */
export const CONTAINER_PREFIX = SANDBOX_IDENTITY_WRITE.containerPrefix

/**
 * The `--label` args a new sandbox container is created with: the write identity
 * set only (the spec hash, managed flag, sandbox id, image id and, when given,
 * the lifecycle generation).
 */
export function sandboxContainerLabelArgs(input: {
  sandboxId: string
  specHash: string
  imageId: string
  lifecycleGeneration?: string | null
}): string[] {
  const set = SANDBOX_IDENTITY_WRITE
  return [
    // Stamp the create-time spec hash so ensure can detect mount drift on a
    // later run (see computeDockerSpecHash) — stamp and check are one function.
    '--label',
    `${set.specHashLabel}=${input.specHash}`,
    '--label',
    `${set.managedLabel}=true`,
    '--label',
    `${set.sandboxIdLabel}=${input.sandboxId}`,
    '--label',
    `${set.imageIdLabel}=${input.imageId}`,
    ...(input.lifecycleGeneration ? ['--label', `${set.lifecycleGenerationLabel}=${input.lifecycleGeneration}`] : []),
  ]
}

/**
 * Ids of the containers that exist for a sandbox under any identity prefix, the
 * write name first. Normally at most one: a release creates under the write name
 * only after this finds (and adopts or removes) the others.
 */
function findSandboxContainers(sandboxId: string, lookup: (name: string) => string | null): string[] {
  const ids: string[] = []
  for (const name of sandboxContainerNames(sandboxId)) {
    const id = lookup(name)
    if (id && !ids.includes(id)) ids.push(id)
  }
  if (ids.length > 1)
    log.warn(`Sandbox ${sandboxId} has containers under more than one identity prefix: ${ids.join(', ')}`)
  return ids
}

/** The existing container for a sandbox under any identity prefix, the write name first; null when none. */
function findSandboxContainer(sandboxId: string, lookup: (name: string) => string | null): string | null {
  return findSandboxContainers(sandboxId, lookup)[0] ?? null
}

export function buildManagedToolchainDirPrefix(workRoot: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`
  const containerDir = `${workRoot}/${WORKSPACE_DOT_DIR}/toolchain`
  return `set -e; test ! -L ${quote(`${workRoot}/${WORKSPACE_DOT_DIR}`)}; test ! -L ${quote(containerDir)}; mkdir -p -- ${quote(containerDir)}; cd -P -- ${quote(containerDir)}; test "$(pwd -P)" = ${quote(containerDir)}; `
}

export async function waitForDockerExec(
  proc: { exited: Promise<number>; kill(): void },
  timeoutMs: number
): Promise<{ exitCode: number; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ exitCode: number; timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      proc.kill()
      resolve({ exitCode: 124, timedOut: true })
    }, timeoutMs)
  })
  const exited = proc.exited.then((exitCode) => ({ exitCode, timedOut: false as const }))
  const result = await Promise.race([exited, timeout])
  if (timer) clearTimeout(timer)
  if (result.timedOut) await proc.exited.catch(() => {})
  return result
}

/**
 * Extract the squad ID from a sandbox ID.
 * Sandbox IDs for squads are formatted as 'squad_<uuid>'.
 * Returns null if not a squad sandbox.
 */

interface SandboxState {
  containerId: string
  workspacePath: string
  sandboxId: string
  runtime: SandboxRuntime
  workspaceMount: string
  memoryMount?: string
  squadId?: string
  privateVolumePath?: string
  lifecycleGeneration?: string
  client?: SandboxClient
}

// --- Nix Store ---

/** Get the nix store directory path for a sandbox */
/**
 * Merge new packages from a default devbox.json template into an existing workspace devbox.json.
 * Only adds packages not already present (by name, ignoring version).
 */
function mergeDevboxPackages(workspacePath: string, templatePath: string): void {
  try {
    const workspace = JSON.parse(fs.readFileSync(workspacePath, 'utf-8'))
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'))
    if (!Array.isArray(workspace.packages) || !Array.isArray(template.packages)) return

    const existingNames = new Set(workspace.packages.map((p: string) => p.split('@')[0]))
    const newPackages = template.packages.filter((p: string) => !existingNames.has(p.split('@')[0]))

    if (newPackages.length > 0) {
      workspace.packages.push(...newPackages)
      fs.writeFileSync(workspacePath, JSON.stringify(workspace, null, 2) + '\n')
      log.info(`Merged ${newPackages.length} new package(s) into devbox.json: ${newPackages.join(', ')}`)
    }
  } catch {
    // Non-fatal — don't break sandbox startup over devbox.json merge
  }
}

function getNixStorePath(sandboxId: string): string {
  return path.join(getHomeDir(), 'nix', sandboxId)
}

const PERSONAL_AGENT_SANDBOX_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Resolve a personal agent's Nix store, rejecting all shared or malformed sandbox IDs. */
export function resolveReclaimableNixStorePath(sandboxId: string): string {
  if (!PERSONAL_AGENT_SANDBOX_ID.test(sandboxId)) {
    throw new Error(`Refusing to reclaim non-personal sandbox storage: ${sandboxId}`)
  }
  const root = path.resolve(getHomeDir(), 'nix')
  const candidate = path.resolve(root, sandboxId)
  if (path.dirname(candidate) !== root) throw new Error('Nix store path escaped the Nix root')
  return candidate
}

type DockerCommandResult = { exitCode: number; stdout: Buffer; stderr: Buffer }
type DockerCommand = (args: string[]) => DockerCommandResult

/** Reclaim a terminated personal agent's Nix store using an exact-path root helper. */
export function reclaimAgentNixStore(sandboxId: string, deps: { spawnSync?: DockerCommand } = {}): void {
  const nixPath = resolveReclaimableNixStorePath(sandboxId)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(nixPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing to reclaim symlinked Nix store: ${nixPath}`)
  if (!stat.isDirectory()) throw new Error(`Refusing to reclaim non-directory Nix store: ${nixPath}`)

  const spawnSync = deps.spawnSync ?? ((args) => Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' }))
  // The store backs the container under whichever identity prefix it carries.
  for (const containerName of sandboxContainerNames(sandboxId)) {
    const inspect = spawnSync(['docker', 'inspect', '-f', '{{.State.Running}}', containerName])
    const inspectStderr = inspect.stderr.toString()
    if (inspect.exitCode === 0) {
      if (inspect.stdout.toString().trim() === 'true') {
        throw new Error(`Refusing to reclaim Nix store while container is running: ${containerName}`)
      }
      if (inspect.stdout.toString().trim() !== 'false') {
        throw new Error(`Refusing to reclaim Nix store because container state is unknown: ${containerName}`)
      }
    } else if (!/no such (object|container)/i.test(inspectStderr)) {
      throw new Error(`Refusing to reclaim Nix store because container state is unknown: ${inspectStderr}`)
    }
  }

  const helper = spawnSync([
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    '/bin/sh',
    '--user',
    '0',
    '-v',
    `${nixPath}:/target`,
    SANDBOX_IMAGE,
    '-c',
    'find /target -mindepth 1 -delete',
  ])
  if (helper.exitCode !== 0) throw new Error(`Failed to reclaim Nix store ${nixPath}: ${helper.stderr.toString()}`)
  fs.rmdirSync(nixPath)
}

/**
 * The shared seed for per-sandbox nix stores: the image's baked /nix, copied to
 * the host ONCE and cloned (not copied) into each sandbox's store. Dot-prefixed
 * so it can never collide with a sandbox id, and `resolveReclaimableNixStorePath`'s
 * strict `agent_<uuid>` regex means reclamation can never touch it.
 */
const NIX_BASE_DIRNAME = '.base'

function getNixBasePath(): string {
  return path.join(getHomeDir(), 'nix', NIX_BASE_DIRNAME)
}

type SpawnLike = (args: string[]) => { exitCode: number; stderr: Buffer | Uint8Array }

const defaultSpawn: SpawnLike = (args) => Bun.spawnSync(args, { stdout: 'ignore', stderr: 'pipe' })

/**
 * Seed the shared base store from the container image, once.
 *
 * Seeds into a temp sibling then renames into place, so a concurrent ensure
 * either sees no base (and seeds its own temp) or a complete one — never a
 * half-copied store. Losing the publish race is fine: discard the temp and use
 * the winner's base. The one-time chown makes the base usable by the host user;
 * clones inherit it (hardlinks share the inode, APFS clones copy the metadata).
 */
export function ensureNixBase(deps: { spawnSync?: SpawnLike } = {}): string {
  const spawnSync = deps.spawnSync ?? defaultSpawn
  const basePath = getNixBasePath()
  if (fs.existsSync(basePath) && fs.readdirSync(basePath).length > 0) return basePath

  const nixRoot = path.dirname(basePath)
  fs.mkdirSync(nixRoot, { recursive: true })
  const tmpPath = path.join(nixRoot, `${NIX_BASE_DIRNAME}.tmp-${randomBytes(4).toString('hex')}`)
  fs.mkdirSync(tmpPath)

  log.info('Seeding shared nix base store from the sandbox image...')
  const tempName = `ficus-nix-init-${randomBytes(4).toString('hex')}`
  try {
    const createResult = spawnSync(['docker', 'create', '--name', tempName, SANDBOX_IMAGE])
    if (createResult.exitCode !== 0) {
      throw new Error(`Failed to create temp container for nix init: ${createResult.stderr.toString()}`)
    }
    try {
      const copyResult = spawnSync(['docker', 'cp', `${tempName}:/nix/.`, tmpPath])
      if (copyResult.exitCode !== 0) {
        throw new Error(`Failed to copy nix store: ${copyResult.stderr.toString()}`)
      }
      // One-time: make the base usable by the host user (avoids per-sandbox chown).
      const hostUid = process.getuid?.()
      const hostGid = process.getgid?.()
      if (hostUid != null && hostGid != null && hostUid !== 0) {
        spawnSync(['chown', '-R', `${hostUid}:${hostGid}`, tmpPath])
      }
    } finally {
      spawnSync(['docker', 'rm', '-f', tempName])
    }

    // Publish atomically. rename(2) replaces an EMPTY existing dir (the
    // pre-clone mkdir state); a non-empty one means a concurrent seeder won.
    try {
      fs.renameSync(tmpPath, basePath)
    } catch {
      if (!(fs.existsSync(basePath) && fs.readdirSync(basePath).length > 0))
        throw new Error('Failed to publish nix base store')
      fs.rmSync(tmpPath, { recursive: true, force: true })
    }
    return basePath
  } catch (error) {
    fs.rmSync(tmpPath, { recursive: true, force: true })
    throw error
  }
}

/**
 * Populate an empty per-sandbox Nix directory from the base.
 *
 * Only /nix/store is immutable and eligible for inode/block sharing. Mutable
 * Nix state, including /nix/var/nix/db, is independently copied. On failure,
 * remove the partial directory so a later initialization retry starts cleanly.
 */
type NixCloneDeps = { spawnSync?: SpawnLike; copySync?: typeof fs.cpSync }

export function cloneNixBase(basePath: string, nixPath: string, deps: NixCloneDeps = {}): void {
  const spawnSync = deps.spawnSync ?? defaultSpawn
  const copySync = deps.copySync ?? fs.cpSync

  try {
    for (const entry of fs.readdirSync(basePath)) {
      if (entry === 'store') continue
      copySync(path.join(basePath, entry), path.join(nixPath, entry), { recursive: true, force: false })
    }

    const baseStore = path.join(basePath, 'store')
    const sandboxStore = path.join(nixPath, 'store')
    fs.mkdirSync(sandboxStore, { recursive: true })
    const src = `${baseStore}${path.sep}.`
    const strategies: string[][] =
      process.platform === 'darwin'
        ? [
            ['cp', '-Rpc', src, sandboxStore],
            ['cp', '-Rp', src, sandboxStore],
          ]
        : [
            ['cp', '-al', src, sandboxStore],
            ['cp', '-a', src, sandboxStore],
          ]

    let lastError = ''
    for (const args of strategies) {
      const result = spawnSync(args)
      if (result.exitCode === 0) return
      lastError = result.stderr.toString()
      fs.rmSync(sandboxStore, { recursive: true, force: true })
      fs.mkdirSync(sandboxStore, { recursive: true })
    }
    throw new Error(`Failed to clone immutable Nix store into ${nixPath}: ${lastError}`)
  } catch (error) {
    fs.rmSync(nixPath, { recursive: true, force: true })
    throw error
  }
}

/**
 * Ensure the nix store directory exists and is initialized.
 *
 * On first use, clones the shared base store (itself seeded once from the
 * container image) instead of copying the multi-GB base per sandbox — N
 * sandboxes cost ~one base store of disk, not N (issue #631's 114 GB came
 * from full per-sandbox copies of the same baked /nix).
 */
export function ensureNixStore(sandboxId: string, deps: NixCloneDeps = {}): string {
  const nixPath = getNixStorePath(sandboxId)

  if (!fs.existsSync(nixPath)) {
    fs.mkdirSync(nixPath, { recursive: true })
  }

  // Check if nix store is initialized (has content)
  const contents = fs.readdirSync(nixPath)
  if (contents.length === 0) {
    log.info(`Initializing nix store for sandbox ${sandboxId}...`)
    const basePath = ensureNixBase(deps)
    cloneNixBase(basePath, nixPath, deps)
    log.info(`Nix store initialized for sandbox ${sandboxId} (cloned from shared base)`)
  }

  return nixPath
}

// --- Runtime Detection ---

/** Cache for runtime availability checks (computed once at startup) */
let cachedSysboxAvailable: boolean | null = null
let cachedSocketModeAvailable: boolean | null = null
let cachedSelectedRuntime: SandboxRuntime | null = null

/**
 * Check if sysbox-runc is available on this system.
 * Sysbox only works on Linux with kernel 5.12+.
 */
export function isSysboxAvailable(): boolean {
  if (cachedSysboxAvailable !== null) return cachedSysboxAvailable

  // Sysbox only works on Linux
  if (process.platform !== 'linux') {
    cachedSysboxAvailable = false
    return false
  }

  // Check if sysbox-runc runtime is registered with Docker
  const result = Bun.spawnSync(['docker', 'info', '--format', '{{json .Runtimes}}'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })

  if (result.exitCode !== 0) {
    cachedSysboxAvailable = false
    return false
  }

  try {
    const runtimes = JSON.parse(result.stdout.toString().trim())
    cachedSysboxAvailable = 'sysbox-runc' in runtimes
  } catch {
    cachedSysboxAvailable = false
  }

  return cachedSysboxAvailable
}

/**
 * Check if socket mode is available.
 * This requires Docker to be running and the Docker socket to be accessible.
 */
export function isSocketModeAvailable(): boolean {
  if (cachedSocketModeAvailable !== null) return cachedSocketModeAvailable

  // Check if Docker is running
  const result = Bun.spawnSync(['docker', 'info'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })

  cachedSocketModeAvailable = result.exitCode === 0
  return cachedSocketModeAvailable
}

/**
 * Get the Docker socket path for the current platform.
 */
function getDockerSocketPath(): string {
  // Check for custom socket path via environment
  if (process.env.DOCKER_HOST) {
    const host = process.env.DOCKER_HOST
    // Handle unix:// prefix
    if (host.startsWith('unix://')) {
      return host.slice(7)
    }
    // For tcp:// or other protocols, socket mounting won't work
    // but we return a default path and let Docker handle the error
  }

  // Platform-specific default paths
  if (process.platform === 'darwin') {
    // macOS: Docker Desktop socket location - check common locations
    const macPaths = [`${process.env.HOME}/.docker/run/docker.sock`, '/var/run/docker.sock']
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p
    }
  }

  // Windows (via WSL), Linux, and fallback
  return '/var/run/docker.sock'
}

/**
 * Resolve the Docker runtime named by FICUS_SANDBOX_RUNTIME.
 *
 * No probing and no fallbacks: the operator picked `docker-sysbox` or
 * `docker-socket` explicitly, and anything else (including the k8s/vm/host
 * runtimes, which never reach this manager) is a configuration error. In
 * particular `docker-sysbox` on a host without sysbox FAILS — silently
 * downgrading to socket mode would hand agents the host's Docker socket after
 * the operator asked for the isolated runtime.
 */
export function selectRuntime(): SandboxRuntime {
  if (cachedSelectedRuntime !== null) return cachedSelectedRuntime

  const runtime = requireSandboxRuntime()

  if (runtime === 'docker-sysbox') {
    if (!isSysboxAvailable()) {
      throw new Error(
        'FICUS_SANDBOX_RUNTIME=docker-sysbox requested but the sysbox runtime is not installed on this host. ' +
          'Install sysbox (Linux only), or set FICUS_SANDBOX_RUNTIME=docker-socket.'
      )
    }
    cachedSelectedRuntime = 'docker-sysbox'
    log.info('Using docker-sysbox runtime (secure Docker-in-Docker)')
    return cachedSelectedRuntime
  }

  if (runtime === 'docker-socket') {
    cachedSelectedRuntime = 'docker-socket'
    log.info('Using docker-socket runtime (Docker socket mounting)')
    return cachedSelectedRuntime
  }

  throw new Error(
    `The Docker sandbox manager was used under FICUS_SANDBOX_RUNTIME=${runtime}. ` +
      'Set FICUS_SANDBOX_RUNTIME to docker-sysbox or docker-socket to run Docker sandboxes.'
  )
}

/**
 * Get a human-readable description of the current runtime configuration.
 */
export function getRuntimeInfo(): { runtime: SandboxRuntime; sysboxAvailable: boolean; platform: string } {
  return {
    runtime: selectRuntime(),
    sysboxAvailable: isSysboxAvailable(),
    platform: process.platform,
  }
}

/**
 * Clear runtime detection cache (for testing).
 */
export function clearRuntimeCache(): void {
  cachedSysboxAvailable = null
  cachedSocketModeAvailable = null
  cachedSelectedRuntime = null
}

export function parseDockerExitCode(stdout: string): number | undefined {
  const trimmed = stdout.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) ? parsed : undefined
}

export function buildDockerLogsArgs(containerName: string, opts: { tailLines?: number; follow?: boolean }): string[] {
  const tail = Math.min(Math.max(opts.tailLines ?? 500, 1), 5000)
  const follow = opts.follow ?? true
  return ['logs', '--tail', String(tail), ...(follow ? ['-f'] : []), containerName]
}

/**
 * The Core API URL a Docker sandbox should use to reach the `ficus` CLI / callbacks.
 * Re-injected per `docker exec` (overriding the value baked into the container at
 * creation) so the CLI survives a Core restart on a different dynamic port.
 */
export function resolveDockerApiUrl(opts: { port?: string } = {}): string {
  const port = opts.port ?? process.env.PORT ?? '3000'
  return `http://host.docker.internal:${port}`
}

/**
 * Docker LABEL that carries the create-time spec hash, so mount/volume drift
 * survives Core restarts (the live container is the source of truth, not the
 * in-memory state map). The value is {@link computeDockerSpecHash}.
 */

/**
 * Hash of the create-time inputs that a running container cannot change without
 * being recreated: the image, the selected runtime, the workspace/private bind
 * targets, the squad membership (which selects the container mount layout), and
 * the extra `-v` volume list. When any of these drift from the running
 * container's stamped {@link SPEC_HASH_LABEL}, ensure recreates it instead of
 * adopting a stale (e.g. pre-upgrade) container.
 *
 * The stamp written at create and the value compared at ensure BOTH come from
 * this one function over the same `opts`, so identical mounts always agree — the
 * anti-loop invariant (see squad-sandbox-spec-hash lesson). Two things are load-
 * bearing for that:
 *  - `volumes` is sorted, so a reordered list never churns the hash.
 *  - `env` is EXCLUDED: it carries per-ensure churn (the dynamic Core port in
 *    FICUS_API_URL, GitHub tokens, the callback secret) and is re-injected per
 *    `docker exec` anyway, so it is not a create-immutable input. Hashing it
 *    would make the stamp never match the next ensure — an infinite recreate.
 */
export function computeDockerSpecHash(
  opts: SandboxOptions,
  image: Pick<
    DockerImageContract,
    'imageReference' | 'imageId' | 'runtimeContractVersion' | 'executorProtocolVersion'
  > = {
    imageReference: SANDBOX_IMAGE,
    imageId: `unresolved:${SANDBOX_IMAGE}`,
    runtimeContractVersion: 1,
    executorProtocolVersion: 1,
  }
): string {
  const reconcilable = {
    imageReference: image.imageReference,
    imageId: image.imageId,
    runtimeContractVersion: image.runtimeContractVersion,
    executorProtocolVersion: image.executorProtocolVersion,
    commandIdentityFingerprint: `${process.getuid?.() ?? 'image'}:${process.getgid?.() ?? 'image'}`,
    runtime: selectRuntime(),
    workspacePath: opts.workspacePath,
    privateVolumePath: opts.privateVolumePath ?? null,
    squadId: opts.squadId ?? null,
    lifecycleGeneration: opts.lifecycleGeneration ?? null,
    volumes: [...(opts.volumes ?? [])].sort(),
    shmSize: DOCKER_SANDBOX_SHM_SIZE,
  }
  return computeDockerSpecDigest(reconcilable)
}

export function inspectDockerImageContract(imageReference = SANDBOX_IMAGE): DockerImageContract {
  const result = Bun.spawnSync(['docker', 'image', 'inspect', imageReference], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) return parseDockerImageContract(imageReference, [])
  try {
    return parseDockerImageContract(imageReference, JSON.parse(result.stdout.toString()))
  } catch (error) {
    if (error instanceof SyntaxError) return parseDockerImageContract(imageReference, [])
    throw error
  }
}

// --- Sandbox Manager ---

export class DockerSandboxManager implements ISandboxManager {
  private sandboxes = new Map<string, SandboxState>()

  /**
   * Get the container name for a sandbox ID.
   */
  private containerName(sandboxId: string): string {
    return `${CONTAINER_PREFIX}${sandboxId}`
  }

  /**
   * Ensure the .ficus/.bashrc file exists for terminal sessions.
   * This sources .ficus/.env and activates devbox if available.
   */
  private ensureBashrc(
    containerId: string,
    workspacePath: string,
    workspaceMount: string,
    toolchainDir?: string
  ): void {
    const userArgs = this.getSandboxUserArgs(containerId)
    const content = buildBashrcContent(workspacePath, workspaceMount, { toolchainDir })

    Bun.spawnSync(
      [
        'docker',
        'exec',
        ...userArgs,
        '-w',
        workspaceMount,
        containerId,
        'sh',
        '-c',
        `mkdir -p ${WORKSPACE_DOT_DIR} && echo '${content.trimEnd()}' > ${WORKSPACE_DOT_DIR}/.bashrc`,
      ],
      { stdout: 'ignore', stderr: 'ignore' }
    )
  }

  /**
   * Ensure a sandbox container is running for the given ID.
   * Creates one if it doesn't exist. Reuses existing if it does.
   * Uses DB locking for squad sandboxes to prevent concurrent initialization.
   *
   * @param sandboxId - Opaque identifier (taskId, squadId, etc.)
   * @param opts - Sandbox options (workspace path, etc.)
   * @returns The container ID
   */
  async attachExistingSandbox(sandboxId: string, opts: SandboxOptions): Promise<boolean> {
    const tracked = this.sandboxes.get(sandboxId)
    if (tracked && this.isContainerRunning(tracked.containerId)) {
      if (!tracked.client) await this.connectExecutor(tracked.containerId, sandboxId)
      return true
    }
    const [containerId, ...duplicateContainers] = findSandboxContainers(sandboxId, (candidate) =>
      this.getExistingContainer(candidate)
    )
    if (!containerId) return false
    // No-create reconciliation adopts only already-reachable boxes. A stopped
    // container stays cold until its normal ensure lifecycle starts it.
    if (!this.isContainerRunning(containerId)) return false
    if (duplicateContainers.length) this.removeDuplicateContainers(sandboxId, duplicateContainers, opts.workspacePath)
    const squadId = opts.squadId ?? getSquadIdFromSandbox(sandboxId) ?? undefined
    const layout = containerWorkspaceLayout({ squadId })
    const workRoot = containerWorkRoot({ squadId })
    this.sandboxes.set(sandboxId, {
      containerId,
      workspacePath: opts.workspacePath,
      sandboxId,
      runtime: selectRuntime(),
      workspaceMount: workRoot,
      memoryMount: layout.memoryMount,
      squadId,
      privateVolumePath: opts.privateVolumePath,
      lifecycleGeneration: opts.lifecycleGeneration,
    })
    this.ensureBashrc(containerId, opts.workspacePath, workRoot)
    await this.connectExecutor(containerId, sandboxId)
    return true
  }

  async ensureSandbox(sandboxId: string, opts: SandboxOptions): Promise<string> {
    let finishSetup: ((outcome: 'ready' | 'failed') => void) | undefined
    let setupOutcome: 'ready' | 'failed' = 'failed'
    const beginOnce = (reason: SandboxSetupWorkReason) => {
      finishSetup ??= beginSandboxSetupWork(this, sandboxId, reason)
    }
    const ready = <T>(value: T): T => {
      setupOutcome = 'ready'
      return value
    }

    try {
      // The spec these opts would create. Used both to gate reuse of an existing
      // container and (via createXContainer) to stamp the new one — one function,
      // one config, so stamp and check always agree (anti-loop invariant).
      const imageContract = this.resolveImageContract()
      const specHash = computeDockerSpecHash(opts, imageContract)

      // Check if we already have it in memory
      const existing = this.sandboxes.get(sandboxId)
      if (existing) {
        existing.lifecycleGeneration = opts.lifecycleGeneration
        // Verify container is still running
        if (this.isContainerRunning(existing.containerId)) {
          // Reuse only when the running container's mounts still match the desired
          // spec; a stale or missing label (e.g. a mount-changing upgrade) forces a
          // recreate instead of adopting an out-of-date container.
          if (this.getContainerSpecHash(existing.containerId) === specHash) {
            if (!existing.client) {
              beginOnce('runtime_reconnect')
              await this.connectExecutor(existing.containerId, sandboxId)
            }
            return ready(existing.containerId)
          }
          // Idle/session gate (parity with the k8s drift-recreate gate in
          // ensure.ts): a spec-drifted box with an active session is reused as-is,
          // deferring the recreate so an in-flight turn is never torn down. A later
          // idle ensure reconciles the drift.
          if (opts.hasActiveSession) {
            log.info(`Sandbox ${sandboxId} spec drifted but session active; deferring recreate and reusing container`)
            if (!existing.client) {
              beginOnce('runtime_reconnect')
              await this.connectActiveDrift(existing.containerId, sandboxId)
            }
            return ready(existing.containerId)
          }
          log.info(`Sandbox ${sandboxId} spec drifted; recreating container`)
          beginOnce('spec_reconcile')
          // removeSandbox rm's the container AND drops the in-memory entry, so the
          // recreate below can't race a stale state map (requirement 3).
          await this.removeSandbox(sandboxId)
        } else {
          // Container died while we believed it was running — notify best-effort, then recreate.
          beginOnce('runtime_start')
          const { sandboxDeathNotifier } = await import('../death/notifier')
          await sandboxDeathNotifier.maybeNotify({
            sandboxId,
            signal: 'exited',
            reason: this.getContainerExitReason(existing.containerId),
            exitCode: this.getContainerExitCode(existing.containerId),
            memoryLimit: DOCKER_SANDBOX_MEMORY_LIMIT,
            runtime: 'docker',
          })
          this.sandboxes.delete(sandboxId)
        }
      }

      const name = this.containerName(sandboxId)

      // Check if container already exists (e.g. from a previous server run),
      // under any identity prefix: a container this release did not name is
      // still adopted or removed here, never left beside a new one.
      const [existingContainer, ...duplicateContainers] = findSandboxContainers(sandboxId, (candidate) =>
        this.getExistingContainer(candidate)
      )
      if (existingContainer) {
        // Adopt it only when its stamped spec matches; a missing label (pre-upgrade
        // container) or a mismatch means the mounts are stale — remove + recreate.
        // Exception (idle/session gate): a drifted box with an active session is
        // adopted as-is, deferring the recreate to a later idle ensure.
        const existingMatches = this.getContainerSpecHash(existingContainer) === specHash
        if (existingMatches || opts.hasActiveSession) {
          if (!existingMatches) {
            log.info(`Container for ${sandboxId} spec drifted but session active; deferring recreate and adopting`)
          }
          // Adopt the write-name container; a duplicate under another prefix is removed, never left running.
          if (duplicateContainers.length)
            this.removeDuplicateContainers(sandboxId, duplicateContainers, opts.workspacePath)
          // Start it if stopped
          if (!this.isContainerRunning(existingContainer)) {
            beginOnce('runtime_start')
            Bun.spawnSync(['docker', 'start', existingContainer], { stdout: 'ignore', stderr: 'ignore' })
          } else {
            beginOnce('runtime_reconnect')
          }
          // We don't know the original runtime, but it doesn't matter for existing containers
          const existingSquadId = opts.squadId ?? getSquadIdFromSandbox(sandboxId) ?? undefined
          const existingLayout = containerWorkspaceLayout({ squadId: existingSquadId })
          const existingWorkRoot = containerWorkRoot({ squadId: existingSquadId })
          this.sandboxes.set(sandboxId, {
            containerId: existingContainer,
            workspacePath: opts.workspacePath,
            sandboxId,
            runtime: selectRuntime(),
            workspaceMount: existingWorkRoot,
            memoryMount: existingLayout.memoryMount,
            squadId: existingSquadId,
            lifecycleGeneration: opts.lifecycleGeneration,
          })
          // Ensure bashrc exists for terminal sessions (may be missing on older containers)
          this.ensureBashrc(existingContainer, opts.workspacePath, existingWorkRoot)
          await (existingMatches
            ? this.connectExecutor(existingContainer, sandboxId)
            : this.connectActiveDrift(existingContainer, sandboxId))
          return ready(existingContainer)
        }
        log.info(`Container for ${sandboxId} has a stale or missing spec-hash; recreating`)
        beginOnce('spec_reconcile')
        await this.removeSandbox(sandboxId, opts.workspacePath)
      }

      // No container exists - check if DB thinks it's ready (stale state from deleted container)
      // If so, reset the status so we can reinitialize.
      beginOnce('runtime_start')
      await this.resetStaleSandboxStatus(sandboxId)

      // Try to acquire initialization lock via DB (for squad sandboxes)
      // This prevents concurrent initialization from multiple processes
      const lockAcquired = await this.tryAcquireSandboxLock(sandboxId)
      if (!lockAcquired) {
        // Another process is initializing - wait for it to complete
        await this.waitForSandboxReady(sandboxId)
        // Now check again for the container
        const [containerAfterWait, ...duplicatesAfterWait] = findSandboxContainers(sandboxId, (candidate) =>
          this.getExistingContainer(candidate)
        )
        // Adopt the peer's container only when its spec matches ours; a stale or
        // missing label falls through to remove + recreate below. Idle/session
        // gate: a drifted box with an active session is adopted as-is (defer).
        const afterWaitMatches = containerAfterWait ? this.getContainerSpecHash(containerAfterWait) === specHash : false
        if (containerAfterWait && (afterWaitMatches || opts.hasActiveSession)) {
          if (!afterWaitMatches) {
            log.info(`Container for ${sandboxId} (post-wait) spec drifted but session active; deferring recreate`)
          }
          if (duplicatesAfterWait.length)
            this.removeDuplicateContainers(sandboxId, duplicatesAfterWait, opts.workspacePath)
          if (!this.isContainerRunning(containerAfterWait)) {
            Bun.spawnSync(['docker', 'start', containerAfterWait], { stdout: 'ignore', stderr: 'ignore' })
          }
          const afterWaitSquadId = opts.squadId ?? getSquadIdFromSandbox(sandboxId) ?? undefined
          const afterWaitLayout = containerWorkspaceLayout({ squadId: afterWaitSquadId })
          const afterWaitWorkRoot = containerWorkRoot({ squadId: afterWaitSquadId })
          this.sandboxes.set(sandboxId, {
            containerId: containerAfterWait,
            workspacePath: opts.workspacePath,
            sandboxId,
            runtime: selectRuntime(),
            workspaceMount: afterWaitWorkRoot,
            memoryMount: afterWaitLayout.memoryMount,
            squadId: afterWaitSquadId,
            lifecycleGeneration: opts.lifecycleGeneration,
          })
          // Ensure bashrc exists for terminal sessions
          this.ensureBashrc(containerAfterWait, opts.workspacePath, afterWaitWorkRoot)
          await (afterWaitMatches
            ? this.connectExecutor(containerAfterWait, sandboxId)
            : this.connectActiveDrift(containerAfterWait, sandboxId))
          return ready(containerAfterWait)
        }
        if (containerAfterWait) {
          log.info(`Container for ${sandboxId} (post-wait) has a stale or missing spec-hash; recreating`)
          await this.removeSandbox(sandboxId, opts.workspacePath)
        }

        // Container still doesn't exist after waiting - the other process may have failed
        // Reset status and try to acquire lock again
        await this.resetStaleSandboxStatus(sandboxId)
        const lockAcquiredAgain = await this.tryAcquireSandboxLock(sandboxId)
        if (!lockAcquiredAgain) {
          throw new Error(`Failed to acquire sandbox lock for ${sandboxId} after waiting`)
        }
      }

      const runtime = selectRuntime()
      const newSquadId = opts.squadId ?? getSquadIdFromSandbox(sandboxId) ?? undefined
      const newLayout = containerWorkspaceLayout({ squadId: newSquadId })
      const newWorkRoot = containerWorkRoot({ squadId: newSquadId })
      const containerId =
        runtime === 'docker-sysbox'
          ? await this.createSysboxContainer(name, opts, specHash, imageContract)
          : await this.createSocketContainer(name, opts, specHash, imageContract)

      this.sandboxes.set(sandboxId, {
        containerId,
        workspacePath: opts.workspacePath,
        sandboxId,
        runtime,
        workspaceMount: newWorkRoot,
        memoryMount: newLayout.memoryMount,
        squadId: opts.squadId,
        privateVolumePath: opts.privateVolumePath,
        lifecycleGeneration: opts.lifecycleGeneration,
      })
      const initializedContainer = await runWithPrimaryCleanup(
        async () => {
          await this.connectExecutor(containerId, sandboxId)

          // All subsequent docker exec calls run as the sandbox user
          const userArgs = this.getSandboxUserArgs(containerId)

          const githubIdentity = await resolveGitHubIdentity(opts.squadId ?? getSquadIdFromSandbox(sandboxId))

          // Forward resolved git user config into the container
          if (githubIdentity.gitUserName) {
            Bun.spawnSync(
              [
                'docker',
                'exec',
                ...userArgs,
                containerId,
                'git',
                'config',
                '--global',
                'user.name',
                githubIdentity.gitUserName,
              ],
              { stdout: 'ignore', stderr: 'ignore' }
            )
          }
          if (githubIdentity.gitUserEmail) {
            Bun.spawnSync(
              [
                'docker',
                'exec',
                ...userArgs,
                containerId,
                'git',
                'config',
                '--global',
                'user.email',
                githubIdentity.gitUserEmail,
              ],
              { stdout: 'ignore', stderr: 'ignore' }
            )
          }

          // Initialize or update devbox in workspace from default template.
          // Seeds if missing, merges new packages if template has additions.
          const devboxJsonPath = path.join(opts.workspacePath, 'devbox.json')
          const templatePath = path.join(MONOREPO_ROOT, 'apps/core/docker-sandbox/devbox.json')
          if (!fs.existsSync(devboxJsonPath)) {
            if (fs.existsSync(templatePath)) {
              fs.copyFileSync(templatePath, devboxJsonPath)
              log.info(`Initialized devbox.json in workspace`)
            }
          } else if (fs.existsSync(templatePath)) {
            mergeDevboxPackages(devboxJsonPath, templatePath)
          }

          // Run devbox install to initialize .devbox directory
          // This pre-warms the devbox environment so agents don't have to wait
          if (fs.existsSync(devboxJsonPath)) {
            Bun.spawnSync(
              [
                'docker',
                'exec',
                ...userArgs,
                '-w',
                newLayout.workspaceMount,
                containerId,
                'sh',
                '-c',
                '. ~/.nix-profile/etc/profile.d/nix.sh 2>/dev/null || true; devbox install 2>/dev/null || true',
              ],
              { stdout: 'ignore', stderr: 'ignore' }
            )
          }

          // Create bashrc for terminal sessions to load .env and activate devbox
          this.ensureBashrc(containerId, opts.workspacePath, newLayout.workspaceMount)

          // Run workspace setup script if present (.ficus/setup.sh)
          // This allows workspaces to install system-level tools or run custom initialization.
          // The script runs as the sandbox user with sudo access.
          const setupScript = `${newLayout.workspaceMount}/${WORKSPACE_DOT_DIR}/setup.sh`
          const setupResult = Bun.spawnSync(
            [
              'docker',
              'exec',
              ...userArgs,
              '-w',
              newLayout.workspaceMount,
              containerId,
              'sh',
              '-c',
              `[ -x ${setupScript} ] && ${setupScript} || true`,
            ],
            { stdout: 'inherit', stderr: 'inherit' }
          )
          if (setupResult.exitCode !== 0) {
            log.warn(`Setup script failed with exit code ${setupResult.exitCode}`)
          }

          // Mark sandbox as ready in DB
          await this.markSandboxReady(sandboxId)
          const { sandboxDeathNotifier } = await import('../death/notifier')
          sandboxDeathNotifier.clear(sandboxId)

          return containerId
        },
        () => this.cleanupFailedInitialization(sandboxId, opts.workspacePath)
      )
      return ready(initializedContainer)
    } finally {
      finishSetup?.(setupOutcome)
    }
  }

  private async cleanupFailedInitialization(sandboxId: string, workspacePath: string): Promise<void> {
    const client = this.sandboxes.get(sandboxId)?.client
    await cleanupFailedInitialization({
      remove: () => this.removeSandbox(sandboxId, workspacePath),
      isTracked: () => this.sandboxes.has(sandboxId),
      close: client ? () => client.close() : undefined,
    })
  }

  /**
   * Try to acquire the sandbox initialization lock via atomic DB update.
   * Returns true if lock acquired, false if another process is initializing.
   */
  private async tryAcquireSandboxLock(sandboxId: string): Promise<boolean> {
    const squadId = getSquadIdFromSandbox(sandboxId)
    if (!squadId) return true // Non-squad sandboxes don't need locking

    try {
      const { db, squads } = await import('../../../db')
      const { eq, and } = await import('drizzle-orm')

      const result = await db
        .update(squads)
        .set({ sandboxStatus: 'initializing', updatedAt: new Date() })
        .where(and(eq(squads.id, squadId), eq(squads.sandboxStatus, 'none')))
        .returning({ id: squads.id })

      if (result.length > 0) {
        log.info(`Acquired sandbox lock for ${sandboxId}`)
        return true
      }

      // Check if already ready
      const squad = await db.select({ sandboxStatus: squads.sandboxStatus }).from(squads).where(eq(squads.id, squadId))
      if (squad.length > 0 && squad[0].sandboxStatus === 'ready') {
        return true // Already initialized, no need to wait
      }

      return false
    } catch {
      // Not a squad sandbox (e.g., task sandbox) - no locking needed
      return true
    }
  }

  /**
   * Wait for sandbox to become ready (another process is initializing).
   * Polls DB with exponential backoff.
   */
  private async waitForSandboxReady(sandboxId: string, timeoutMs = 120000): Promise<void> {
    const squadId = getSquadIdFromSandbox(sandboxId)
    if (!squadId) return // Non-squad sandboxes don't need waiting

    const { db, squads } = await import('../../../db')
    const { eq } = await import('drizzle-orm')

    const startTime = Date.now()
    let delay = 500

    while (Date.now() - startTime < timeoutMs) {
      const result = await db.select({ sandboxStatus: squads.sandboxStatus }).from(squads).where(eq(squads.id, squadId))

      if (result.length > 0) {
        const status = result[0].sandboxStatus
        if (status === 'ready') {
          log.info(`Sandbox ${sandboxId} is ready`)
          return
        }
        if (status === 'failed') {
          throw new Error(`Sandbox initialization failed for ${sandboxId}`)
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 1.5, 5000) // Exponential backoff, max 5s
    }

    throw new Error(`Timeout waiting for sandbox ${sandboxId} to initialize`)
  }

  /**
   * Mark sandbox as ready in DB.
   */
  private async markSandboxReady(sandboxId: string): Promise<void> {
    const squadId = getSquadIdFromSandbox(sandboxId)
    if (!squadId) return

    try {
      const { db, squads } = await import('../../../db')
      const { eq } = await import('drizzle-orm')

      await db.update(squads).set({ sandboxStatus: 'ready', updatedAt: new Date() }).where(eq(squads.id, squadId))
    } catch {
      // Not a squad sandbox - ignore
    }
  }

  /**
   * Reset sandbox status to 'none' if it's 'ready' or 'failed' but container doesn't exist.
   * This handles the case where a container was manually deleted.
   */
  private async resetStaleSandboxStatus(sandboxId: string): Promise<void> {
    const squadId = getSquadIdFromSandbox(sandboxId)
    if (!squadId) return

    try {
      const { db, squads } = await import('../../../db')
      const { eq, and, or } = await import('drizzle-orm')

      const result = await db
        .update(squads)
        .set({ sandboxStatus: 'none', updatedAt: new Date() })
        .where(
          and(
            eq(squads.id, squadId),
            // Only reset if status is 'ready' or 'failed' (stale states)
            // 'none' and 'initializing' should not be reset
            or(eq(squads.sandboxStatus, 'ready'), eq(squads.sandboxStatus, 'failed'))
          )
        )
        .returning({ id: squads.id })

      if (result.length > 0) {
        log.info(`Reset stale sandbox status for ${sandboxId} (container was deleted)`)
      }
    } catch {
      // Not a squad sandbox - ignore
    }
  }

  /**
   * Create a container using sysbox-runc runtime.
   * Provides secure, unprivileged Docker-in-Docker via user namespace isolation.
   */
  private async createSysboxContainer(
    name: string,
    opts: SandboxOptions,
    specHash: string,
    imageContract: DockerImageContract
  ): Promise<string> {
    const squadId = opts.squadId ?? getSquadIdFromSandbox(name.replace(CONTAINER_PREFIX, '')) ?? undefined
    const layout = containerWorkspaceLayout({ squadId })
    // Solo agents work in /private (no /workspace); squad members in the shared workspace.
    const workspaceMount = containerWorkRoot({ squadId })
    const args = [
      'docker',
      'run',
      '-d',
      '--name',
      name,
      '-p',
      '127.0.0.1::50051',
      ...sandboxContainerLabelArgs({
        sandboxId: name.replace(CONTAINER_PREFIX, ''),
        specHash,
        imageId: imageContract.imageId,
        lifecycleGeneration: opts.lifecycleGeneration,
      }),
      '--runtime=sysbox-runc',
      // Resource limits
      `--memory=${DOCKER_SANDBOX_MEMORY_LIMIT}`,
      '--cpus=2',
      // Chromium (in-container ficus-browser service) needs a real /dev/shm.
      `--shm-size=${DOCKER_SANDBOX_SHM_SIZE}`,
      // Mount workspace
      '-v',
      `${opts.workspacePath}:${workspaceMount}`,
      '-w',
      workspaceMount,
    ]

    const hostUid = process.getuid?.()
    const hostGid = process.getgid?.()
    if (
      Number.isSafeInteger(hostUid) &&
      Number.isSafeInteger(hostGid) &&
      hostUid! > 0 &&
      hostGid! > 0 &&
      hostUid !== 65534 &&
      hostGid !== 65534
    ) {
      pushEnvArgs(args, { FICUS_HOST_UID: String(hostUid), FICUS_HOST_GID: String(hostGid) })
    }

    // Mount per-agent private volume when provided
    if (opts.privateVolumePath) {
      args.push('-v', `${opts.privateVolumePath}:${layout.privateMount}`)
    }

    // Add common options (hostAccess, env, volumes, git credentials, nix store)
    await this.addCommonContainerOptions(args, name, opts)

    args.push(SANDBOX_IMAGE)

    const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim()
      throw new Error(`Failed to create sysbox sandbox container: ${stderr}`)
    }

    return result.stdout.toString().trim().slice(0, 12)
  }

  /**
   * Create a container using socket mode.
   * Mounts the Docker socket for DinD capability. Works on macOS, Windows, and Linux.
   *
   * Security notes:
   * - Docker socket access grants significant host privileges
   * - Resource limits are enforced
   * - The sandbox image runs as root inside but cannot escape the container
   */
  private async createSocketContainer(
    name: string,
    opts: SandboxOptions,
    specHash: string,
    imageContract: DockerImageContract
  ): Promise<string> {
    const dockerSocket = getDockerSocketPath()
    const squadId = opts.squadId ?? getSquadIdFromSandbox(name.replace(CONTAINER_PREFIX, '')) ?? undefined
    const layout = containerWorkspaceLayout({ squadId })
    // Solo agents work in /private (no /workspace); squad members in the shared workspace.
    const workspaceMount = containerWorkRoot({ squadId })

    const args = [
      'docker',
      'run',
      '-d',
      '--name',
      name,
      '-p',
      '127.0.0.1::50051',
      ...sandboxContainerLabelArgs({
        sandboxId: name.replace(CONTAINER_PREFIX, ''),
        specHash,
        imageId: imageContract.imageId,
        lifecycleGeneration: opts.lifecycleGeneration,
      }),
      // Mount Docker socket for DinD
      '-v',
      `${dockerSocket}:/var/run/docker.sock`,
      // Resource limits
      `--memory=${DOCKER_SANDBOX_MEMORY_LIMIT}`,
      '--cpus=2',
      // Chromium (in-container ficus-browser service) needs a real /dev/shm.
      `--shm-size=${DOCKER_SANDBOX_SHM_SIZE}`,
      // Mount workspace
      '-v',
      `${opts.workspacePath}:${workspaceMount}`,
      '-w',
      workspaceMount,
    ]

    const hostUid = process.getuid?.()
    const hostGid = process.getgid?.()
    if (
      Number.isSafeInteger(hostUid) &&
      Number.isSafeInteger(hostGid) &&
      hostUid! > 0 &&
      hostGid! > 0 &&
      hostUid !== 65534 &&
      hostGid !== 65534
    ) {
      pushEnvArgs(args, { FICUS_HOST_UID: String(hostUid), FICUS_HOST_GID: String(hostGid) })
    }

    // Mount per-agent private volume when provided
    if (opts.privateVolumePath) {
      args.push('-v', `${opts.privateVolumePath}:${layout.privateMount}`)
    }

    // On Linux, we may need to handle Docker socket permissions
    if (process.platform === 'linux') {
      // Get the docker socket's group ID and pass it to the container
      const statResult = Bun.spawnSync(['stat', '-c', '%g', dockerSocket], {
        stdout: 'pipe',
        stderr: 'ignore',
      })
      if (statResult.exitCode === 0) {
        const gid = statResult.stdout.toString().trim()
        if (gid && gid !== '0') {
          args.push('--group-add', gid)
        }
      }
    }

    // Add common options (hostAccess, env, volumes, git credentials, nix store)
    await this.addCommonContainerOptions(args, name, opts)

    args.push(SANDBOX_IMAGE)

    const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim()
      throw new Error(`Failed to create socket mode container: ${stderr}`)
    }

    return result.stdout.toString().trim().slice(0, 12)
  }

  /**
   * Add common container options shared between runtimes.
   */
  private async addCommonContainerOptions(args: string[], containerName: string, opts: SandboxOptions): Promise<void> {
    // Allow container to reach services on the host via host.docker.internal
    if (opts.hostAccess) {
      const hostIp = this.getDockerHostIp()
      args.push(`--add-host=host.docker.internal:${hostIp}`)
    }

    // Extra environment variables
    if (opts.env) pushEnvArgs(args, opts.env)

    // Extra volume mounts
    if (opts.volumes) {
      for (const vol of opts.volumes) {
        args.push('-v', vol)
      }
    }

    // Mount per-sandbox Nix store directory for devbox package persistence.
    // Each sandbox gets its own directory for isolation — prevents cross-sandbox
    // tampering and ensures clean teardown when sandbox is removed.
    // Stored in ~/.tau/data/nix/{sandboxId}/ alongside other sandbox data.
    const sandboxId = containerName.replace(CONTAINER_PREFIX, '')
    const nixStorePath = ensureNixStore(sandboxId)
    args.push('-v', `${nixStorePath}:/nix`)

    // Pass through resolved git/GitHub credentials if available.
    // Prefer opts.squadId so light containers (agent_<type>_<id>) whose sandboxId
    // no longer encodes the squad still resolve the correct squad GitHub identity.
    const githubIdentity = await resolveGitHubIdentity(opts.squadId ?? getSquadIdFromSandbox(sandboxId))

    for (const [name, value] of Object.entries(gitIdentityEnv(githubIdentity))) args.push('-e', `${name}=${value}`)
  }

  /**
   * Get a spawnHook for the bash tool that executes commands inside the container.
   * The hook writes the command to a temp script in the workspace (bind-mounted)
   * and runs it via `docker exec`.
   */
  getSpawnHook(
    sandboxId: string,
    workspacePath: string,
    ficusToken?: string
  ):
    | ((ctx: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => {
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
      })
    | null {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) return null

    return (ctx) => {
      // Write command to a temp script in the workspace (which is mounted in the container)
      const tmpDir = path.join(workspacePath, '.tmp')
      fs.mkdirSync(tmpDir, { recursive: true })
      const scriptName = `ficus-exec-${randomBytes(8).toString('hex')}.sh`
      const scriptPath = path.join(tmpDir, scriptName)
      const containerScriptPath = `${sandbox.workspaceMount}/.tmp/${scriptName}`

      // Build script preamble
      let preamble = `trap 'rm -f "${containerScriptPath}"' EXIT\n`

      // Source workspace .ficus/.env if it exists (for secrets/environment variables)
      preamble += `[ -f ${sandbox.workspaceMount}/${WORKSPACE_DOT_DIR}/.env ] && set -a && . ${sandbox.workspaceMount}/${WORKSPACE_DOT_DIR}/.env && set +a\n`

      // Auto-activate devbox if devbox.json exists in workspace
      // This makes devbox-installed tools available in PATH for all commands
      if (fs.existsSync(path.join(workspacePath, 'devbox.json'))) {
        preamble += `eval "$(devbox shellenv --init-hook 2>/dev/null)" 2>/dev/null || true\n`
      }

      const managedHostRoot = sandbox.privateVolumePath ?? sandbox.workspacePath
      const managedContainerRoot = sandbox.privateVolumePath ? '/private' : sandbox.workspaceMount
      if (fs.existsSync(workspaceDotPath(managedHostRoot, 'toolchain', '.ready'))) {
        preamble += `eval "$(cd ${managedContainerRoot}/${WORKSPACE_DOT_DIR}/toolchain && devbox shellenv --init-hook 2>/dev/null)" 2>/dev/null || true\n`
      }

      const scriptContent = preamble + ctx.command
      fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 })

      const userArgs = this.getSandboxUserArgs(sandbox.containerId)
      // Inject the per-agent scoped token so `ficus` CLI calls inside the sandbox
      // authenticate AS this agent (RBAC squad-scoped) rather than via the shared
      // FICUS_PASSWORD. Tokens are `ficus_agent_<uuid>` (no shell metacharacters).
      // Re-inject the live Core URL so the CLI reaches the current Core even if the
      // container baked a now-stale dynamic port at creation (matches k8s behavior).
      const identityArgs: string[] = []
      pushEnvArgs(identityArgs, {
        ...(ficusToken ? { FICUS_TOKEN: ficusToken } : {}),
        FICUS_API_URL: resolveDockerApiUrl(),
      })
      const execArgs = [
        'docker',
        'exec',
        ...userArgs,
        ...identityArgs,
        '-w',
        sandbox.workspaceMount,
        sandbox.containerId,
        'bash',
        containerScriptPath,
      ]
      const command = execArgs.join(' ')

      return {
        ...ctx,
        command,
      }
    }
  }

  /**
   * Spawn an interactive shell inside a sandbox container.
   * Returns an IPty for terminal sessions.
   * If workspacePath is provided and contains devbox.json, auto-activates devbox environment.
   */
  async reconcileToolchain(
    sandboxId: string,
    _opts: SandboxOptions,
    request: ManagedToolchainRequest
  ): Promise<'unchanged' | 'applied' | 'cleared'> {
    const state = this.sandboxes.get(sandboxId)
    if (!state) throw new Error(`No sandbox found for ${sandboxId}`)
    const isAgent = Boolean(state.privateVolumePath)
    const workRoot = isAgent ? '/private' : state.workspaceMount
    const containerDir = `${workRoot}/${WORKSPACE_DOT_DIR}/toolchain`
    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`
    const enterManagedDir = buildManagedToolchainDirPrefix(workRoot)
    const runManaged = (command: string, timeoutMs = 600_000) =>
      this.execToolchainStatus(sandboxId, ['bash', '-lc', `${enterManagedDir}${command}`], timeoutMs)
    const runReadiness = async () => {
      for (const check of request.readiness ?? []) {
        const command = `set -o pipefail; ${check.command} | grep -F -- ${quote(check.expectedSubstring)}`
        const result = await runManaged(`devbox run -c . -- bash -lc ${quote(command)}`)
        if (result.timedOut) throw new ToolchainAdapterError('timeout')
        if (result.exitCode !== 0) throw new ToolchainAdapterError('readiness_failed', result.exitCode)
      }
    }
    const remove = async (name: string) => {
      const result = await runManaged(`rm -f -- ${quote(name)}`)
      if (result.timedOut) throw new ToolchainAdapterError('timeout')
      if (result.exitCode !== 0) throw new ToolchainAdapterError('activation_failed', result.exitCode)
    }
    const atomicWrite = async (name: string, contents: string, mode: string) => {
      const encoded = Buffer.from(contents).toString('base64')
      const command = `tmp=$(mktemp .managed.XXXXXX); trap 'rm -f -- "$tmp"' EXIT; printf %s ${quote(encoded)} | base64 -d >"$tmp"; chmod ${mode} "$tmp"; mv -fT -- "$tmp" ${quote(name)}; trap - EXIT`
      const result = await runManaged(command)
      if (result.timedOut) throw new ToolchainAdapterError('timeout')
      if (result.exitCode !== 0) throw new ToolchainAdapterError('activation_failed', result.exitCode)
    }

    if (!request.config || !request.fingerprint || !request.devboxJson) {
      return trackSandboxSetupWork(this, sandboxId, 'toolchain_reconcile', async () => {
        await remove('.ready')
        this.ensureBashrc(state.containerId, state.workspacePath, state.workspaceMount)
        return 'cleared' as const
      })
    }
    const config = request.config
    const fingerprint = request.fingerprint
    const devboxJson = request.devboxJson
    const marker = await runManaged(`test "$(cat -- .ready 2>/dev/null)" = ${quote(fingerprint)}`)
    if (marker.timedOut) throw new ToolchainAdapterError('timeout')
    if (marker.exitCode === 0) {
      await runReadiness()
      const activation = await runManaged('devbox shellenv --init-hook >/dev/null')
      if (activation.timedOut) throw new ToolchainAdapterError('timeout')
      if (activation.exitCode !== 0) throw new ToolchainAdapterError('activation_failed', activation.exitCode)
      this.ensureBashrc(state.containerId, state.workspacePath, state.workspaceMount, containerDir)
      return 'unchanged'
    }

    return trackSandboxSetupWork(this, sandboxId, 'toolchain_reconcile', async () => {
      await remove('.ready')
      await atomicWrite('devbox.json', devboxJson, '0600')
      if (config.setupScript) await atomicWrite('setup.sh', config.setupScript, '0700')
      else await remove('setup.sh')
      await request.reportStage('installing')
      let execution = await runManaged('devbox install -c .')
      if (execution.timedOut) throw new ToolchainAdapterError('timeout')
      if (execution.exitCode !== 0) throw new ToolchainAdapterError('install_failed', execution.exitCode)
      if (config.setupScript) {
        await request.reportStage('running_setup')
        execution = await runManaged(
          `cd ${quote(workRoot)} && devbox run -c ${quote(containerDir)} -- bash ${quote(`${containerDir}/setup.sh`)}`
        )
        if (execution.timedOut) throw new ToolchainAdapterError('timeout')
        if (execution.exitCode !== 0) throw new ToolchainAdapterError('setup_failed', execution.exitCode)
      }
      await runReadiness()
      execution = await runManaged('devbox shellenv --init-hook >/dev/null')
      if (execution.timedOut) throw new ToolchainAdapterError('timeout')
      if (execution.exitCode !== 0) throw new ToolchainAdapterError('activation_failed', execution.exitCode)
      this.ensureBashrc(state.containerId, state.workspacePath, state.workspaceMount, containerDir)
      await atomicWrite('.ready', `${fingerprint}\n`, '0600')
      return 'applied' as const
    })
  }

  spawnShell(sandboxId: string, cols: number, rows: number, workspacePath?: string): IPty | null {
    let containerId: string | null = null

    // Check in-memory cache first
    const sandbox = this.sandboxes.get(sandboxId)
    if (sandbox) {
      containerId = sandbox.containerId
      workspacePath = workspacePath || sandbox.workspacePath
    } else {
      // Check for existing container by name (e.g., after server restart)
      containerId = findSandboxContainer(sandboxId, (candidate) => this.getExistingContainer(candidate))
    }

    if (!containerId) {
      log.warn(`spawnShell: No container found for sandbox ${sandboxId}`)
      return null
    }

    // Verify container is running - start it if stopped
    if (!this.isContainerRunning(containerId)) {
      log.info(`spawnShell: Starting stopped container ${containerId}`)
      const startResult = Bun.spawnSync(['docker', 'start', containerId], { stdout: 'pipe', stderr: 'pipe' })
      if (startResult.exitCode !== 0) {
        log.error(`spawnShell: Failed to start container: ${startResult.stderr.toString()}`)
        return null
      }
      // Wait a moment for container to be fully ready
      Bun.spawnSync(['docker', 'exec', containerId, 'true'], { stdout: 'ignore', stderr: 'ignore' })
    }

    // Verify we can exec into the container before spawning PTY
    const testResult = Bun.spawnSync(['docker', 'exec', containerId, 'true'], { stdout: 'ignore', stderr: 'pipe' })
    if (testResult.exitCode !== 0) {
      log.error(`spawnShell: Container ${containerId} not ready for exec: ${testResult.stderr.toString()}`)
      return null
    }

    // Check if sandbox user exists, create if not (handles containers from before user setup)
    const dockerIdentity = this.resolveDockerExecIdentity(containerId)
    const userArgs = buildSandboxUserArgs(dockerIdentity)
    if (userArgs.length > 0) {
      const userCheck = Bun.spawnSync(['docker', 'exec', ...userArgs, containerId, 'true'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      if (userCheck.exitCode !== 0) {
        log.info(`spawnShell: Creating sandbox user in container ${containerId}`)
        const hostUid = process.getuid?.()
        const hostGid = process.getgid?.()
        if (hostUid != null && hostGid != null) {
          const { user, home } = dockerIdentity
          Bun.spawnSync(
            [
              'docker',
              'exec',
              containerId,
              'sh',
              '-c',
              `addgroup -g ${hostGid} ${user} 2>/dev/null || true; ` +
                `adduser -u ${hostUid} -G ${user} -D -h ${home} ${user} 2>/dev/null || true; ` +
                `chown -R ${hostUid}:${hostGid} ${home} 2>/dev/null || true`,
            ],
            { stdout: 'ignore', stderr: 'ignore' }
          )
        }
      }
    }

    // Use script wrapper to force proper TTY allocation.
    // Docker exec -t can be finicky with bun-pty's pseudo-TTY, but script handles it correctly.

    // Use devbox bashrc if it exists (created during sandbox init)
    const hasDevboxBashrc = workspacePath && fs.existsSync(workspaceDotPath(workspacePath, '.bashrc'))

    const shellWorkspaceMount = sandbox?.workspaceMount ?? containerWorkspaceLayout().workspaceMount
    // Inject the live Core URL so the terminal's `ficus` CLI reaches the current Core
    // even if the container baked a now-stale port. No token/password: the box is
    // shared with squad agents, so the terminal stays a token-free environment.
    const apiUrlArg = terminalApiUrlArgs(resolveDockerApiUrl())
    let dockerCmd: string
    if (hasDevboxBashrc) {
      dockerCmd = `docker exec ${userArgs.join(' ')} ${apiUrlArg} -it -w ${shellWorkspaceMount} ${containerId} bash --rcfile ${WORKSPACE_DOT_DIR}/.bashrc`
    } else {
      dockerCmd = `docker exec ${userArgs.join(' ')} ${apiUrlArg} -it -w ${shellWorkspaceMount} ${containerId} bash`
    }
    return ptySpawn('script', ['-q', '-c', dockerCmd, '/dev/null'], {
      name: 'xterm-256color',
      cols,
      rows,
    })
  }

  /**
   * Stop a sandbox container (but don't remove it).
   * The container can be restarted quickly on next use.
   * The nix store is preserved so installed packages persist.
   */
  async stopSandbox(sandboxId: string, options: { lifecycleGeneration?: string | null } = {}) {
    const sandbox = this.sandboxes.get(sandboxId)
    const requestedRef =
      sandbox?.containerId ??
      findSandboxContainer(sandboxId, (candidate) => this.getExistingContainer(candidate)) ??
      this.containerName(sandboxId)
    const immutableId = this.proveContainerOwnership(requestedRef, sandboxId, sandbox)
    if (!immutableId) {
      this.releaseSandboxState(sandboxId, sandbox)
      return { kind: 'not-found' } as const
    }
    const actualLifecycleGeneration = this.getContainerLabel(immutableId, (set) => set.lifecycleGenerationLabel) ?? null
    if (options.lifecycleGeneration !== undefined && actualLifecycleGeneration !== options.lifecycleGeneration) {
      log.warn(
        `Refusing stale sandbox stop for ${sandboxId}: expected generation ${options.lifecycleGeneration ?? 'legacy'}, actual ${actualLifecycleGeneration ?? 'legacy'}`
      )
      return { kind: 'generation-mismatch', actualLifecycleGeneration } as const
    }
    terminationIntentRegistry.record(sandboxId, 'manual')
    runDestructiveLifecycle({
      operation: 'stop',
      sandboxId,
      immutableId,
      containerName: this.containerName(sandboxId),
      execute: () => this.runLifecycleDocker(['stop', immutableLifecycleTarget(immutableId)]),
      inspect: () => this.inspectContainerRunning(immutableId),
      release: () => this.releaseSandboxState(sandboxId, sandbox),
    })
    return { kind: 'stopped' } as const
  }

  /**
   * Fully remove a sandbox container.
   * Use stopSandbox() for graceful shutdown; this is for permanent cleanup.
   */
  async removeSandbox(sandboxId: string, expectedWorkspacePath?: string): Promise<void> {
    terminationIntentRegistry.record(sandboxId, 'manual')
    const sandbox = this.sandboxes.get(sandboxId)
    // The tracked container plus every container found under any identity
    // prefix, so removal never leaves one behind under the other name.
    const found = findSandboxContainers(sandboxId, (candidate) => this.getExistingContainer(candidate))
    const requestedRefs = [...new Set([...(sandbox ? [sandbox.containerId] : []), ...found])]
    if (requestedRefs.length === 0) requestedRefs.push(this.containerName(sandboxId))
    // Prove EVERY candidate before touching any: one unproven container throws
    // here with nothing removed and the tracked state untouched.
    const proven = new Map<string, string>()
    for (const requestedRef of requestedRefs) {
      const immutableId = this.proveContainerOwnership(requestedRef, sandboxId, sandbox, expectedWorkspacePath)
      if (immutableId) proven.set(requestedRef, immutableId)
    }
    // The tracked container goes last, so a failed removal of another one
    // leaves the tracked state pointing at a container that still exists.
    const trackedId = sandbox ? proven.get(sandbox.containerId) : undefined
    const targets = [...new Set(proven.values())].filter((id) => id !== trackedId)
    if (trackedId) targets.push(trackedId)
    for (const immutableId of targets) this.removeProvenContainer(sandboxId, immutableId)
    this.releaseSandboxState(sandboxId, sandbox)
  }

  /** Remove one container whose ownership is already proven, by its immutable id. */
  private removeProvenContainer(sandboxId: string, immutableId: string): void {
    runDestructiveLifecycle({
      operation: 'remove',
      sandboxId,
      immutableId,
      containerName: this.containerName(sandboxId),
      execute: () => this.runLifecycleDocker(['rm', '-f', immutableLifecycleTarget(immutableId)]),
      inspect: () => this.inspectContainerRunning(immutableId),
      release: () => {},
    })
  }

  /**
   * Remove the duplicates of an adopted container found under another identity
   * prefix, so a sandbox never keeps a second box running beside the one Core
   * uses. Only proven containers are removed; an unproven one is left untouched
   * and logged.
   */
  private removeDuplicateContainers(sandboxId: string, duplicateRefs: string[], expectedWorkspacePath?: string): void {
    for (const ref of duplicateRefs) {
      let immutableId: string | undefined
      try {
        immutableId = this.proveContainerOwnership(ref, sandboxId, undefined, expectedWorkspacePath)
      } catch (error) {
        if (!(error instanceof DockerSandboxLifecycleError) || error.code !== 'LEGACY_OWNERSHIP_UNPROVEN') throw error
        log.warn(`Leaving unproven container ${ref} beside sandbox ${sandboxId}: its ownership is not proven`)
        continue
      }
      if (!immutableId) continue
      log.warn(`Removing duplicate container ${ref} of sandbox ${sandboxId} (another identity prefix)`)
      this.removeProvenContainer(sandboxId, immutableId)
    }
  }

  private releaseSandboxState(sandboxId: string, sandbox?: SandboxState): void {
    releaseTrackedState({
      sandboxId,
      containerId: sandbox?.containerId,
      close: sandbox?.client ? () => sandbox.client!.close() : undefined,
      deleteState: () => this.sandboxes.delete(sandboxId),
    })
  }

  /** Permanently reclaim a terminated personal agent's Docker-specific Nix store. */
  async reclaimSandboxStorage(sandboxId: string): Promise<void> {
    reclaimAgentNixStore(sandboxId)
  }

  /**
   * Translate a host path to the corresponding container path.
   */
  toContainerPath(sandboxId: string, hostPath: string): string {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) throw new Error(`No sandbox found for ${sandboxId}`)
    // Replace the workspace prefix with the container mount point
    const relative = path.relative(sandbox.workspacePath, hostPath)
    if (relative.startsWith('..')) {
      throw new Error(`Path ${hostPath} is outside workspace ${sandbox.workspacePath}`)
    }
    return path.join(sandbox.workspaceMount, relative)
  }

  /**
   * Execute a command inside the container and return stdout.
   * Throws on non-zero exit code.
   */
  async exec(sandboxId: string, args: string[]): Promise<Buffer> {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) throw new Error(`No sandbox found for ${sandboxId}`)

    const userArgs = this.getSandboxUserArgs(sandbox.containerId)
    const result = Bun.spawnSync(
      ['docker', 'exec', ...userArgs, '-w', sandbox.workspaceMount, sandbox.containerId, ...args],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim()
      throw new Error(stderr || `Command failed with exit code ${result.exitCode}`)
    }

    return Buffer.from(result.stdout)
  }

  async execWithStdin(sandboxId: string, args: string[], stdin: Buffer): Promise<Buffer> {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) throw new Error(`No sandbox found for ${sandboxId}`)
    const result = Bun.spawnSync(
      dockerExecWithStdinArgs(
        sandbox.containerId,
        sandbox.workspaceMount,
        this.getSandboxUserArgs(sandbox.containerId),
        args
      ),
      { stdin, stdout: 'pipe', stderr: 'pipe' }
    )
    if (result.exitCode !== 0) {
      throw new DockerSandboxLifecycleError({
        operation: 'exec-with-stdin',
        sandboxId,
        containerId: sandbox.containerId,
        reason: 'START_FAILED',
        stderr: result.stderr.toString(),
      })
    }
    return Buffer.from(result.stdout)
  }

  /**
   * Execute a command inside the container, returning exit code without throwing.
   */
  streamExec(
    sandboxId: string,
    args: string[],
    onStdout: (chunk: Buffer) => void,
    onStderr: (chunk: Buffer) => void = () => {}
  ): { cancel: () => void } {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) throw new Error(`No sandbox found for ${sandboxId}`)

    const userArgs = this.getSandboxUserArgs(sandbox.containerId)
    const proc = Bun.spawn(
      ['docker', 'exec', ...userArgs, '-w', sandbox.workspaceMount, sandbox.containerId, ...args],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )

    const pump = async (stream: ReadableStream<Uint8Array> | null, onChunk: (chunk: Buffer) => void) => {
      if (!stream) return
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          onChunk(Buffer.from(value))
        }
      } catch {
        // Cancellation/connection errors end the stream.
      }
    }

    pump(proc.stdout, onStdout)
    pump(proc.stderr, onStderr)

    return { cancel: () => proc.kill() }
  }

  streamLogs(
    sandboxId: string,
    opts: { tailLines?: number; follow?: boolean; previous?: boolean },
    onData: (chunk: Buffer) => void,
    onError?: (err: Error) => void
  ): { cancel: () => void } {
    if (opts.previous) {
      onError?.(new Error('Previous-container logs are not supported on the docker runtime'))
      return { cancel: () => {} }
    }
    const name =
      findSandboxContainer(sandboxId, (candidate) => this.getExistingContainer(candidate)) ??
      this.containerName(sandboxId)
    const proc = Bun.spawn(['docker', ...buildDockerLogsArgs(name, opts)], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const pump = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return
      for await (const chunk of stream) onData(Buffer.from(chunk))
    }
    pump(proc.stdout).catch((err) => onError?.(err as Error))
    pump(proc.stderr).catch(() => {})
    return { cancel: () => proc.kill() }
  }

  async execToolchainStatus(
    sandboxId: string,
    args: string[],
    timeoutMs: number
  ): Promise<{ exitCode: number; timedOut: boolean }> {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) return { exitCode: 1, timedOut: false }
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    const proc = Bun.spawn(
      [
        'docker',
        'exec',
        ...this.getSandboxUserArgs(sandbox.containerId),
        '-w',
        sandbox.workspaceMount,
        sandbox.containerId,
        'timeout',
        '--signal=TERM',
        '--kill-after=5',
        String(timeoutSeconds),
        ...args,
      ],
      { stdout: 'ignore', stderr: 'ignore' }
    )
    const result = await waitForDockerExec(proc, timeoutMs + 10_000)
    return result.exitCode === 124 ? { exitCode: 124, timedOut: true } : result
  }

  async execStatus(sandboxId: string, args: string[]): Promise<number> {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) return 1

    const userArgs = this.getSandboxUserArgs(sandbox.containerId)
    const result = Bun.spawnSync(
      ['docker', 'exec', ...userArgs, '-w', sandbox.workspaceMount, sandbox.containerId, ...args],
      {
        stdout: 'ignore',
        stderr: 'ignore',
      }
    )

    return result.exitCode
  }

  /**
   * Check if a sandbox exists and is running.
   */
  hasSandbox(sandboxId: string): boolean {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) return false
    return this.isContainerRunning(sandbox.containerId)
  }

  async getSandboxStatus(sandboxId: string): Promise<{ status: 'running' | 'not_found' | 'unknown' }> {
    // Present under any identity prefix counts; absent only when every name is authoritatively missing.
    let status: 'not_found' | 'unknown' = 'not_found'
    for (const name of sandboxContainerNames(sandboxId)) {
      const proc = Bun.spawn(['docker', 'inspect', name], {
        stdout: 'ignore',
        stderr: 'pipe',
      })
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      const result = classifyDockerInspectStatus(exitCode, stderr)
      if (result === 'running') return { status: 'running' }
      if (result === 'unknown') status = 'unknown'
    }
    return { status }
  }

  /**
   * The fixed docker container layout (`/workspace[/<squadId>]`, `/private`,
   * `/memory[/<squadId>]`) — env-independent.
   */
  getWorkspaceLayout(ctx: WorkspaceLayoutContext): WorkspaceLayout {
    return containerWorkspaceLayout(ctx)
  }

  /**
   * Get the runtime being used for a specific sandbox.
   */
  getSandboxRuntime(sandboxId: string): SandboxRuntime | null {
    const sandbox = this.sandboxes.get(sandboxId)
    return sandbox?.runtime ?? null
  }

  async getLocalDeploymentTarget(sandboxId: string, port: number): Promise<{ host: string; port: number }> {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) throw new Error(`No sandbox found for ${sandboxId}`)
    return { host: this.getContainerIp(sandbox.containerId), port }
  }

  /**
   * Stop all sandbox containers (called on shutdown).
   * Containers are stopped but not removed, allowing fast restart on next use.
   */
  async cleanup(): Promise<void> {
    await cleanupTrackedSandboxes(Array.from(this.sandboxes.keys()), async (id) => {
      await this.stopSandbox(id)
    })
  }

  /**
   * Get `docker exec` args for running as the sandbox user.
   * Returns `['--user', 'uid:gid', '-e', 'HOME=/home/ficus']` if a non-root
   * host user was detected, or an empty array to run as container root.
   */
  getClientForSandbox(sandboxId: string): SandboxClient | null {
    return this.sandboxes.get(sandboxId)?.client ?? null
  }

  resolveToolApiUrl(): string {
    return resolveDockerApiUrl()
  }

  private async connectActiveDrift(containerId: string, sandboxId: string): Promise<void> {
    try {
      await this.connectExecutor(containerId, sandboxId)
    } catch (error) {
      throw activeDriftError(error, sandboxId, containerId)
    }
  }

  private async connectExecutor(containerId: string, sandboxId: string): Promise<void> {
    // The container's OWN baked identity — never assumed. A legacy-labelled
    // container (adopted, not recreated, because it has an active session —
    // see connectActiveDrift) has a `tau` user and `/run/tau/...` paths; it // ficus-p5-bridge
    // has no `/run/ficus/...` executor-token file at all.
    const dockerIdentity = this.resolveDockerExecIdentity(containerId)
    let portResult = Bun.spawnSync(['docker', 'port', containerId, '50051/tcp'], { stdout: 'pipe', stderr: 'pipe' })
    let portMatch = portResult.stdout
      .toString()
      .trim()
      .match(/127\.0\.0\.1:(\d+)$/)
    for (let attempt = 0; (portResult.exitCode !== 0 || !portMatch) && attempt < 300; attempt++) {
      await Bun.sleep(100)
      portResult = Bun.spawnSync(['docker', 'port', containerId, '50051/tcp'], { stdout: 'pipe', stderr: 'pipe' })
      portMatch = portResult.stdout
        .toString()
        .trim()
        .match(/127\.0\.0\.1:(\d+)$/)
    }
    if (portResult.exitCode !== 0 || !portMatch)
      throw new DockerSandboxLifecycleError({
        operation: 'connect-executor',
        sandboxId,
        containerId,
        reason: 'START_FAILED',
        stderr: portResult.stderr.toString(),
      })
    let tokenResult = Bun.spawnSync(['docker', 'exec', containerId, 'cat', dockerIdentity.executorTokenPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    for (let attempt = 0; tokenResult.exitCode !== 0 && attempt < 300; attempt++) {
      await Bun.sleep(100)
      tokenResult = Bun.spawnSync(['docker', 'exec', containerId, 'cat', dockerIdentity.executorTokenPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
    }
    const token = tokenResult.stdout.toString().trim()
    if (tokenResult.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(token))
      throw new DockerSandboxLifecycleError({
        operation: 'read-executor-token',
        sandboxId,
        containerId,
        reason: 'EXECUTOR_MISSING',
        stderr: tokenResult.stderr.toString(),
      })
    const client = new SandboxClient(`127.0.0.1:${portMatch[1]}`, token)
    try {
      await client.waitForReady(30_000)
      // The expected identity contract follows the SAME container-reported
      // generation as the token path above: the current release's baked file
      // for a new-identity container, the fixed pre-release pair (never read
      // from a file — this release's checkout no longer has one) for a
      // legacy-identity one.
      const identity =
        dockerIdentity === DOCKER_EXEC_IDENTITY_NEW
          ? parseDockerCommandIdentity(
              fs.readFileSync(path.join(MONOREPO_ROOT, 'apps/core/docker-sandbox/command-identity.json'), 'utf8')
            )
          : LEGACY_DOCKER_COMMAND_IDENTITY_CONTRACT
      const expectedIdentity = resolveDockerCommandIdentity(identity, {
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      })
      validateDockerHealthContract(await client.health(), {
        user: expectedIdentity.user,
        home: expectedIdentity.home,
        uid: expectedIdentity.resolvedUid,
        gid: expectedIdentity.resolvedGid,
        source: expectedIdentity.source,
        contractDigest: expectedIdentity.contractDigest,
      })
      const state = this.sandboxes.get(sandboxId)
      if (!state) throw new Error('Sandbox state disappeared during executor connection')
      state.client?.close()
      state.client = client
    } catch (error) {
      client.close()
      throw error
    }
  }

  /**
   * `docker exec` args for running as the container's OWN sandbox user — read
   * from ITS labels (see {@link resolveDockerExecIdentity}), never assumed to
   * be the current release's. A legacy-labelled container has no `ficus`
   * user; `docker exec --user ficus` against one fails outright.
   */
  private getSandboxUserArgs(containerId: string): string[] {
    return buildSandboxUserArgs(this.resolveDockerExecIdentity(containerId))
  }

  private resolveImageContract(): DockerImageContract {
    return inspectDockerImageContract()
  }

  private proveContainerOwnership(
    ref: string,
    sandboxId: string,
    state?: SandboxState,
    expectedWorkspacePath?: string
  ): string | undefined {
    let result: { exitCode: number; stdout: Buffer; stderr: Buffer }
    try {
      result = this.runLifecycleDocker(['inspect', ref])
    } catch (cause) {
      throw new DockerSandboxLifecycleError({
        operation: 'prove-ownership',
        sandboxId,
        containerId: state?.containerId,
        containerName: this.containerName(sandboxId),
        reason: 'DOCKER_STATE_UNKNOWN',
        cause,
      })
    }
    if (result.exitCode !== 0) {
      if (classifyDockerInspectStatus(result.exitCode, result.stderr.toString()) === 'not_found') return undefined
      throw new DockerSandboxLifecycleError({
        operation: 'prove-ownership',
        sandboxId,
        containerId: state?.containerId,
        containerName: this.containerName(sandboxId),
        reason: 'DOCKER_STATE_UNKNOWN',
        stderr: result.stderr.toString(),
      })
    }
    let inspected: any
    try {
      inspected = JSON.parse(result.stdout.toString())?.[0]
    } catch {
      inspected = undefined
    }
    const ownership = classifyDockerContainerOwnership(
      inspected,
      sandboxId,
      state?.workspacePath ?? expectedWorkspacePath
    )
    if (ownership === 'unproven')
      // Name the container that failed the proof, which may carry another identity prefix.
      throw new DockerSandboxLifecycleError({
        operation: 'prove-ownership',
        sandboxId,
        containerId: typeof inspected?.Id === 'string' ? inspected.Id : state?.containerId,
        containerName:
          typeof inspected?.Name === 'string' ? inspected.Name.replace(/^\//, '') : this.containerName(sandboxId),
        reason: 'LEGACY_OWNERSHIP_UNPROVEN',
      })
    const immutableId = inspected?.Id
    if (typeof immutableId !== 'string' || !/^[a-f0-9]{64}$/.test(immutableId))
      throw new DockerSandboxLifecycleError({
        operation: 'prove-ownership',
        sandboxId,
        containerName: this.containerName(sandboxId),
        reason: 'DOCKER_STATE_UNKNOWN',
      })
    return immutableId
  }

  private runLifecycleDocker(args: string[]): { exitCode: number; stdout: Buffer; stderr: Buffer } {
    const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })
    return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr) }
  }

  private inspectContainerRunning(ref: string): 'running' | 'stopped' | 'not_found' | 'unknown' {
    let result: { exitCode: number; stdout: Buffer; stderr: Buffer }
    try {
      result = this.runLifecycleDocker(['inspect', '-f', '{{.State.Running}}', ref])
    } catch {
      return 'unknown'
    }
    if (result.exitCode !== 0) {
      return classifyDockerInspectStatus(result.exitCode, result.stderr.toString()) === 'not_found'
        ? 'not_found'
        : 'unknown'
    }
    const value = result.stdout.toString().trim()
    return value === 'true' ? 'running' : value === 'false' ? 'stopped' : 'unknown'
  }

  // --- Private helpers ---

  /**
   * Get the host IP reachable from Docker containers.
   * Uses the Docker bridge network gateway, falling back to 172.17.0.1.
   */
  private getDockerHostIp(): string {
    try {
      const result = Bun.spawnSync(
        ['docker', 'network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}'],
        { stdout: 'pipe', stderr: 'ignore' }
      )
      const ip = result.stdout.toString().trim()
      if (ip && result.exitCode === 0) return ip
    } catch (error) {
      log.error('Failed to get Docker host IP:', error)
      // fall through
    }
    return '172.17.0.1'
  }

  private getContainerIp(containerId: string): string {
    const result = Bun.spawnSync(
      ['docker', 'inspect', '-f', '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}', containerId],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    const ip = result.stdout.toString().trim()
    if (result.exitCode !== 0 || !ip) {
      const stderr = result.stderr.toString().trim()
      throw new Error(stderr || `Failed to inspect container IP for ${containerId}`)
    }
    return ip
  }

  private isContainerRunning(containerId: string): boolean {
    const result = Bun.spawnSync(['docker', 'inspect', '-f', '{{.State.Running}}', containerId], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    return result.stdout.toString().trim() === 'true'
  }

  private getContainerExitCode(containerId: string): number | undefined {
    try {
      const result = Bun.spawnSync(['docker', 'inspect', '-f', '{{.State.ExitCode}}', containerId], {
        stdout: 'pipe',
        stderr: 'ignore',
      })
      if (result.exitCode !== 0) return undefined
      return parseDockerExitCode(result.stdout.toString())
    } catch {
      return undefined
    }
  }

  private getContainerExitReason(containerId: string): string | undefined {
    try {
      const result = Bun.spawnSync(
        ['docker', 'inspect', '-f', '{{if .State.OOMKilled}}OOMKilled{{else}}{{.State.Error}}{{end}}', containerId],
        { stdout: 'pipe', stderr: 'ignore' }
      )
      if (result.exitCode !== 0) return undefined
      const reason = result.stdout.toString().trim()
      return reason || undefined
    } catch {
      return undefined
    }
  }

  /** A container's labels (by id or name), or null when it is gone or unreadable. */
  private getContainerLabels(containerRef: string): Record<string, string> | null {
    const result = Bun.spawnSync(['docker', 'inspect', '-f', '{{json .Config.Labels}}', containerRef], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (result.exitCode !== 0) return null
    try {
      const labels: unknown = JSON.parse(result.stdout.toString())
      return labels && typeof labels === 'object' && !Array.isArray(labels) ? (labels as Record<string, string>) : {}
    } catch {
      return null
    }
  }

  /**
   * A label value under any identity set (see {@link readSandboxLabel}), or null
   * when the container is gone or the label is missing or empty.
   */
  private getContainerLabel(containerRef: string, pick: (set: SandboxIdentitySet) => string): string | null {
    const labels = this.getContainerLabels(containerRef)
    if (!labels) return null
    return readSandboxLabel(labels, pick) || null
  }

  /**
   * The in-container exec identity (user/home/token path/docker-proxy socket)
   * a container ACTUALLY has baked in, read from its own labels — never
   * assumed to be the current release's. A legacy-labelled container (built
   * before this release) has a `tau` user and `/run/tau/...` paths; exec'ing // ficus-p5-bridge
   * into it with the new-only literals fails outright, which is exactly the
   * bug this resolves (an adopted-not-recreated legacy container must stay
   * reachable, not just discoverable).
   */
  private resolveDockerExecIdentity(containerRef: string): DockerExecIdentity {
    const labels = this.getContainerLabels(containerRef)
    return dockerExecIdentityForSet(labels ? identitySetForLabels(labels) : null)
  }

  /**
   * The create-time spec hash stamped on a container, or null when the container
   * is gone or was created before spec-hashing existed (no label). A null result
   * is treated as drift so pre-upgrade containers are recreated with the current
   * mount set.
   */
  private getContainerSpecHash(containerRef: string): string | null {
    return this.getContainerLabel(containerRef, (set) => set.specHashLabel)
  }

  private getExistingContainer(name: string): string | null {
    const result = Bun.spawnSync(['docker', 'ps', '-aq', '-f', `name=^${name}$`], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const id = result.stdout.toString().trim()
    return id || null
  }
}

// Singleton
