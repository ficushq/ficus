import { routeLinearEvent } from './ingress'
import { withLegacyEnvAliases } from '@ficus/shared/legacy-env'
import { resolveLinearWebhookSecret } from './webhook-settings'
/**
 * Linear Webhook Processor
 *
 * Handles webhook events from Linear including:
 * - Signature verification using Linear-Signature header (HMAC-SHA256, raw hex)
 * - Issue and comment events for task creation on assignment
 */

import { createHmac, timingSafeEqual } from 'crypto'
import type { WebhookProcessor, WebhookContext, WebhookHandler } from '../../webhooks/types'
import type { WebhookActionConfig, WebhookActionRule } from '../../webhooks/action-config'
import { resolveEnvTemplates, getEventRules } from '../../webhooks/action-config'
import { exec } from 'child_process'
import { promisify } from 'util'
import { MONOREPO_ROOT } from '../../../lib/paths'
import { createLogger } from '../../../lib/infra/logger'
import { getSecretStore } from '../../secrets'
import { webhookScriptAuthEnv } from '../../auth/system-tokens'

const execAsync = promisify(exec)
const log = createLogger('linear-webhook')

let actionConfig: WebhookActionConfig | null = null

export function setLinearActionConfig(config: WebhookActionConfig): void {
  actionConfig = config
}

/**
 * Execute commands from a webhook action rule.
 * Shared helper for Linear webhook handlers.
 *
 * @param rule - The action rule containing commands to execute
 * @param payload - The webhook payload for template resolution
 * @param handlerName - Name of the handler for logging (e.g., "issue_assigned")
 */
async function executeRuleCommands(
  rule: WebhookActionRule,
  payload: Record<string, unknown>,
  handlerName: string,
  squadId: string
): Promise<void> {
  const cwd = rule.cwd || MONOREPO_ROOT
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(?:LINEAR_|GH_TOKEN|GITHUB_TOKEN|GITHUB_WEBHOOK_SECRET)/.test(key))
  )
  const secretEnv = { ...environment, ...(await webhookScriptAuthEnv()), TARGET_SQUAD_ID: squadId }
  const resolvedEnv = rule.env
    ? { ...secretEnv, ...resolveEnvTemplates(rule.env, payload) }
    : Object.keys(secretEnv).length > 0
      ? { ...secretEnv }
      : undefined

  for (const command of rule.commands) {
    log.info(`Running: \`${command.run}\` from ${cwd}`)
    const opts: { cwd: string; timeout?: number; env?: Record<string, string> } = { cwd }
    if (command.timeout) opts.timeout = command.timeout
    // One release (Ficus rename): webhook scripts may still read the TAU_* names.
    if (resolvedEnv) opts.env = withLegacyEnvAliases(resolvedEnv)

    const result = await execAsync(command.run, opts)
    if (result.stdout) {
      log.info(`output:`, result.stdout.trim().slice(0, 1000))
    }
    if (result.stderr) {
      log.info(`${command.run} error:`, result.stderr.trim().slice(0, 1000))
    }
  }

  log.info(`${handlerName} commands completed`)
}

/**
 * Linear webhook processor implementation
 */
export const linearProcessor: WebhookProcessor = {
  provider: 'linear',

  async verifySignature(ctx: WebhookContext, secret: string): Promise<boolean> {
    const signature = ctx.headers['linear-signature']
    if (!signature) {
      return false
    }

    try {
      // Linear sends raw hex signature (no prefix like GitHub's "sha256=")
      const headerSignature = Buffer.from(signature, 'hex')
      const computedSignature = createHmac('sha256', secret).update(ctx.rawBody).digest()

      // Use timing-safe comparison to prevent timing attacks
      return timingSafeEqual(computedSignature, headerSignature)
    } catch {
      // timingSafeEqual throws if buffer lengths differ, or hex decode fails
      return false
    }
  },

  getEventType(ctx: WebhookContext): string {
    return ctx.headers['linear-event'] || 'unknown'
  },

  getSecret(): string | null {
    return resolveLinearWebhookSecret(getSecretStore())
  },
}

/** Route Linear issue and comment events through connected account authority; assignments keep the legacy fallback. */
export const handleLinearIssueUpdate: WebhookHandler = async (ctx) => {
  await routeLinearEvent({ type: ctx.eventType, payload: ctx.payload }, async (squadId) => {
    const rule = actionConfig && getEventRules(actionConfig, 'linear', 'issue_assigned')?.[0]
    if (rule) await executeRuleCommands(rule, ctx.payload, 'issue_assigned', squadId)
  })
}
