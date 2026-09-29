/**
 * Build the environment for processes spawned by the sandbox executor
 * (bash command runs and the interactive PTY shell).
 *
 * The sandbox is an isolated runtime with its own image, pod env, and
 * per-command preamble that re-derives PATH/LD_LIBRARY_PATH/etc. Child
 * processes therefore do NOT need to inherit the executor's full
 * process.env. We allowlist a minimal set of variables that downstream
 * tooling (bash, git, gh, devbox/Nix, locale-aware programs) actually
 * needs, and fall back to safe sandbox defaults for anything missing.
 *
 * Caller-supplied overrides are applied last, with safety exclusions still
 * enforced for SSH agent and Kubernetes service variables.
 *
 * Excluded by design:
 *   - SSH_AUTH_SOCK / SSH_AGENT_PID / SSH_CLIENT / SSH_TTY / SSH_CONNECTION
 *     The sandbox uses mounted keys at /root/.ssh, never a host agent.
 *   - KUBERNETES_* and pod service env (<SVC>_PORT*, <SVC>_SERVICE_*)
 *   - Executor-internal vars (EXECUTOR_PORT, WORKSPACE_PATH)
 *   - DOCKER_HOST (mutated by docker.ts on purpose), except a vm box's own
 *     rootless socket
 *   - TMPDIR / LD_LIBRARY_PATH / PLAYWRIGHT_* (re-set by runtime-env.sh)
 */

const EXACT_ALLOW = new Set<string>([
  // Build-parallelism knobs: box-provision.sh derives defaults from FICUS_BOX_CPUS
  // (applyParallelismDefaults); an operator may pin them explicitly in host.env.
  'CARGO_BUILD_JOBS',
  'MAKEFLAGS',
  'GOMAXPROCS',
  'CMAKE_BUILD_PARALLEL_LEVEL',
  // POSIX/shell basics
  'HOME',
  'USER',
  'LOGNAME',
  'HOSTNAME',
  'PATH',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'TZ',
  // Ficus-injected, agent-facing
  'APP_URL',
  // Git/GitHub auth (pod-injected)
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GIT_USER_NAME',
  'GIT_USER_EMAIL',
  // git's OWN identity variables. Distinct from GIT_USER_* above, which are
  // tau's names and which git ignores — those work only because the image
  // translates them into `git config --global`, and global config LOSES to a
  // repo-local [user] section. Agents clone repos themselves, so tau has no
  // per-repo hook to clean a stale one up; these four outrank every config
  // file and are the only thing that cannot be shadowed. Omitting them here
  // silently strips them before `git` ever runs (this allowlist gates every
  // agent bash/PTY child), which made the identity fix a no-op on k8s and VM.
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  // TLS bundles (Nix sets these)
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
])

const PREFIX_ALLOW = ['FICUS_', 'LC_', 'NIX_', 'DEVBOX_', 'XDG_']

const DEFAULTS: Record<string, string> = {
  HOME: '/root',
  PATH: '/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  SHELL: '/bin/bash',
  TERM: 'xterm-256color',
}

function isAllowed(key: string): boolean {
  if (isBlocked(key)) return false
  if (EXACT_ALLOW.has(key)) return true
  return PREFIX_ALLOW.some((p) => key.startsWith(p))
}

function isBlocked(key: string): boolean {
  return key.startsWith('SSH_') || key.startsWith('KUBERNETES_') || isKubernetesServiceEnv(key)
}

function isKubernetesServiceEnv(key: string): boolean {
  return /(^|_)PORT(_|$)/.test(key) || /(^|_)SERVICE_(HOST|PORT)$/.test(key)
}

export function buildSandboxChildEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
  overrides?: Record<string, string | undefined>
): Record<string, string> {
  const out: Record<string, string> = {}

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (!isAllowed(key)) continue
    out[key] = value
  }

  // A vm box's own rootless docker socket. Commands reached it only because the
  // cached devbox shellenv used to re-export the executor's whole environment
  // (see shellenvProcessEnv), so pass it on explicitly. k8s never sets
  // FICUS_BOX_HOME, and docker.ts clears DOCKER_HOST there.
  if (source.FICUS_BOX_HOME && source.DOCKER_HOST) out.DOCKER_HOST = source.DOCKER_HOST

  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (out[key] === undefined) out[key] = value
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) continue
      if (isBlocked(key)) continue
      out[key] = value
    }
  }

  applyParallelismDefaults(out)
  return out
}

/**
 * Build-parallelism defaults derived from FICUS_BOX_CPUS (written by
 * box-provision.sh into ~/.tau/host.env as half the host's cores, matching the
 * slice's CPUQuota). Without these, one box's `cargo test` spawns a rustc per
 * core and pins the whole machine host. Applied last and only where nothing
 * (source env or caller overrides) already set a value, so explicit choices
 * always win. Ignored when FICUS_BOX_CPUS is absent or not a positive integer.
 */
function applyParallelismDefaults(out: Record<string, string>): void {
  const raw = out.FICUS_BOX_CPUS
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return
  const defaults: Record<string, string> = {
    CARGO_BUILD_JOBS: raw,
    MAKEFLAGS: `-j${raw}`,
    GOMAXPROCS: raw,
    CMAKE_BUILD_PARALLEL_LEVEL: raw,
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (out[key] === undefined) out[key] = value
  }
}
