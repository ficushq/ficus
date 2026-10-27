import { expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { MessageMetadata, MessageToolCall } from '@ficus/shared'
import type { ToolInlineAction } from '../lib/tool-inline-actions'
import { acquireDomHarness } from '../test/domHarness'
import { AssistantMessageContent } from './MessageContent'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const monitorCall = (id: string, monitorId: string): MessageToolCall => ({
  toolCallId: id,
  toolName: 'monitor',
  args: '{"action":"create"}',
  result: JSON.stringify({ details: { success: true, monitorId } }),
  isError: false,
})
const dispatchCall = (id: string, children: Array<{ subagentId: string; label: string }>): MessageToolCall => ({
  toolCallId: id,
  toolName: 'dispatch',
  args: '{}',
  result: JSON.stringify({ details: { subagents: children } }),
  isError: false,
})
const readImageCall = (id: string): MessageToolCall => ({
  toolCallId: id,
  toolName: 'read',
  args: JSON.stringify({ path: '/tmp/shot.png' }),
  result: JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data: PNG }] }),
  isError: false,
})
const toolBlock = (toolCall: MessageToolCall) => ({ type: 'tool_use' as const, id: toolCall.toolCallId, toolCall })

const groupMetadata = {
  content: [
    { type: 'thinking' as const, id: 'th', content: 'Start watching, then fan out' },
    toolBlock(monitorCall('m1', 'monitor-1')),
    toolBlock(
      dispatchCall('d1', [
        { subagentId: 'child-1', label: 'Research' },
        { subagentId: 'child-2', label: 'Build' },
      ])
    ),
    // The same subagent again from a later call shows once.
    toolBlock(dispatchCall('d2', [{ subagentId: 'child-1', label: 'Research' }])),
    toolBlock({ ...monitorCall('m-failed', 'monitor-failed'), isError: true }),
  ],
} satisfies MessageMetadata

async function render(element: ReactElement) {
  const dom = await acquireDomHarness({ url: 'http://localhost/chat' })
  const document = dom.window.document
  const { root } = dom.createRoot()
  await dom.act(async () => root.render(<MemoryRouter>{element}</MemoryRouter>))
  return {
    document,
    actionRows: () => [...document.querySelectorAll<HTMLElement>('[data-tool-inline-actions]')],
    actionLabels: () =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-tool-inline-actions] button')].map((button) =>
        button.getAttribute('aria-label')
      ),
    // The group header is the first button, collapsed or expanded.
    groupHeader: () => document.querySelector<HTMLButtonElement>('button')!,
    click: (element: Element) => dom.act(async () => (element as HTMLElement).click()),
    cleanup: () => dom.cleanup(),
  }
}

test('a collapsed group shows its completed calls’ actions under the header, in order and once each', async () => {
  const view = await render(
    <AssistantMessageContent content="" metadata={groupMetadata} onToolInlineAction={() => {}} />
  )
  try {
    expect(view.document.body.textContent).toContain('4 tools')
    expect(view.document.querySelector('[data-tool-call-row]')).toBeNull()
    const rows = view.actionRows()
    expect(rows).toHaveLength(1)
    // Directly under the group header, like the image strip.
    expect(rows[0]!.previousElementSibling).toBe(view.groupHeader())
    expect(view.actionLabels()).toEqual(['Open monitor', 'Open Research chat', 'Open Build chat'])
    expect(rows[0]!.textContent).toBe('Open monitor →Open Research chat →Open Build chat →')
  } finally {
    await view.cleanup()
  }
})

test('an expanded group drops the group row; each call shows its own actions instead', async () => {
  const view = await render(
    <AssistantMessageContent content="" metadata={groupMetadata} onToolInlineAction={() => {}} />
  )
  try {
    await view.click(view.groupHeader())
    expect(view.document.querySelector('[data-tool-call-row="m1"]')).not.toBeNull()
    // One row per call that offers actions, each right under that call's row.
    const rows = view.actionRows()
    expect(rows.map((row) => row.previousElementSibling?.getAttribute('data-tool-call-row'))).toEqual([
      'm1',
      'd1',
      'd2',
    ])
    expect(view.actionLabels()).toEqual(['Open monitor', 'Open Research chat', 'Open Build chat', 'Open Research chat'])

    await view.click(view.groupHeader())
    expect(view.actionRows()).toHaveLength(1)
  } finally {
    await view.cleanup()
  }
})

test('clicking a group action opens exactly what the call’s own action opens, without expanding the group', async () => {
  const opened: ToolInlineAction[] = []
  const view = await render(
    <AssistantMessageContent content="" metadata={groupMetadata} onToolInlineAction={(action) => opened.push(action)} />
  )
  try {
    const button = (label: string) =>
      view.document.querySelector<HTMLButtonElement>(`[data-tool-inline-actions] button[aria-label="${label}"]`)!
    await view.click(button('Open monitor'))
    await view.click(button('Open Build chat'))
    expect(view.document.querySelector('[data-tool-call-row]')).toBeNull()

    await view.click(view.groupHeader())
    await view.click(view.document.querySelector('[data-tool-call-row="m1"] + [data-tool-inline-actions] button')!)
    expect(opened).toEqual([
      { kind: 'monitor', key: 'monitor:monitor-1', label: 'Open monitor', monitorId: 'monitor-1' },
      {
        kind: 'subagent',
        key: 'subagent:child-2',
        label: 'Open Build chat',
        subagentId: 'child-2',
        subagentLabel: 'Build',
      },
      { kind: 'monitor', key: 'monitor:monitor-1', label: 'Open monitor', monitorId: 'monitor-1' },
    ])
  } finally {
    await view.cleanup()
  }
})

test('a collapsed group with actions and images shows the actions first, then the images', async () => {
  const metadata = {
    content: [toolBlock(readImageCall('r1')), toolBlock(monitorCall('m1', 'monitor-1'))],
  } satisfies MessageMetadata
  const view = await render(<AssistantMessageContent content="" metadata={metadata} onToolInlineAction={() => {}} />)
  try {
    const [row] = view.actionRows()
    expect(row!.previousElementSibling).toBe(view.groupHeader())
    expect(row!.nextElementSibling?.hasAttribute('data-tool-image-strip')).toBe(true)
  } finally {
    await view.cleanup()
  }
})

test('a group without actions, or without a handler, renders no action row', async () => {
  const noActions = {
    content: [toolBlock(readImageCall('r1')), toolBlock(readImageCall('r2'))],
  } satisfies MessageMetadata
  const plain = await render(<AssistantMessageContent content="" metadata={noActions} onToolInlineAction={() => {}} />)
  try {
    expect(plain.actionRows()).toHaveLength(0)
  } finally {
    await plain.cleanup()
  }
  const unhandled = await render(<AssistantMessageContent content="" metadata={groupMetadata} />)
  try {
    expect(unhandled.actionRows()).toHaveLength(0)
  } finally {
    await unhandled.cleanup()
  }
})
