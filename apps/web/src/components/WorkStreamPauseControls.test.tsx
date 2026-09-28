import { expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { client } from '../api/clientInstance'
import { queryKeys } from '../queryKeys'
import { WorkStreamPauseControls } from './WorkStreamPauseControls'

test('pause controls retain the slot by default and expose resume/park only while paused', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/pause' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const stream = { id: 'pause-stream', squadId: 'pause-squad', status: 'active' } as WorkStream
  cache.setQueryData(queryKeys.auth.permissions(stream.squadId), { permissions: ['workstreams:update'] })
  const root = dom.createRoot()
  const pause = spyOn(client.workStreams, 'pause').mockResolvedValue(stream)
  const resume = spyOn(client.workStreams, 'resume').mockResolvedValue(stream)
  const park = spyOn(client.workStreams, 'park').mockResolvedValue({} as any)
  const render = async (value: WorkStream) =>
    dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={cache}>
          <WorkStreamPauseControls stream={value} />
        </QueryClientProvider>
      )
    )
  const button = (label: string) =>
    [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent === label)!
  try {
    await render(stream)
    await dom.act(async () => button('Pause work').click())
    await dom.act(async () =>
      dom.window.document
        .querySelector('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    )
    expect(pause).toHaveBeenCalledWith(stream.id, { reason: '' })
    const paused = {
      ...stream,
      pause: { id: 'pause-id', pausedAt: new Date().toISOString(), reason: 'Hold', parkAt: null, agentIds: [] },
    }
    await render(paused)
    expect(dom.window.document.body.textContent).toContain('Holding its slot')
    await dom.act(async () => button('Park while paused').click())
    expect(park).toHaveBeenCalledWith(stream.id)
    await render({ ...paused, status: 'queued' })
    expect(dom.window.document.body.textContent).toContain('Parked; no slot held')
    expect(button('Park while paused')).toBeUndefined()
    await dom.act(async () => button('Resume work').click())
    expect(resume).toHaveBeenCalledWith(stream.id)
  } finally {
    pause.mockRestore()
    resume.mockRestore()
    park.mockRestore()
    await dom.cleanup()
    cache.clear()
  }
})
