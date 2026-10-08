import { afterEach, expect, test } from 'bun:test'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../../test/domHarness'
import { webkitTap } from '../../test/webkitTap'
import { SettingsNavigation } from './SettingsNavigation'
import { SettingsSearchDestination } from './SettingsSearchDestination'
import { matchesSetting, SETTINGS_SEARCH_ENTRIES } from './settingsSearch'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
const groups = [
  {
    items: [
      { id: 'general', label: 'General' },
      { id: 'account', label: 'Account' },
      { id: 'sessions', label: 'Sessions' },
    ],
  },
  { label: 'AI & workspace', items: [{ id: 'providers', label: 'AI Providers' }] },
]
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

async function setup(allowed = groups, scopeTitle?: string) {
  dom = await acquireDomHarness({ url: 'http://localhost/settings' })
  const calls: Array<[string, string | undefined]> = []
  const { container, root } = dom.createRoot()
  function Harness() {
    const [section, setSection] = useState('general')
    return (
      <MemoryRouter>
        <SettingsNavigation
          groups={allowed}
          scopeTitle={scopeTitle}
          activeSection={section}
          onSectionChange={(id, target) => {
            calls.push([id, target])
            setSection(id)
          }}
          showOnboardingLink={false}
        />
      </MemoryRouter>
    )
  }
  await dom.act(async () => root.render(<Harness />))
  const sidebar = container.querySelector('aside')!
  const search = async (query: string) => {
    await dom!.act(async () => {
      const input = sidebar.querySelector('input')!
      Object.getOwnPropertyDescriptor(dom!.window.HTMLInputElement.prototype, 'value')!.set!.call(input, query)
      input.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
    })
  }
  return { calls, container, sidebar, search }
}

test('keeps personal settings clean and finds fields across permitted administration pages', async () => {
  const { sidebar, search, calls } = await setup()
  expect(sidebar.textContent).toContain('Sessions')
  expect(sidebar.textContent).not.toContain('AI Providers')
  await search('server url')
  const result = [...sidebar.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Server URL'))!
  expect(result.textContent).toContain('Administration → AI Providers')
  await dom!.act(async () => result.click())
  expect(calls.at(-1)).toEqual(['providers', 'server-url'])
  expect(sidebar.querySelector('input')?.value).toBe('')
  expect(sidebar.textContent).toContain('AI Providers')
  expect(sidebar.textContent).not.toContain('Sessions')
})

for (const scopeTitle of [undefined, 'Squad settings']) {
  test(`settings search keyboard navigation (${scopeTitle ?? 'global'})`, async () => {
    const { sidebar, search, calls } = await setup(
      [
        {
          items: [
            { id: 'alpha', label: 'Alpha' },
            { id: 'beta', label: 'Beta' },
            { id: 'gamma', label: 'Gamma' },
          ],
        },
      ],
      scopeTitle
    )
    const input = sidebar.querySelector('input')!
    const key = async (key: string) =>
      dom!.act(async () => {
        input.focus()
        input.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    await search('a')
    const selected = () => sidebar.querySelector('[aria-selected="true"]')!
    expect(selected().textContent).toContain('Alpha')
    await key('ArrowDown')
    expect(selected().textContent).toContain('Beta')
    expect(dom!.window.document.activeElement).toBe(input)
    expect(input.getAttribute('aria-activedescendant')).toBe(selected().id)
    await key('ArrowUp')
    await key('ArrowUp')
    expect(selected().textContent).toContain('Gamma')
    await key('ArrowDown')
    await key('ArrowDown')
    await key('Enter')
    expect(calls.at(-1)).toEqual(['beta', undefined])
    await search('a')
    expect(selected().textContent).toContain('Alpha')
    await key('ArrowDown')
    await search('gamma')
    expect(selected().textContent).toContain('Gamma')
    await key('Enter')
    expect(calls.at(-1)).toEqual(['gamma', undefined])
    await search('no match exists')
    await key('ArrowDown')
    await key('Enter')
    expect(calls).toHaveLength(2)
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)
  })
}

test('matches aliases and field labels without exposing unavailable pages', async () => {
  const { sidebar, search, calls } = await setup([groups[0]])
  await search('face id')
  const passkeys = [...sidebar.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Passkeys'))!
  await dom!.act(async () => passkeys.click())
  expect(calls.at(-1)).toEqual(['account', 'passkeys'])
  await search('server url')
  expect(sidebar.textContent).toContain('No settings match')
  expect(sidebar.textContent).not.toContain('Administration')
})

test('matches punctuation-insensitive multiword queries and retains page-title matches', () => {
  expect(matchesSetting('AI providers', 'AI Providers')).toBe(true)
  expect(matchesSetting('auto update', 'Auto-update local k3d install')).toBe(true)
  expect(matchesSetting('update banana', 'Auto-update local k3d install')).toBe(false)
})

test('every indexed destination has a stable source anchor', () => {
  const sources = [
    join(import.meta.dir, '..', 'SettingsPage.tsx'),
    join(import.meta.dir, 'ThemeControl.tsx'),
    join(import.meta.dir, 'RelayConnectionSettings.tsx'),
    ...readdirSync(import.meta.dir)
      .filter((name) => name.endsWith('Section.tsx'))
      .map((name) => join(import.meta.dir, name)),
  ]
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    if (entry.id.startsWith('secret-')) {
      expect(sources).toContain('data-setting-target={`secret-${secret.key.toLowerCase()}`}')
    } else if (['realtime-assistant', 'voice-dictation', 'automatic-embeddings'].includes(entry.id)) {
      expect(sources).toContain(`target: '${entry.id}'`)
      expect(sources).toContain('data-setting-target={feature.target}')
    } else expect(sources).toContain(`data-setting-target="${entry.id}"`)
  }
})

test('a direct field link waits for loaded content, reveals and focuses it without editing values', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/settings' })
  const { container, root } = dom.createRoot()
  const render = (loaded: boolean, target = 'passkeys') => (
    <SettingsSearchDestination section="account" target={target}>
      {loaded ? (
        <details>
          <summary>Security</summary>
          <h4 data-setting-target="passkeys">Passkeys</h4>
          <input defaultValue="unchanged" />
        </details>
      ) : (
        <p>Loading</p>
      )}
    </SettingsSearchDestination>
  )
  await dom.act(async () => root.render(render(false)))
  const focused = new Promise<void>((resolve) =>
    container.addEventListener('focus', () => resolve(), { once: true, capture: true })
  )
  await dom.act(async () => {
    root.render(render(true))
  })
  await dom.act(async () => {
    await focused
  })
  const heading = container.querySelector('h4')!
  expect(container.querySelector('details')?.open).toBe(true)
  expect(dom.window.document.activeElement).toBe(heading)
  expect(heading.hasAttribute('data-setting-highlight')).toBe(true)
  expect(container.querySelector('input')?.value).toBe('unchanged')
  await dom.act(async () => root.render(render(true, 'other')))
  expect(heading.hasAttribute('data-setting-highlight')).toBe(false)
  expect(heading.hasAttribute('tabindex')).toBe(false)
})

test('phone settings chooser dismisses with Escape and restores its trigger focus', async () => {
  const { container } = await setup()
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Choose settings section"]')!
  await dom!.act(async () => trigger.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(dom!.window.document.activeElement?.tagName).toBe('INPUT')
  await dom!.act(async () =>
    dom!.window.document.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(dom!.window.document.activeElement).toBe(trigger)
})

test('squad field destinations have anchors and use the squad search scope', async () => {
  const { SQUAD_SETTINGS_SEARCH } = await import('../squads/squadSettingsSearch')
  const directory = join(import.meta.dir, '..', 'squads')
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => readFileSync(join(directory, name), 'utf8'))
    .join('\n')
  for (const entry of SQUAD_SETTINGS_SEARCH) expect(sources).toContain(`data-setting-target="${entry.id}"`)
  dom = await acquireDomHarness({})
  const { container, root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <MemoryRouter>
        <SettingsNavigation
          groups={[{ label: 'Workspace', items: [{ id: 'memory', label: 'Memory' }] }]}
          activeSection="memory"
          onSectionChange={() => {}}
          scopeTitle="Squad settings"
          showOnboardingLink={false}
          searchEntries={SQUAD_SETTINGS_SEARCH}
        />
      </MemoryRouter>
    )
  )
  expect(container.textContent).toContain('Squad settings')
  expect(container.textContent).not.toContain('Administration')
  expect(container.querySelector('aside')?.textContent).toContain('Memory')
})

test('a field link opens only its declared editor before focusing the field', async () => {
  dom = await acquireDomHarness({})
  const { container, root } = dom.createRoot()
  function Editor() {
    const [editing, setEditing] = useState(false)
    return (
      <SettingsSearchDestination section="memory" target="include-patterns">
        {editing ? (
          <label data-setting-target="include-patterns">
            Include patterns
            <input defaultValue="src/**" />
          </label>
        ) : (
          <button data-setting-reveal="include-patterns" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </SettingsSearchDestination>
    )
  }
  const focused = new Promise<void>((resolve) =>
    container.addEventListener('focus', () => resolve(), { capture: true, once: true })
  )
  await dom.act(async () => root.render(<Editor />))
  await dom.act(async () => {
    await focused
  })
  expect(dom.window.document.activeElement?.getAttribute('data-setting-target')).toBe('include-patterns')
  expect(container.querySelector('input')?.value).toBe('src/**')
})

test('phone settings chooser stays open across areas and closes on a page selection', async () => {
  const { container, calls } = await setup()
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Choose settings section"]')!
  const mobile = trigger.parentElement!
  const button = (label: string) =>
    [...mobile.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!
  await dom!.act(async () => trigger.click())
  await dom!.act(async () => button('Administration').click())
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(mobile.querySelector('[aria-label="Administration sections"]')).not.toBeNull()
  await dom!.act(async () => button('Personal').click())
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(mobile.querySelector('[aria-label="Personal settings sections"]')).not.toBeNull()
  await dom!.act(async () => button('Account').click())
  expect(calls.at(-1)).toEqual(['account', undefined])
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

// On a phone the search field holds focus when the chooser opens. A Safari/iOS tap on an area tab or a page
// blurs it to nothing (buttons never take focus), and must still switch the area or choose the page.
test('phone settings chooser handles WebKit taps, outside taps and Tab out', async () => {
  const { container, calls } = await setup()
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Choose settings section"]')!
  const mobile = trigger.parentElement!
  const button = (label: string) =>
    [...mobile.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!
  await dom!.act(async () => trigger.click())
  expect(dom!.window.document.activeElement?.tagName).toBe('INPUT')
  expect(await webkitTap(button('Administration'), { touch: true })).toBe(true)
  expect(mobile.querySelector('[aria-label="Administration sections"]')).not.toBeNull()
  expect(await webkitTap(button('Personal'))).toBe(true)
  expect(await webkitTap(button('Account'))).toBe(true)
  expect(calls.at(-1)).toEqual(['account', undefined])
  expect(trigger.getAttribute('aria-expanded')).toBe('false')

  await dom!.act(async () => trigger.click())
  await webkitTap(container.querySelector('aside')!)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')

  await dom!.act(async () => trigger.click())
  await dom!.act(async () => container.querySelector('aside')!.querySelector('input')!.focus())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('phone chooser fits below the squad header and tracks the keyboard viewport', async () => {
  const { container } = await setup()
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Choose settings section"]')!
  const chooser = trigger.parentElement!
  const viewport = new dom!.window.EventTarget()
  Object.assign(viewport, { height: 844, offsetTop: 0 })
  Object.defineProperty(dom!.window, 'visualViewport', { configurable: true, value: viewport })
  container.getBoundingClientRect = () => ({ bottom: 740 }) as DOMRect
  chooser.getBoundingClientRect = () => ({ bottom: 350 }) as DOMRect
  await dom!.act(async () => trigger.click())
  const menu = chooser.querySelector<HTMLElement>('[data-state="open"]')!
  expect(menu.style.maxHeight).toBe('min(60dvh, 374px)')
  await dom!.act(async () => {
    Object.assign(viewport, { height: 510 })
    viewport.dispatchEvent(new dom!.window.Event('resize'))
  })
  expect(menu.style.maxHeight).toBe('min(60dvh, 144px)')
  await dom!.act(async () => {
    Object.assign(viewport, { offsetTop: 100 })
    viewport.dispatchEvent(new dom!.window.Event('scroll'))
  })
  expect(menu.style.maxHeight).toBe('min(60dvh, 244px)')
})

test('exact Agents page ranks ahead of keyword-only field matches', async () => {
  const { sidebar, search } = await setup([
    {
      items: [
        { id: 'secrets', label: 'Secrets & Keys' },
        { id: 'agents', label: 'Agents' },
        { id: 'features', label: 'Features' },
      ],
    },
  ])
  await search('agents')
  const results = [...sidebar.querySelectorAll('button')].filter(
    (button) => button.textContent?.includes('Administration') && button.textContent?.trim() !== 'Administration'
  )
  expect(results[0]?.textContent).toStartWith('Agents')
})
