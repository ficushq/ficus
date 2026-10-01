import type { CodeHostingRegistry, RecoveryTarget } from '../integrations/code-hosting/registry'
import { codeHostFromRemote, type RepositoryExec } from './repository-setup'

export class WorktreeDeliveryUnprovenError extends Error {}

/** Revalidate live delivery and recovery of the exact head captured at finish.
 * PR refs preserve squash-merged feature commits without requiring ancestry.
 *
 * The remote recovery reference is read through the code-hosting adapter with the squad's
 * connection, not `git ls-remote`: cleanup's sandbox exec carries no git credential and has no
 * environment channel, so private repositories could never be proven, and passing a token any
 * other way would put it in argv or shared files. Local git is only used for the configured
 * remote's identity, which must match the delivered code-host repository. */
export async function verifyWorktreeCleanupDelivery(
  input: {
    metadata: Record<string, unknown>
    mode: string
    deliveredHead: string | null
    repository: string
    squadId: string
  },
  exec: RepositoryExec,
  registry: CodeHostingRegistry
): Promise<string> {
  function refuse(reason: string): never {
    throw new WorktreeDeliveryUnprovenError(reason)
  }
  const head = input.deliveredHead
  if (!head || !/^[a-f0-9]{40}$/.test(head)) refuse('No authoritative delivered head was captured; retain the worktree')
  const binding = registry.resolve(input.metadata)
  if (!binding || !['pr-merge', 'pr-auto-merge', 'direct-merge'].includes(input.mode))
    refuse('Cleanup requires independently verified code-host delivery')
  const { reference, adapter } = binding!
  const git = input.metadata.git as Record<string, unknown> | undefined
  const remote = git?.remote ?? 'origin'
  if (typeof remote !== 'string' || !/^[\w][\w.-]*$/.test(remote)) refuse('Git remote selection is invalid')
  for (const args of [
    ['remote', 'get-url', remote],
    ['remote', 'get-url', '--push', '--all', remote],
  ]) {
    const urls = (await exec(['git', '-C', input.repository, ...args])).trim().split('\n')
    const identity = urls.length === 1 ? codeHostFromRemote(urls[0]!) : undefined
    if (
      !identity ||
      identity.integration !== reference.integration ||
      identity.repository.toLowerCase() !== reference.repository.toLowerCase()
    )
      refuse('Git remote does not match the delivered code-host repository')
  }
  const base = git?.baseBranch
  if (typeof base !== 'string' || !base || typeof git?.branch !== 'string')
    refuse('Delivery branch bindings are incomplete')
  let target: RecoveryTarget
  if (input.mode === 'direct-merge') {
    target = { branch: base as string }
  } else {
    if (!reference.changeRequest) refuse('Delivery change request is missing')
    const change = await adapter.changeRequest(reference, input.squadId)
    if (!change?.merged || change.headSha !== head || change.headBranch !== git!.branch || change.baseBranch !== base)
      refuse('Merged change request no longer proves this exact delivered head')
    target = { changeRequest: reference.changeRequest!.number }
  }
  const remoteHead = await adapter.recoveryHead(reference, input.squadId, target)
  if (!remoteHead || !/^[a-f0-9]{40}$/.test(remoteHead)) refuse('Exact remote recovery reference is unavailable')
  if (input.mode === 'direct-merge') {
    // Verify containment in the immutable advertised commit, not a moving base.
    if (!(await adapter.containsCommit(reference, input.squadId, remoteHead!, head!)))
      refuse('Remote base does not retain the delivered commit')
  } else if (remoteHead !== head) refuse('Remote recovery head differs from delivered head')
  return head!
}
