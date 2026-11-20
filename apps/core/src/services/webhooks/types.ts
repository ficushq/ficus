/**
 * Webhook Event Handling System - Type Definitions
 *
 * This module defines the core interfaces for the extensible webhook
 * event handling architecture.
 */

/**
 * Stored webhook event for audit/debugging
 */
export interface WebhookEvent {
  id: string
  provider: string
  eventType: string
  payload: Record<string, unknown>
  headers: Record<string, string>
  signature: string | null
  verified: boolean
  processedAt: Date | null
  error: string | null
  createdAt: Date
}

/**
 * Context passed to webhook handlers
 */
export interface WebhookContext {
  /** Server-owned generic routing receipts, never read from provider payloads. */
  integrationHandledSquadIds?: string[]
  provider: string
  eventType: string
  payload: Record<string, unknown>
  headers: Record<string, string>
  rawBody: string
  /** Transport-independent observability only; handlers must not branch on it. */
  metadata?: Readonly<Record<string, unknown>>
}

/**
 * Interface that webhook processors must implement.
 * Each provider (GitHub, Stripe, etc.) has its own processor.
 */
export interface WebhookProcessor {
  /** Provider name (e.g., 'github', 'stripe') */
  provider: string

  /**
   * Verify the webhook signature.
   * Each provider has its own signature scheme.
   */
  verifySignature(ctx: WebhookContext, secret: string): Promise<boolean>

  /**
   * Extract the event type from the webhook payload/headers.
   * For GitHub, this comes from X-GitHub-Event header.
   */
  getEventType(ctx: WebhookContext): string

  /**
   * Get the secret for this provider from environment.
   * Returns null if not configured.
   */
  getSecret(): string | null

  /** First-party integration whose enabled state gates this processor, when it differs from `provider`. */
  integration?: string

  /**
   * Checks a signature-verified delivery further (freshness, type agreement, sender identity).
   * Returns a short reason to reject it, or null to accept.
   */
  verifyDelivery?(ctx: WebhookContext): string | null

  /** The provider's delivery ID, for deduplicating retried deliveries. */
  getDeliveryId?(ctx: WebhookContext): string | undefined
}

/**
 * Handler function for processing webhook events
 */
export type WebhookHandler = (ctx: WebhookContext) => Promise<void>

/**
 * Registry for managing webhook processors and handlers
 */
export interface WebhookRegistry {
  /** Register a processor for a provider */
  registerProcessor(processor: WebhookProcessor): void

  /** Register a handler for a provider + event type */
  registerHandler(provider: string, eventType: string, handler: WebhookHandler): void

  /** Get processor for a provider */
  getProcessor(provider: string): WebhookProcessor | undefined

  /** Get all handlers for a provider + event type (including wildcard handlers) */
  getHandlers(provider: string, eventType: string): WebhookHandler[]
}

/**
 * Input for storing a webhook event
 */
export interface StoreWebhookEventInput {
  provider: string
  eventType: string
  payload: Record<string, unknown>
  headers: Record<string, string>
  signature: string | null
  verified: boolean
  error?: string
  /** Provider delivery ID; a verified delivery with a stored ID is rejected as a duplicate. */
  deliveryId?: string
}
