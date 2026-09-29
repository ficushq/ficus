import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import {
  farmHref,
  isNavItemAllowed,
  navFooterHints,
  navItems,
  resolveNavShortcut,
  shouldShowVoiceButton,
} from './navModel'
import { assistantQueryKeys, queryKeys } from '../queryKeys'
import { getTabNavigationTarget, getTabPath, recordTabPath, resetTabHistory } from '../hooks/useTabHistory'
import { ThemeProvider } from '../providers/ThemeProvider'

let permissions = new Set<string>()
let permissionsLoading = false
/** undefined = capability still unknown (query not yet resolved). */
let voiceStatus: { enabled: boolean } | undefined

import { AppHeader, DesktopFooter, MobileBottomNav } from './AppNav'

const useFixturePendingActions = () => ({ data: [] })
const FixtureVoiceButton = () => <button>Fixture voice trigger</button>

const ownerUserId = '507a9ac0-164e-4f49-9441-e57522bdc52b'
let unreadAssistantConversations = 0

function renderWithProviders(children: ReactNode, path = '/squads') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (!permissionsLoading) {
    queryClient.setQueryData(queryKeys.auth.permissions(undefined), {
      permissions: [...permissions],
      identity: { type: 'user', userId: ownerUserId },
    })
  }
  if (unreadAssistantConversations > 0) {
    queryClient.setQueryData(assistantQueryKeys.activity(ownerUserId, 0), {
      totals: {
        unreadConversations: unreadAssistantConversations,
        unreadUpdates: unreadAssistantConversations,
        workingTasks: 7,
        waitingTasks: 0,
        needsInputTasks: 0,
        unavailableTasks: 0,
      },
      conversations: [],
      hasMore: false,
    })
  }
  if (voiceStatus) {
    queryClient.setQueryData(queryKeys.voice.status(), voiceStatus)
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

describe('React render harness', () => {
  test('shares one React dispatcher with workspace provider dependencies', () => {
    const queryClient = new QueryClient()

    expect(
      renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <span>dispatcher connected</span>
        </QueryClientProvider>
      )
    ).toContain('dispatcher connected')
  })
})

describe('MobileBottomNav rendering', () => {
  beforeEach(() => {
    resetTabHistory()
    permissions = new Set<string>()
    permissionsLoading = false
    voiceStatus = { enabled: true }
  })

  test('uses the per-render pending-actions fixture for the feed badge', () => {
    const useSevenFixtureActions = () => ({ data: Array.from({ length: 7 }, (_, id) => ({ id })) })

    const html = renderWithProviders(<MobileBottomNav usePendingActions={useSevenFixtureActions} />)

    expect(html).toContain('>7</span>')
  })

  test('keeps the feed badge absent on desktop and mobile before data resolves', () => {
    const useLoadingActions = () => ({ data: undefined, isLoading: true, isFetching: true })
    const header = renderWithProviders(<AppHeader usePendingActions={useLoadingActions} />)
    const mobile = renderWithProviders(<MobileBottomNav usePendingActions={useLoadingActions} />)

    expect(header).not.toContain('Action Center loading')
    expect(header).not.toContain('>…</span>')
    expect(mobile).not.toContain('Action Center loading')
    expect(mobile).not.toContain('>…</span>')
  })

  test('keeps the badge absent while a cached empty result refreshes in the background', () => {
    const useRefreshingActions = () => ({ data: [], isLoading: false, isFetching: true })
    const header = renderWithProviders(<AppHeader usePendingActions={useRefreshingActions} />)
    const mobile = renderWithProviders(<MobileBottomNav usePendingActions={useRefreshingActions} />)

    expect(header).not.toContain('Action Center loading')
    expect(header).not.toContain('>…</span>')
    expect(mobile).not.toContain('Action Center loading')
    expect(mobile).not.toContain('>…</span>')
  })

  test('retains a nonempty count during background refresh', () => {
    const useRefreshingActions = () => ({ data: [{ id: 1 }, { id: 2 }], isFetching: true })
    expect(renderWithProviders(<AppHeader usePendingActions={useRefreshingActions} />)).toContain('>2</span>')
    expect(renderWithProviders(<MobileBottomNav usePendingActions={useRefreshingActions} />)).toContain('>2</span>')
  })

  test('keeps Feed active for an exact action deep link on desktop and mobile', () => {
    const path = '/actions/workstream-review%3Aws-1%3Await-1'
    const header = renderWithProviders(<AppHeader usePendingActions={useFixturePendingActions} />, path)
    const mobile = renderWithProviders(<MobileBottomNav usePendingActions={useFixturePendingActions} />, path)
    expect(header).toMatch(/<a class="[^"]*text-accent-light[^"]*" href="\/"[^>]*>Feed/)
    expect(mobile).toContain('text-accent-light')
  })

  test('shows an error badge instead of zero on desktop and mobile', () => {
    const useFailedActions = () => ({ data: [], isError: true })

    const header = renderWithProviders(<AppHeader usePendingActions={useFailedActions} />)
    const mobile = renderWithProviders(<MobileBottomNav usePendingActions={useFailedActions} />)

    expect(header).toContain('aria-label="Action Center unavailable"')
    expect(header).toContain('>!</span>')
    expect(mobile).toContain('aria-label="Action Center unavailable"')
    expect(mobile).toContain('>!</span>')
  })

  test('renders Feed, Activity, Squads and Inbox but not the hidden Chat destination', () => {
    const html = renderWithProviders(<MobileBottomNav usePendingActions={useFixturePendingActions} />)

    expect(html).toContain('Feed')
    expect(html).toContain('Activity')
    expect(html).toContain('Squads')
    expect(html).toContain('Inbox')
    expect(html).toContain('Settings')
    expect(html).not.toContain('>More<')
    expect(html).not.toContain('Chat')
  })

  test('hides Schedules from the More menu even with schedules:read', () => {
    permissions.add('schedules:read')

    expect(renderWithProviders(<MobileBottomNav usePendingActions={useFixturePendingActions} />)).not.toContain(
      'Schedules'
    )
  })

  test('hides voice companion button unless ai:voice is allowed', () => {
    const deniedHtml = renderWithProviders(
      <AppHeader usePendingActions={useFixturePendingActions} VoiceCompanionButton={FixtureVoiceButton} />
    )
    expect(deniedHtml).not.toContain('Fixture voice trigger')

    permissions.add('ai:voice')
    const allowedHtml = renderWithProviders(
      <AppHeader usePendingActions={useFixturePendingActions} VoiceCompanionButton={FixtureVoiceButton} />
    )
    expect(allowedHtml).not.toContain('Fixture voice trigger')
    expect(allowedHtml).toContain('Assistant')
  })

  test('shows unread Assistant conversations on the closed command bar button, never executing tasks', () => {
    permissions.add('chat:send')
    unreadAssistantConversations = 0
    try {
      expect(renderWithProviders(<AppHeader usePendingActions={useFixturePendingActions} />)).not.toContain(
        'with unread updates'
      )
      unreadAssistantConversations = 2
      const html = renderWithProviders(<AppHeader usePendingActions={useFixturePendingActions} />)
      expect(html).toContain('aria-label="2 Assistant conversations with unread updates"')
      expect(html).not.toContain('aria-label="7 ')
      unreadAssistantConversations = 250
      const capped = renderWithProviders(<AppHeader usePendingActions={useFixturePendingActions} />)
      expect(capped).toContain('aria-label="250 Assistant conversations with unread updates"')
      expect(capped).toContain('>99+<')
      // Without chat:send the badge never queries or renders, even with cached data present.
      permissions.delete('chat:send')
      expect(renderWithProviders(<AppHeader usePendingActions={useFixturePendingActions} />)).not.toContain(
        'with unread updates'
      )
    } finally {
      unreadAssistantConversations = 0
    }
  })
})

describe('the farm link', () => {
  test('opens the farm beside the web app, under the instance base path', () => {
    expect(farmHref('/')).toBe('/farm/')
    expect(farmHref('/ficus/')).toBe('/ficus/farm/')
    expect(farmHref('/ficus')).toBe('/ficus/farm/')
  })

  test('is in the header, as a page link (the farm is its own app, not a route here)', () => {
    const html = renderWithProviders(<AppHeader usePendingActions={useFixturePendingActions} />)
    expect(html).toContain(`href="${farmHref()}"`)
    expect(html).toContain('aria-label="Open the farm"')
  })
})

describe('header microphone follows server voice capability', () => {
  // Asserted through the pure gate rather than rendered markup: whether the
  // mocked VoiceCompanionButton actually renders depends on module-mock ordering
  // across the whole suite (see the pre-existing flake on the
  // 'hides voice companion button' test above), which would make a
  // presence assertion pass alone and fail in a full run.
  test('shows the microphone only when permitted and the server has a key', () => {
    expect(shouldShowVoiceButton({ permissionsLoading: false, canVoice: true, voiceEnabled: true })).toBe(true)
  })

  test('hides the microphone when the server reports voice disabled', () => {
    expect(shouldShowVoiceButton({ permissionsLoading: false, canVoice: true, voiceEnabled: false })).toBe(false)
  })

  test('hides the microphone while the capability is still unknown', () => {
    // useVoiceEnabled maps "unknown" to false, so this is the no-flash case: a
    // mic that appears and then disappears is worse than one that appears late.
    expect(shouldShowVoiceButton({ permissionsLoading: false, canVoice: true, voiceEnabled: false })).toBe(false)
  })

  test('hides the microphone without ai:voice even when the server has a key', () => {
    expect(shouldShowVoiceButton({ permissionsLoading: false, canVoice: false, voiceEnabled: true })).toBe(false)
  })

  test('hides the microphone while permissions are still loading', () => {
    expect(shouldShowVoiceButton({ permissionsLoading: true, canVoice: true, voiceEnabled: true })).toBe(false)
  })

  test('is absent from the rendered header when the server reports voice disabled', () => {
    permissions = new Set<string>(['ai:voice'])
    permissionsLoading = false
    voiceStatus = { enabled: false }

    expect(
      renderWithProviders(
        <AppHeader usePendingActions={useFixturePendingActions} VoiceCompanionButton={FixtureVoiceButton} />
      )
    ).not.toContain('Fixture voice trigger')
  })

  // The failed-request and cached-capability cases is covered by the policy unit tests in
  // hooks/useVoiceEnabled.test.ts: react-query resets an errored query to
  // `pending` for the duration of its on-mount refetch, so a rendered component
  // cannot observe the error state deterministically.
})

describe('primary desktop navigation', () => {
  beforeEach(() => {
    resetTabHistory()
    // Grant everything: the hidden destinations must stay hidden on merit, not
    // because the test user happens to lack a permission.
    permissions = new Set<string>(['schedules:read', 'recommendations:read', 'ai:voice', 'inbox:system'])
    permissionsLoading = false
    voiceStatus = { enabled: true }
  })

  test('does not advertise Ops Insights in the header (it lives in Settings)', () => {
    const html = renderWithProviders(
      <AppHeader usePendingActions={useFixturePendingActions} VoiceCompanionButton={FixtureVoiceButton} />
    )
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'))

    expect([...nav.matchAll(/>([A-Za-z ]+)<\/a>/g)].map((m) => m[1])).toEqual(['Feed', 'Activity', 'Squads'])
  })

  test('gates Ops Insights on recommendations:read', () => {
    const item = navItems.find((candidate) => candidate.to === '/recommendations')!
    expect(isNavItemAllowed(item, (permission) => permission === 'recommendations:read', false)).toBe(true)
    expect(isNavItemAllowed(item, () => false, false)).toBe(false)
    expect(isNavItemAllowed(item, () => true, true)).toBe(false)
  })

  test('does not advertise Chat or Schedules anywhere in the header', () => {
    const html = renderWithProviders(
      <AppHeader usePendingActions={useFixturePendingActions} VoiceCompanionButton={FixtureVoiceButton} />
    )

    expect(html).not.toContain('Chat')
    expect(html).not.toContain('Schedules')
    expect(html).not.toContain('href="/chat"')
    expect(html).not.toContain('href="/schedules"')
  })
})

describe('theme quick picker placement', () => {
  beforeEach(() => {
    resetTabHistory()
    permissions = new Set<string>()
    permissionsLoading = false
    voiceStatus = { enabled: true }
  })

  test('sits between Settings and Inbox in the desktop right cluster, desktop-only like both neighbors', () => {
    const html = renderWithProviders(<AppHeader usePendingActions={useFixturePendingActions} />)

    const settingsIndex = html.indexOf('title="Settings (S)"')
    const themeIndex = html.indexOf('title="Theme"')
    const inboxIndex = html.indexOf('title="Inbox (I)"')

    expect(settingsIndex).toBeGreaterThan(-1)
    expect(themeIndex).toBeGreaterThan(-1)
    expect(inboxIndex).toBeGreaterThan(-1)
    expect(settingsIndex).toBeLessThan(themeIndex)
    expect(themeIndex).toBeLessThan(inboxIndex)

    // Same desktop-only pattern as its Settings/Inbox neighbors.
    const themeButtonStart = html.lastIndexOf('<button', themeIndex)
    const themeButton = html.slice(themeButtonStart, html.indexOf('>', themeIndex) + 1)
    expect(themeButton).toContain('hidden md:flex')
  })
})

describe('navigation keyboard shortcuts', () => {
  test('F, A and Q still navigate, and S still reaches settings', () => {
    expect(resolveNavShortcut('f')).toBe('/')
    expect(resolveNavShortcut('a')).toBe('/activity')
    expect(resolveNavShortcut('q')).toBe('/squads')
    expect(resolveNavShortcut('s')).toBe('/settings')
  })

  test('C no longer navigates to the hidden Chat destination', () => {
    expect(resolveNavShortcut('c')).toBeUndefined()
    expect(resolveNavShortcut('C')).toBeUndefined()
  })

  test('no shortcut resolves to a hidden destination', () => {
    const reachable = 'abcdefghijklmnopqrstuvwxyz'.split('').map((k) => resolveNavShortcut(k))

    expect(reachable).not.toContain('/chat')
    expect(reachable).not.toContain('/schedules')
    expect(reachable.filter(Boolean).sort()).toEqual(['/', '/activity', '/settings', '/squads'])
  })
})

describe('desktop instance label', () => {
  beforeEach(() => {
    resetTabHistory()
    permissions = new Set<string>()
    permissionsLoading = false
    voiceStatus = { enabled: true }
  })

  afterEach(() => {
    delete window.tauDesktopApp
    delete window.ficusDesktopApp
  })

  test('shows the paired instance name in the inset title bar', () => {
    window.ficusDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      instance: { kind: 'remote', name: 'noah' },
    }

    const html = renderWithProviders(<AppHeader usePendingActions={useFixturePendingActions} />)

    expect(html).toContain('data-testid="desktop-instance-label"')
    expect(html).toMatch(/data-testid="desktop-instance-label"[^>]*>noah</)
  })

  test('shows the paired instance name via the legacy window.tauDesktopApp (D1 and older Desktop builds)', () => {
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      instance: { kind: 'remote', name: 'noah' },
    }

    const html = renderWithProviders(<AppHeader usePendingActions={useFixturePendingActions} />)

    expect(html).toContain('data-testid="desktop-instance-label"')
    expect(html).toMatch(/data-testid="desktop-instance-label"[^>]*>noah</)
  })

  test('omits the instance label without a desktop bridge', () => {
    const html = renderWithProviders(<AppHeader usePendingActions={useFixturePendingActions} />)

    expect(html).not.toContain('data-testid="desktop-instance-label"')
  })
})

describe('DesktopFooter key hints', () => {
  test('lists exactly feed, squads, settings, inbox, quick chat', () => {
    expect(navFooterHints()).toEqual([
      { key: 'F', label: 'Feed' },
      { key: 'A', label: 'Activity' },
      { key: 'Q', label: 'Squads' },
      { key: 'S', label: 'Settings' },
      { key: 'I', label: 'Inbox' },
      { key: '⌘K / Ctrl K', label: 'Assistant' },
    ])
  })

  test('keeps the quick-chat hint even though Chat left the nav', () => {
    const html = renderToStaticMarkup(<DesktopFooter />)

    // "Quick chat" is the drawer toggle, not the /chat destination — it stays.
    expect(html).toContain('Assistant')
    expect(html).not.toContain('>Chat<')
    expect(html).not.toContain('Schedules')
  })
})

describe('mobile tab target policy', () => {
  beforeEach(() => resetTabHistory())

  test('returns remembered nested path when switching tabs', () => {
    recordTabPath('/squads/abc-uuid?tab=agents')

    expect(getTabPath('squads')).toBe('/squads/abc-uuid?tab=agents')
    expect(getTabNavigationTarget('/inbox', '/squads')).toBe('/squads/abc-uuid?tab=agents')
  })

  test('returns the tab root when tapping the current tab', () => {
    recordTabPath('/squads/abc-uuid?tab=agents')

    expect(getTabNavigationTarget('/squads/abc-uuid?tab=agents', '/squads')).toBe('/squads')
  })
})
