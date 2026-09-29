import { expect, test } from 'bun:test'
import { describeAppPath, durableAssistantPageLinks } from './assistantPageLinks'

const item = (blocks: Array<{ toolName: string; args: unknown; isError?: boolean }>) =>
  ({
    kind: 'persisted',
    message: { role: 'assistant' },
    blocks: blocks.map((block, index) => ({
      type: 'tool_use',
      id: `tool-${index}`,
      toolCall: {
        toolName: block.toolName,
        args: typeof block.args === 'string' ? block.args : JSON.stringify(block.args),
        result: 'ok',
        isError: block.isError ?? false,
      },
    })),
  }) as any

test('only offered app-relative navigations become page links', () => {
  expect(
    durableAssistantPageLinks(
      item([
        { toolName: 'navigate', args: { path: '/settings?section=appearance', prompt: true } },
        { toolName: 'navigate', args: { path: '/settings?section=appearance', prompt: true } },
        { toolName: 'navigate', args: { path: '/inbox', prompt: false } },
        { toolName: 'navigate', args: { path: '//evil.example', prompt: true } },
        { toolName: 'navigate', args: { path: 'https://evil.example', prompt: true } },
        { toolName: 'navigate', args: { path: '/activity', prompt: true }, isError: true },
        { toolName: 'navigate', args: '{not json' },
        { toolName: 'search_ficus', args: { path: '/squads', prompt: true } },
      ])
    )
  ).toEqual(['/settings?section=appearance'])
})

test('app paths are named from the navigation definitions', () => {
  expect(describeAppPath('/')).toEqual({ kind: 'page', title: 'Feed' })
  expect(describeAppPath('/inbox')).toEqual({ kind: 'page', title: 'Inbox' })
  expect(describeAppPath('/settings?section=appearance')).toEqual({
    kind: 'settings',
    title: 'Appearance',
    context: 'Settings',
  })
  expect(describeAppPath('/settings')).toEqual({ kind: 'settings', title: 'Settings' })
  expect(describeAppPath('/squads/ficus/work?ws=42')).toEqual({
    kind: 'work-stream',
    title: 'Work stream #42',
    squadId: 'ficus',
  })
  expect(describeAppPath('/squads/ficus/agents?agent=a1')).toEqual({
    kind: 'conversation',
    title: 'Agent conversation',
    squadId: 'ficus',
  })
  expect(describeAppPath('/squads/ficus/settings?section=workflows')).toEqual({
    kind: 'settings',
    title: 'Workflows settings',
    squadId: 'ficus',
  })
  expect(describeAppPath('/squads/ficus/memory')).toEqual({ kind: 'squad', title: 'Memory', squadId: 'ficus' })
  expect(describeAppPath('/squads/ficus')).toEqual({ kind: 'squad', title: 'Home', squadId: 'ficus' })
  expect(describeAppPath('/somewhere-new')).toEqual({ kind: 'page', title: '/somewhere-new' })
})
