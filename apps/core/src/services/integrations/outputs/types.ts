import type {
  IntegrationOutputDescriptor,
  IntegrationOutputFact,
  TrackedResourceKind,
  WorkflowEventTrigger,
} from '@ficus/shared'
import type { VerifiedIngressEvent } from '../types'

export interface IntegrationOutputAdapter {
  integration: string
  catalog: readonly IntegrationOutputDescriptor[]
  /** Bind provider resource details when a squad rule starts work. Actions remain provider independent. */
  workStreamBindings?(fact: IntegrationOutputFact): WorkflowEventTrigger['create']['metadata']
  /** Provider resource identity carried by the fact, for tracking and existing-stream matching. */
  trackedResource?(fact: IntegrationOutputFact): {
    integration: string
    repository: string
    kind: TrackedResourceKind
    number: number
    url?: string
    /** Provider-native identity, when the fact carries one alongside repository/number. */
    externalId?: string
  } | null
  /** Provider-native identity for facts that carry no repository/number, e.g. a Linear comment. */
  trackedIdentity?(fact: IntegrationOutputFact): { integration: string; externalId: string } | null
  /** Suppress notification echoes without discarding the recorded provider fact. */
  shouldNotify?(fact: IntegrationOutputFact, connectionConfiguration: unknown): boolean
  normalize(event: VerifiedIngressEvent): IntegrationOutputFact[]
}
/** Supplied by the authenticated ingress, never by event payload or stream metadata. */
export type IntegrationOutputAuthority =
  | { kind: 'instance' }
  | { kind: 'connection'; connectionId: string; squadId: string; connectionRevision?: string }
