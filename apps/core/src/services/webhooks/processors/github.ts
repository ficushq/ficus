import { resolveGitHubWebhookSecret } from '../../integrations/github/webhook-settings'
import { withLegacyEnvAliases } from '@ficus/shared/legacy-env'
import { connectedGitHubLogins } from '../../integrations/github/resolve-connection'
import { githubWebhookEnvironment } from '../../integrations/github/webhook-environment'
/**
 * GitHub Webhook Processor
 *
 * Handles webhook events from GitHub including:
 * - Signature verification using X-Hub-Signature-256
 * - Push event handling for auto-deploy
 * - Batched event handling for PR reviews
 */

import { createHmac, timingSafeEqual } from 'crypto'
import type { WebhookProcessor, WebhookContext, WebhookHandler } from '../types'
import type { WebhookActionConfig, WebhookActionRule } from '../action-config'
import { getMatchingRule, matchesRepo, resolveEnvTemplates, getBatcherConfig, getEventRules } from '../action-config'
import { webhookBatcher } from '../batcher'
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

export function setGithubActionConfig(config: WebhookActionConfig): void {
  actionConfig = config
  // Load batch configs into the batcher
  const batcherConfig = getBatcherConfig(config, 'github')
  if (batcherConfig.batches && Object.keys(batcherConfig.batches).length > 0) {
    webhookBatcher.loadConfig('github', batcherConfig)
    log.info(`Loaded batch configs: ${Object.keys(batcherConfig.batches).join(', ')}`)
  }
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
    // One release (Ficus rename): webhook scripts may still read the TAU_* names.
    opts.env = withLegacyEnvAliases({
      ...(resolvedEnv as Record<string, string>),
      FICUS_INTEGRATION_HANDLED_SQUADS_JSON: JSON.stringify(handledSquadIds),
    })

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
 * Handler for GitHub pull_request_review events.
 * Checks batcher first for batched handling, otherwise uses YAML-configured action rules.
 */
export const handleGithubPullRequestReview: WebhookHandler = async (ctx) => {
  await indexGithubIssueForConfiguredSquads(ctx.payload as Parameters<typeof indexGithubIssueForConfiguredSquads>[0])

  // Check if this event should be batched
  if (webhookBatcher.handleEvent('github', 'pull_request_review', ctx.payload as Record<string, unknown>)) {
    log.info('pull_request_review event batched')
    return
  }

  // Fall through to normal handling if not batched
  if (!actionConfig) {
    log.warn('No action config loaded, skipping pull_request_review handling')
    return
  }

  const rules = getEventRules(actionConfig, 'github', 'pull_request_review')
  if (!rules || rules.length === 0) {
    log.info('No rules for pull_request_review')
    return
  }

  const payload = ctx.payload as { repository?: { full_name?: string } }
  const repoName = payload.repository?.full_name || ''

  // Find first rule that matches repo (or has no repo filter)
  const rule = rules.find((r) => matchesRepo(repoName, r.repos || []))
  if (!rule) {
    log.info(`No matching rule for pull_request_review in ${repoName}`)
    return
  }

  try {
    await executeRuleCommands(
      rule,
      ctx.payload as Record<string, unknown>,
      'pull_request_review',
      ctx.integrationHandledSquadIds
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('pull_request_review command failed:', errorMsg)
    throw new Error(`PR review command failed: ${errorMsg}`)
  }
}

/**
 * Payload structure for GitHub pull_request events
 */
interface GithubPullRequestPayload {
  action?: string
  requested_reviewer?: { login?: string }
  requested_team?: { slug?: string; name?: string }
  pull_request?: {
    number?: number
    merged?: boolean
    merge_commit_sha?: string
    title?: string
    html_url?: string
    body?: string | null
    base?: {
      ref?: string
    }
    head?: {
      ref?: string
    }
    user?: {
      login?: string
    }
  }
  repository?: {
    full_name?: string
  }
}

/**
 * Handler for GitHub pull_request events when review is requested.
 * User review requests are filtered by a connected GitHub account; team requests are routed by repo in the script.
 */
export const handleGithubPullRequestReviewRequested: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as unknown as GithubPullRequestPayload
  await indexGithubIssueForConfiguredSquads(payload)

  if (payload.action !== 'review_requested') {
    log.info(`pull_request review_requested event ignored (action=${payload.action})`)
    return
  }

  const configuredUsers = await connectedGitHubLogins()
  const requestedReviewer = payload.requested_reviewer?.login || ''
  const requestedTeam = payload.requested_team?.slug || payload.requested_team?.name || ''

  if (requestedReviewer && !requestedTeam && configuredUsers.length === 0) {
    log.warn('a connected GitHub account not configured, skipping pull_request review_requested user review request')
    return
  }

  if (requestedReviewer && !configuredUsers.includes(requestedReviewer.toLowerCase()) && !requestedTeam) {
    log.info(
      `pull_request review_requested event ignored (requested_reviewer=${requestedReviewer}, configured=${configuredUsers.join(', ')})`
    )
    return
  }

  if (!actionConfig) {
    log.warn('No action config loaded, skipping pull_request review_requested handling')
    return
  }

  const rules = getEventRules(actionConfig, 'github', 'pull_request_review_requested')
  if (!rules || rules.length === 0) {
    log.info('No rules for pull_request_review_requested')
    return
  }

  const repoName = payload.repository?.full_name || 'unknown'
  const rule = rules.find((r) => matchesRepo(repoName, r.repos || []))
  if (!rule) {
    log.info(`No matching rule for pull_request_review_requested in ${repoName}`)
    return
  }

  const prNumber = payload.pull_request?.number || 'unknown'
  const prTitle = payload.pull_request?.title || 'unknown'
  log.info(
    `Processing pull_request review_requested: #${prNumber} "${prTitle}" requested reviewer=${requestedReviewer} team=${requestedTeam} in ${repoName}`
  )

  try {
    await executeRuleCommands(
      rule,
      ctx.payload as Record<string, unknown>,
      'pull_request_review_requested',
      ctx.integrationHandledSquadIds
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('pull_request_review_requested command failed:', errorMsg)
    throw new Error(`PR review_requested command failed: ${errorMsg}`)
  }
}

/**
 * Handler for GitHub pull_request events when a PR is merged.
 * Triggers only when action is "closed" and pull_request.merged is true.
 * Uses YAML-configured action rules to run commands on PR merge.
 */
export const handleGithubPullRequestMerge: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as unknown as GithubPullRequestPayload
  await indexGithubIssueForConfiguredSquads(payload)

  // Only handle merged PRs (action=closed + merged=true)
  if (payload.action !== 'closed' || !payload.pull_request?.merged) {
    log.info(`pull_request event ignored (action=${payload.action}, merged=${payload.pull_request?.merged})`)
    return
  }

  if (!actionConfig) {
    log.warn('No action config loaded, skipping pull_request merge handling')
    return
  }

  const rules = getEventRules(actionConfig, 'github', 'pull_request_merge')
  if (!rules || rules.length === 0) {
    log.info('No rules for pull_request_merge')
    return
  }

  const baseRef = payload.pull_request.base?.ref || 'unknown'
  const targetRef = `refs/heads/${baseRef}`
  const repoName = payload.repository?.full_name || 'unknown'

  // Find matching rule by target branch and repo
  const rule = rules.find((r) => {
    // Check branch match
    const branchMatch =
      !r.branches ||
      r.branches.some((b) => {
        if (b === '*') return true
        if (b.includes('*')) {
          const regex = new RegExp('^' + b.replace(/\*/g, '.*') + '$')
          return regex.test(targetRef)
        }
        return targetRef === b
      })
    if (!branchMatch) return false

    // Check repo match (if repos filter is specified)
    return matchesRepo(repoName, r.repos || [])
  })

  if (!rule) {
    log.info(`No matching rule for pull_request merge to ${targetRef}`)
    return
  }
  const prNumber = payload.pull_request.number || 'unknown'
  const prTitle = payload.pull_request.title || 'unknown'
  const headRef = payload.pull_request.head?.ref || 'unknown'

  log.info(`Processing pull_request merge: #${prNumber} "${prTitle}" (${headRef} -> ${baseRef}) in ${repoName}`)

  try {
    await executeRuleCommands(
      rule,
      ctx.payload as Record<string, unknown>,
      'pull_request_merge',
      ctx.integrationHandledSquadIds
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('pull_request_merge command failed:', errorMsg)
    throw new Error(`PR merge command failed: ${errorMsg}`)
  }
}

/**
 * Handler for GitHub ping events (sent when webhook is created)
 */
export const handleGithubPing: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as { zen?: string; hook_id?: number }
  log.info(`Ping received: "${payload.zen}" (hook_id: ${payload.hook_id})`)
}

/**
 * Payload structure for GitHub issues events
 */
interface GithubIssuesPayload {
  action?: string
  issue?: {
    number?: number
    title?: string
    body?: string | null
    html_url?: string
    user?: {
      login?: string
    }
  }
  assignee?: {
    login?: string
  }
  repository?: {
    full_name?: string
  }
}

/**
 * Handler for GitHub issues events when an issue is assigned.
 * Triggers only when action is "assigned" and user matches a connected GitHub account.
 * Uses YAML-configured action rules to create tasks via CLI.
 */
export const handleGithubIssuesAssigned: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as unknown as GithubIssuesPayload
  await indexGithubIssueForConfiguredSquads(payload)

  // Only handle assigned actions
  if (payload.action !== 'assigned') {
    log.info(`issues event ignored (action=${payload.action})`)
    return
  }

  // Check if user matches configured username
  const configuredUsers = await connectedGitHubLogins()
  if (configuredUsers.length === 0) {
    log.warn('a connected GitHub account not configured, skipping issues handling')
    return
  }

  const assignee = payload.assignee?.login
  if (!configuredUsers.includes(assignee?.toLowerCase() ?? '')) {
    log.info(`issues assigned event ignored (assignee=${assignee}, configured=${configuredUsers.join(', ')})`)
    return
  }

  if (!actionConfig) {
    log.warn('No action config loaded, skipping issues handling')
    return
  }

  const rules = getEventRules(actionConfig, 'github', 'issues_assigned')
  if (!rules || rules.length === 0) {
    log.info('No rules for issues_assigned')
    return
  }

  const repoName = payload.repository?.full_name || 'unknown'

  // Find first rule that matches repo (or has no repo filter)
  const rule = rules.find((r) => matchesRepo(repoName, r.repos || []))
  if (!rule) {
    log.info(`No matching rule for issues_assigned in ${repoName}`)
    return
  }
  const issueNumber = payload.issue?.number || 'unknown'
  const issueTitle = payload.issue?.title || 'unknown'

  log.info(`Processing issues assigned: #${issueNumber} "${issueTitle}" assigned to ${assignee} in ${repoName}`)

  try {
    await executeRuleCommands(
      rule,
      ctx.payload as Record<string, unknown>,
      'issues_assigned',
      ctx.integrationHandledSquadIds
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('issues_assigned command failed:', errorMsg)
    throw new Error(`Issues assigned command failed: ${errorMsg}`)
  }
}

/**
 * Handler for GitHub issues unassigned events.
 * Notifies squad managers when an issue is unassigned from the configured user.
 */
export const handleGithubIssuesUnassigned: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as unknown as GithubIssuesPayload
  await indexGithubIssueForConfiguredSquads(payload)

  // Only handle unassigned actions
  if (payload.action !== 'unassigned') {
    log.info(`issues event ignored (action=${payload.action})`)
    return
  }

  // Check if the unassigned user matches configured username
  const configuredUsers = await connectedGitHubLogins()
  if (configuredUsers.length === 0) {
    log.warn('a connected GitHub account not configured, skipping issues handling')
    return
  }

  const unassignee = payload.assignee?.login
  if (!configuredUsers.includes(unassignee?.toLowerCase() ?? '')) {
    log.info(`issues unassigned event ignored (unassignee=${unassignee}, configured=${configuredUsers.join(', ')})`)
    return
  }

  if (!actionConfig) {
    log.warn('No action config loaded, skipping issues handling')
    return
  }

  const rules = getEventRules(actionConfig, 'github', 'issues_unassigned')
  if (!rules || rules.length === 0) {
    log.info('No rules for issues_unassigned')
    return
  }

  const repoName = payload.repository?.full_name || 'unknown'

  // Find first rule that matches repo (or has no repo filter)
  const rule = rules.find((r) => matchesRepo(repoName, r.repos || []))
  if (!rule) {
    log.info(`No matching rule for issues_unassigned in ${repoName}`)
    return
  }
  const issueNumber = payload.issue?.number || 'unknown'
  const issueTitle = payload.issue?.title || 'unknown'

  log.info(`Processing issues unassigned: #${issueNumber} "${issueTitle}" unassigned from ${unassignee} in ${repoName}`)

  try {
    await executeRuleCommands(
      rule,
      ctx.payload as Record<string, unknown>,
      'issues_unassigned',
      ctx.integrationHandledSquadIds
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('issues_unassigned command failed:', errorMsg)
    throw new Error(`Issues unassigned command failed: ${errorMsg}`)
  }
}

/**
 * Payload structure for GitHub workflow_run events
 */
interface GithubWorkflowRunPayload {
  action?: string
  workflow_run?: {
    id?: number
    run_attempt?: number
    name?: string
    conclusion?: string
    html_url?: string
    head_branch?: string
    pull_requests?: Array<{
      number?: number
      url?: string
    }>
  }
  repository?: {
    full_name?: string
  }
}

/**
 * Extended payload structure for GitHub pull_request events (conflict-relevant fields)
 */
interface GithubPullRequestConflictPayload {
  action?: string
  pull_request?: {
    number?: number
    title?: string
    mergeable?: boolean | null
    mergeable_state?: string // "clean", "dirty", "blocked", "unstable", "unknown"
    base?: {
      ref?: string
    }
    head?: {
      ref?: string
    }
  }
  repository?: {
    full_name?: string
  }
}

/**
 * Payload structure for GitHub issue_comment events (includes PR comments)
 */
interface GithubIssueCommentPayload {
  action?: string
  issue?: {
    number?: number
    pull_request?: object // Present only if the issue is a PR
  }
  comment?: {
    body?: string
    html_url?: string
    user?: {
      login?: string
      type?: string // "User" or "Bot"
    }
  }
  repository?: {
    full_name?: string
  }
}

/**
 * Payload structure for GitHub pull_request_review_comment events
 */
interface GithubPullRequestReviewCommentPayload {
  action?: string
  pull_request?: {
    number?: number
  }
  comment?: {
    body?: string
    html_url?: string
    path?: string
    line?: number
    user?: {
      login?: string
      type?: string // "User" or "Bot"
    }
  }
  repository?: {
    full_name?: string
  }
}

/**
 * Handler for completed GitHub workflow_run events with a terminal conclusion.
 * Uses YAML-configured action rules to notify linked work streams via CLI.
 */
export const handleGithubWorkflowRun: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as unknown as GithubWorkflowRunPayload
  await indexGithubIssueForConfiguredSquads(payload)

  // Only handle completed workflows
  if (payload.action !== 'completed') {
    log.info(`workflow_run event ignored (action=${payload.action})`)
    return
  }

  // A completed workflow must include its terminal conclusion.
  const conclusion = payload.workflow_run?.conclusion
  if (conclusion == null || conclusion === '') {
    log.info('workflow_run event ignored (missing conclusion)')
    return
  }
  if (typeof conclusion !== 'string') {
    const conclusionType = Array.isArray(conclusion) ? 'array' : typeof conclusion
    log.info(`workflow_run event ignored (invalid conclusion type=${conclusionType})`)
    return
  }
  // Full-string anchors are load-bearing: do not add multiline mode or trim,
  // because embedded or trailing whitespace/control characters must remain invalid.
  if (!/^[a-z0-9_-]+$/.test(conclusion)) {
    log.info('workflow_run event ignored (invalid conclusion token shape)')
    return
  }

  // Must have an associated PR
  const prNumber = payload.workflow_run?.pull_requests?.[0]?.number
  if (!prNumber) {
    log.info('workflow_run event ignored (no associated PR)')
    return
  }

  if (!actionConfig) {
    log.warn('No action config loaded, skipping workflow_run handling')
    return
  }

  const rules = getEventRules(actionConfig, 'github', 'workflow_run')
  if (!rules || rules.length === 0) {
    log.info('No rules for workflow_run')
    return
  }

  const repoName = payload.repository?.full_name || 'unknown'

  // Find first rule that matches repo (or has no repo filter)
  const rule = rules.find((r) => matchesRepo(repoName, r.repos || []))
  if (!rule) {
    log.info(`No matching rule for workflow_run in ${repoName}`)
    return
  }
  const workflowName = payload.workflow_run?.name || 'unknown'
  // const workflowUrl = payload.workflow_run?.html_url || 'unknown'
  const headBranch = payload.workflow_run?.head_branch || 'unknown'

  log.info(
    `Processing workflow_run ${conclusion}: "${workflowName}" for PR #${prNumber} (branch: ${headBranch}) in ${repoName}`
  )

  try {
    await executeRuleCommands(
      rule,
      ctx.payload as Record<string, unknown>,
      'workflow_run',
      ctx.integrationHandledSquadIds
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('workflow_run command failed:', errorMsg)
    throw new Error(`Workflow run command failed: ${errorMsg}`)
  }
}

/**
 * Handler for GitHub pull_request events when a PR has merge conflicts.
 * Triggers when action is "synchronize" or "opened" and mergeable_state is "dirty".
 * Uses YAML-configured action rules to reject tasks via CLI.
 */
export const handleGithubPullRequestConflict: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as unknown as GithubPullRequestConflictPayload
  await indexGithubIssueForConfiguredSquads(payload)
  const action = payload.action

  // Only handle synchronize (branch updated) or opened (new PR) actions
  if (action !== 'synchronize' && action !== 'opened') {
    return
  }

  const pr = payload.pull_request

  // Skip if still computing mergeability
  if (pr?.mergeable === null || pr?.mergeable === undefined) {
    log.info('pull_request conflict check skipped (mergeable still computing)')
    return
  }

  // Only act on actual merge conflicts (dirty state)
  if (pr?.mergeable !== false || pr?.mergeable_state !== 'dirty') {
    return
  }

  // Has merge conflicts - proceed with action config
  if (!actionConfig) {
    log.warn('No action config loaded, skipping pull_request conflict handling')
    return
  }

  const rules = getEventRules(actionConfig, 'github', 'pull_request_conflict')
  if (!rules || rules.length === 0) {
    log.info('No rules for pull_request_conflict')
    return
  }

  const repoName = payload.repository?.full_name || 'unknown'

  // Find first rule that matches repo (or has no repo filter)
  const rule = rules.find((r) => matchesRepo(repoName, r.repos || []))
  if (!rule) {
    log.info(`No matching rule for pull_request_conflict in ${repoName}`)
    return
  }
  const prNumber = pr?.number || 'unknown'
  const prTitle = pr?.title || 'unknown'
  const baseBranch = pr?.base?.ref || 'unknown'
  const headBranch = pr?.head?.ref || 'unknown'

  log.info(`Processing merge conflict: PR #${prNumber} "${prTitle}" (${headBranch} -> ${baseBranch}) in ${repoName}`)

  try {
    await executeRuleCommands(
      rule,
      ctx.payload as Record<string, unknown>,
      'pull_request_conflict',
      ctx.integrationHandledSquadIds
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('pull_request_conflict command failed:', errorMsg)
    throw new Error(`PR conflict command failed: ${errorMsg}`)
  }
}

/**
 * Handler for GitHub issue_comment events on PRs.
 * Triggers only when action is "created" and the comment is on a PR (not a regular issue).
 * Skips bot comments and own comments (matching a connected GitHub account).
 * Uses YAML-configured action rules to reject tasks via CLI.
 */
export const handleGithubIssueComment: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as unknown as GithubIssueCommentPayload
  await indexGithubIssueForConfiguredSquads(payload)

  // Only handle created comments
  if (payload.action !== 'created') {
    log.info(`issue_comment event ignored (action=${payload.action})`)
    return
  }

  // Skip bot comments
  if (payload.comment?.user?.type === 'Bot') {
    log.info('issue_comment event ignored (bot comment)')
    return
  }

  // Skip own comments to avoid self-loops
  const configuredUsers = await connectedGitHubLogins()
  if (configuredUsers.includes(payload.comment?.user?.login?.toLowerCase() ?? '')) {
    log.info(`issue_comment event ignored (own comment from ${configuredUsers.join(', ')})`)
    return
  }

  if (!actionConfig) {
    log.warn('No action config loaded, skipping issue_comment handling')
    return
  }

  const rules = getEventRules(actionConfig, 'github', 'issue_comment')
  if (!rules || rules.length === 0) {
    log.info('No rules for issue_comment')
    return
  }

  const repoName = payload.repository?.full_name || 'unknown'

  // Find first rule that matches repo (or has no repo filter)
  const rule = rules.find((r) => matchesRepo(repoName, r.repos || []))
  if (!rule) {
    log.info(`No matching rule for issue_comment in ${repoName}`)
    return
  }
  const number = payload.issue?.number || 'unknown'
  const commentUser = payload.comment?.user?.login || 'unknown'
  const isPr = !!payload.issue?.pull_request

  log.info(`Processing issue_comment: ${isPr ? 'PR' : 'Issue'} #${number} comment from ${commentUser} in ${repoName}`)

  try {
    await executeRuleCommands(
      rule,
      ctx.payload as Record<string, unknown>,
      'issue_comment',
      ctx.integrationHandledSquadIds
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('issue_comment command failed:', errorMsg)
    throw new Error(`Issue comment command failed: ${errorMsg}`)
  }
}

/**
 * Handler for GitHub pull_request_review_comment events.
 * Checks batcher first for batched handling, otherwise uses YAML-configured action rules.
 * Triggers only when action is "created" (ignores edits/deletes).
 * Skips bot comments and own comments (matching a connected GitHub account).
 */
export const handleGithubPullRequestReviewComment: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as unknown as GithubPullRequestReviewCommentPayload
  await indexGithubIssueForConfiguredSquads(payload)

  // Only handle created comments
  if (payload.action !== 'created') {
    log.info(`pull_request_review_comment event ignored (action=${payload.action})`)
    return
  }

  // Skip bot comments
  if (payload.comment?.user?.type === 'Bot') {
    log.info('pull_request_review_comment event ignored (bot comment)')
    return
  }

  // Skip own comments to avoid self-loops
  const configuredUsers = await connectedGitHubLogins()
  if (configuredUsers.includes(payload.comment?.user?.login?.toLowerCase() ?? '')) {
    log.info(`pull_request_review_comment event ignored (own comment from ${configuredUsers.join(', ')})`)
    return
  }

  // Check if this event should be batched
  if (webhookBatcher.handleEvent('github', 'pull_request_review_comment', ctx.payload as Record<string, unknown>)) {
    log.info('pull_request_review_comment event batched')
    return
  }

  // Fall through to normal handling if not batched
  if (!actionConfig) {
    log.warn('No action config loaded, skipping pull_request_review_comment handling')
    return
  }

  const rules = getEventRules(actionConfig, 'github', 'pull_request_review_comment')
  if (!rules || rules.length === 0) {
    log.info('No rules for pull_request_review_comment')
    return
  }

  const repoName = payload.repository?.full_name || 'unknown'

  // Find first rule that matches repo (or has no repo filter)
  const rule = rules.find((r) => matchesRepo(repoName, r.repos || []))
  if (!rule) {
    log.info(`No matching rule for pull_request_review_comment in ${repoName}`)
    return
  }
  const prNumber = payload.pull_request?.number || 'unknown'
  const commentUser = payload.comment?.user?.login || 'unknown'
  const commentPath = payload.comment?.path || 'unknown'
  const commentLine = payload.comment?.line || 'unknown'

  log.info(
    `Processing pull_request_review_comment: PR #${prNumber} comment from ${commentUser} on ${commentPath}:${commentLine} in ${repoName}`
  )

  try {
    await executeRuleCommands(
      rule,
      ctx.payload as Record<string, unknown>,
      'pull_request_review_comment',
      ctx.integrationHandledSquadIds
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('pull_request_review_comment command failed:', errorMsg)
    throw new Error(`PR review comment command failed: ${errorMsg}`)
  }
}
