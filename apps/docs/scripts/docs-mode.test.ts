import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { DOCS_MODE_STORAGE_KEY } from '../../../packages/shared/src/browser-keys'

const script = readFileSync(new URL('../src/scripts/docs-mode.js', import.meta.url), 'utf8')

async function fixture(
  options: { path?: string; stored?: string; blockedStorage?: boolean },
  run: (window: Window) => void | Promise<void>
) {
  // Owned DOM only: never install browser globals into Bun's process.
  const window = new Window({ url: `https://docs.example.test${options.path ?? '/'}` })
  try {
    if (options.stored) window.localStorage.setItem('ficus-docs-mode', options.stored)
    if (options.blockedStorage) {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('Storage blocked')
        },
      })
    }
    window.document.body.innerHTML = `
      <select data-docs-mode-select><option value="cloud">Cloud</option><option value="self-hosted">Self-hosted</option></select>
      <select data-docs-mode-select><option value="cloud">Cloud</option><option value="self-hosted">Self-hosted</option></select>
      <a id="guide" href="/use/assistant/?q=voice#talk">Guide</a>
      <a id="cloud" data-docs-mode-link="cloud" href="/?mode=cloud#setup">Cloud</a>
      <a id="install" href="/start/self-host/">Install</a>
      <a id="external" href="https://example.com/">External</a>
      <a id="asset" href="/favicon.svg">Asset</a>
      <section data-docs-only="cloud"><button data-docs-mode-switch="self-hosted">Switch</button></section>
      <section data-docs-only="self-hosted"><button data-docs-mode-switch="cloud">Switch</button></section>`
    // Bun does not expose happy-dom's Window.eval. Bind this owned fixture
    // lexically instead of installing browser globals into the test process.
    new Function('window', `with (window) { ${script} }`)(window)
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'))
    await run(window)
  } finally {
    await window.happyDOM.close()
  }
}

test('the inline script stores the mode under the shared ficus key', () => {
  expect(DOCS_MODE_STORAGE_KEY).toBe('ficus-docs-mode')
  expect(script).toContain(`const storageKey = '${DOCS_MODE_STORAGE_KEY}'`)
})

test('shared URL wins over saved mode, retaining unrelated query and fragment', async () => {
  await fixture({ path: '/?mode=cloud&from=share#setup', stored: 'self-hosted' }, (w) => {
    expect(w.document.documentElement.dataset.docsMode).toBe('cloud')
    expect(w.localStorage.getItem('ficus-docs-mode')).toBe('cloud')
    expect(w.location.search).toBe('?mode=cloud&from=share')
    expect(w.location.hash).toBe('#setup')
  })
})

test('saved preference carries through normal links and newly inserted search results', async () => {
  await fixture({ stored: 'self-hosted' }, async (w) => {
    const href = (id: string) => w.document.getElementById(id)?.getAttribute('href')
    expect(href('guide')).toBe('/use/assistant/?q=voice&mode=self-hosted#talk')
    expect(href('cloud')).toBe('/?mode=cloud#setup')
    expect(href('external')).toBe('https://example.com/')
    expect(href('asset')).toBe('/favicon.svg')
    const result = w.document.createElement('a')
    result.href = '/use/squads/#start'
    w.document.body.append(result)
    await w.happyDOM.waitUntilComplete()
    expect(result.getAttribute('href')).toBe('/use/squads/?mode=self-hosted#start')
  })
})

test('setup entrypoints choose their own mode even against stored or linked preferences', async () => {
  await fixture({ path: '/start/self-host/?mode=cloud', stored: 'cloud' }, (w) => {
    expect(w.document.documentElement.dataset.docsMode).toBe('self-hosted')
    expect(w.location.search).toBe('?mode=self-hosted')
  })
})

test('switching synchronizes both pickers, the URL and links without losing fragments', async () => {
  await fixture({ path: '/use/assistant/#talk' }, (w) => {
    const select = w.document.querySelector('select')!
    select.value = 'self-hosted'
    select.dispatchEvent(new w.Event('change', { bubbles: true }))
    expect([...w.document.querySelectorAll('select')].map((item) => item.value)).toEqual(['self-hosted', 'self-hosted'])
    expect(w.location.href).toBe('https://docs.example.test/use/assistant/?mode=self-hosted#talk')
    expect(w.document.getElementById('guide')?.getAttribute('href')).toContain('mode=self-hosted')
    w.document.querySelector('[data-docs-only="self-hosted"]')!.querySelector('button')!.click()
    expect(w.document.documentElement.dataset.docsMode).toBe('cloud')
    expect(w.document.activeElement?.getAttribute('data-docs-mode-switch')).toBe('self-hosted')
  })
})

test('invalid preferences and blocked storage still allow mode selection and navigation', async () => {
  await fixture({ path: '/?mode=invalid', blockedStorage: true }, (w) => {
    expect(w.document.documentElement.dataset.docsMode).toBe('cloud')
    w.document.querySelector('button')!.click()
    expect(w.location.search).toBe('?mode=self-hosted')
    expect(w.document.getElementById('guide')?.getAttribute('href')).toContain('mode=self-hosted')
  })
})

test('browser history restores the mode encoded by the destination URL', async () => {
  await fixture({ stored: 'cloud' }, (w) => {
    w.history.replaceState({}, '', '/?mode=self-hosted#setup')
    w.dispatchEvent(new w.PopStateEvent('popstate'))
    expect(w.document.documentElement.dataset.docsMode).toBe('self-hosted')
    expect(w.document.querySelector('select')?.value).toBe('self-hosted')
  })
})

test('same-page setup choice switches in place while modified clicks still navigate normally', async () => {
  await fixture({ stored: 'self-hosted' }, (w) => {
    const choice = w.document.getElementById('cloud')!
    const click = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    choice.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(w.document.documentElement.dataset.docsMode).toBe('cloud')
    expect(w.location.search).toBe('?mode=cloud')
    const newTab = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true })
    choice.dispatchEvent(newTab)
    expect(newTab.defaultPrevented).toBe(false)
  })
})

test('embedded setup and search preserve docs mode without decorating app routes', async () => {
  await fixture({ path: '/docs/start/self-host/', stored: 'cloud' }, async (w) => {
    expect(w.document.documentElement.dataset.docsMode).toBe('self-hosted')
    expect(w.document.getElementById('guide')?.getAttribute('href')).toBe('/use/assistant/?q=voice#talk')
    const result = w.document.createElement('a')
    result.href = '/docs/use/squads/#start'
    w.document.body.append(result)
    await w.happyDOM.waitUntilComplete()
    expect(result.getAttribute('href')).toBe('/docs/use/squads/?mode=self-hosted#start')
  })
})
