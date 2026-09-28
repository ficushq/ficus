/**
 * Runtime Selection Factory
 *
 * Provides a unified interface to select Docker or K8s sandbox managers
 * and tools based on the FICUS_SANDBOX_RUNTIME environment variable.
 *
 * Both managers are lazily instantiated on first use.
 */

import type { ISandboxManager } from './types'
import {
  isK8sRuntimeValue,
  isVmRuntimeValue,
  isHostRuntimeValue,
  isDockerRuntimeValue,
  requireSandboxRuntime,
} from './runtime'
import { DockerSandboxManager, selectRuntime } from './docker/manager'
import { K8sSandboxManager } from './k8s/manager'
import { VmSandboxManager } from './vm/manager'
import { HostSandboxManager } from './host/manager'
import { createDockerSandboxedCodingTools, type SandboxedToolWithKey } from '../../tools/docker-sandbox'
import { createK8sSandboxedCodingTools } from '../../tools/k8s-sandbox'
import { createHostSandboxedCodingTools } from '../../tools/host-sandbox'
import { createLogger } from '../../lib/infra/logger'
import { parseDockerImageContract } from './docker/runtime-contract'

const log = createLogger('sandbox')

/** Cached manager singletons (lazily initialized) */
let _dockerManager: ISandboxManager | null = null
let _k8sManager: ISandboxManager | null = null
let _vmManager: ISandboxManager | null = null
let _hostManager: ISandboxManager | null = null

// Runtime predicates live in the pure leaf module ./runtime (so manager-side
// modules like workspace-layout can dispatch on the active runtime without a
// cycle through this factory); re-exported here for existing importers.
export {
  isK8sRuntimeValue,
  isK8sRuntime,
  isVmRuntimeValue,
  isVmRuntime,
  isHostRuntimeValue,
  isHostRuntime,
  isRemoteSandboxRuntimeValue,
  isRemoteSandboxRuntime,
} from './runtime'

function getDockerManager(): ISandboxManager {
  if (!_dockerManager) {
    _dockerManager = new DockerSandboxManager()
  }
  return _dockerManager
}

/**
 * Whether THIS process owns periodic sandbox maintenance — today the k8s
 * manager's 60s squad-pod reconcile pass.
 *
 * Both entry points build a sandbox manager — the API needs one for the request
 * path (ensure/exec/spawnShell) — so without an owner both processes ran the
 * identical fleet-wide pass every 60s: the same active-squad scans, the same
 * per-pod health calls, the same bashrc writes, twice. The worker claims it at
 * module load (worker.ts), mirroring the vm runtime, whose lifecycle runner is
 * likewise started only from the worker.
 *
 * The pod manager's idle sweep is NOT part of this: it reaps only the pods its
 * own process tracks in memory, so both processes must keep running it.
 */
let _runsPeriodicSandboxMaintenance = false

/**
 * Claim periodic sandbox maintenance for this process. Call at entry-point
 * module load, before any manager can be lazily constructed; if one already
 * exists (a request path built it first) its loop is armed now.
 */
export function claimPeriodicSandboxMaintenance(): void {
  _runsPeriodicSandboxMaintenance = true
  if (_k8sManager) (_k8sManager as K8sSandboxManager).startPeriodicMaintenance()
}

export function runsPeriodicSandboxMaintenance(): boolean {
  return _runsPeriodicSandboxMaintenance
}

function getK8sManager(): ISandboxManager {
  if (!_k8sManager) {
    _k8sManager = new K8sSandboxManager(undefined, { runPeriodicLoops: _runsPeriodicSandboxMaintenance })
  }
  return _k8sManager
}

function getVmManager(): ISandboxManager {
  if (!_vmManager) {
    _vmManager = new VmSandboxManager()
  }
  return _vmManager
}

function getHostManager(): ISandboxManager {
  if (!_hostManager) _hostManager = new HostSandboxManager()
  return _hostManager
}

/**
 * Returns the sandbox manager for an EXPLICIT runtime value. There is no
 * default: an unset, legacy, or unknown value throws {@link requireSandboxRuntime}'s
 * error rather than quietly falling through to Docker.
 *
 * - FICUS_SANDBOX_RUNTIME=docker-sysbox | docker-socket: Docker sandbox manager
 * - FICUS_SANDBOX_RUNTIME=k8s: Kubernetes-based sandbox manager
 * - FICUS_SANDBOX_RUNTIME=vm: VM ("box") sandbox manager
 * - FICUS_SANDBOX_RUNTIME=host: host (no-sandbox) manager
 */
export function getSandboxManagerForRuntime(rawRuntime: string | undefined): ISandboxManager {
  // Trimmed to match requireSandboxRuntime: anything the boot guard accepts
  // must dispatch here, or ` host ` would boot and then die on the
  // "unreachable" fallthrough below on the first agent turn.
  const runtime = rawRuntime?.trim()
  if (isK8sRuntimeValue(runtime)) return getK8sManager()
  if (isVmRuntimeValue(runtime)) return getVmManager()
  if (isHostRuntimeValue(runtime)) return getHostManager()
  if (isDockerRuntimeValue(runtime)) return getDockerManager()
  // Not a supported value — raise the one canonical error naming all five.
  requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: runtime })
  // Unreachable: requireSandboxRuntime throws for every value that reaches here.
  throw new Error(`Unsupported FICUS_SANDBOX_RUNTIME: ${runtime}`)
}

export function getSandboxManager(): ISandboxManager {
  return getSandboxManagerForRuntime(process.env.FICUS_SANDBOX_RUNTIME)
}

/**
 * Creates coding tools (Read, Write, Edit, Bash) for the specified sandbox.
 *
 * Returns Docker or K8s sandboxed tools based on the runtime configuration.
 */
export function createCodingTools(
  workspacePath: string,
  sandboxId: string,
  tauToken?: string,
  squadId?: string,
  invocationOwnerId?: string,
  agentId?: string
): SandboxedToolWithKey[] {
  // Dispatch on the EXPLICIT value, same closed set as getSandboxManagerForRuntime.
  // Docker is a NAMED case below, not a fallthrough: an unset or legacy
  // FICUS_SANDBOX_RUNTIME used to hand the agent Docker tools by default.
  const runtime = requireSandboxRuntime()
  if (isK8sRuntimeValue(runtime)) {
    const manager = getK8sManager() as K8sSandboxManager
    return createK8sSandboxedCodingTools(
      workspacePath,
      sandboxId,
      manager,
      tauToken,
      squadId,
      invocationOwnerId,
      agentId
    )
  }
  if (isVmRuntimeValue(runtime)) {
    // The vm manager mirrors the k8s client-based tool surface (getClientForSandbox,
    // getSandboxStatus, resolveToolApiUrl), so it reuses the same HTTP tool path.
    const manager = getVmManager() as VmSandboxManager
    return createK8sSandboxedCodingTools(
      workspacePath,
      sandboxId,
      manager,
      tauToken,
      squadId,
      invocationOwnerId,
      agentId
    )
  }
  if (isHostRuntimeValue(runtime)) {
    return createHostSandboxedCodingTools(workspacePath, sandboxId, tauToken, squadId, invocationOwnerId, agentId)
  }
  if (isDockerRuntimeValue(runtime)) {
    return createDockerSandboxedCodingTools(workspacePath, sandboxId, tauToken, squadId, invocationOwnerId, agentId)
  }
  // Unreachable: requireSandboxRuntime above returns one of exactly five values,
  // and all five are named. Present so adding a sixth is a compile/runtime
  // error here rather than a silent docker default.
  throw new Error(`Unsupported FICUS_SANDBOX_RUNTIME: ${runtime}`)
}

/**
 * Validate that the sandbox environment is properly configured.
 * FICUS_SANDBOX_RUNTIME must name one of the five supported runtimes (no default,
 * no auto-detection); for the Docker runtimes this also checks that the sandbox
 * image exists locally. Throws a clear error at startup rather than failing
 * silently when creating sandboxes.
 */
export function validateSandboxSetup(): void {
  const configured = requireSandboxRuntime()

  if (isK8sRuntimeValue(configured)) return // K8s pulls images from a registry
  if (isVmRuntimeValue(configured)) return // VM boxes run the sandbox-server on a machine, no local image

  if (isHostRuntimeValue(configured)) {
    const bash = Bun.which('bash')
    if (!bash) throw new Error('FICUS_SANDBOX_RUNTIME=host requires `bash` on PATH')
    const user = process.env.USER ?? String(process.getuid?.() ?? 'unknown')
    log.warn(
      `Sandbox runtime is HOST: agents run UNSANDBOXED on this machine as user "${user}" with full filesystem access. ` +
        'Use docker, k8s, or vm for isolation.'
    )
    return
  }

  const runtime = selectRuntime()
  const image = process.env.FICUS_SANDBOX_IMAGE || 'tau-sandbox:latest'

  // Check if the sandbox image exists locally
  const result = Bun.spawnSync(['docker', 'image', 'inspect', image], {
    stdout: 'pipe',
    stderr: 'ignore',
  })

  if (result.exitCode !== 0) {
    const msg =
      `Sandbox image "${image}" not found locally (runtime: ${runtime}). ` +
      `Sandboxes will not work until the image is built.\n` +
      `  Build it with: bun run sandbox:build:docker`
    log.error(msg)
    throw new Error(msg)
  }

  let inspect: unknown
  try {
    inspect = JSON.parse(result.stdout.toString())
  } catch {
    inspect = []
  }
  parseDockerImageContract(image, inspect)
  log.info(`Sandbox image "${image}" has a compatible runtime contract (runtime: ${runtime})`)
}
