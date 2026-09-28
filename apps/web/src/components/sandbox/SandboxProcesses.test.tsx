import { afterEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SandboxProcesses as SandboxProcessesData } from '@ficus/shared'
import * as workspaceApi from '../../api/workspace'
import { acquireDomHarness } from '../../test/domHarness'
import { formatAge, SandboxProcesses } from './SandboxProcesses'

// Today's incident: a detached full typecheck and a forgotten test database
// overloading the squad box, next to the sandbox server itself.
const listing: SandboxProcessesData = {
  pressure: { cpus: 4, load: [22.72, 31.86, 30.52], memTotalMb: 7941, memAvailableMb: 463 },
  processes: [
    {
      pid: 2838629,
      ppid: 2838611,
      cpuPercent: 187.4,
      memRssMb: 2116,
      ageSeconds: 9286,
      state: 'R',
      command: 'bun node_modules/.bin/tsc -p apps/core --noEmit',
      protected: false,
    },
    {
      pid: 754597,
      ppid: 929,
      cpuPercent: 0.4,
      memRssMb: 123,
      ageSeconds: 136_000,
      state: 'S',
      command: '/opt/tau/bin/bun /opt/tau/server/server.js',
      protected: true,
    },
  ],
  containers: {
    available: true,
    containers: [
      {
        id: '5da43cf7deaa',
        name: 'tau-test-ebb213d9-postgres-1',
        image: 'paradedb/paradedb',
        state: 'running',
        status: 'Up 10 hours',
      },
    ],
  },
}

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

test('formats ages compactly', () => {
  expect([45, 720, 9286, 136_000, 400_000].map(formatAge)).toEqual(['45s', '12m', '2h 34m', '37h 46m', '4d'])
})

test('loads on request, flags overload, protects the sandbox server, and stops what it is asked to', async () => {
  const list = spyOn(workspaceApi, 'getSandboxProcesses').mockResolvedValue(listing)
  const signal = spyOn(workspaceApi, 'signalSandboxProcess').mockResolvedValue(undefined)
  const stop = spyOn(workspaceApi, 'stopSandboxContainer').mockResolvedValue(undefined)
  spies.push(list, signal, stop)
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/s/settings' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const root = dom.createRoot()
  const settle = () =>
    dom.act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
  const button = (label: string) =>
    [...dom.window.document.querySelectorAll('button')].find(
      (node) => node.getAttribute('aria-label') === label || node.textContent === label
    )!
  try {
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={queryClient}>
          <SandboxProcesses target={{ kind: 'squad', squadId: 'squad-1' }} />
        </QueryClientProvider>
      )
    )
    // Sampling takes a second and command lines can carry secrets: nothing loads until asked.
    expect(list).not.toHaveBeenCalled()
    await dom.act(async () => button('Show processes').click())
    await settle()
    expect(list).toHaveBeenCalledWith('squad-1')

    const text = dom.window.document.body.textContent ?? ''
    expect(text).toContain('Overloaded:')
    expect(text).toContain('Load 22.7 on 4 CPUs')
    expect(text).toContain('bun node_modules/.bin/tsc -p apps/core --noEmit')
    expect(text).toContain('187%')
    expect(text).toContain('Runs the sandbox')
    expect(button('Stop process 754597')).toBeUndefined()

    // Stopping needs a confirming second click, then sends TERM.
    await dom.act(async () => button('Stop process 2838629').click())
    expect(signal).not.toHaveBeenCalled()
    await dom.act(async () => button('Stop process 2838629').click())
    await settle()
    expect(signal).toHaveBeenCalledWith('squad-1', 2838629, 'TERM')

    await dom.act(async () => button('Stop container tau-test-ebb213d9-postgres-1').click())
    await dom.act(async () => button('Stop container tau-test-ebb213d9-postgres-1').click())
    await settle()
    expect(stop).toHaveBeenCalledWith('squad-1', '5da43cf7deaa')
  } finally {
    await dom.cleanup()
    queryClient.clear()
  }
})
