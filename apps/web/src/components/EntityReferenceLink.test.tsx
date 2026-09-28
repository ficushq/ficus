import { expect, test, spyOn } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import { queries } from '../queryOptions'
import { EntityReferenceLink } from './EntityReferenceLink'
import type { EntityReference } from '../lib/entityReference'

const agentId = 'abc12345-1234-1234-1234-123456789012'
const workId = 'def12345-1234-1234-1234-123456789012'

async function fixture(reference: EntityReference, onOpenAgent?: (agent: import('@ficus/shared').Agent) => void) {
  // Load lazy modules before installing the DOM's constructor globals.
  await Promise.all([import('./EntityReferencePreview'), import('./EntityReferenceModal')])
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  const agent = {
    id: agentId,
    squadId: 'squad',
    agentTypeId: 'engineer',
    status: 'active',
    metadata: { purpose: 'Build the release', name: 'Robin' },
  }
  const work = {
    id: workId,
    number: 42,
    squadId: 'squad',
    title: 'Ship the release',
    status: 'active',
    derivedState: 'in_progress',
    priority: 'high',
    assigneeAgentId: agentId,
    metadata: {
      tracked: [
        {
          integration: 'github',
          repository: 'example/product',
          kind: 'pull_request',
          number: 123,
          delivery: true,
        },
      ],
    },
  }
  for (const [queryKey, value] of [
    [queries.agents.detail(agentId).queryKey, agent],
    [queries.agents.detail('abc12345').queryKey, agent],
    [queries.squads.workStreamDetail('42').queryKey, work],
    [queries.squads.workStreamDetail(workId).queryKey, work],
    [queries.squads.basic('squad').queryKey, { id: 'squad', name: 'Product' }],
    [queries.squads.agents('squad').queryKey, [agent]],
    [queries.squads.workStreamMetrics(workId).queryKey, {}],
    [queries.workStreamSubscription.detail(workId).queryKey, {}],
    [queries.workflows.run(workId).queryKey, {}],
    [queries.agentTypes.list().queryKey, [{ id: 'engineer', name: 'Engineer' }]],
  ] as const)
    client.setQueryData(queryKey, value)

  // Own just the hover deadlines; React/query scheduling keeps its normal clock.
  let serial = 10000
  const deadlines = new Map<number, { callback: () => void; ms: number }>()
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms: number,
    ...args: unknown[]
  ) => {
    if (ms === 250 || ms === 150) {
      deadlines.set(++serial, { callback, ms })
      return serial
    }
    return originalSet(callback, ms, ...args)
  }) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
    if (!deadlines.delete(Number(id))) originalClear(id)
  }) as typeof clearTimeout)
  const advance = (ms: number) =>
    dom.act(async () => {
      for (const [id, deadline] of [...deadlines])
        if (deadline.ms <= ms) {
          deadlines.delete(id)
          deadline.callback()
        }
    })
  function Location() {
    const location = useLocation()
    return (
      <output>
        {location.pathname}
        {location.search}
      </output>
    )
  }
  const { container, root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <EntityReferenceLink reference={reference} onOpenAgent={onOpenAgent}>
            Reference
          </EntityReferenceLink>
          <EntityReferenceLink reference={{ kind: 'ws', id: '42' }}>Another reference</EntityReferenceLink>
          <Location />
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
  const button = container.querySelector('button')!
  const hover = () =>
    dom.act(async () => button.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })))
  const tooltip = () => dom.window.document.querySelector<HTMLElement>('[role="dialog"]')
  return {
    dom,
    client,
    agent,
    work,
    container,
    button,
    hover,
    tooltip,
    advance,
    cleanup: async () => {
      try {
        await dom.cleanup()
        client.clear()
      } finally {
        timer.mockRestore()
        clear.mockRestore()
      }
    },
  }
}

test('work-number hover shows status, priority and assigned agent, then follows canonical cache updates', async () => {
  const f = await fixture({ kind: 'ws', id: '42' })
  try {
    await f.hover()
    expect(f.tooltip()).toBeNull()
    await f.advance(250)
    expect(f.tooltip()?.textContent).toContain('#42 · Ship the release')
    expect(f.tooltip()?.textContent).not.toContain('Product')
    expect(f.tooltip()?.textContent).toContain('In Progress')
    expect(f.tooltip()?.textContent).toContain('High priority')
    expect(f.tooltip()?.textContent).toContain('Engineer')
    expect(f.button.getAttribute('aria-controls')).toBe(f.tooltip()?.id)
    await f.dom.act(async () => {
      f.client.setQueryData(queries.squads.workStreamDetail(workId).queryKey, {
        ...f.work,
        title: 'Release shipped',
        status: 'done',
        derivedState: 'done',
      })
      // Flush React Query's notification queue deterministically.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(f.tooltip()?.textContent).toContain('#42 · Release shipped')
    expect(f.tooltip()?.textContent).toContain('Done')
  } finally {
    await f.cleanup()
  }
})

test('hover card stays open while moving onto it and Escape dismisses without opening the reference', async () => {
  const f = await fixture({ kind: 'agent', id: 'abc12345' })
  try {
    await f.hover()
    await f.advance(250)
    expect(f.tooltip()?.textContent).toContain('Engineer')
    expect(f.tooltip()?.textContent).toContain('Working')
    await f.dom.act(async () => {
      f.button.dispatchEvent(new f.dom.window.MouseEvent('mouseout', { bubbles: true }))
      f.tooltip()!.dispatchEvent(new f.dom.window.MouseEvent('mouseover', { bubbles: true }))
    })
    await f.advance(150)
    expect(f.tooltip()).not.toBeNull()
    await f.dom.act(async () =>
      f.button.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(f.tooltip()).toBeNull()
    expect(f.container.querySelector('output')?.textContent).toBe('/')
    expect(f.button.hasAttribute('aria-controls')).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test('leaving before the hover deadline cancels the preview; clicking still opens the canonical agent chat', async () => {
  const f = await fixture({ kind: 'agent', id: 'abc12345' })
  try {
    await f.hover()
    await f.dom.act(async () => f.button.dispatchEvent(new f.dom.window.MouseEvent('mouseout', { bubbles: true })))
    await f.advance(250)
    expect(f.tooltip()).toBeNull()
    await f.hover()
    await f.advance(250)
    await f.dom.act(async () => f.button.click())
    expect(f.tooltip()).toBeNull()
    expect(f.container.querySelector('output')?.textContent).toBe(`/squads/squad/agents?agent=${agentId}`)
  } finally {
    await f.cleanup()
  }
})

test('keyboard focus shows an agent preview and blur dismisses it', async () => {
  const f = await fixture({ kind: 'agent', id: agentId })
  const matches = spyOn(f.button, 'matches').mockReturnValue(true)
  try {
    await f.dom.act(async () => f.button.focus())
    expect(f.tooltip()?.textContent).toContain('Build the release')
    expect(f.tooltip()?.textContent).toContain('Robin')
    await f.dom.act(async () => f.button.blur())
    await f.advance(150)
    expect(f.tooltip()).toBeNull()
  } finally {
    matches.mockRestore()
    await f.cleanup()
  }
})

test('work preview offers an agent chat and a PR in a new tab, with keyboard access to both', async () => {
  const f = await fixture({ kind: 'ws', id: '42' })
  try {
    await f.hover()
    await f.advance(250)
    const card = f.tooltip()!
    const links = card.querySelectorAll<HTMLAnchorElement>('a')
    expect(links).toHaveLength(2)
    expect(links[0]!.textContent).toBe('Engineer')
    expect(links[0]!.getAttribute('href')).toBe(`/squads/squad/agents?agent=${agentId}`)
    expect(links[1]!.getAttribute('href')).toBe('https://github.com/example/product/pull/123')
    expect(links[1]!.target).toBe('_blank')
    expect(links[1]!.rel).toContain('noopener')
    await f.dom.act(async () =>
      f.button.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    )
    expect(f.dom.window.document.activeElement).toBe(links[0])
    await f.dom.act(async () =>
      links[0]!.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
      )
    )
    expect(f.dom.window.document.activeElement).toBe(f.button)
    await f.dom.act(async () => links[0]!.click())
    expect(f.tooltip()).toBeNull()
    expect(f.container.querySelector('output')?.textContent).toBe(`/squads/squad/agents?agent=${agentId}`)
  } finally {
    await f.cleanup()
  }
})

test('work preview links every tracked delivery pull request', async () => {
  const f = await fixture({ kind: 'ws', id: '42' })
  try {
    const multiPullRequestWork = {
      ...f.work,
      metadata: {
        tracked: [
          { integration: 'github', repository: 'example/product', kind: 'pull_request', number: 200, delivery: true },
          { integration: 'github', repository: 'example/product', kind: 'pull_request', number: 201, delivery: true },
        ],
      },
    }
    await f.dom.act(async () => {
      f.client.setQueryData(queries.squads.workStreamDetail(workId).queryKey, multiPullRequestWork)
      f.client.setQueryData(queries.squads.workStreamDetail('42').queryKey, multiPullRequestWork)
      // Flush React Query's notification queue deterministically.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await f.hover()
    await f.advance(250)
    const pullRequestLinks = [...f.tooltip()!.querySelectorAll<HTMLAnchorElement>('a')].filter((link) =>
      link.getAttribute('href')?.includes('/pull/')
    )
    expect(pullRequestLinks.map((link) => link.getAttribute('href'))).toEqual([
      'https://github.com/example/product/pull/200',
      'https://github.com/example/product/pull/201',
    ])
    expect(pullRequestLinks.map((link) => link.textContent?.replace(' (opens in a new tab)', ''))).toEqual([
      'PR #200↗',
      'PR #201↗',
    ])
  } finally {
    await f.cleanup()
  }
})

test('Escape inside a quick link returns focus to the original reference', async () => {
  const f = await fixture({ kind: 'agent', id: agentId })
  try {
    await f.hover()
    await f.advance(250)
    const link = f.tooltip()!.querySelector('a')!
    await f.dom.act(async () => {
      link.focus()
      link.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(f.tooltip()).toBeNull()
    expect(f.dom.window.document.activeElement).toBe(f.button)
  } finally {
    await f.cleanup()
  }
})

test('preview clamps to the viewport and moves above references near the bottom', async () => {
  const f = await fixture({ kind: 'agent', id: agentId })
  const rect = spyOn(f.button, 'getBoundingClientRect').mockReturnValue({
    left: 950,
    right: 1000,
    top: 740,
    bottom: 764,
    width: 50,
    height: 24,
  } as DOMRect)
  try {
    await f.hover()
    await f.advance(250)
    const card = f.tooltip()!
    const cardRect = spyOn(card, 'getBoundingClientRect').mockReturnValue({ width: 320, height: 180 } as DOMRect)
    try {
      await f.dom.act(async () => f.dom.window.dispatchEvent(new f.dom.window.Event('resize')))
      expect(Number.parseFloat(card.style.left)).toBeLessThanOrEqual(f.dom.window.innerWidth - 328)
      expect(Number.parseFloat(card.style.top)).toBe(552)
    } finally {
      cardRect.mockRestore()
    }
  } finally {
    rect.mockRestore()
    await f.cleanup()
  }
})

test('opening another reference replaces the existing preview', async () => {
  const f = await fixture({ kind: 'agent', id: agentId })
  try {
    await f.hover()
    await f.advance(250)
    expect(f.tooltip()?.getAttribute('aria-label')).toBe('Agent preview')
    await f.dom.act(async () =>
      f.container
        .querySelectorAll('button')[1]!
        .dispatchEvent(new f.dom.window.MouseEvent('mouseover', { bubbles: true }))
    )
    await f.advance(250)
    expect(f.dom.window.document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(f.tooltip()?.getAttribute('aria-label')).toBe('Work stream preview')
    expect(f.button.getAttribute('aria-expanded')).toBe('false')
  } finally {
    await f.cleanup()
  }
})

for (const reference of [
  { kind: 'agent', id: 'abc12345' },
  { kind: 'ws', id: '42' },
] as const) {
  test(`Activity override retains context for ${reference.kind} preview agent quick links`, async () => {
    const opened: string[] = []
    const f = await fixture(reference, (agent) => opened.push(agent.id))
    try {
      await f.hover()
      await f.advance(250)
      const link = f.tooltip()!.querySelector<HTMLAnchorElement>('a[href*="agents"]')!
      await f.dom.act(async () => link.click())
      expect(opened).toEqual([agentId])
      expect(f.container.querySelector('output')?.textContent).toBe('/')
      expect(f.tooltip()).toBeNull()
    } finally {
      await f.cleanup()
    }
  })
}
