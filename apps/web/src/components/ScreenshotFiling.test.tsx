import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { FileScreenshotResponse, ScreenshotCorrection, Squad } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { PermissionsProvider } from '../hooks/usePermissions'
import { queryKeys } from '../queryKeys'
import { filingDetail, filingHeadline } from '../lib/screenshotFiling'
import { ScreenshotFiling } from './ScreenshotFiling'

type Harness = Awaited<ReturnType<typeof acquireDomHarness>>

const chlea = { id: '11111111-1111-4111-8111-111111111111', name: 'Chlea', status: 'active' } as Squad
const ops = { id: '22222222-2222-4222-8222-222222222222', name: 'Ops', status: 'active' } as Squad
const filedInChlea: FileScreenshotResponse = {
  conversationId: '33333333-3333-4333-8333-333333333333',
  guess: {
    kind: { id: 'bug', label: 'a bug', probability: 0.88 },
    squad: { id: chlea.id, name: 'Chlea', probability: 0.72 },
    action: { id: 'new_work_stream', label: 'start a new work stream', probability: 0.6 },
  },
}

function fakes(response: FileScreenshotResponse = filedInChlea) {
  const uploads: Array<{ data: string; mimeType: string }> = []
  const filed: string[] = []
  const corrections: ScreenshotCorrection[] = []
  return {
    uploads,
    filed,
    corrections,
    dependencies: {
      upload: async (images: Array<{ data: string; mimeType: string }>) => {
        uploads.push(...images)
        return ['44444444-4444-4444-8444-444444444444']
      },
      api: {
        file: async (imageId: string) => {
          filed.push(imageId)
          return response
        },
        correct: async (correction: ScreenshotCorrection) => {
          corrections.push(correction)
          return { conversationId: correction.conversationId }
        },
      },
    },
  }
}

async function render(dom: Harness, deps: ReturnType<typeof fakes>, permissions = ['chat:send', 'agents:write']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.squads.list(), [chlea, ops])
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/squads/x/work']}>
        <QueryClientProvider client={client}>
          <PermissionsProvider
            usePermissions={() => ({
              can: (permission) => permissions.includes(permission),
              permissions,
              isLoading: false,
              isError: false,
            })}
          >
            <main>
              <p>Page content</p>
              <input aria-label="Search" />
              <div data-drop-scope="chat" tabIndex={-1}>
                <p>A chat message</p>
                <textarea aria-label="Composer" />
              </div>
            </main>
            <ScreenshotFiling dependencies={deps.dependencies as never} />
          </PermissionsProvider>
        </QueryClientProvider>
      </MemoryRouter>
    )
  )
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const png = (dom: Harness) => new dom.window.File([PNG_BYTES], 'shot.png', { type: 'image/png' }) as unknown as File

function drag(dom: Harness, type: string, target: Element, files: File[] = []) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files, dropEffect: 'none' },
  })
  target.dispatchEvent(event as unknown as Event)
  return event
}

function paste(dom: Harness, target: Element, file: File | null) {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { items: file ? [{ kind: 'file', type: file.type, getAsFile: () => file }] : [] },
  })
  target.dispatchEvent(event as unknown as Event)
  return event
}

async function settle(dom: Harness, until: () => boolean) {
  for (let attempt = 0; attempt < 50 && !until(); attempt++) await dom.act(async () => await Promise.resolve())
  expect(until()).toBe(true)
}

const overlay = () => document.querySelector('[data-testid="screenshot-drop-overlay"]')
const toast = () => document.querySelector('[data-testid="screenshot-filing-toast"]')

describe('ScreenshotFiling', () => {
  test('dragging a file over the app shows the overlay; over a composer drop zone it does not', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      await render(dom, fakes())
      const page = document.querySelector('main p')!
      await dom.act(async () => void drag(dom, 'dragenter', page))
      expect(overlay()?.textContent).toContain('Drop to file this screenshot')
      // Over the composer, its own drop handling wins.
      const composer = document.querySelector('textarea')!
      const over = await dom.act(async () => drag(dom, 'dragover', composer))
      expect(overlay()).toBeNull()
      expect(over.defaultPrevented).toBe(false)
      await dom.act(async () => void drag(dom, 'dragover', page))
      expect(overlay()).not.toBeNull()
      // Moving between elements enters the next before leaving the last: still showing.
      const search = document.querySelector('input')!
      await dom.act(async () => {
        drag(dom, 'dragenter', search)
        drag(dom, 'dragleave', page)
      })
      expect(overlay()).not.toBeNull()
      // Leaving the window leaves the last element with nothing entered.
      await dom.act(async () => void drag(dom, 'dragleave', search))
      expect(overlay()).toBeNull()
    } finally {
      await dom.cleanup()
    }
  })

  test('dropping an image outside drop zones uploads it, files it, and shows the guess', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      await render(dom, deps)
      const page = document.querySelector('main p')!
      await dom.act(async () => void drag(dom, 'dragover', page))
      const dropped = await dom.act(async () => drag(dom, 'drop', page, [png(dom)]))
      expect(dropped.defaultPrevented).toBe(true)
      expect(overlay()).toBeNull()
      await settle(dom, () => Boolean(toast()?.textContent?.includes('Filing in Chlea: looks like a bug')))
      expect(deps.uploads).toEqual([
        { type: 'image', data: btoa(String.fromCharCode(...PNG_BYTES)), mimeType: 'image/png' },
      ] as never)
      expect(deps.filed).toEqual(['44444444-4444-4444-8444-444444444444'])
      expect(toast()!.getAttribute('role')).toBe('status')

      // A drop on the composer is the composer's.
      const composer = document.querySelector('textarea')!
      await dom.act(async () => void drag(dom, 'drop', composer, [png(dom)]))
      expect(deps.uploads).toHaveLength(1)
    } finally {
      await dom.cleanup()
    }
  })

  test('pasting an image files it only when focus is not in a text field', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      await render(dom, deps)
      const search = document.querySelector('input')!
      search.focus()
      const intoField = await dom.act(async () => paste(dom, search, png(dom)))
      expect(intoField.defaultPrevented).toBe(false)
      const composer = document.querySelector('textarea')!
      composer.focus()
      await dom.act(async () => void paste(dom, composer, png(dom)))
      expect(deps.uploads).toEqual([])

      // Focus on a chat surface (not a field): the chat handles it, nothing is filed.
      const chatSurface = document.querySelector('[data-drop-scope="chat"]') as HTMLElement
      chatSurface.focus()
      const intoChat = await dom.act(async () =>
        paste(dom, document.querySelector('[data-drop-scope="chat"] p')!, png(dom))
      )
      expect(intoChat.defaultPrevented).toBe(false)
      expect(deps.uploads).toEqual([])

      search.blur()
      composer.blur()
      chatSurface.blur()
      const page = document.querySelector('main p')!
      // Text, not an image: left alone.
      const text = await dom.act(async () => paste(dom, page, null))
      expect(text.defaultPrevented).toBe(false)
      const pasted = await dom.act(async () => paste(dom, page, png(dom)))
      expect(pasted.defaultPrevented).toBe(true)
      await settle(dom, () => deps.filed.length === 1)
    } finally {
      await dom.cleanup()
    }
  })

  test('the toast opens the conversation and "Wrong squad?" posts a correction', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      await render(dom, deps)
      const page = document.querySelector('main p')!
      await dom.act(async () => void paste(dom, page, png(dom)))
      await settle(dom, () => Boolean(toast()?.textContent?.includes('Filing in Chlea')))

      const open = Array.from(toast()!.querySelectorAll('a')).find((link) => link.textContent === 'Open conversation')!
      const href = new URL(open.getAttribute('href')!, 'http://localhost')
      expect(href.pathname).toBe('/squads/x/work')
      expect(href.searchParams.get('chat')).toBe('open')
      expect(href.searchParams.get('assistantConversation')).toBe(filedInChlea.conversationId)

      const wrong = toast()!.querySelector('button[aria-label="Wrong squad?"]') as HTMLButtonElement
      await dom.act(async () => wrong.click())
      const options = Array.from(document.querySelectorAll('[role="option"]'))
      expect(options.map((option) => option.textContent)).toEqual(['Chlea', 'Ops', 'No squad'])
      expect(options[0]!.getAttribute('aria-selected')).toBe('true')
      await dom.act(async () => (options[1] as HTMLElement).click())
      await settle(dom, () => deps.corrections.length === 1)
      expect(deps.corrections[0]).toMatchObject({ conversationId: filedInChlea.conversationId, squadId: ops.id })
      await settle(dom, () => Boolean(toast()?.textContent?.includes('Filing in Ops')))

      const dismiss = toast()!.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement
      await dom.act(async () => dismiss.click())
      expect(toast()).toBeNull()
    } finally {
      await dom.cleanup()
    }
  })

  test('without chat and upload permissions there is no drop or paste target', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      await render(dom, deps, ['chat:send'])
      const page = document.querySelector('main p')!
      await dom.act(async () => void drag(dom, 'dragover', page))
      expect(overlay()).toBeNull()
      const pasted = await dom.act(async () => paste(dom, page, png(dom)))
      expect(pasted.defaultPrevented).toBe(false)
      expect(deps.uploads).toEqual([])
    } finally {
      await dom.cleanup()
    }
  })

  test('the headline says where it is filed, or that the Assistant will look', () => {
    expect(filingHeadline({ status: 'filed', ...filedInChlea })).toBe('Filing in Chlea: looks like a bug')
    expect(
      filingHeadline({
        status: 'filed',
        conversationId: 'c',
        guess: { ...filedInChlea.guess!, squad: null },
      })
    ).toBe('Filing: looks like a bug')
    expect(filingHeadline({ status: 'filed', conversationId: 'c', guess: null })).toBe('Filing with the Assistant')
  })

  test('the detail names the work stream it seems to be part of', () => {
    const workStream = { id: 'w', title: 'Fix the export crash', probability: 0.8 }
    expect(filingDetail({ status: 'filed', conversationId: 'c', guess: { ...filedInChlea.guess!, workStream } })).toBe(
      'Looks like part of “Fix the export crash”. The Assistant checks and adds it there.'
    )
    expect(filingDetail({ status: 'filed', ...filedInChlea })).toBe('The Assistant checks the guess and files it.')
    expect(filingDetail({ status: 'filed', conversationId: 'c', guess: null })).toBe(
      'No guess this time; the Assistant will look at it.'
    )
    expect(filingDetail({ status: 'filed', ...filedInChlea, correctedTo: 'Ops' })).toBe(
      'Told the Assistant where it belongs.'
    )
  })
})
