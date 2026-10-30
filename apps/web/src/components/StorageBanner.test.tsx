import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { PermissionsProvider } from '../hooks/usePermissions'
import { queryKeys } from '../queryKeys'
import { StorageBanner, storageWarningText } from './StorageBanner'
import { StorageMonitorSettings } from './settings/StorageMonitorSettings'

const config = { intervalHours: 12, alertsEnabled: true, thresholds: [80, 90, 95], nextScanAt: null }
for (const allowed of [true, false]) {
  test(`storage warnings ${allowed ? 'show stale capacity and a settings link' : 'hide cached machine details without permission'}`, () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.system.storageStatus(), {
      supported: true,
      scanning: false,
      scannedAt: '2026-09-22T00:00:00Z',
      error: null,
      monitoring: config,
      warnings: [
        {
          machineId: 'a',
          machineName: 'Worker machine',
          percent: 96,
          threshold: 95,
          measuredAt: '2026-09-22T00:00:00Z',
          stale: true,
        },
      ],
    })
    try {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <PermissionsProvider
              usePermissions={() => ({ can: () => allowed, permissions: [], isLoading: false, isError: false })}
            >
              <StorageBanner />
            </PermissionsProvider>
          </QueryClientProvider>
        </MemoryRouter>
      )
      if (allowed) {
        expect(html).toContain('Worker machine is 96.0% full, above the 95% warning level.')
        expect(html).toContain('Dismiss')
        expect(html).toContain('current usage is unknown')
        expect(html).toContain('/settings?section=storage')
      } else expect(html).toBe('')
    } finally {
      client.clear()
    }
  })
}
test('storage monitoring form exposes saved interval, thresholds and inbox preference', () => {
  const client = new QueryClient()
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <StorageMonitorSettings config={config} />
      </QueryClientProvider>
    )
    expect(html).toContain('value="12"')
    expect(html).toContain('value="80,90,95"')
    expect(html).toContain('Send threshold alerts to the system inbox')
  } finally {
    client.clear()
  }
})

const warning = (threshold: number, percent: number) => ({
  machineId: 'a',
  machineName: 'host',
  percent,
  threshold,
  measuredAt: '2026-10-30T02:00:00Z',
  stale: false,
})

test('the warning names its level and, inside the hysteresis band, when it clears', () => {
  expect(storageWarningText(warning(80, 84.25))).toBe('host is 84.3% full, above the 80% warning level.')
  expect(storageWarningText(warning(80, 77.03))).toBe('host is 77.0% full. The 80% warning clears below 77%.')
})

function renderBanner(warnings: ReturnType<typeof warning>[], storage: Pick<Storage, 'getItem' | 'setItem'>) {
  const client = new QueryClient()
  client.setQueryData(queryKeys.system.storageStatus(), {
    supported: true,
    scanning: false,
    scannedAt: '2026-10-30T02:00:00Z',
    error: null,
    monitoring: config,
    warnings,
  })
  try {
    return renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <PermissionsProvider
            usePermissions={() => ({ can: () => true, permissions: [], isLoading: false, isError: false })}
          >
            <StorageBanner storage={storage} />
          </PermissionsProvider>
        </QueryClientProvider>
      </MemoryRouter>
    )
  } finally {
    client.clear()
  }
}

test('Dismiss is a padded ghost button while Review storage remains a navigation link', () => {
  const html = renderBanner([warning(80, 77.03)], { getItem: () => null, setItem: () => {} })
  const button = html.match(/<button\b[^>]*>Dismiss<\/button>/)?.[0] ?? ''
  expect(button).toContain('type="button"')
  expect(button).toContain('ficus-button ficus-button-ghost')
  expect(button).toContain('px-3 py-1')
  expect(button).not.toContain('ficus-button-link')
  expect(button).not.toContain('underline')
  expect(html).toMatch(/<a\b[^>]*href="\/settings\?section=storage"[^>]*>Review storage<\/a>/)
})

test('a dismissal hides the banner for a week unless a higher warning level is reached', () => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
  const key = 'ficus.storageBanner.dismissed'
  store.set(key, JSON.stringify({ until: Date.now() + 60_000, threshold: 80 }))
  expect(renderBanner([warning(80, 77.03)], storage)).toBe('')
  expect(renderBanner([warning(90, 91)], storage)).toContain('above the 90% warning level')
  store.set(key, JSON.stringify({ until: Date.now() - 1, threshold: 95 }))
  expect(renderBanner([warning(80, 81)], storage)).toContain('above the 80% warning level')
  store.set(key, 'not json')
  expect(renderBanner([warning(80, 81)], storage)).toContain('Storage warning')
  const blocked = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
  }
  expect(renderBanner([warning(80, 81)], blocked)).toContain('Storage warning')
})
