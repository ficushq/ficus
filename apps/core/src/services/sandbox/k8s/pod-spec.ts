/**
 * Sandbox pod-spec construction.
 *
 * Everything that decides WHAT a sandbox pod looks like — image selection,
 * resource budgets, volume/mount routing, env vars, probes, naming — lives
 * here as pure(ish) functions with explicit inputs. The K8sPodManager decides
 * WHEN pods are created/terminated and owns cluster I/O.
 */

import * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../../../lib/infra/logger'
import { getSecretStore } from '../../secrets/store'
import { gitIdentityEnv, resolveGitHubIdentity } from '../github-identity'
import { getHomeDir } from '../../../lib/utils/home'
import { getSandboxSkillsDir } from '../../agent/skill-materializer'
import { resolveSandboxAssets } from '../asset-manifest'
import { containerWorkspaceLayout } from '../workspace-layout'
import { K8S_STAGED_CLI_SUBPATH, SANDBOX_CLI_PATH } from '../cli-path'
import { isLocalK8sMode } from '../runtime'
import { WORKSPACE_DOT_DIR } from '../../workspace/dot-dir'
import { SANDBOX_IDENTITY_WRITE, sandboxPodNamePrefixes } from '../identity-names'
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  EXECUTOR_PORT,
  HEADLESS_SERVICE_NAME,
  IS_LOCAL_DEV,
  SANDBOX_AUTH_SECRET_NAME,
} from './constants'

const log = createLogger('k8s-pod-manager')

/** Sandbox type: squad sandboxes get memory/SSH mounts; agent/system-manager sandboxes are lightweight. */
export type SandboxType = 'squad' | 'agent' | 'system-manager'

export interface SquadSandboxConfig {
  /** Sandbox type. Defaults to 'squad' for backward compatibility. */
  sandboxType?: SandboxType
  /** Idle timeout in milliseconds before pod is terminated */
  idleTimeout?: number
  /** If true, pod is never terminated due to inactivity */
  alwaysOn?: boolean
  /** K8s RuntimeClass name (e.g., 'sysbox-runc' for Docker-in-Docker support) */
  runtimeClass?: string
  /**
   * Per-squad override for the pod's ephemeral-storage limit, in GiB. Use for
   * squads with heavy toolchains (swift/rust/go/tectonic) whose fresh nix
   * install exceeds the global default. Falls back to
   * SANDBOX_EPHEMERAL_STORAGE_LIMIT when unset.
   */
  ephemeralStorageLimitGi?: number
  /** Squad ID (drives subPath selection and git identity on K8s; consumed by Task 5) */
  squadId?: string
  /** PVC subPath key for the per-agent /private volume (K8s only; consumed by Task 5) */
  privateStorageKey?: string
}

export function getSandboxImage(
  opts: { sandboxType?: SandboxType; isLocalDev?: boolean; env?: Record<string, string | undefined> } = {}
): string {
  const env = opts.env ?? process.env
  const isLocalDev = opts.isLocalDev ?? isLocalK8sMode(env)
  // Agent (light) boxes run a stripped-down image; everything else runs the full image.
  if (opts.sandboxType === 'agent') {
    return (
      env.FICUS_SANDBOX_AGENT_IMAGE ||
      (isLocalDev ? 'ficus-registry:5000/ficus-sandbox-agent:latest' : 'ficus-sandbox-agent:latest')
    )
  }
  return env.FICUS_SANDBOX_IMAGE || (isLocalDev ? 'ficus-registry:5000/ficus-sandbox:latest' : 'ficus-sandbox:latest')
}

export function getSandboxImagePullPolicy(_opts: { isLocalDev?: boolean } = {}): 'Always' {
  return 'Always'
}

/**
 * Resolve the Core API URL a sandbox should use to reach `ficus` CLI / callbacks.
 *
 * In local dev the Core runs on the host (k3d routes `host.k3d.internal` to it)
 * on a *dynamic* port, so this is recomputed from the live `PORT` on every bash
 * command — the value baked into a pod at creation goes stale the moment the Core
 * restarts on a different port, which orphans long-lived pods ("Unable to connect").
 * In cluster mode the URL is stable Service DNS, so the baked value never drifts.
 *
 * `opts` mirrors getSandboxImage's testability seam (defaults to module/process state).
 */
export function resolveSandboxApiUrl(namespace: string, opts: { isLocalDev?: boolean; port?: string } = {}): string {
  const isLocalDev = opts.isLocalDev ?? IS_LOCAL_DEV
  if (isLocalDev) {
    const port = opts.port ?? process.env.PORT ?? '3000'
    return `http://host.k3d.internal:${port}`
  }
  const coreNamespace = namespace.replace('ficus-sandboxes', 'ficus-core')
  return `http://ficus-api.${coreNamespace}.svc.cluster.local:3000`
}

/** Exported for the death notifier, which reports the limit a killed pod ran under. */
export const SANDBOX_MEMORY_LIMIT = process.env.FICUS_SANDBOX_MEMORY_LIMIT || (IS_LOCAL_DEV ? '8Gi' : '4Gi')
// A squad sandbox really does use this: measured 7.0GiB on the dev cluster's
// busiest squad, against this 10Gi request. Calibrated — leave it alone.
const SANDBOX_SQUAD_EPHEMERAL_STORAGE_REQUEST = process.env.FICUS_SANDBOX_SQUAD_EPHEMERAL_STORAGE_REQUEST || '10Gi'
/**
 * Ephemeral storage RESERVED for an agent sandbox. Like the CPU request above,
 * this is subtracted from node capacity for the pod's whole life, so it — not
 * actual disk use — decides how many agent sandboxes fit on a node.
 *
 * Measured on the dev cluster 2026-08-09 across 18 live sandboxes: agent pods
 * used a **median of 0MiB and a maximum of 4.7MiB**. The old 2Gi request was
 * therefore ~400x the observed peak, and it became the binding constraint the
 * moment the CPU request was corrected: with 71.5GiB allocatable, 2Gi apiece
 * capped the node at ~35 agent sandboxes and pinned ephemeral allocation at
 * 97% while CPU sat at 43%.
 *
 * 256Mi keeps ~50x headroom over the measured peak and lifts the ceiling to
 * ~280, which puts CPU (~140) back in front as the limiting resource. The
 * ephemeral LIMIT is unchanged, so a sandbox that genuinely fills its disk is
 * still evicted on its own budget rather than taking the node down with it —
 * the request governs scheduling, the limit governs blast radius.
 *
 * Agent sandboxes are light by construction (the squad box holds the workspace
 * and toolchain); if that ever stops being true, raise this deliberately rather
 * than discovering it through evictions.
 */
const SANDBOX_AGENT_EPHEMERAL_STORAGE_REQUEST = process.env.FICUS_SANDBOX_AGENT_EPHEMERAL_STORAGE_REQUEST || '256Mi'
const SANDBOX_EPHEMERAL_STORAGE_LIMIT = process.env.FICUS_SANDBOX_EPHEMERAL_STORAGE_LIMIT || '10Gi'
/**
 * CPU the scheduler RESERVES for every sandbox, busy or idle. This single value
 * decides how many agents fit on a node; nothing else does.
 *
 * It is deliberately far below the cpu LIMIT (2 cores) below. A request is not
 * a cap — it is the floor the scheduler subtracts from node capacity up front
 * and holds for the pod's entire life, while the limit is what an agent may
 * burst to while it actually works. Sizing the request for the busy case prices
 * every idle sandbox as though it were mid-turn.
 *
 * Measured on the dev cluster 2026-08-09 across 24 live agent sandboxes: 1m CPU
 * and ~21Mi memory each at rest. The previous hardcoded 500m was therefore a
 * ~500x over-request, capping a 14-core node at ~28 sandboxes regardless of
 * actual load — and that ceiling was hit: 27 sandboxes, every one belonging to
 * an IDLE agent, took the node to 97% of CPU requests while 11 further agents
 * sat Pending (one for 52 minutes) on `0/1 nodes are available: 1 Insufficient
 * cpu`. Each blocked sandbox then burns a 5-minute pod-ready timeout, and that
 * retry pile-up leaked memory in ficus-api until it stopped serving entirely.
 *
 * 100m keeps ~50-100x headroom over the measured idle draw while raising the
 * per-node ceiling to ~140. Under real contention CFS shares are proportional
 * to requests, so a working agent still gets its share and can burst to the
 * 2-core limit whenever the node is not saturated.
 */
const SANDBOX_CPU_REQUEST = process.env.FICUS_SANDBOX_CPU_REQUEST || '100m'
// Cap the Docker-in-Docker emptyDir so a sandbox that fills /var/lib/docker (image/layer churn) is
// evicted on its OWN budget rather than silently consuming node disk and tipping the whole node into
// DiskPressure (which evicts every sandbox at once). Kept below the ephemeral-storage limit so the
// container layer + logs still have headroom.
const SANDBOX_DOCKER_STORAGE_LIMIT = process.env.FICUS_SANDBOX_DOCKER_STORAGE_LIMIT || '8Gi'

// Upper bound for a per-squad ephemeral-storage override, so a misconfigured
// squad can't request more disk than any node could schedule.
const MAX_EPHEMERAL_STORAGE_LIMIT_GI = 200

/**
 * Resolve the pod's ephemeral-storage limit. A per-squad override (in GiB) wins
 * when it's a positive integer within bounds; otherwise the global env default
 * applies.
 */
export function resolveEphemeralStorageLimit(overrideGi?: number): string {
  if (
    typeof overrideGi === 'number' &&
    Number.isInteger(overrideGi) &&
    overrideGi > 0 &&
    overrideGi <= MAX_EPHEMERAL_STORAGE_LIMIT_GI
  ) {
    return `${overrideGi}Gi`
  }
  return SANDBOX_EPHEMERAL_STORAGE_LIMIT
}

// Pod annotation carrying the hash below, so spec drift survives core restarts
// (the live pod is the source of truth, not in-memory state). New pods carry the
// write set's key; readers accept every read set (readSandboxLabel).
export const SPEC_HASH_ANNOTATION = SANDBOX_IDENTITY_WRITE.k8sSpecHashAnnotation
export const SANDBOX_EXECUTOR_PROTOCOL_VERSION = 'write-verified-v1'

/**
 * Hash of the pod-spec fields that are immutable on a running pod and therefore
 * require recreation to change (the resolved ephemeral-storage limit, the
 * squad membership that determines the squad-scoped mounts, and where the CLI
 * is mounted). When a sandbox's
 * config changes, the desired hash diverges from the running pod's annotation,
 * which drift detection uses to recreate it instead of adopting a stale pod.
 */
export function reconcilableSpecHash(
  config?: SquadSandboxConfig,
  executorProtocolVersion = SANDBOX_EXECUTOR_PROTOCOL_VERSION
): string {
  const reconcilable = {
    executorProtocolVersion,
    ephemeralStorage: resolveEphemeralStorageLimit(config?.ephemeralStorageLimitGi),
    // squadId selects the squad-scoped mounts (/workspace/<id>, /memory/<id>),
    // which can't be added to a running pod — so a solo box (no squadId) must
    // NOT be adopted for a squad member (and vice-versa); the differing hash
    // forces recreation. Modeled as a sorted array so multi-squad membership
    // (future: an agent in several squads) extends without changing the hash
    // shape or churning existing single-squad pods — today it's [] or [squadId].
    squadIds: config?.squadId ? [config.squadId] : [],
    // The CLI's mount path. A pod created before the CLI was `ficus` carries a
    // stamp without this field, so it drifts and is recreated once idle (the
    // spec-drift gates: no active agent session / an idle squad); a busy one is
    // kept until then. Changing the path later recreates pods the same way.
    cliMountPath: SANDBOX_CLI_PATH,
  }
  return createHash('sha256').update(JSON.stringify(reconcilable)).digest('hex').slice(0, 16)
}

function getSharedVolumeGid(): number | undefined {
  const configured = process.env.FICUS_SANDBOX_SHARED_GID
  const gid = configured
    ? Number(configured)
    : IS_LOCAL_DEV && typeof process.getgid === 'function'
      ? process.getgid()
      : undefined
  return gid !== undefined && Number.isInteger(gid) && gid >= 0 ? gid : undefined
}

function ensureLocalSharedSubPath(path: string): void {
  if (!IS_LOCAL_DEV) return
  try {
    mkdirSync(path, { recursive: true })
    chmodSync(path, 0o2775)
  } catch (err) {
    log.warn(`Failed to prepare local k8s shared path ${path}:`, err)
  }
}

/** K8s RuntimeClass for sandbox pods. Defaults to sysbox-runc for secure DinD. Set to '' to disable. */
const RUNTIME_CLASS = process.env.FICUS_K8S_RUNTIME_CLASS ?? 'sysbox-runc'

/**
 * In local dev (k3d), read the host IP written by `scripts/k3d-dev.sh` and
 * inject it into each pod's hostAliases so `host.k3d.internal` resolves via
 * /etc/hosts. k3d's --host-alias flag is unreliable across versions
 * (silently dropped in v5.8.3); kubelet-managed hostAliases is the durable
 * path. Returns null if the file is missing — caller should warn.
 */
const getHostIpFile = () => join(getHomeDir(), '.k3d-host-ip')

export function readK3dHostIp(): string | null {
  try {
    const ip = readFileSync(getHostIpFile(), 'utf8').trim()
    return ip || null
  } catch {
    return null
  }
}

/**
 * Sanitize a sandbox ID into a K8s pod name under the given prefix (default
 * the write prefix) — lowercase, ≤63 chars, hashed when truncated.
 */
export function sandboxPodName(sandboxId: string, prefix: string = SANDBOX_IDENTITY_WRITE.k8sPodNamePrefix): string {
  const sanitized = sandboxId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const name = `${prefix}${sanitized}`
  // K8s hostnames must be ≤63 characters. If too long, truncate and append
  // a short hash of the full sanitized ID to avoid collisions.
  if (name.length <= 63) return name
  const hash = Bun.hash(sanitized).toString(36).slice(0, 8)
  return `${name.slice(0, 63 - 9).replace(/-$/, '')}-${hash}`
}

/**
 * Every pod name a sandbox may carry: the write name first, then each other
 * read name — mirrors {@link sandboxContainerNames} for Docker. A pod built
 * under a prefix this release does not write (e.g. the legacy `tau-sb-`
 * prefix) is still found, adopted, and cleaned up by trying every name here,
 * never left running beside a freshly created pod under the write name.
 */
export function sandboxPodNames(sandboxId: string): string[] {
  return sandboxPodNamePrefixes().map((prefix) => sandboxPodName(sandboxId, prefix))
}

/** Sanitize a value into a valid K8s label value (≤63 chars, hashed when truncated). */
export function sanitizeLabelValue(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
  const label = sanitized || 'sandbox'
  if (label.length <= 63) return label
  const hash = Bun.hash(label).toString(36).slice(0, 8)
  return `${label.slice(0, 63 - 9).replace(/[^a-z0-9]+$/g, '')}-${hash}`
}

/**
 * Build env vars for sandbox pods.
 * Reads git credentials and config from the secret store (set via Settings UI).
 */
async function buildSandboxEnv(input: {
  sandboxId: string
  squadId: string
  namespace: string
}): Promise<k8s.V1EnvVar[]> {
  const { sandboxId, squadId, namespace } = input
  const store = getSecretStore()

  // Baked default. NOTE: in local dev this captures the Core's port at pod
  // creation; the per-command bash env re-injects the *live* URL (see
  // createHttpBashOperations) so a Core restart on a new port doesn't orphan
  // the pod's `ficus` CLI. The cluster-mode URL is stable Service DNS.
  const apiUrl = resolveSandboxApiUrl(namespace)

  const sharedVolumeGid = getSharedVolumeGid()
  const env: k8s.V1EnvVar[] = [
    { name: 'FICUS_SANDBOX_ID', value: sandboxId },
    { name: 'FICUS_SQUAD_ID', value: squadId },
    { name: 'FICUS_API_URL', value: apiUrl },
    { name: 'FICUS_SANDBOX_UMASK', value: process.env.FICUS_SANDBOX_UMASK || '0002' },
    ...(sharedVolumeGid !== undefined ? [{ name: 'FICUS_SHARED_GID', value: String(sharedVolumeGid) }] : []),
  ]

  // Public APP_URL so agents can reference it in bash commands
  const appUrl = process.env.APP_URL
  if (appUrl) env.push({ name: 'APP_URL', value: appUrl })

  // Git credentials and config from squad override/global fallback resolver
  const githubIdentity = await resolveGitHubIdentity(squadId)

  for (const [name, value] of Object.entries(gitIdentityEnv(githubIdentity))) env.push({ name, value })

  // In local dev mode, pass the sandbox callback secret directly as env var.
  // In cluster mode, it's mounted via the K8s Secret volume.
  // NOTE: FICUS_PASSWORD is intentionally NOT injected — agents authenticate via the
  // per-command FICUS_TOKEN, and the shared legacy password is a dead credential
  // under multi-admin setups (pure exfil surface in a box shared with agents).
  if (IS_LOCAL_DEV) {
    const sandboxCallbackSecret = store.get('SANDBOX_CALLBACK_SECRET')
    if (sandboxCallbackSecret) env.push({ name: 'SANDBOX_CALLBACK_SECRET', value: sandboxCallbackSecret })
  }

  return env
}

export interface BuildPodSpecInput {
  sandboxId: string
  podName: string
  namespace: string
  config?: SquadSandboxConfig
}

export interface BuildPodSpecDeps {
  /** Env-var builder seam — defaults to the secret-store/git-identity backed one. */
  buildEnv?: (input: {
    sandboxId: string
    squadId: string
    namespace: string
  }) => Promise<k8s.V1EnvVar[]> | k8s.V1EnvVar[]
}

export async function buildSandboxPodSpec(input: BuildPodSpecInput, deps: BuildPodSpecDeps = {}): Promise<k8s.V1Pod> {
  const { sandboxId, podName, namespace, config } = input
  const buildEnv = deps.buildEnv ?? buildSandboxEnv

  const sandboxType = config?.sandboxType ?? 'squad'
  const isSquad = sandboxType === 'squad'
  // Agent (light) boxes boot fast (no dockerd gate) — probe sooner so pod-ready
  // isn't held back by the conservative squad-box floor.
  const isAgentPod = sandboxType === 'agent'
  const squadKey = config?.squadId

  let hostAliases: k8s.V1HostAlias[] | undefined
  if (IS_LOCAL_DEV) {
    const hostIp = readK3dHostIp()
    if (hostIp) {
      hostAliases = [{ ip: hostIp, hostnames: ['host.k3d.internal'] }]
    } else {
      log.warn(
        `Local dev mode but ${getHostIpFile()} is missing — host.k3d.internal won't resolve in ${podName}. Re-run cluster setup: bun run k3d:setup`
      )
    }
  }

  // For squad sandboxes, extract squad ID from sandboxId (e.g., "squad_abc123" -> "abc123")
  // For agent sandboxes, use the full sandboxId as the workspace key
  const storageKey = isSquad ? (sandboxId.startsWith('squad_') ? sandboxId.slice(6) : sandboxId) : sandboxId

  // Compute workspace subPath once to avoid repeating the three-way ternary in the IS_LOCAL_DEV
  // block and in the volumeMounts array.
  const workspaceSubPath = squadKey
    ? `workspaces/squads/${squadKey}`
    : isSquad
      ? `workspaces/squads/${storageKey}`
      : `workspaces/agents/${storageKey}`

  // Solo (non-squad) agents have no /workspace at all — they work in /private
  // (mounted below). Only squad members + the squad warm box mount a /workspace.
  const isSoloAgent = sandboxType === 'agent' && !squadKey

  // Resolve runtime class: config override > env var > undefined
  const runtimeClass = config?.runtimeClass || RUNTIME_CLASS || undefined

  // Resolve ephemeral-storage limit: per-squad override > env default.
  const ephemeralStorageLimit = resolveEphemeralStorageLimit(config?.ephemeralStorageLimitGi)

  if (IS_LOCAL_DEV) {
    const homeDir = getHomeDir()
    // Solo agents don't mount /workspace, so skip creating its backing dir.
    if (!isSoloAgent) ensureLocalSharedSubPath(join(homeDir, workspaceSubPath))
    ensureLocalSharedSubPath(getSandboxSkillsDir(sandboxId))
    if (isSquad || squadKey) {
      const sharedKey = squadKey ?? storageKey
      // Members (sandboxType 'agent') no longer mount squad memory — only the
      // squad box needs its backing dir. Members still mount ssh, prepped below.
      if (sandboxType !== 'agent') ensureLocalSharedSubPath(join(homeDir, `memory/${sharedKey}`))
      ensureLocalSharedSubPath(join(homeDir, `ssh/${sharedKey}`))
      // Agent boxes don't use the shared nix-cache, so don't create its subPath.
      if (sandboxType !== 'agent') ensureLocalSharedSubPath(join(homeDir, `nix-cache/${sharedKey}`))
    }
    if (config?.privateStorageKey) {
      ensureLocalSharedSubPath(join(homeDir, `private/${config.privateStorageKey}`))
    }
  }

  // Resolve the workspace mount from the layout resolver (squad-namespaced when a squad key is present).
  const layoutSquadId = squadKey ?? (isSquad ? storageKey : undefined)
  const { workspaceMount, memoryMount, privateMount } = containerWorkspaceLayout({ squadId: layoutSquadId })

  // Build volume mounts based on sandbox type. Solo agents have no /workspace
  // (they work in /private, mounted below); squad members + the squad warm box
  // mount the shared squad workspace here.
  const volumeMounts: k8s.V1VolumeMount[] = []
  if (!isSoloAgent) {
    volumeMounts.push({
      name: 'core-data',
      mountPath: workspaceMount,
      subPath: workspaceSubPath,
    })
  }
  volumeMounts.push(
    {
      name: 'core-data',
      mountPath: SANDBOX_CLI_PATH,
      subPath: K8S_STAGED_CLI_SUBPATH,
      readOnly: true,
    },
    {
      name: 'sandbox-auth',
      mountPath: '/etc/ficus',
      readOnly: true,
    }
  )

  // Docker-in-Docker needs its own filesystem to avoid nested overlayfs.
  // Without this, the inner dockerd's overlay mounts fail with "invalid argument"
  // because overlayfs-on-overlayfs is not supported.
  volumeMounts.push({
    name: 'docker-storage',
    mountPath: '/var/lib/docker',
  })

  // Per-asset subPath mounts (skills / memory / ssh) come straight from the
  // shared asset manifest — the single source of truth every runtime delivers
  // from, with no per-runtime special cases. `squadId`/`role` mirror the vm
  // file-sync derivation; resolveSandboxAssets falls back to the sandboxId
  // prefix for squadId. Only assets with a `pvcSubPath` get a k8s subPath mount:
  // identity rides the /private mount and squad-env rides the workspace mount,
  // so neither exposes one and both are skipped. Scope is the manifest's job —
  // a solo agent resolves to skills only; a squad MEMBER to skills + ssh (NO
  // memory: squad memory lives only on the squad box, accessed core-side via the
  // memory_* tools); a squad BOX to skills + memory + ssh.
  const assets = await resolveSandboxAssets({ sandboxId, squadId: squadKey, role: sandboxType })
  for (const { asset, source } of assets) {
    if (!source.pvcSubPath) continue
    // Resolve the manifest's logical dest to the pod-side mount path.
    const mountPath =
      asset.dest.base === 'skills'
        ? getSandboxSkillsDir(sandboxId)
        : asset.dest.base === 'memory'
          ? memoryMount
          : // SSH keys are NOT mounted at /root/.ssh: the host API needs host-user
            // write access while OpenSSH requires root:root 700 inside the
            // container. The entrypoint mirrors this source dir into a
            // container-private /root/.ssh and applies strict perms there.
            asset.dest.base === 'ssh'
            ? '/var/lib/ficus/ssh-source'
            : null
    if (mountPath === null) {
      throw new Error(
        `k8s pod-spec: asset '${asset.name}' has a pvcSubPath but no k8s mount path for dest.base='${asset.dest.base}'`
      )
    }
    volumeMounts.push({
      name: 'core-data',
      mountPath,
      subPath: source.pvcSubPath,
      // The ssh-source is writable (the entrypoint mirrors + re-perms it into
      // /root/.ssh); every other delivered asset is mounted read-only.
      ...(asset.dest.base === 'ssh' ? {} : { readOnly: true }),
    })
  }

  // The shared nix-cache is NOT a delivered asset (it's a shared build cache
  // volume, not per-sandbox material). Squad warm boxes keep it; agent (light)
  // boxes are minimal and a solo agent has no squad cache.
  if ((isSquad || squadKey) && sandboxType !== 'agent') {
    const sharedKey = squadKey ?? storageKey
    volumeMounts.push({
      name: 'core-data',
      mountPath: '/nix-cache',
      subPath: `nix-cache/${sharedKey}`,
    })
  }

  // Per-agent private storage: mounted read-write when a privateStorageKey is provided
  if (config?.privateStorageKey) {
    volumeMounts.push({
      name: 'core-data',
      mountPath: privateMount,
      subPath: `private/${config.privateStorageKey}`,
    })
  }

  const sharedVolumeGid = getSharedVolumeGid()

  const containerEnv = await buildEnv({
    sandboxId,
    squadId: squadKey ?? (isSquad ? storageKey : ''),
    namespace,
  })
  containerEnv.push({ name: 'WORKSPACE_PATH', value: isSoloAgent ? privateMount : workspaceMount })

  // Agent boxes are minimal: no nix-cache, no dockerd, personal devbox in /private
  // (every agent box works in /private; squad members additionally see the shared
  // squad workspace). The entrypoint + server read these.
  const sandboxRole = sandboxType === 'agent' ? 'agent' : 'squad'
  const devboxDir = sandboxType === 'agent' ? privateMount : workspaceMount
  containerEnv.push({ name: 'FICUS_SANDBOX_ROLE', value: sandboxRole })
  containerEnv.push({ name: 'FICUS_DEVBOX_DIR', value: devboxDir })
  containerEnv.push({ name: 'FICUS_TOOLCHAIN_DIR', value: `${devboxDir}/${WORKSPACE_DOT_DIR}/toolchain` })

  const podSpec: k8s.V1Pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace,
      labels: {
        app: SANDBOX_IDENTITY_WRITE.k8sAppLabelValue,
        'ficus.sh/sandbox-id': sanitizeLabelValue(sandboxId),
        'ficus.sh/sandbox-type': sandboxType,
        ...(isSquad ? { 'ficus.sh/squad-id': sanitizeLabelValue(storageKey) } : {}),
      },
      annotations: {
        'ficus.sh/idle-timeout': String(config?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS),
        'ficus.sh/always-on': String(config?.alwaysOn ?? false),
        [SPEC_HASH_ANNOTATION]: reconcilableSpecHash(config),
        // CRI-O requires this annotation for user namespace support (sysbox)
        ...(runtimeClass ? { 'io.kubernetes.cri-o.userns-mode': 'auto:size=65536' } : {}),
      },
    },
    spec: {
      restartPolicy: 'OnFailure',
      // Make the pod's volume mounts group-readable by the host API user so
      // the API (running on the host as a non-root user) can read/write
      // ~/.ficus/{memory,ssh,workspaces,nix-cache}/<squadId>. Without this,
      // the kubelet creates subPath dirs as root and container-root writes
      // land as uid 0 on the host, locking the API out.
      securityContext: sharedVolumeGid
        ? {
            fsGroup: sharedVolumeGid,
            // 'Always' (not 'OnRootMismatch') — the kubelet checks ownership at
            // the volume root, but we mount nested subPaths whose dirs may have
            // been created by an earlier pod as root. OnRootMismatch would skip
            // the recurse whenever the volume root happens to match, leaving the
            // nested subPath dir locked to host uid 0.
            fsGroupChangePolicy: 'Always',
          }
        : undefined,
      // hostname + subdomain enable DNS resolution via the headless service:
      // <podName>.<serviceName>.<namespace>.svc.cluster.local
      hostname: podName,
      subdomain: HEADLESS_SERVICE_NAME,
      // In local dev, inject host.k3d.internal directly into /etc/hosts —
      // see readK3dHostIp() above for why this can't rely on k3d's
      // --host-alias or CoreDNS NodeHosts.
      ...(hostAliases ? { hostAliases } : {}),
      // Runtime class for DinD support (e.g., sysbox-runc)
      // Sysbox provides user namespace isolation — no need for init containers
      // or explicit runAsUser; the entrypoint runs as root inside the user
      // namespace (which is unprivileged on the host).
      ...(runtimeClass ? { runtimeClassName: runtimeClass } : {}),
      // Run pod in a user namespace (required for sysbox on K8s 1.30+)
      ...(runtimeClass ? { hostUsers: false } : {}),

      // Main container: sandbox (runs as root in sysbox user namespace)
      containers: [
        {
          name: 'sandbox',
          image: getSandboxImage({ sandboxType, isLocalDev: IS_LOCAL_DEV }),
          // In local dev without sysbox, run privileged so dockerd can
          // create network namespaces, iptables rules, and cgroups.
          // In production, sysbox provides this via user namespace isolation.
          ...(IS_LOCAL_DEV && !runtimeClass ? { securityContext: { privileged: true } } : {}),
          // Always pull on pod creation. In local dev, this pulls from the
          // compose-managed local registry so rebuilt :latest images are picked up
          // even if an older layer is still cached on the k3d node.
          imagePullPolicy: getSandboxImagePullPolicy({ isLocalDev: IS_LOCAL_DEV }),
          ports: [{ containerPort: EXECUTOR_PORT, name: 'http' }],
          resources: {
            requests: {
              cpu: SANDBOX_CPU_REQUEST,
              memory: '256Mi',
              'ephemeral-storage': isAgentPod
                ? SANDBOX_AGENT_EPHEMERAL_STORAGE_REQUEST
                : SANDBOX_SQUAD_EPHEMERAL_STORAGE_REQUEST,
            },
            limits: {
              cpu: '2',
              memory: SANDBOX_MEMORY_LIMIT,
              'ephemeral-storage': ephemeralStorageLimit,
            },
          },
          // Startup probe: allows slow first boot (devbox install, dockerd start).
          // Checks every 5s for up to 5 minutes before declaring failure.
          // Liveness/readiness probes don't start until startup probe passes.
          startupProbe: {
            httpGet: {
              path: '/healthz',
              port: EXECUTOR_PORT,
            },
            initialDelaySeconds: isAgentPod ? 1 : 5,
            periodSeconds: isAgentPod ? 2 : 5,
            timeoutSeconds: 3,
            failureThreshold: 60,
          },
          readinessProbe: {
            httpGet: {
              path: '/healthz',
              port: EXECUTOR_PORT,
            },
            periodSeconds: 5,
            timeoutSeconds: 3,
            failureThreshold: 3,
          },
          livenessProbe: {
            httpGet: {
              path: '/healthz',
              port: EXECUTOR_PORT,
            },
            periodSeconds: 15,
            timeoutSeconds: 10,
            failureThreshold: 6,
          },
          volumeMounts,
          env: containerEnv,
        },
      ],

      volumes: [
        {
          name: 'core-data',
          persistentVolumeClaim: { claimName: 'ficus-core-data' },
        },
        {
          name: 'sandbox-auth',
          secret: {
            secretName: SANDBOX_AUTH_SECRET_NAME,
            optional: true, // Don't block pod start if secret doesn't exist yet
          },
        },
        // Ephemeral volume for Docker-in-Docker storage.
        // Without this, the inner dockerd's overlayfs operations fail on top
        // of the container's own overlayfs (nested overlayfs not supported).
        {
          name: 'docker-storage',
          emptyDir: { sizeLimit: SANDBOX_DOCKER_STORAGE_LIMIT },
        },
      ],

      // Pod affinity: prefer co-location with ficus-core pods
      affinity: {
        podAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [
            {
              weight: 100,
              podAffinityTerm: {
                labelSelector: {
                  matchLabels: {
                    app: 'ficus-core',
                  },
                },
                topologyKey: 'kubernetes.io/hostname',
              },
            },
          ],
        },
      },
    },
  }

  return podSpec
}
