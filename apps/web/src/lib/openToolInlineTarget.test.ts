import { describe, expect, mock, test } from 'bun:test'
import type { LocalDeployment } from '@ficus/shared'
import { openExternalUrl, openLocalApp } from './openToolInlineTarget'

function fakeTab() {
  return { opener: {} as unknown, location: { href: '' }, close: mock(() => undefined) }
}

const deployment = (overrides: Partial<LocalDeployment> = {}) =>
  ({
    id: 'ld-1',
    urlPathOrHost: 'https://ficus--preview.apps.example.com/',
    archivedAt: null,
    ...overrides,
  }) as LocalDeployment

describe('openExternalUrl', () => {
  test('opens the URL in a new tab without an opener', () => {
    const open = mock(() => null)
    openExternalUrl('https://github.com/ficushq/ficus/pull/684', open)
    expect(open).toHaveBeenCalledWith('https://github.com/ficushq/ficus/pull/684', '_blank', 'noopener,noreferrer')
  })
})

describe('openLocalApp', () => {
  test('opens a tab during the click, detaches it, and sends it to the app', async () => {
    const tab = fakeTab()
    const open = mock(() => tab as unknown as Window)
    const getLocalDeployment = mock(async () => deployment())
    await openLocalApp('ld-1', { open, getLocalDeployment, getPublicAppUrl: async () => ({ url: null }) })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(tab.opener).toBeNull()
    expect(getLocalDeployment).toHaveBeenCalledWith('ld-1')
    expect(tab.location.href).toBe('https://ficus--preview.apps.example.com/')
    expect(tab.close).not.toHaveBeenCalled()
  })

  test('closes the tab when the app is archived or cannot be loaded', async () => {
    for (const getLocalDeployment of [
      async () => deployment({ archivedAt: '2026-10-27T00:00:00.000Z' }),
      async () => {
        throw new Error('Local deployment not found')
      },
    ]) {
      const tab = fakeTab()
      await openLocalApp('ld-1', {
        open: () => tab as unknown as Window,
        getLocalDeployment,
        getPublicAppUrl: async () => ({ url: null }),
      })
      expect(tab.close).toHaveBeenCalledTimes(1)
      expect(tab.location.href).toBe('')
    }
  })

  test('falls back to opening the app directly when no tab could be opened up front', async () => {
    const open = mock((_url?: string) => null)
    await openLocalApp('ld-1', {
      open,
      getLocalDeployment: async () => deployment(),
      getPublicAppUrl: async () => {
        throw new Error('offline')
      },
    })
    expect(open).toHaveBeenLastCalledWith('https://ficus--preview.apps.example.com/', '_blank', 'noopener,noreferrer')
  })
})
