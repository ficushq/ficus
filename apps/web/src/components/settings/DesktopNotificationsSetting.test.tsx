import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, waitFor } from '@testing-library/dom'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { desktopQueryKeys, queryKeys } from '../../queryKeys'
import { NotificationsConfigSection } from './NotificationsConfigSection'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let client: QueryClient
beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings?section=notification-rules' })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.notificationConfig.detail(), {
    rules: [],
    channels: {},
    yamlFieldOverrides: [],
    hasTemplate: false,
  })
})
afterEach(async () => {
  await harness.cleanup()
  delete window.ficusDesktopApp
  client.clear()
})

async function render() {
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <PermissionsProvider
            usePermissions={() => ({ permissions: [], can: () => false, isLoading: false, isError: false })}
          >
            <NotificationsConfigSection />
          </PermissionsProvider>
        </QueryClientProvider>
      </MemoryRouter>
    )
  )
  return container
}

test('the desktop notifications switch reads and writes the desktop preference', async () => {
  let desktopEnabled = false
  const writes: boolean[] = []
  window.ficusDesktopApp = {
    version: 1,
    notificationsEnabled: async () => desktopEnabled,
    deliverNotifications: async () => {},
    setNotificationsEnabled: async (enabled) => {
      writes.push(enabled)
      desktopEnabled = enabled
      return enabled
    },
  }
  const container = await render()
  const toggle = () => container.querySelector<HTMLInputElement>('[data-setting-target="desktop-notifications"] input')!

  expect(container.textContent).toContain('Desktop notifications')
  expect(container.textContent).toContain('macOS alerts for inbox updates while Ficus is in the background.')
  await harness.act(async () => waitFor(() => expect(toggle().disabled).toBe(false)))
  expect(toggle().getAttribute('role')).toBe('switch')
  expect(toggle().checked).toBe(false)

  await harness.act(async () => fireEvent.click(toggle()))
  await harness.act(async () => waitFor(() => expect(toggle().checked).toBe(true)))
  expect(writes).toEqual([true])
  // DesktopNotifications gates its feed polling on this same cached preference.
  expect(client.getQueryData(desktopQueryKeys.enabled())).toBe(true)

  await harness.act(async () => fireEvent.click(toggle()))
  await harness.act(async () => waitFor(() => expect(toggle().checked).toBe(false)))
  expect(writes).toEqual([true, false])
  expect(client.getQueryData(desktopQueryKeys.enabled())).toBe(false)
})

test('older desktop builds and browsers show no desktop notifications switch', async () => {
  window.ficusDesktopApp = {
    version: 1,
    notificationsEnabled: async () => true,
    deliverNotifications: async () => {},
  }
  const withOldBridge = await render()
  expect(withOldBridge.textContent).toContain('Notification Rules')
  expect(withOldBridge.textContent).not.toContain('Desktop notifications')

  delete window.ficusDesktopApp
  const inBrowser = await render()
  expect(inBrowser.textContent).not.toContain('Desktop notifications')
})
