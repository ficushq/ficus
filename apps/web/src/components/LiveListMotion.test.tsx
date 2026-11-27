import { afterEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { liveEmphasisProps, liveRowProps, LIVE_MOVE_DURATION_MS } from '../lib/liveListMotion'
import { LiveListMotion, LIVE_ARRIVED_CLASS, LIVE_EMPHASIS_CLASS } from './LiveListMotion'

const ROW_HEIGHT = 40

interface Row {
  id: string
  status?: string
}

interface AnimateCall {
  key: string | null
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
}

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

/**
 * Renders a list whose rows report their place from their index (Happy DOM has no layout), with
 * `animate` recorded instead of run.
 */
async function renderList(rows: Row[], { resetKey = 'list', reducedMotion = false, hidden = false } = {}) {
  const animations: AnimateCall[] = []
  dom = await acquireDomHarness({
    url: 'http://localhost/',
    configureWindow(window) {
      window.matchMedia = ((query: string) => ({
        matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener() {},
        removeEventListener() {},
      })) as unknown as typeof window.matchMedia
      Object.defineProperty(window.document, 'visibilityState', {
        configurable: true,
        get: () => (hidden ? 'hidden' : 'visible'),
      })
      const prototype = window.HTMLElement.prototype as unknown as HTMLElement
      prototype.getBoundingClientRect = function (this: HTMLElement) {
        const index = Number(this.dataset.index ?? 0)
        const top = index * ROW_HEIGHT
        return { top, bottom: top + ROW_HEIGHT, left: 0, right: 300, width: 300, height: ROW_HEIGHT } as DOMRect
      }
      prototype.animate = function (this: HTMLElement, keyframes, options) {
        animations.push({
          key: this.getAttribute('data-live-row'),
          keyframes: keyframes as Keyframe[],
          options: options as KeyframeAnimationOptions,
        })
        return { cancel() {}, onfinish: null } as unknown as Animation
      }
    },
  })
  const { container, root } = dom.createRoot()
  const harness = dom
  const render = async (next: Row[], key = resetKey) => {
    await harness.act(async () =>
      root.render(
        <LiveListMotion resetKey={key}>
          <ul>
            {next.map((row, index) => (
              <li key={row.id} data-index={index} {...liveRowProps(row.id, row.status)}>
                {row.id}
                {row.status && <span {...liveEmphasisProps}>{row.status}</span>}
              </li>
            ))}
          </ul>
        </LiveListMotion>
      )
    )
  }
  await render(rows)
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-live-row="${id}"]`)!
  const arrived = () =>
    [...container.querySelectorAll(`.${LIVE_ARRIVED_CLASS}`)].map((node) => node.getAttribute('data-live-row'))
  const emphasized = () =>
    [...container.querySelectorAll(`.${LIVE_EMPHASIS_CLASS}`)].map((node) =>
      node.closest('[data-live-row]')!.getAttribute('data-live-row')
    )
  return { animations, render, row, arrived, emphasized }
}

const ABC: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

test('first load animates nothing', async () => {
  const list = await renderList(ABC)
  expect(list.animations).toEqual([])
  expect(list.arrived()).toEqual([])
})

test('a live reorder slides each moved row from its old place in about 300 ms', async () => {
  const list = await renderList(ABC)
  await list.render([{ id: 'c' }, { id: 'a' }, { id: 'b' }])
  expect(list.animations.map(({ key, keyframes }) => [key, keyframes[0]!.transform])).toEqual([
    ['c', 'translate(0px, 80px)'],
    ['a', 'translate(0px, -40px)'],
    ['b', 'translate(0px, -40px)'],
  ])
  expect(list.animations.every(({ keyframes }) => keyframes[1]!.transform === 'none')).toBe(true)
  expect(list.animations[0]!.options.duration).toBe(LIVE_MOVE_DURATION_MS)
  expect(LIVE_MOVE_DURATION_MS).toBe(300)
  expect(list.arrived()).toEqual([])
})

test('a row that arrives is highlighted until its animation ends', async () => {
  const list = await renderList(ABC)
  await list.render([{ id: 'new' }, ...ABC])
  expect(list.arrived()).toEqual(['new'])
  // The rows it pushed down slide.
  expect(list.animations.map(({ key }) => key)).toEqual(['a', 'b', 'c'])

  const event = new window.Event('animationend', { bubbles: true }) as unknown as AnimationEvent
  Object.defineProperty(event, 'animationName', { value: LIVE_ARRIVED_CLASS })
  list.row('new').dispatchEvent(event)
  expect(list.arrived()).toEqual([])
})

test('a status change briefly emphasizes that row’s badge', async () => {
  const list = await renderList([
    { id: 'a', status: 'in_progress' },
    { id: 'b', status: 'queued' },
  ])
  await list.render([
    { id: 'a', status: 'in_review' },
    { id: 'b', status: 'queued' },
  ])
  expect(list.emphasized()).toEqual(['a'])
  expect(list.animations).toEqual([])
  expect(list.arrived()).toEqual([])
})

test('an update that changes nothing the rows show does nothing', async () => {
  const list = await renderList(ABC)
  await list.render(ABC)
  expect(list.animations).toEqual([])
  expect(list.arrived()).toEqual([])
})

test('a filter, scope or loading change (a new reset key) never animates', async () => {
  const list = await renderList(ABC)
  await list.render([{ id: 'new' }, { id: 'c' }, { id: 'a' }], 'filtered')
  expect(list.animations).toEqual([])
  expect(list.arrived()).toEqual([])
  // The next live change under the new key animates again.
  await list.render([{ id: 'a' }, { id: 'new' }, { id: 'c' }], 'filtered')
  expect(list.animations.map(({ key }) => key)).toEqual(['a', 'new', 'c'])
})

test('reduced motion: nothing moves, arrives or swells', async () => {
  const list = await renderList(
    [
      { id: 'a', status: 'queued' },
      { id: 'b', status: 'queued' },
    ],
    { reducedMotion: true }
  )
  await list.render([{ id: 'new' }, { id: 'b', status: 'in_progress' }, { id: 'a', status: 'queued' }])
  expect(list.animations).toEqual([])
  expect(list.arrived()).toEqual([])
  expect(list.emphasized()).toEqual([])
})

test('a hidden tab animates nothing', async () => {
  const list = await renderList(ABC, { hidden: true })
  await list.render([{ id: 'new' }, { id: 'c' }, { id: 'a' }])
  expect(list.animations).toEqual([])
  expect(list.arrived()).toEqual([])
})
