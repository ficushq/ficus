import { MemoryRouter } from 'react-router-dom'
import { expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { client } from '../api/clientInstance'
import { WorkStreamActionsMenu } from './WorkStreamActionsMenu'
import { WorkStreamPauseControls, useWorkStreamPauseControls } from './WorkStreamPauseControls'

function Surface({ stream }: { stream: WorkStream }) {
  const controls = useWorkStreamPauseControls(stream)
  return (
    <>
      <WorkStreamActionsMenu stream={stream} controls={controls} />
      <WorkStreamPauseControls stream={stream} controls={controls} />
    </>
  )
}

test('overflow keeps pause secondary, preserves attention, copies a canonical link and dismisses with focus', async () => {
  const dom = await acquireDomHarness({ url: 'https://example.test/actions/old?waitId=stale' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const stream = { id: 'stream-id', number: 451, squadId: 'squad-id', status: 'active' } as WorkStream
  cache.setQueryData(queryKeys.auth.permissions(stream.squadId), { permissions: ['workstreams:update'] })
  cache.setQueryData(queryKeys.workStreamSubscription.detail(stream.id), {
    attention: { decisions: 'notify', progress: 'mute' },
    inherited: true,
  })
  const root = dom.createRoot()
  const pause = spyOn(client.workStreams, 'pause').mockResolvedValue(stream)
  const copy = spyOn(dom.window.navigator.clipboard, 'writeText').mockResolvedValue()
  const render = (value: WorkStream) =>
    dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter basename="/tau" initialEntries={['/tau/']}>
            <Surface stream={value} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
  const button = (text: string) => [...root.container.querySelectorAll('button')].find((b) => b.textContent === text)
  try {
    await render(stream)
    const trigger = root.container.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!
    expect(button('Pause work…')).toBeUndefined()
    await dom.act(async () => trigger.click())
    expect(button('Pause work…')).toBeDefined()
    expect(root.container.textContent).toContain('Notifications…')
    expect(root.container.textContent).toContain('Custom')
    await dom.act(async () => button('Copy link')!.click())
    expect(copy).toHaveBeenCalledWith('https://example.test/tau/squads/squad-id/work?ws=451')
    expect(root.container.textContent).toContain('Link copied')
    copy.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    await dom.act(async () => trigger.click())
    await dom.act(async () => button('Copy link')!.click())
    expect(root.container.textContent).toContain('Could not copy link')
    await dom.act(async () => trigger.click())
    await dom.act(async () => button('Pause work…')!.click())
    expect(pause).not.toHaveBeenCalled()
    expect(root.container.querySelector('form')).not.toBeNull()
    expect(dom.window.document.activeElement?.tagName).toBe('INPUT')
    await dom.act(async () => trigger.click())
    await dom.act(async () =>
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(dom.window.document.activeElement).toBe(trigger)
    const paused = { ...stream, pause: { id: 'p', reason: 'Hold', pausedAt: '', parkAt: null, agentIds: [] } }
    await render(paused)
    await dom.act(async () => trigger.click())
    expect(button('Park while paused')).toBeDefined()
    expect(button('Pause work…')).toBeUndefined()
    await render({ ...paused, status: 'queued' })
    expect(button('Park while paused')).toBeUndefined()
    await dom.act(async () =>
      dom.window.document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
    )
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    for (const status of ['done', 'canceled'] as const) {
      await render({ ...stream, status })
      await dom.act(async () => trigger.click())
      expect(button('Pause work…')).toBeUndefined()
      expect(button('Park while paused')).toBeUndefined()
      await dom.act(async () => trigger.click())
    }
    cache.setQueryData(queryKeys.auth.permissions(stream.squadId), { permissions: [] })
    await render({ ...stream, id: 'read-only' })
    await dom.act(async () => trigger.click())
    expect(button('Pause work…')).toBeUndefined()
  } finally {
    copy.mockRestore()
    pause.mockRestore()
    await dom.cleanup()
    cache.clear()
  }
})

test('notification changes preserve the other kind and reset the stream override to squad', async () => {
  const api = await import('../api/squads')
  const dom = await acquireDomHarness({ url: 'https://example.test/' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const stream = { id: 'notifications-stream', squadId: 'squad', status: 'done' } as WorkStream
  let subscription = {
    attention: { decisions: 'notify', progress: 'mute' } as const,
    inherited: true,
    subscribed: false,
    count: 0,
  }
  cache.setQueryData(queryKeys.auth.permissions(stream.squadId), { permissions: [] })
  cache.setQueryData(queryKeys.workStreamSubscription.detail(stream.id), subscription)
  const get = spyOn(api, 'getWorkStreamSubscription').mockImplementation(async () => subscription)
  const subscribe = spyOn(api, 'subscribeWorkStream').mockImplementation(async (_id, attention) => {
    subscription = { ...subscription, inherited: false, attention: attention! as any }
    return subscription
  })
  const reset = spyOn(api, 'unsubscribeWorkStream').mockImplementation(async () => {
    subscription = { ...subscription, inherited: true }
    return subscription
  })
  const root = dom.createRoot()
  try {
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter>
            <Surface stream={stream} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    await dom.act(async () => root.container.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click())
    await dom.act(async () => root.container.querySelector('summary')!.click())
    await dom.act(async () => root.container.querySelector<HTMLInputElement>('[aria-label="Progress: Show"]')!.click())
    expect(subscribe).toHaveBeenCalledWith(stream.id, { decisions: 'notify', progress: 'show' })
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(root.container.querySelector<HTMLInputElement>('[aria-label="Progress: Show"]')!.checked).toBe(true)
    const resetButton = [...root.container.querySelectorAll('button')].find((b) => b.textContent === 'Reset to squad')!
    expect(Boolean(resetButton)).toBe(true)
    await dom.act(async () => resetButton.click())
    expect(reset).toHaveBeenCalledWith(stream.id)
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(root.container.textContent).toContain('Inherits from squad')
    expect(root.container.textContent).not.toContain('Reset to squad')
  } finally {
    get.mockRestore()
    subscribe.mockRestore()
    reset.mockRestore()
    await dom.cleanup()
    cache.clear()
  }
})
