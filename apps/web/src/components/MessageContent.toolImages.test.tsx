import { expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { MessageMetadata, MessageToolCall } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { AssistantMessageContent, SingleToolCallSection } from './MessageContent'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const GIF = 'R0lGODlhAQABAAAAACw='
const PREVIEW_DIALOG = '[role="dialog"][aria-label="Image preview"][data-state="open"]'

const readCall = (id: string, path: string, content: unknown[]): MessageToolCall => ({
  toolCallId: id,
  toolName: 'read',
  args: JSON.stringify({ path }),
  result: JSON.stringify({ content }),
  isError: false,
})
const imagePart = (data = PNG, mimeType = 'image/png') => ({ type: 'image', mimeType, data })
const placeholder = (mimeType = 'image/png') => ({ type: 'text', text: `Read image file [${mimeType}]` })
const toolBlock = (toolCall: MessageToolCall) => ({ type: 'tool_use' as const, id: toolCall.toolCallId, toolCall })

async function render(element: ReactElement) {
  const dom = await acquireDomHarness({ url: 'http://localhost/chat' })
  const document = dom.window.document
  const { root } = dom.createRoot()
  await dom.act(async () => root.render(<MemoryRouter>{element}</MemoryRouter>))
  return {
    dom,
    document,
    strips: () => [...document.querySelectorAll<HTMLElement>('[data-tool-image-strip]')],
    thumbnails: () => [...document.querySelectorAll<HTMLButtonElement>('[data-tool-image-strip] button')],
    dialog: () => document.querySelector<HTMLElement>(PREVIEW_DIALOG),
    previewImage: () => document.querySelector<HTMLImageElement>(`${PREVIEW_DIALOG} img`),
    click: (element: Element) => dom.act(async () => (element as HTMLElement).click()),
    cleanup: () => dom.cleanup(),
  }
}

test('an expanded read shows the image as a thumbnail in place of the placeholder text, keeping other notes', async () => {
  const toolCall = readCall('r1', '/tmp/shots/after.png', [
    { type: 'text', text: 'Read image file [image/png]\n[Image resized to 1000x750]' },
    imagePart(),
  ])
  const view = await render(<SingleToolCallSection toolCall={toolCall} />)
  try {
    // Collapsed by default, the row already shows what was read.
    expect(view.thumbnails()).toHaveLength(1)
    await view.click(view.document.querySelector('[data-tool-call-row="r1"]')!)

    const [thumbnail] = view.thumbnails()
    expect(view.thumbnails()).toHaveLength(1)
    const img = thumbnail!.querySelector('img')!
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    expect(img.getAttribute('alt')).toBe('/tmp/shots/after.png')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(thumbnail!.getAttribute('type')).toBe('button')
    expect(thumbnail!.getAttribute('aria-label')).toBe('Preview /tmp/shots/after.png')

    const text = view.document.body.textContent ?? ''
    expect(text).not.toContain('Read image file')
    expect(text).toContain('[Image resized to 1000x750]')
    expect(text).not.toContain(PNG)
  } finally {
    await view.cleanup()
  }
})

test('a read with only the placeholder text shows just the thumbnail, no empty code block', async () => {
  const view = await render(
    <SingleToolCallSection toolCall={readCall('r1', '/tmp/a.png', [placeholder(), imagePart()])} />
  )
  try {
    await view.click(view.document.querySelector('[data-tool-call-row="r1"]')!)
    expect(view.thumbnails()).toHaveLength(1)
    expect(view.document.querySelector('pre')).toBeNull()
    expect(view.document.body.textContent).not.toContain('Read image file')
  } finally {
    await view.cleanup()
  }
})

test('without an image part the read result renders exactly as before', async () => {
  const view = await render(
    <SingleToolCallSection
      toolCall={readCall('r1', '/tmp/a.md', [{ type: 'text', text: 'Read image file [image/png]' }])}
    />
  )
  try {
    expect(view.strips()).toHaveLength(0)
    await view.click(view.document.querySelector('[data-tool-call-row="r1"]')!)
    expect(view.strips()).toHaveLength(0)
    expect(view.document.querySelector('pre')!.textContent).toBe('Read image file [image/png]')
  } finally {
    await view.cleanup()
  }
})

test('any tool’s image parts render, never the raw JSON with its base64 payload', async () => {
  const toolCall: MessageToolCall = {
    toolCallId: 'b1',
    toolName: 'browser_screenshot',
    args: '{}',
    result: JSON.stringify({ content: [{ type: 'text', text: 'Clicked Save' }, imagePart()] }),
    isError: false,
  }
  const view = await render(<SingleToolCallSection toolCall={toolCall} />)
  try {
    await view.click(view.document.querySelector('[data-tool-call-row="b1"]')!)
    expect(view.thumbnails()[0]!.querySelector('img')!.getAttribute('alt')).toBe('Image from browser_screenshot')
    expect(view.document.body.textContent).toContain('Clicked Save')
    expect(view.document.body.textContent).not.toContain(PNG)
  } finally {
    await view.cleanup()
  }
})

const groupMetadata = {
  content: [
    { type: 'thinking' as const, id: 'th', content: 'Look at the screenshots' },
    toolBlock(readCall('a', '/tmp/one.png', [placeholder(), imagePart()])),
    toolBlock(readCall('b', '/tmp/notes.md', [{ type: 'text', text: '# notes' }])),
    toolBlock(readCall('c', '/tmp/two.gif', [placeholder('image/gif'), imagePart(GIF, 'image/gif')])),
    toolBlock(readCall('d', '/tmp/three.png', [placeholder(), imagePart()])),
  ],
} satisfies MessageMetadata

test('a collapsed group shows every image it read, in order, side by side in one scrolling strip', async () => {
  const view = await render(<AssistantMessageContent content="" metadata={groupMetadata} />)
  try {
    expect(view.document.body.textContent).toContain('4 tools')
    // Still collapsed: no tool rows, but the images are there.
    expect(view.document.querySelector('[data-tool-call-row]')).toBeNull()
    const strips = view.strips()
    expect(strips).toHaveLength(1)
    expect(strips[0]!.className).toContain('flex')
    expect(strips[0]!.className).toContain('overflow-x-auto')
    expect(strips[0]!.className).not.toContain('flex-wrap')
    expect(view.thumbnails().map((button) => button.querySelector('img')!.getAttribute('alt'))).toEqual([
      '/tmp/one.png',
      '/tmp/two.gif',
      '/tmp/three.png',
    ])
    for (const button of view.thumbnails()) expect(button.className).toContain('shrink-0')
  } finally {
    await view.cleanup()
  }
})

test('clicking a group thumbnail opens that image in the preview, steps through the group, and leaves the group collapsed', async () => {
  const view = await render(<AssistantMessageContent content="" metadata={groupMetadata} />)
  try {
    const thumbnails = view.thumbnails()
    expect(view.dialog()).toBeNull()
    await view.click(thumbnails[1]!)

    expect(view.dialog()).toBeTruthy()
    expect(view.previewImage()!.getAttribute('src')).toBe(`data:image/gif;base64,${GIF}`)
    expect(view.previewImage()!.getAttribute('alt')).toBe('/tmp/two.gif')
    expect(view.dialog()!.querySelector('[data-image-position]')!.textContent).toBe('2 of 3')
    // The group did not toggle open behind the preview.
    expect(view.document.querySelector('[data-tool-call-row]')).toBeNull()

    await view.click(view.dialog()!.querySelector('button[aria-label="Next image"]')!)
    expect(view.previewImage()!.getAttribute('alt')).toBe('/tmp/three.png')

    await view.click(view.dialog()!.querySelector('button[aria-label="Close"]')!)
    expect(view.dialog()).toBeNull()
    expect(view.document.activeElement).toBe(thumbnails[1]!)
  } finally {
    await view.cleanup()
  }
})

test('expanding the group moves the thumbnails onto each tool row', async () => {
  const view = await render(<AssistantMessageContent content="" metadata={groupMetadata} />)
  try {
    const header = [...view.document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('4 tools')
    )!
    await view.click(header)
    expect(view.document.querySelectorAll('[data-tool-call-row]')).toHaveLength(4)
    // One strip per image-bearing row, none for the group header or the text-only read.
    expect(view.strips()).toHaveLength(3)
  } finally {
    await view.cleanup()
  }
})

test('a thumbnail whose data fails to decode disappears quietly', async () => {
  const view = await render(<AssistantMessageContent content="" metadata={groupMetadata} />)
  try {
    const broken = view.thumbnails()[0]!.querySelector('img')!
    await view.dom.act(async () => {
      broken.dispatchEvent(new view.dom.window.Event('error') as unknown as Event)
    })
    expect(view.thumbnails().map((button) => button.querySelector('img')!.getAttribute('alt'))).toEqual([
      '/tmp/two.gif',
      '/tmp/three.png',
    ])
  } finally {
    await view.cleanup()
  }
})
