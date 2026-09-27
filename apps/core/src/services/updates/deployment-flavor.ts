/**
 * Deployment-flavor detection for the self-updater (#627). The updater's
 * commands are hardcoded source constants; the flavor only SELECTS among them
 * (which restart commands, whether the k3d sandbox task applies) and gates
 * auto-updates on shapes we can actually update (git checkout + a supervisor
 * we know how to restart).
 */
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { MONOREPO_ROOT } from '../../lib/paths'
import { isArtifactDeployment, readArtifactManifest } from '../machines/machine-prebuilt'
import { isLocalK8sMode } from '../sandbox/runtime'

export type UpdateSource = 'git-checkout' | 'artifact' | 'unknown'

/** A full, lowercase git object name — what `git rev-parse HEAD` prints. */
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/
export type ProcessSupervisor = 'pm2' | 'systemd' | 'launchd' | 'systemd-user' | 'desktop' | 'unknown'
export type SandboxRuntimeFlavor = 'k3d-local' | 'k8s' | 'vm' | 'host' | 'docker-sysbox' | 'docker-socket' | 'other'

export interface DeploymentFlavor {
  source: UpdateSource
  supervisor: ProcessSupervisor
  sandboxRuntime: SandboxRuntimeFlavor
}

/**
 * Resolves the git checkout root by walking up from `start` to the nearest
 * ancestor containing a `.git` entry. The merged setup toolkit runs the services
 * with `WorkingDirectory=<dest>/apps/core` (so `process.cwd()` is a subdirectory)
 * while the checkout root — and the `.git` dir plus the root package scripts the
 * updater invokes — live at `<dest>`. A bare-cwd check would detect
 * `source='unknown'` on every real install and gate the updater fully off.
 *
 * Falls back to `start` unchanged when no ancestor has a `.git` (preserving the
 * prior "unknown" behavior for genuinely non-checkout installs). The walk stops
 * at the filesystem root (`dirname(dir) === dir`).
 */
export function resolveRepoRoot(start: string = process.cwd()): string {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

export function detectDeploymentFlavor(
  options: {
    repoRoot?: string
    cwd?: string
    env?: Record<string, string | undefined>
    /**
     * Where to look for `artifact.json` (spec §4.1). Defaults to
     * MONOREPO_ROOT — the real constant an actual artifact deployment carries
     * it at — and is a parameter only so tests can point it at a fixture
     * without a real artifact tree above MONOREPO_ROOT.
     */
    artifactRoot?: string
  } = {}
): DeploymentFlavor {
  const env = options.env ?? process.env
  return {
    source: detectSource(options),
    supervisor: detectSupervisor(env),
    sandboxRuntime: detectSandboxRuntime(env),
  }
}

/**
 * Artifact detection takes priority: a shipped release artifact never has a
 * `.git` dir, so if it did fall through to the git-checkout check below it
 * would (correctly, but less usefully) land on 'unknown' — checking artifact
 * first gives it its own honest label instead. A malformed/incomplete
 * manifest (missing or non-40-hex `commit`) still counts as an artifact TREE
 * but not a resolvable one, so it reports 'unknown' rather than fabricating
 * an identity — same "malformed → never throw, report honest unknown"
 * posture as {@link readArtifactManifest} itself.
 */
function detectSource(options: { repoRoot?: string; cwd?: string; artifactRoot?: string }): UpdateSource {
  const artifactRoot = options.artifactRoot ?? MONOREPO_ROOT
  if (isArtifactDeployment(artifactRoot)) {
    const commit = readArtifactManifest(artifactRoot)?.commit
    return commit !== undefined && COMMIT_SHA_RE.test(commit) ? 'artifact' : 'unknown'
  }
  const repoRoot = options.repoRoot ?? resolveRepoRoot(options.cwd ?? process.cwd())
  return existsSync(join(repoRoot, '.git')) ? 'git-checkout' : 'unknown'
}

function detectSupervisor(env: Record<string, string | undefined>): ProcessSupervisor {
  if (env.FICUS_DESKTOP_MANAGED === '1') return 'desktop'
  const override = env.FICUS_UPDATE_SUPERVISOR
  if (override === 'pm2' || override === 'systemd' || override === 'launchd' || override === 'systemd-user')
    return override
  // pm2 sets pm_id/PM2_HOME on managed children; systemd sets INVOCATION_ID
  // for every service it starts.
  if (env.pm_id !== undefined || env.PM2_HOME !== undefined) return 'pm2'
  if (env.INVOCATION_ID !== undefined) return 'systemd'
  return 'unknown'
}

function detectSandboxRuntime(env: Record<string, string | undefined>): SandboxRuntimeFlavor {
  // FICUS_SANDBOX_RUNTIME decides, always and first. The toolkit writes exactly
  // one of the five supported values; each maps to its own honest label for
  // status display, and anything else (including the removed 'auto'/'docker'
  // spellings, which no longer start the core at all) reports 'other'.
  //
  // k3d-local is the ONLY flavor whose sandbox image is rebuilt/imported
  // locally (bun run k3d:import), and it is a REFINEMENT of the k8s runtime:
  // k8s plus FICUS_K8S_LOCAL=true, which scripts/k3d-dev.sh sets for local dev
  // and the setup toolkit never sets on a real host. A plain k8s is a *server*
  // runtime that pulls images from a registry, so it keeps the distinct 'k8s'
  // flavor and never picks up the k3d import task.
  //
  // FICUS_K8S_LOCAL used to be read BEFORE the runtime, which made a stale line
  // in .env outrank it: a checkout moved from local k3d to host kept reporting
  // k3d-local and had `k3d:import` planned into every update.
  switch (env.FICUS_SANDBOX_RUNTIME?.trim()) {
    case 'k8s':
      return isLocalK8sMode(env) ? 'k3d-local' : 'k8s'
    case 'vm':
      return 'vm'
    case 'host':
      return 'host'
    case 'docker-sysbox':
      return 'docker-sysbox'
    case 'docker-socket':
      return 'docker-socket'
    default:
      return 'other'
  }
}

export function supportsAutoUpdate(flavor: DeploymentFlavor): { ok: boolean; reason?: string } {
  if (flavor.supervisor === 'desktop')
    return {
      ok: false,
      reason: 'This instance is managed by Ficus Desktop. Update it through the desktop application.',
    }
  if (flavor.source === 'artifact') {
    return {
      ok: false,
      reason: 'Install runs a prebuilt release artifact; upgrades are managed by the control plane.',
    }
  }
  if (flavor.source !== 'git-checkout') {
    return { ok: false, reason: 'Install is not a git checkout; the updater only supports git-based installs.' }
  }
  if (flavor.supervisor === 'unknown') {
    return {
      ok: false,
      reason:
        'Unknown process supervisor; set FICUS_UPDATE_SUPERVISOR=pm2, =systemd, =launchd, or =systemd-user to enable updates.',
    }
  }
  return { ok: true }
}
