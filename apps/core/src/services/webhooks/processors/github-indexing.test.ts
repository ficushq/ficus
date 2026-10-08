import { describe, expect, it } from 'bun:test'
import { Squad } from '../../../entities/Squad'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'
import { IndexingService } from '../../memory'
import {
  sourceCapabilities,
  type DiscoveredItem,
  type FetchedContent,
  type MemorySourceAdapter,
} from '../../memory/sources'
import type { IndexResult } from '../../memory/sources'
import type { WebhookContext } from '../types'
import { handleGithubManagedIndexing, indexGithubIssueForConfiguredSquads, squadsWithRepoConfigured } from './github'

class FakeGithubIssueAdapter implements MemorySourceAdapter {
  readonly sourceType = 'github_issue'
  readonly capabilities = sourceCapabilities(['searchable', 'readable', 'incremental', 'external'])
  readonly defaultSensitivity = 'internal' as const
  readonly indexed: Array<{ squadId: string; sourceId: string }> = []

  async list(): Promise<DiscoveredItem[]> {
    return []
  }

  async fetch(): Promise<FetchedContent | null> {
    return null
  }

  async index(squadId: string, sourceId: string): Promise<IndexResult> {
    this.indexed.push({ squadId, sourceId })
    return { success: true, chunksCreated: 0, linksCreated: 0 }
  }

  async indexAll(): Promise<IndexResult[]> {
    return []
  }

  async exists(): Promise<boolean> {
    return false
  }

  async remove(): Promise<void> {}

  async reconcile(): Promise<{ removed: number }> {
    return { removed: 0 }
  }
}

async function createConfiguredSquad(repo: string): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8)
  const squad = await Squad.create({ name: `GitHub indexing ${suffix}`, purpose: 'test' })
  await SquadSourceConfig.upsert({
    squadId: squad.id,
    sourceType: 'github_issue',
    enabled: true,
    policy: { version: 1, scope: { repos: [repo] } },
  })
  return squad.id
}

function registerFakeGithubIssueAdapter(): FakeGithubIssueAdapter {
  IndexingService._reset()
  const fake = new FakeGithubIssueAdapter()
  IndexingService.instance().registerAdapter(fake)
  return fake
}

describe('GitHub webhook memory indexing', () => {
  it('finds configured squads and indexes affected issues', async () => {
    const squadId = await createConfiguredSquad('acme/api')

    expect(await squadsWithRepoConfigured('acme/api')).toContain(squadId)

    const fake = registerFakeGithubIssueAdapter()

    await indexGithubIssueForConfiguredSquads({ repository: { full_name: 'acme/api' }, issue: { number: 42 } })

    expect(fake.indexed).toContainEqual({ squadId, sourceId: 'acme/api#42' })
  })

  it('reindexes associated GitHub issue/PR when a workflow_run webhook references it', async () => {
    const squadId = await createConfiguredSquad('acme/api')
    const fake = registerFakeGithubIssueAdapter()
    const ctx: WebhookContext = {
      provider: 'github',
      eventType: 'workflow_run',
      payload: {
        action: 'requested',
        workflow_run: {
          id: 12345,
          name: 'CI',
          conclusion: null,
          pull_requests: [{ number: 43 }],
        },
        repository: { full_name: 'acme/api' },
      },
      headers: {},
      rawBody: '{}',
    }

    await handleGithubManagedIndexing(ctx)

    expect(fake.indexed).toContainEqual({ squadId, sourceId: 'acme/api#43' })
  })

  it('reindexes changed pull requests for configured squads', async () => {
    const squadId = await createConfiguredSquad('acme/api')
    const fake = registerFakeGithubIssueAdapter()
    const ctx: WebhookContext = {
      provider: 'github',
      eventType: 'pull_request',
      payload: {
        action: 'synchronize',
        pull_request: {
          number: 44,
          mergeable: null,
          mergeable_state: 'unknown',
        },
        repository: { full_name: 'acme/api' },
      },
      headers: {},
      rawBody: '{}',
    }

    await handleGithubManagedIndexing(ctx)

    expect(fake.indexed).toContainEqual({ squadId, sourceId: 'acme/api#44' })
  })
})
