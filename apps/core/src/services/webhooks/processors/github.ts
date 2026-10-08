import { resolveGitHubWebhookSecret } from '../../integrations/github/webhook-settings'
import { githubWebhookEnvironment } from '../../integrations/github/webhook-environment'
/**
 * GitHub Webhook Processor
 *
 * Handles webhook events from GitHub including:
 * - Signature verification using X-Hub-Signature-256
 * - Push event handling for operator-configured deployment commands
 * - Ping acknowledgement and the managed memory indexing hook
 *
 * Code-host feedback (comments, reviews, issues, PR lifecycle and CI) reaches agents ONLY through
 * the native integration event system, which applies the squad's GitHub author filter. Legacy
 * operator shell commands and batches for those events are retired: they are never registered or
 * executed, and a configuration that still names them gets a content-free startup diagnostic.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import type { WebhookProcessor, WebhookContext, WebhookHandler } from '../types'
import type { WebhookActionConfig, WebhookActionRule } from '../action-config'
import { getMatchingRule, resolveEnvTemplates } from '../action-config'
import { exec } from 'child_process'
import { promisify } from 'util'
import { MONOREPO_ROOT } from '../../../lib/paths'
import { createLogger } from '../../../lib/infra/logger'
import { getSecretStore } from '../../secrets'
import { webhookScriptAuthEnv } from '../../auth/system-tokens'
import { db } from '../../../db'
import { squadSourceConfigs } from '../../../db/schema'
import { IndexingService } from '../../memory'

const execAsync = promisify(exec)
const log = createLogger('github-webhook')
const GITHUB_ISSUE_INDEXED_SYMBOL = Symbol('github_issue_indexed')

let actionConfig: WebhookActionConfig | null = null

export async function squadsWithRepoConfigured(repo: string): Promise<string[]> {
  const configs = await db.select().from(squadSourceConfigs)
  return configs
    .filter((config) => {
      if (config.sourceType !== 'github_issue' || !config.enabled) return false
      const policy = (config.policy as { scope?: { repos?: unknown } } | null) ?? null
      const repos = policy?.scope?.repos
      return Array.isArray(repos) && repos.includes(repo)
    })
    .map((config) => config.squadId)
}

export async function indexGithubIssueForConfiguredSquads(payload: {
  repository?: { full_name?: string }
  issue?: { number?: number }
  pull_request?: { number?: number }
  workflow_run?: { pull_requests?: Array<{ number?: number }> }
}): Promise<void> {
  const indexedPayload = payload as typeof payload & { [GITHUB_ISSUE_INDEXED_SYMBOL]?: boolean }
  if (indexedPayload[GITHUB_ISSUE_INDEXED_SYMBOL]) return

  const repo = payload.repository?.full_name
  const number =
    payload.issue?.number ?? payload.pull_request?.number ?? payload.workflow_run?.pull_requests?.[0]?.number
  if (!repo || !number) return

  Object.defineProperty(indexedPayload, GITHUB_ISSUE_INDEXED_SYMBOL, { value: true })
  for (const squadId of await squadsWithRepoConfigured(repo)) {
    await IndexingService.instance().index(squadId, 'github_issue', `${repo}#${number}`)
  }
}

/** Operator-configured GitHub commands that still run: deployment hooks on push. */
const SUPPORTED_GITHUB_ACTIONS = new Set(['push'])

export function setGithubActionConfig(config: WebhookActionConfig): void {
  actionConfig = config
  // Feedback/issue/PR/CI commands and batches are retired, never loaded into the batcher. The
  // diagnostic names only operator configuration keys, never webhook content.
  const retired = Object.keys(config?.github ?? {}).filter((key) => !SUPPORTED_GITHUB_ACTIONS.has(key))
  if (retired.length)
    log.warn(
      `Ignoring retired GitHub webhook actions (${retired.sort().join(', ')}); configure squad GitHub event rules instead`
    )
}

/**
 * Managed memory indexing hook. It re-indexes the referenced issue/PR through GitHubIssueSource,
 * which projects only prose the squad's author filter admits; it never runs operator commands
 * and never notifies agents.
 */
export const handleGithubManagedIndexing: WebhookHandler = async (ctx) => {
  await indexGithubIssueForConfiguredSquads(ctx.payload as Parameters<typeof indexGithubIssueForConfiguredSquads>[0])
}

/**
 * Execute commands from a webhook action rule.
 * Shared helper used by all GitHub webhook handlers.
 *
 * @param rule - The action rule containing commands to execute
 * @param payload - The webhook payload for template resolution
 * @param handlerName - Name of the handler for logging (e.g., "push", "workflow_run")
 */
async function executeRuleCommands(
  rule: WebhookActionRule,
  payload: Record<string, unknown>,
  handlerName: string,
  handledSquadIds: string[] = []
): Promise<void> {
  const cwd = rule.cwd || MONOREPO_ROOT
  const secretEnv = { ...(await githubWebhookEnvironment()), ...(await webhookScriptAuthEnv()) }
  const resolvedEnv = rule.env
    ? { ...secretEnv, ...resolveEnvTemplates(rule.env, payload) }
    : Object.keys(secretEnv).length > 0
      ? { ...secretEnv }
      : undefined

  for (const command of rule.commands) {
    log.info(`Running: \`${command.run}\` from ${cwd}`)
    const opts: { cwd: string; timeout?: number; env?: Record<string, string> } = { cwd }
    if (command.timeout) opts.timeout = command.timeout
    opts.env = {
      ...(resolvedEnv as Record<string, string>),
      FICUS_INTEGRATION_HANDLED_SQUADS_JSON: JSON.stringify(handledSquadIds),
    }

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
 * GitHub webhook processor implementation
 */
export const githubProcessor: WebhookProcessor = {
  provider: 'github',

  async verifySignature(ctx: WebhookContext, secret: string): Promise<boolean> {
    const signature = ctx.headers['x-hub-signature-256']
    if (!signature) {
      return false
    }

    const expectedSignature = 'sha256=' + createHmac('sha256', secret).update(ctx.rawBody).digest('hex')

    try {
      // Use timing-safe comparison to prevent timing attacks
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
    } catch {
      // timingSafeEqual throws if buffer lengths differ
      return false
    }
  },

  getEventType(ctx: WebhookContext): string {
    return ctx.headers['x-github-event'] || 'unknown'
  },

  getSecret(): string | null {
    return resolveGitHubWebhookSecret(getSecretStore())
  },
}

/**
 * Payload structure for GitHub push events
 */
interface GithubPushPayload {
  ref?: string
  repository?: {
    full_name?: string
  }
  pusher?: {
    name?: string
  }
  head_commit?: {
    message?: string
    id?: string
  }
}

/**
 * Handler for GitHub push events.
 * Uses YAML-configured action rules to determine which commands to run per branch.
 */
export const handleGithubPush: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as GithubPushPayload
  const ref = payload.ref || 'unknown'
  const repoName = payload.repository?.full_name || 'unknown'

  if (!actionConfig) {
    log.warn('No action config loaded, skipping push handling')
    return
  }

  const rule = getMatchingRule(actionConfig, 'github', 'push', ref, repoName)

  if (!rule) {
    log.info(`No matching rule for push to ${ref}`)
    return
  }
  const commitMsg = payload.head_commit?.message?.split('\n')[0] || 'unknown'
  const commitId = payload.head_commit?.id?.slice(0, 7) || 'unknown'

  log.info(`Processing push to ${ref} for ${repoName}`)
  log.info(`Commit: ${commitId} - ${commitMsg}`)

  try {
    await executeRuleCommands(rule, ctx.payload as Record<string, unknown>, 'push', ctx.integrationHandledSquadIds)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('push command failed:', errorMsg)
    throw new Error(`Push command failed: ${errorMsg}`)
  }
}

/**
 * Handler for GitHub ping events (sent when webhook is created)
 */
export const handleGithubPing: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as { zen?: string; hook_id?: number }
  log.info(`Ping received: "${payload.zen}" (hook_id: ${payload.hook_id})`)
}
