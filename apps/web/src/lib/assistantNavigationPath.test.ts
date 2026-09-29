import { expect, test } from 'bun:test'
import { assistantNavigationPath } from './assistantNavigationPath'

test('assistant navigation retains its text conversation while changing the underlying page', () => {
  const source =
    '/settings?section=providers&chat=open&commandStack=' +
    encodeURIComponent(JSON.stringify([['assistant', 'conversation']]))
  const target = new URL(
    assistantNavigationPath('/settings?section=workflows#details', source),
    'https://ficus.invalid'
  )
  expect(target.searchParams.get('section')).toBe('workflows')
  expect(target.searchParams.get('chat')).toBe('open')
  expect(target.searchParams.get('commandStack')).toBe(JSON.stringify([['assistant', 'conversation']]))
  expect(target.hash).toBe('#details')
})
test('preserves expanded and direct-linked conversations without copying old page filters', () => {
  expect(
    assistantNavigationPath(
      '/squads/example/work?ws=task',
      '/settings?section=users&chat=expanded&assistantConversation=saved'
    )
  ).toBe('/squads/example/work?ws=task&chat=expanded&assistantConversation=saved')
})
test('explicit assistant destinations and a closed assistant retain their requested behavior', () => {
  const source = '/?chat=open&assistantConversation=old'
  for (const path of ['/?chat=closed', '/?chat=open&assistantConversation=new', 'https://example.com/'])
    expect(assistantNavigationPath(path, source)).toBe(path)
  expect(assistantNavigationPath('/settings?section=workflows', '/?chat=closed')).toBe('/settings?section=workflows')
})
