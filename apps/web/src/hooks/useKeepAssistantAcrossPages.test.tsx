import { expect, test } from 'bun:test'
import { Link, MemoryRouter, useLocation } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import { CLOSE_ASSISTANT_STATE, useKeepAssistantAcrossPages } from './useKeepAssistantAcrossPages'

async function renderAt(initial: string) {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root } = dom.createRoot()
  let current = ''
  function App() {
    useKeepAssistantAcrossPages()
    const location = useLocation()
    current = `${location.pathname}${location.search}`
    return (
      <>
        <Link data-to="settings" to="/settings?section=providers">
          Settings
        </Link>
        <Link data-to="feed" to="/feed">
          Feed
        </Link>
        <Link data-to="close" to="/feed">
          Close here
        </Link>
        <Link data-to="jump" to="/squads" state={CLOSE_ASSISTANT_STATE}>
          Jump
        </Link>
      </>
    )
  }
  await dom.act(async () =>
    root.render(
      <MemoryRouter initialEntries={[initial]}>
        <App />
      </MemoryRouter>
    )
  )
  const click = async (name: string) =>
    dom.act(async () => (document.querySelector(`[data-to="${name}"]`) as HTMLAnchorElement).click())
  return { dom, click, url: () => current }
}

test('an open assistant follows ordinary links to other pages, keeping its conversation', async () => {
  const { dom, click, url } = await renderAt(
    '/feed?chat=open&commandStack=%5B%5B%22assistant%22%2C%22a1%22%2C%22%22%5D%5D'
  )
  try {
    await click('settings')
    const params = new URLSearchParams(url().split('?')[1])
    expect(url().startsWith('/settings?')).toBe(true)
    expect(params.get('section')).toBe('providers')
    expect(params.get('chat')).toBe('open')
    expect(params.get('commandStack')).toBe('[["assistant","a1",""]]')
  } finally {
    await dom.cleanup()
  }
})

test('closing the assistant on a page, or a closing jump, is not undone', async () => {
  const { dom, click, url } = await renderAt('/feed?chat=open')
  try {
    // Same page without the assistant parameters: the assistant was closed here.
    await click('close')
    expect(url()).toBe('/feed')
    await click('settings')
    expect(url()).toBe('/settings?section=providers')
  } finally {
    await dom.cleanup()
  }
  const jump = await renderAt('/feed?chat=open')
  try {
    await jump.click('jump')
    expect(jump.url()).toBe('/squads')
  } finally {
    await jump.dom.cleanup()
  }
})

test('a closed assistant stays closed across pages', async () => {
  const { dom, click, url } = await renderAt('/feed')
  try {
    await click('settings')
    expect(url()).toBe('/settings?section=providers')
  } finally {
    await dom.cleanup()
  }
})
