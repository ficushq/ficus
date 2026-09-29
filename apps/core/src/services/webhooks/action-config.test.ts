import { describe, it, expect } from 'bun:test'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { MONOREPO_ROOT } from '../../lib/paths'
import {
  loadWebhookActionConfig,
  matchesBranch,
  matchesRepo,
  getMatchingRule,
  resolveEnvTemplates,
  WebhookActionConfigError,
} from './action-config'
import type { WebhookActionConfig } from './action-config'
import { mkdtemp, rm } from 'node:fs/promises'

describe('webhooks/action-config', () => {
  it('retires old bundled rules and review batches while preserving custom commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ficus-retired-webhooks-'))
    const path = join(dir, 'actions.yaml')
    try {
      await Bun.write(
        path,
        `github:
  pull_request_merge:
    - commands:
        - run: config/webhooks/scripts/pull-request-merge.sh
    - commands:
        - run: echo custom-merge
  issue_comment:
    - commands:
        - run: bash /srv/ficus/config/webhooks/scripts/issue-comment.sh
        - run: /srv/custom/issue-comment.sh
  batches:
    pr_review:
      timeout: 5000
      events:
        pull_request_review:
          role: primary
          batch_key: '{{ payload.review.id }}'
      commands:
        - run: config/webhooks/scripts/pull-request-review-batched.sh
linear:
  issue_assigned:
    - commands:
        - run: ./config/webhooks/scripts/linear-issue-assigned.sh
`
      )
      const config = await loadWebhookActionConfig(path)
      expect(config.github.pull_request_merge).toHaveLength(1)
      expect(config.github.pull_request_merge[0]!.commands).toEqual([{ run: 'echo custom-merge' }])
      expect(config.github.issue_comment[0]!.commands).toEqual([{ run: '/srv/custom/issue-comment.sh' }])
      expect(config.github.batches).toEqual({})
      expect(config.linear.issue_assigned).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  describe('loadWebhookActionConfig', () => {
    it('ships no shell notification rules', async () => {
      const configPath = join(__dirname, '../../../../../config/webhooks/actions.yaml')
      const config = await loadWebhookActionConfig(configPath)

      expect(config).toEqual({ github: {}, linear: {} })
    })

    it('throws on missing file', async () => {
      await expect(loadWebhookActionConfig('/nonexistent/path.yaml')).rejects.toThrow()
    })

    it('defaults branches to wildcard when not provided', async () => {
      const tmpPath = join(__dirname, '../../../../../.tmp-test-config.yaml')
      await Bun.write(tmpPath, `github:\n  push:\n    - commands:\n        - run: "echo hi"\n`)

      try {
        const config = await loadWebhookActionConfig(tmpPath)
        expect(config.github.push[0].branches).toEqual(['*'])
      } finally {
        const { unlink } = await import('fs/promises')
        await unlink(tmpPath).catch(() => {})
      }
    })

    it('throws WebhookActionConfigError for missing commands', async () => {
      const tmpPath = join(__dirname, '../../../../../.tmp-test-config2.yaml')
      await Bun.write(tmpPath, `github:\n  push:\n    - branches: ["refs/heads/main"]\n`)

      try {
        await expect(loadWebhookActionConfig(tmpPath)).rejects.toThrow(WebhookActionConfigError)
      } finally {
        const { unlink } = await import('fs/promises')
        await unlink(tmpPath).catch(() => {})
      }
    })

    it('throws WebhookActionConfigError for missing run in command', async () => {
      const tmpPath = join(__dirname, '../../../../../.tmp-test-config3.yaml')
      await Bun.write(
        tmpPath,
        `github:\n  push:\n    - branches: ["refs/heads/main"]\n      commands:\n        - timeout: 5000\n`
      )

      try {
        await expect(loadWebhookActionConfig(tmpPath)).rejects.toThrow(WebhookActionConfigError)
      } finally {
        const { unlink } = await import('fs/promises')
        await unlink(tmpPath).catch(() => {})
      }
    })

    it('parses optional timeout field', async () => {
      const tmpPath = join(__dirname, '../../../../../.tmp-test-config4.yaml')
      await Bun.write(
        tmpPath,
        `github:\n  push:\n    - branches: ["refs/heads/main"]\n      commands:\n        - run: "echo hi"\n          timeout: 30000\n`
      )

      try {
        const config = await loadWebhookActionConfig(tmpPath)
        expect(config.github.push[0].commands[0].timeout).toBe(30000)
      } finally {
        const { unlink } = await import('fs/promises')
        await unlink(tmpPath).catch(() => {})
      }
    })

    it('parses optional cwd field', async () => {
      const tmpPath = join(__dirname, '../../../../../.tmp-test-config5.yaml')
      await Bun.write(
        tmpPath,
        `github:\n  push:\n    - branches: ["refs/heads/main"]\n      cwd: "/opt/app"\n      commands:\n        - run: "echo hi"\n`
      )

      try {
        const config = await loadWebhookActionConfig(tmpPath)
        expect(config.github.push[0].cwd).toBe('/opt/app')
      } finally {
        const { unlink } = await import('fs/promises')
        await unlink(tmpPath).catch(() => {})
      }
    })

    it('parses optional repos field', async () => {
      const tmpPath = join(__dirname, '../../../../../.tmp-test-config6.yaml')
      await Bun.write(
        tmpPath,
        `github:\n  push:\n    - branches: ["refs/heads/main"]\n      repos: ["ficusagent/ficus-management"]\n      commands:\n        - run: "echo hi"\n`
      )

      try {
        const config = await loadWebhookActionConfig(tmpPath)
        expect(config.github.push[0].repos).toEqual(['ficusagent/ficus-management'])
      } finally {
        const { unlink } = await import('fs/promises')
        await unlink(tmpPath).catch(() => {})
      }
    })

    it('throws WebhookActionConfigError for empty repos array', async () => {
      const tmpPath = join(__dirname, '../../../../../.tmp-test-config7.yaml')
      await Bun.write(
        tmpPath,
        `github:\n  push:\n    - branches: ["refs/heads/main"]\n      repos: []\n      commands:\n        - run: "echo hi"\n`
      )

      try {
        await expect(loadWebhookActionConfig(tmpPath)).rejects.toThrow(WebhookActionConfigError)
      } finally {
        const { unlink } = await import('fs/promises')
        await unlink(tmpPath).catch(() => {})
      }
    })
  })

  describe('matchesBranch', () => {
    it('matches exact ref', () => {
      expect(matchesBranch('refs/heads/main', ['refs/heads/main'])).toBe(true)
    })

    it('does not match different ref', () => {
      expect(matchesBranch('refs/heads/develop', ['refs/heads/main'])).toBe(false)
    })

    it('matches wildcard *', () => {
      expect(matchesBranch('refs/heads/anything', ['*'])).toBe(true)
    })

    it('matches glob pattern refs/heads/*', () => {
      expect(matchesBranch('refs/heads/feature/test', ['refs/heads/*'])).toBe(true)
    })

    it('matches glob pattern with prefix', () => {
      expect(matchesBranch('refs/heads/release-1.0', ['refs/heads/release-*'])).toBe(true)
    })

    it('does not match unrelated glob', () => {
      expect(matchesBranch('refs/tags/v1.0', ['refs/heads/*'])).toBe(false)
    })

    it('matches if any pattern in array matches', () => {
      expect(matchesBranch('refs/heads/staging', ['refs/heads/main', 'refs/heads/staging'])).toBe(true)
    })

    it('returns false for empty patterns', () => {
      expect(matchesBranch('refs/heads/main', [])).toBe(false)
    })
  })

  describe('matchesRepo', () => {
    it('matches exact repo name', () => {
      expect(matchesRepo('ficusagent/ficus-management', ['ficusagent/ficus-management'])).toBe(true)
    })

    it('does not match different repo', () => {
      expect(matchesRepo('other/repo', ['ficusagent/ficus-management'])).toBe(false)
    })

    it('matches wildcard *', () => {
      expect(matchesRepo('any/repo', ['*'])).toBe(true)
    })

    it('matches glob pattern org/*', () => {
      expect(matchesRepo('ficusagent/any-repo', ['ficusagent/*'])).toBe(true)
    })

    it('matches glob pattern with prefix', () => {
      expect(matchesRepo('ficusagent/ficus-management', ['ficusagent/ficus-*'])).toBe(true)
    })

    it('does not match unrelated glob', () => {
      expect(matchesRepo('other/repo', ['ficusagent/*'])).toBe(false)
    })

    it('matches if any pattern in array matches', () => {
      expect(matchesRepo('ficusagent/ficus-management', ['other/repo', 'ficusagent/ficus-management'])).toBe(true)
    })

    it('returns true for empty patterns (matches all)', () => {
      expect(matchesRepo('any/repo', [])).toBe(true)
    })

    it('returns true for undefined patterns (matches all)', () => {
      expect(matchesRepo('any/repo', undefined as unknown as string[])).toBe(true)
    })
  })

  describe('getMatchingRule', () => {
    const config: WebhookActionConfig = {
      github: {
        push: [
          {
            branches: ['refs/heads/main'],
            commands: [{ run: 'deploy.sh' }],
          },
          {
            branches: ['refs/heads/staging'],
            commands: [{ run: 'deploy-staging.sh' }],
          },
          {
            branches: ['*'],
            commands: [{ run: 'echo fallback' }],
          },
        ],
      },
    }

    it('returns first matching rule', () => {
      const rule = getMatchingRule(config, 'github', 'push', 'refs/heads/main')
      expect(rule).not.toBeNull()
      expect(rule!.commands[0].run).toBe('deploy.sh')
    })

    it('returns second rule for staging', () => {
      const rule = getMatchingRule(config, 'github', 'push', 'refs/heads/staging')
      expect(rule).not.toBeNull()
      expect(rule!.commands[0].run).toBe('deploy-staging.sh')
    })

    it('returns wildcard fallback for unknown branch', () => {
      const rule = getMatchingRule(config, 'github', 'push', 'refs/heads/feature/x')
      expect(rule).not.toBeNull()
      expect(rule!.commands[0].run).toBe('echo fallback')
    })

    it('returns null for unknown provider', () => {
      const rule = getMatchingRule(config, 'gitlab', 'push', 'refs/heads/main')
      expect(rule).toBeNull()
    })

    it('returns null for unknown event type', () => {
      const rule = getMatchingRule(config, 'github', 'pull_request', 'refs/heads/main')
      expect(rule).toBeNull()
    })

    it('first-match-wins: main before wildcard', () => {
      const rule = getMatchingRule(config, 'github', 'push', 'refs/heads/main')
      expect(rule!.commands[0].run).toBe('deploy.sh')
    })

    it('filters by repo when repo is provided and rule has repos', () => {
      const configWithRepos: WebhookActionConfig = {
        github: {
          push: [
            {
              branches: ['refs/heads/main'],
              repos: ['ficusagent/ficus-management'],
              commands: [{ run: 'deploy-ficus.sh' }],
            },
            {
              branches: ['refs/heads/main'],
              commands: [{ run: 'deploy-other.sh' }],
            },
          ],
        },
      }

      // With matching repo, first rule matches
      const rule1 = getMatchingRule(configWithRepos, 'github', 'push', 'refs/heads/main', 'ficusagent/ficus-management')
      expect(rule1).not.toBeNull()
      expect(rule1!.commands[0].run).toBe('deploy-ficus.sh')

      // With different repo, first rule skipped, second rule matches
      const rule2 = getMatchingRule(configWithRepos, 'github', 'push', 'refs/heads/main', 'other/repo')
      expect(rule2).not.toBeNull()
      expect(rule2!.commands[0].run).toBe('deploy-other.sh')
    })

    it('matches rule without repos filter when repo is provided', () => {
      const configNoRepos: WebhookActionConfig = {
        github: {
          push: [
            {
              branches: ['refs/heads/main'],
              commands: [{ run: 'deploy.sh' }],
            },
          ],
        },
      }

      // Rule without repos filter should still match when repo is provided
      const rule = getMatchingRule(configNoRepos, 'github', 'push', 'refs/heads/main', 'any/repo')
      expect(rule).not.toBeNull()
      expect(rule!.commands[0].run).toBe('deploy.sh')
    })

    it('matches rule with repos filter when repo is not provided', () => {
      const configWithRepos: WebhookActionConfig = {
        github: {
          push: [
            {
              branches: ['refs/heads/main'],
              repos: ['ficusagent/ficus-management'],
              commands: [{ run: 'deploy.sh' }],
            },
          ],
        },
      }

      // Rule with repos filter should still match when repo is undefined (backward compat)
      const rule = getMatchingRule(configWithRepos, 'github', 'push', 'refs/heads/main')
      expect(rule).not.toBeNull()
      expect(rule!.commands[0].run).toBe('deploy.sh')
    })

    it('returns null when no rule matches repo', () => {
      const configWithRepos: WebhookActionConfig = {
        github: {
          push: [
            {
              branches: ['refs/heads/main'],
              repos: ['ficusagent/ficus-management'],
              commands: [{ run: 'deploy.sh' }],
            },
          ],
        },
      }

      // No matching repo, no fallback rule
      const rule = getMatchingRule(configWithRepos, 'github', 'push', 'refs/heads/main', 'other/repo')
      expect(rule).toBeNull()
    })
  })

  describe('resolveEnvTemplates', () => {
    it('resolves simple dot path', () => {
      const payload = { review: { state: 'approved' } }
      const env = { STATE: '{{ payload.review.state }}' }
      const result = resolveEnvTemplates(env, payload)
      expect(result.STATE).toBe('approved')
    })

    it('resolves numeric values as strings', () => {
      const payload = { pull_request: { number: 42 } }
      const env = { PR: '{{ payload.pull_request.number }}' }
      const result = resolveEnvTemplates(env, payload)
      expect(result.PR).toBe('42')
    })

    it('resolves missing path as empty string', () => {
      const payload = {}
      const env = { X: '{{ payload.missing.path }}' }
      const result = resolveEnvTemplates(env, payload)
      expect(result.X).toBe('')
    })

    it('passes through non-template values', () => {
      const env = { STATIC: 'hello' }
      const result = resolveEnvTemplates(env, {})
      expect(result.STATIC).toBe('hello')
    })

    describe('filters', () => {
      it('applies tojson filter', () => {
        const payload = { issue: { labels: [{ name: 'bug' }, { name: 'urgent' }] } }
        const env = { LABELS: '{{ payload.issue.labels | tojson }}' }
        const result = resolveEnvTemplates(env, payload)
        expect(result.LABELS).toBe('[{"name":"bug"},{"name":"urgent"}]')
      })

      it('applies map filter to extract field from array', () => {
        const payload = { issue: { labels: [{ name: 'bug' }, { name: 'urgent' }] } }
        const env = { NAMES: '{{ payload.issue.labels | map(.name) | tojson }}' }
        const result = resolveEnvTemplates(env, payload)
        expect(result.NAMES).toBe('["bug","urgent"]')
      })

      it('applies join filter with separator', () => {
        const payload = { issue: { labels: [{ name: 'bug' }, { name: 'urgent' }] } }
        const env = { LABELS: '{{ payload.issue.labels | map(.name) | join(",") }}' }
        const result = resolveEnvTemplates(env, payload)
        expect(result.LABELS).toBe('bug,urgent')
      })

      it('applies join filter with custom separator', () => {
        const payload = { tags: ['a', 'b', 'c'] }
        const env = { TAGS: '{{ payload.tags | join(" | ") }}' }
        const result = resolveEnvTemplates(env, payload)
        expect(result.TAGS).toBe('a | b | c')
      })

      it('applies join filter without args defaults to comma', () => {
        const payload = { tags: ['a', 'b', 'c'] }
        const env = { TAGS: '{{ payload.tags | join }}' }
        const result = resolveEnvTemplates(env, payload)
        expect(result.TAGS).toBe('a,b,c')
      })

      it('chains multiple filters: map then tojson', () => {
        const payload = {
          issue: {
            labels: [
              { name: 'bug', id: 1 },
              { name: 'feature', id: 2 },
            ],
          },
        }
        const env = { LABEL_NAMES_JSON: '{{ payload.issue.labels | map(.name) | tojson }}' }
        const result = resolveEnvTemplates(env, payload)
        expect(result.LABEL_NAMES_JSON).toBe('["bug","feature"]')
      })

      it('handles empty array with filters', () => {
        const payload = { issue: { labels: [] } }
        const env = { LABELS: '{{ payload.issue.labels | map(.name) | tojson }}' }
        const result = resolveEnvTemplates(env, payload)
        expect(result.LABELS).toBe('[]')
      })

      it('handles missing path with filters gracefully', () => {
        const payload = {}
        const env = { LABELS: '{{ payload.issue.labels | map(.name) | tojson }}' }
        const result = resolveEnvTemplates(env, payload)
        expect(result.LABELS).toBe('')
      })

      it('applies truthy filter for PR vs issue detection', () => {
        const prPayload = { issue: { pull_request: { url: 'https://api.github.com/pulls/1' } } }
        const issuePayload = { issue: {} }
        const env = { IS_PR: '{{ payload.issue.pull_request | truthy }}' }
        expect(resolveEnvTemplates(env, prPayload).IS_PR).toBe('true')
        expect(resolveEnvTemplates(env, issuePayload).IS_PR).toBe('false')
      })
    })
  })
})

describe('webhooks/action-config — cwd resolution', () => {
  async function loadYaml(body: string): Promise<WebhookActionConfig> {
    const tmpPath = join(tmpdir(), `ficus-action-cwd-${Math.random().toString(36).slice(2)}.yaml`)
    await Bun.write(tmpPath, body)
    try {
      return await loadWebhookActionConfig(tmpPath)
    } finally {
      const { unlink } = await import('fs/promises')
      await unlink(tmpPath).catch(() => {})
    }
  }

  it('expands a leading ~ in a rule cwd', async () => {
    const config = await loadYaml('github:\n  push:\n    - cwd: "~/proj"\n      commands:\n        - run: "echo hi"\n')
    expect(config.github.push[0].cwd).toBe(join(homedir(), 'proj'))
  })

  it('expands a leading ~ in a batch cwd', async () => {
    const config = await loadYaml(
      'github:\n  batches:\n    nightly:\n      timeout: 60\n      cwd: "~/proj"\n      events:\n        push:\n          role: primary\n          batch_key: "k"\n      commands:\n        - run: "echo hi"\n'
    )
    expect(config.github.batches?.nightly.cwd).toBe(join(homedir(), 'proj'))
  })

  it('leaves an absolute cwd untouched', async () => {
    const config = await loadYaml(
      'github:\n  push:\n    - cwd: "/srv/proj"\n      commands:\n        - run: "echo hi"\n'
    )
    expect(config.github.push[0].cwd).toBe('/srv/proj')
  })

  it('resolves a relative cwd against the monorepo root, not the process cwd', async () => {
    const config = await loadYaml('github:\n  push:\n    - cwd: "scripts"\n      commands:\n        - run: "echo hi"\n')
    expect(config.github.push[0].cwd).toBe(resolve(MONOREPO_ROOT, 'scripts'))
  })
})
