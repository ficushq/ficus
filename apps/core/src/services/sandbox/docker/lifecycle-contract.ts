import { SANDBOX_IDENTITY_READ, SANDBOX_IDENTITY_WRITE } from '../identity-names'

/** The spec-hash label new containers are stamped with (readers accept every read set). */
export const SPEC_HASH_LABEL = SANDBOX_IDENTITY_WRITE.specHashLabel

export function classifyDockerInspectStatus(exitCode: number, stderr: string): 'running' | 'not_found' | 'unknown' {
  if (exitCode === 0) return 'running'
  if (/no such (object|container)/i.test(stderr)) return 'not_found'
  return 'unknown'
}

/**
 * Whether an inspected container is this sandbox's own. Name and labels must come
 * from ONE identity set (a single create call writes both), under any read set:
 * - `current`: the managed label, this sandbox id, and the exact container name;
 * - `legacy`: a container from before ownership labels — exact name, a spec-hash
 *   label, and the sandbox's workspace bind-mounted;
 * - `unproven`: anything else, which lifecycle operations refuse to touch.
 */
export function classifyDockerContainerOwnership(
  inspected: any,
  sandboxId: string,
  expectedWorkspacePath?: string
): 'current' | 'legacy' | 'unproven' {
  const labels = inspected?.Config?.Labels ?? {}
  const namedBy = SANDBOX_IDENTITY_READ.filter((set) => inspected?.Name === `/${set.containerPrefix}${sandboxId}`)
  if (namedBy.some((set) => labels[set.managedLabel] === 'true' && labels[set.sandboxIdLabel] === sandboxId))
    return 'current'
  const legacyMount =
    expectedWorkspacePath && inspected?.Mounts?.some((mount: any) => mount?.Source === expectedWorkspacePath)
  if (legacyMount && namedBy.some((set) => Boolean(labels[set.specHashLabel]))) return 'legacy'
  return 'unproven'
}
