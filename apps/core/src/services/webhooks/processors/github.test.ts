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
import { githubProcessor, handleGithubPush, handleGithubPing, setGithubActionConfig } from './github'
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
              repos: ['ficusagent/ficus-management'],
              commands: [{ run: 'echo deploy-ficus' }],
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
              repos: ['ficusagent/ficus-management'],
              commands: [{ run: 'echo deploy-ficus' }],
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
          repository: { full_name: 'ficusagent/ficus-management' },
          head_commit: { message: 'test commit', id: 'abc1234567' },
        },
        headers: {},
        rawBody: '{}',
      }

      await handleGithubPush(ctx)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        'Processing push to refs/heads/main for ficusagent/ficus-management'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[github-webhook]'),
        expect.stringContaining('Running: `echo deploy-ficus`')
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
})
