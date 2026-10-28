import { afterEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SandboxProcesses as SandboxProcessesData } from '@ficus/shared'
import * as agentApi from '../../api/agents'
import * as workspaceApi from '../../api/workspace'
import { acquireDomHarness } from '../../test/domHarness'
import { formatAge, SandboxProcesses } from './SandboxProcesses'

// Today's incident: a detached full typecheck and a forgotten test database
// overloading the squad box, next to the sandbox server itself.
const listing: SandboxProcessesData = {
  pressure: { cpus: 4, load: [22.72, 31.86, 30.52], memTotalMb: 7941, memAvailableMb: 463 },
  processes: [
    {
      pid: 4201,
      ppid: 4200,
      cpuPercent: 187.4,
      memRssMb: 2116,
      ageSeconds: 9286,
      state: 'R',
      command: 'bun node_modules/.bin/tsc -p apps/core --noEmit',
      protected: false,
    },
    {
      pid: 4202,
      ppid: 4203,
      cpuPercent: 0.4,
      memRssMb: 123,
      ageSeconds: 136_000,
      state: 'S',
      command: '/opt/ficus/bin/bun /opt/ficus/server/server.js',
      protected: true,
    },
    ...(['Docker runtime', 'Box listener', 'Session bus'] as const).map((protectionReason, index) => ({
      pid: 4500 + index,
      ppid: 1,
      cpuPercent: 0,
      memRssMb: 5,
      ageSeconds: 900,
      state: 'S',
      command: 'protected runtime fixture',
      protected: true,
      protectionReason,
    })),
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
    expect(text).toContain('Host overloaded:')
    expect(text).toContain('CPU unavailable')
    expect(text).toContain('Load 22.7 on 4 CPUs')
    expect(text).toContain('bun node_modules/.bin/tsc -p apps/core --noEmit')
    expect(text).toContain('187%')
    expect(text).toContain('Runs the sandbox')
    expect(button('Stop process 4202')).toBeUndefined()
    for (const [i, label] of ['Docker runtime', 'Box listener', 'Session bus'].entries()) {
      expect(text).toContain(label)
      expect(button(`Stop process ${4500 + i}`)).toBeUndefined()
      expect(button(`Kill process ${4500 + i}`)).toBeUndefined()
    }

    // Stopping needs a confirming second click, then sends TERM.
    await dom.act(async () => button('Stop process 4201').click())
    expect(signal).not.toHaveBeenCalled()
    await dom.act(async () => button('Stop process 4201').click())
    await settle()
    expect(signal).toHaveBeenCalledWith('squad-1', 4201, 'TERM', expect.any(AbortSignal))

    await dom.act(async () => button('Stop container tau-test-ebb213d9-postgres-1').click())
    await dom.act(async () => button('Stop container tau-test-ebb213d9-postgres-1').click())
    await settle()
    expect(stop).toHaveBeenCalledWith('squad-1', '5da43cf7deaa', expect.any(AbortSignal))
  } finally {
    await dom.cleanup()
    queryClient.clear()
  }
})

async function controlsTest(
  run: (ui: {
    button: (label: string) => HTMLButtonElement | undefined
    confirm: (label: string) => Promise<void>
    settle: () => Promise<void>
    text: () => string
  }) => Promise<void>,
  agent = false
) {
  const processes = [
    ...listing.processes,
    { ...listing.processes[0]!, pid: 4301, command: '/usr/bin/containerd-shim-runc-v2 -id synthetic' },
    { ...listing.processes[0]!, pid: 4302, command: 'runc --root /tmp/synthetic exec synthetic' },
    { ...listing.processes[0]!, pid: 4303, command: 'bash -c echo containerd-shim-runc-v2' },
  ]
  const data = {
    ...listing,
    processes,
    containers: {
      available: true as const,
      containers: [
        ...(listing.containers.available ? listing.containers.containers : []),
        { id: 'synthetic-second', name: 'second', image: 'test', state: 'running', status: 'Up' },
      ],
    },
  }
  spies.push(spyOn(workspaceApi, 'getSandboxProcesses').mockResolvedValue(data))
  spies.push(spyOn(agentApi, 'getAgentSandboxProcesses').mockResolvedValue(data))
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
    ) as HTMLButtonElement | undefined
  try {
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={queryClient}>
          <SandboxProcesses
            target={agent ? { kind: 'agent', agentId: 'agent-1' } : { kind: 'squad', squadId: 'squad-1' }}
          />
        </QueryClientProvider>
      )
    )
    await dom.act(async () => button('Show processes')!.click())
    await settle()
    await run({
      button,
      settle,
      text: () => dom.window.document.body.textContent ?? '',
      confirm: async (label) => {
        await dom.act(async () => button(label)!.click())
        await dom.act(async () => button(label)!.click())
        await settle()
      },
    })
  } finally {
    await dom.cleanup()
    queryClient.clear()
  }
}

test('independent process and container rows remain available while other actions are pending', async () => {
  const signal = spyOn(workspaceApi, 'signalSandboxProcess').mockImplementation(() => new Promise(() => {}))
  const stop = spyOn(workspaceApi, 'stopSandboxContainer').mockImplementation(() => new Promise(() => {}))
  spies.push(signal, stop)
  await controlsTest(async ({ button, confirm }) => {
    await confirm('Stop process 4201')
    expect(button('Stop process 4201')!.disabled).toBe(true)
    expect(button('Kill process 4201')!.disabled).toBe(true)
    expect(button('Kill process 4301')!.disabled).toBe(false)
    await confirm('Kill process 4301')
    expect(signal.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ['squad-1', 4201, 'TERM'],
      ['squad-1', 4301, 'KILL'],
    ])
    await confirm('Stop container second')
    expect(button('Stop container second')!.disabled).toBe(true)
    expect(button('Stop container tau-test-ebb213d9-postgres-1')!.disabled).toBe(false)
    await confirm('Stop container tau-test-ebb213d9-postgres-1')
    expect(stop.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['squad-1', 'synthetic-second'],
      ['squad-1', '5da43cf7deaa'],
    ])
  })
})

test('offers confirmed Kill directly for shims and runc, not commands merely mentioning them', async () => {
  const signal = spyOn(agentApi, 'signalAgentSandboxProcess').mockResolvedValue(undefined)
  spies.push(signal)
  await controlsTest(async ({ button, confirm, text }) => {
    expect(!!button('Stop process 4301')).toBe(false)
    expect(!!button('Stop process 4302')).toBe(false)
    expect(button('Stop process 4303')).toBeDefined()
    expect(text()).toContain('Stop (TERM) is ineffective for containerd shims')
    expect(button('Kill process 4202')).toBeUndefined()
    await confirm('Kill process 4302')
    expect(signal).toHaveBeenCalledWith('agent-1', 4302, 'KILL', expect.any(AbortSignal))
  }, true)
})

test('failed actions recover only their own row and retry the same target', async () => {
  const signal = spyOn(workspaceApi, 'signalSandboxProcess')
    .mockRejectedValueOnce(new Error('Timed out. Refresh before retrying.'))
    .mockResolvedValue(undefined)
  spies.push(signal)
  await controlsTest(async ({ button, confirm, text }) => {
    await confirm('Stop process 4201')
    expect(text()).toContain('Timed out. Refresh before retrying.')
    expect(button('Stop process 4201')!.disabled).toBe(false)
    expect(button('Kill process 4301')!.disabled).toBe(false)
    await confirm('Stop process 4201')
    expect(signal).toHaveBeenCalledTimes(2)
    expect(text()).not.toContain('Timed out.')
  })
})

test('unmount cancels its in-flight control', async () => {
  let abortSignal: AbortSignal | undefined
  const signal = spyOn(workspaceApi, 'signalSandboxProcess').mockImplementation((_id, _pid, _signal, abort) => {
    abortSignal = abort
    return new Promise(() => {})
  })
  spies.push(signal)
  await controlsTest(async ({ confirm }) => {
    await confirm('Kill process 4301')
    expect(abortSignal?.aborted).toBe(false)
  })
  expect(abortSignal?.aborted).toBe(true)
})

test('a hung refresh cannot keep a completed row action disabled', async () => {
  const signal = spyOn(workspaceApi, 'signalSandboxProcess').mockResolvedValue(undefined)
  spies.push(signal)
  await controlsTest(async ({ button, confirm }) => {
    spies.push(spyOn(workspaceApi, 'getSandboxProcesses').mockImplementation(() => new Promise(() => {})))
    await confirm('Stop process 4201')
    expect(button('Refresh')?.disabled ?? button('Loading…')?.disabled).toBe(true)
    expect(button('Stop process 4201')!.disabled).toBe(false)
    expect(button('Kill process 4301')!.disabled).toBe(false)
  })
})

for (const kind of ['squad', 'agent'] as const) {
  test(`${kind} process header keeps its action compact across loading and refresh states`, async () => {
    let resolveListing!: (value: SandboxProcessesData) => void
    const pending = new Promise<SandboxProcessesData>((resolve) => {
      resolveListing = resolve
    })
    const list =
      kind === 'squad'
        ? spyOn(workspaceApi, 'getSandboxProcesses').mockReturnValue(pending)
        : spyOn(agentApi, 'getAgentSandboxProcesses').mockReturnValue(pending)
    spies.push(list)
    const dom = await acquireDomHarness({ url: 'http://localhost' })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const root = dom.createRoot()
    try {
      await dom.act(async () =>
        root.root.render(
          <QueryClientProvider client={queryClient}>
            <SandboxProcesses target={kind === 'squad' ? { kind, squadId: 's' } : { kind, agentId: 'a' }} />
          </QueryClientProvider>
        )
      )
      const button = dom.window.document.querySelector('button')!
      const header = button.parentElement!
      // DOM tests cannot measure flex layout; browser verification covers actual widths.
      expect(header.classList.contains('flex-wrap')).toBe(true)
      expect(header.firstElementChild!.classList.contains('min-w-0')).toBe(true)
      const expectCompactAction = (label: string) => {
        expect(button.textContent).toBe(label)
        expect(button.classList.contains('shrink-0')).toBe(true)
        expect(button.classList.contains('whitespace-nowrap')).toBe(true)
      }
      expectCompactAction('Show processes')
      expect(list).not.toHaveBeenCalled()
      await dom.act(async () => button.click())
      expectCompactAction('Loading…')
      expect(button.disabled).toBe(true)
      await dom.act(async () => {
        resolveListing(listing)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      })
      expectCompactAction('Refresh')
      expect(button.disabled).toBe(false)
    } finally {
      await dom.cleanup()
      queryClient.clear()
    }
  })
}
