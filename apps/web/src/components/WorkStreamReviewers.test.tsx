import { test, expect, spyOn } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { waitFor } from '@testing-library/dom'
import type { WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { client } from '../api/clientInstance'
import { renderToStaticMarkup } from 'react-dom/server'
import { NoActiveReviewerNotice, WorkStreamReviewers } from './WorkStreamReviewers'

test('work-stream editors assign and clear reviewer filters without granting review permissions', async () => {
  const reviewers = [{ id: 'reviewer', name: 'Riley' }]
  // Assigning a reviewer refreshes the reviewer options.
  const dom = await acquireDomHarness({
    url: 'http://localhost/workstream',
    api: { '/api/workflows/reviewers': reviewers },
  })
  const { root } = dom.createRoot()
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const stream = { id: 'stream', squadId: 'squad', assignedReviewerIds: [] } as unknown as WorkStream
  cache.setQueryData(queryKeys.auth.permissions('squad'), { permissions: ['workstreams:update'] })
  cache.setQueryData(queryKeys.workflows.reviewers('squad'), reviewers)
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

test('the stream warns to reassign while no assigned reviewer is active, and marks the inactive ones', () => {
  const stream = {
    id: 'stream',
    squadId: 'squad',
    status: 'active',
    assignedReviewerIds: ['gone', 'left'],
  } as unknown as WorkStream
  const notice = (fields: Partial<WorkStream>) =>
    renderToStaticMarkup(<NoActiveReviewerNotice stream={{ ...stream, ...fields }} />)
  expect(notice({ inactiveAssignedReviewerIds: ['gone', 'left'] })).toContain('Assign an active reviewer')
  // One still active, an older server that sends nothing, or a finished stream: no warning.
  expect(notice({ inactiveAssignedReviewerIds: ['gone'] })).toBe('')
  expect(notice({})).toBe('')
  expect(notice({ inactiveAssignedReviewerIds: ['gone', 'left'], status: 'done' })).toBe('')
  // Reassigned: an active reviewer joins the list, so the warning clears.
  expect(notice({ assignedReviewerIds: ['gone', 'left', 'new'], inactiveAssignedReviewerIds: ['gone', 'left'] })).toBe(
    ''
  )

  const cache = new QueryClient()
  cache.setQueryData(queryKeys.workflows.reviewers('squad'), [])
  const list = renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <WorkStreamReviewers stream={{ ...stream, inactiveAssignedReviewerIds: ['gone', 'left'] }} />
    </QueryClientProvider>
  )
  expect(list.match(/no longer active/g)).toHaveLength(2)
  // The warning is the stream's notice, not repeated in the list.
  expect(list).not.toContain('No assigned reviewer')
})
