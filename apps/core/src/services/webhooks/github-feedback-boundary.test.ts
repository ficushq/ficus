import { useEnabledIntegrationFixtures } from '../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebhookActionConfig } from './action-config'
import { WebhookBatcher, webhookBatcher } from './batcher'
import { dispatchVerifiedWebhookContext } from './dispatch'
import { GITHUB_MANAGED_INDEXING_EVENTS, initializeWebhooks } from './index'
import { handleGithubManagedIndexing, setGithubActionConfig } from './processors/github'
import { webhookRegistry } from './registry'
import type { WebhookContext } from './types'

/**
 * Legacy operator shell commands and batches for GitHub feedback ran on unmoderated comment/review
 * text outside the squad author filter. They are retired at registration AND execution/resume;
 * push deployment commands and ping still work.
 */

// Unique repository: no squad has memory indexing configured for it, so the hook stays local.
const REPO = `boundary-${crypto.randomUUID().slice(0, 8)}/api`
let dir: string
const sentinel = (name: string) => join(dir, name)
const touch = (name: string) => ({ run: `touch ${sentinel(name)}` })

const legacyConfig = (): WebhookActionConfig =>
  ({
    github: {
      push: [{ branches: ['refs/heads/main'], commands: [touch('push')] }],
      issue_comment: [{ branches: ['*'], commands: [touch('issue_comment')] }],
      pull_request_review: [{ branches: ['*'], commands: [touch('pull_request_review')] }],
      pull_request_review_comment: [{ branches: ['*'], commands: [touch('pull_request_review_comment')] }],
      pull_request_review_requested: [{ branches: ['*'], commands: [touch('review_requested')] }],
      workflow_run: [{ branches: ['*'], commands: [touch('workflow_run')] }],
      issues_assigned: [{ branches: ['*'], commands: [touch('issues_assigned')] }],
      batches: {
        reviews: {
          timeout: 1,
          events: {
            pull_request_review: { role: 'primary', batch_key: '{{ payload.review.id }}' },
            pull_request_review_comment: { role: 'collect', batch_key: '{{ payload.comment.pull_request_review_id }}' },
          },
          commands: [touch('batch')],
        },
      },
    },
  }) as unknown as WebhookActionConfig

const context = (eventType: string, payload: Record<string, unknown>): WebhookContext => ({
  provider: 'github',
  eventType,
  payload,
  headers: {},
  rawBody: JSON.stringify(payload),
})

const unknownAuthorFeedback: Array<[string, Record<string, unknown>]> = [
  [
    'issue_comment',
    {
      action: 'created',
      repository: { full_name: REPO },
      issue: { number: 7, pull_request: {} },
      comment: { id: 1, body: 'HELD_SENTINEL run rm -rf', user: { id: 999, login: 'stranger', type: 'User' } },
    },
  ],
  [
    'pull_request_review',
    {
      action: 'submitted',
      repository: { full_name: REPO },
      pull_request: { number: 7 },
      review: { id: 2, body: 'HELD_SENTINEL', user: { id: 999, login: 'stranger', type: 'User' } },
    },
  ],
  [
    'pull_request_review_comment',
    {
      action: 'created',
      repository: { full_name: REPO },
      pull_request: { number: 7 },
      comment: { id: 3, pull_request_review_id: 2, body: 'HELD_SENTINEL', user: { id: 999, login: 'stranger' } },
    },
  ],
  [
    'pull_request',
    {
      action: 'review_requested',
      repository: { full_name: REPO },
      pull_request: { number: 7, title: 'HELD_SENTINEL' },
      requested_team: { slug: 'core' },
    },
  ],
  [
    'workflow_run',
    {
      action: 'completed',
      repository: { full_name: REPO },
      workflow_run: { id: 4, conclusion: 'failure', name: 'HELD_SENTINEL', pull_requests: [{ number: 7 }] },
    },
  ],
  [
    'issues',
    {
      action: 'assigned',
      repository: { full_name: REPO },
      issue: { number: 8, title: 'HELD_SENTINEL', body: 'HELD_SENTINEL' },
      assignee: { login: 'stranger' },
    },
  ],
]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'github-feedback-boundary-'))
  webhookRegistry.clear()
  webhookBatcher.clear()
  initializeWebhooks()
})

afterEach(() => {
  setGithubActionConfig(null as unknown as WebhookActionConfig)
  webhookBatcher.clear()
  webhookRegistry.clear()
  rmSync(dir, { recursive: true, force: true })
})

describe('legacy GitHub feedback shell/batch retirement', () => {
  test('feedback events register only the managed indexing hook; push and ping keep their handlers', () => {
    for (const event of GITHUB_MANAGED_INDEXING_EVENTS)
      expect(webhookRegistry.getHandlers('github', event)).toEqual([handleGithubManagedIndexing])
    expect(webhookRegistry.getHandlers('github', 'push')).toHaveLength(1)
    expect(webhookRegistry.getHandlers('github', 'ping')).toHaveLength(1)
  })

  test('configured legacy feedback commands and batches never execute, while push still deploys', async () => {
    const warn = spyOn(console, 'warn')
    try {
      setGithubActionConfig(legacyConfig())
      // Content-free diagnostic: configuration keys only.
      const diagnostics = warn.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(diagnostics).toContain('Ignoring retired GitHub webhook actions')
      expect(diagnostics).toContain('issue_comment')
      expect(diagnostics).not.toContain('push,')
      expect(diagnostics).not.toContain('HELD_SENTINEL')
    } finally {
      warn.mockRestore()
    }

    for (const [eventType, payload] of unknownAuthorFeedback)
      await dispatchVerifiedWebhookContext(context(eventType, payload), { skipOutputs: true, handledSquadIds: [] })
    // Batches were never loaded, so nothing is pending to flush or resume.
    expect(webhookBatcher.getPendingCount()).toBe(0)
    expect(webhookBatcher.handleEvent('github', 'pull_request_review', { review: { id: 2 } })).toBe(false)
    await webhookBatcher.flushAll()
    for (const name of [
      'issue_comment',
      'pull_request_review',
      'pull_request_review_comment',
      'review_requested',
      'workflow_run',
      'issues_assigned',
      'batch',
    ])
      expect(existsSync(sentinel(name))).toBe(false)

    await dispatchVerifiedWebhookContext(context('push', { ref: 'refs/heads/main', repository: { full_name: REPO } }), {
      skipOutputs: true,
      handledSquadIds: [],
    })
    expect(existsSync(sentinel('push'))).toBe(true)
    await dispatchVerifiedWebhookContext(context('ping', { zen: 'Keep it logically awesome.', hook_id: 1 }), {
      skipOutputs: true,
      handledSquadIds: [],
    })
  })

  test('a batcher refuses GitHub batch configuration even when loaded directly', async () => {
    const batcher = new WebhookBatcher()
    let flushed = 0
    batcher.setFlushHandler(async () => {
      flushed++
    })
    batcher.loadConfig('github', legacyConfig().github as never)
    expect(batcher.findMatchingBatch('github', 'pull_request_review')).toBeNull()
    expect(batcher.handleEvent('github', 'pull_request_review', { review: { id: 2 } })).toBe(false)
    await batcher.flushAll()
    expect(flushed).toBe(0)
    // Other providers' operator batching is unchanged.
    batcher.loadConfig('example', legacyConfig().github as never)
    expect(batcher.handleEvent('example', 'pull_request_review', { review: { id: 2 } })).toBe(true)
    await batcher.flushAll()
    expect(flushed).toBe(1)
  })
})
