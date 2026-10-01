/** Provider-neutral integration contracts. Provider implementations are injected at composition time. */
export type IntegrationCapabilityKind =
  | 'agent_tools'
  | 'conversation_export'
  | 'webhook_ingress'
  | 'event_polling'
  | 'messaging'
  | 'memory_source'
  | 'notification_sink'

export interface RuntimeConnection<C = unknown> {
  id: string
  /** Assignment or synthetic-watch context; global persistence records have no squad. */
  squadId: string
  providerKey: string
  adapterVersion: number
  configuration: C
}

export interface ValidationConnection<C = unknown> {
  id: string
  providerKey: string
  adapterVersion: number
  configuration: C
}

export interface ProviderAuthContext<C = unknown> {
  connection: ValidationConnection<C>
  credential: string
  signal?: AbortSignal
}

export type ProviderValidation =
  | {
      ok: true
      grantedScopes: readonly string[]
      /** Non-secret configuration refreshed for the same account identity, e.g. after a rename. */
      configuration?: unknown
    }
  | { ok: false; code: string }

export interface BoundIntegrationTool {
  name: string
  description: string
  parameters: unknown
  execute(input: unknown): Promise<unknown>
}

export interface AgentToolCapability<C = unknown> {
  createTools(connection: RuntimeConnection<C>): Promise<readonly BoundIntegrationTool[]>
}

export interface SanitizedConversationRecord {
  role: 'user' | 'assistant'
  text: string
  sourceMessageId: string
  createdAt: Date
}

export interface ConversationExportCapability<C = unknown> {
  encode(records: readonly SanitizedConversationRecord[], connection: RuntimeConnection<C>): Uint8Array
  send(payload: Uint8Array, connection: RuntimeConnection<C>, signal?: AbortSignal): Promise<void>
}

export interface RawIngressRequest {
  method: string
  headers: Readonly<Record<string, string>>
  body: Uint8Array
}

export interface IngressAck {
  status: number
  headers?: Readonly<Record<string, string>>
  body?: Uint8Array
}

export interface VerifiedIngressEvent {
  type: string
  payload: unknown
  /** Transport-independent observability metadata. Consumers must not branch on it. */
  metadata?: Readonly<Record<string, unknown>>
  /** Internal durable identity for synthetic polling dispatch; never added to the native payload. */
  logicalEventKey?: string
}

/**
 * Provider-neutral poll signal. Adapters must reserve cost immediately before
 * every external request so a tick cannot exceed the shared hard limit.
 */
export interface EventPollingSignal extends AbortSignal {
  readonly remainingBudgetUnits: number
  reserveRequest(units?: number): void
}

export interface EventPollingResult {
  events: readonly VerifiedIngressEvent[]
  nextCursor: Record<string, unknown>
  suggestedIntervalMs: number
  /**
   * Fallback accounting for adapters that did not reserve through the signal.
   * Values must be finite positive units; malformed values exhaust the tick.
   */
  budgetUnitsConsumed?: number
}

export interface EventPollingCapability<C = unknown> {
  poll(
    connection: RuntimeConnection<C>,
    cursor: Readonly<Record<string, unknown>> | null,
    signal?: EventPollingSignal
  ): Promise<EventPollingResult>
}

export interface WebhookIngressCapability<C = unknown> {
  acknowledge(input: RawIngressRequest, connection: RuntimeConnection<C>): Promise<IngressAck>
  handle(event: VerifiedIngressEvent, connection: RuntimeConnection<C>): Promise<void>
}

export interface MessagingCapability<C = unknown> {
  send(message: unknown, connection: RuntimeConnection<C>): Promise<void>
}

export interface MemorySourceCapability<C = unknown> {
  search(query: unknown, connection: RuntimeConnection<C>): Promise<unknown>
}

export interface NotificationSinkCapability<C = unknown> {
  notify(notification: unknown, connection: RuntimeConnection<C>): Promise<void>
}

export interface IntegrationCapabilities<C = unknown> {
  agent_tools: AgentToolCapability<C>
  conversation_export: ConversationExportCapability<C>
  webhook_ingress: WebhookIngressCapability<C>
  event_polling: EventPollingCapability<C>
  messaging: MessagingCapability<C>
  memory_source: MemorySourceCapability<C>
  notification_sink: NotificationSinkCapability<C>
}

export interface IntegrationProvider<C = unknown> {
  readonly key: string
  readonly adapterVersion: number
  parseConfig(value: unknown): C
  validate(context: ProviderAuthContext<C>): Promise<ProviderValidation>
  readonly outputs?: import('./outputs/types').IntegrationOutputAdapter
  readonly capabilities: Partial<IntegrationCapabilities<C>>
}

/** Safe provider backoff hint; the runner clamps it before writing its durable retry deadline. */
export class EventPollingRetryError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number
  ) {
    super(message)
  }
}
