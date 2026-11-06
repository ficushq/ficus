import { describe, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { acquireDomHarness } from '../test/domHarness'
import { isDarkColor } from '../theme/isDarkColor'
import { MermaidDiagram, type MermaidRenderer } from './MermaidDiagram'

const fallback = <pre data-testid="source">flowchart TD</pre>

/** A renderer the test settles by hand, recording each call's theme. */
function controlledRenderer() {
  const calls: Array<{ source: string; dark: boolean; resolve: (svg: string) => void; reject: (e: Error) => void }> = []
  const renderer: MermaidRenderer = (source, dark) =>
    new Promise((resolve, reject) => calls.push({ source, dark, resolve, reject }))
  return { calls, renderer }
}

async function mount(renderer: MermaidRenderer) {
  const harness = await acquireDomHarness({ url: 'https://ficus.test' })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<MermaidDiagram source="flowchart TD" fallback={fallback} renderer={renderer} />))
  return {
    harness,
    host,
    state: () => host.querySelector('[data-mermaid]')?.getAttribute('data-mermaid'),
    async cleanup() {
      await act(async () => root.unmount())
      await harness.cleanup()
    },
  }
}

describe('MermaidDiagram', () => {
  test('shows the source while loading, then the diagram, with a toggle back to the source', async () => {
    const { calls, renderer } = controlledRenderer()
    const view = await mount(renderer)
    try {
      expect(view.state()).toBe('loading')
      expect(view.host.querySelector('[data-testid="source"]')).not.toBeNull()
      expect(calls.map(({ source, dark }) => ({ source, dark }))).toEqual([{ source: 'flowchart TD', dark: false }])

      await act(async () => calls[0]!.resolve('<svg data-testid="diagram"></svg>'))
      expect(view.state()).toBe('rendered')
      expect(view.host.querySelector('[role="img"] [data-testid="diagram"]')).not.toBeNull()
      expect(view.host.querySelector('[data-testid="source"]')).toBeNull()

      const button = (label: string) =>
        [...view.host.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
      await act(async () => button('Source').click())
      expect(view.host.querySelector('[data-testid="source"]')).not.toBeNull()
      expect(view.host.querySelector('[data-testid="diagram"]')).toBeNull()
      expect(button('Source').getAttribute('aria-pressed')).toBe('true')
      await act(async () => button('Diagram').click())
      expect(view.host.querySelector('[data-testid="diagram"]')).not.toBeNull()
    } finally {
      await view.cleanup()
    }
  })

  test('falls back to the source with a short note when the diagram does not parse', async () => {
    const { calls, renderer } = controlledRenderer()
    const view = await mount(renderer)
    try {
      await act(async () => calls[0]!.reject(new Error('Parse error on line 2')))
      expect(view.state()).toBe('error')
      expect(view.host.querySelector('[data-testid="source"]')).not.toBeNull()
      const note = view.host.querySelector('p')!
      expect(note.textContent).toContain('could not be rendered')
      expect(note.getAttribute('title')).toBe('Parse error on line 2')
      expect(view.host.querySelector('[role="img"]')).toBeNull()
    } finally {
      await view.cleanup()
    }
  })

  test('a renderer that throws synchronously also falls back instead of breaking the tree', async () => {
    const view = await mount(() => {
      throw new Error('Mermaid failed to load')
    })
    try {
      await act(async () => {})
      expect(view.state()).toBe('error')
      expect(view.host.querySelector('[data-testid="source"]')).not.toBeNull()
    } finally {
      await view.cleanup()
    }
  })

  test('redraws in the dark theme when the app switches to a dark surface', async () => {
    const { calls, renderer } = controlledRenderer()
    const view = await mount(renderer)
    try {
      await act(async () => calls[0]!.resolve('<svg data-testid="light"></svg>'))
      const style = document.createElement('style')
      style.textContent = ':root { --color-bg-surface: 250 250 250; } .dark { --color-bg-surface: 20 20 24; }'
      document.head.append(style)
      await act(async () => {
        document.documentElement.classList.add('dark')
        await view.harness.window.happyDOM.waitUntilComplete()
      })
      expect(calls.at(-1)!.dark).toBe(true)
      // The previous drawing stays until the new one is ready, so the area never goes blank.
      expect(view.host.querySelector('[data-testid="light"]')).not.toBeNull()
      await act(async () => calls.at(-1)!.resolve('<svg data-testid="dark"></svg>'))
      expect(view.host.querySelector('[data-testid="dark"]')).not.toBeNull()
    } finally {
      await view.cleanup()
    }
  })
})

test('isDarkColor reads resolved token colors', () => {
  expect(isDarkColor('rgb(20, 20, 24)')).toBe(true)
  expect(isDarkColor('rgba(30, 41, 59, 0.9)')).toBe(true)
  expect(isDarkColor('rgb(255, 255, 255)')).toBe(false)
  expect(isDarkColor('rgb(241, 245, 249)')).toBe(false)
  expect(isDarkColor(undefined)).toBe(false)
  expect(isDarkColor('transparent')).toBe(false)
})
