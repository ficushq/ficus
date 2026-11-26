import { expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { apiUnavailable } from '../test/apiMock'
import { acquireDomHarness } from '../test/domHarness'
import { workStreamReads } from '../test/workStreamApi'
import { MemoryRouter } from 'react-router'
import type { Agent, Squad, WorkStream } from '@ficus/shared'
import { queryKeys } from '../queryKeys'

const permissions = new Set<string>()
const permissionsLoading = false

const { WorkStreamDetailModal } = await import('./WorkStreamDetailModal')

const now = new Date('2026-01-01T00:00:00Z')
const squad: Squad = {
  id: 'squad-1',
  name: 'Ficus',
  purpose: 'Build Ficus',
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

function reviewWorkStream(): WorkStream {
  return {
    id: 'ws-1',
    squadId: squad.id,
    title: 'Review gated actions',
    description: 'Check controls.',
    status: 'active',
    derivedState: 'in_review',
    openWaits: [
      {
        id: 'wait-1',
        workStreamId: 'ws-1',
        type: 'review',
        referenceId: null,
        message: 'Review this',
        createdBy: 'agent',
        createdByAgentId: null,
        createdByUserId: null,
        completesOnApproval: false,
        openedAt: now.toISOString(),
        closedAt: null,
        resolution: null,
        resolutionNote: null,
      },
    ],
    assigneeAgentId: null,
    agentIds: [],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    completionMode: 'review-approval',
    createdAt: now,
    updatedAt: now,
  }
}

async function renderModal<T = string>(
  options: { workStream?: WorkStream; focusWaitId?: string; actionCanRespond?: boolean } = {},
  inspect: (dom: Awaited<ReturnType<typeof acquireDomHarness>>) => T | Promise<T> = (dom) =>
    dom.window.document.body.innerHTML as T
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  if (!permissionsLoading) {
    queryClient.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: [...permissions] })
  }
  const dom = await acquireDomHarness({
    url: 'http://localhost/work-streams/ws-1',
    // The server answers with the same permissions the cache was seeded with.
    api: {
      ...workStreamReads,
      '/api/auth/permissions': () => (permissionsLoading ? apiUnavailable : { permissions: [...permissions] }),
    },
    beforeUnmount: async () => queryClient.cancelQueries(),
    afterUnmount: () => queryClient.clear(),
  })
  const rendered = dom.createRoot()
  try {
    await dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <WorkStreamDetailModal
              workStream={options.workStream ?? reviewWorkStream()}
              focusWaitId={options.focusWaitId}
              actionCanRespond={options.actionCanRespond}
              squadMap={new Map([[squad.id, squad]])}
              agentMap={new Map<string, Agent>()}
              onClose={() => undefined}
            />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    return await inspect(dom)
  } finally {
    await dom.cleanup()
  }
}

test('stored inputs and workspace files share one Attachments list, each with its source, and open in the viewer', async () => {
  const stream: WorkStream = {
    ...reviewWorkStream(),
    files: ['docs/plans/notes.md'],
    assetAttachments: [
      {
        id: 'share-1',
        workStreamId: 'ws-1',
        attemptId: null,
        source: { kind: 'image', imageId: '22222222-2222-4222-8222-222222222222' },
        filename: '22222222-2222-4222-8222-222222222222.png',
        contentType: 'image/png',
        byteSize: 4,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
  const { client } = await import('../api/clientInstance')
  const download = spyOn(client.workStreams, 'downloadAssetAttachment').mockResolvedValue(
    new Uint8Array([137, 80, 78, 71])
  )
  const create = spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:stored-input')
  const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  try {
    const result = await renderModal({ workStream: stream }, async (dom) => {
      const body = dom.window.document.body
      const text = body.textContent ?? ''
      const card = [...body.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('22222222-2222-4222-8222-222222222222.png')
      )!
      const workspaceCard = [...body.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('notes.md')
      )!
      const workspace = { text: workspaceCard.textContent ?? '', title: workspaceCard.getAttribute('title') }
      const lists = body.querySelectorAll('section[aria-label="Attachments"]').length
      const detail = card.textContent ?? ''
      await dom.act(async () => card.click())
      await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
      const image = body.querySelector<HTMLImageElement>('img[alt="22222222-2222-4222-8222-222222222222.png"]')
      return { text, workspace, lists, detail, src: image?.getAttribute('src') ?? null }
    })
    expect(result.lists).toBe(1)
    expect(result.text).not.toContain('Stored inputs')
    // A workspace file shows its name and source; the full path stays reachable on the row.
    expect(result.workspace.text).toContain('Workspace file')
    expect(result.workspace.text).not.toContain('docs/plans/notes.md')
    expect(result.workspace.title).toBe('docs/plans/notes.md')
    // An ID is never presented as a path.
    expect(result.detail).toContain('From chat')
    expect(result.detail).not.toContain('/')
    expect(download.mock.calls[0]!.slice(0, 2)).toEqual(['ws-1', 'share-1'])
    expect(result.src).toBe('blob:stored-input')
  } finally {
    create.mockRestore()
    revoke.mockRestore()
    download.mockRestore()
  }
})

test('the Attachments list is hidden when the stream has no files', async () => {
  const text = await renderModal(
    { workStream: reviewWorkStream() },
    (dom) => dom.window.document.body.textContent ?? ''
  )
  expect(text).not.toContain('Attachments')
})
