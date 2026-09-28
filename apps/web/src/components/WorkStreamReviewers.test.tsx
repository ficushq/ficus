import { test, expect, spyOn } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { waitFor } from '@testing-library/dom'
import type { WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { client } from '../api/clientInstance'
import { WorkStreamReviewers } from './WorkStreamReviewers'

test('work-stream editors assign and clear reviewer filters without granting review permissions', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/workstream' })
  const { root } = dom.createRoot()
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const stream = { id: 'stream', squadId: 'squad', assignedReviewerIds: [] } as unknown as WorkStream
  cache.setQueryData(queryKeys.auth.permissions('squad'), { permissions: ['workstreams:update'] })
  cache.setQueryData(queryKeys.workflows.reviewers('squad'), [{ id: 'reviewer', name: 'Riley' }])
  const update = spyOn(client.workflows, 'assignReviewers').mockResolvedValue({
    ...stream,
    assignedReviewerIds: ['reviewer'],
  })
  const render = async (ids: string[]) =>
    dom.act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <WorkStreamReviewers stream={{ ...stream, assignedReviewerIds: ids }} />
        </QueryClientProvider>
      )
    )
  try {
    await render([])
    expect(document.body.textContent).toContain('anyone with review permission can decide')
    await dom.act(async () => {
      const field = document.querySelector<HTMLSelectElement>('[aria-label="Assign reviewer"]')!
      field.value = 'reviewer'
      field.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    expect(update).toHaveBeenCalledWith('stream', ['reviewer'])
    await render(['reviewer'])
    await waitFor(() => expect(document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false))
    await dom.act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    expect(update).toHaveBeenLastCalledWith('stream', [])
    await dom.act(async () =>
      cache.setQueryData(queryKeys.auth.permissions('squad'), { permissions: ['workstreams:review'] })
    )
    await render(['reviewer'])
    expect(document.querySelector('select') === null).toBe(true)
    expect(document.querySelector('button') === null).toBe(true)
    expect(document.body.textContent).toContain('Riley')
  } finally {
    update.mockRestore()
    await dom.cleanup()
    cache.clear()
  }
})

for (const status of ['done', 'canceled'] as const) {
  test(`hides reviewer assignment for ${status} work without fetching reviewer options`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/workstream' })
    const { root } = dom.createRoot()
    try {
      await dom.act(async () =>
        root.render(<WorkStreamReviewers stream={{ id: 'finished', squadId: 'squad', status } as WorkStream} />)
      )
      expect(dom.window.document.body.textContent).not.toContain('Assigned reviewers')
      expect(dom.window.document.querySelector('select')).toBeNull()
    } finally {
      await dom.cleanup()
    }
  })
}
