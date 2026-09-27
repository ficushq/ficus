import { waitFor } from '@testing-library/dom'
import { describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { Agent, NormalizedSquadActivityFilters, SquadActivityItem } from '@ficus/shared'
import type { AuthIdentity } from '@ficus/client-core'
import { queryKeys } from '../../queryKeys'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { WebSocketContext, type WebSocketContextValue } from '../../hooks/useWebSocket'
import { acquireDomHarness } from '../../test/domHarness'
import { SquadActivityTab } from './SquadActivityTab'
import {
  ACTIVITY_SMALL_TEXT_CLASS,
  activityAccessSignature,
  formatActivityTimestamp,
  resolveActivityInboxAccess,
  squadActivityStatusMessage,
} from './squadActivityView'

const squadId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const filters: NormalizedSquadActivityFilters = { verbose: false, agentIds: [], kinds: [] }
const agent = {
  id: agentId,
  agentTypeId: 'engineer',
  squadId,
  parentAgentId: null,
  status: 'idle',
  persist: false,
  modelOverride: null,
  metadata: { name: 'Ada' },
  context: {},
  questionData: null,
  sessionUsage: null,
  terminatedAt: null,
  lastMessageAt: null,
  lastHumanMessageAt: null,
  lastMessagePreview: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  amtpHandle: null,
  identityPublicKey: null,
  inboundOpen: false,
} satisfies Agent

const waitItem: SquadActivityItem = {
  id: '41:00000000-0000-4000-8000-000000000041',
  at: '2026-08-26T12:00:00.123Z',
  agentId: null,
  agentTypeId: null,
  kind: 'wait',
  preview: [{ text: '[ws-abcd · review approved] Ship it' }],
  summary: '[ws-abcd · review approved] Ship it',
  ref: { type: 'workstream', workStreamId: '00000000-0000-4000-8000-000000000010' },
}
const messageItem: SquadActivityItem = {
  id: '20:00000000-0000-4000-8000-000000000020',
  at: '2026-08-26T11:59:00.000Z',
  agentId,
  agentTypeId: 'engineer',
  kind: 'message',
  preview: [{ text: 'Implementation ready' }],
  summary: 'Implementation ready',
  ref: { type: 'agent', agentId, view: 'inbox', messageId: '00000000-0000-4000-8000-000000000020' },
}
// Not present in the `agents` roster passed to SquadActivityTab — exercises the
// historical/terminated-agent fallback (plain viewport modal, not AgentViewModal).
const historicalAgentId = '00000000-0000-4000-8000-000000000099'
const historicalMessageItem: SquadActivityItem = {
  id: '21:00000000-0000-4000-8000-000000000021',
  at: '2026-08-26T11:58:00.000Z',
  agentId: historicalAgentId,
  agentTypeId: 'engineer',
  kind: 'message',
  preview: [{ text: 'Historical agent activity' }],
  summary: 'Historical agent activity',
  ref: {
    type: 'agent',
    agentId: historicalAgentId,
    view: 'chat',
    messageId: '00000000-0000-4000-8000-000000000021',
  },
}

// A tracked GitHub issue: the row opens the code host, while the work-stream
// chip stays in-app.
const issueItem: SquadActivityItem = {
  id: '71:00000000-0000-4000-8000-000000000071',
  at: '2026-08-26T11:57:00.000Z',
  agentId: null,
  agentTypeId: null,
  kind: 'issue',
  preview: [{ text: '[issue #12 opened] Flaky login' }],
  summary: '[issue #12 opened] Flaky login',
  ref: {
    type: 'issue',
    url: 'https://example.test/issues/12',
    workStreamId: '00000000-0000-4000-8000-000000000010',
    workStreamNumber: 12,
  },
}

const userIdentity: AuthIdentity = { type: 'user', userId: 'user-1' }
const accessSignature = (allowed: Set<string>, identity: AuthIdentity = userIdentity) =>
  activityAccessSignature(identity, squadId, true, (permission) =>
    permission === 'squads:read' ? true : allowed.has(permission)
  )

const permissionHook =
  (allowed: Set<string>, identity: AuthIdentity = userIdentity) =>
  () => ({
    permissions: ['squads:read', ...allowed],
    identity,
    can: (permission: string) => permission === 'squads:read' || allowed.has(permission),
    isLoading: false,
    isError: false,
  })

function staticRender(
  items?: SquadActivityItem[],
  hasMore = false,
  options: { agents?: (typeof agent)[]; activeStreams?: Array<Record<string, unknown>>; permissions?: string[] } = {}
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const permissions = new Set(options.permissions ?? [])
  if (items)
    client.setQueryData(queryKeys.squads.activityInfinite(squadId, filters, accessSignature(permissions)), {
      pages: [{ items, hasMore, nextCursor: hasMore ? 'next' : null }],
      pageParams: [null],
    })
  if (options.activeStreams) client.setQueryData(queryKeys.squads.activeWorkStreams(squadId), options.activeStreams)
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PermissionsProvider usePermissions={permissionHook(permissions)}>
          <WebSocketContext.Provider value={{ isConnected: true, subscribe: () => () => undefined }}>
            <SquadActivityTab squadId={squadId} squadSlug="tau" agents={options.agents ?? [agent]} />
          </WebSocketContext.Provider>
        </PermissionsProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('activity inbox subscription access', () => {
  const resolve = (identity: Parameters<typeof resolveActivityInboxAccess>[0], permissions: string[]) =>
    resolveActivityInboxAccess(identity, squadId, (permission) => permissions.includes(permission))

  test('mirrors user and agent own/all/none API semantics', () => {
    expect(resolve(undefined, ['inbox:read', 'inbox:read-squad'])).toEqual({ mode: 'none' })
    expect(resolve({ type: 'user', userId: 'user-1' }, ['inbox:read'])).toEqual({ mode: 'all' })
    expect(resolve({ type: 'user', userId: 'user-1' }, ['inbox:read-squad'])).toEqual({ mode: 'none' })
    expect(resolve({ type: 'agent', agentId, squadId }, [])).toEqual({ mode: 'own', recipientId: agentId })
    expect(resolve({ type: 'agent', agentId, squadId }, ['inbox:read-squad'])).toEqual({ mode: 'all' })
    expect(resolve({ type: 'agent', agentId, squadId: crypto.randomUUID() }, [])).toEqual({ mode: 'none' })
    expect(resolve({ type: 'agent', agentId, squadId: null }, [])).toEqual({ mode: 'none' })
    expect(resolve({ type: 'agent', agentId, squadId: null }, ['inbox:read-squad'])).toEqual({ mode: 'none' })
    expect(resolve({ type: 'agent', agentId, squadId, userId: 'user-1' }, ['inbox:read-squad'])).toEqual({
      mode: 'none',
    })
    expect(accessSignature(new Set(), { type: 'agent', agentId, squadId })).toBe(
      accessSignature(new Set(['inbox:read']), { type: 'agent', agentId, squadId })
    )
    expect(accessSignature(new Set(['inbox:read-squad']), { type: 'agent', agentId, squadId })).not.toBe(
      accessSignature(new Set(), { type: 'agent', agentId, squadId })
    )
  })
})

describe('SquadActivityTab rendering', () => {
  test('renders loading, empty, pagination, deep links, and stacked mobile summary placement', () => {
    expect(staticRender()).toContain('Loading activity')
    expect(staticRender([])).toContain('No activity matches these filters')
    const emittedKinds: SquadActivityItem[] = [
      waitItem,
      messageItem,
      {
        ...waitItem,
        id: '30:00000000-0000-4000-8000-000000000030',
        kind: 'workstream',
        preview: [{ text: '[ws-abcd created] Activity feed' }],
        summary: '[ws-abcd created] Activity feed',
      },
      {
        ...waitItem,
        id: '50:00000000-0000-4000-8000-000000000050',
        kind: 'handoff',
        preview: [{ text: '[ws-abcd handoff → reviewer]' }],
        summary: '[ws-abcd handoff → reviewer]',
      },
      {
        ...messageItem,
        id: '61:00000000-0000-4000-8000-000000000061',
        kind: 'execution',
        preview: [{ text: '[execution completed]' }],
        summary: '[execution completed]',
      },
      {
        ...messageItem,
        id: '10:00000000-0000-4000-8000-000000000010',
        ref: { type: 'agent', agentId, view: 'chat', executionId: crypto.randomUUID() },
        preview: [{ text: 'Chat activity' }],
        summary: 'Chat activity',
      },
      {
        ...waitItem,
        id: '31:00000000-0000-4000-8000-000000000031',
        kind: 'pr',
        preview: [{ text: '[PR #42 created]' }],
        summary: '[PR #42 created]',
        ref: { type: 'pr', url: 'https://example.test/pull/42' },
      },
      issueItem,
    ]
    const html = staticRender(emittedKinds, true)
    expect(html).toContain('>All<')
    expect(html).toContain('Ship it')
    expect(html).toContain('/squads/tau/work?ws=00000000-0000-4000-8000-000000000010')
    expect(html).toContain('/squads/tau?agent=00000000-0000-4000-8000-000000000002&amp;view=inbox')
    expect(html).toContain('/squads/tau?agent=00000000-0000-4000-8000-000000000002')
    expect(html).toContain('href="https://example.test/pull/42"')
    // Issue rows leave the app like PR rows, and carry an in-app work-stream chip.
    expect(html).toContain('href="https://example.test/issues/12"')
    expect(html).toContain('Flaky login')
    expect(html).toContain('aria-label="Open work stream #12"')
    expect(html).toContain('#12</button>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('dateTime="2026-08-26T12:00:00.123Z"')
    expect(html).toContain('dir="ltr"')
    expect(html).toContain('whitespace-nowrap')
    // Mobile rows are a flex header (chip+label left, time right) + summary;
    // the grid appears only at md+ (operator feedback 2026-08-27 PWA review).
    expect(html).toContain('data-activity-layout="squad"')
    expect(html).not.toContain('data-activity-column="squad"')
    expect(html).toContain('data-activity-column="agent"')
    expect(html).toContain('lg:grid-cols-[4rem_8rem_1fr]')
    expect(html).toContain('order-last ml-auto')
    expect(html).toContain('text-secondary')
    for (const summary of ['Activity feed', 'handoff', 'execution completed', 'Chat activity', 'PR #42'])
      expect(html).toContain(summary)
    // Infinite scroll (2026-08-27): a sentinel replaces the Load-more button.
    expect(html).not.toContain('Load more')
    expect(html).toContain('lg:col-span-1 lg:col-start-3')
    expect(html).toContain('>GitHub<')
    expect(html).toContain('>Subagents<')
  })
})

describe('SquadActivityTab issue rows', () => {
  test('the work-stream chip navigates in-app instead of following the code-host link', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.squads.activityInfinite(squadId, filters, accessSignature(new Set())), {
      pages: [{ items: [issueItem], hasMore: false, nextCursor: null }],
      pageParams: [null],
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(
      async () =>
        new dom.window.Response(JSON.stringify({ items: [issueItem], hasMore: false, nextCursor: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }) as unknown as Response
    ) as typeof fetch
    function LocationProbe() {
      const location = useLocation()
      return <span data-location={`${location.pathname}${location.search}`} />
    }
    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter>
            <LocationProbe />
            <QueryClientProvider client={client}>
              <PermissionsProvider usePermissions={permissionHook(new Set())}>
                <WebSocketContext.Provider value={{ isConnected: true, subscribe: () => () => undefined }}>
                  <SquadActivityTab squadId={squadId} squadSlug="tau" agents={[agent]} />
                </WebSocketContext.Provider>
              </PermissionsProvider>
            </QueryClientProvider>
          </MemoryRouter>
        )
        await Bun.sleep(20)
      })
      const row = [...dom.window.document.querySelectorAll('a')].find(
        (candidate) => candidate.getAttribute('href') === 'https://example.test/issues/12'
      )
      expect(row).toBeDefined()
      expect(row!.getAttribute('target')).toBe('_blank')
      expect(row!.getAttribute('rel')).toBe('noopener noreferrer')
      const chip = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Open work stream #12"]')!
      expect(chip).toBeDefined()
      await dom.act(async () => chip.click())
      expect(dom.window.document.querySelector('[data-location]')!.getAttribute('data-location')).toBe(
        '/squads/tau/work?ws=12'
      )
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

describe('SquadActivityTab linkless issue rows', () => {
  test('an issue row with no recorded link renders as text, not as an anchor to nowhere', async () => {
    // A tracked Linear issue whose delivery carried no URL and whose link the squad never recorded.
    const linkless: SquadActivityItem = {
      ...issueItem,
      id: '71:00000000-0000-4000-8000-000000000072',
      preview: [{ text: '[Issue ENG-12 comment] Ship the tracked issue · by Ada' }],
      summary: '[Issue ENG-12 comment] Ship the tracked issue · by Ada',
      ref: { ...issueItem.ref, url: '' } as SquadActivityItem['ref'],
    }
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.squads.activityInfinite(squadId, filters, accessSignature(new Set())), {
      pages: [{ items: [linkless], hasMore: false, nextCursor: null }],
      pageParams: [null],
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(
      async () =>
        new dom.window.Response(JSON.stringify({ items: [linkless], hasMore: false, nextCursor: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }) as unknown as Response
    ) as typeof fetch
    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={client}>
              <PermissionsProvider usePermissions={permissionHook(new Set())}>
                <WebSocketContext.Provider value={{ isConnected: true, subscribe: () => () => undefined }}>
                  <SquadActivityTab squadId={squadId} squadSlug="tau" agents={[agent]} />
                </WebSocketContext.Provider>
              </PermissionsProvider>
            </QueryClientProvider>
          </MemoryRouter>
        )
        await Bun.sleep(20)
      })
      const { document } = dom.window
      expect(document.body.textContent).toContain('[Issue ENG-12 comment] Ship the tracked issue · by Ada')
      // No anchor at all for the row: an empty href would just reload the page.
      expect([...document.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))).not.toContain('')
      expect(document.querySelector('[aria-label="Open work stream #12"]')).toBeDefined()
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

describe('activity timestamps', () => {
  const now = new Date('2026-08-27T15:00:00.000Z')
  test('today shows time only; other days add month+day, never a year', () => {
    expect(formatActivityTimestamp('2026-08-27T13:29:00.000Z', 'en-US', 'UTC', now)).toBe('13:29')
    expect(formatActivityTimestamp('2026-08-26T23:59:59.000Z', 'en-US', 'UTC', now)).toBe('Aug 26 23:59')
    // Across a year boundary the year still stays implicit (30-day retention
    // means it is never ambiguous).
    expect(formatActivityTimestamp('2025-12-31T08:05:00.000Z', 'en-US', 'UTC', now)).toBe('Dec 31 08:05')
  })
  test('today-ness is judged in the display timezone, not UTC', () => {
    // 23:30Z on the 26th is already Aug 27 in Kolkata — same day as `now`.
    expect(formatActivityTimestamp('2026-08-26T23:30:00.000Z', 'en-US', 'Asia/Kolkata', now)).toBe('05:00')
    // …while in UTC it renders as yesterday.
    expect(formatActivityTimestamp('2026-08-26T23:30:00.000Z', 'en-US', 'UTC', now)).toBe('Aug 26 23:30')
    const arabic = formatActivityTimestamp('2026-08-20T00:00:01.000Z', 'ar-EG', 'Asia/Kolkata', now)
    expect([...arabic].length).toBeLessThanOrEqual(16)
  })
})

describe('activity small-text contrast', () => {
  const luminance = (hex: string) => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)!
      .map((value) => Number.parseInt(value, 16) / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const contrast = (foreground: string, background: string) => {
    const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
    return (values[0] + 0.05) / (values[1] + 0.05)
  }

  test('meets WCAG AA against actual normal and hover theme surfaces', () => {
    expect(ACTIVITY_SMALL_TEXT_CLASS).toBe('text-secondary')
    for (const background of ['#ffffff', '#f3f4f6']) expect(contrast('#4b5563', background)).toBeGreaterThanOrEqual(4.5)
    for (const background of ['#0d0e18', '#151620']) expect(contrast('#94a3b8', background)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('SquadActivityTab filters', () => {
  test('drives kind filters into the canonical query (verbose retired, always quiet)', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new dom.window.Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response
    }) as typeof fetch
    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <PermissionsProvider usePermissions={permissionHook(new Set(['agents:read']))}>
                <WebSocketContext.Provider value={{ isConnected: true, subscribe: () => () => undefined }}>
                  <SquadActivityTab squadId={squadId} squadSlug="tau" agents={[agent]} />
                </WebSocketContext.Provider>
              </PermissionsProvider>
            </QueryClientProvider>
          </MemoryRouter>
        )
        await Bun.sleep(20)
      })
      const button = (label: string) =>
        [...dom.window.document.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
      // The agent pill filter was removed 2026-08-27: no per-agent button
      // renders, and no agentId param ever reaches the wire.
      expect(
        [...dom.window.document.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Ada')
      ).toBeUndefined()
      // The Verbose toggle was retired 2026-08-27: no button renders and the
      // wire always requests the quiet feed.
      expect(
        [...dom.window.document.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Verbose')
      ).toBeUndefined()
      await dom.act(async () => {
        button('Messages').click()
        await Bun.sleep(30)
      })
      expect(urls.at(-1)).not.toContain('verbose=true')
      expect(urls.at(-1)).toContain('kind=message')
      expect(urls.at(-1)).not.toContain('agentId=')
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

describe('SquadActivityTab errors', () => {
  test('prioritizes the query error state over loading and empty states', () => {
    expect(squadActivityStatusMessage(true, true, 0)).toBe('Unable to load activity.')
    expect(squadActivityStatusMessage(false, false, 0)).toBe('No activity matches these filters.')
  })
})

describe('SquadActivityTab direct live activity', () => {
  test('applies direct upserts and tombstones without a REST head fetch', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const callbacks = new Map<string, (entry: any) => void>()
    const client = new QueryClient()
    client.setQueryData(
      queryKeys.squads.activityInfinite(squadId, filters, accessSignature(new Set(['agents:read']))),
      {
        pages: [{ items: [waitItem], hasMore: false, nextCursor: null }],
        pageParams: [null],
      }
    )
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = mock(async () => {
      requests++
      return new dom.window.Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response
    }) as typeof fetch
    const ws: WebSocketContextValue = {
      isConnected: true,
      subscribe: ((topic: string, callback: (entry: any) => void) => {
        callbacks.set(topic, callback)
        return () => undefined
      }) as WebSocketContextValue['subscribe'],
    }
    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={client}>
              <PermissionsProvider usePermissions={permissionHook(new Set(['agents:read']))}>
                <WebSocketContext.Provider value={ws}>
                  <SquadActivityTab squadId={squadId} squadSlug="tau" agents={[agent]} />
                </WebSocketContext.Provider>
              </PermissionsProvider>
            </QueryClientProvider>
          </MemoryRouter>
        )
        await Bun.sleep(20)
      })
      expect(callbacks.has(`squadActivity:${squadId}`)).toBe(true)
      const execution = {
        ...messageItem,
        id: `61:${crypto.randomUUID()}`,
        kind: 'execution' as const,
        preview: [{ text: 'Direct terminal' }],
        summary: 'Direct terminal',
      }
      await dom.act(async () => {
        callbacks.get(`squadActivity:${squadId}`)?.({
          event: 'squadActivity.projected',
          data: {
            squadId,
            operation: 'upsert',
            item: execution,
            quietEligible: true,
            accessScope: 'agents',
            inboxRecipientId: null,
            agentTypeRequiresAgentsRead: false,
          },
        })
      })
      expect(dom.window.document.body.textContent).toContain('Direct terminal')
      // Label contract (2026-08-27 v2): Title-Cased agent type ONLY — the
      // purpose/name parenthetical always truncated and moved to the tooltip.
      expect(dom.window.document.body.textContent).toContain('Engineer')
      expect(dom.window.document.body.textContent).not.toContain('Engineer (Ada)')
      await dom.act(async () => {
        callbacks.get(`squadActivity:${squadId}`)?.({
          event: 'squadActivity.projected',
          data: {
            squadId,
            operation: 'delete',
            item: waitItem,
            quietEligible: true,
            accessScope: 'workstreams',
            inboxRecipientId: null,
            agentTypeRequiresAgentsRead: false,
          },
        })
      })
      expect(dom.window.document.body.textContent).not.toContain('Ship it')
      expect(requests).toBe(0)
      await dom.act(async () => {
        for (let index = 0; index < 201; index++)
          callbacks.get(`squadActivity:${squadId}`)?.({
            event: 'squadActivity.projected',
            data: {
              squadId,
              operation: 'upsert',
              item: { ...execution, id: `61:${crypto.randomUUID()}`, summary: `Overflow ${index}` },
              quietEligible: true,
              accessScope: 'agents',
              inboxRecipientId: null,
              agentTypeRequiresAgentsRead: false,
            },
          })
        await Bun.sleep(100)
      })
      expect(dom.window.document.body.textContent).not.toContain('Ship it')
      expect(requests).toBeGreaterThan(0)
      expect(requests).toBeLessThanOrEqual(2)
      const activityButton = (label: string) =>
        [...dom.window.document.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
      expect(activityButton('All').getAttribute('aria-pressed')).toBe('true')
      await dom.act(async () => {
        activityButton('Messages').click()
        await Bun.sleep(10)
      })
      expect(activityButton('All').getAttribute('aria-pressed')).toBe('false')
      expect(activityButton('Messages').getAttribute('aria-pressed')).toBe('true')
      await dom.act(async () => {
        callbacks.get(`squadActivity:${squadId}`)?.({
          event: 'squadActivity.accessRevoked',
          data: { squadId },
        })
        await Bun.sleep(10)
      })
      expect(dom.window.document.body.textContent).not.toContain('Direct terminal')
      expect(activityButton('Messages').getAttribute('aria-pressed')).toBe('false')
      expect(requests).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })

  test('reconciles the bounded head once after reconnect', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      return new dom.window.Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response
    }) as typeof fetch
    let setConnected!: (connected: boolean) => void
    function Harness() {
      const [connected, update] = useState(false)
      setConnected = update
      return (
        <WebSocketContext.Provider value={{ isConnected: connected, subscribe: () => () => undefined }}>
          <SquadActivityTab squadId={squadId} squadSlug="tau" agents={[agent]} />
        </WebSocketContext.Provider>
      )
    }
    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <PermissionsProvider usePermissions={permissionHook(new Set())}>
                <Harness />
              </PermissionsProvider>
            </QueryClientProvider>
          </MemoryRouter>
        )
        await Bun.sleep(20)
      })
      const baseline = calls
      await dom.act(async () => {
        setConnected(true)
        await Bun.sleep(70)
      })
      expect(calls).toBe(baseline + 1)
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

describe('SquadActivityTab in-place modals', () => {
  test('plain row clicks open modals in place; modified clicks keep navigation', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const client = new QueryClient()
    client.setQueryData(
      queryKeys.squads.activityInfinite(squadId, filters, accessSignature(new Set(['agents:read']))),
      {
        pages: [{ items: [waitItem, messageItem, historicalMessageItem], hasMore: false, nextCursor: null }],
        pageParams: [null],
      }
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      return new dom.window.Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response
    }) as typeof fetch
    const ws: WebSocketContextValue = {
      isConnected: true,
      subscribe: (() => () => undefined) as WebSocketContextValue['subscribe'],
    }
    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={client}>
              <PermissionsProvider usePermissions={permissionHook(new Set(['agents:read']))}>
                <WebSocketContext.Provider value={ws}>
                  <SquadActivityTab
                    squadId={squadId}
                    squadSlug="tau"
                    agents={[agent]}
                    dependencies={{
                      AgentConversationComponent: (() => <p>conversation-stub</p>) as never,
                      WorkStreamViewModalComponent: (() => <p>workstream-stub</p>) as never,
                      AgentViewModalComponent: ((props: {
                        agent: Agent
                        squadId: string
                        initialTab?: string
                        focusMessageId?: string
                        focusInboxMessageId?: string
                      }) => (
                        <p>
                          agent-view-modal:{props.agent.id}:{props.squadId}:{props.initialTab ?? 'none'}:
                          {props.focusMessageId ?? 'none'}:{props.focusInboxMessageId ?? 'none'}
                        </p>
                      )) as never,
                    }}
                  />
                </WebSocketContext.Provider>
              </PermissionsProvider>
            </QueryClientProvider>
          </MemoryRouter>
        )
        await Bun.sleep(20)
      })
      const agentRow = [...dom.window.document.querySelectorAll('a')].find((a) =>
        a.getAttribute('aria-label')?.includes('Implementation ready')
      )!
      expect(agentRow).toBeDefined()
      // Plain click on a roster agent's row opens AgentViewModal in place, with the
      // agent/squad/initialTab/focusMessageId it should receive (inbox view here, so
      // no focusMessageId — that's chat-only per SquadActivityTab's mapping).
      await dom.act(async () => {
        agentRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
        await Bun.sleep(10)
      })
      // Inbox rows open the CHAT tab focused on the delivering transcript
      // message (via the inbox message id), not the Inbox tab (2026-08-27).
      expect(dom.window.document.body.textContent).toContain(
        `agent-view-modal:${agentId}:${squadId}:chat:none:${messageItem.ref.type === 'agent' ? messageItem.ref.messageId : ''}`
      )
      expect(dom.window.document.body.textContent).not.toContain('conversation-stub')

      // A historical/terminated agent absent from the roster still falls back to the
      // plain viewport AgentConversation modal.
      const historicalRow = [...dom.window.document.querySelectorAll('a')].find((a) =>
        a.getAttribute('aria-label')?.includes('Historical agent activity')
      )!
      expect(historicalRow).toBeDefined()
      await dom.act(async () => {
        historicalRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
        await Bun.sleep(10)
      })
      expect(dom.window.document.body.textContent).toContain('conversation-stub')
      expect(dom.window.document.body.textContent).not.toContain('agent-view-modal:')

      // Plain click on a workstream row swaps to the work-stream modal.
      const wsRow = [...dom.window.document.querySelectorAll('a')].find((a) =>
        a.getAttribute('aria-label')?.includes('Ship it')
      )!
      await dom.act(async () => {
        wsRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
        await Bun.sleep(10)
      })
      expect(dom.window.document.body.textContent).toContain('workstream-stub')
      // A modified click keeps navigation semantics: no NEW modal state — the
      // interceptor must leave the event alone (metaKey honored).
      const cmdClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })
      expect(cmdClick.metaKey).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

describe('background presence (operator decisions 2026-08-27)', () => {
  test('strip shows working/waiting/stream counts; top-most row of a working agent gets one live dot', () => {
    const workingAgent = { ...agent, status: 'active' }
    const rows: SquadActivityItem[] = [
      { ...messageItem, id: '10:00000000-0000-4000-8000-0000000000a1', summary: 'Newest row' },
      { ...messageItem, id: '10:00000000-0000-4000-8000-0000000000a2', summary: 'Older row' },
    ]
    const html = staticRender(rows, false, {
      agents: [workingAgent],
      permissions: ['workstreams:read'],
      activeStreams: [
        { id: 'ws-a', status: 'active', derivedState: 'in_progress' },
        { id: 'ws-b', status: 'active', derivedState: 'waiting_on_answer' },
        { id: 'ws-c', status: 'queued', derivedState: 'blocked' },
      ],
    })
    expect(html).toContain('1 working')
    expect(html).toContain('2 waiting on you')
    expect(html).toContain('3 active streams')
    expect(html).toContain('animate-pulse bg-status-progress-500')
    // Exactly ONE live dot: the agent's top-most row only.
    expect(html.split('Working now').length - 1).toBe(1)
    expect(html).toContain('bg-current')
    expect(html.indexOf('Working now')).toBeLessThan(html.indexOf('Newest row'))

    // Idle roster: gray dot, zero counts, no live dots.
    const quiet = staticRender([], false, { agents: [agent] })
    expect(quiet).toContain('0 working')
    expect(quiet).not.toContain('Working now')
  })
})

for (const reference of ['abc12345-1234-1234-1234-123456789abc', 'abc12345']) {
  test(`inline agent ${reference} retains squad filters and scroll without opening the source`, async () => {
    await import('../EntityReferenceModal')
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    // The target is intentionally outside this squad's roster and belongs to another squad.
    const target = { ...agent, id: 'abc12345-1234-1234-1234-123456789abc', squadId: 'other-squad' }
    const item = { ...messageItem, preview: [{ text: 'Review agent', href: `ficus:agent:${reference}` }] }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const allowed = new Set(['agents:read'])
    for (const selected of [filters, { ...filters, kinds: ['message', 'subagent'] as const }])
      client.setQueryData(
        queryKeys.squads.activityInfinite(
          squadId,
          { ...selected, kinds: [...selected.kinds] },
          accessSignature(allowed)
        ),
        {
          pages: [{ items: [item], hasMore: false, nextCursor: null }],
          pageParams: [null],
        }
      )
    client.setQueryData(queryKeys.agents.detail(reference), target)
    client.setQueryData(queryKeys.agents.detail(target.id), target)
    function LocationProbe() {
      return <p data-location>{useLocation().pathname}</p>
    }
    const opened: string[] = []
    try {
      const view = dom.createRoot()
      await dom.act(() =>
        view.root.render(
          <MemoryRouter initialEntries={['/squads/tau/activity']}>
            <QueryClientProvider client={client}>
              <PermissionsProvider usePermissions={permissionHook(allowed)}>
                <WebSocketContext.Provider value={{ isConnected: true, subscribe: () => () => {} }}>
                  <LocationProbe />
                  <SquadActivityTab
                    squadId={squadId}
                    squadSlug="tau"
                    agents={[agent]}
                    dependencies={{
                      AgentViewModalComponent: (({
                        agent,
                        squadId,
                        onClose,
                      }: {
                        agent: { id: string }
                        squadId: string
                        onClose: () => void
                      }) => {
                        opened.push(`${agent.id}:${squadId}`)
                        return <button onClick={onClose}>Close referenced agent</button>
                      }) as never,
                    }}
                  />
                </WebSocketContext.Provider>
              </PermissionsProvider>
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      const messages = [...view.container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Messages'
      )!
      await dom.act(() => messages.click())
      const scroller = view.container.querySelector<HTMLElement>('.overflow-y-auto')!
      scroller.scrollTop = 400
      await dom.act(async () => {
        ;[...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Review agent')!.click()
      })
      await dom.act(async () => {
        await waitFor(() => expect(view.container.textContent).toContain('Close referenced agent'))
      })
      expect(view.container.querySelector('[data-location]')?.textContent).toBe('/squads/tau/activity')
      expect(opened).toContain(`${target.id}:${target.squadId}`)
      expect(opened.every((value) => value.startsWith(target.id))).toBe(true)
      expect(messages.getAttribute('aria-pressed')).toBe('true')
      expect(view.container.querySelector('.overflow-y-auto')).toBe(scroller)
      expect(scroller.scrollTop).toBe(400)
      await dom.act(() =>
        [...view.container.querySelectorAll('button')]
          .find((button) => button.textContent === 'Close referenced agent')!
          .click()
      )
      expect(view.container.querySelector('[data-location]')?.textContent).toBe('/squads/tau/activity')
      expect(messages.getAttribute('aria-pressed')).toBe('true')
      expect(scroller.scrollTop).toBe(400)
    } finally {
      client.clear()
      await dom.cleanup()
    }
  })
}
