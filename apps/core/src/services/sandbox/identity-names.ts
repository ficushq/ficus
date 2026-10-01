/**
 * Every name that marks a sandbox as Core's own: the docker container prefix and
 * labels, the image-contract label namespace, and the k8s spec-hash annotation
 * and `app` label value.
 *
 * Adoption and GC recognise a sandbox under ANY set in {@link SANDBOX_IDENTITY_READ};
 * create and label paths write only {@link SANDBOX_IDENTITY_WRITE}. Reading both
 * sets one release before writing the new one means a rollback target always
 * recognises what the newer release created, so a sandbox is never orphaned
 * (left running under a name nobody looks for) or double-created (a second box
 * started beside one that was not found).
 */

export interface SandboxIdentitySet {
  /** Docker container name prefix; the sandbox id follows it. */
  containerPrefix: string
  /** Docker label set to `'true'` on every managed sandbox container. */
  managedLabel: string
  /** Docker label carrying the sandbox id. */
  sandboxIdLabel: string
  /** Docker label carrying the create-time spec hash. */
  specHashLabel: string
  /** Docker label carrying the lifecycle generation that created the container. */
  lifecycleGenerationLabel: string
  /** Docker label carrying the immutable image id the container was created from. */
  imageIdLabel: string
  /** Namespace of the sandbox image's runtime-contract labels (`<ns>.managed`, …). */
  imageLabelNamespace: string
  /** k8s pod annotation carrying the reconcilable spec hash. */
  k8sSpecHashAnnotation: string
  /** k8s `app` label value on sandbox pods. */
  k8sAppLabelValue: string
  /** k8s pod name prefix; the sanitized sandbox id (or its prepull variant) follows it. */
  k8sPodNamePrefix: string
}

export const SANDBOX_IDENTITY_NEW: SandboxIdentitySet = {
  containerPrefix: 'ficus-sandbox-',
  managedLabel: 'ficus.managed',
  sandboxIdLabel: 'ficus.sandbox-id',
  specHashLabel: 'ficus.spec-hash',
  lifecycleGenerationLabel: 'ficus.lifecycle-generation',
  imageIdLabel: 'ficus.image-id',
  imageLabelNamespace: 'sh.ficus.sandbox',
  k8sSpecHashAnnotation: 'ficus.sh/spec-hash',
  k8sAppLabelValue: 'ficus-sandbox',
  k8sPodNamePrefix: 'ficus-sb-',
}

export const SANDBOX_IDENTITY_LEGACY: SandboxIdentitySet = {
  containerPrefix: 'tau-sandbox-', // ficus-p5-bridge
  managedLabel: 'tau.managed', // ficus-p5-bridge
  sandboxIdLabel: 'tau.sandbox-id', // ficus-p5-bridge
  specHashLabel: 'tau.spec-hash', // ficus-p5-bridge
  lifecycleGenerationLabel: 'tau.lifecycle-generation', // ficus-p5-bridge
  imageIdLabel: 'tau.image-id', // ficus-p5-bridge
  imageLabelNamespace: 'io.hiretau.sandbox', // ficus-p5-bridge
  k8sSpecHashAnnotation: 'tau.io/spec-hash', // ficus-p5-bridge
  k8sAppLabelValue: 'tau-sandbox', // ficus-p5-bridge
  k8sPodNamePrefix: 'tau-sb-', // ficus-p5-bridge
}

/** The set new sandboxes are created and labelled with. The new set as of this release. */
export const SANDBOX_IDENTITY_WRITE: SandboxIdentitySet = SANDBOX_IDENTITY_NEW

/** Every set a sandbox is recognised under, new first. */
export const SANDBOX_IDENTITY_READ: readonly SandboxIdentitySet[] = [SANDBOX_IDENTITY_NEW, SANDBOX_IDENTITY_LEGACY]

/** Label value for a key under any read set; undefined when absent. */
export function readSandboxLabel(
  labels: Record<string, string>,
  pick: (s: SandboxIdentitySet) => string
): string | undefined {
  for (const set of SANDBOX_IDENTITY_READ) {
    const value = labels[pick(set)]
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Every container name a sandbox may carry: the write name first, then each
 * other read name. Lookups try them in this order.
 */
export function sandboxContainerNames(sandboxId: string): string[] {
  const prefixes = [SANDBOX_IDENTITY_WRITE, ...SANDBOX_IDENTITY_READ].map((set) => set.containerPrefix)
  return [...new Set(prefixes)].map((prefix) => `${prefix}${sandboxId}`)
}

/** k8s label selector matching sandbox pods under any read set. */
export function sandboxPodLabelSelector(): string {
  const values = [...new Set(SANDBOX_IDENTITY_READ.map((set) => set.k8sAppLabelValue))]
  return `app in (${values.join(',')})`
}

/** Every k8s pod-name prefix a sandbox may carry: the write prefix first, then each other read prefix. */
export function sandboxPodNamePrefixes(): string[] {
  const prefixes = [SANDBOX_IDENTITY_WRITE, ...SANDBOX_IDENTITY_READ].map((set) => set.k8sPodNamePrefix)
  return [...new Set(prefixes)]
}

/**
 * In-container exec identity for a Docker-mode sandbox: the OS user `docker
 * exec` runs sandbox commands as, that user's home, the authenticated
 * executor's token path, and the DOCKER_HOST docker-proxy socket path. This
 * sits OUTSIDE {@link SandboxIdentitySet} (k8s sandboxes run as root behind no
 * analogous user/paths), but a container built under a given label
 * generation only ever has ONE of these two pairs baked into its image — a
 * legacy-labelled container has a `tau` user and `/run/tau/...` paths, never // ficus-p5-bridge
 * `ficus`/`/run/ficus/...`. Using the new-only values unconditionally when
 * exec'ing into an adopted (not recreated) legacy container leaves it
 * impossible to connect to or exec into: see {@link identitySetForLabels}.
 */
export interface DockerExecIdentity {
  /** OS user `docker exec` runs sandbox commands as. */
  user: string
  /** That user's home directory inside the container. */
  home: string
  /** Path to the authenticated executor's token file inside the container. */
  executorTokenPath: string
  /** DOCKER_HOST target: the docker-proxy socket path inside the container. */
  dockerProxySocketPath: string
}

export const DOCKER_EXEC_IDENTITY_NEW: DockerExecIdentity = {
  user: 'ficus',
  home: '/home/ficus',
  executorTokenPath: '/run/ficus/executor-token',
  dockerProxySocketPath: '/run/ficus-docker/docker.sock',
}

export const DOCKER_EXEC_IDENTITY_LEGACY: DockerExecIdentity = {
  user: 'tau', // ficus-p5-bridge
  home: '/home/tau', // ficus-p5-bridge
  executorTokenPath: '/run/tau/executor-token', // ficus-p5-bridge
  dockerProxySocketPath: '/run/tau-docker/docker.sock', // ficus-p5-bridge
}

/**
 * Which identity set labelled a container, from its labels (by the same
 * `managedLabel` check {@link readSandboxLabel} walks); `null` when neither
 * set's managed label is present (a container predating even the legacy
 * label scheme — callers fall back to the write identity for these).
 */
export function identitySetForLabels(labels: Record<string, string>): SandboxIdentitySet | null {
  return SANDBOX_IDENTITY_READ.find((set) => labels[set.managedLabel] === 'true') ?? null
}

/**
 * The {@link DockerExecIdentity} a container built under the given identity
 * set actually has baked in: NEW labels mean a `ficus`-identity container,
 * LEGACY labels mean a `tau`-identity one. `null` (no managed label found)
 * falls back to NEW, matching {@link SANDBOX_IDENTITY_WRITE}.
 */
export function dockerExecIdentityForSet(set: SandboxIdentitySet | null): DockerExecIdentity {
  return set === SANDBOX_IDENTITY_LEGACY ? DOCKER_EXEC_IDENTITY_LEGACY : DOCKER_EXEC_IDENTITY_NEW
}
