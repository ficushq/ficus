/**
 * Webhooks Module - Main Entry Point
 *
 * This module exports the webhook registry and handles
 * the registration of all webhook processors and handlers.
 */

export * from './types'
export { webhookRegistry } from './registry'
export { dispatchVerifiedWebhookContext, dispatchVerifiedWebhookEvent } from './dispatch'
export {
  storeWebhookEvent,
  markWebhookProcessed,
  markWebhookError,
  getWebhookEvent,
  listWebhookEvents,
  getLastRealWebhookDeliveryForRepo,
  getLastRealWebhookDeliveriesForRepos,
} from './store'

export { setGithubActionConfig, setLinearActionConfig } from './processors'
export { loadWebhookActionConfig, getBatcherConfig } from './action-config'
export { webhookBatcher, WebhookBatcher } from './batcher'
export type { BatchConfig, BatchEventConfig, BatcherConfig, BatchContext, PendingBatch } from './batcher'

// Import processors and handlers
import { webhookRegistry } from './registry'
import type { WebhookHandler } from './types'
import {
  githubProcessor,
  handleGithubPush,
  handleGithubPing,
  handleGithubManagedIndexing,
  linearProcessor,
  handleLinearIssueUpdate,
} from './processors'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('webhooks')

/** GitHub events whose verified deliveries are published natively and re-indexed for memory. */
export const GITHUB_MANAGED_INDEXING_EVENTS = [
  'pull_request_review',
  'pull_request',
  'issues',
  'workflow_run',
  'issue_comment',
  'pull_request_review_comment',
] as const

/**
 * Initialize all webhook processors and handlers.
 * Call this during app startup.
 */
export function initializeWebhooks(): void {
  log.info('Registering processors and handlers...')

  // Register GitHub processor
  webhookRegistry.registerProcessor(githubProcessor)
  log.info('Registered processor: github')

  // GitHub handlers. Feedback events keep a handler only for the managed memory indexing hook, so
  // the route still dispatches them to native output publishing (which applies the author filter).
  // Legacy operator shell commands/batches for feedback events are retired and never registered.
  const githubHandlers: Array<[string, WebhookHandler]> = [
    ['push', handleGithubPush],
    ['ping', handleGithubPing],
    ...GITHUB_MANAGED_INDEXING_EVENTS.map((event): [string, WebhookHandler] => [event, handleGithubManagedIndexing]),
  ]

  for (const [event, handler] of githubHandlers) {
    webhookRegistry.registerHandler('github', event, handler)
  }
  log.info(
    `Registered ${githubHandlers.length} GitHub handlers: ${[...new Set(githubHandlers.map(([e]) => e))].join(', ')}`
  )

  // Register Linear processor
  webhookRegistry.registerProcessor(linearProcessor)
  log.info('Registered processor: linear')

  // Register Linear event handlers
  webhookRegistry.registerHandler('linear', 'Issue', handleLinearIssueUpdate)
  webhookRegistry.registerHandler('linear', 'Comment', handleLinearIssueUpdate)
  log.info('Registered 2 Linear handlers: Issue, Comment')

  log.info(`Initialization complete. Providers: ${webhookRegistry.getProviders().join(', ')}`)
}
