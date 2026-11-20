import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { MemoryRouter } from 'react-router'
import { acquireDomHarness } from '../test/domHarness'
import { PermissionsProvider } from '../hooks/usePermissions'
import { COMPOSER_UNFOLD_MARGIN } from '../hooks/useComposerFit'

const usePermissionsMock = () => ({ can: () => true, isLoading: false, isError: false, permissions: ['agents:write'] })
const dependencies = {
  useImageSrcsHook: () => ({}),
  usePermissionsHook: usePermissionsMock,
  useVoiceEnabledHook: () => false,
  uploadImages: mock(async () => [] as string[]),
}

const { ChatView } = await import('./ChatView')

// Happy DOM lays nothing out, so each part of the composer's row reports a width from here, and the
// right-hand group's width follows what it holds right now, as it would in a browser.
const ACTIONS = 296
const STATUS = 56
const SEND = 60
const STOP = 50
const PICKER = 160
const HINT = 40
const TRIGGER = 36
let rowWidth = 600

function widthOf(element: Element): number {
  const classes = element.classList
  const row = element.closest('.chat-composer-controls')
  if (classes.contains('chat-composer-controls')) return rowWidth
  if (classes.contains('chat-composer-actions')) return ACTIONS
  if (classes.contains('chat-composer-status')) return STATUS
  // The trigger shows only while the actions are folded, and the hint takes room only while it is not compact.
  if (classes.contains('chat-composer-attach')) return row?.hasAttribute('data-folded') ? TRIGGER : 0
  if (classes.contains('chat-composer-auto')) return HINT
  if (classes.contains('chat-composer-send')) {
    const stop = element.querySelector('.chat-composer-stop') ? STOP : 0
    const hint = element.querySelector('.chat-composer-auto') && !row?.hasAttribute('data-compact') ? HINT : 0
    return stop + (element.querySelector('.chat-composer-delivery') ? PICKER + hint : SEND)
  }
  return 0
}

/** Every ResizeObserver the chat made; `resize()` delivers what a browser would after a layout change. */
const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = []

let cleanup: (() => Promise<void>) | undefined
let restorePrototype: (() => void) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  observers.length = 0
  rowWidth = 600
})

type Props = Partial<React.ComponentProps<typeof ChatView>>

async function render(props: Props = {}) {
  const dom = await acquireDomHarness({
    url: 'http://localhost/chat',
    configureWindow(window) {
      window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(callback, 0)
      window.cancelAnimationFrame = (id: number) => window.clearTimeout(id)
      window.HTMLElement.prototype.scrollIntoView = () => undefined
      window.ResizeObserver = class ResizeObserver {
        entry: { callback: ResizeObserverCallback; targets: Set<Element> }
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, targets: new Set() }
          observers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.targets.add(target)
        }
        unobserve(target: Element) {
          this.entry.targets.delete(target)
        }
        disconnect() {
          this.entry.targets.clear()
        }
      } as unknown as typeof window.ResizeObserver
      const prototype = window.HTMLElement.prototype
      const original = { rect: prototype.getBoundingClientRect, rects: prototype.getClientRects }
      prototype.getBoundingClientRect = function (this: HTMLElement) {
        const width = widthOf(this as unknown as Element)
        return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: width, width, height: 0 } as DOMRect
      }
      prototype.getClientRects = function (this: HTMLElement) {
        const rect = this.getBoundingClientRect()
        return (rect.width > 0 ? [rect] : []) as unknown as DOMRectList
      }
      restorePrototype = () => {
        prototype.getBoundingClientRect = original.rect
        prototype.getClientRects = original.rects
      }
    },
  })
  const { root } = dom.createRoot()
  cleanup = async () => {
    await dom.cleanup()
    restorePrototype?.()
  }
  const show = (next: Props) =>
    dom.act(async () => {
      root.render(
        <MemoryRouter>
          <PermissionsProvider usePermissions={usePermissionsMock}>
            <ChatView
              items={[]}
              agentId="agent-1"
              onSend={() => undefined}
              composerStatus={<span>18%</span>}
              dependencies={dependencies}
              {...next}
            />
          </PermissionsProvider>
        </MemoryRouter>
      )
    })
  await show(props)
  const document = dom.window.document
  const row = () => document.querySelector<HTMLElement>('.chat-composer-controls')!
  /** A layout change: the row, the right-hand group or the actions changed size. */
  const resize = () =>
    dom.act(async () => {
      for (const { callback, targets } of observers) {
        if (targets.has(row())) callback([], {} as ResizeObserver)
      }
    })
  await resize()
  const folded = () => row().hasAttribute('data-folded')
  const compact = () => row().hasAttribute('data-compact')
  const wrapped = () => row().hasAttribute('data-wrap')
  return { dom, document, row, show, resize, folded, compact, wrapped }
}

// Running: Stop and the Interrupt / Follow up split button instead of Send.
const running: Props = {
  executionStatus: 'running',
  onStop: () => undefined,
  deliveryMode: 'steer',
  onDeliveryModeChange: () => undefined,
}

const idleNeeds = ACTIONS + STATUS + SEND
const runningNeeds = ACTIONS + STATUS + STOP + PICKER
// Running with the Auto hint, actions folded: with the hint, and without it.
const suggested: Props = { ...running, suggestedDelivery: { now: true } }
const foldedNeeds = TRIGGER + STATUS + STOP + PICKER + HINT
const compactNeeds = TRIGGER + STATUS + STOP + PICKER

describe('ChatView composer fit', () => {
  test('watches the row, the actions, the status and the right-hand group', async () => {
    const { document } = await render()
    const watched = observers.find(({ targets }) => targets.has(document.querySelector('.chat-composer-controls')!))!
    expect(
      [...watched.targets].map((element) => [...element.classList].find((name) => name.startsWith('chat-composer')))
    ).toEqual(['chat-composer-controls', 'chat-composer-actions', 'chat-composer-status', 'chat-composer-send'])
  })

  test('keeps the actions inline beside Send, and folds them at the same width once a turn runs', async () => {
    rowWidth = idleNeeds + 40
    expect(runningNeeds).toBeGreaterThan(rowWidth)
    const { document, show, resize, folded } = await render()
    expect(folded()).toBe(false)
    const slot = document.querySelector('.chat-composer-actions-slot')!
    expect(slot.hasAttribute('inert')).toBe(false)

    // Stop and the picker appear: the right-hand group grows and the actions fold, unseen and inert.
    await show(running)
    await resize()
    expect(document.querySelector('.chat-composer-delivery')).not.toBeNull()
    expect(folded()).toBe(true)
    expect(slot.hasAttribute('inert')).toBe(true)
    // Still in the DOM, so their width stays known while folded.
    expect(slot.querySelectorAll('button').length).toBeGreaterThan(0)

    // The turn ends: Send alone again, and the actions come back.
    await show({})
    await resize()
    expect(folded()).toBe(false)
  })

  test('counts the follow-up picker: Stop alone fits where Stop with the picker does not', async () => {
    rowWidth = ACTIONS + STATUS + STOP + SEND + 10
    const { show, resize, folded } = await render({ ...running, deliveryMode: undefined })
    // No picker without a delivery mode: Stop beside the plain Send.
    expect(folded()).toBe(false)
    await show(running)
    await resize()
    expect(folded()).toBe(true)
  })

  test('unfolds only with the margin to spare, so a width at the boundary does not flicker', async () => {
    rowWidth = idleNeeds - 1
    const { resize, folded } = await render()
    expect(folded()).toBe(true)
    for (const width of [idleNeeds, idleNeeds + COMPOSER_UNFOLD_MARGIN - 1, idleNeeds + 4, idleNeeds]) {
      rowWidth = width
      await resize()
      expect(folded()).toBe(true)
    }
    rowWidth = idleNeeds + COMPOSER_UNFOLD_MARGIN
    await resize()
    expect(folded()).toBe(false)
    // Back inside the margin it stays inline; it folds again only once the row no longer fits.
    rowWidth = idleNeeds
    await resize()
    expect(folded()).toBe(false)
    rowWidth = idleNeeds - 1
    await resize()
    expect(folded()).toBe(true)
  })

  test('closes the options menu when the actions come back inline', async () => {
    rowWidth = runningNeeds - 1
    const { dom, document, resize, folded } = await render(running)
    expect(folded()).toBe(true)
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="More controls"]')!
    await dom.act(async () => fireEvent.click(trigger))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    rowWidth = runningNeeds + COMPOSER_UNFOLD_MARGIN
    await resize()
    expect(folded()).toBe(false)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  test('drops the Auto hint where the folded row still does not fit, and wraps only as a last resort', async () => {
    rowWidth = foldedNeeds - 1
    const { document, resize, folded, compact, wrapped } = await render(suggested)
    // One observation folds the actions, measures again with the trigger shown, and drops the hint.
    expect(folded()).toBe(true)
    expect(compact()).toBe(true)
    expect(wrapped()).toBe(false)
    // The hint is still there, so screen readers and the next measurement still have it.
    expect(document.querySelector('.chat-composer-auto')).not.toBeNull()
    // Comes back once the row has the margin to spare, counting the hidden hint.
    rowWidth = foldedNeeds + COMPOSER_UNFOLD_MARGIN - 1
    await resize()
    expect(compact()).toBe(true)
    rowWidth = foldedNeeds + COMPOSER_UNFOLD_MARGIN
    await resize()
    expect(compact()).toBe(false)
    expect(folded()).toBe(true)
    // Narrower than even the compact row: it wraps.
    rowWidth = compactNeeds - 1
    await resize()
    expect(compact()).toBe(true)
    expect(wrapped()).toBe(true)
    rowWidth = compactNeeds + COMPOSER_UNFOLD_MARGIN
    await resize()
    expect(wrapped()).toBe(false)
  })

  test('an idle composer never drops anything from Send', async () => {
    rowWidth = TRIGGER + STATUS + SEND
    const { folded, compact, wrapped } = await render()
    expect(folded()).toBe(true)
    expect(compact()).toBe(false)
    expect(wrapped()).toBe(false)
  })

  test('a composer that is not laid out keeps its actions inline', async () => {
    rowWidth = 0
    const { folded } = await render(running)
    expect(folded()).toBe(false)
  })
})
