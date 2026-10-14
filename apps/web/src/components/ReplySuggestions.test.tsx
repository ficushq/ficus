import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { acquireDomHarness } from '../test/domHarness'
import { ReplySuggestions } from './ReplySuggestions'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

/** A long-press timer the test fires by hand. */
function manualSchedule() {
  const pending = new Set<() => void>()
  return {
    schedule: (fire: () => void) => {
      pending.add(fire)
      return () => pending.delete(fire)
    },
    fire: () => {
      for (const fire of [...pending]) {
        pending.delete(fire)
        fire()
      }
    },
    get size() {
      return pending.size
    },
  }
}

async function renderChips(timer = manualSchedule()) {
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  const sent: string[] = []
  const edited: string[] = []
  await dom.act(async () =>
    root.render(
      <ReplySuggestions
        replies={['Yes, start it', 'Not now', 'Explain more']}
        onSend={(reply) => sent.push(reply)}
        onEdit={(reply) => edited.push(reply)}
        schedule={timer.schedule}
      />
    )
  )
  const chip = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!
  const pointer = (button: HTMLButtonElement, type: string, pointerType: string) =>
    dom!.act(async () => {
      button.dispatchEvent(new dom!.window.PointerEvent(type, { bubbles: true, pointerType }) as unknown as Event)
    })
  return { container, sent, edited, chip, pointer, timer }
}

test('renders accessible buttons in a labelled group, as plain text', () => {
  const html = renderToStaticMarkup(
    <ReplySuggestions replies={['<b>Yes</b>', 'No']} onSend={() => undefined} onEdit={() => undefined} />
  )
  expect(html).toContain('role="group"')
  expect(html).toContain('aria-label="Suggested replies"')
  expect(html).toContain('type="button"')
  expect(html).toContain('&lt;b&gt;Yes&lt;/b&gt;')
  expect(html).not.toContain('<b>')
})

test('renders nothing without replies', () => {
  expect(
    renderToStaticMarkup(<ReplySuggestions replies={[]} onSend={() => undefined} onEdit={() => undefined} />)
  ).toBe('')
})

test('a tap sends the reply immediately', async () => {
  const { chip, sent, edited } = await renderChips()
  await dom!.act(async () => chip('Not now').click())
  expect(sent).toEqual(['Not now'])
  expect(edited).toEqual([])
})

test('Shift+click puts the reply in the composer instead of sending it', async () => {
  const { chip, sent, edited } = await renderChips()
  await dom!.act(async () => {
    chip('Yes, start it').dispatchEvent(
      new dom!.window.MouseEvent('click', { bubbles: true, shiftKey: true }) as unknown as Event
    )
  })
  expect(edited).toEqual(['Yes, start it'])
  expect(sent).toEqual([])
})

test('a long press on touch edits the reply, and the click that ends it does not send', async () => {
  const { chip, pointer, sent, edited, timer } = await renderChips()
  const button = chip('Explain more')
  await pointer(button, 'pointerdown', 'touch')
  expect(timer.size).toBe(1)
  await dom!.act(async () => timer.fire())
  expect(edited).toEqual(['Explain more'])
  await pointer(button, 'pointerup', 'touch')
  await dom!.act(async () => button.click())
  expect(sent).toEqual([])
  // The next tap sends again.
  await pointer(button, 'pointerdown', 'touch')
  await pointer(button, 'pointerup', 'touch')
  await dom!.act(async () => button.click())
  expect(sent).toEqual(['Explain more'])
  expect(timer.size).toBe(0)
})

test('a short touch is a tap, and the mouse never starts a long press', async () => {
  const { chip, pointer, sent, edited, timer } = await renderChips()
  await pointer(chip('Not now'), 'pointerdown', 'mouse')
  expect(timer.size).toBe(0)
  await pointer(chip('Not now'), 'pointerdown', 'touch')
  await pointer(chip('Not now'), 'pointerup', 'touch')
  expect(timer.size).toBe(0)
  await dom!.act(async () => chip('Not now').click())
  expect(sent).toEqual(['Not now'])
  expect(edited).toEqual([])
})
