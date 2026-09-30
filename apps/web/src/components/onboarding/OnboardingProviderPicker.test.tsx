import { fireEvent } from '@testing-library/dom'
import { expect, test } from 'bun:test'
import { useState } from 'react'
import { acquireDomHarness } from '../../test/domHarness'
import { OnboardingProviderPicker, type ProviderPickerOption } from './OnboardingProviderPicker'

// Directory order as ProviderAuthSection builds it: common providers first, OpenAI ahead of Anthropic.
const OPTIONS: ProviderPickerOption[] = [
  { id: 'openai', name: 'OpenAI', description: 'GPT and o-series models' },
  { id: 'anthropic', name: 'Anthropic', description: 'Claude models (Sonnet, Opus, Haiku)' },
  { id: 'openrouter', name: 'OpenRouter', description: 'One account for many models.' },
  { id: 'zai', name: 'Z.ai', description: '12 models available via API key.' },
  { id: 'google', name: 'Google', description: 'Gemini models' },
  { id: 'custom', name: 'Local or custom provider' },
]

async function renderPicker(options = OPTIONS, initial = '') {
  const dom = await acquireDomHarness({ url: 'http://localhost/onboarding' })
  const changes: string[] = []
  function Harness() {
    const [value, setValue] = useState(initial)
    return (
      <OnboardingProviderPicker
        options={options}
        value={value}
        onChange={(id) => {
          changes.push(id)
          setValue(id)
        }}
      />
    )
  }
  const { root, container } = dom.createRoot()
  await dom.act(async () => root.render(<Harness />))
  const document = dom.window.document
  const radios = () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  const moreButton = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
  const openDialog = () => document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]')
  const search = () => openDialog()!.querySelector<HTMLInputElement>('input[type="search"]')!
  const listed = () =>
    [...openDialog()!.querySelectorAll<HTMLButtonElement>('ul button')].map(
      (button) => button.querySelector('.font-medium')!.textContent
    )
  const openMore = () => dom.act(async () => moreButton()!.click())
  const type = (value: string) => dom.act(async () => fireEvent.change(search(), { target: { value } }))
  return { dom, container, document, changes, radios, moreButton, openDialog, search, listed, openMore, type }
}

test('Anthropic and OpenAI render as the primary choices, Anthropic first, and clicking one selects it', async () => {
  const { dom, container, changes, radios, moreButton } = await renderPicker()
  try {
    const group = container.querySelector('[role="radiogroup"]')!
    expect(group.getAttribute('aria-label')).toBe('Choose an AI provider')
    expect(radios().map((radio) => radio.getAttribute('aria-label'))).toEqual(['Anthropic', 'OpenAI'])
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    // The only tab stop in the group is the first card until one is checked.
    expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1])
    expect(container.textContent).toContain('Claude models (Sonnet, Opus, Haiku)')
    expect(container.querySelector('select')).toBeNull()
    expect(moreButton()!.textContent).toContain('More providers')
    expect(moreButton()!.textContent).toContain('Search 4 more options')

    await dom.act(async () => radios()[1]!.click())
    expect(changes).toEqual(['openai'])
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0])

    await dom.act(async () => radios()[0]!.click())
    expect(changes).toEqual(['openai', 'anthropic'])
    expect(radios()[0]!.getAttribute('aria-checked')).toBe('true')
  } finally {
    await dom.cleanup()
  }
})

test('arrow keys move the selection between the primary choices', async () => {
  const { dom, document, changes, radios } = await renderPicker(OPTIONS, 'anthropic')
  try {
    await dom.act(async () => fireEvent.keyDown(radios()[0]!, { key: 'ArrowRight' }))
    expect(changes).toEqual(['openai'])
    expect(document.activeElement).toBe(radios()[1]!)
    await dom.act(async () => fireEvent.keyDown(radios()[1]!, { key: 'ArrowDown' }))
    expect(changes).toEqual(['openai', 'anthropic'])
    expect(document.activeElement).toBe(radios()[0]!)
  } finally {
    await dom.cleanup()
  }
})

test('More providers opens a searchable dialog; choosing one selects it, closes the dialog, and shows it', async () => {
  const { dom, document, changes, radios, moreButton, openDialog, search, listed, openMore, type } =
    await renderPicker()
  try {
    expect(openDialog()).toBeNull()
    await openMore()
    expect(openDialog()!.getAttribute('aria-label')).toBe('More providers')
    expect(document.activeElement).toBe(search())
    // The primary choices are not repeated; the rest keep the directory order.
    expect(listed()).toEqual(['OpenRouter', 'Z.ai', 'Google', 'Local or custom provider'])

    await type('GOO')
    expect(listed()).toEqual(['Google'])
    await type('zai') // matches the id as well as the name
    expect(listed()).toEqual(['Z.ai'])
    await type('router')
    expect(listed()).toEqual(['OpenRouter'])

    await dom.act(async () => openDialog()!.querySelector<HTMLButtonElement>('ul button')!.click())
    expect(changes).toEqual(['openrouter'])
    expect(openDialog()).toBeNull()
    expect(document.activeElement).toBe(moreButton())
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    expect(moreButton()!.textContent).toContain('OpenRouter')
    expect(moreButton()!.textContent).toContain('Change')

    // Reopening starts from a clear search and marks the current choice.
    await openMore()
    expect(search().value).toBe('')
    expect(listed()).toHaveLength(4)
    expect(openDialog()!.querySelector('[aria-current="true"]')!.textContent).toContain('OpenRouter')

    // Choosing a primary card afterwards replaces the "more" choice.
    await dom.act(async () => fireEvent.keyDown(search(), { key: 'Escape' }))
    await dom.act(async () => radios()[0]!.click())
    expect(changes).toEqual(['openrouter', 'anthropic'])
    expect(moreButton()!.textContent).toContain('More providers')
  } finally {
    await dom.cleanup()
  }
})

test('Enter picks the first match, and an unmatched search says so', async () => {
  const { dom, changes, openDialog, search, openMore, type } = await renderPicker()
  try {
    await openMore()
    await type('nothing like this')
    expect(openDialog()!.querySelector('ul')).toBeNull()
    expect(openDialog()!.querySelector('[role="status"]')!.textContent).toBe('No providers match “nothing like this”.')
    await dom.act(async () => fireEvent.keyDown(search(), { key: 'Enter' }))
    expect(changes).toEqual([])
    expect(openDialog()).not.toBeNull()

    await type('o')
    await dom.act(async () => fireEvent.keyDown(search(), { key: 'Enter' }))
    expect(changes).toEqual(['openrouter'])
    expect(openDialog()).toBeNull()
  } finally {
    await dom.cleanup()
  }
})

test('Escape closes the dialog without changing the selection', async () => {
  const { dom, document, changes, radios, moreButton, openDialog, openMore, type } = await renderPicker(
    OPTIONS,
    'anthropic'
  )
  try {
    await openMore()
    await type('goo')
    await dom.act(async () => fireEvent.keyDown(document.activeElement!, { key: 'Escape' }))
    expect(openDialog()).toBeNull()
    expect(changes).toEqual([])
    expect(radios()[0]!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(moreButton())
  } finally {
    await dom.cleanup()
  }
})

test('a provider missing from the directory gets no card', async () => {
  const withoutAnthropic = OPTIONS.filter((option) => option.id !== 'anthropic')
  const { dom, radios, moreButton, openMore, listed } = await renderPicker(withoutAnthropic)
  try {
    expect(radios().map((radio) => radio.getAttribute('aria-label'))).toEqual(['OpenAI'])
    expect(moreButton()).not.toBeNull()
    await openMore()
    expect(listed()).not.toContain('Anthropic')
  } finally {
    await dom.cleanup()
  }
  const primaryOnly = OPTIONS.filter((option) => ['anthropic', 'openai'].includes(option.id))
  const second = await renderPicker(primaryOnly)
  try {
    expect(second.radios()).toHaveLength(2)
    expect(second.moreButton()).toBeNull()
  } finally {
    await second.dom.cleanup()
  }
})
