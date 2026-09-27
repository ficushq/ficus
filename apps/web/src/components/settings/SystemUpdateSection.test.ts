import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS } from '../../api/updates'
import type { LocalUpdateRun, UpdateStatusResponse } from '../../api/updates'
import { queryKeys } from '../../queryKeys'
import { SystemUpdateSection } from './SystemUpdateSection'
import { getUpdateLoaderMessage } from './SystemUpdateSection.loader'

const source = readFileSync(join(import.meta.dir, 'SystemUpdateSection.tsx'), 'utf8')

function stubDesktopUpdates() {
  return {
    state: async () => ({ appVersion: '1.0.0', coreCommit: 'abc123', supported: true, phase: 'idle' as const }),
    check: async () => ({ appVersion: '1.0.0', coreCommit: 'abc123', supported: true, phase: 'idle' as const }),
    install: async () => {},
    subscribe: () => () => {},
  }
}

function renderSystemUpdateSection(
  latest: LocalUpdateRun | null = null,
  flavor?: UpdateStatusResponse['flavor']
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  queryClient.setQueryData(queryKeys.updates.settings(), {
    settings: DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS,
    status: { active: false, latest, flavor },
  })
  queryClient.setQueryData(queryKeys.updates.status(), { active: false, latest, flavor })
  queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions: ['updates:write'] })
  const previousLocalStorage = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {},
    } as Storage,
  })

  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, createElement(SystemUpdateSection))
    )
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousLocalStorage })
  }
}

describe('SystemUpdateSection defaults', () => {
  test('keeps automatic system updates disabled until the user explicitly enables them', () => {
    expect(DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS.enabled).toBe(false)
    expect(source).toContain('checked={settings.enabled}')
    expect(source).toContain('Automatic updates are disabled')
    expect(source).toContain('by default; enable them only')
  })

  test('renders the auto-update checkbox unchecked with default settings', () => {
    const html = renderSystemUpdateSection()

    expect(html).toContain('Auto-update this instance')
    expect(html).not.toContain('checked=""')
  })
})

describe('SystemUpdateSection deployment flavor', () => {
  test('keeps the git updater form for self-hosted installs', () => {
    const html = renderSystemUpdateSection(null, { source: 'git-checkout', supervisor: 'pm2', sandboxRuntime: 'k3d' })

    expect(html).toContain('Auto-update this instance')
    expect(html).toContain('Manual rebuild')
    expect(html).not.toContain('managed by Ficus Desktop')
  })

  test('shows a read-only Ficus Desktop note instead of git controls when opened outside the desktop app', () => {
    const html = renderSystemUpdateSection(null, { source: 'artifact', supervisor: 'desktop', sandboxRuntime: 'host' })

    expect(html).toContain('This instance is managed by Ficus Desktop')
    expect(html).toContain('Ficus → Check for Updates…')
    expect(html).not.toContain('Auto-update this instance')
    expect(html).not.toContain('Manual rebuild')
    expect(html).not.toContain('Update now')
  })
})

describe('SystemUpdateSection instance kind', () => {
  afterEach(() => {
    delete window.ficusDesktopApp
  })

  test('a remote instance updates like a server, not with the app', () => {
    window.ficusDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      updates: stubDesktopUpdates(),
      instance: { kind: 'remote', name: 'noah' },
    }

    const html = renderSystemUpdateSection(null, { source: 'git-checkout', supervisor: 'pm2', sandboxRuntime: 'k3d' })

    expect(html).toContain('Auto-update this instance')
    expect(html).not.toContain('Ficus Desktop updates')
  })

  test('an attached instance updates like a server, not with the app', () => {
    window.ficusDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      updates: stubDesktopUpdates(),
      instance: { kind: 'attached', name: 'x' },
    }

    const html = renderSystemUpdateSection(null, { source: 'git-checkout', supervisor: 'pm2', sandboxRuntime: 'k3d' })

    expect(html).toContain('Auto-update this instance')
    expect(html).not.toContain('Ficus Desktop updates')
  })

  test('the bundled local instance keeps native Desktop update controls', () => {
    window.ficusDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      updates: stubDesktopUpdates(),
      instance: { kind: 'local', name: 'noah' },
    }

    const html = renderSystemUpdateSection()

    expect(html).toContain('Ficus Desktop updates')
    expect(html).not.toContain('Auto-update this instance')
  })

  test('no instance reported (older Desktop builds) still gets native Desktop update controls', () => {
    window.ficusDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      updates: stubDesktopUpdates(),
    }

    const html = renderSystemUpdateSection()

    expect(html).toContain('Ficus Desktop updates')
    expect(html).not.toContain('Auto-update this instance')
  })
})

describe('SystemUpdateSection latest run changed files', () => {
  test('renders long changed file paths in a responsive list that can break within the card', () => {
    const longPath = 'apps/web/src/components/settings/'.repeat(4) + 'SystemUpdateSectionWithLongName.tsx'

    const html = renderSystemUpdateSection({
      status: 'completed',
      changedFiles: [longPath],
      selectedTasks: [],
    })

    expect(html).toContain('Changed files')
    expect(html).toContain(longPath)
    expect(html).toMatch(/<li class="[^"]*break-all[^"]*"/)
  })
})

describe('SystemUpdateSection theme classes', () => {
  test('uses theme-safe primary text classes for controls and latest run content', () => {
    expect(source).toContain('<section className="space-y-6 text-primary">')
    expect(source).toContain('bg-surface px-2 py-1 text-primary')
    expect(source).toContain('bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active')
    expect(source).toContain('rounded bg-background text-xs text-primary')
  })

  test('uses settings-page button sizing and disabled styles', () => {
    expect(source).toContain('px-4 py-2.5 md:py-2')
    expect(source).toContain('rounded-md text-sm font-medium min-h-[44px] md:min-h-0')
    expect(source).toContain('disabled:opacity-50 disabled:cursor-not-allowed')
  })

  test('shows explicit loading labels while checking and updating', () => {
    expect(source).toContain("check.isPending ? 'Checking…' : 'Check now'")
    expect(source).toContain("isApplying ? 'Updating…' : 'Update now'")
  })

  test('uses backend deployment mode and history without browser persistence', () => {
    expect(source).toContain('const latest = status?.latest')
    expect(source).toContain('status.flavor.sandboxRuntime')
    expect(source).not.toContain('localStorage')
  })

  test('shows a friendly reconnecting message instead of raw gateway HTML', () => {
    expect(source).toContain('formatUpdateError')
    expect(source).toContain('The API is restarting or temporarily unavailable. Reconnecting…')
  })
})

describe('SystemUpdateSection manual rebuild block', () => {
  test('renders target checkboxes and a Rebuild selected button', () => {
    expect(source).toContain('Manual rebuild')
    expect(source).toContain('MANUAL_UPDATE_TARGETS')
    expect(source).toContain('applyTargetedUpdate')
    expect(source).toContain("'Rebuilding…'")
    expect(source).toContain("'Rebuild selected'")
  })
})

describe('getUpdateLoaderMessage', () => {
  test('prioritizes checking over an active running update', () => {
    expect(
      getUpdateLoaderMessage({
        isChecking: true,
        isRebuilding: false,
        isUpdating: true,
      })
    ).toBe('Checking for updates…')
  })

  test('prioritizes rebuilding over other update activity', () => {
    expect(
      getUpdateLoaderMessage({
        isChecking: false,
        isRebuilding: true,
        isUpdating: true,
      })
    ).toBe('Rebuilding selected components…')
  })

  test('returns a single updating message while applying', () => {
    expect(
      getUpdateLoaderMessage({
        isChecking: false,
        isRebuilding: false,
        isUpdating: true,
      })
    ).toBe('Updating system…')
  })

  test('returns null when no loader state is active', () => {
    expect(
      getUpdateLoaderMessage({
        isChecking: false,
        isRebuilding: false,
        isUpdating: false,
      })
    ).toBeNull()
  })
})
