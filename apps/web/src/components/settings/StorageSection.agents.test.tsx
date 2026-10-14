import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { StorageAgent, StorageFolder, StorageSnapshot, StoredFilesSummary } from '@ficus/shared'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { StorageSection } from './StorageSection'
import { idleDormancySummary } from './storage/format'
import { queries } from '../../queryOptions'

const GiB = 1024 ** 3
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

function agentFolder(id: string, bytes: number, agent: Omit<StorageAgent, 'id' | 'createdAt'>): StorageFolder {
  return {
    name: agent.label,
    path: `/home/box_${id}`,
    bytes,
    status: 'available',
    children: [],
    kind: 'agent',
    agent: { id, createdAt: daysAgo(400), ...agent },
  }
}

const snapshot = (): StorageSnapshot => ({
  supported: true,
  scanning: false,
  scannedAt: '2026-10-10T00:00:00Z',
  error: null,
  dormantRetentionDays: 7,
  monitoring: { intervalHours: 12, alertsEnabled: true, thresholds: [80, 90, 95], nextScanAt: null },
  machines: [
    {
      id: 'machine',
      name: 'Worker',
      status: 'available',
      usedBytes: 10 * GiB,
      totalBytes: 100 * GiB,
      unattributedBytes: 0,
      squads: [
        {
          id: 'squad',
          name: 'Product',
          bytes: 4 * GiB,
          status: 'available',
          folders: [
            agentFolder('d1', 2 * GiB, {
              label: 'Old research',
              agentTypeId: 'consultant',
              status: 'dormant',
              lastMessageAt: daysAgo(30),
              dormantAt: '2026-10-01T12:00:00.000Z',
            }),
            agentFolder('d2', GiB, {
              label: 'Old build',
              agentTypeId: 'engineer',
              status: 'dormant',
              lastMessageAt: daysAgo(30),
              dormantAt: '2026-10-05T12:00:00.000Z',
            }),
            agentFolder('b', 1000, {
              label: 'Build API · Bob',
              agentTypeId: 'engineer',
              status: 'active',
              lastMessageAt: daysAgo(0),
              dormantAt: null,
            }),
            {
              name: 'Squad workspace',
              path: '/home/box_w',
              bytes: 500,
              status: 'available',
              children: [],
              kind: 'squad-workspace',
            },
            agentFolder('a', 300, {
              label: 'Plan launch · Ada',
              agentTypeId: 'consultant',
              status: 'idle',
              lastMessageAt: daysAgo(3),
              dormantAt: null,
            }),
            agentFolder('m', 50, {
              label: 'Lead',
              agentTypeId: 'manager',
              status: 'idle',
              lastMessageAt: daysAgo(1),
              dormantAt: null,
            }),
          ],
        },
      ],
    },
  ],
})

const storedFiles: StoredFilesSummary = {
  sources: [
    { key: 'agentFiles', label: 'Agent file attachments', countsTowardQuota: true, bytes: 3 * GiB },
    { key: 'inboxAttachments', label: 'Inbox attachments', countsTowardQuota: true, bytes: GiB },
    { key: 'images', label: 'Images', countsTowardQuota: false, bytes: 2048 },
  ],
  squads: [{ id: 'squad', name: 'Product', bytes: 3 * GiB + 2048, sources: { agentFiles: 3 * GiB, images: 2048 } }],
  unattributed: { bytes: GiB, sources: { inboxAttachments: GiB } },
  totalBytes: 4 * GiB + 2048,
  quotaUsedBytes: 4 * GiB,
  quotaBytes: 10 * GiB,
}

function permissions(granted: string[]) {
  return () => ({
    permissions: granted,
    can: (permission: string) => granted.includes(permission),
    isLoading: false,
    isError: false,
  })
}

function element(client: QueryClient, granted: string[]) {
  return (
    <PermissionsProvider usePermissions={permissions(granted)}>
      <QueryClientProvider client={client}>
        <StorageSection />
      </QueryClientProvider>
    </PermissionsProvider>
  )
}

function client() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queryKeys.system.storage(), snapshot())
  queryClient.setQueryData(queryKeys.system.storedFiles(), storedFiles)
  return queryClient
}

function render(granted: string[]) {
  const queryClient = client()
  try {
    return renderToStaticMarkup(element(queryClient, granted))
  } finally {
    queryClient.clear()
  }
}

const count = (html: string, text: string) => html.split(text).length - 1

describe('StorageSection agents', () => {
  test('lists the squad workspace, then agents with label, type, status and last activity, largest first', () => {
    const html = render(['system:logs'])
    expect(html).toContain('Squad workspace')
    expect(html).not.toContain('Agent files')
    expect(html).toContain('Plan launch · Ada')
    expect(html).toContain('consultant · idle · last active 3 days ago')
    expect(html).toContain('engineer · active · last active today')
    expect(html.indexOf('Squad workspace')).toBeLessThan(html.indexOf('Build API · Bob'))
    expect(html.indexOf('Build API · Bob')).toBeLessThan(html.indexOf('Plan launch · Ada'))
    expect(html.indexOf('Plan launch · Ada')).toBeLessThan(html.indexOf('>Lead<'))
  })

  test('collapses dormant agents into one summary with the automatic removal date, expandable to the list', () => {
    const html = render(['system:logs'])
    const removal = new Date(Date.parse('2026-10-01T12:00:00.000Z') + 7 * 86_400_000).toLocaleDateString()
    expect(html).toContain(`2 dormant · 3.0 GiB · removed automatically from ${removal}`)
    const group = html.slice(html.indexOf('2 dormant'))
    expect(group).toContain('Old research')
    expect(group).toContain('Old build')
    expect(html.indexOf('Old research')).toBeGreaterThan(html.indexOf('2 dormant'))
  })

  test('offers cleanup actions only with the matching permissions, never for managers or dormant agents', () => {
    const readOnly = render(['system:logs'])
    for (const label of ['Make dormant', 'Remove now', 'Make idle consultants dormant', 'Scan Nix stores'])
      expect(readOnly).not.toContain(label)

    const terminate = render(['system:logs', 'agents:terminate'])
    expect(count(terminate, '>Make dormant<')).toBe(2)
    expect(terminate).toContain('Make idle consultants dormant…')
    expect(terminate).not.toContain('Remove now')

    const cleanup = render(['system:logs', 'system:cleanup'])
    expect(cleanup).not.toContain('>Make dormant<')
    expect(count(cleanup, '>Remove now<')).toBe(2)
    expect(cleanup).toContain('Remove all 2 now')
    expect(cleanup).toContain('Scan Nix stores')
    expect(cleanup).toContain('Scan empty workspace folders')
  })

  test('a squad spanning several machines offers its squad action once', () => {
    const queryClient = client()
    const data = snapshot()
    data.machines.push({ ...data.machines[0]!, id: 'machine-2', name: 'Worker 2' })
    queryClient.setQueryData(queryKeys.system.storage(), data)
    try {
      const html = renderToStaticMarkup(element(queryClient, ['system:logs', 'agents:terminate']))
      expect(count(html, 'Make idle consultants dormant…')).toBe(1)
    } finally {
      queryClient.clear()
    }
  })

  test('agents queued for removal show Removing… and are not offered again', () => {
    const queryClient = client()
    const data = snapshot()
    data.machines[0]!.squads[0]!.folders[0]!.agent!.removalPending = true
    queryClient.setQueryData(queryKeys.system.storage(), data)
    try {
      const html = renderToStaticMarkup(element(queryClient, ['system:logs', 'system:cleanup']))
      expect(count(html, 'Removing…')).toBe(1)
      expect(count(html, '>Remove now<')).toBe(1)
      expect(html).not.toContain('Remove all')
    } finally {
      queryClient.clear()
    }
  })

  test('the storage view refetches often while a removal is pending', () => {
    const interval = queries.system.storage().refetchInterval as (query: {
      state: { data?: StorageSnapshot }
    }) => number
    const data = snapshot()
    expect(interval({ state: { data } })).toBe(300000)
    data.machines[0]!.squads[0]!.folders[0]!.agent!.removalPending = true
    expect(interval({ state: { data } })).toBe(10000)
    expect(interval({ state: { data: { ...data, scanning: true } } })).toBe(2000)
  })

  test('the idle-consultant summary states the real reason for each agent left alone', () => {
    expect(
      idleDormancySummary({
        dormant: ['a'],
        deferred: [],
        skipped: [
          { id: 'b', reason: 'became active' },
          { id: 'c', reason: 'became active' },
          { id: 'd', reason: 'Agent has active work streams.' },
        ],
      })
    ).toBe('Made 1 idle consultant dormant. Left alone: 2 became active; 1 Agent has active work streams.')
  })

  test('shows files stored by Ficus per squad and the attachment quota', () => {
    const html = render(['system:logs'])
    expect(html).toContain('Files stored by Ficus')
    expect(html).toContain('Unattributed')
    expect(html).toContain('4.0 GiB of 10.0 GiB attachment quota')
    expect(html).toContain('aria-valuenow="4294967296"')
  })

  test('edits dormant retention only with settings:write', () => {
    expect(render(['system:logs'])).not.toContain('Remove dormant agents after')
    const html = render(['system:logs', 'settings:write'])
    expect(html).toContain('Remove dormant agents after')
    expect(html).toContain('value="7"')
  })
})

async function interact(granted: string[]) {
  const dom = await acquireDomHarness({ url: 'http://localhost/settings/storage' })
  const rendered = dom.createRoot()
  const queryClient = client()
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const body = url.includes('/storage/files')
      ? storedFiles
      : url.endsWith('/system/storage')
        ? snapshot()
        : url.includes('dormant-agents/remove')
          ? { accepted: ['d1'], skipped: [] }
          : url.includes('/admin/nix-gc')
            ? {
                candidates: [
                  { sandboxId: 'agent_x', bytes: GiB, verdict: 'terminated', running: false },
                  { sandboxId: 'agent_y', bytes: GiB, verdict: 'live', running: false },
                ],
                totalReclaimableBytes: GiB,
                ...(String(init?.body).includes('apply') ? { reclaimed: ['agent_x'], failed: [] } : {}),
              }
            : url.includes('/idle-consultants/dormant')
              ? { dormant: ['a'], deferred: [], skipped: [] }
              : url.includes('/idle-consultants?days=')
                ? {
                    days: Number(new URL(url).searchParams.get('days')),
                    agents: [
                      {
                        id: 'a',
                        label: 'Plan launch · Ada',
                        status: 'idle',
                        lastMessageAt: daysAgo(120),
                        createdAt: daysAgo(400),
                        bytes: 300,
                      },
                    ],
                  }
                : {}
    return new dom.window.Response(method === 'DELETE' ? null : JSON.stringify(body), {
      status: method === 'DELETE' ? 204 : 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response
  }) as typeof fetch
  const document = dom.window.document
  const button = (text: string, root: ParentNode = document) =>
    [...root.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text)
  const dialog = () => document.querySelector('[role="dialog"]')
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i++) await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(done()).toBe(true)
  }
  await dom.act(async () => rendered.root.render(element(queryClient, granted)))
  return {
    dom,
    document,
    calls,
    button,
    dialog,
    settle,
    restore: async () => {
      globalThis.fetch = originalFetch
      queryClient.clear()
      await dom.cleanup()
    },
  }
}

describe('StorageSection cleanup dialogs', () => {
  test('Make dormant states what happens and the space it frees, then uses the terminate path', async () => {
    const ui = await interact(['system:logs', 'agents:terminate'])
    try {
      const row = [...ui.document.querySelectorAll('[data-storage-agent]')].find(
        (item) => item.getAttribute('data-storage-agent') === 'a'
      )!
      await ui.dom.act(async () => ui.button('Make dormant', row)!.click())
      const text = ui.dialog()?.textContent ?? ''
      expect(text).toContain('Plan launch · Ada')
      expect(text).toContain('No space is freed now')
      expect(text).toContain('300 B')
      expect(text).toContain('7 days')
      expect(ui.calls.some((call) => call.method === 'DELETE')).toBe(false)

      await ui.dom.act(async () => ui.button('Make dormant', ui.dialog()!)!.click())
      await ui.settle(() => ui.calls.some((call) => call.method === 'DELETE'))
      expect(ui.calls.find((call) => call.method === 'DELETE')?.url).toContain('/squads/squad/agents/a')
      await ui.settle(() => (ui.document.body.textContent ?? '').includes('Sizes update after the next scan'))
    } finally {
      await ui.restore()
    }
  })

  test('Remove now warns that the home is removed and the agent cannot be reused', async () => {
    const ui = await interact(['system:logs', 'system:cleanup'])
    try {
      const row = [...ui.document.querySelectorAll('[data-storage-agent]')].find(
        (item) => item.getAttribute('data-storage-agent') === 'd1'
      )!
      await ui.dom.act(async () => ui.button('Remove now', row)!.click())
      const text = ui.dialog()?.textContent ?? ''
      expect(text).toContain('Old research')
      expect(text).toContain('archived and removed')
      expect(text).toContain('in the background')
      expect(text).toContain('can no longer be woken or reused')
      expect(text).toContain('2.0 GiB')

      await ui.dom.act(async () => ui.button('Remove now', ui.dialog()!)!.click())
      await ui.settle(() => ui.calls.some((call) => call.url.includes('dormant-agents/remove')))
      expect(ui.calls.find((call) => call.url.includes('dormant-agents/remove'))?.body).toEqual({ agentIds: ['d1'] })
      await ui.settle(() =>
        (ui.document.body.textContent ?? '').includes('Removing 1 dormant agent in the background.')
      )
    } finally {
      await ui.restore()
    }
  })

  test('idle consultants: preview for N days, then make exactly the previewed consultants dormant', async () => {
    const ui = await interact(['system:logs', 'agents:terminate'])
    try {
      await ui.dom.act(async () => ui.button('Make idle consultants dormant…')!.click())
      await ui.settle(() => (ui.dialog()?.textContent ?? '').includes('Plan launch · Ada'))
      expect(ui.calls.some((call) => call.url.endsWith('/squads/squad/idle-consultants?days=90'))).toBe(true)
      const text = ui.dialog()!.textContent ?? ''
      expect(text).toContain('Last active 120 days ago')
      expect(text).toContain('No space is freed now')
      expect(text).toContain('300 B')

      await ui.dom.act(async () => ui.button('Make 1 dormant', ui.dialog()!)!.click())
      await ui.settle(() => ui.calls.some((call) => call.url.includes('/idle-consultants/dormant')))
      expect(ui.calls.find((call) => call.url.includes('/idle-consultants/dormant'))?.body).toEqual({
        days: 90,
        agentIds: ['a'],
      })
      await ui.settle(() => (ui.document.body.textContent ?? '').includes('Made 1 idle consultant dormant.'))
    } finally {
      await ui.restore()
    }
  })

  test('host cleanup scans first, states what will be reclaimed, and applies only after confirming', async () => {
    const ui = await interact(['system:logs', 'system:cleanup'])
    try {
      await ui.dom.act(async () => ui.button('Scan Nix stores')!.click())
      await ui.settle(() => (ui.document.body.textContent ?? '').includes('1 can be reclaimed (1.0 GiB)'))
      expect(ui.calls.find((call) => call.url.includes('/admin/nix-gc'))?.body).toEqual({})
      await ui.dom.act(async () => ui.button('Reclaim 1.0 GiB…')!.click())
      expect(ui.dialog()?.textContent).toContain('freeing about 1.0 GiB')
      await ui.dom.act(async () => ui.button('Reclaim', ui.dialog()!)!.click())
      await ui.settle(() => ui.calls.filter((call) => call.url.includes('/admin/nix-gc')).length === 2)
      expect(ui.calls.filter((call) => call.url.includes('/admin/nix-gc'))[1]?.body).toEqual({ apply: true })
      await ui.settle(() => (ui.document.body.textContent ?? '').includes('Reclaimed 1 Nix store(s).'))
    } finally {
      await ui.restore()
    }
  })
})
