import { expect, test } from 'bun:test'
import { useState } from 'react'
import { createBlankWorkflow, createWorkflowRun, workflowPresetSchema, workflowDefinitionSchema } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { WorkflowGraph } from './WorkflowGraph'
test('flow preview exposes step instructions, outcome routing, and paused status without claiming work is active', async () => {
  const definition = createBlankWorkflow()
  const dom = await acquireDomHarness({ url: 'http://localhost/flow-preview' })
  const root = dom.createRoot()
  try {
    await dom.act(async () =>
      root.root.render(<WorkflowGraph definition={definition} run={createWorkflowRun(definition)} paused />)
    )
    const button = dom.window.document.querySelector('button[aria-label="execute: Paused"]')!
    expect(button).not.toBeNull()
    const subtitle = button.querySelector('[data-flow-participant]')!
    expect(subtitle.textContent).toBe('worker')
    expect(subtitle.classList.contains('pl-6')).toBe(true)
    await dom.act(async () => (button as HTMLButtonElement).click())
    expect(dom.window.document.body.textContent).toContain(definition.steps[0]!.instructions)
    expect(dom.window.document.body.textContent).toContain('completed → finish')
    expect(dom.window.document.querySelector('svg path[marker-end]')).not.toBeNull()
  } finally {
    await dom.cleanup()
  }
})

test('inline preview connects parallel branches directly without a fork card or toolbar divider', async () => {
  const definition = workflowPresetSchema.parse(
    Bun.YAML.parse(await Bun.file(new URL('../test/fixtures/parallel-flow.yaml', import.meta.url)).text())
  ).definition
  const dom = await acquireDomHarness({ url: 'http://localhost/parallel-preview' })
  const root = dom.createRoot()
  try {
    await dom.act(async () => root.root.render(<WorkflowGraph definition={definition} />))
    expect(document.body.textContent).not.toContain('Run in parallel')
    expect(document.querySelector('[data-flow-kind="fork"]')).toBeNull()
    expect(document.querySelectorAll('[data-flow-edge="build:completed"]')).toHaveLength(2)
    expect(document.querySelector('[aria-label="Flow controls"] .border-t')).toBeNull()
  } finally {
    await dom.cleanup()
  }
})

test('compact endpoint cards keep their handles and arrows on the card boundary', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/compact-endpoints' })
  const root = dom.createRoot()
  try {
    await dom.act(async () =>
      root.root.render(<WorkflowGraph definition={createBlankWorkflow()} onConnect={() => {}} />)
    )
    const start = document.querySelector<HTMLButtonElement>('[data-flow-kind="start"]')!
    const finish = document.querySelector<HTMLButtonElement>('[data-flow-kind="completion"]')!
    const worker = document.querySelector<HTMLButtonElement>('[data-flow-kind="agent"]')!
    for (const endpoint of [start, finish]) {
      expect(parseFloat(endpoint.style.width)).toBeLessThan(parseFloat(worker.style.width))
      expect(parseFloat(endpoint.style.height)).toBeLessThan(parseFloat(worker.style.height))
    }
    const startHandle = document.querySelector<HTMLButtonElement>('[aria-label="Connect Start"]')!
    expect(
      parseFloat(startHandle.parentElement!.style.left) + parseFloat(startHandle.parentElement!.style.width) - 10
    ).toBe(parseFloat(start.style.left) + parseFloat(start.style.width))
    const startPath = document
      .querySelector('[data-flow-edge="$start:starts"] path[marker-end]')!
      .getAttribute('d')!
      .split(' ')
    expect(Number(startPath[1])).toBe(parseFloat(start.style.left) + parseFloat(start.style.width))
    const finishHandle = document.querySelector<HTMLButtonElement>('[aria-label="Connect to Finish"]')!
    expect(parseFloat(finishHandle.style.left) + 10).toBe(parseFloat(finish.style.left))
    const finishPath = document
      .querySelector('[data-flow-edge="execute:completed"] path[marker-end]')!
      .getAttribute('d')!
      .split(' ')
    expect(Number(finishPath.at(-2))).toBe(parseFloat(finish.style.left))
  } finally {
    await dom.cleanup()
  }
})

test('a scoped wait marks only its active branch as waiting', async () => {
  const definition = createBlankWorkflow()
  const run = createWorkflowRun(definition)
  const dom = await acquireDomHarness({ url: 'http://localhost/flow-wait' })
  const root = dom.createRoot()
  try {
    const wait = { flowAttemptId: 99 } as import('@ficus/shared').WorkStreamWait
    await dom.act(async () => root.root.render(<WorkflowGraph definition={definition} run={run} openWaits={[wait]} />))
    expect(dom.window.document.querySelector('button[aria-label="execute: Active"]')).not.toBeNull()
    await dom.act(async () =>
      root.root.render(
        <WorkflowGraph
          definition={definition}
          run={run}
          openWaits={[{ ...wait, flowAttemptId: run.activeAttemptId }]}
        />
      )
    )
    expect(dom.window.document.querySelector('button[aria-label="execute: Waiting for input"]')).not.toBeNull()
  } finally {
    await dom.cleanup()
  }
})

test('integration nodes explain bindings and retained events without implying step advancement', async () => {
  const definition = createBlankWorkflow()
  definition.subscriptions = [
    {
      id: 'issue-updates',
      source: { integration: 'github', output: 'issue.updated', version: 1 },
      match: { repository: { streamMetadata: 'github.repo' }, 'issue.number': { streamMetadata: 'github.issue' } },
      deliver: { to: { participant: 'worker' }, whenInactive: 'retain' },
    },
  ]
  const dom = await acquireDomHarness({ url: 'http://localhost/flow-subscriptions' })
  const root = dom.createRoot()
  try {
    await dom.act(async () =>
      root.root.render(<WorkflowGraph definition={definition} run={createWorkflowRun(definition)} metadata={{}} />)
    )
    const node = dom.window.document.querySelector(
      'button[aria-label="github · issue-updates: Unbound resource"]'
    ) as HTMLButtonElement
    expect(node).not.toBeNull()
    expect(dom.window.document.querySelector('path[stroke-dasharray="2 6"]')).not.toBeNull()
    await dom.act(async () => node.click())
    expect(dom.window.document.body.textContent).toContain('metadata.github.issue')
    expect(dom.window.document.body.textContent).toContain('Events do not advance steps.')
    expect(dom.window.document.body.textContent).toContain('When inactive: retain')
  } finally {
    await dom.cleanup()
  }
})

test('canvas supports pointer dragging, drawing a connection, click-to-connect, and Escape cancellation', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/flow-canvas' })
  const root = dom.createRoot()
  const connected: unknown[][] = []
  const originalHitTest = document.elementFromPoint
  try {
    await dom.act(async () =>
      root.root.render(
        <WorkflowGraph
          definition={createBlankWorkflow()}
          onSelect={() => {}}
          onConnect={(...args) => connected.push(args)}
        />
      )
    )
    const card = document.querySelector<HTMLButtonElement>('[data-flow-target="execute"]')!
    const initial = parseFloat(card.style.left)
    const pointer = async (target: Element, type: string, x: number, y: number) =>
      dom.act(async () => {
        target.dispatchEvent(
          new dom.window.PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y })
        )
      })
    await pointer(card, 'pointerdown', 100, 100)
    await pointer(card, 'pointermove', 180, 140)
    await pointer(card, 'pointerup', 180, 140)
    expect(parseFloat(card.style.left)).toBeCloseTo(initial + 100)
    const output = document.querySelector<HTMLButtonElement>('[aria-label="Connect execute completed"]')!
    const input = document.querySelector<HTMLButtonElement>('[aria-label="Connect to Finish"]')!
    const finishCard = document.querySelector<HTMLButtonElement>('[data-flow-kind="completion"]')!
    document.elementFromPoint = () => finishCard
    await pointer(output, 'pointerdown', 200, 100)
    await pointer(output, 'pointermove', 400, 200)
    expect(finishCard.dataset.flowDropTarget).toBe('true')
    expect(input.classList.contains('ring-2')).toBe(true)
    const end = document.querySelector('[data-flow-wire]')!.getAttribute('d')!.split(' ').slice(-2).map(Number)
    expect(end).toEqual([parseFloat(input.style.left) + 10, parseFloat(input.style.top) + 10])
    document.elementFromPoint = () => null
    await pointer(output, 'pointermove', 420, 220)
    expect(document.querySelector('[data-flow-drop-target]')).toBeNull()
    document.elementFromPoint = () => card
    await pointer(output, 'pointermove', 200, 100)
    expect(document.querySelector('[data-flow-drop-target]')).toBeNull() // Self-connections are not valid targets.
    document.elementFromPoint = () => finishCard
    await pointer(output, 'pointermove', 400, 200)
    await pointer(output, 'pointerup', 400, 200)
    expect(document.querySelector('[data-flow-drop-target]')).toBeNull()
    expect(document.querySelector('[data-flow-wire]')).toBeNull()
    await dom.act(async () => output.click()) // Pointer capture also produces a click; it must not reopen the wire.
    expect(connected).toEqual([['execute', 'completed', 'finish', undefined]])
    await dom.act(async () => input.click())
    expect(connected).toHaveLength(1)
    await dom.act(async () => output.click())
    await dom.act(async () => input.click())
    expect(connected).toHaveLength(2)
    await dom.act(async () => output.click())
    await dom.act(async () =>
      output.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    await dom.act(async () => input.click())
    expect(connected).toHaveLength(2)
    const scale = () => parseFloat(document.querySelector<HTMLElement>('[style*="scale("]')!.style.transform.slice(6))
    const beforeZoom = scale()
    await dom.act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Zoom in flow"]')!.click())
    expect(scale()).toBeCloseTo(beforeZoom + 0.1)
    await dom.act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Zoom out flow"]')!.click())
    expect(scale()).toBeCloseTo(beforeZoom)
    await dom.act(async () =>
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Auto arrange')!.click()
    )
    expect(parseFloat(card.style.left)).toBe(initial)
    expect(scale()).toBeCloseTo(0.8)
    expect(document.querySelector('[aria-label="Reset flow zoom"]')).toBeNull()
  } finally {
    document.elementFromPoint = originalHitTest
    await dom.cleanup()
  }
})

test('interactive edges meet outcome and input handles even when cards wrap or return backwards', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/flow-handles' })
  const root = dom.createRoot()
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes.completed = { next: 'review' }
  definition.steps.push({
    ...structuredClone(definition.steps[0]!),
    id: 'review',
    outcomes: {
      approved: { next: 'finish' },
      'changes-requested': { returnTo: 'execute', afterRework: 'return-to-requester' },
    },
  })
  const positions = { execute: { x: 32, y: 32 }, review: { x: 320, y: 32 }, finish: { x: 320, y: 300 } }
  try {
    await dom.act(async () =>
      root.root.render(<WorkflowGraph definition={definition} fill positions={positions} onConnect={() => {}} />)
    )
    expect(document.querySelectorAll('[data-return-indicator]')).toHaveLength(1)
    for (const [from, outcome, to] of [
      ['execute', 'completed', 'review'],
      ['review', 'approved', 'finish'],
      ['review', 'changes-requested', 'execute'],
    ]) {
      const output = document.querySelector<HTMLElement>(
        `button[aria-label="Connect ${from} ${outcome}"]`
      )!.parentElement!
      const input = document.querySelector<HTMLElement>(`button[data-flow-target="${to}"][aria-label^="Connect to "]`)!
      const path = [...document.querySelectorAll('svg g')]
        .find((group) => group.getAttribute('data-flow-edge') === `${from}:${outcome}`)!
        .querySelector('path[marker-end]')!
      const d = path.getAttribute('d')!
      const start = [
        parseFloat(output.style.left) + parseFloat(output.style.width) - 10,
        parseFloat(output.style.top) + 10,
      ]
      const end = [parseFloat(input.style.left) + 10, parseFloat(input.style.top) + 10]
      expect(d.startsWith(`M ${start[0]} ${start[1]} `)).toBe(true)
      expect(d.endsWith(`${end[0]} ${end[1]}`)).toBe(true)
      expect(path.hasAttribute('marker-start')).toBe(outcome === 'changes-requested')
    }
  } finally {
    await dom.cleanup()
  }
})

test('backward handoffs and rework stay inside the canvas near its left and top edges', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/flow-clipping' })
  const root = dom.createRoot()
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes.completed = { next: 'review' }
  definition.steps.push({
    ...structuredClone(definition.steps[0]!),
    id: 'review',
    outcomes: {
      approved: { next: 'finish' },
      'changes-requested': { returnTo: 'execute', afterRework: 'return-to-requester' },
    },
  })
  try {
    await dom.act(async () =>
      root.root.render(
        <WorkflowGraph
          definition={definition}
          fill
          onConnect={() => {}}
          positions={{
            execute: { x: 400, y: 24 },
            review: { x: 24, y: 300 },
            finish: { x: 650, y: 24 },
          }}
        />
      )
    )
    const svg = document.querySelector('svg[aria-hidden="true"][width]')!
    const width = Number(svg.getAttribute('width'))
    const height = Number(svg.getAttribute('height'))
    for (const path of svg.querySelectorAll('g path[marker-end]')) {
      const coordinates = path
        .getAttribute('d')!
        .match(/-?\d+(?:\.\d+)?/g)!
        .map(Number)
      // Endpoints and control points all stay in bounds, so each line and
      // cubic segment stays inside the SVG's clipping rectangle.
      expect(coordinates.length % 2).toBe(0)
      for (let index = 0; index < coordinates.length; index += 2) {
        expect(coordinates[index]!).toBeGreaterThanOrEqual(0)
        expect(coordinates[index]!).toBeLessThanOrEqual(width)
        expect(coordinates[index + 1]!).toBeGreaterThanOrEqual(0)
        expect(coordinates[index + 1]!).toBeLessThanOrEqual(height)
      }
      const outcome = path.parentElement!.querySelector('title')!.textContent
      if (outcome === 'completed') {
        const ys = coordinates.filter((_, index) => index % 2 === 1)
        expect(Math.min(...ys)).toBe(coordinates[1]!) // Forward row transitions never loop above the source.
      }
      if (outcome === 'completed' || outcome === 'changes-requested') {
        expect(path.getAttribute('d')).toMatch(/^M [\d.]+ [\d.]+ L /)
        expect(coordinates[2]!).toBeGreaterThan(coordinates[0]!)
        expect(coordinates[3]).toBe(coordinates[1])
      }
    }
  } finally {
    await dom.cleanup()
  }
})

test('editor surface fills the viewport without centering padding after resizing or zooming out', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/flow-width' })
  const root = dom.createRoot()
  let resize: (() => void) | undefined
  const originalObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resize = callback
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  try {
    await dom.act(async () =>
      root.root.render(<WorkflowGraph definition={createBlankWorkflow()} fill onConnect={() => {}} />)
    )
    const viewport = document.querySelector<HTMLElement>('[role="region"]')!
    let width = 700
    Object.defineProperty(viewport, 'clientWidth', { get: () => width })
    Object.defineProperty(viewport, 'clientHeight', { value: 600 })
    for (const nextWidth of [700, 1200]) {
      width = nextWidth
      await dom.act(async () => resize!())
      await dom.act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Zoom out flow"]')!.click())
      const wrapper = viewport.firstElementChild as HTMLElement
      expect(parseFloat(wrapper.style.width)).toBeGreaterThanOrEqual(width)
      expect(parseFloat(wrapper.style.height)).toBeGreaterThanOrEqual(600)
      expect(wrapper.classList.contains('mx-auto')).toBe(false)
      const surface = wrapper.firstElementChild as HTMLElement
      const svg = surface.querySelector('svg[width]')!
      expect(Number(svg.getAttribute('width'))).toBeCloseTo(parseFloat(surface.style.width))
      expect(Number(svg.getAttribute('height'))).toBeCloseTo(parseFloat(surface.style.height))
    }
  } finally {
    globalThis.ResizeObserver = originalObserver
    await dom.cleanup()
  }
})

test('parallel branches converge on the destination with a compact wait indicator', async () => {
  const definition = workflowPresetSchema.parse(
    Bun.YAML.parse(await Bun.file(new URL('../test/fixtures/parallel-flow.yaml', import.meta.url)).text())
  ).definition
  const dom = await acquireDomHarness({ url: 'http://localhost/flow-parallel' })
  const root = dom.createRoot()
  const connections: unknown[][] = []
  const selections: unknown[][] = []
  try {
    await dom.act(async () =>
      root.root.render(
        <WorkflowGraph
          definition={definition}
          fill
          selectedId="build"
          changedStepIds={['build', 'correctness', 'audience']}
          onConnect={(...args) => connections.push(args)}
          onSelectEdge={(...args) => selections.push(args)}
        />
      )
    )
    expect(document.querySelectorAll('[data-flow-kind][aria-pressed="true"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-flow-kind].border-accent')).toHaveLength(1)
    expect(document.querySelectorAll('[aria-label="Changed by assistant"]')).toHaveLength(3)
    expect(document.querySelector('[data-flow-kind="join"]')).toBeNull()
    const join = document.querySelector<HTMLButtonElement>('[data-flow-kind="agent"][data-flow-target="consolidate"]')!
    expect(join.textContent).toContain('Waits for 2 branches')
    expect(document.querySelector('[aria-label="Connect build completed · join"]')).toBeNull()
    expect(document.querySelectorAll('[aria-label="Connect build completed"]')).toHaveLength(1)
    expect(document.body.textContent).toContain('completed · 2 branches')
    const branchPaths = [...document.querySelectorAll('[data-flow-edge]')].filter((edge) =>
      edge.getAttribute('data-flow-edge')?.startsWith('build:completed · branch')
    )
    expect(branchPaths).toHaveLength(2)
    const starts = branchPaths.map((edge) =>
      edge.querySelector('path[marker-end]')!.getAttribute('d')!.split(' ').slice(0, 3).join(' ')
    )
    expect(starts[0]).toBe(starts[1])
    expect(
      [...document.querySelectorAll('svg g title')].filter((title) => title.textContent === 'all ready')
    ).toHaveLength(0)
    await dom.act(async () =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === 'completed · 2 branches')!
        .click()
    )
    expect(selections).toEqual([['build', 'completed']])
    await dom.act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Connect audience approved"]')!.click()
    )
    await dom.act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Connect to consolidate"]')!.click()
    )
    expect(connections).toEqual([['audience', 'approved', 'consolidate', undefined]])
    const joinInput = document.querySelector<HTMLElement>('[aria-label="Connect to consolidate"]')!
    const joinEnd = `${parseFloat(joinInput.style.left) + 10} ${parseFloat(joinInput.style.top) + 10}`
    const arrivals = [...document.querySelectorAll('svg g')].filter(
      (group) => group.querySelector('title')?.textContent === 'approved'
    )
    expect(arrivals).toHaveLength(2)
    for (const arrival of arrivals)
      expect(arrival.querySelector('path[marker-end]')!.getAttribute('d')!.endsWith(joinEnd)).toBe(true)
    delete definition.steps.find((step) => step.id === 'audience')!.outcomes.approved
    expect(workflowDefinitionSchema.safeParse(definition).success).toBe(false)
    await dom.act(async () => root.root.render(<WorkflowGraph definition={definition} fill onConnect={() => {}} />))
    expect(document.querySelector('[data-flow-kind="join"]')).toBeNull()
    expect(
      [...document.querySelectorAll('svg g title')].filter((title) => title.textContent === 'approved')
    ).toHaveLength(1)
  } finally {
    await dom.cleanup()
  }
})

test('opening an editor arranges saved positions once after measurement and keeps controls inside the graph', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const root = dom.createRoot()
  const originalObserver = globalThis.ResizeObserver
  let resize!: () => void
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resize = callback
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  const saved = { $start: { x: 3000, y: 3000 }, execute: { x: 4000, y: 4000 }, finish: { x: 8000, y: 8000 } }
  let positions: typeof saved | undefined
  try {
    await dom.act(async () =>
      root.root.render(
        <WorkflowGraph
          definition={createBlankWorkflow()}
          fill
          arrangeOnMount
          positions={saved}
          onConnect={() => {}}
          onPositionsChange={(value) => {
            positions = value as typeof saved
          }}
          toolbar={<button>Add agent step</button>}
        />
      )
    )
    expect(positions).toBeUndefined()
    const viewport = document.querySelector<HTMLElement>('[role="region"]')!
    Object.defineProperty(viewport, 'clientWidth', { value: 900 })
    Object.defineProperty(viewport, 'clientHeight', { value: 700 })
    await dom.act(async () => resize())
    expect(positions!.execute.x).toBeLessThan(900)
    expect(positions!.finish.y).toBeLessThan(700)
    expect(document.querySelector('[role="toolbar"]')!.parentElement).toBe(viewport.parentElement)
    const toolbar = document.querySelector('[role="toolbar"]')!
    expect(toolbar.querySelector('details')).toBeNull()
    expect(toolbar.classList.contains('bottom-3')).toBe(true)
    expect(toolbar.classList.contains('left-3')).toBe(true)

    const first = JSON.stringify(positions)
    await dom.act(async () =>
      root.root.render(
        <WorkflowGraph
          definition={createBlankWorkflow()}
          fill
          arrangeOnMount
          positions={positions}
          onConnect={() => {}}
          onPositionsChange={(value) => {
            positions = value as typeof saved
          }}
        />
      )
    )
    await dom.act(async () => resize())
    expect(JSON.stringify(positions)).toBe(first)
  } finally {
    globalThis.ResizeObserver = originalObserver
    await dom.cleanup()
  }
})

test('canvas pans by mouse or finger and pinch zoom keeps its focal point fixed without moving cards', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/flow-navigation' })
  const root = dom.createRoot()
  try {
    await dom.act(async () =>
      root.root.render(<WorkflowGraph definition={createBlankWorkflow()} onConnect={() => {}} />)
    )
    const viewport = document.querySelector<HTMLElement>('[role="region"]')!
    const surface = document.querySelector<HTMLElement>('[style*="scale("]')!
    const card = document.querySelector<HTMLButtonElement>('[data-flow-target="execute"]')!
    const position = [card.style.left, card.style.top]
    const zoom = () => parseFloat(surface.style.transform.slice(6))
    const offset = () => surface.style.translate.split(' ').map(parseFloat)
    const pointer = async (type: string, id: number, x: number, y: number, pointerType = 'touch') =>
      dom.act(async () =>
        viewport.dispatchEvent(
          new dom.window.PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: id,
            button: 0,
            clientX: x,
            clientY: y,
            pointerType,
          })
        )
      )
    await pointer('pointerdown', 1, 100, 100, 'mouse')
    await pointer('pointermove', 1, 140, 125, 'mouse')
    await pointer('pointerup', 1, 140, 125, 'mouse')
    expect(offset()).toEqual([40, 25])
    await pointer('pointerdown', 2, 100, 100)
    await pointer('pointermove', 2, 120, 130)
    expect(offset()).toEqual([60, 55])
    await pointer('pointerup', 2, 120, 130)
    await dom.act(async () =>
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Fit')!.click()
    )
    expect(offset()).toEqual([0, 0])
    const start = zoom()
    // A symmetric pinch doubles distance while leaving the midpoint at (150, 100).
    await pointer('pointerdown', 3, 100, 100)
    await pointer('pointerdown', 4, 200, 100)
    await pointer('pointermove', 3, 75, 100)
    await pointer('pointermove', 4, 225, 100)
    expect(zoom()).toBeCloseTo(start * 1.5)
    expect((150 - offset()[0]!) / zoom()).toBeCloseTo(150 / start)
    expect((100 - offset()[1]!) / zoom()).toBeCloseTo(100 / start)
    await pointer('pointerup', 4, 225, 100)
    const afterPinch = offset()
    await pointer('pointermove', 3, 95, 110)
    expect(offset()[0]).toBeCloseTo(afterPinch[0]! + 20)
    await pointer('pointercancel', 3, 95, 110)
    const beforeWheel = zoom()
    const wheel = new dom.window.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -5,
      clientX: 150,
      clientY: 100,
    })
    // Happy DOM's WheelEvent omits MouseEvent modifier and client-coordinate fields.
    Object.defineProperties(wheel, { ctrlKey: { value: true }, clientX: { value: 150 }, clientY: { value: 100 } })
    await dom.act(async () => viewport.dispatchEvent(wheel))
    expect(wheel.defaultPrevented).toBe(true)
    expect(zoom()).toBeCloseTo(beforeWheel * Math.exp(0.05))
    const ordinary = new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 10 })
    await dom.act(async () => viewport.dispatchEvent(ordinary))
    expect(ordinary.defaultPrevented).toBe(false)
    expect([card.style.left, card.style.top]).toEqual(position)
    expect(document.querySelector('[aria-label="Reset flow zoom"]')).toBeNull()
  } finally {
    await dom.cleanup()
  }
})

test('manual graph actions preserve existing coordinates and place additions without overlaps', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/manual-layout' })
  const originalObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {}
    observe(element: HTMLElement) {
      Object.defineProperties(element, {
        clientWidth: { configurable: true, value: 900 },
        clientHeight: { configurable: true, value: 600 },
      })
      this.callback()
    }
    disconnect() {}
  } as unknown as typeof ResizeObserver
  const initial = createBlankWorkflow()
  initial.steps.push({ ...structuredClone(initial.steps[0]!), id: 'other' })
  initial.steps[0]!.outcomes = { completed: { next: 'other' } }
  let current = initial
  let change!: (next: typeof initial) => void
  let disable!: (disabled: boolean) => void
  function Harness() {
    const [definition, setDefinition] = useState(initial)
    const [disabled, setDisabled] = useState(false)
    disable = setDisabled
    const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({
      $start: { x: 24, y: 32 },
      execute: { x: 220, y: 32 },
      other: { x: 440, y: 32 },
      finish: { x: 660, y: 32 },
    })
    current = definition
    change = setDefinition
    return (
      <WorkflowGraph
        definition={definition}
        positions={positions}
        onPositionsChange={setPositions}
        editorLayout
        onConnect={disabled ? undefined : () => {}}
        fill
      />
    )
  }
  const cards = () =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-flow-kind]')].map((card) => [
        card.dataset.flowNodeId!,
        {
          x: parseFloat(card.style.left),
          y: parseFloat(card.style.top),
          width: parseFloat(card.style.width),
          height: parseFloat(card.style.height),
        },
      ])
    )
  const edit = async (update: (draft: typeof initial) => void) => {
    const before = cards()
    const zoom = document.querySelector<HTMLElement>('[style*="scale("]')!.style.transform
    const next = structuredClone(current)
    update(next)
    await dom.act(async () => change(next))
    const after = cards()
    for (const [id, point] of Object.entries(before)) {
      if (!after[id] || id === 'finish') continue
      expect([after[id]!.x, after[id]!.y]).toEqual([point.x, point.y])
    }
    // Finish can resize with its own policy, but other edits must not move it vertically.
    expect(after.finish!.y).toBe(before.finish!.y)
    expect(document.querySelector<HTMLElement>('[style*="scale("]')!.style.transform).toBe(zoom)
    return after
  }
  try {
    const root = dom.createRoot()
    await dom.act(async () => root.root.render(<Harness />))
    const baseline = cards()
    await dom.act(async () => disable(true))
    expect(cards()).toEqual(baseline)
    await dom.act(async () => disable(false))
    expect(cards()).toEqual(baseline)
    await edit((draft) => {
      for (let i = 0; i < 6; i++) draft.steps[0]!.outcomes['option-' + i] = { next: 'other' }
    })
    expect(cards().other).toEqual(baseline.other)
    expect(cards().$start).toEqual(baseline.$start)
    expect(cards().finish).toEqual(baseline.finish)
    await edit((draft) => {
      draft.steps[0]!.outcomes = { completed: { next: 'other' } }
    })
    expect(cards()).toEqual(baseline)
    await edit((draft) => {
      draft.steps[1]!.instructions = 'Revised instructions'
      draft.participants.worker!.session = 'fresh-per-attempt'
      draft.limits.maxStepAttempts = 5
      draft.routing.mode = 'flexible'
    })
    expect(cards()).toEqual(baseline)
    for (const kind of ['agent', 'human-approval'] as const) {
      const before = structuredClone(current)
      const added = await edit((draft) => {
        draft.steps.push({
          ...structuredClone(draft.steps[1]!),
          id: 'added',
          ...(kind === 'agent' ? { kind, participant: 'worker' } : { kind, approver: 'reviewers' }),
        } as (typeof draft.steps)[number])
        draft.steps[0]!.outcomes.completed = { parallel: ['other', 'added'], join: 'finish' }
      })
      const newCard = added.added!
      for (const [id, other] of Object.entries(added))
        if (id !== 'added') {
          expect(
            newCard.x >= other.x + other.width ||
              other.x >= newCard.x + newCard.width ||
              newCard.y >= other.y + other.height ||
              other.y >= newCard.y + newCard.height
          ).toBe(true)
        }
      const withAdded = structuredClone(current)
      await edit((draft) => {
        draft.steps = before.steps
      })
      expect(cards()).toEqual(baseline)
      // Undo/redo restore the existing layout, including the reappearing card.
      await dom.act(async () => change(withAdded))
      expect(cards()).toEqual(added)
      await dom.act(async () => change(before))
      expect(cards()).toEqual(baseline)
    }
    await edit((draft) => {
      draft.completion.followChanges = true
      draft.completion.changeEventsTo = { step: 'other' }
    })
    expect(cards()['code-host:delivery']).toBeDefined()
    await edit((draft) => {
      draft.completion.followChanges = false
      delete draft.completion.changeEventsTo
    })
    expect(cards()).toEqual(baseline)
    await edit((draft) => {
      draft.completion.mode = 'review-approval'
    })
    expect(cards().execute).toEqual(baseline.execute)
    await edit((draft) => {
      delete draft.steps[0]!.outcomes.completed
    })
    expect(cards().other).toEqual(baseline.other)
  } finally {
    globalThis.ResizeObserver = originalObserver
    await dom.cleanup()
  }
})
