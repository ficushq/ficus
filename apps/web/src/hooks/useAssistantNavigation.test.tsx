import { expect, test } from 'bun:test'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import { assistantNavigationParams, readAssistantNavigation, useAssistantNavigation } from './useAssistantNavigation'

test('navigation restores nesting and search on refresh and unwraps legacy conversation links', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  let nav!: ReturnType<typeof useAssistantNavigation>
  let search = ''
  function Probe() {
    nav = useAssistantNavigation()
    search = useLocation().search
    return <div>{nav.entries.at(-1)?.kind ?? 'search'}</div>
  }
  const { root } = dom.createRoot()
  const render = (url: string, key: string) =>
    root.render(
      <MemoryRouter key={key} initialEntries={[url]}>
        <Probe />
      </MemoryRouter>
    )
  try {
    await dom.act(async () =>
      render('/squads/tau?tab=work&chat=open&assistantConversation=old&agentConversation=stale', 'initial')
    )
    expect(nav.entries.at(-1)?.id).toBe('old')
    await dom.act(async () => nav.back())
    expect(readAssistantNavigation(new URLSearchParams(search))).toEqual([])
    expect(new URLSearchParams(search).has('agentConversation')).toBe(false)
    expect(new URLSearchParams(search).has('assistantConversation')).toBe(false)
    await dom.act(async () => nav.setQuery('OAuth'))
    await dom.act(async () => nav.push({ kind: 'squad', id: 'tau', label: 'Ficus' }))
    await dom.act(async () => nav.push({ kind: 'work', id: 'w1', squadId: 'tau', label: 'OAuth setup' }))
    await dom.act(async () =>
      nav.push({ kind: 'chat', id: 'a1', agentId: 'a1', squadId: 'tau', label: 'Research OAuth' })
    )
    expect(nav.entries.map((entry) => entry.kind)).toEqual(['squad', 'work', 'chat'])
    const refreshUrl = '/squads/tau' + search
    await dom.act(async () => render(refreshUrl, 'refresh'))
    expect(nav.entries.map((entry) => entry.kind)).toEqual(['squad', 'work', 'chat'])
    expect(nav.query).toBe('OAuth')
    expect(new URLSearchParams(search).get('tab')).toBe('work')
    await dom.act(async () => nav.back())
    expect(readAssistantNavigation(new URLSearchParams(search)).map((entry) => entry.kind)).toEqual(['squad', 'work'])
    await dom.act(async () => nav.back())
    await dom.act(async () => nav.back())
    expect(new URLSearchParams(search).has('commandStack')).toBe(false)
    expect(nav.query).toBe('OAuth')
    await dom.act(async () => nav.close())
    expect(search).toBe('?tab=work')
  } finally {
    await dom.cleanup()
  }
})

test('new chat prompts remain in memory and created agent identities survive refresh', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  let nav!: ReturnType<typeof useAssistantNavigation>
  let search = ''
  function Probe() {
    nav = useAssistantNavigation()
    search = useLocation().search
    return null
  }
  const { root } = dom.createRoot()
  try {
    await dom.act(async () =>
      root.render(
        <MemoryRouter>
          <Probe />
        </MemoryRouter>
      )
    )
    await dom.act(async () =>
      nav.push({
        kind: 'chat',
        id: 'draft',
        squadId: 'tau',
        label: 'Explore the request',
        initialText: 'Private initial prompt',
      })
    )
    expect(nav.entries.at(-1)).toMatchObject({ initialText: 'Private initial prompt' })
    expect(decodeURIComponent(search)).not.toContain('Private initial prompt')
    await dom.act(async () => nav.chatCreated('draft', 'created-agent'))
    expect(readAssistantNavigation(new URLSearchParams(search)).at(-1)).toMatchObject({
      id: 'draft',
      agentId: 'created-agent',
      squadId: 'tau',
    })
    expect(nav.entries.at(-1)).toMatchObject({ initialText: 'Private initial prompt' })
  } finally {
    await dom.cleanup()
  }
})

test('malformed navigation is bounded and never restores submitted prompts', () => {
  expect(readAssistantNavigation(new URLSearchParams({ commandStack: 'not json' }))).toEqual([])
  expect(
    readAssistantNavigation(new URLSearchParams({ commandStack: JSON.stringify(Array(31).fill(['squad', 'tau'])) }))
  ).toEqual([])
  const encoded = assistantNavigationParams(
    new URLSearchParams(),
    [{ kind: 'chat', id: 'draft', squadId: 'tau', label: 'Private label', initialText: 'Private prompt' }],
    ''
  )
  expect(encoded.toString()).not.toContain('Private')
  expect(readAssistantNavigation(encoded)[0]).not.toHaveProperty('initialText')
})

test('origin conversation read-only mode survives URL restoration', () => {
  const params = assistantNavigationParams(
    new URLSearchParams(),
    [
      { kind: 'work', id: 'work', squadId: 'tau', label: 'Work' },
      { kind: 'chat', id: 'origin', agentId: 'origin', squadId: 'tau', label: 'Explore approaches', readOnly: true },
    ],
    'OAuth'
  )
  expect(readAssistantNavigation(params).at(-1)).toMatchObject({ kind: 'chat', agentId: 'origin', readOnly: true })
})

test('a nested assistant recipient without a squad survives a deep link', () => {
  const params = assistantNavigationParams(
    new URLSearchParams('section=workflows'),
    [
      { kind: 'assistant', id: 'parent', label: 'Assistant' },
      { kind: 'chat', id: 'manager', agentId: 'manager', label: 'User Assistant' },
    ],
    ''
  )
  expect(readAssistantNavigation(params)).toEqual([
    { kind: 'assistant', id: 'parent', draft: false, label: 'Assistant' },
    { kind: 'chat', id: 'manager', agentId: 'manager', squadId: undefined, label: 'Conversation' },
  ])
  expect(params.get('section')).toBe('workflows')
})
