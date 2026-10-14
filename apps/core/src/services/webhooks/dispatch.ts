import { firstPartyIntegrationPlugin } from '../integrations/first-party-plugins'
import { isIntegrationEnabled } from '../integrations/provider-state'
import type { VerifiedIngressEvent } from '../integrations/types'
import { webhookRegistry } from './registry'
import type { WebhookContext } from './types'

/** Dispatch an already-authenticated context through the shared handler registry. */
export async function dispatchVerifiedWebhookContext(
  ctx: WebhookContext,
  options: { skipOutputs?: boolean; handledSquadIds?: string[] } = {}
): Promise<void> {
  if (firstPartyIntegrationPlugin(ctx.provider) && !(await isIntegrationEnabled(ctx.provider))) return
  const { publishIntegrationOutputs } = await import('../integrations/outputs/runtime')
  if (options.skipOutputs) ctx.integrationHandledSquadIds = options.handledSquadIds ?? []
  else if (ctx.provider === 'github') {
    const { publishGitHubWebhookOutputs } = await import('../integrations/github/ingress')
    ctx.integrationHandledSquadIds = await publishGitHubWebhookOutputs({
      type: ctx.eventType,
      payload: ctx.payload,
      githubObservation: ctx.headers['x-github-delivery']
        ? { kind: 'webhook', deliveryId: ctx.headers['x-github-delivery'] }
        : undefined,
    })
  } else if (ctx.provider === 'linear') {
    // Linear's event handler verifies connected-account issue access before publishing.
    ctx.integrationHandledSquadIds = []
  } else
    ctx.integrationHandledSquadIds = await publishIntegrationOutputs(
      ctx.provider,
      { type: ctx.eventType, payload: ctx.payload },
      { kind: 'instance' }
    )
  const errors: string[] = []
  for (const handler of webhookRegistry.getHandlers(ctx.provider, ctx.eventType)) {
    try {
      await handler(ctx)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (errors.length) throw new Error(errors.join('; '))
}

/** Construct a transport-free context for a trusted synthetic event and dispatch it. */
export async function dispatchVerifiedWebhookEvent(
  provider: string,
  event: VerifiedIngressEvent,
  options: { skipOutputs?: boolean; handledSquadIds?: string[] } = {}
): Promise<void> {
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new Error(`Invalid verified ingress payload for ${provider}:${event.type}`)
  }
  const payload = event.payload as Record<string, unknown>
  return dispatchVerifiedWebhookContext(
    {
      provider,
      eventType: event.type,
      payload,
      headers: {},
      rawBody: JSON.stringify(payload),
      metadata: event.metadata,
    },
    options
  )
}
