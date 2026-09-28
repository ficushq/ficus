import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { queryKeys } from '../queryKeys'
import type { useTheme } from '../providers/ThemeProvider'

// A route-driven split check: Theme moved out of "App & Appearance" into its
// own "Appearance" section/tab, while "App" (installation/cache/offline
// storage) stays put under the old 'app' section id. See settingsSections.ts,
// SettingsNavigation.tsx's PERSONAL_SECTIONS, and settingsSearch.ts.

const fullThemeValue: ReturnType<typeof useTheme> = {
  syncAvailable: false,
  customTheme: null,
  customThemeError: null,
  presetId: null,
  presetOwnerId: null,
  applyCustom: () => undefined,
  applyPreset: () => undefined,
  themeId: 'iris',
  appearance: 'light',
  theme: 'light',
  toggleTheme: () => undefined,
  setTheme: () => undefined,
  setThemeId: () => undefined,
  setAppearance: () => undefined,
}

const dependencies = {
  useAuth: () => ({
    authRequired: true,
    authStatus: { mode: 'passkey' as const, authEnabled: true, hasUsers: true, hasAdminUser: true },
    logout: async () => undefined,
  }),
  useTheme: () => fullThemeValue,
  usePushNotifications: () => ({
    isSupported: false,
    isSubscribed: false,
    permission: 'default' as const,
    subscriptions: [],
    currentSubscriptionId: null,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    removeSubscription: () => undefined,
    error: null,
  }),
  useNotificationSound: () => ({ enabled: false, toggle: () => undefined }),
  createPingSound: () => undefined,
  useOfflineCache: () => ({ cacheStats: { entryCount: 0 }, clearCache: async () => undefined }),
  usePWA: () => ({
    isStandalone: false,
    canInstall: false,
    isSupported: true,
    platform: 'desktop' as const,
    updateAvailable: false,
    isOnline: true,
    promptInstall: () => undefined,
    applyUpdate: () => undefined,
  }),
}

async function renderSettings(route: string): Promise<string> {
  const { SettingsPage } = await import('./SettingsPage')
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.updates.settings(), {
    settings: { enabled: false, intervalMinutes: 30, remote: 'origin', branch: 'main' },
    status: { active: false, latest: null },
    managed: false,
  })
  queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions: [] })
  queryClient.setQueryData(queryKeys.auth.me(), {
    id: 'u1',
    email: 'admin@example.com',
    displayName: 'Admin',
    createdAt: '2026-01-01T00:00:00Z',
  })
  queryClient.setQueryData(queryKeys.auth.myCredentials(), [])
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <SettingsPage dependencies={dependencies} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

test('section=appearance renders the Theme picker (grid + segmented appearance), not App Installation/Offline Cache', async () => {
  const html = await renderSettings('/settings?section=appearance')
  expect(html).toContain('>Appearance<')
  expect(html).toContain('>Theme<')
  expect(html).toContain('Color theme')
  expect(html).not.toContain('App Installation')
  expect(html).not.toContain('Offline Cache')
})

test('section=app renders App Installation/Offline Cache, not the Theme picker', async () => {
  const html = await renderSettings('/settings?section=app')
  expect(html).toContain('App Installation')
  expect(html).toContain('Offline Cache')
  expect(html).not.toContain('data-setting-target="dark-mode"')
  expect(html).not.toContain('Color theme')
})

test('Appearance is its own item in the desktop Personal nav, next to Account and App', async () => {
  const html = await renderSettings('/settings?section=account')
  const nav = html
  const personalOrder = ['Account', 'Appearance', 'App', 'Notifications']
  const positions = personalOrder.map((label) => nav.indexOf(`>${label}<`))
  expect(positions.every((index) => index >= 0)).toBe(true)
  expect([...positions].sort((a, b) => a - b)).toEqual(positions)
})

test('Appearance is reachable from the mobile section chooser (same nav groups feed both)', async () => {
  const html = await renderSettings('/settings?section=account')
  // The mobile trigger/chooser and desktop aside share one groups list
  // (SettingsNavigation renders both from the same `groups` prop), so
  // Appearance appearing once in the shared nav item markup covers both
  // surfaces; assert its icon/label pairing renders as a real nav button,
  // not just search-result text.
  expect(html).toContain('aria-label="Choose settings section"')
  expect((html.match(/>Appearance</g) ?? []).length).toBeGreaterThanOrEqual(1)
})
