import { expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SandboxStatus } from '../../api/workspace'
import { queryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import { SandboxStatusIndicator } from './SandboxStatusIndicator'

const pressure = { cpus: 8, load: [28, 20, 12] as [number, number, number], memTotalMb: 16000, memAvailableMb: 4000 }
const healthy: SandboxStatus = {
  status: 'running',
  runtime: 'vm',
  chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
}
async function withIndicator(status: SandboxStatus, check: (ui: Awaited<ReturnType<typeof mount>>) => Promise<void>) {
  const ui = await mount(status)
  try {
    await check(ui)
  } finally {
    ui.client.clear()
    await ui.dom.cleanup()
  }
}

async function mount(status: SandboxStatus) {
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/squad-one/home' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.sandbox.status('squad-one'), status)
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/squads/squad-one/home']}>
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="/squads/:squadId/home" element={<SandboxStatusIndicator squadId="squad-one" />} />
            <Route path="/squads/:squadId/settings" element={<p>Squad workspace settings</p>} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>
    )
  )
  const doc = dom.window.document
  const warning = () => doc.querySelector<HTMLButtonElement>('button[aria-label="Sandbox warning"]')
  const card = () => doc.querySelector<HTMLElement>('[role="dialog"][data-state="open"]')
  const key = (key: string) =>
    dom.act(async () => {
      doc.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      )
    })
  return { dom, client, doc, warning, card, key }
}

test('header exposes overload diagnostics to keyboard and screen readers and links to this squad Processes', async () => {
  await withIndicator({ ...healthy, status: 'starting', pressure }, async ({ dom, doc, warning, card, key }) => {
    const trigger = warning()!
    expect(trigger).not.toBeNull()
    expect(trigger.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    const description = doc.getElementById(trigger.getAttribute('aria-describedby')!)!
    expect(description.textContent).toContain('Host overloaded: Load 28.0 on 8 CPUs')
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await dom.act(async () => trigger.focus())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(card()!.id).toBe(trigger.getAttribute('aria-controls')!)
    expect(card()!.textContent).toContain('Host overloaded: Load 28.0 on 8 CPUs')
    expect(card()!.textContent).toContain('free of')
    await key('Tab')
    const link = card()!.querySelector('a')!
    expect(doc.activeElement).toBe(link)
    expect(link.textContent).toBe('Open Processes')
    expect(link.getAttribute('href')).toBe('/squads/squad-one/settings?section=workspace&setting=sandbox-processes')
    await key('Escape')
    expect(card()).toBeNull()
    expect(doc.activeElement).toBe(trigger)
    await dom.act(async () => trigger.click())
    await dom.act(async () => card()!.querySelector('a')!.click())
    expect(doc.body.textContent).toContain('Squad workspace settings')
  })
})

test.each([
  [
    'legacy Docker failure',
    { ...healthy, status: 'starting', reason: 'Docker did not answer within 15s' },
    'Docker did not answer within 15s',
  ],
  [
    'runtime degradation',
    {
      ...healthy,
      runtimeHealth: { status: 'degraded', reason: 'Detached runc exec has been stuck for at least 300s' },
    },
    'Detached runc exec has been stuck for at least 300s',
  ],
  [
    'degraded fallback',
    { ...healthy, readiness: 'ready_degraded', reason: 'Docker did not answer within 2s' },
    'Docker did not answer within 2s',
  ],
] satisfies Array<[string, SandboxStatus, string]>)(
  '%s retains the diagnostic instead of just Starting/Running',
  async (_, status, reason) => {
    await withIndicator(status, async ({ dom, warning, card }) => {
      expect(warning()).not.toBeNull()
      await dom.act(async () => warning()!.focus())
      expect(card()!.textContent).toContain(reason)
    })
  }
)

test('hover warning preserves runtime and legacy reasons alongside pressure even during toolchain provisioning', async () => {
  await withIndicator(
    {
      ...healthy,
      pressure,
      reason: 'Docker did not answer within 15s',
      runtimeHealth: { status: 'degraded', reason: 'Detached runc exec has been stuck for at least 300s' },
      toolchain: { status: 'installing', desiredFingerprint: 'test' },
    },
    async ({ dom, warning, card }) => {
      expect(warning()).not.toBeNull()
      await dom.act(async () => {
        warning()!.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
      expect(card()!.textContent).toContain('Host overloaded: Load 28.0 on 8 CPUs')
      expect(card()!.textContent).toContain('Docker did not answer within 15s')
      expect(card()!.textContent).toContain('Detached runc exec has been stuck for at least 300s')
    }
  )
})

test.each([
  ['healthy legacy', healthy, 'Running'],
  [
    'healthy current',
    { ...healthy, pressure: { ...pressure, load: [2, 2, 2] }, runtimeHealth: { status: 'ready' } },
    'Running',
  ],
  ['normal starting', { status: 'starting', runtime: 'vm', reason: 'ContainerCreating' }, 'Starting'],
  ['normal running reason', { ...healthy, reason: 'Running' }, 'Running'],
  ['legacy non-VM', { status: 'starting', runtime: 'docker', reason: 'Scheduling' }, 'Sandbox starting'],
] satisfies Array<[string, SandboxStatus, string]>)('%s does not acquire a false warning', async (_, status, label) => {
  await withIndicator(status, async ({ doc, warning }) => {
    expect(Boolean(warning())).toBe(false)
    expect(doc.body.textContent).toContain(label)
  })
})

// These are the normal VM getSandboxStatus producer reasons, not just K8s phase tokens.
const vmStartupReasons = [
  'sandbox setup has not been reconciled',
  'required sandbox assets are not ready',
  'box is provisioning or its health probe has not yet passed',
]

test.each(vmStartupReasons)('normal VM startup does not warn for "%s"', async (reason) => {
  await withIndicator({ ...healthy, status: 'starting', reason }, async ({ doc, warning }) => {
    expect(Boolean(warning())).toBe(false)
    expect(doc.body.textContent).toContain('Starting')
  })
})

test('idle setup-pending VM shows deferred assets without a health warning', async () => {
  await withIndicator(
    {
      ...healthy,
      status: 'starting',
      reason: 'required sandbox assets are not ready',
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'idle' },
      readiness: 'pending',
      assetsRefreshPending: true,
      toolchain: { status: 'pending', desiredFingerprint: 'test' },
    },
    async ({ doc, warning }) => {
      expect(Boolean(warning())).toBe(false)
      expect(doc.body.textContent).toContain('Idle')
      expect(doc.body.textContent).toContain('assets refresh on next start')
      expect(doc.body.textContent).not.toContain('Starting')
    }
  )
})

test.each(vmStartupReasons)('overloaded VM retains normal startup context: "%s"', async (reason) => {
  await withIndicator({ ...healthy, status: 'starting', reason, pressure }, async ({ dom, warning, card }) => {
    expect(warning()).not.toBeNull()
    await dom.act(async () => warning()!.focus())
    expect(card()!.textContent).toContain('Host overloaded: Load 28.0 on 8 CPUs')
    expect(card()!.textContent).toContain(reason)
  })
})

test('explicit runtime degradation is not masked by an ordinary startup reason', async () => {
  await withIndicator(
    {
      ...healthy,
      status: 'starting',
      reason: 'required sandbox assets are not ready',
      runtimeHealth: { status: 'degraded', reason: 'Docker did not answer within 2s' },
    },
    async ({ dom, warning, card }) => {
      expect(warning()).not.toBeNull()
      await dom.act(async () => warning()!.focus())
      expect(card()!.textContent).toContain('Docker did not answer within 2s')
      expect(card()!.textContent).toContain('required sandbox assets are not ready')
    }
  )
})

test('unknown genuine failure reasons are still surfaced on older starting payloads', async () => {
  await withIndicator(
    { ...healthy, status: 'starting', reason: 'Executor failed to attach: connection refused' },
    async ({ dom, warning, card }) => {
      expect(warning()).not.toBeNull()
      await dom.act(async () => warning()!.focus())
      expect(card()!.textContent).toContain('Executor failed to attach: connection refused')
    }
  )
})

test('a reasonless runtime degradation still has useful warning detail', async () => {
  await withIndicator({ ...healthy, runtimeHealth: { status: 'degraded' } }, async ({ dom, warning, card }) => {
    expect(warning()).not.toBeNull()
    await dom.act(async () => warning()!.click())
    expect(card()!.textContent).toContain('Sandbox is degraded')
    expect(card()!.querySelector('a')).not.toBeNull()
  })
})

test.each([
  ['overload', { pressure }, 'Host overloaded: Load 28.0 on 8 CPUs'],
  [
    'Docker degradation',
    { runtimeHealth: { status: 'degraded', reason: 'Docker did not answer within 2s' } },
    'Docker did not answer within 2s',
  ],
] satisfies Array<[string, Partial<SandboxStatus>, string]>)(
  'idle refresh does not hide %s warnings',
  async (_, diagnostics, message) => {
    await withIndicator(
      {
        ...healthy,
        status: 'starting',
        readiness: 'pending',
        assetsRefreshPending: true,
        reason: 'required sandbox assets are not ready',
        chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'idle' },
        ...diagnostics,
      },
      async ({ dom, doc, warning, card }) => {
        expect(doc.body.textContent).toContain('Idle')
        expect(doc.body.textContent).toContain('assets refresh on next start')
        expect(warning()).not.toBeNull()
        await dom.act(async () => warning()!.focus())
        expect(card()!.textContent).toContain(message)
        expect(card()!.querySelector('a')!.getAttribute('href')).toContain('setting=sandbox-processes')
      }
    )
  }
)

test('header attributes local reclaim pressure even when the host load is low', async () => {
  const local = {
    ...pressure,
    load: [1, 1, 1] as [number, number, number],
    box: {
      cpuPercent: 12,
      sampleMs: 1000,
      cpuPressureSome: { avg10: 0, avg60: 0, avg300: 0 },
      memoryPressureSome: { avg10: 20, avg60: 10, avg300: 5 },
    },
  }
  await withIndicator({ ...healthy, pressure: local }, async ({ doc, warning }) => {
    expect(warning()).not.toBeNull()
    const text = doc.getElementById(warning()!.getAttribute('aria-describedby')!)!.textContent
    expect(text).toContain('This sandbox overloaded: Load 1.0 on 8 CPUs')
    expect(text).toContain('12.0% CPU')
    expect(text).toContain('Memory PSI some 20.0/10.0/5.0%')
  })
})

test('header shows startup concurrency alongside separately attributed host pressure', async () => {
  await withIndicator(
    {
      ...healthy,
      pressure,
      hostCapacity: {
        allowed: true,
        reason: 'already-accounted',
        cpus: 8,
        activeBoxes: 15,
        startingBoxes: 2,
        startupLimit: 2,
      },
    },
    async ({ doc }) => {
      expect(doc.body.textContent).toContain('Host load 3.5×')
      expect(doc.body.textContent).toContain('Starting 2/2 boxes')
      expect(doc.body.textContent).not.toContain('quota 12/12 CPUs')
      expect(doc.querySelector('[title*="Squads share host CPUs"]')?.getAttribute('title')).toContain(
        'running boxes do not occupy startup slots'
      )
    }
  )
})
