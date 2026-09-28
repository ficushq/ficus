import { expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { client } from '../api/clientInstance'
import { WorktreeCleanupSettings } from './WorktreeCleanupSettings'

for (const permission of [false, true]) {
  test(`cleanup setting is ${permission ? 'editable' : 'read-only'} with effective retention and status`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/cleanup' })
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const stream = {
      id: 'stream',
      squadId: 'squad',
      autoCleanupWorktree: false,
      worktree: '/workspace/feature',
      worktreeCleanup: { status: 'deferred', reason: 'Ignored evidence must be retained' },
    } as WorkStream
    cache.setQueryData(queryKeys.auth.permissions(stream.squadId), {
      permissions: permission ? ['workstreams:update'] : [],
    })
    const root = dom.createRoot()
    try {
      await dom.act(async () =>
        root.root.render(
          <QueryClientProvider client={cache}>
            <WorktreeCleanupSettings stream={stream} />
          </QueryClientProvider>
        )
      )
      const checkbox = dom.window.document.querySelector('input[type="checkbox"]') as HTMLInputElement | null
      expect(checkbox).not.toBeNull()
      expect(checkbox!.checked).toBe(false)
      expect(checkbox!.disabled).toBe(!permission)
      expect(dom.window.document.body.textContent).toContain('Ignored evidence must be retained')
    } finally {
      await dom.cleanup()
      cache.clear()
    }
  })
}

test('cleanup toggle sends false explicitly and explains removal already in flight', async () => {
  expect(client.workStreams.setAutoCleanupWorktree).toBeDefined()
  const dom = await acquireDomHarness({ url: 'http://localhost/cleanup' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const stream = {
    id: 'stream',
    squadId: 'squad',
    autoCleanupWorktree: true,
    worktree: '/workspace/feature',
  } as WorkStream
  cache.setQueryData(queryKeys.auth.permissions(stream.squadId), { permissions: ['workstreams:update'] })
  const save = spyOn(client.workStreams, 'setAutoCleanupWorktree').mockResolvedValue({
    ...stream,
    autoCleanupWorktree: false,
  })
  const root = dom.createRoot()
  const render = (value: WorkStream) =>
    dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={cache}>
          <WorktreeCleanupSettings stream={value} />
        </QueryClientProvider>
      )
    )
  try {
    await render(stream)
    await dom.act(async () => (dom.window.document.querySelector('input') as HTMLInputElement).click())
    expect(save).toHaveBeenCalledWith('stream', false)
    await render({
      ...stream,
      worktreeCleanup: {
        status: 'removing',
        reason: 'Awaiting terminal receipt',
        operationId: 'operation',
      } as WorkStream['worktreeCleanup'],
    })
    expect((dom.window.document.querySelector('input') as HTMLInputElement).disabled).toBe(true)
    expect(dom.window.document.body.textContent).toContain('Do not reuse')
  } finally {
    save.mockRestore()
    await dom.cleanup()
    cache.clear()
  }
})

test('failed retention updates keep the effective setting and restore editing after pending state', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/cleanup' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const stream = { id: 'stream', squadId: 'squad', autoCleanupWorktree: true } as WorkStream
  cache.setQueryData(queryKeys.auth.permissions(stream.squadId), { permissions: ['workstreams:update'] })
  let reject!: (error: Error) => void
  const pending = new Promise<WorkStream>((_, fail) => {
    reject = fail
  })
  const save = spyOn(client.workStreams, 'setAutoCleanupWorktree').mockReturnValue(pending)
  const root = dom.createRoot()
  try {
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={cache}>
          <WorktreeCleanupSettings stream={stream} />
        </QueryClientProvider>
      )
    )
    const checkbox = dom.window.document.querySelector('input') as HTMLInputElement
    await dom.act(async () => {
      checkbox.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(checkbox.disabled).toBe(true)
    await dom.act(async () => {
      reject(new Error('Retention update rejected'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(checkbox.checked).toBe(true)
    expect(checkbox.disabled).toBe(false)
    expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('Retention update rejected')
  } finally {
    save.mockRestore()
    await dom.cleanup()
    cache.clear()
  }
})
