import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
import { getSecretStore } from '../../secrets'
import { GITHUB_WEBHOOK_SETTINGS_KEY } from '../../integrations/github/webhook-settings'
const githubFixtures: Awaited<ReturnType<typeof createTestGitHubConnection>>[] = []
afterEach(async () => {
  for (const fixture of githubFixtures.splice(0)) await fixture.dispose()
})
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import { describe, it, expect, spyOn, afterEach, beforeEach } from 'bun:test'
import { createHmac } from 'crypto'
import {
  githubProcessor,
  handleGithubPush,
  handleGithubPing,
  handleGithubPullRequestMerge,
  handleGithubPullRequestConflict,
  handleGithubIssuesAssigned,
  handleGithubWorkflowRun,
  handleGithubIssueComment,
  handleGithubPullRequestReviewComment,
  handleGithubPullRequestReviewRequested,
  setGithubActionConfig,
} from './github'
import type { WebhookContext } from '../types'
import type { WebhookActionConfig } from '../action-config'

describe('webhooks/processors/github', () => {
  describe('githubProcessor', () => {
    it('has correct provider name', () => {
      expect(githubProcessor.provider).toBe('github')
    })

    describe('verifySignature', () => {
      const secret = 'test-secret-12345'

      it('returns true for valid signature', async () => {
        const rawBody = JSON.stringify({ test: 'data' })
        const expectedSig = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')

        const ctx: WebhookContext = {
          provider: 'github',
          eventType: 'push',
          payload: { test: 'data' },
          headers: { 'x-hub-signature-256': expectedSig },
          rawBody,
        }

        const result = await githubProcessor.verifySignature(ctx, secret)
        expect(result).toBe(true)
      })

      it('returns false for invalid signature', async () => {
        const ctx: WebhookContext = {
          provider: 'github',
          eventType: 'push',
          payload: { test: 'data' },
          headers: { 'x-hub-signature-256': 'sha256=invalid' },
          rawBody: JSON.stringify({ test: 'data' }),
        }

        const result = await githubProcessor.verifySignature(ctx, secret)
        expect(result).toBe(false)
      })

      it('returns false for missing signature header', async () => {
        const ctx: WebhookContext = {
          provider: 'github',
          eventType: 'push',
          payload: {},
          headers: {},
          rawBody: '{}',
        }

        const result = await githubProcessor.verifySignature(ctx, secret)
        expect(result).toBe(false)
      })

      it('returns false for wrong secret', async () => {
        const rawBody = JSON.stringify({ test: 'data' })
        const expectedSig = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')

        const ctx: WebhookContext = {
          provider: 'github',
          eventType: 'push',
          payload: { test: 'data' },
          headers: { 'x-hub-signature-256': expectedSig },
          rawBody,
        }

        const result = await githubProcessor.verifySignature(ctx, 'wrong-secret')
        expect(result).toBe(false)
      })

      it('returns false when payload was tampered with', async () => {
        const originalBody = JSON.stringify({ test: 'original' })
        const expectedSig = 'sha256=' + createHmac('sha256', secret).update(originalBody).digest('hex')

        // Signature was computed for original, but body was modified
        const ctx: WebhookContext = {
          provider: 'github',
          eventType: 'push',
          payload: { test: 'tampered' },
          headers: { 'x-hub-signature-256': expectedSig },
          rawBody: JSON.stringify({ test: 'tampered' }),
        }

        const result = await githubProcessor.verifySignature(ctx, secret)
        expect(result).toBe(false)
      })
    })

    describe('getEventType', () => {
      it('extracts event type from x-github-event header', () => {
        const ctx: WebhookContext = {
          provider: 'github',
          eventType: '',
          payload: {},
          headers: { 'x-github-event': 'push' },
          rawBody: '{}',
        }

        const eventType = githubProcessor.getEventType(ctx)
        expect(eventType).toBe('push')
      })

      it("returns 'unknown' when header is missing", () => {
        const ctx: WebhookContext = {
          provider: 'github',
          eventType: '',
          payload: {},
          headers: {},
          rawBody: '{}',
        }

        const eventType = githubProcessor.getEventType(ctx)
        expect(eventType).toBe('unknown')
      })
    })

    describe('getSecret', () => {
      it('reads only the integration-owned webhook secret', () => {
        const get = spyOn(getSecretStore(), 'get').mockImplementation((key) =>
          key === GITHUB_WEBHOOK_SETTINGS_KEY ? 'integration-secret' : 'legacy-secret'
        )
        try {
          expect(githubProcessor.getSecret()).toBe('integration-secret')
          expect(get).toHaveBeenCalledWith(GITHUB_WEBHOOK_SETTINGS_KEY)
        } finally {
          get.mockRestore()
        }
      })
      it('does not fall back to legacy secrets when disabled', () => {
        const get = spyOn(getSecretStore(), 'get').mockImplementation((key) =>
          key === GITHUB_WEBHOOK_SETTINGS_KEY ? '' : 'legacy-secret'
        )
        try {
          expect(githubProcessor.getSecret()).toBeNull()
        } finally {
          get.mockRestore()
        }
      })
    })
  })

  describe('handleGithubPullRequestReviewRequested', () => {
    const testConfig: WebhookActionConfig = {
      github: {
        pull_request_review_requested: [
          {
            branches: [],
            commands: [{ run: 'echo review requested' }],
          },
        ],
      },
    }

    const originalUser = process.env.GITHUB_USER

    beforeEach(async () => {
      setGithubActionConfig(testConfig)
      githubFixtures.push(await createTestGitHubConnection({ login: 'tau-bot' }))
    })

    afterEach(async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
      if (originalUser !== undefined) process.env.GITHUB_USER = originalUser
      else delete process.env.GITHUB_USER
    })

    it('ignores non-review_requested pull_request actions', async () => {
      const consoleSpy = spyOn(console, 'log')
      await handleGithubPullRequestReviewRequested({
        provider: 'github',
        eventType: 'pull_request',
        headers: {},
        rawBody: '{}',
        payload: {
          action: 'opened',
          pull_request: { number: 10, title: 'PR title' },
          repository: { full_name: 'owner/repo' },
        },
      })
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request review_requested event ignored (action=opened)'
      )
      consoleSpy.mockRestore()
    })

    it('executes commands for matching requested reviewer', async () => {
      const consoleSpy = spyOn(console, 'log')
      await handleGithubPullRequestReviewRequested({
        provider: 'github',
        eventType: 'pull_request',
        headers: {},
        rawBody: '{}',
        payload: {
          action: 'review_requested',
          requested_reviewer: { login: 'tau-bot' },
          pull_request: { number: 42, title: 'Add feature', html_url: 'https://github.com/owner/repo/pull/42' },
          repository: { full_name: 'owner/repo' },
        },
      })
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing pull_request review_requested: #42 "Add feature" requested reviewer=tau-bot team= in owner/repo'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo review requested`')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request_review_requested commands completed'
      )
      consoleSpy.mockRestore()
    })

    it('executes commands for requested team even when requested_reviewer is absent', async () => {
      const consoleSpy = spyOn(console, 'log')
      await handleGithubPullRequestReviewRequested({
        provider: 'github',
        eventType: 'pull_request',
        headers: {},
        rawBody: '{}',
        payload: {
          action: 'review_requested',
          requested_team: { slug: 'tau-reviewers', name: 'Ficus Reviewers' },
          pull_request: { number: 43, title: 'Team PR', html_url: 'https://github.com/owner/repo/pull/43' },
          repository: { full_name: 'owner/repo' },
        },
      })
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request_review_requested commands completed'
      )
      consoleSpy.mockRestore()
    })

    it('warns and skips user review requests when GITHUB_USER is not configured', async () => {
      for (const fixture of githubFixtures.splice(0)) await fixture.dispose()
      const warnSpy = spyOn(console, 'warn')
      await handleGithubPullRequestReviewRequested({
        provider: 'github',
        eventType: 'pull_request',
        headers: {},
        rawBody: '{}',
        payload: {
          action: 'review_requested',
          requested_reviewer: { login: 'tau-bot' },
          pull_request: { number: 45, title: 'User PR' },
          repository: { full_name: 'owner/repo' },
        },
      })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'a connected GitHub account not configured, skipping pull_request review_requested user review request'
      )
      warnSpy.mockRestore()
    })

    it('ignores requested reviewers that do not match GITHUB_USER when no team is requested', async () => {
      const consoleSpy = spyOn(console, 'log')
      await handleGithubPullRequestReviewRequested({
        provider: 'github',
        eventType: 'pull_request',
        headers: {},
        rawBody: '{}',
        payload: {
          action: 'review_requested',
          requested_reviewer: { login: 'someone-else' },
          pull_request: { number: 44, title: 'Other PR' },
          repository: { full_name: 'owner/repo' },
        },
      })
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request review_requested event ignored (requested_reviewer=someone-else, configured=tau-bot)'
      )
      consoleSpy.mockRestore()
    })
  })

  describe('handleGithubPush', () => {
    const testConfig: WebhookActionConfig = {
      github: {
        push: [
          {
            branches: ['refs/heads/main'],
            commands: [{ run: 'echo deploy' }],
          },
        ],
      },
    }

    beforeEach(async () => {
      setGithubActionConfig(testConfig)
    })

    afterEach(async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
    })

    it('logs no matching rule for unmatched branches', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'push',
        payload: {
          ref: 'refs/heads/feature/test',
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPush(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No matching rule for push to refs/heads/feature/test'
      )
      consoleSpy.mockRestore()
    })

    it('warns and skips when no config loaded', async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
      const warnSpy = spyOn(console, 'warn')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'push',
        payload: {
          ref: 'refs/heads/main',
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPush(ctx)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No action config loaded, skipping push handling'
      )
      warnSpy.mockRestore()
    })

    it('executes commands for matching branch', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'push',
        payload: {
          ref: 'refs/heads/main',
          repository: { full_name: 'test/repo' },
          head_commit: { message: 'test commit', id: 'abc1234567' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPush(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing push to refs/heads/main for test/repo'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo deploy`')
      )
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[github-webhook]'), 'push commands completed')
      consoleSpy.mockRestore()
    })

    it('filters by repo when repos filter is configured', async () => {
      const configWithRepoFilter: WebhookActionConfig = {
        github: {
          push: [
            {
              branches: ['refs/heads/main'],
              repos: ['ficusagent/tau-management'],
              commands: [{ run: 'echo deploy-tau' }],
            },
          ],
        },
      }
      setGithubActionConfig(configWithRepoFilter)
      const consoleSpy = spyOn(console, 'log')

      // Should not match - different repo
      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'push',
        payload: {
          ref: 'refs/heads/main',
          repository: { full_name: 'other/repo' },
          head_commit: { message: 'test commit', id: 'abc1234567' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPush(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No matching rule for push to refs/heads/main'
      )
      consoleSpy.mockRestore()
    })

    it('executes commands when repo matches filter', async () => {
      const configWithRepoFilter: WebhookActionConfig = {
        github: {
          push: [
            {
              branches: ['refs/heads/main'],
              repos: ['ficusagent/tau-management'],
              commands: [{ run: 'echo deploy-tau' }],
            },
          ],
        },
      }
      setGithubActionConfig(configWithRepoFilter)
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'push',
        payload: {
          ref: 'refs/heads/main',
          repository: { full_name: 'ficusagent/tau-management' },
          head_commit: { message: 'test commit', id: 'abc1234567' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPush(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing push to refs/heads/main for ficusagent/tau-management'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo deploy-tau`')
      )
      consoleSpy.mockRestore()
    })
  })

  describe('handleGithubPullRequestMerge', () => {
    const testConfig: WebhookActionConfig = {
      github: {
        pull_request_merge: [
          {
            branches: ['refs/heads/main'],
            commands: [{ run: 'echo merged' }],
          },
        ],
      },
    }

    beforeEach(async () => {
      setGithubActionConfig(testConfig)
    })

    afterEach(async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
    })

    it('ignores non-closed actions', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'opened',
          pull_request: { number: 1, merged: false },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestMerge(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request event ignored (action=opened, merged=false)'
      )
      consoleSpy.mockRestore()
    })

    it('ignores closed but not merged PRs', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'closed',
          pull_request: { number: 2, merged: false },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestMerge(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request event ignored (action=closed, merged=false)'
      )
      consoleSpy.mockRestore()
    })

    it('warns and skips when no config loaded', async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
      const warnSpy = spyOn(console, 'warn')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'closed',
          pull_request: { number: 3, merged: true, base: { ref: 'main' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestMerge(ctx)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No action config loaded, skipping pull_request merge handling'
      )
      warnSpy.mockRestore()
    })

    it('logs no matching rule for unmatched target branch', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'closed',
          pull_request: { number: 4, merged: true, base: { ref: 'develop' }, head: { ref: 'feature/test' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestMerge(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No matching rule for pull_request merge to refs/heads/develop'
      )
      consoleSpy.mockRestore()
    })

    it('executes commands for merged PR targeting matching branch', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'closed',
          pull_request: {
            number: 5,
            merged: true,
            title: 'Add new feature',
            base: { ref: 'main' },
            head: { ref: 'feature/cool' },
            user: { login: 'testuser' },
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestMerge(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing pull_request merge: #5 "Add new feature" (feature/cool -> main) in test/repo'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo merged`')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request_merge commands completed'
      )
      consoleSpy.mockRestore()
    })

    it('logs no rules when pull_request config is missing', async () => {
      setGithubActionConfig({ github: { push: [] } })
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'closed',
          pull_request: { number: 6, merged: true, base: { ref: 'main' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestMerge(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No rules for pull_request_merge'
      )
      consoleSpy.mockRestore()
    })
  })

  describe('handleGithubPing', () => {
    it('logs ping event details', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'ping',
        payload: {
          zen: 'Keep it logically awesome.',
          hook_id: 12345,
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPing(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Ping received: "Keep it logically awesome." (hook_id: 12345)'
      )
      consoleSpy.mockRestore()
    })
  })

  describe('handleGithubIssuesAssigned', () => {
    const testConfig: WebhookActionConfig = {
      github: {
        issues_assigned: [
          {
            branches: [],
            commands: [{ run: 'echo task created' }],
          },
        ],
      },
    }

    const originalUser = process.env.GITHUB_USER

    beforeEach(async () => {
      setGithubActionConfig(testConfig)
      githubFixtures.push(await createTestGitHubConnection())
    })

    afterEach(async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
      if (originalUser !== undefined) {
        process.env.GITHUB_USER = originalUser
      } else {
        for (const fixture of githubFixtures.splice(0)) await fixture.dispose()
      }
    })

    it('ignores non-assigned actions', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issues',
        payload: {
          action: 'opened',
          issue: { number: 1, title: 'Test Issue' },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssuesAssigned(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'issues event ignored (action=opened)'
      )
      consoleSpy.mockRestore()
    })

    it('warns and skips when GITHUB_USER not configured', async () => {
      for (const fixture of githubFixtures.splice(0)) await fixture.dispose()
      const warnSpy = spyOn(console, 'warn')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issues',
        payload: {
          action: 'assigned',
          issue: { number: 2, title: 'Test Issue' },
          assignee: { login: 'someuser' },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssuesAssigned(ctx)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'a connected GitHub account not configured, skipping issues handling'
      )
      warnSpy.mockRestore()
    })

    it('ignores assignments to non-configured users', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issues',
        payload: {
          action: 'assigned',
          issue: { number: 3, title: 'Test Issue' },
          assignee: { login: 'otheruser' },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssuesAssigned(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'issues assigned event ignored (assignee=otheruser, configured=testbot)'
      )
      consoleSpy.mockRestore()
    })

    it('warns and skips when no config loaded', async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
      const warnSpy = spyOn(console, 'warn')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issues',
        payload: {
          action: 'assigned',
          issue: { number: 4, title: 'Test Issue' },
          assignee: { login: 'testbot' },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssuesAssigned(ctx)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No action config loaded, skipping issues handling'
      )
      warnSpy.mockRestore()
    })

    it('logs no rules when issues_assigned config is missing', async () => {
      setGithubActionConfig({ github: { push: [] } })
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issues',
        payload: {
          action: 'assigned',
          issue: { number: 5, title: 'Test Issue' },
          assignee: { login: 'testbot' },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssuesAssigned(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No rules for issues_assigned'
      )
      consoleSpy.mockRestore()
    })

    it('executes commands for matching assignment', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issues',
        payload: {
          action: 'assigned',
          issue: {
            number: 6,
            title: 'Add new feature',
            body: 'Please implement this feature',
            html_url: 'https://github.com/test/repo/issues/6',
          },
          assignee: { login: 'testbot' },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssuesAssigned(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing issues assigned: #6 "Add new feature" assigned to testbot in test/repo'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo task created`')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'issues_assigned commands completed'
      )
      consoleSpy.mockRestore()
    })
  })

  describe('handleGithubWorkflowRun', () => {
    const testConfig: WebhookActionConfig = {
      github: {
        workflow_run: [
          {
            branches: [],
            commands: [{ run: 'echo ci failed' }],
          },
        ],
      },
    }

    beforeEach(async () => {
      setGithubActionConfig(testConfig)
    })

    afterEach(async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
    })

    it('ignores non-completed actions', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'workflow_run',
        payload: {
          action: 'requested',
          workflow_run: {
            id: 12345,
            name: 'CI',
            conclusion: null,
            pull_requests: [{ number: 1 }],
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubWorkflowRun(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'workflow_run event ignored (action=requested)'
      )
      consoleSpy.mockRestore()
    })

    it('executes commands for successful workflow with associated PR', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'workflow_run',
        payload: {
          action: 'completed',
          workflow_run: {
            id: 12345,
            name: 'CI',
            conclusion: 'success',
            html_url: 'https://github.com/test/repo/actions/runs/12345',
            head_branch: 'feature/test',
            pull_requests: [{ number: 2 }],
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubWorkflowRun(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing workflow_run success: "CI" for PR #2 (branch: feature/test) in test/repo'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo ci failed`')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'workflow_run commands completed'
      )
      consoleSpy.mockRestore()
    })

    for (const conclusion of ['cancelled', 'timed_out']) {
      it(`executes commands for ${conclusion} workflow`, async () => {
        const consoleSpy = spyOn(console, 'log')

        const ctx: WebhookContext = {
          provider: 'github',
          eventType: 'workflow_run',
          payload: {
            action: 'completed',
            workflow_run: {
              id: 12345,
              name: 'CI',
              conclusion,
              pull_requests: [{ number: 3 }],
            },
            repository: { full_name: 'test/repo' },
          },
          headers: {},
          rawBody: '{}',
        }

        await handleGithubWorkflowRun(ctx)

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('[github-webhook]'),
          `Processing workflow_run ${conclusion}: "CI" for PR #3 (branch: unknown) in test/repo`
        )
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('[github-webhook]'),
          expect.stringContaining('Running: `echo ci failed`')
        )
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('[github-webhook]'),
          'workflow_run commands completed'
        )
        consoleSpy.mockRestore()
      })
    }

    it('ignores completed workflows without a conclusion', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'workflow_run',
        payload: {
          action: 'completed',
          workflow_run: {
            id: 12345,
            name: 'CI',
            conclusion: null,
            pull_requests: [{ number: 3 }],
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubWorkflowRun(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'workflow_run event ignored (missing conclusion)'
      )
      consoleSpy.mockRestore()
    })

    it('ignores completed workflows with a truthy non-string conclusion', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'workflow_run',
        payload: {
          action: 'completed',
          workflow_run: {
            id: 12345,
            name: 'CI',
            conclusion: { malformed: true },
            pull_requests: [{ number: 3 }],
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubWorkflowRun(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'workflow_run event ignored (invalid conclusion type=object)'
      )
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running:')
      )
      consoleSpy.mockRestore()
    })

    it('ignores completed workflows with an invalid conclusion token', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'workflow_run',
        payload: {
          action: 'completed',
          workflow_run: {
            id: 12345,
            name: 'CI',
            conclusion: 'failure\nspoofed',
            pull_requests: [{ number: 3 }],
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubWorkflowRun(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'workflow_run event ignored (invalid conclusion token shape)'
      )
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running:')
      )
      consoleSpy.mockRestore()
    })

    it('executes commands for an unknown valid-shaped conclusion', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'workflow_run',
        payload: {
          action: 'completed',
          workflow_run: {
            id: 12345,
            name: 'CI',
            conclusion: 'future_terminal_state',
            pull_requests: [{ number: 3 }],
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubWorkflowRun(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing workflow_run future_terminal_state: "CI" for PR #3 (branch: unknown) in test/repo'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo ci failed`')
      )
      consoleSpy.mockRestore()
    })

    it('ignores workflows without associated PRs', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'workflow_run',
        payload: {
          action: 'completed',
          workflow_run: {
            id: 12345,
            name: 'CI',
            conclusion: 'failure',
            pull_requests: [],
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubWorkflowRun(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'workflow_run event ignored (no associated PR)'
      )
      consoleSpy.mockRestore()
    })

    it('warns and skips when no config loaded', async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
      const warnSpy = spyOn(console, 'warn')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'workflow_run',
        payload: {
          action: 'completed',
          workflow_run: {
            id: 12345,
            name: 'CI',
            conclusion: 'failure',
            pull_requests: [{ number: 4 }],
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubWorkflowRun(ctx)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No action config loaded, skipping workflow_run handling'
      )
      warnSpy.mockRestore()
    })

    it('logs no rules when workflow_run config is missing', async () => {
      setGithubActionConfig({ github: { push: [] } })
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'workflow_run',
        payload: {
          action: 'completed',
          workflow_run: {
            id: 12345,
            name: 'CI',
            conclusion: 'failure',
            pull_requests: [{ number: 5 }],
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubWorkflowRun(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[github-webhook]'), 'No rules for workflow_run')
      consoleSpy.mockRestore()
    })

    it('executes commands for failed workflow with associated PR', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'workflow_run',
        payload: {
          action: 'completed',
          workflow_run: {
            id: 12345,
            name: 'CI',
            conclusion: 'failure',
            html_url: 'https://github.com/test/repo/actions/runs/12345',
            head_branch: 'feature/test',
            pull_requests: [{ number: 6, url: 'https://api.github.com/repos/test/repo/pulls/6' }],
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubWorkflowRun(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing workflow_run failure: "CI" for PR #6 (branch: feature/test) in test/repo'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo ci failed`')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'workflow_run commands completed'
      )
      consoleSpy.mockRestore()
    })
  })

  describe('handleGithubPullRequestConflict', () => {
    const testConfig: WebhookActionConfig = {
      github: {
        pull_request_conflict: [
          {
            branches: [],
            commands: [{ run: 'echo conflict detected' }],
          },
        ],
      },
    }

    beforeEach(async () => {
      setGithubActionConfig(testConfig)
    })

    afterEach(async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
    })

    it('ignores non-synchronize/opened actions', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'closed',
          pull_request: {
            number: 1,
            mergeable: false,
            mergeable_state: 'dirty',
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestConflict(ctx)

      // Should not log anything - silently skipped
      expect(consoleSpy).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('skips when mergeable is null (still computing)', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'synchronize',
          pull_request: {
            number: 2,
            mergeable: null,
            mergeable_state: 'unknown',
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestConflict(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request conflict check skipped (mergeable still computing)'
      )
      consoleSpy.mockRestore()
    })

    it('skips when mergeable is true (no conflict)', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'synchronize',
          pull_request: {
            number: 3,
            mergeable: true,
            mergeable_state: 'clean',
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestConflict(ctx)

      // Should not log anything - silently skipped
      expect(consoleSpy).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('skips when mergeable_state is blocked (not conflict)', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'synchronize',
          pull_request: {
            number: 4,
            mergeable: false,
            mergeable_state: 'blocked',
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestConflict(ctx)

      // Should not log anything - silently skipped (blocked is not conflict)
      expect(consoleSpy).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('warns and skips when no config loaded', async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
      const warnSpy = spyOn(console, 'warn')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'synchronize',
          pull_request: {
            number: 5,
            mergeable: false,
            mergeable_state: 'dirty',
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestConflict(ctx)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No action config loaded, skipping pull_request conflict handling'
      )
      warnSpy.mockRestore()
    })

    it('logs no rules when pull_request_conflict config is missing', async () => {
      setGithubActionConfig({ github: { push: [] } })
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'synchronize',
          pull_request: {
            number: 6,
            mergeable: false,
            mergeable_state: 'dirty',
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestConflict(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No rules for pull_request_conflict'
      )
      consoleSpy.mockRestore()
    })

    it('executes commands for PR with merge conflicts (synchronize action)', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'synchronize',
          pull_request: {
            number: 7,
            title: 'Add new feature',
            mergeable: false,
            mergeable_state: 'dirty',
            base: { ref: 'main' },
            head: { ref: 'feature/test' },
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestConflict(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing merge conflict: PR #7 "Add new feature" (feature/test -> main) in test/repo'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo conflict detected`')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request_conflict commands completed'
      )
      consoleSpy.mockRestore()
    })

    it('executes commands for PR with merge conflicts (opened action)', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'opened',
          pull_request: {
            number: 8,
            title: 'Another feature',
            mergeable: false,
            mergeable_state: 'dirty',
            base: { ref: 'develop' },
            head: { ref: 'feature/other' },
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestConflict(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing merge conflict: PR #8 "Another feature" (feature/other -> develop) in test/repo'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo conflict detected`')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request_conflict commands completed'
      )
      consoleSpy.mockRestore()
    })
  })

  describe('handleGithubIssueComment', () => {
    const testConfig: WebhookActionConfig = {
      github: {
        issue_comment: [
          {
            branches: [],
            commands: [{ run: 'echo pr comment received' }],
          },
        ],
      },
    }

    const originalUser = process.env.GITHUB_USER

    beforeEach(async () => {
      setGithubActionConfig(testConfig)
      githubFixtures.push(await createTestGitHubConnection())
    })

    afterEach(async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
      if (originalUser !== undefined) {
        process.env.GITHUB_USER = originalUser
      } else {
        for (const fixture of githubFixtures.splice(0)) await fixture.dispose()
      }
    })

    it('ignores non-created actions', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issue_comment',
        payload: {
          action: 'edited',
          issue: { number: 1, pull_request: {} },
          comment: { body: 'Updated comment', user: { login: 'reviewer', type: 'User' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssueComment(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'issue_comment event ignored (action=edited)'
      )
      consoleSpy.mockRestore()
    })

    it('executes commands for valid issue comment (not PR)', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issue_comment',
        payload: {
          action: 'created',
          issue: { number: 2 }, // No pull_request field = regular issue
          comment: { body: 'Comment on issue', user: { login: 'reviewer', type: 'User' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssueComment(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing issue_comment: Issue #2 comment from reviewer in test/repo'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo pr comment received`')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'issue_comment commands completed'
      )
      consoleSpy.mockRestore()
    })

    it('ignores bot comments', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issue_comment',
        payload: {
          action: 'created',
          issue: { number: 3, pull_request: {} },
          comment: { body: 'Automated comment', user: { login: 'github-actions[bot]', type: 'Bot' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssueComment(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'issue_comment event ignored (bot comment)'
      )
      consoleSpy.mockRestore()
    })

    it('ignores own comments (matches GITHUB_USER)', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issue_comment',
        payload: {
          action: 'created',
          issue: { number: 4, pull_request: {} },
          comment: { body: 'My own comment', user: { login: 'testbot', type: 'User' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssueComment(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'issue_comment event ignored (own comment from testbot)'
      )
      consoleSpy.mockRestore()
    })

    it('warns and skips when no config loaded', async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
      const warnSpy = spyOn(console, 'warn')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issue_comment',
        payload: {
          action: 'created',
          issue: { number: 5, pull_request: {} },
          comment: { body: 'Test comment', user: { login: 'reviewer', type: 'User' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssueComment(ctx)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No action config loaded, skipping issue_comment handling'
      )
      warnSpy.mockRestore()
    })

    it('logs no rules when issue_comment config is missing', async () => {
      setGithubActionConfig({ github: { push: [] } })
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issue_comment',
        payload: {
          action: 'created',
          issue: { number: 6, pull_request: {} },
          comment: { body: 'Test comment', user: { login: 'reviewer', type: 'User' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubIssueComment(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[github-webhook]'), 'No rules for issue_comment')
      consoleSpy.mockRestore()
    })

    it('executes commands for a sanitized recorded PR comment webhook', async () => {
      const consoleSpy = spyOn(console, 'log')
      const payload = await Bun.file(`${import.meta.dir}/fixtures/github-issue-comment-webhook.json`).json()
      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'issue_comment',
        payload,
        headers: {},
        rawBody: JSON.stringify(payload),
      }

      await handleGithubIssueComment(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing issue_comment: PR #42 comment from fixture-user-4 in fixture-org-2/fixture-repo-3'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo pr comment received`')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'issue_comment commands completed'
      )
      consoleSpy.mockRestore()
    })
  })

  describe('handleGithubPullRequestReviewComment', () => {
    const testConfig: WebhookActionConfig = {
      github: {
        pull_request_review_comment: [
          {
            branches: [],
            commands: [{ run: 'echo pr review comment received' }],
          },
        ],
      },
    }

    const originalUser = process.env.GITHUB_USER

    beforeEach(async () => {
      setGithubActionConfig(testConfig)
      githubFixtures.push(await createTestGitHubConnection())
    })

    afterEach(async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
      if (originalUser !== undefined) {
        process.env.GITHUB_USER = originalUser
      } else {
        for (const fixture of githubFixtures.splice(0)) await fixture.dispose()
      }
    })

    it('ignores non-created actions', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request_review_comment',
        payload: {
          action: 'deleted',
          pull_request: { number: 1 },
          comment: { body: 'Deleted comment', user: { login: 'reviewer', type: 'User' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestReviewComment(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request_review_comment event ignored (action=deleted)'
      )
      consoleSpy.mockRestore()
    })

    it('ignores bot comments', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request_review_comment',
        payload: {
          action: 'created',
          pull_request: { number: 2 },
          comment: { body: 'Automated comment', user: { login: 'codecov[bot]', type: 'Bot' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestReviewComment(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request_review_comment event ignored (bot comment)'
      )
      consoleSpy.mockRestore()
    })

    it('ignores own comments (matches GITHUB_USER)', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request_review_comment',
        payload: {
          action: 'created',
          pull_request: { number: 3 },
          comment: {
            body: 'Self-reply',
            path: 'src/index.ts',
            line: 10,
            user: { login: 'testbot', type: 'User' },
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestReviewComment(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request_review_comment event ignored (own comment from testbot)'
      )
      consoleSpy.mockRestore()
    })

    it('warns and skips when no config loaded', async () => {
      setGithubActionConfig(null as unknown as WebhookActionConfig)
      const warnSpy = spyOn(console, 'warn')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request_review_comment',
        payload: {
          action: 'created',
          pull_request: { number: 4 },
          comment: { body: 'Test comment', user: { login: 'reviewer', type: 'User' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestReviewComment(ctx)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No action config loaded, skipping pull_request_review_comment handling'
      )
      warnSpy.mockRestore()
    })

    it('logs no rules when pull_request_review_comment config is missing', async () => {
      setGithubActionConfig({ github: { push: [] } })
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request_review_comment',
        payload: {
          action: 'created',
          pull_request: { number: 5 },
          comment: { body: 'Test comment', user: { login: 'reviewer', type: 'User' } },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestReviewComment(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'No rules for pull_request_review_comment'
      )
      consoleSpy.mockRestore()
    })

    it('executes commands for valid PR review comment from a human user', async () => {
      const consoleSpy = spyOn(console, 'log')

      const ctx: WebhookContext = {
        provider: 'github',
        eventType: 'pull_request_review_comment',
        payload: {
          action: 'created',
          pull_request: { number: 6 },
          comment: {
            body: 'This variable should be renamed',
            html_url: 'https://github.com/test/repo/pull/6#discussion_r456',
            path: 'src/utils.ts',
            line: 42,
            user: { login: 'reviewer', type: 'User' },
          },
          repository: { full_name: 'test/repo' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPullRequestReviewComment(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing pull_request_review_comment: PR #6 comment from reviewer on src/utils.ts:42 in test/repo'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo pr review comment received`')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'pull_request_review_comment commands completed'
      )
      consoleSpy.mockRestore()
    })
  })
})
