import { describe, expect, mock, test } from 'bun:test'
import { useState } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { MultilineResponseField } from './MultilineResponseField'

function Harness({
  initial,
  canSubmit = true,
  onSubmit,
}: {
  initial: string
  canSubmit?: boolean
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <MultilineResponseField
      value={value}
      onChange={setValue}
      onSubmit={() => onSubmit(value)}
      canSubmit={canSubmit}
      actions={<button type="button">Send</button>}
    />
  )
}

async function renderField(props: Parameters<typeof Harness>[0], platform = 'Linux x86_64') {
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    configureWindow: (window) => Object.defineProperty(window.navigator, 'platform', { value: platform }),
  })
  const rendered = dom.createRoot()
  await dom.act(async () => rendered.root.render(<Harness {...props} />))
  const textarea = dom.window.document.querySelector('textarea') as HTMLTextAreaElement
  const press = async (init: KeyboardEventInit & { isComposing?: boolean }) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
    await dom.act(async () => {
      textarea.dispatchEvent(event)
    })
    return event
  }
  return { dom, textarea, press }
}

describe('MultilineResponseField', () => {
  test('renders a resizable multi-line textarea that keeps line breaks', async () => {
    const onSubmit = mock((_value: string) => {})
    const { dom, textarea, press } = await renderField({ initial: 'line one\nline two', onSubmit })
    try {
      expect(textarea.placeholder).toBe('Your response...')
      expect(Number(textarea.getAttribute('rows'))).toBeGreaterThan(1)
      expect(textarea.className).toContain('resize-y')
      expect(textarea.className).toContain('ficus-field')
      expect(textarea.value).toBe('line one\nline two')
      await press({ ctrlKey: true })
      expect(onSubmit).toHaveBeenCalledWith('line one\nline two')
    } finally {
      await dom.cleanup()
    }
  })

  test('plain Enter and Shift+Enter insert a newline instead of submitting', async () => {
    const onSubmit = mock((_value: string) => {})
    const { dom, press } = await renderField({ initial: 'a response', onSubmit })
    try {
      const plain = await press({})
      const shifted = await press({ shiftKey: true })
      expect(plain.defaultPrevented).toBe(false)
      expect(shifted.defaultPrevented).toBe(false)
      expect(onSubmit).not.toHaveBeenCalled()
    } finally {
      await dom.cleanup()
    }
  })

  test('Cmd+Enter and Ctrl+Enter submit', async () => {
    const onSubmit = mock((_value: string) => {})
    const { dom, press } = await renderField({ initial: 'ok', onSubmit })
    try {
      const meta = await press({ metaKey: true })
      expect(meta.defaultPrevented).toBe(true)
      await press({ ctrlKey: true })
      expect(onSubmit).toHaveBeenCalledTimes(2)
    } finally {
      await dom.cleanup()
    }
  })

  test('does not submit a blank response, while submission is not allowed, or during IME composition', async () => {
    const onSubmit = mock((_value: string) => {})
    for (const [props, init] of [
      [{ initial: '  \n\t ', onSubmit }, { metaKey: true }],
      [{ initial: 'ready', canSubmit: false, onSubmit }, { metaKey: true }],
      [
        { initial: 'ready', onSubmit },
        { metaKey: true, isComposing: true },
      ],
    ] as const) {
      const { dom, press } = await renderField(props)
      try {
        await press(init)
      } finally {
        await dom.cleanup()
      }
    }
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('shows the platform submit hint while focused', async () => {
    for (const [platform, hint] of [
      ['MacIntel', '⌘ + Enter to submit'],
      ['Win32', 'Ctrl + Enter to submit'],
    ] as const) {
      const { dom, textarea } = await renderField({ initial: '', onSubmit: () => {} }, platform)
      try {
        expect(dom.window.document.body.textContent).not.toContain('Enter to submit')
        await dom.act(async () => textarea.focus())
        expect(dom.window.document.body.textContent).toContain(hint)
        await dom.act(async () => textarea.blur())
        expect(dom.window.document.body.textContent).not.toContain('Enter to submit')
      } finally {
        await dom.cleanup()
      }
    }
  })
})
