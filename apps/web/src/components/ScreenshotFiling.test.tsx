import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  type FileScreenshotRequest,
  type FileScreenshotResponse,
  type GuessScreenshotResponse,
  type ScreenshotGuess,
  type Squad,
} from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { webkitTap } from '../test/webkitTap'
import { PermissionsProvider } from '../hooks/usePermissions'
import { queryKeys, screenshotQueryKeys } from '../queryKeys'
import { ScreenshotFiling } from './ScreenshotFiling'

type Harness = Awaited<ReturnType<typeof acquireDomHarness>>

const chlea = { id: '11111111-1111-4111-8111-111111111111', name: 'Chlea', status: 'active' } as Squad
const ops = { id: '22222222-2222-4222-8222-222222222222', name: 'Ops', status: 'active' } as Squad
const empty = { id: '66666666-6666-4666-8666-666666666666', name: 'Docs', status: 'active' } as Squad
const retired = { id: '77777777-7777-4777-8777-777777777777', name: 'Retired', status: 'archived' } as Squad
const exportCrash = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Fix the export crash' }
const rewriteDocs = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Rewrite the docs' }
const rotation = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'On-call rotation' }
const IMAGE_ID = '44444444-4444-4444-8444-444444444444'
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'

/** A bug in Chlea's export work stream; the model was not sure about the squad. */
const bugInChlea: ScreenshotGuess = {
  kind: { id: 'bug', label: 'a bug', probability: 0.88 },
  squad: { id: chlea.id, name: 'Chlea', probability: 0.41 },
  action: { id: 'existing_work_stream', label: 'add it to an existing work stream', probability: 0.83 },
  workStream: { ...exportCrash, probability: 0.83 },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** Fake upload and API. Each call's answer can be replaced to hold it open or fail it. */
function fakes(guess: ScreenshotGuess | null = bugInChlea) {
  const uploads: Array<{ data: string; mimeType: string }> = []
  const guessed: string[] = []
  const filed: FileScreenshotRequest[] = []
  /** The staged uploads the card asked Core to delete. */
  const discarded: string[] = []
  const answers = {
    upload: async (): Promise<string[]> => [IMAGE_ID],
    discard: async (): Promise<void> => {},
    guess: async (): Promise<GuessScreenshotResponse> => ({ guess }),
    file: async (): Promise<FileScreenshotResponse> => ({ conversationId: CONVERSATION_ID }),
  }
  return {
    uploads,
    guessed,
    filed,
    discarded,
    answers,
    dependencies: {
      upload: async (images: Array<{ data: string; mimeType: string }>) => {
        uploads.push(...images)
        return answers.upload()
      },
      discard: async (imageId: string) => {
        discarded.push(imageId)
        return answers.discard()
      },
      api: {
        guess: async (imageId: string) => {
          guessed.push(imageId)
          return answers.guess()
        },
        file: async (request: FileScreenshotRequest) => {
          filed.push(request)
          return answers.file()
        },
      },
    },
  }
}

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

async function render(dom: Harness, deps: ReturnType<typeof fakes>, permissions = ['chat:send', 'agents:write']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.squads.list(), [chlea, ops, empty, retired])
  client.setQueryData(screenshotQueryKeys.workStreams(chlea.id), { workStreams: [exportCrash, rewriteDocs] })
  client.setQueryData(screenshotQueryKeys.workStreams(ops.id), { workStreams: [rotation] })
  client.setQueryData(screenshotQueryKeys.workStreams(empty.id), { workStreams: [] })
  const { root } = dom.createRoot()
  const app = (filing: boolean) => (
    <MemoryRouter initialEntries={['/squads/x/work?tab=open']}>
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
          <Where />
          {filing && <ScreenshotFiling dependencies={deps.dependencies as never} />}
        </PermissionsProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
  await dom.act(async () => root.render(app(true)))
  /** Unmount the feature, as the app does on sign-out. */
  return { unmount: () => dom.act(async () => root.render(app(false))) }
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
const card = () => document.querySelector('[data-testid="screenshot-review-card"]')
const where = () => new URL(document.querySelector('[data-testid="where"]')!.textContent!, 'http://localhost')
const note = () => card()!.querySelector('textarea') as HTMLTextAreaElement
const picker = (name: string) => card()!.querySelector(`button[aria-label^="${name}:"]`) as HTMLButtonElement | null
/** What a picker shows, e.g. "A bug"; null while it is loading or not shown. */
const shown = (name: string) => picker(name)?.textContent ?? null
const button = (label: string) =>
  Array.from(card()!.querySelectorAll('button')).find((candidate) => candidate.textContent === label) as
    HTMLButtonElement | undefined
const options = () =>
  Array.from(document.querySelectorAll('[role="listbox"]:not([data-state="closed"]) [role="option"]'))
/** The fields marked "not sure", by their row name. */
const unsure = () =>
  Array.from(card()!.querySelectorAll('span'))
    .filter((mark) => mark.textContent === 'not sure')
    .map((mark) => mark.parentElement!.previousElementSibling!.textContent)

async function type(dom: Harness, text: string) {
  await dom.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(note(), text)
    note().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

async function pick(dom: Harness, name: string, label: string) {
  await dom.act(async () => picker(name)!.click())
  const option = options().find((candidate) => candidate.textContent?.startsWith(label)) as HTMLElement
  expect(option).toBeDefined()
  await dom.act(async () => option.click())
}

/** Drop an image on the page and wait for its card. */
async function dropImage(dom: Harness) {
  const page = document.querySelector('main p')!
  const dropped = await dom.act(async () => drag(dom, 'drop', page, [png(dom)]))
  await settle(dom, () => card() !== null)
  return dropped
}

// The harness's files are happy-dom's, which the runtime's own URL.createObjectURL does not take.
const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL
let previews: string[] = []
let revoked: string[] = []
beforeEach(() => {
  previews = []
  revoked = []
  URL.createObjectURL = () => {
    previews.push(`blob:preview-${previews.length + 1}`)
    return previews.at(-1)!
  }
  URL.revokeObjectURL = (url) => void revoked.push(url)
})
afterEach(() => {
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
})

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

  test('dropping an image shows the review card at once, with the note focused while the guess loads', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      const upload = deferred<string[]>()
      const guess = deferred<GuessScreenshotResponse>()
      deps.answers.upload = () => upload.promise
      deps.answers.guess = () => guess.promise
      await render(dom, deps)
      const page = document.querySelector('main p')!
      await dom.act(async () => void drag(dom, 'dragover', page))
      const dropped = await dropImage(dom)
      expect(dropped.defaultPrevented).toBe(true)
      expect(overlay()).toBeNull()

      // The card is there before the upload finishes: thumbnail, focused note, loading fields.
      expect(card()!.querySelector('img')!.getAttribute('src')).toBe('blob:preview-1')
      expect(document.activeElement).toBe(note())
      expect(card()!.textContent).toContain('Uploading…')
      for (const name of ['Kind', 'Squad', 'Action']) expect(picker(name)).toBeNull()
      expect(button('File it')!.disabled).toBe(true)
      await settle(dom, () => deps.uploads.length === 1)
      expect(deps.uploads).toEqual([
        { type: 'image', data: btoa(String.fromCharCode(...PNG_BYTES)), mimeType: 'image/png' },
      ] as never)

      // Uploaded: the guess is asked for, and the user can already type.
      await dom.act(async () => upload.resolve([IMAGE_ID]))
      await settle(dom, () => deps.guessed.length === 1)
      expect(deps.guessed).toEqual([IMAGE_ID])
      expect(card()!.textContent).toContain('Guessing what it is and where it belongs…')
      expect(picker('Kind')).toBeNull()
      await type(dom, 'Broke after the coupon change')

      // The guess fills the pickers in, marks the weak one, and keeps the note.
      await dom.act(async () => guess.resolve({ guess: bugInChlea }))
      await settle(dom, () => shown('Kind') === 'A bug')
      expect(shown('Squad')).toBe('Chlea')
      expect(shown('Action')).toBe('Add it to an existing work stream')
      expect(shown('Work stream')).toBe('Fix the export crash')
      expect(unsure()).toEqual(['Squad'])
      expect(note().value).toBe('Broke after the coupon change')
      expect(card()!.textContent).toContain('Check the guess, add a note, then file it.')
      // Nothing has been filed, and nothing navigated.
      expect(deps.filed).toEqual([])
      expect(where().searchParams.get('assistantConversation')).toBeNull()

      // A drop on the composer is the composer's.
      const composer = document.querySelector('textarea[aria-label="Composer"]')!
      await dom.act(async () => void drag(dom, 'drop', composer, [png(dom)]))
      expect(deps.uploads).toHaveLength(1)
    } finally {
      await dom.cleanup()
    }
  })

  test('pasting an image opens the card only when focus is not in a text field', async () => {
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
      await settle(dom, () => shown('Kind') === 'A bug')
      expect(deps.filed).toEqual([])

      // With the card open, a paste into its note is text: no second screenshot.
      const intoNote = await dom.act(async () => paste(dom, note(), png(dom)))
      expect(intoNote.defaultPrevented).toBe(false)
      expect(deps.uploads).toHaveLength(1)
    } finally {
      await dom.cleanup()
    }
  })

  test('every field is editable; changing the squad reloads its work streams and applies the fallback', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => shown('Work stream') === 'Fix the export crash')

      // Kind.
      await dom.act(async () => picker('Kind')!.click())
      expect(options().map((option) => option.getAttribute('aria-label'))).toEqual([
        'A bug',
        'Design feedback',
        'An error message or log',
        'An idea or feature request',
        'A reference',
      ])
      expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
      await dom.act(async () => (options()[2] as HTMLElement).click())
      expect(shown('Kind')).toBe('An error message or log')

      // Squad: visible squads that are not archived, plus "No squad".
      await dom.act(async () => picker('Squad')!.click())
      expect(options().map((option) => option.textContent)).toEqual(['Chlea', 'Ops', 'Docs', 'No squad'])
      await dom.act(async () => (options()[1] as HTMLElement).click())
      // Another squad: its own open work streams, none selected, and no longer "not sure".
      expect(shown('Squad')).toBe('Ops')
      expect(unsure()).toEqual([])
      await settle(dom, () => shown('Work stream') === 'Choose a work stream')
      await dom.act(async () => picker('Work stream')!.click())
      expect(options().map((option) => option.textContent)).toEqual(['On-call rotation'])
      await dom.act(async () => (options()[0] as HTMLElement).click())
      expect(shown('Work stream')).toBe('On-call rotation')
      expect(shown('Action')).toBe('Add it to an existing work stream')

      // A squad with no open work streams: fall back to a new one, and hide the work stream picker.
      await pick(dom, 'Squad', 'Docs')
      await settle(dom, () => shown('Action') === 'Start a new work stream')
      expect(picker('Work stream')).toBeNull()
      await dom.act(async () => picker('Action')!.click())
      const existing = options().find(
        (option) => option.getAttribute('aria-label') === 'Add it to an existing work stream'
      )
      expect((existing as HTMLButtonElement).disabled).toBe(true)
      expect(existing!.textContent).toContain('This squad has no open work streams.')
      await dom.act(async () => (options()[3] as HTMLElement).click())
      expect(shown('Action')).toBe('Just save it')

      // Back to a squad with work streams and the "existing" action, then "No squad": the fallback again.
      await pick(dom, 'Squad', 'Chlea')
      await pick(dom, 'Action', 'Add it to an existing work stream')
      await settle(dom, () => shown('Work stream') === 'Choose a work stream')
      await pick(dom, 'Squad', 'No squad')
      expect(shown('Action')).toBe('Start a new work stream')
      expect(picker('Work stream')).toBeNull()
      // The guess was asked for once: changing fields never asks the decision model again.
      expect(deps.guessed).toHaveLength(1)
      expect(deps.filed).toEqual([])
    } finally {
      await dom.cleanup()
    }
  })

  test('a weak work stream guess is "not sure": pre-selected with the "existing" action, otherwise only once the user turns to it', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const { workStream: _sure, ...unsureOfStream } = bugInChlea
      // The action question answered "existing"; the work stream question was not sure which one.
      const deps = fakes({
        ...unsureOfStream,
        squad: { id: chlea.id, name: 'Chlea', probability: 0.9 },
        workStream: null,
        workStreamSuggestion: { ...exportCrash, probability: 0.45 },
      })
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => shown('Work stream') === 'Fix the export crash')
      expect(shown('Action')).toBe('Add it to an existing work stream')
      expect(unsure()).toEqual(['Work stream'])
      // Picking a stream by hand removes the mark.
      await pick(dom, 'Work stream', 'Rewrite the docs')
      expect(shown('Work stream')).toBe('Rewrite the docs')
      expect(unsure()).toEqual([])
      await dom.act(async () => button('Dismiss')!.click())
      expect(card()).toBeNull()

      // The action question answered something else: the card shows no work stream, and nothing "not sure".
      deps.answers.guess = async () => ({
        guess: {
          ...unsureOfStream,
          squad: { id: chlea.id, name: 'Chlea', probability: 0.9 },
          action: { id: 'new_work_stream', label: 'start a new work stream', probability: 0.7 },
          workStream: null,
          workStreamSuggestion: { ...exportCrash, probability: 0.45 },
        },
      })
      await dropImage(dom)
      await settle(dom, () => shown('Action') === 'Start a new work stream')
      expect(picker('Work stream')).toBeNull()
      expect(unsure()).toEqual([])
      // The user turns to "existing" in the guessed squad: the picker is pre-filled with it, marked.
      await pick(dom, 'Action', 'Add it to an existing work stream')
      expect(shown('Work stream')).toBe('Fix the export crash')
      expect(unsure()).toEqual(['Work stream'])
      // Another squad: the suggestion goes with the mark, and does not come back with the squad.
      await pick(dom, 'Squad', 'Ops')
      await settle(dom, () => shown('Work stream') === 'Choose a work stream')
      expect(unsure()).toEqual([])
      await pick(dom, 'Squad', 'Chlea')
      await settle(dom, () => shown('Work stream') === 'Choose a work stream')
      expect(unsure()).toEqual([])

      await dom.act(async () => button('File it')!.click())
      await settle(dom, () => card() === null)
      // It was shown, so it is part of what the card was filled in with.
      expect(deps.filed).toEqual([
        {
          imageId: IMAGE_ID,
          kind: 'bug',
          squadId: chlea.id,
          action: 'existing_work_stream',
          guessed: { kind: 'bug', squadId: chlea.id, action: 'new_work_stream', workStreamId: exportCrash.id },
        },
      ])
    } finally {
      await dom.cleanup()
    }
  })

  test('"File it" files the note and the confirmed choices, closes the card and opens the conversation', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => shown('Work stream') === 'Fix the export crash')
      await type(dom, '  The total shows NaN  ')
      await pick(dom, 'Kind', 'An error message or log')
      await pick(dom, 'Work stream', 'Rewrite the docs')
      expect(deps.filed).toEqual([])

      // A WebKit tap: the focused note blurs to nothing before the click, which must still arrive.
      note().focus()
      expect(await webkitTap(button('File it')!)).toBe(true)
      await settle(dom, () => card() === null)
      expect(deps.filed).toEqual([
        {
          imageId: IMAGE_ID,
          note: 'The total shows NaN',
          kind: 'error_message',
          squadId: chlea.id,
          action: 'existing_work_stream',
          workStreamId: rewriteDocs.id,
          guessed: {
            kind: 'bug',
            squadId: chlea.id,
            action: 'existing_work_stream',
            workStreamId: exportCrash.id,
          },
        },
      ])
      expect(revoked).toEqual(['blob:preview-1'])
      // A filed screenshot's image is the conversation's now: it is never deleted.
      expect(deps.discarded).toEqual([])
      // The same page, with the new Assistant conversation open.
      expect(where().pathname).toBe('/squads/x/work')
      expect(where().searchParams.get('tab')).toBe('open')
      expect(where().searchParams.get('chat')).toBe('open')
      expect(where().searchParams.get('assistantConversation')).toBe(CONVERSATION_ID)

      // The card is gone, so the next drop gets a card of its own.
      await dropImage(dom)
      expect(note().value).toBe('')
      expect(deps.uploads).toHaveLength(2)
    } finally {
      await dom.cleanup()
    }
  })

  test('Ctrl or ⌘ + Enter in the note files it; a WebKit tap on a picker option commits it', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'A bug')
      note().focus()
      await dom.act(async () => picker('Kind')!.click())
      expect(await webkitTap(options()[4]!)).toBe(true)
      expect(shown('Kind')).toBe('A reference')

      await type(dom, 'For the mood board')
      const enter = (init: KeyboardEventInit) =>
        dom.act(async () => {
          const event = new dom.window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
            ...init,
          })
          note().dispatchEvent(event as unknown as Event)
          return event
        })
      // A plain Enter is a new line in the note.
      expect((await enter({})).defaultPrevented).toBe(false)
      expect(deps.filed).toEqual([])
      expect((await enter({ metaKey: true })).defaultPrevented).toBe(true)
      await settle(dom, () => card() === null)
      expect(deps.filed).toHaveLength(1)
      expect(deps.filed[0]).toMatchObject({ note: 'For the mood board', kind: 'reference' })
    } finally {
      await dom.cleanup()
    }
  })

  test('dismissing files nothing and deletes the upload', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'A bug')
      await type(dom, 'Never mind')
      expect(revoked).toEqual([])
      expect(deps.discarded).toEqual([])
      await dom.act(async () => button('Dismiss')!.click())
      expect(card()).toBeNull()
      expect(deps.filed).toEqual([])
      expect(deps.discarded).toEqual([IMAGE_ID])
      expect(where().search).toBe('?tab=open')
      // The thumbnail's object URL is released with the card.
      expect(revoked).toEqual(['blob:preview-1'])
      // Clicking elsewhere on the page is not a dismissal: the note would be lost.
      await dropImage(dom)
      await type(dom, 'Keep me')
      await webkitTap(document.querySelector('main p')!)
      expect(note().value).toBe('Keep me')
    } finally {
      await dom.cleanup()
    }
  })

  test('dismissing a card whose filing failed deletes the upload; a filed one is never deleted', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      deps.answers.upload = async () => ['first-image']
      deps.answers.file = async () => {
        throw new Error("The Assistant's model cannot read images.")
      }
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'A bug')
      await dom.act(async () => button('File it')!.click())
      await settle(dom, () => card()!.querySelector('[role="alert"]') !== null)
      // Still on the card for another try: nothing is deleted yet.
      expect(deps.discarded).toEqual([])
      await dom.act(async () => button('Dismiss')!.click())
      expect(card()).toBeNull()
      expect(deps.discarded).toEqual(['first-image'])

      // A failed try followed by one that files: the image stays.
      deps.answers.upload = async () => ['second-image']
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'A bug')
      await dom.act(async () => button('File it')!.click())
      await settle(dom, () => button('Try again') !== undefined)
      deps.answers.file = async () => ({ conversationId: CONVERSATION_ID })
      await dom.act(async () => button('Try again')!.click())
      await settle(dom, () => card() === null)
      expect(deps.filed.map((request) => request.imageId)).toEqual(['first-image', 'second-image', 'second-image'])
      expect(deps.discarded).toEqual(['first-image'])
    } finally {
      await dom.cleanup()
    }
  })

  test('a delete that fails is silent: the card closes and the next screenshot works', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      deps.answers.discard = async () => {
        throw new Error('Image not found')
      }
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'A bug')
      await dom.act(async () => button('Dismiss')!.click())
      expect(deps.discarded).toEqual([IMAGE_ID])
      expect(card()).toBeNull()
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(document.body.textContent).not.toContain('Image not found')

      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'A bug')
      expect(note().value).toBe('')
    } finally {
      await dom.cleanup()
    }
  })

  test('an upload that finishes after its card was dismissed is deleted, and never guessed', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      const upload = deferred<string[]>()
      deps.answers.upload = () => upload.promise
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => deps.uploads.length === 1)
      await dom.act(async () => button('Dismiss')!.click())
      expect(card()).toBeNull()
      // Nothing to delete until the upload has an image.
      expect(deps.discarded).toEqual([])
      await dom.act(async () => upload.resolve(['late-image']))
      await settle(dom, () => deps.discarded.length === 1)
      expect(deps.discarded).toEqual(['late-image'])
      expect(deps.guessed).toEqual([])
      expect(card()).toBeNull()

      // An upload that failed left no image: dismissing its card deletes nothing.
      deps.answers.upload = async () => {
        throw new Error('Network error during upload')
      }
      await dropImage(dom)
      await settle(dom, () => card()!.querySelector('[role="alert"]') !== null)
      await dom.act(async () => button('Dismiss')!.click())
      expect(card()).toBeNull()
      expect(deps.discarded).toEqual(['late-image'])
    } finally {
      await dom.cleanup()
    }
  })

  test('unmounting with a card open deletes its upload, but never one whose filing is still in flight', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      // A card under review when the feature unmounts.
      const reviewing = fakes()
      const first = await render(dom, reviewing)
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'A bug')
      await first.unmount()
      expect(card()).toBeNull()
      expect(reviewing.discarded).toEqual([IMAGE_ID])
      expect(revoked).toEqual(['blob:preview-1'])

      // Unmounted while it files: the image may be filed, so it is kept until the filing fails.
      const failing = fakes()
      const refused = deferred<FileScreenshotResponse>()
      failing.answers.file = () => refused.promise
      const second = await render(dom, failing)
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'A bug')
      await dom.act(async () => button('File it')!.click())
      await settle(dom, () => failing.filed.length === 1)
      await second.unmount()
      expect(failing.discarded).toEqual([])
      await dom.act(async () => refused.reject(new Error('Network error')))
      await settle(dom, () => failing.discarded.length === 1)
      expect(failing.discarded).toEqual([IMAGE_ID])

      // And when that filing succeeds, the image is never deleted.
      const filing = fakes()
      const accepted = deferred<FileScreenshotResponse>()
      filing.answers.file = () => accepted.promise
      const third = await render(dom, filing)
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'A bug')
      await dom.act(async () => button('File it')!.click())
      await settle(dom, () => filing.filed.length === 1)
      await third.unmount()
      await dom.act(async () => accepted.resolve({ conversationId: CONVERSATION_ID }))
      await dom.act(async () => await Promise.resolve())
      expect(filing.discarded).toEqual([])
    } finally {
      await dom.cleanup()
    }
  })

  test('with no guess the card still opens, with unselected pickers, and files with only a note', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      // The feature is off, or no decision model answered.
      const deps = fakes(null)
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'Choose what it is')
      expect(shown('Squad')).toBe('Choose a squad')
      expect(shown('Action')).toBe('Choose what to do')
      expect(picker('Work stream')).toBeNull()
      expect(unsure()).toEqual([])
      expect(card()!.textContent).toContain('No guess this time. Pick what you know, or just add a note.')

      // "Existing" before a squad is chosen asks for the squad first.
      await pick(dom, 'Action', 'Add it to an existing work stream')
      expect(card()!.textContent).toContain('Choose a squad to pick one of its work streams.')
      await pick(dom, 'Squad', 'Ops')
      await settle(dom, () => shown('Work stream') === 'Choose a work stream')
      await pick(dom, 'Work stream', 'On-call rotation')
      await type(dom, 'Pager screenshot')
      await dom.act(async () => button('File it')!.click())
      await settle(dom, () => card() === null)
      expect(deps.filed).toEqual([
        {
          imageId: IMAGE_ID,
          note: 'Pager screenshot',
          squadId: ops.id,
          action: 'existing_work_stream',
          workStreamId: rotation.id,
        },
      ])

      // The guess call failing is no guess either, and a note alone is enough.
      deps.answers.guess = async () => {
        throw new Error('decision provider down')
      }
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'Choose what it is')
      await type(dom, 'Just this')
      await dom.act(async () => button('File it')!.click())
      await settle(dom, () => deps.filed.length === 2)
      expect(deps.filed[1]).toEqual({ imageId: IMAGE_ID, note: 'Just this' })
    } finally {
      await dom.cleanup()
    }
  })

  test('filing does not wait for a slow guess', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      deps.answers.guess = () => deferred<GuessScreenshotResponse>().promise
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => button('File it')!.disabled === false)
      expect(picker('Kind')).toBeNull()
      await type(dom, 'No time to wait')
      await dom.act(async () => button('File it')!.click())
      await settle(dom, () => card() === null)
      expect(deps.filed).toEqual([{ imageId: IMAGE_ID, note: 'No time to wait' }])
    } finally {
      await dom.cleanup()
    }
  })

  test('a failed confirm keeps the note and the choices on the card for another try', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      const first = deferred<FileScreenshotResponse>()
      deps.answers.file = () => first.promise
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'A bug')
      await type(dom, 'Broke after the coupon change')
      await pick(dom, 'Squad', 'Ops')
      await settle(dom, () => shown('Work stream') === 'Choose a work stream')
      await dom.act(async () => button('File it')!.click())

      // While it files, nothing on the card can change and it cannot be dismissed or sent twice.
      await settle(dom, () => Boolean(card()!.textContent?.includes('Filing…')))
      expect(button('File it')!.disabled).toBe(true)
      expect(button('Dismiss')!.disabled).toBe(true)
      expect(note().disabled).toBe(true)
      expect(picker('Squad')!.disabled).toBe(true)

      await dom.act(async () => first.reject(new Error("The Assistant's model cannot read images.")))
      await settle(dom, () => card()!.querySelector('[role="alert"]') !== null)
      expect(card()!.querySelector('[role="alert"]')!.textContent).toBe(
        "Couldn't file the screenshot: The Assistant's model cannot read images. Your note and choices are still here."
      )
      expect(note().value).toBe('Broke after the coupon change')
      expect(shown('Squad')).toBe('Ops')
      expect(shown('Kind')).toBe('A bug')
      expect(where().searchParams.get('assistantConversation')).toBeNull()

      // The retry sends the same image and choices, so Core lands it on the same conversation.
      deps.answers.file = async () => ({ conversationId: CONVERSATION_ID })
      await dom.act(async () => button('Try again')!.click())
      await settle(dom, () => card() === null)
      expect(deps.filed).toHaveLength(2)
      expect(deps.filed[1]).toEqual(deps.filed[0]!)
      expect(deps.filed[1]).toMatchObject({ imageId: IMAGE_ID, note: 'Broke after the coupon change', squadId: ops.id })
      expect(deps.uploads).toHaveLength(1)
      expect(where().searchParams.get('assistantConversation')).toBe(CONVERSATION_ID)
    } finally {
      await dom.cleanup()
    }
  })

  test('a failed upload can be retried without losing the note; an oversized image is only reported', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      deps.answers.upload = async () => {
        throw new Error('Network error during upload')
      }
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => card()!.querySelector('[role="alert"]') !== null)
      expect(card()!.querySelector('[role="alert"]')!.textContent).toContain(
        "Couldn't upload the screenshot: Network error during upload"
      )
      expect(button('File it')!.disabled).toBe(true)
      expect(deps.guessed).toEqual([])
      await type(dom, 'Typed while it failed')
      deps.answers.upload = async () => [IMAGE_ID]
      await dom.act(async () => button('Retry')!.click())
      await settle(dom, () => shown('Kind') === 'A bug')
      expect(note().value).toBe('Typed while it failed')
      expect(deps.uploads).toHaveLength(2)
      await dom.act(async () => button('Dismiss')!.click())

      // Too large: nothing is uploaded, and the message can be dismissed or replaced by another drop.
      const page = document.querySelector('main p')!
      const huge = png(dom)
      Object.defineProperty(huge, 'size', { value: MAX_IMAGE_ATTACHMENT_BYTES + 1 })
      await dom.act(async () => void drag(dom, 'drop', page, [huge]))
      const rejected = () => document.querySelector('[data-testid="screenshot-rejected"]')
      expect(rejected()!.textContent).toContain(
        `Screenshots can be up to ${MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024} MB.`
      )
      expect(card()).toBeNull()
      expect(deps.uploads).toHaveLength(2)
      await dropImage(dom)
      expect(rejected()).toBeNull()
      await dom.act(async () => button('Dismiss')!.click())
      await dom.act(async () => void drag(dom, 'drop', page, [huge]))
      await dom.act(async () => (rejected()!.querySelector('button') as HTMLButtonElement).click())
      expect(rejected()).toBeNull()
      expect(deps.filed).toEqual([])
    } finally {
      await dom.cleanup()
    }
  })

  test('a second drop while a card is open is ignored with a visible hint, and the first is kept', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const deps = fakes()
      await render(dom, deps)
      await dropImage(dom)
      await settle(dom, () => shown('Kind') === 'A bug')
      await type(dom, 'The first one')
      await pick(dom, 'Kind', 'Design feedback')

      const page = document.querySelector('main p')!
      await dom.act(async () => void drag(dom, 'dragenter', page))
      expect(overlay()!.textContent).toContain('Finish the open screenshot first')
      const second = await dom.act(async () => drag(dom, 'drop', page, [png(dom)]))
      // Still taken from the browser, which would otherwise open the image and leave the app.
      expect(second.defaultPrevented).toBe(true)
      expect(card()!.textContent).toContain(
        'That image was not added. File or dismiss this screenshot first, then drop it again.'
      )
      expect(note().value).toBe('The first one')
      expect(shown('Kind')).toBe('Design feedback')
      expect(deps.uploads).toHaveLength(1)
      expect(deps.guessed).toHaveLength(1)
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
})
