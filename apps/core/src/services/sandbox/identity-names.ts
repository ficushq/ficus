/** Canonical sandbox identity. Retired names and labels are never discovered or adopted. */

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

/** The set new sandboxes are created and labelled with. The new set as of this release. */
export const SANDBOX_IDENTITY_WRITE: SandboxIdentitySet = SANDBOX_IDENTITY_NEW

/** Every set a sandbox is recognised under, new first. */
export const SANDBOX_IDENTITY_READ: readonly SandboxIdentitySet[] = [SANDBOX_IDENTITY_NEW]

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

/** User and paths baked into the canonical Docker sandbox image. */
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

/** Canonical managed identity, or null when the required label is absent. */
export function identitySetForLabels(labels: Record<string, string>): SandboxIdentitySet | null {
  return SANDBOX_IDENTITY_READ.find((set) => labels[set.managedLabel] === 'true') ?? null
}

/** Canonical exec paths; unknown identity objects fail closed. */
export function dockerExecIdentityForSet(set: SandboxIdentitySet | null): DockerExecIdentity {
  if (set !== null && set !== SANDBOX_IDENTITY_NEW) throw new Error('unsupported sandbox identity')
  return DOCKER_EXEC_IDENTITY_NEW
}
