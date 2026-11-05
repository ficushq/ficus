import { afterEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { typingSummary } from '../lib/teammatesTyping'
import { TeammatesTyping } from './TeammatesTyping'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

/** Renders the indicator with the viewer's motion preference. */
async function render(names: string[], { reducedMotion = false } = {}) {
  dom = await acquireDomHarness({
    url: 'http://localhost/',
    configureWindow(window) {
      window.matchMedia = ((query: string) => ({
        matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener() {},
        removeEventListener() {},
      })) as unknown as typeof window.matchMedia
    },
  })
  const { container, root } = dom.createRoot()
  const typers = names.map((name, index) => ({ userId: `user-${index}`, name }))
  await dom.act(async () => root.render(<TeammatesTyping typers={typers} />))
  const status = container.querySelector('[data-testid="teammates-typing"]')
  return {
    container,
    status,
    bubbles: [...container.querySelectorAll('[data-testid="typing-bubble"]')],
  }
}

test('says who is typing, compactly for many', () => {
  expect(typingSummary([])).toBe('')
  expect(typingSummary(['Alice'])).toBe('Alice is typing')
  expect(typingSummary(['Alice', 'Bob'])).toBe('Alice and Bob are typing')
  expect(typingSummary(['Alice', 'Bob', 'Carol'])).toBe('Alice, Bob and Carol are typing')
  expect(typingSummary(['Alice', 'Bob', 'Carol', 'Dan', 'Eve'])).toBe('Alice, Bob and 3 others are typing')
})

test('nobody typing shows nothing', async () => {
  const { container, status } = await render([])
  expect(status).toBeNull()
  expect(container.innerHTML).toBe('')
})

test('one typer: a bubble of three staggered bouncing dots, labeled with their name', async () => {
  const { status, bubbles } = await render(['Alice'])
  expect(status!.getAttribute('role')).toBe('status')
  expect(status!.getAttribute('data-motion')).toBe('full')
  expect(status!.querySelector('.sr-only')!.textContent).toBe('Alice is typing')
  expect(bubbles).toHaveLength(1)
  expect(bubbles[0]!.textContent).toBe('Alice')
  // Decoration: the status line carries the meaning for assistive tech.
  expect(bubbles[0]!.getAttribute('aria-hidden')).toBe('true')
  const dots = [...bubbles[0]!.querySelectorAll<HTMLElement>('[data-testid="typing-dot"]')]
  expect(dots).toHaveLength(3)
  expect(dots.every((dot) => dot.classList.contains('ficus-typing-dot'))).toBe(true)
  expect(dots.map((dot) => dot.style.animationDelay)).toEqual(['0ms', '160ms', '320ms'])
})

test('several typers each get their own bubble, however many there are', async () => {
  const { bubbles, status } = await render(['Alice', 'Bob', 'Carol', 'Dan', 'Eve'])
  expect(bubbles.map((bubble) => bubble.textContent)).toEqual(['Alice', 'Bob', 'Carol', 'Dan', 'Eve'])
  // The status line stays short for assistive tech.
  expect(status!.querySelector('.sr-only')!.textContent).toBe('Alice, Bob and 3 others are typing')
})

test('reduced motion keeps the dots still', async () => {
  const { status, bubbles } = await render(['Alice', 'Bob'], { reducedMotion: true })
  expect(status!.getAttribute('data-motion')).toBe('reduced')
  const dots = bubbles.flatMap((bubble) => [...bubble.querySelectorAll<HTMLElement>('[data-testid="typing-dot"]')])
  expect(dots).toHaveLength(6)
  expect(dots.some((dot) => dot.classList.contains('ficus-typing-dot'))).toBe(false)
  expect(dots.every((dot) => dot.style.animationDelay === '')).toBe(true)
})
