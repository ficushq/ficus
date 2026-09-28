import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { Agent, Squad, WorkStream, WorkStreamDeliveryPresentation } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { WorkStreamDetailModal } from './WorkStreamDetailModal'

const now = new Date('2026-01-01T00:00:00Z')
const squad: Squad = {
  id: 'squad-1',
  name: 'Ops',
  purpose: 'Run things',
  status: 'active',
  squadPresetId: null,
  defaultAgents: [],
  managerAgentId: null,
  context: null,
  isAnonymous: false,
  globalCollaborationEnabled: false,
  order: 0,
  metadata: {},
  sandboxStatus: 'none',
  createdAt: now,
  updatedAt: now,
}

/** The #234 fact shape: completion-ready pr-merge with a bound, approved PR whose head is unsigned. */
function deliveryWorkStream(delivery?: WorkStreamDeliveryPresentation): WorkStream {
  return {
    id: 'ws-1',
    squadId: squad.id,
    title: 'Delivery setup example',
    description: '',
    status: 'active',
    derivedState: 'blocked',
    openWaits: [],
    assigneeAgentId: null,
    ownerAgentId: null,
    creatorAgentId: null,
    requestingUserId: null,
    agentIds: [],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {
      codeHost: {
        integration: 'github',
        repository: 'intentional/design',
        changeRequest: { number: 51, url: 'https://github.com/intentional/design/pull/51' },
      },
    },
    completionMode: 'pr-merge',
    createdAt: now,
    updatedAt: now,
    ...(delivery ? { delivery } : {}),
  }
}

describe('WorkStreamDetailModal delivery presentation', () => {
  let cleanup: (() => Promise<void>) | undefined
  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
  })

  async function render(workStream: WorkStream) {
    // The DOM ownership lease is process-global: release the previous render's
    // harness before acquiring the next one within the same test.
    await cleanup?.()
    cleanup = undefined
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false }, mutations: { retry: false } },
    })
    queryClient.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: ['workstreams:read'] })
    const dom = await acquireDomHarness({
      url: 'http://localhost/work-streams/ws-1',
      beforeUnmount: async () => {
        await queryClient.cancelQueries()
      },
      afterUnmount: () => queryClient.clear(),
    })
    cleanup = () => dom.cleanup()
    const rendered = dom.createRoot()
    await dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <WorkStreamDetailModal
              workStream={workStream}
              squadMap={new Map([[squad.id, squad]])}
              agentMap={new Map<string, Agent>()}
              onClose={() => undefined}
            />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    return { body: dom.window.document.body }
  }

  test('delivery_setup shows the explanatory callout with the rebind step and protection note', async () => {
    const { body } = await render(
      deliveryWorkStream({
        kind: 'setup',
        explanation: {
          setupReason: 'branch-mismatch',
          branchMismatch: { streamBranch: 'work/ws-1', pullRequestBranch: 'rework/head' },
          pullRequests: [{ number: 51, state: 'open' }],
          gates: { mergeState: 'blocked', checksState: 'success', reviewDecision: 'approved' },
        },
      })
    )
    expect(body.textContent).toContain('Delivery Setup Required')
    expect(body.textContent).toContain('What is blocking completion')
    expect(body.textContent).toContain('It completes once its delivery pull request is merged.')
    expect(body.textContent).toContain('branch protection')
    expect(body.textContent).toContain('Signing Key')
    expect(body.textContent).toContain('github.com/settings/keys')
  })

  test('delivery_setup with sparse facts degrades to the generic explanation', async () => {
    const { body } = await render(deliveryWorkStream({ kind: 'setup' }))
    expect(body.textContent).toContain('Delivery Setup Required')
    expect(body.textContent).toContain('delivery setup is incomplete')
    expect(body.textContent).toContain('Check the delivery requirements on the linked pull request')
  })

  test('the callout is absent for other delivery kinds and non-delivery states', async () => {
    const { body } = await render(deliveryWorkStream({ kind: 'merge' }))
    expect(body.textContent).not.toContain('What is blocking completion')
    const external = await render(
      deliveryWorkStream({
        kind: 'external',
        explanation: { pullRequests: [{ number: 51, state: 'open' }] },
      })
    )
    expect(external.body.textContent).not.toContain('What is blocking completion')
    const running = await render({ ...deliveryWorkStream(), derivedState: 'in_progress' })
    expect(running.body.textContent).not.toContain('What is blocking completion')
  })

  test('the modal status pill derives the external label from server facts', async () => {
    const { body } = await render(
      deliveryWorkStream({
        kind: 'external',
        explanation: { pullRequests: [{ number: 51, state: 'open' }] },
      })
    )
    expect(body.textContent).toContain('Awaiting merge of #51')
    const blocked = await render(
      deliveryWorkStream({
        kind: 'external',
        explanation: {
          pullRequests: [{ number: 51, state: 'open' }],
          gates: { mergeState: 'blocked', checksState: 'success', reviewDecision: 'approved' },
        },
      })
    )
    expect(blocked.body.textContent).toContain('Blocked by branch protection')
  })
})
