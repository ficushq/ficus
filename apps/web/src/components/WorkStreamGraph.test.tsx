import { acquireDomHarness } from '../test/domHarness'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Root } from 'react-dom/client'
import type { WorkStream } from '@ficus/shared'
import { WorkStreamGraph } from './WorkStreamGraph'

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

function stream(id: string, dependsOn: string[] = []): WorkStream {
  return {
    id,
    squadId: 'squad-1',
    title: `Stream ${id}`,
    description: '',
    status: 'queued',
    priority: 'normal',
    effectivePriority: 'normal',
    completionMode: 'pr-merge',
    assigneeAgentId: null,
    ownerAgentId: null,
    creatorAgentId: null,
    requestingUserId: null,
    agentIds: [],
    dependsOn,
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    createdAt: new Date('2026-08-14T12:00:00.000Z'),
    updatedAt: new Date('2026-08-14T12:00:00.000Z'),
  }
}

let windowValue: Awaited<ReturnType<typeof acquireDomHarness>>['window']
let container: HTMLElement
let root: Root

beforeEach(async () => {
  domHarness = await acquireDomHarness({ url: 'http://localhost/' })
  windowValue = domHarness.window
  ;({ container, root } = domHarness.createRoot())
})

describe('WorkStreamGraph', () => {
  test('renders nodes and blocker-to-dependent edges', async () => {
    await domHarness!.act(async () =>
      root.render(
        <WorkStreamGraph
          workStreams={[stream('a'), stream('b', ['a'])]}
          agentMap={new Map()}
          onSelectWorkStream={() => undefined}
        />
      )
    )

    expect(container.querySelectorAll('[role="button"]')).toHaveLength(2)
    const edge = container.querySelector('[data-from="a"][data-to="b"]')
    expect(edge).not.toBeNull()
  })

  test('opens the selected stream when a node is clicked', async () => {
    const selected: string[] = []
    await domHarness!.act(async () =>
      root.render(
        <WorkStreamGraph
          workStreams={[stream('a')]}
          agentMap={new Map()}
          onSelectWorkStream={(id) => selected.push(id)}
        />
      )
    )

    await domHarness!.act(async () => {
      container
        .querySelector<SVGGElement>('[role="button"]')!
        .dispatchEvent(new windowValue.MouseEvent('click', { bubbles: true }))
    })
    expect(selected).toEqual(['a'])
  })

  test('shows a visible focus treatment when a node receives keyboard focus', async () => {
    await domHarness!.act(async () =>
      root.render(
        <WorkStreamGraph workStreams={[stream('a')]} agentMap={new Map()} onSelectWorkStream={() => undefined} />
      )
    )
    const node = container.querySelector<SVGGElement>('[role="button"]')!
    node.focus()

    expect(document.activeElement).toBe(node)
    expect(node.getAttribute('class')).toContain('focus-visible:outline-none')
    expect(node.querySelector('div')?.className).toContain('group-focus-visible:ring-2')
  })

  test('shows an independent-stream hint and boosted treatment', async () => {
    const boosted = {
      ...stream('a'),
      priority: 'low' as const,
      effectivePriority: 'high' as const,
      effectivePriorityVia: 'Stream b',
    }
    await domHarness!.act(async () =>
      root.render(<WorkStreamGraph workStreams={[boosted]} agentMap={new Map()} onSelectWorkStream={() => undefined} />)
    )

    expect(container.textContent).toContain('No dependencies — streams run independently.')
    expect(container.textContent).toContain('↑ high')
    const effectiveBadge = container.querySelector<HTMLElement>('[title="low → high"]')
    expect(effectiveBadge?.className).toContain('bg-status-external-wait-badge-surface')
    expect(effectiveBadge?.className).not.toContain('bg-status-neutral-badge-surface')
    expect(container.querySelector('.ring-2')).not.toBeNull()
  })
})

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})

test('delivery action and paused states retain truthful visible labels', async () => {
  await domHarness!.act(async () =>
    root.render(
      <WorkStreamGraph
        workStreams={[
          { ...stream('merge'), status: 'active', derivedState: 'idle', openWaits: [], delivery: { kind: 'merge' } },
          { ...stream('ci'), status: 'active', derivedState: 'idle', openWaits: [], delivery: { kind: 'external' } },
          {
            ...stream('paused'),
            pause: { pausedAt: '2026-09-21T00:00:00Z' } as WorkStream['pause'],
            derivedState: 'in_review',
          },
        ]}
        agentMap={new Map()}
        onSelectWorkStream={() => undefined}
      />
    )
  )
  expect(container.textContent).toContain('Merge Pull Request')
  expect(container.textContent).toContain('Awaiting Code Host')
  expect(container.textContent).toContain('Paused')
  expect(container.querySelector('[aria-label*="Stream merge, Merge Pull Request"]')).not.toBeNull()
})
