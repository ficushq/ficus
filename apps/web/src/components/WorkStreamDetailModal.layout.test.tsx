import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { waitFor } from '@testing-library/dom'
import { MemoryRouter } from 'react-router'
import type { Agent, GlobalSquadActivityItem, Squad, WorkStream, WorkflowDefinition } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { apiUnavailable } from '../test/apiMock'
import { workStreamReads } from '../test/workStreamApi'
import { queryKeys } from '../queryKeys'

const { WorkStreamDetailModal } = await import('./WorkStreamDetailModal')

const now = new Date('2026-01-01T00:00:00Z')
const squad = { id: 'squad-1', name: 'Ficus', managerAgentId: null } as unknown as Squad

const agent = (id: string, agentTypeId: string, name: string): Agent =>
  ({ id, squadId: squad.id, agentTypeId, status: 'idle', metadata: { name }, createdAt: now }) as unknown as Agent
const engineer = agent('agent-engineer', 'engineer', 'Fern')
const manager = agent('agent-manager', 'manager', 'Cascade')

function stream(): WorkStream {
  return {
    id: 'ws-1',
    number: 12,
    squadId: squad.id,
    title: 'Make every payment retry safe',
    description: 'Retries must never charge twice.',
    status: 'active',
    derivedState: 'in_review',
    openWaits: [
      {
        id: 'wait-1',
        workStreamId: 'ws-1',
        type: 'review',
        referenceId: null,
        message: 'Please review the retry change.',
        createdBy: 'agent',
        createdByAgentId: null,
        createdByUserId: null,
        completesOnApproval: true,
        openedAt: now.toISOString(),
        closedAt: null,
        resolution: null,
        resolutionNote: null,
      },
    ],
    assigneeAgentId: engineer.id,
    ownerAgentId: manager.id,
    requestingUserId: 'a949b6a1-0000-4000-8000-000000000000',
    requestingUserName: 'Fern',
    agentIds: [engineer.id, manager.id],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    completionMode: 'pr-merge',
    createdAt: now,
    updatedAt: now,
  } as unknown as WorkStream
}

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  name: 'Reviewed Coding',
  participants: { engineer: { agentTypeId: 'engineer', session: 'reuse-within-stream' } },
  entry: 'implement',
  routing: { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' },
  limits: { maxDelegations: 0, onLimit: 'request-owner-input' },
  steps: [
    {
      id: 'implement',
      kind: 'agent',
      participant: 'engineer',
      instructions: 'Build it.',
      output: 'Evidence.',
      outcomes: { completed: { next: 'approve' } },
    },
    {
      id: 'approve',
      name: 'Your approval to release',
      kind: 'human-approval',
      approver: 'reviewers',
      instructions: 'Decide.',
      output: 'A decision.',
      outcomes: { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'implement' } },
    },
  ],
  completion: { mode: 'pr-merge' },
}

const run = {
  workStreamId: 'ws-1',
  source: null,
  version: 3,
  attemptAgents: { '1': engineer.id },
  openWaits: stream().openWaits,
  state: {
    schemaVersion: 1,
    version: 3,
    definition,
    status: 'running',
    activeAttemptId: 2,
    attempts: [
      { id: 1, stepId: 'implement', status: 'completed' },
      { id: 2, stepId: 'approve', status: 'running', sourceAttemptIds: [1] },
    ],
    returns: [],
    completedStepIds: ['implement'],
  },
}

const row = (index: number): GlobalSquadActivityItem => ({
  id: `row-${index}`,
  at: new Date(now.getTime() - index * 60_000).toISOString(),
  agentId: engineer.id,
  agentTypeId: 'engineer',
  kind: 'message',
  summary: `Step ${index} done`,
  preview: [{ text: `Step ${index} done` }],
  ref: { type: 'agent', agentId: engineer.id, view: 'chat' },
  context: { workStream: { id: 'ws-1', number: 12, title: 'Make every payment retry safe', step: 'implement' } },
  squadId: squad.id,
})

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  queryClient.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: ['workstreams:update'] })
  const activityRequests: URL[] = []
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    api: {
      ...workStreamReads,
      '/api/auth/permissions': { permissions: ['workstreams:update'] },
      '/api/workstreams/:id': ({ url }) =>
        url.searchParams.get('metrics')
          ? {
              ...stream(),
              metrics: {
                cost: 0.42,
                tokens: { total: 1200, input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
                executions: { completed: 2, total: 3 },
                byAgent: {},
              },
            }
          : apiUnavailable,
      '/api/workstreams/:id/tracked': { resources: [], subscriptions: 'active' },
      '/api/workflows/runs/:id': run,
      '/api/activity': ({ url }) => {
        activityRequests.push(url)
        return { items: [1, 2, 3, 4, 5, 6, 7].map(row), hasMore: true, nextCursor: 'next', squads: {} }
      },
    },
    beforeUnmount: async () => queryClient.cancelQueries(),
    afterUnmount: () => queryClient.clear(),
  })
  const rendered = dom.createRoot()
  await dom.act(async () =>
    rendered.root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <WorkStreamDetailModal
            workStream={stream()}
            squadMap={new Map([[squad.id, squad]])}
            agentMap={new Map([engineer, manager].map((entry) => [entry.id, entry]))}
            onClose={() => undefined}
          />
        </QueryClientProvider>
      </MemoryRouter>
    )
  )
  const body = dom.window.document.body
  await dom.act(async () => {
    await waitFor(() => {
      expect(body.querySelectorAll('[data-recent-activity-row]').length).toBeGreaterThan(0)
      expect(body.querySelector('[data-progress-step]')).not.toBeNull()
      expect(body.textContent).toContain('Cost:')
    })
  })
  return { dom, body, activityRequests }
}

const position = (body: HTMLElement, selector: string) => {
  const all = [...body.querySelectorAll('*')]
  const element = body.querySelector(selector)
  expect(element).not.toBeNull()
  return all.indexOf(element!)
}

describe('WorkStreamDetailModal layout', () => {
  test('orders the modal by what a reader asks: the callout, description, progress, recent activity, then the rest', async () => {
    const { dom, body } = await render()
    try {
      const description = [...body.querySelectorAll('label')].find((label) => label.textContent === 'Description')!
      const order = [
        position(body, 'button[title="Approve review"]'),
        [...body.querySelectorAll('*')].indexOf(description),
        position(body, 'section[aria-label="Progress"]'),
        position(body, 'section[aria-label="Recent activity"]'),
        position(body, 'details[aria-label="Work stream details"]'),
      ]
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    } finally {
      await dom.cleanup()
    }
  })

  test('shows the flow as a step list with each state and who does it', async () => {
    const { dom, body } = await render()
    try {
      const steps = [...body.querySelectorAll('[data-progress-step]')].map((step) => step.textContent)
      expect(steps).toEqual(['ImplementEngineerDone', 'Your approval to releaseReviewerWaiting for review'])
      expect(body.querySelector('[data-progress-step="approve"]')!.getAttribute('aria-current')).toBe('step')
      // The graph stays behind its own disclosure.
      expect(body.querySelector('button[aria-label="Workflow preview: Reviewed Coding"]')).not.toBeNull()
    } finally {
      await dom.cleanup()
    }
  })

  test('shows the newest five Activity rows for this stream and links to Activity filtered to it', async () => {
    const { dom, body, activityRequests } = await render()
    try {
      expect(activityRequests[0]!.searchParams.get('workStreamId')).toBe('ws-1')
      const rows = [...body.querySelectorAll('[data-recent-activity-row]')]
      expect(rows).toHaveLength(5)
      expect(rows[0]!.textContent).toContain('Engineer')
      expect(rows[0]!.textContent).toContain('Step 1 done')
      // Rows about this stream do not repeat its title.
      expect(rows[0]!.textContent).not.toContain('Make every payment retry safe')
      const link = [...body.querySelectorAll('a')].find((anchor) => anchor.textContent === 'View all in Activity')!
      expect(link.getAttribute('href')).toBe('/activity?workStream=ws-1')
    } finally {
      await dom.cleanup()
    }
  })

  test('keeps operational detail in one collapsed Details section, with nothing removed', async () => {
    const { dom, body } = await render()
    try {
      const details = body.querySelector<HTMLDetailsElement>('details[aria-label="Work stream details"]')!
      expect(details.open).toBe(false)
      const inside = details.textContent ?? ''
      for (const fact of [
        'Completion',
        'Cost:',
        'Tokens:',
        'Executions:',
        'Usage breakdown',
        'Assigned Agents',
        'Automatically clean up the worktree',
        'Track an issue, PR or alert',
        'Requester ID',
        'a949b6a1',
      ])
        expect(inside).toContain(fact)
      // The requester's id is gone from the default view; the name stays.
      const outside = (body.textContent ?? '').replace(inside, '')
      expect(outside).toContain('Requested by')
      expect(outside).not.toContain('a949b6a1')
      // Nothing is tracked, so the tracked section is not at the top level.
      expect(outside).not.toContain('Tracked issues, PRs and alerts')
      expect(outside).not.toContain('Nothing tracked')
    } finally {
      await dom.cleanup()
    }
  })

  test('names agents by type first, never by their name alone', async () => {
    const { dom, body } = await render()
    try {
      const assignee = [...body.querySelectorAll('label')].find((label) => label.textContent === 'Assignee')!
      const owner = [...body.querySelectorAll('label')].find((label) => label.textContent === 'Owner')!
      expect(assignee.parentElement!.textContent).toBe('AssigneeEngineer')
      expect(owner.parentElement!.textContent).toBe('OwnerManager')
      expect(assignee.parentElement!.querySelector('a')!.getAttribute('title')).toBe('Fern')
    } finally {
      await dom.cleanup()
    }
  })
})
