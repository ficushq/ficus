import {
  changeRequestBindCommand,
  codeHostBindingCommand,
  deliveryPullRequests,
  describeCodeHostReference,
  resolveCodeHostReference,
  type BranchChangeRequestCandidate,
  type BranchChangeRequestResolution,
  type CodeHostReference,
  type IntegrationSubscription,
  type WorkflowDefinition,
} from '@ficus/shared'
import { subscriptionTargetsResource, trackedResourceRegistry } from '../tracked-resources'

/** An exact code-host reference that keeps a delivered commit recoverable after local removal. */
export type RecoveryTarget = { changeRequest: number } | { branch: string }

export interface CodeHostingAdapter {
  integration: string
  validateRepository(repository: string): boolean
  changeRequest(
    reference: CodeHostReference,
    squadId: string
  ): Promise<{ merged: boolean; headBranch: string; baseBranch: string; headSha?: string } | null>
  /**
   * The pull requests a provider reports for one head branch (`state=all`). The GitHub filter is
   * owner-namespace scoped, so forks reusing the branch name never appear. Null means the lookup
   * itself failed; an empty array means the branch genuinely has no pull requests.
   */
  changeRequestsByHead(
    reference: CodeHostReference,
    squadId: string,
    headBranch: string
  ): Promise<BranchChangeRequestCandidate[] | null>
  containsCommit(reference: CodeHostReference, squadId: string, base: string, commit: string): Promise<boolean>
  /**
   * The commit the code host currently advertises for one exact recovery reference (a change
   * request's head ref, or a branch), read with the squad's connection so private repositories
   * work without git credentials in the sandbox. Null when the reference is unavailable.
   */
  recoveryHead(reference: CodeHostReference, squadId: string, target: RecoveryTarget): Promise<string | null>
  subscriptions(reference: CodeHostReference): IntegrationSubscription[]
}

/**
 * Feedback on a delivery change request: the reserved code-host ids, plus the tracked
 * subscriptions whose identity is a pull request designated as delivery in `metadata`.
 *
 * Both id prefixes are reserved by schema, so only subscriptions this registry derived can
 * qualify. An author-written explicit subscription is never delivery feedback even when its
 * literal `match` names a delivery pull request: otherwise any flow could mint a subscription
 * that bypasses the delivery-approval wait.
 */
export function isDeliveryFeedbackSubscription(subscription: IntegrationSubscription, metadata: unknown): boolean {
  if (subscription.id.startsWith('code-host-')) return true
  if (!subscription.id.startsWith('tracked-')) return false
  return deliveryPullRequests(metadata).some((resource) => subscriptionTargetsResource(subscription, resource))
}

export class CodeHostingRegistry {
  private readonly adapters = new Map<string, CodeHostingAdapter>()
  constructor(adapters: readonly CodeHostingAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.integration)) throw new Error('Duplicate code hosting adapter')
      this.adapters.set(adapter.integration, adapter)
    }
  }
  adapterFor(integration: string): CodeHostingAdapter | undefined {
    return this.adapters.get(integration)
  }
  resolve(metadata: unknown) {
    const reference = resolveCodeHostReference(metadata)
    const adapter = reference && this.adapters.get(reference.integration)
    return reference && adapter?.validateRepository(reference.repository) ? { reference, adapter } : null
  }
  /**
   * Why `resolve` returned null, for people. Distinguishes metadata that is present but invalid
   * (for example extra keys on `changeRequest`) from a missing binding, so a delivery failure
   * points at the actual defect instead of claiming required fields are missing.
   */
  explainMissingBinding(metadata: unknown, streamId?: string): string {
    const described = describeCodeHostReference(metadata)
    if (described.status === 'invalid')
      return `codeHost metadata is present but invalid: ${described.issues.join('; ')}. Keep verification evidence outside codeHost (for example metadata.delivery).`
    if (described.status === 'valid') {
      const { integration, repository } = described.reference
      if (!this.adapters.has(integration))
        return `codeHost.integration '${integration}' is not a supported code hosting integration (supported: ${[...this.adapters.keys()].join(', ')})`
      return `codeHost.repository '${repository}' is not a valid repository for the ${integration} integration`
    }
    return `Set codeHost.integration and codeHost.repository to a supported code hosting integration before completion (for example ${codeHostBindingCommand(streamId ?? '<work-stream-id>')})`
  }
  /**
   * Failure class (b) for PR-delivery completion: the integration and repository resolve, but the
   * primary change request binding is missing. Names what finish-time resolution concluded, the
   * exact shape-matching repair, and the track alternative, so the operator can copy-paste
   * instead of guessing which field was absent.
   */
  explainMissingChangeRequest(streamId: string, metadata: unknown, resolution?: BranchChangeRequestResolution): string {
    const described = describeCodeHostReference(metadata)
    const reference = described.status === 'valid' ? described.reference : null
    const repository = reference?.repository ?? '<repository>'
    const integration = reference?.integration ?? 'github'
    const git = (metadata as { git?: { branch?: unknown } } | null)?.git
    const branch = typeof git?.branch === 'string' && git.branch.trim() ? git.branch.trim() : undefined
    const outcome =
      resolution?.status === 'no-branch'
        ? `This stream records no branch (metadata.git.branch), so finish cannot resolve the delivery pull request automatically; it must be bound manually.`
        : resolution?.status === 'no-candidates'
          ? `No pull request was found for branch '${branch}' in ${repository} (the owner-namespace head lookup excludes fork pull requests); bind the delivery pull request manually.`
          : resolution?.status === 'unclear'
            ? `Branch '${branch}' does not identify one delivery pull request (candidates ${resolution.candidates.join(', ')}); finish will not guess, so bind the intended one manually.`
            : resolution?.status === 'lookup-failed'
              ? `The pull requests for branch '${branch}' could not be read through the ${integration} integration; check the pull request exists and the squad connection can read ${repository}, then retry.`
              : `When this stream's branch ${branch ? `'${branch}' ` : ''}carries exactly one pull request, finish binds it automatically.`
    return [
      `codeHost.changeRequest is not set: the delivery pull request for ${repository} is not bound to this work stream. ${outcome}`,
      `Bind it exactly: ${changeRequestBindCommand(streamId, metadata)}`,
      `Additional pull requests that are part of the deliverable are designated with ficus workstream track ${streamId} --pr <owner/repo#n> --delivery instead.`,
    ].join(' ')
  }
  subscriptions(definition: WorkflowDefinition, metadata: unknown): IntegrationSubscription[] {
    const explicit = definition.subscriptions ?? []
    if (!definition.completion.followChanges) return explicit
    const binding = this.resolve(metadata)
    const inferred = binding
      ? binding.reference.changeRequest
        ? binding.adapter.subscriptions(binding.reference)
        : []
      : []
    // Delivery links already own their reserved ids; only extra links fan out, and they follow
    // their own provider's adapter: a stream may track a Linear issue with no code host at all.
    inferred.push(...trackedResourceRegistry.subscriptions(metadata))
    // IDs are reserved by schema so explicit subscriptions cannot shadow delivery bindings.
    return [
      ...explicit,
      ...inferred.map((subscription) => ({
        ...subscription,
        deliver: { ...subscription.deliver, to: definition.completion.changeEventsTo ?? 'delivery-owner' },
      })),
    ]
  }
}
