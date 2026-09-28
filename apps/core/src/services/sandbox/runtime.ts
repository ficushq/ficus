/**
 * Sandbox runtime selection predicates (FICUS_SANDBOX_RUNTIME).
 *
 * Pure leaf module: factory.ts (which imports every manager) re-exports these,
 * but modules the managers themselves depend on — e.g. workspace-layout — must
 * import from HERE to dispatch on the active runtime without creating an
 * import cycle through factory.
 */

/**
 * The complete, closed set of sandbox runtimes. FICUS_SANDBOX_RUNTIME must name
 * one of these EXACTLY: there is no default and no auto-detection, so a
 * misconfigured deployment fails at startup instead of silently running agents
 * on a runtime nobody chose.
 */
export const SANDBOX_RUNTIME_VALUES = ['docker-sysbox', 'docker-socket', 'k8s', 'vm', 'host'] as const

export type SandboxRuntimeValue = (typeof SANDBOX_RUNTIME_VALUES)[number]

/**
 * The configured runtime as the boot guard sees it: trimmed (a .env line or
 * shell export easily carries stray whitespace, and ` host ` is a typo rather
 * than a different runtime) but NEVER lowercased — the five values are exact,
 * so `Host` stays a real misconfiguration.
 *
 * EVERY predicate below and {@link requireSandboxRuntime} read through here.
 * When they did not, ` host ` passed the boot guard (which trimmed) while
 * `isHostRuntime()` compared the raw value and answered false — the factory
 * handed out the host manager while the layout/routing predicates said the
 * runtime was something else.
 */
function configuredRuntime(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.FICUS_SANDBOX_RUNTIME?.trim()
}

/** Returns true if `value` is one of the five supported runtime values. */
export function isKnownSandboxRuntimeValue(value: string | undefined): value is SandboxRuntimeValue {
  return SANDBOX_RUNTIME_VALUES.includes(value as SandboxRuntimeValue)
}

/** Returns true if the provided runtime value selects one of the Docker runtimes. */
export function isDockerRuntimeValue(runtime: string | undefined): boolean {
  const value = runtime?.trim()
  return value === 'docker-sysbox' || value === 'docker-socket'
}

/** Returns true if the configured runtime is one of the Docker runtimes. */
export function isDockerRuntime(): boolean {
  return isDockerRuntimeValue(configuredRuntime())
}

/** Legacy spellings that used to be accepted, mapped to their replacement hint. */
const LEGACY_HINTS: Record<string, string> = {
  sysbox: 'Use docker-sysbox.',
  socket: 'Use docker-socket.',
  auto: 'Auto-detection was removed — choose docker-sysbox or docker-socket.',
  docker: 'Auto-detection was removed — choose docker-sysbox or docker-socket.',
}

/**
 * Reads FICUS_SANDBOX_RUNTIME and returns it, or throws a single actionable error
 * naming every supported value. Called at api/worker startup so a bad (or
 * missing) setting kills the process loudly rather than surfacing later as a
 * confusing sandbox failure on the first agent turn.
 */
export function requireSandboxRuntime(env: Record<string, string | undefined> = process.env): SandboxRuntimeValue {
  const raw = configuredRuntime(env)
  if (isKnownSandboxRuntimeValue(raw)) return raw
  const got = raw === undefined || raw === '' ? 'is unset' : `got "${raw}"`
  // Object.hasOwn, not a bare lookup: `LEGACY_HINTS['toString']` answers with
  // Object.prototype's method and used to splice its source into the message.
  const hint =
    (raw !== undefined && Object.hasOwn(LEGACY_HINTS, raw) && LEGACY_HINTS[raw]) ||
    'Set it in .env (see docs/wiki/sandbox-runtimes.md)'
  throw new Error(`FICUS_SANDBOX_RUNTIME must be one of ${SANDBOX_RUNTIME_VALUES.join(', ')} (${got}). ${hint}`)
}

/** Returns true if the provided runtime value selects Kubernetes sandboxes. */
export function isK8sRuntimeValue(runtime: string | undefined): boolean {
  return runtime?.trim() === 'k8s'
}

/** Returns true if the runtime is configured to use Kubernetes sandboxes. */
export function isK8sRuntime(): boolean {
  return isK8sRuntimeValue(configuredRuntime())
}

/** Returns true if the provided runtime value selects VM ("box") sandboxes. */
export function isVmRuntimeValue(runtime: string | undefined): boolean {
  return runtime?.trim() === 'vm'
}

/** Returns true if the runtime is configured to use VM ("box") sandboxes. */
export function isVmRuntime(): boolean {
  return isVmRuntimeValue(configuredRuntime())
}

/** Returns true if the provided runtime value selects the host (no-sandbox) runtime. */
export function isHostRuntimeValue(runtime: string | undefined): boolean {
  return runtime?.trim() === 'host'
}

/**
 * Returns true if the runtime is configured to run agents directly on the
 * core's own machine as the process user — no container, box, or executor.
 */
export function isHostRuntime(): boolean {
  return isHostRuntimeValue(configuredRuntime())
}

/**
 * Returns true for the "remote" runtimes (k8s + vm) whose sandboxes are reached
 * over HTTP via a {@link SandboxClient} and expose a live `getSandboxStatus`.
 * Docker sandboxes are local and have no such status surface. Routes that query
 * live status / grab a client gate on this so both remote runtimes take the same
 * path (the vm manager was built to mirror the k8s shapes exactly).
 */
export function isRemoteSandboxRuntimeValue(runtime: string | undefined): boolean {
  return isK8sRuntimeValue(runtime) || isVmRuntimeValue(runtime)
}

/** Returns true if the configured runtime is a remote (k8s or vm) runtime. */
export function isRemoteSandboxRuntime(): boolean {
  return isRemoteSandboxRuntimeValue(configuredRuntime())
}

/**
 * Returns true only for a LOCAL k8s (k3d) dev cluster: the configured runtime
 * is `k8s` AND FICUS_K8S_LOCAL=true.
 *
 * Every FICUS_K8S_* key is a strict SUBSET of the k8s runtime — none of them may
 * change behaviour, or outrank FICUS_SANDBOX_RUNTIME, when another runtime is
 * configured. A checkout that moves from local k3d to host/docker keeps the
 * stale `FICUS_K8S_LOCAL=true` line in its .env; read bare, that line kept the
 * self-updater planning `bun run k3d:import` on a host-runtime install. Read
 * through here, a stale key is inert.
 */
export function isLocalK8sMode(env: Record<string, string | undefined> = process.env): boolean {
  return isK8sRuntimeValue(configuredRuntime(env)) && env.FICUS_K8S_LOCAL?.trim() === 'true'
}

const K8S_ENV_PREFIX = 'FICUS_K8S_'

/**
 * The FICUS_K8S_* keys that carry a value while the configured runtime is NOT
 * `k8s`, sorted — i.e. the keys this deployment is deliberately ignoring.
 * Empty under the k8s runtime (there they are honoured) and empty when nothing
 * is set. Boot logs it once so an operator sees the stale lines instead of
 * assuming they still do something.
 */
export function ignoredK8sEnvKeys(env: Record<string, string | undefined> = process.env): string[] {
  if (isK8sRuntimeValue(configuredRuntime(env))) return []
  return Object.keys(env)
    .filter((key) => key.startsWith(K8S_ENV_PREFIX) && (env[key]?.trim() ?? '') !== '')
    .sort()
}

/**
 * One boot-warning line naming {@link ignoredK8sEnvKeys}, or undefined when
 * there are none.
 *
 * The "FICUS_SANDBOX_RUNTIME is unset" wording is unreachable from the api/worker
 * boot call sites — they run after {@link requireSandboxRuntime} has already
 * exited the process on an unset/unknown value — and exists only so any other
 * caller cannot get a message reading `FICUS_SANDBOX_RUNTIME=undefined`.
 */
export function ignoredK8sEnvWarning(env: Record<string, string | undefined> = process.env): string | undefined {
  const keys = ignoredK8sEnvKeys(env)
  if (keys.length === 0) return undefined
  const runtime = configuredRuntime(env)
  const active = runtime ? `FICUS_SANDBOX_RUNTIME=${runtime}` : 'FICUS_SANDBOX_RUNTIME is unset'
  const [verb, pronoun] = keys.length === 1 ? ['is', 'it'] : ['are', 'them']
  return `${keys.join(', ')} ${verb} set but ${active} — ignoring ${pronoun} (they apply only to the k8s runtime)`
}
