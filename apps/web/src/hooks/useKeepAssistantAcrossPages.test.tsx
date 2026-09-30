import { expect, test } from 'bun:test'
import { useLayoutEffect } from 'react'
import { Link, MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import { CLOSE_ASSISTANT_STATE, useKeepAssistantAcrossPages } from './useKeepAssistantAcrossPages'

async function renderAt(initial: string) {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root } = dom.createRoot()
  let current = ''
  const commits: string[] = []
  function App() {
    const params = useKeepAssistantAcrossPages()
    const location = useLocation()
    const navigate = useNavigate()
    current = `${location.pathname}${location.search}${location.hash}`
    useLayoutEffect(() => {
      commits.push(params.toString())
    })
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
        <Link data-to="explicit-close" to="/settings?chat=closed">
          Dismiss
        </Link>
        <Link data-to="conversation" to="/settings?chat=open&assistantConversation=other">
          Other chat
        </Link>
        <button data-to="back" onClick={() => navigate(-1)}>
          Back
        </button>
        <button data-to="forward" onClick={() => navigate(1)}>
          Forward
        </button>
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
  return { dom, click, commits, url: () => current }
}

test('an open assistant follows ordinary links to other pages, keeping its conversation', async () => {
  const { dom, click, commits, url } = await renderAt(
    '/feed?chat=open&commandStack=%5B%5B%22assistant%22%2C%22a1%22%2C%22%22%5D%5D'
  )
  try {
    commits.length = 0
    await click('settings')
    const params = new URLSearchParams(url().split('?')[1])
    expect(url().startsWith('/settings?')).toBe(true)
    expect(params.get('section')).toBe('providers')
    expect(params.get('chat')).toBe('open')
    expect(params.get('commandStack')).toBe('[["assistant","a1",""]]')
    expect(commits.length).toBeGreaterThan(0)
    expect(commits.every((commit) => new URLSearchParams(commit).get('chat') === 'open')).toBe(true)
    expect(
      commits.every((commit) => new URLSearchParams(commit).get('commandStack') === '[["assistant","a1",""]]')
    ).toBe(true)
    // URL repair replaces the new entry, rather than adding a second history step.
    await click('back')
    expect(url().startsWith('/feed?')).toBe(true)
    await click('forward')
    expect(url().startsWith('/settings?')).toBe(true)
  } finally {
    await dom.cleanup()
  }
})

test('explicit destination assistant state wins over the carried conversation', async () => {
  const { dom, click, url, commits } = await renderAt('/feed?chat=open&assistantConversation=existing')
  try {
    commits.length = 0
    await click('conversation')
    expect(url()).toBe('/settings?chat=open&assistantConversation=other')
    expect(commits.every((commit) => new URLSearchParams(commit).get('assistantConversation') === 'other')).toBe(true)
    await click('feed')
    commits.length = 0
    await click('explicit-close')
    expect(url()).toBe('/settings?chat=closed')
    expect(commits.every((commit) => new URLSearchParams(commit).get('chat') === 'closed')).toBe(true)
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
