import { acquireDomHarness } from '../test/domHarness'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkStreamViewToggle, workStreamViewStorageKey } from './WorkStreamViewToggle'

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

let windowValue: Awaited<ReturnType<typeof acquireDomHarness>>['window']
let container: HTMLElement
let root: Root

beforeEach(async () => {
  domHarness = await acquireDomHarness({ url: 'http://localhost/' })
  windowValue = domHarness.window
  ;({ container, root } = domHarness.createRoot())
})

const HOME_MODES = ['list', 'graph'] as const
const WORK_MODES = ['list', 'kanban', 'graph'] as const

function graphButtons() {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === 'graph')
}

describe('WorkStreamViewToggle', () => {
  test('synchronizes two surfaces for the same squad and persists the selection', async () => {
    await domHarness!.act(async () =>
      root.render(
        <>
          <WorkStreamViewToggle squadId="one" surface="home" modes={HOME_MODES} />
          <WorkStreamViewToggle squadId="one" surface="home" modes={HOME_MODES} />
        </>
      )
    )
    await domHarness!.act(async () => graphButtons()[0].click())

    expect(window.localStorage.getItem(workStreamViewStorageKey('one', 'home'))).toBe('graph')
    expect(graphButtons().map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'true'])
  })

  test('isolates preferences by squad', async () => {
    window.localStorage.setItem(workStreamViewStorageKey('one', 'home'), 'graph')
    await domHarness!.act(async () =>
      root.render(
        <>
          <WorkStreamViewToggle squadId="one" surface="home" modes={HOME_MODES} />
          <WorkStreamViewToggle squadId="two" surface="home" modes={HOME_MODES} />
        </>
      )
    )

    expect(graphButtons().map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
  })

  test('honors the specified persisted work-tab key', async () => {
    window.localStorage.setItem('ficus.wsView.one', 'kanban')
    await domHarness!.act(async () =>
      root.render(<WorkStreamViewToggle squadId="one" surface="work" modes={WORK_MODES} />)
    )

    const kanban = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'kanban'
    )
    expect(kanban?.getAttribute('aria-pressed')).toBe('true')
  })

  test('reads the previously shipped surface-qualified work key as a migration fallback', async () => {
    window.localStorage.setItem('ficus.wsView.work.one', 'graph')
    await domHarness!.act(async () =>
      root.render(<WorkStreamViewToggle squadId="one" surface="work" modes={WORK_MODES} />)
    )

    expect(graphButtons()[0].getAttribute('aria-pressed')).toBe('true')
  })

  test('does not leak a work-tab Kanban preference into home', async () => {
    window.localStorage.setItem(workStreamViewStorageKey('one', 'work'), 'kanban')
    await domHarness!.act(async () =>
      root.render(<WorkStreamViewToggle squadId="one" surface="home" modes={HOME_MODES} />)
    )

    expect(container.textContent).not.toContain('kanban')
    expect(container.querySelector<HTMLButtonElement>('button')?.getAttribute('aria-pressed')).toBe('true')
  })

  test('falls back to list for invalid persisted values', async () => {
    window.localStorage.setItem(workStreamViewStorageKey('one', 'home'), 'stale')
    await domHarness!.act(async () =>
      root.render(<WorkStreamViewToggle squadId="one" surface="home" modes={HOME_MODES} />)
    )

    expect(container.querySelector<HTMLButtonElement>('button')?.getAttribute('aria-pressed')).toBe('true')
    expect(graphButtons()[0].getAttribute('aria-pressed')).toBe('false')
  })

  test('falls back to list when storage is unavailable', async () => {
    Object.defineProperty(windowValue, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied')
      },
    })
    await domHarness!.act(async () =>
      root.render(<WorkStreamViewToggle squadId="one" surface="home" modes={HOME_MODES} />)
    )

    expect(container.querySelector<HTMLButtonElement>('button')?.getAttribute('aria-pressed')).toBe('true')
  })

  test('server rendering safely defaults to list', () => {
    const savedWindow = globalThis.window
    delete (globalThis as Record<string, unknown>).window
    try {
      const html = renderToStaticMarkup(<WorkStreamViewToggle squadId="one" surface="work" modes={WORK_MODES} />)
      expect(html).toContain('aria-pressed="true"')
      expect(html).toContain('>list</button>')
    } finally {
      globalThis.window = savedWindow
    }
  })
})

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})
