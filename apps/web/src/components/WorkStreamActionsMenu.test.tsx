import { MemoryRouter } from 'react-router-dom'
import { expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { webkitTap } from '../test/webkitTap'
import { queryKeys } from '../queryKeys'
import { client } from '../api/clientInstance'
import { WorkStreamActionsMenu } from './WorkStreamActionsMenu'
import { WorkStreamPauseControls, useWorkStreamPauseControls } from './WorkStreamPauseControls'

function Surface({ stream }: { stream: WorkStream }) {
  const controls = useWorkStreamPauseControls(stream)
  return (
    <>
      <div role="dialog" tabIndex={-1}>
        <WorkStreamActionsMenu stream={stream} controls={controls} />
      </div>
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
  const button = (text: string) =>
    [...dom.window.document.body.querySelectorAll('button')].find((b) => b.textContent === text)
  try {
    await render(stream)
    const trigger = dom.window.document.body.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!
    expect(button('Pause work…')).toBeUndefined()
    await dom.act(async () => trigger.click())
    expect(button('Pause work…')).toBeDefined()
    expect(dom.window.document.body.textContent).toContain('Notifications…')
    expect(dom.window.document.body.querySelector('summary')!.textContent).toBe('Notifications…')
    await dom.act(async () => button('Copy link')!.click())
    expect(copy).toHaveBeenCalledWith('https://example.test/tau/squads/squad-id/work?ws=451')
    expect(dom.window.document.body.textContent).toContain('Link copied')
    copy.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    await dom.act(async () => trigger.click())
    await dom.act(async () => button('Copy link')!.click())
    expect(dom.window.document.body.textContent).toContain('Could not copy link')
    await dom.act(async () => trigger.click())
    await dom.act(async () => button('Pause work…')!.click())
    expect(pause).not.toHaveBeenCalled()
    expect(dom.window.document.body.querySelector('form')).not.toBeNull()
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
    await dom.act(async () =>
      dom.window.document.body.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click()
    )
    await dom.act(async () => dom.window.document.body.querySelector('summary')!.click())
    // A press on the visible label first focuses the nearest focusable ancestor (the dialog),
    // then the label's click forwards focus/activation to its radio. Don't unmount in between.
    await dom.act(async () => dom.window.document.body.querySelector('summary')!.focus())
    await dom.act(async () => dom.window.document.body.querySelector<HTMLElement>('[role="dialog"]')!.focus())
    expect(dom.window.document.body.querySelector('[aria-label="More actions"]')!.getAttribute('aria-expanded')).toBe(
      'true'
    )
    await dom.act(async () =>
      dom.window.document.body.querySelector<HTMLInputElement>('[aria-label="Progress: Show"]')!.click()
    )
    expect(subscribe).toHaveBeenCalledWith(stream.id, { decisions: 'notify', progress: 'show' })
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(dom.window.document.body.querySelector<HTMLInputElement>('[aria-label="Progress: Show"]')!.checked).toBe(
      true
    )
    subscribe.mockRejectedValueOnce(new Error('Offline'))
    await dom.act(async () =>
      dom.window.document.body.querySelector<HTMLInputElement>('[aria-label="Decisions: Show"]')!.click()
    )
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(dom.window.document.body.querySelector('[role="alert"]')!.textContent).toContain(
      'Could not update attention'
    )
    expect(dom.window.document.body.querySelector('details')!.open).toBe(true)
    expect(dom.window.document.body.querySelector<HTMLInputElement>('[aria-label="Decisions: Notify"]')!.checked).toBe(
      true
    )
    const resetButton = [...dom.window.document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'Reset to squad'
    )!
    expect(Boolean(resetButton)).toBe(true)
    await dom.act(async () => resetButton.click())
    expect(reset).toHaveBeenCalledWith(stream.id)
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(dom.window.document.body.textContent).toContain('Inherits from squad')
    expect(dom.window.document.body.textContent).not.toContain('Reset to squad')
  } finally {
    get.mockRestore()
    subscribe.mockRestore()
    reset.mockRestore()
    await dom.cleanup()
    cache.clear()
  }
})

// Safari/iOS: a tapped button or label is never focused; WebKit focuses the enclosing dialog instead. Every
// action, including a level inside the inline notifications disclosure, must still run.
test('WebKit taps on menu items run them inside a focusable dialog', async () => {
  const api = await import('../api/squads')
  const dom = await acquireDomHarness({ url: 'https://example.test/' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const stream = { id: 'webkit-stream', number: 7, squadId: 'squad', status: 'active' } as WorkStream
  const subscription = { attention: { decisions: 'notify', progress: 'mute' }, inherited: true, subscribed: false }
  cache.setQueryData(queryKeys.auth.permissions(stream.squadId), { permissions: ['workstreams:update'] })
  cache.setQueryData(queryKeys.workStreamSubscription.detail(stream.id), subscription)
  const get = spyOn(api, 'getWorkStreamSubscription').mockImplementation(async () => subscription as never)
  const subscribe = spyOn(api, 'subscribeWorkStream').mockImplementation(async () => subscription as never)
  const copy = spyOn(dom.window.navigator.clipboard, 'writeText').mockResolvedValue()
  const root = dom.createRoot()
  const button = (text: string) =>
    [...dom.window.document.body.querySelectorAll('button')].find((b) => b.textContent === text)!
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
    const trigger = dom.window.document.body.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!
    await dom.act(async () => trigger.click())
    await dom.act(async () => button('Copy link').focus())
    expect(await webkitTap(button('Copy link'))).toBe(true)
    expect(copy).toHaveBeenCalledWith('https://example.test/squads/squad/work?ws=7')

    await dom.act(async () => trigger.click())
    await dom.act(async () => button('Pause work…').focus())
    expect(await webkitTap(dom.window.document.body.querySelector('summary')!, { touch: true })).toBe(true)
    expect(dom.window.document.body.querySelector('details')!.open).toBe(true)
    const label = dom.window.document.body.querySelector('[aria-label="Progress: Show"]')!.closest('label')!
    expect(await webkitTap(label)).toBe(true)
    expect(subscribe).toHaveBeenCalledWith(stream.id, { decisions: 'notify', progress: 'show' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    // Keyboard focus leaving the menu (once the tap has finished) closes it.
    const outside = dom.window.document.body.appendChild(dom.window.document.createElement('button'))
    await dom.act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    await dom.act(async () => button('Copy link').focus())
    await dom.act(async () => outside.focus())
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  } finally {
    get.mockRestore()
    subscribe.mockRestore()
    copy.mockRestore()
    await dom.cleanup()
    cache.clear()
  }
})

test('a PR-mode stream ready for delivery offers Check delivery now in More actions until its PR is merged', async () => {
  const dom = await acquireDomHarness({ url: 'https://example.test/' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const stream = {
    id: 'pr-stream',
    number: 452,
    squadId: 'squad-id',
    status: 'active',
    metadata: { codeHost: { integration: 'github', repository: 'ficushq/ficus', changeRequest: { number: 12 } } },
  } as unknown as WorkStream
  cache.setQueryData(queryKeys.auth.permissions(stream.squadId), { permissions: ['workstreams:respond'] })
  cache.setQueryData(queryKeys.workStreamSubscription.detail(stream.id), {
    attention: { decisions: 'notify', progress: 'mute' },
    inherited: true,
  })
  cache.setQueryData(queryKeys.workflows.run(stream.id), {
    workStreamId: stream.id,
    version: 5,
    state: { status: 'completion-ready', definition: { completion: { mode: 'pr-auto-merge' } } },
  })
  const finish = spyOn(client.workflows, 'finish').mockResolvedValue(undefined as never)
  const root = dom.createRoot()
  const render = (value: WorkStream) =>
    dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter>
            <Surface stream={value} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
  const item = () =>
    [...dom.window.document.body.querySelectorAll('button')].find((b) => b.textContent === 'Check delivery now')
  try {
    await render(stream)
    const trigger = dom.window.document.body.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!
    await dom.act(async () => trigger.click())
    await dom.act(async () => item()!.click())
    await dom.act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(finish).toHaveBeenCalledWith(stream.id, 5)
    expect(dom.window.document.body.textContent).toContain('Delivery checked')

    const key = 'github:ficushq/ficus:pull_request:12'
    await render({
      ...stream,
      metadata: { ...stream.metadata, delivery: { pullRequests: { [key]: { state: 'merged', at: 'now' } } } },
    } as unknown as WorkStream)
    await dom.act(async () => trigger.click())
    expect([...dom.window.document.body.querySelectorAll('button')].some((b) => b.textContent === 'Copy link')).toBe(
      true
    )
    expect(item()).toBeUndefined()
  } finally {
    finish.mockRestore()
    await dom.cleanup()
  }
})
