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
