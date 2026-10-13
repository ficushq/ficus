import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MessageMetadata } from '@ficus/shared'
import { queries } from '../queryOptions'
import { acquireDomHarness } from '../test/domHarness'
import { HumanMessageContent } from './MessageContent'

const START_URL = 'http://localhost/squads/squad-1/agents/agent-1?tab=chat'
const PREVIEW_DIALOG = '[role="dialog"][aria-label="Image preview"][data-state="open"]'

async function renderMessage(metadata: MessageMetadata, content = 'Look at this') {
  const dom = await acquireDomHarness({ url: START_URL })
  const document = dom.window.document
  const imageIds = metadata.imageIds ?? []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  // Seeded signed paths keep the hook off the network and prove the modal reuses the resolved URLs.
  queryClient.setQueryData(
    queries.images.signedUrls([...new Set(imageIds)].sort()).queryKey,
    Object.fromEntries(imageIds.map((id) => [id, `/api/images/${id}?sig=signed-${id}`]))
  )
  const opened: unknown[][] = []
  dom.window.open = ((...args: unknown[]) => {
    opened.push(args)
    return null
  }) as typeof dom.window.open
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <HumanMessageContent content={content} metadata={metadata} />
      </QueryClientProvider>
    )
  )
  const pressKey = (key: string, init: KeyboardEventInit = {}) =>
    dom.act(async () => {
      document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key, bubbles: true, ...init }) as unknown as KeyboardEvent
      )
    })
  return {
    dom,
    document,
    opened,
    pressKey,
    thumbnails: () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Preview attached image"]')],
    dialog: () => document.querySelector<HTMLElement>(PREVIEW_DIALOG),
    previewSrc: () => document.querySelector<HTMLImageElement>(`${PREVIEW_DIALOG} img`)?.getAttribute('src'),
    click: (element: HTMLElement) => dom.act(async () => element.click()),
    async cleanup() {
      queryClient.clear()
      await dom.cleanup()
    },
  }
}

const inboxMetadata = (imageIds: string[]) =>
  ({
    source: 'inbox',
    inboxMessageIds: ['m1'],
    inboxMessageSummaries: [{ id: 'm1', senderType: 'agent', senderId: 'agent-1', subject: 'Shots', preview: 'See' }],
    imageIds,
  }) satisfies MessageMetadata

for (const [variant, metadata] of [
  ['standard', { imageIds: ['img-a'] }],
  ['inbox', inboxMetadata(['img-a'])],
] as const)
  test(`${variant} attachment thumbnail is a button that opens the preview in place, never a link or a new window`, async () => {
    const view = await renderMessage(metadata)
    try {
      // No anchor wraps an attachment, so nothing can navigate the window or ask for a new tab.
      expect(view.document.querySelector('a[target="_blank"]')).toBeNull()
      expect(view.document.querySelector('a[href*="/images/"]')).toBeNull()
      const [thumbnail] = view.thumbnails()
      expect(view.thumbnails()).toHaveLength(1)
      expect(thumbnail!.tagName).toBe('BUTTON')
      expect(thumbnail!.getAttribute('type')).toBe('button')
      expect(thumbnail!.getAttribute('aria-label')).toBe('Preview attached image')
      expect(thumbnail!.querySelector('img')!.getAttribute('src')).toContain('/images/img-a?sig=signed-img-a')
      expect(view.dialog()).toBeNull()

      await view.click(thumbnail!)

      const dialog = view.dialog()!
      expect(dialog).toBeTruthy()
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      expect(view.previewSrc()).toBe(thumbnail!.querySelector('img')!.getAttribute('src'))
      // Focus moves into the dialog, and the page itself has not gone anywhere.
      expect(dialog.contains(view.document.activeElement)).toBe(true)
      expect(view.dom.window.location.href).toBe(START_URL)
      expect(view.opened).toEqual([])
      // Nothing inside the preview can navigate to the raw image either.
      expect(dialog.querySelector('a')).toBeNull()
      // A single image has nothing to step through.
      expect(dialog.querySelector('button[aria-label="Previous image"]')).toBeNull()
      expect(dialog.querySelector('button[aria-label="Next image"]')).toBeNull()
      await view.pressKey('ArrowRight')
      expect(view.previewSrc()).toContain('img-a')
    } finally {
      await view.cleanup()
    }
  })

test('Escape, the close button and a backdrop click each close the preview and return focus to the thumbnail', async () => {
  const view = await renderMessage({ imageIds: ['img-a', 'img-b'] })
  try {
    const [, second] = view.thumbnails()
    const closers: Array<[string, () => Promise<void>]> = [
      ['Escape', () => view.pressKey('Escape')],
      [
        'close button',
        () => view.click(view.dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!),
      ],
      ['backdrop', () => view.click(view.dialog()!)],
    ]
    for (const [name, close] of closers) {
      await view.click(second!)
      expect(view.dialog(), name).toBeTruthy()
      expect(view.previewSrc(), name).toContain('img-b')
      await close()
      expect(view.dialog(), name).toBeNull()
      expect(view.document.activeElement, name).toBe(second!)
      expect(view.dom.window.location.href, name).toBe(START_URL)
    }
    expect(view.opened).toEqual([])
  } finally {
    await view.cleanup()
  }
})

test('clicking the previewed image itself does not close the preview', async () => {
  const view = await renderMessage({ imageIds: ['img-a'] })
  try {
    await view.click(view.thumbnails()[0]!)
    await view.click(view.dialog()!.querySelector('img')!)
    expect(view.dialog()).toBeTruthy()
  } finally {
    await view.cleanup()
  }
})

test('a message with several images can be stepped through with buttons and arrow keys', async () => {
  const view = await renderMessage({ imageIds: ['img-a', 'img-b', 'img-c'] })
  try {
    const thumbnails = view.thumbnails()
    expect(thumbnails.map((thumbnail) => thumbnail.getAttribute('aria-label'))).toEqual([
      'Preview attached image 1 of 3',
      'Preview attached image 2 of 3',
      'Preview attached image 3 of 3',
    ])
    await view.click(thumbnails[1]!)
    const dialog = view.dialog()!
    const position = () => dialog.querySelector('[data-image-position]')?.textContent
    const button = (label: string) => dialog.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
    expect(view.previewSrc()).toContain('img-b')
    expect(position()).toBe('2 of 3')

    await view.click(button('Next image'))
    expect(view.previewSrc()).toContain('img-c')
    expect(position()).toBe('3 of 3')
    // Stepping wraps, so neither control is ever a dead end.
    await view.click(button('Next image'))
    expect(view.previewSrc()).toContain('img-a')
    await view.click(button('Previous image'))
    expect(view.previewSrc()).toContain('img-c')

    await view.pressKey('ArrowLeft')
    expect(view.previewSrc()).toContain('img-b')
    await view.pressKey('ArrowRight')
    await view.pressKey('ArrowRight')
    expect(view.previewSrc()).toContain('img-a')
    expect(position()).toBe('1 of 3')

    // Alt/Cmd+Arrow belong to the browser and the desktop shell (history navigation).
    await view.pressKey('ArrowRight', { altKey: true })
    await view.pressKey('ArrowRight', { metaKey: true })
    expect(view.previewSrc()).toContain('img-a')

    // Focus returns to the thumbnail that opened the preview, wherever stepping ended.
    await view.pressKey('Escape')
    expect(view.dialog()).toBeNull()
    expect(view.document.activeElement).toBe(thumbnails[1]!)

    // Arrow keys do nothing once the preview is closed.
    await view.pressKey('ArrowRight')
    await view.click(thumbnails[1]!)
    expect(view.previewSrc()).toContain('img-b')
  } finally {
    await view.cleanup()
  }
})
