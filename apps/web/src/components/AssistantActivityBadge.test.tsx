import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { AssistantActivityBadge } from './AssistantActivityBadge'

test('badge counts conversations and exposes the full accessible count', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () => {
      root.render(<AssistantActivityBadge count={123} />)
    })
    expect(container.textContent).toBe('99+')
    // Same theme badge color as the Feed and Inbox counts.
    expect(container.querySelector('span')!.classList.contains('bg-badge')).toBe(true)
    expect(container.querySelector('span')!.classList.contains('text-on-badge')).toBe(true)
    expect(container.querySelector('[aria-label="123 Assistant conversations with unread updates"]')).not.toBeNull()
    await dom.act(async () => {
      root.render(<AssistantActivityBadge count={1} />)
    })
    expect(container.textContent).toBe('1')
    expect(container.querySelector('[aria-label="1 Assistant conversation with unread updates"]')).not.toBeNull()
    await dom.act(async () => {
      root.render(<AssistantActivityBadge count={0} />)
    })
    expect(container.textContent).toBe('')
  } finally {
    await dom.cleanup()
  }
})
