import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { WorkflowDefinition, WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { apiUnavailable, type ApiRoutes } from '../test/apiMock'
import { PermissionsProvider } from '../hooks/usePermissions'
import { untilSettled } from '../test/untilRendered'
import { WorkStreamProgress } from './WorkStreamProgress'

const stream = (assignedReviewerIds: string[] = []) =>
  ({ id: 'ws-1', squadId: 'squad-1', status: 'active', openWaits: [], assignedReviewerIds }) as unknown as WorkStream

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
      kind: 'human-approval',
      approver: 'assigned-reviewers',
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
  version: 2,
  attemptAgents: {},
  openWaits: [{ id: 'wait-1', workStreamId: 'ws-1', type: 'review', flowAttemptId: 2 }],
  state: {
    schemaVersion: 1,
    version: 2,
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

/** A viewer holding exactly these squad permissions. */
const viewer =
  (permissions: string[], userId = 'user-ana') =>
  () => ({
    permissions,
    identity: { type: 'user' as const, userId },
    can: (requested: string) => permissions.includes(requested),
    isLoading: false,
    isError: false,
  })

async function renderProgress(
  options: { stream?: WorkStream; permissions?: string[]; userId?: string; api?: ApiRoutes },
  inspect: (page: { body: HTMLElement; settle: (check: () => void) => Promise<void> }) => Promise<void>
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    api: {
      '/api/squads': apiUnavailable,
      '/api/workflows/runs/:id': run,
      // The server's real labels: "Display Name (email)", or a bare email without a name.
      '/api/workflows/reviewers': [
        { id: 'user-ana', name: 'Ana Lima (ana.lima@example.com)' },
        { id: 'user-ben', name: 'ben.okafor@example.com' },
      ],
      ...options.api,
    },
    beforeUnmount: async () => queryClient.cancelQueries(),
    afterUnmount: () => queryClient.clear(),
  })
  const settle = (check: () => void) => untilSettled(dom, check)
  try {
    const rendered = dom.createRoot()
    await dom.act(async () =>
      rendered.root.render(
        <PermissionsProvider usePermissions={viewer(options.permissions ?? ['workstreams:read'], options.userId)}>
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <WorkStreamProgress stream={options.stream ?? stream()} />
            </QueryClientProvider>
          </MemoryRouter>
        </PermissionsProvider>
      )
    )
    await inspect({ body: dom.window.document.body, settle })
  } finally {
    await dom.cleanup()
  }
}

/** A step row reads name, who, then state: "Approve", "Ana Lima or ben.okafor", "Waiting for review". */
const row = (body: HTMLElement, stepId: string) => body.querySelector(`[data-progress-step="${stepId}"]`)!.textContent

describe('WorkStreamProgress', () => {
  test('holds its place with a skeleton while the flow loads, then lists the steps', async () => {
    let answer: (value: unknown) => void = () => undefined
    const pending = new Promise((resolve) => (answer = resolve))
    await renderProgress({ api: { '/api/workflows/runs/:id': () => pending } }, async ({ body, settle }) => {
      const section = body.querySelector('section[aria-label="Progress"]')
      expect(section).not.toBeNull()
      expect(section!.querySelector('[role="status"][aria-label="Loading progress"]')).not.toBeNull()
      expect(section!.querySelector('[data-progress-step]')).toBeNull()
      answer(run)
      await settle(() => expect(body.querySelectorAll('[data-progress-step]')).toHaveLength(2))
      expect(body.querySelector('[aria-label="Loading progress"]')).toBeNull()
    })
  })

  test('renders nothing for a stream without a flow', async () => {
    await renderProgress({ api: { '/api/workflows/runs/:id': null } }, async ({ body, settle }) => {
      await settle(() => expect(body.querySelector('section[aria-label="Progress"]')).toBeNull())
    })
  })

  test('says "You" for an approval the viewer decides, and names the assigned reviewers to anyone else', async () => {
    const assigned = stream(['user-ana', 'user-ben'])
    await renderProgress(
      { stream: assigned, permissions: ['workstreams:review'], userId: 'user-ana' },
      async ({ body, settle }) => {
        await settle(() => expect(row(body, 'approve')).toBe('ApproveYou or ben.okaforWaiting for review'))
      }
    )
    await renderProgress({ stream: assigned, permissions: ['workstreams:read'] }, async ({ body, settle }) => {
      await settle(() => expect(row(body, 'approve')).toBe('ApproveAna Lima or ben.okaforWaiting for review'))
      expect(body.textContent).not.toContain('@')
    })
  })
})
