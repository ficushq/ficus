import { afterEach, expect, spyOn, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SandboxSettings } from './SandboxSettings'
import { queryKeys } from '../../queryKeys'
import type { SandboxStatus } from '../../api/workspace'
import * as workspace from '../../api/workspace'
import { acquireDomHarness } from '../../test/domHarness'

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})
function client(status: SandboxStatus | undefined, permissions = ['squads:update']) {
  const result = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  result.setQueryData(queryKeys.squads.basic('s1'), { id: 's1', metadata: {} })
  result.setQueryData(queryKeys.auth.permissions('s1'), { permissions })
  if (status) result.setQueryData(queryKeys.sandbox.status('s1'), status)
  return result
}

test('VM recovery is available in lifecycle settings even when health is starting/failed; other runtimes and viewers keep existing controls', () => {
  for (const runtime of ['vm', 'k8s', 'docker', 'host', undefined] as const) {
    for (const status of ['running', 'starting', 'failed'] as const) {
      const queryClient = client(runtime ? { runtime, status } : undefined)
      const html = renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <SandboxSettings squadId="s1" />
        </QueryClientProvider>
      )
      expect(html.includes('>Restart<')).toBe(runtime === 'vm')
      queryClient.clear()
    }
  }
  const queryClient = client({ status: 'running', runtime: 'vm' }, ['squads:read'])
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SandboxSettings squadId="s1" />
    </QueryClientProvider>
  )
  expect(html).not.toContain('>Restart<')
  queryClient.clear()
})

test('restart requires confirmation, stays pending without claiming readiness, then shows failure and permits retry', async () => {
  let reject!: (error: Error) => void
  const restart = spyOn(workspace, 'restartSandbox').mockImplementation(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      })
  )
  spies.push(restart)
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/s1/settings' })
  const queryClient = client({ status: 'starting', runtime: 'vm' })
  const invalidate = spyOn(queryClient, 'invalidateQueries')
  spies.push(invalidate)
  const root = dom.createRoot()
  const button = () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Restart sandbox"]')!
  const settle = () =>
    dom.act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
  try {
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={queryClient}>
          <SandboxSettings squadId="s1" />
        </QueryClientProvider>
      )
    )
    await dom.act(async () => button().click())
    expect(restart).not.toHaveBeenCalled()
    expect(button().textContent).toContain('Confirm restart')
    await dom.act(async () => button().click())
    await settle()
    expect(restart).toHaveBeenCalledWith('s1')
    expect(button().disabled).toBe(true)
    expect(button().textContent).toContain('Restarting')
    expect(dom.window.document.body.textContent).not.toContain('Box server restarted')
    await dom.act(async () => reject(new Error('Readiness deadline exceeded')))
    await settle()
    expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('Readiness deadline exceeded')
    expect(button().disabled).toBe(false)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sandbox.status('s1') })
    restart.mockResolvedValue(undefined)
    await dom.act(async () => button().click())
    await dom.act(async () => button().click())
    await settle()
    expect(dom.window.document.body.textContent).toContain('Box server restarted')
    expect(dom.window.document.querySelector('[role="alert"]')).toBeNull()
    await dom.act(async () =>
      queryClient.setQueryData(queryKeys.sandbox.status('s1'), {
        status: 'starting',
        runtime: 'vm',
        restartPending: true,
      })
    )
    await settle()
    expect(button().disabled).toBe(true)
  } finally {
    await dom.cleanup()
    queryClient.clear()
  }
})
