import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import type { DesktopBridge, DesktopUpdates, DesktopUpdateState } from '../../lib/desktop'
import { DesktopUpdatePanel } from './DesktopUpdatePanel'
import { SystemUpdateSection } from './SystemUpdateSection'

const baseState: DesktopUpdateState = {
  appVersion: '1.4.0',
  coreCommit: '0123456789abcdef0123456789abcdef01234567',
  supported: true,
  phase: 'idle',
}

type FakeUpdates = DesktopUpdates & {
  calls: { check: number; install: number; unsubscribed: number }
  push(state: DesktopUpdateState): void
}

function fakeUpdates(initial: DesktopUpdateState, checked: DesktopUpdateState = initial): FakeUpdates {
  const listeners = new Set<(state: DesktopUpdateState) => void>()
  const calls = { check: 0, install: 0, unsubscribed: 0 }
  return {
    calls,
    state: async () => initial,
    check: async () => {
      calls.check++
      return checked
    },
    install: async () => {
      calls.install++
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        calls.unsubscribed++
        listeners.delete(listener)
      }
    },
    push(state) {
      for (const listener of listeners) listener(state)
    },
  }
}

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings?section=updates' })
})
afterEach(async () => {
  await harness.cleanup()
  delete window.ficusDesktopApp
})

async function renderPanel(updates: DesktopUpdates, canWrite = true) {
  const { root, container } = harness.createRoot()
  await harness.act(async () => root.render(<DesktopUpdatePanel updates={updates} canWrite={canWrite} />))
  return { root, container }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((item) => item.textContent === label)
  if (!match) throw new Error(`missing button ${label}`)
  return match as HTMLButtonElement
}

test('shows the installed app version, short Core commit, up-to-date status, and last check', async () => {
  const lastCheckedAt = new Date(Date.now() - 5 * 60_000).toISOString()
  const { container } = await renderPanel(fakeUpdates({ ...baseState, lastCheckedAt }))

  expect(container.textContent).toContain('Ficus Desktop updates')
  expect(container.textContent).toContain('1.4.0')
  expect(container.textContent).toContain('0123456')
  expect(container.textContent).not.toContain('0123456789abcdef')
  expect(container.textContent).toContain('Up to date')
  expect(container.textContent).toContain('Last checked 5 minutes ago')
  expect(container.textContent).not.toContain('doesn’t receive automatic updates')
})

test('Check now calls the native check and is disabled while checking', async () => {
  const updates = fakeUpdates(baseState, { ...baseState, phase: 'checking' })
  const { container } = await renderPanel(updates)

  await harness.act(async () => fireEvent.click(button(container, 'Check now')))
  expect(updates.calls.check).toBe(1)
  expect(container.textContent).toContain('Checking…')
  expect(button(container, 'Checking…').disabled).toBe(true)
})

test('renders a determinate progress bar while downloading with progress', async () => {
  const { container } = await renderPanel(
    fakeUpdates({
      ...baseState,
      phase: 'downloading',
      availableVersion: '1.5.0',
      progress: { receivedBytes: 25, totalBytes: 100 },
    })
  )

  expect(container.textContent).toContain('Downloading 1.5.0')
  const bar = container.querySelector('[role="progressbar"]')!
  expect(bar.getAttribute('aria-valuenow')).toBe('25')
  expect((bar.firstElementChild as HTMLElement).style.width).toBe('25%')
  expect(button(container, 'Check now').disabled).toBe(true)
})

test('renders an indeterminate progress bar while downloading without progress', async () => {
  const { container } = await renderPanel(
    fakeUpdates({ ...baseState, phase: 'downloading', availableVersion: '1.5.0' })
  )

  const bar = container.querySelector('[role="progressbar"]')!
  expect(bar.hasAttribute('aria-valuenow')).toBe(false)
  expect(bar.firstElementChild?.className).toContain('animate-pulse')
})

test('a ready update offers Restart to update, which installs it', async () => {
  const updates = fakeUpdates({ ...baseState, phase: 'ready', availableVersion: '1.5.0' })
  const { container } = await renderPanel(updates)

  expect(container.textContent).toContain('Ficus 1.5.0 is ready')
  await harness.act(async () => fireEvent.click(button(container, 'Restart to update')))
  expect(updates.calls.install).toBe(1)
})

test('installing disables Check now', async () => {
  const { container } = await renderPanel(fakeUpdates({ ...baseState, phase: 'installing', availableVersion: '1.5.0' }))

  expect(container.textContent).toContain('Restarting to install Ficus 1.5.0')
  expect(button(container, 'Check now').disabled).toBe(true)
})

test('an error shows its message with a Retry that checks again', async () => {
  const updates = fakeUpdates({ ...baseState, phase: 'error', error: 'Network unreachable' })
  const { container } = await renderPanel(updates)

  expect(container.textContent).toContain('Network unreachable')
  await harness.act(async () => fireEvent.click(button(container, 'Retry')))
  expect(updates.calls.check).toBe(1)
})

test('explains when this build does not receive automatic updates', async () => {
  const { container } = await renderPanel(fakeUpdates({ ...baseState, supported: false }))

  expect(container.textContent).toContain('doesn’t receive automatic updates')
  expect(container.textContent).not.toContain('Up to date')
  expect(container.textContent).not.toContain('Check now')
})

test('without update permission, status is visible but Check now and Restart to update are not', async () => {
  const { container } = await renderPanel(
    fakeUpdates({ ...baseState, phase: 'ready', availableVersion: '1.5.0' }),
    false
  )

  expect(container.textContent).toContain('Ficus 1.5.0 is ready')
  expect(container.textContent).not.toContain('Restart to update')
  expect(container.textContent).not.toContain('Check now')
})

test('follows pushed update states and unsubscribes on unmount', async () => {
  const updates = fakeUpdates(baseState)
  const { root, container } = await renderPanel(updates)

  await harness.act(async () =>
    updates.push({ ...baseState, phase: 'downloading', progress: { receivedBytes: 1, totalBytes: 2 } })
  )
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50')
  await harness.act(async () => root.unmount())
  expect(updates.calls.unsubscribed).toBe(1)
})

test('inside the desktop app, the Updates page uses native updates without polling the git updater', async () => {
  const updates = fakeUpdates(baseState)
  const bridge: DesktopBridge = {
    version: 1,
    notificationsEnabled: async () => false,
    deliverNotifications: async () => {},
    updates,
  }
  window.ficusDesktopApp = bridge
  const requests: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    return new Response('{}', { status: 500 })
  }) as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    const { root, container } = harness.createRoot()
    await harness.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SystemUpdateSection />
        </QueryClientProvider>
      )
    )
    expect(container.textContent).toContain('Ficus Desktop updates')
    expect(container.textContent).not.toContain('Auto-update this instance')
    expect(requests.filter((url) => url.includes('/updates/'))).toEqual([])
  } finally {
    globalThis.fetch = previousFetch
    client.clear()
  }
})
